-- All session and turn writes now share one transaction and one freshness check.
-- Older clients lose direct write permission rather than silently corrupting data.
revoke insert, update, delete on public.usage_sessions, public.usage_turns, public.usage_sources from authenticated;
revoke execute on function public.prune_usage_turns_v2(jsonb) from authenticated;
alter table public.usage_turns add column if not exists aggregation_version integer not null default 1;
alter table public.usage_turns add column if not exists observed_at timestamptz not null default now();

create table public.usage_sync_control (
  user_id uuid primary key references auth.users(id) on delete cascade,
  paused boolean not null default false
);
alter table public.usage_sync_control enable row level security;
create policy "users read own sync control" on public.usage_sync_control for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.sync_usage_session_v3(p_session jsonb, p_turns jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  incoming public.usage_sessions;
  saved public.usage_sessions;
begin
  if uid is null then raise exception 'Authentication required'; end if;
  insert into public.usage_sync_control values(uid,false) on conflict(user_id) do nothing;
  perform 1 from public.usage_sync_control where user_id=uid for share;
  if exists(select 1 from public.usage_sync_control where user_id=uid and paused) then
    raise exception 'Cloud sync paused after deletion';
  end if;
  incoming := jsonb_populate_record(null::public.usage_sessions, p_session);
  incoming.user_id := uid;
  if incoming.aggregation_version <> 5 or jsonb_typeof(p_turns) <> 'array'
     or incoming.token_event_count <> jsonb_array_length(p_turns) then
    raise exception 'Incomplete session snapshot';
  end if;
  if incoming.total_tokens <> (select coalesce(sum(total_tokens),0) from jsonb_to_recordset(p_turns) as t(total_tokens bigint)) then
    raise exception 'Token total does not match turns';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_turns) as t(turn_ordinal bigint, total_tokens bigint, input_tokens bigint, output_tokens bigint, cached_input_tokens bigint, cache_write_input_tokens bigint, reasoning_output_tokens bigint)
    where t.turn_ordinal < 1 or t.turn_ordinal > incoming.token_event_count or t.total_tokens < t.input_tokens+t.output_tokens
    or t.cached_input_tokens+t.cache_write_input_tokens>t.input_tokens or t.reasoning_output_tokens>t.output_tokens)
    or (select count(distinct turn_ordinal) from jsonb_to_recordset(p_turns) as t(turn_ordinal bigint))<>incoming.token_event_count then
    raise exception 'Invalid usage breakdown';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text || incoming.session_key,0));
  -- Session UUIDs are shared by copies of a log. Reuse an existing source key so
  -- configuring the same SSH host on a second device cannot double the cloud total.
  select * into saved from public.usage_sessions
    where user_id=uid and session_key=incoming.session_key
    order by token_event_count desc, observed_at desc limit 1 for update;
  if found then
    if incoming.token_event_count < saved.token_event_count
       or incoming.aggregation_version < saved.aggregation_version
       or incoming.ended_at < saved.ended_at then return false; end if;
    if exists(select 1 from public.usage_turns old
      where old.user_id=uid and old.source_key=saved.source_key and old.session_key=saved.session_key
      and not exists(select 1 from jsonb_to_recordset(p_turns) as t(occurred_at timestamptz,total_tokens bigint)
        where t.occurred_at=old.occurred_at and t.total_tokens=old.total_tokens)) then return false; end if;
    incoming.source_key := saved.source_key;
  end if;
  insert into public.usage_sources(user_id,source_key,kind,last_seen_at)
    values(uid,incoming.source_key,'ssh',incoming.observed_at)
    on conflict(user_id,source_key) do update set last_seen_at=greatest(usage_sources.last_seen_at,excluded.last_seen_at);
  -- This delete is safe only here: the complete replacement and all turns are
  -- committed together, after the same locked freshness/coverage decision.
  delete from public.usage_sessions where user_id=uid and source_key=incoming.source_key and session_key=incoming.session_key;
  insert into public.usage_sessions select incoming.*;
  insert into public.usage_turns(user_id,source_key,session_key,turn_ordinal,occurred_at,model,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,service_tier,reasoning_effort,estimate_microusd,aggregation_version,observed_at)
    select uid,incoming.source_key,incoming.session_key,t.turn_ordinal,t.occurred_at,t.model,t.input_tokens,t.cached_input_tokens,t.cache_write_input_tokens,t.output_tokens,t.reasoning_output_tokens,t.total_tokens,t.service_tier,t.reasoning_effort,t.estimate_microusd,5,incoming.observed_at
    from jsonb_to_recordset(p_turns) as t(turn_ordinal bigint,occurred_at timestamptz,model text,input_tokens bigint,cached_input_tokens bigint,cache_write_input_tokens bigint,output_tokens bigint,reasoning_output_tokens bigint,total_tokens bigint,service_tier text,reasoning_effort text,estimate_microusd bigint);
  return true;
end;
$$;

create or replace function public.delete_cloud_usage_v3()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  insert into public.usage_sync_control values(auth.uid(),true)
    on conflict(user_id) do update set paused=true;
  delete from public.usage_sources where user_id=auth.uid();
end;
$$;

create or replace function public.get_usage_session_v3(p_source_key text, p_session_key text)
returns jsonb language sql security invoker set search_path = '' as $$
  select jsonb_build_object('session',to_jsonb(s),'turns',coalesce((select jsonb_agg(to_jsonb(t) order by turn_ordinal)
    from public.usage_turns t where t.user_id=s.user_id and t.source_key=s.source_key and t.session_key=s.session_key),'[]'::jsonb))
  from public.usage_sessions s where s.user_id=auth.uid() and s.source_key=p_source_key and s.session_key=p_session_key;
$$;
revoke all on function public.get_usage_session_v3(text,text) from public;
grant execute on function public.get_usage_session_v3(text,text) to authenticated;

create or replace function public.resume_cloud_usage_v3()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  insert into public.usage_sync_control values(auth.uid(),false)
    on conflict(user_id) do update set paused=false;
end;
$$;

revoke all on function public.sync_usage_session_v3(jsonb,jsonb), public.delete_cloud_usage_v3(), public.resume_cloud_usage_v3() from public;
grant execute on function public.sync_usage_session_v3(jsonb,jsonb), public.delete_cloud_usage_v3(), public.resume_cloud_usage_v3() to authenticated;
create index if not exists usage_sessions_user_session_key_idx on public.usage_sessions(user_id,session_key);
