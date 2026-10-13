-- 保存統計修正的逐筆移除資訊，讓較舊裝置不能把已修正的用量補回。
alter table public.usage_sessions add column if not exists excluded_usage jsonb not null default '[]'::jsonb;

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
  if incoming.aggregation_version is null or incoming.aggregation_version not in (5,6) or jsonb_typeof(p_turns) is distinct from 'array'
     or incoming.token_event_count is distinct from jsonb_array_length(p_turns) then
    raise exception 'Incomplete session snapshot';
  end if;
  if (incoming.input_tokens,incoming.cached_input_tokens,incoming.cache_write_input_tokens,
      incoming.output_tokens,incoming.reasoning_output_tokens,incoming.total_tokens) is distinct from
    (select row(coalesce(sum(input_tokens),0)::bigint,coalesce(sum(cached_input_tokens),0)::bigint,coalesce(sum(cache_write_input_tokens),0)::bigint,
      coalesce(sum(output_tokens),0)::bigint,coalesce(sum(reasoning_output_tokens),0)::bigint,coalesce(sum(total_tokens),0)::bigint)
     from jsonb_to_recordset(p_turns) as t(input_tokens bigint,cached_input_tokens bigint,cache_write_input_tokens bigint,
       output_tokens bigint,reasoning_output_tokens bigint,total_tokens bigint)) then
    raise exception 'Token breakdown does not match turns';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_turns) as t(turn_ordinal bigint, occurred_at timestamptz, total_tokens bigint, input_tokens bigint, output_tokens bigint, cached_input_tokens bigint, cache_write_input_tokens bigint, reasoning_output_tokens bigint)
    where t.turn_ordinal is null or t.occurred_at is null or t.total_tokens is null or t.input_tokens is null
      or t.output_tokens is null or t.cached_input_tokens is null or t.cache_write_input_tokens is null or t.reasoning_output_tokens is null
      or least(t.total_tokens,t.input_tokens,t.output_tokens,t.cached_input_tokens,t.cache_write_input_tokens,t.reasoning_output_tokens)<0
      or t.turn_ordinal < 1 or t.turn_ordinal > incoming.token_event_count or t.total_tokens < t.input_tokens+t.output_tokens
      or t.cached_input_tokens+t.cache_write_input_tokens>t.input_tokens or t.reasoning_output_tokens>t.output_tokens)
    or (select count(distinct turn_ordinal) from jsonb_to_recordset(p_turns) as t(turn_ordinal bigint))<>incoming.token_event_count then
    raise exception 'Invalid usage breakdown';
  end if;
  incoming.excluded_usage := case when incoming.aggregation_version=6 then coalesce(incoming.excluded_usage,'[]'::jsonb) else '[]'::jsonb end;
  if jsonb_typeof(incoming.excluded_usage) is distinct from 'array' then raise exception 'Invalid correction evidence'; end if;
  if exists(select 1 from jsonb_to_recordset(incoming.excluded_usage) as x(timestamp timestamptz,total_tokens bigint)
    where x.timestamp is null or x.total_tokens is null or x.total_tokens<0) then raise exception 'Invalid correction evidence'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(uid::text || incoming.session_key,0));
  -- Session UUIDs are shared by copies of a log. Reuse an existing source key so
  -- configuring the same SSH host on a second device cannot double the cloud total.
  select * into saved from public.usage_sessions
    where user_id=uid and session_key=incoming.session_key
    order by token_event_count desc, observed_at desc limit 1 for update;
  if found then
    if incoming.aggregation_version < saved.aggregation_version then return false; end if;
    if incoming.aggregation_version=5 and (incoming.token_event_count < saved.token_event_count or incoming.ended_at < saved.ended_at) then return false; end if;
    -- 新版先下載並合併；相同版本的另一台裝置也不能覆蓋尚未讀取的修正。
    if incoming.aggregation_version=6 and (p_session->>'base_revision') is distinct from saved.sync_revision::text then return false; end if;
    incoming.excluded_usage := incoming.excluded_usage || saved.excluded_usage;
    if exists(select 1 from public.usage_turns old
      where old.user_id=uid and old.source_key=saved.source_key and old.session_key=saved.session_key
      and not exists(select 1 from jsonb_to_recordset(p_turns) as t(occurred_at timestamptz,total_tokens bigint)
        where t.occurred_at=old.occurred_at and t.total_tokens=old.total_tokens)
      and not exists(select 1 from jsonb_to_recordset(incoming.excluded_usage) as x(timestamp timestamptz,total_tokens bigint)
        where x.timestamp=old.occurred_at and x.total_tokens=old.total_tokens)) then return false; end if;
    incoming.source_key := saved.source_key;
  end if;
  -- 移除資訊持續保留並按實際時間去重；零回合的修正也必須上傳。
  incoming.excluded_usage := (select coalesce(jsonb_agg(jsonb_build_object('timestamp',x.timestamp,'total_tokens',x.total_tokens) order by x.timestamp,x.total_tokens),'[]'::jsonb)
    from (select distinct timestamp,total_tokens from jsonb_to_recordset(incoming.excluded_usage) as e(timestamp timestamptz,total_tokens bigint)) x);
  if exists(select 1 from jsonb_to_recordset(p_turns) as t(occurred_at timestamptz,total_tokens bigint)
    join jsonb_to_recordset(incoming.excluded_usage) as x(timestamp timestamptz,total_tokens bigint)
    on x.timestamp=t.occurred_at and x.total_tokens=t.total_tokens) then return false; end if;
  insert into public.usage_sources(user_id,source_key,kind,last_seen_at)
    values(uid,incoming.source_key,'ssh',incoming.observed_at)
    on conflict(user_id,source_key) do update set last_seen_at=greatest(usage_sources.last_seen_at,excluded.last_seen_at);
  -- This delete is safe only here: the complete replacement and all turns are
  -- committed together, after the same locked freshness/coverage decision.
  delete from public.usage_sessions where user_id=uid and source_key=incoming.source_key and session_key=incoming.session_key;
  insert into public.usage_sessions select incoming.*;
  insert into public.usage_turns(user_id,source_key,session_key,turn_ordinal,occurred_at,model,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens,service_tier,reasoning_effort,estimate_microusd,aggregation_version,observed_at)
    select uid,incoming.source_key,incoming.session_key,t.turn_ordinal,t.occurred_at,t.model,t.input_tokens,t.cached_input_tokens,t.cache_write_input_tokens,t.output_tokens,t.reasoning_output_tokens,t.total_tokens,t.service_tier,t.reasoning_effort,t.estimate_microusd,incoming.aggregation_version,incoming.observed_at
    from jsonb_to_recordset(p_turns) as t(turn_ordinal bigint,occurred_at timestamptz,model text,input_tokens bigint,cached_input_tokens bigint,cache_write_input_tokens bigint,output_tokens bigint,reasoning_output_tokens bigint,total_tokens bigint,service_tier text,reasoning_effort text,estimate_microusd bigint);
  return true;
end;
$$;
