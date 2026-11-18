alter table public.usage_turns
  drop constraint usage_turns_service_tier_check,
  add constraint usage_turns_service_tier_check
    check (service_tier in ('default', 'priority', 'ultrafast'));
