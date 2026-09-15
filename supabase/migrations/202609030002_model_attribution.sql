alter table public.usage_sessions
  add column if not exists aggregation_version integer not null default 1
  check (aggregation_version > 0);

create or replace function public.reject_stale_usage_session()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.aggregation_version < old.aggregation_version
     or (new.aggregation_version = old.aggregation_version and (
       new.token_event_count < old.token_event_count
       or (new.token_event_count = old.token_event_count and new.observed_at < old.observed_at)
     )) then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.prune_usage_turns_v2(p_sessions jsonb)
returns bigint
language sql
security invoker
set search_path = ''
as $$
  with limits as (
    select source_key, session_key, greatest(max_ordinal, 0) as max_ordinal
    from jsonb_to_recordset(coalesce(p_sessions, '[]'::jsonb))
      as item(source_key text, session_key text, max_ordinal bigint)
  ), deleted as (
    delete from public.usage_turns as turn
    using limits
    where turn.user_id = (select auth.uid())
      and turn.source_key = limits.source_key
      and turn.session_key = limits.session_key
      and turn.turn_ordinal > limits.max_ordinal
    returning 1
  )
  select count(*)::bigint from deleted;
$$;

revoke all on function public.prune_usage_turns_v2(jsonb) from public;
grant execute on function public.prune_usage_turns_v2(jsonb) to authenticated;
