alter table public.usage_turns
  add column if not exists reasoning_effort text not null default 'unknown';

alter table public.usage_turns
  add column if not exists aggregation_version integer not null default 1
  check (aggregation_version > 0),
  add column if not exists observed_at timestamptz not null default now();

create index if not exists usage_turns_user_model_effort_idx
  on public.usage_turns(user_id, model, reasoning_effort);

create or replace function public.reject_stale_usage_turn()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.aggregation_version < old.aggregation_version
     or (new.aggregation_version = old.aggregation_version and new.observed_at < old.observed_at) then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists usage_turns_freshness on public.usage_turns;
create trigger usage_turns_freshness before update on public.usage_turns
for each row execute function public.reject_stale_usage_turn();

revoke all on function public.reject_stale_usage_turn() from public;
grant execute on function public.reject_stale_usage_turn() to authenticated;
