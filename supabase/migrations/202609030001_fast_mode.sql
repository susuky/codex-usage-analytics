alter table public.usage_turns
  add column if not exists service_tier text not null default 'default';

alter table public.usage_turns
  drop constraint if exists usage_turns_service_tier_check;

alter table public.usage_turns
  add constraint usage_turns_service_tier_check
  check (service_tier in ('default', 'priority'));
