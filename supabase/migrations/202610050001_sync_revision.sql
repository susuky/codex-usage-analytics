-- 每次完整快照寫入都取得新版本，包含總量不變的回合分類或模型修正。
alter table public.usage_sessions
  add column sync_revision uuid not null default pg_catalog.gen_random_uuid();

create function public.assign_usage_sync_revision()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.sync_revision := pg_catalog.gen_random_uuid();
  return new;
end;
$$;

create trigger usage_sessions_sync_revision before insert on public.usage_sessions
for each row execute function public.assign_usage_sync_revision();

revoke all on function public.assign_usage_sync_revision() from public;
