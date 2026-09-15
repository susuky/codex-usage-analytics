create table if not exists public.usage_sources (
  user_id uuid not null references auth.users(id) on delete cascade,
  source_key text not null check (length(source_key) = 64),
  kind text not null check (kind in ('local', 'ssh')),
  last_seen_at timestamptz not null,
  primary key (user_id, source_key)
);

create table if not exists public.usage_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  source_key text not null check (length(source_key) = 64),
  session_key text not null check (length(session_key) = 64),
  project_key text not null check (length(project_key) = 64),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  model text not null,
  origin text not null,
  input_tokens bigint not null check (input_tokens >= 0),
  cached_input_tokens bigint not null check (cached_input_tokens >= 0),
  cache_write_input_tokens bigint not null check (cache_write_input_tokens >= 0),
  output_tokens bigint not null check (output_tokens >= 0),
  reasoning_output_tokens bigint not null check (reasoning_output_tokens >= 0),
  total_tokens bigint not null check (total_tokens >= 0),
  estimate_microusd bigint check (estimate_microusd >= 0),
  token_event_count bigint not null check (token_event_count >= 0),
  observed_at timestamptz not null default now(),
  primary key (user_id, source_key, session_key),
  foreign key (user_id, source_key) references public.usage_sources(user_id, source_key) on delete cascade
);

create table if not exists public.usage_turns (
  user_id uuid not null references auth.users(id) on delete cascade,
  source_key text not null check (length(source_key) = 64),
  session_key text not null check (length(session_key) = 64),
  turn_ordinal bigint not null check (turn_ordinal > 0),
  occurred_at timestamptz not null,
  model text not null,
  input_tokens bigint not null check (input_tokens >= 0),
  cached_input_tokens bigint not null check (cached_input_tokens >= 0),
  cache_write_input_tokens bigint not null check (cache_write_input_tokens >= 0),
  output_tokens bigint not null check (output_tokens >= 0),
  reasoning_output_tokens bigint not null check (reasoning_output_tokens >= 0),
  total_tokens bigint not null check (total_tokens >= 0),
  service_tier text not null default 'default' check (service_tier in ('default', 'priority')),
  estimate_microusd bigint check (estimate_microusd >= 0),
  primary key (user_id, source_key, session_key, turn_ordinal),
  foreign key (user_id, source_key, session_key) references public.usage_sessions(user_id, source_key, session_key) on delete cascade
);

create index if not exists usage_sessions_user_started_idx on public.usage_sessions(user_id, started_at desc);
create index if not exists usage_sessions_user_model_started_idx on public.usage_sessions(user_id, model, started_at desc);
create index if not exists usage_turns_user_session_idx on public.usage_turns(user_id, source_key, session_key, turn_ordinal);

alter table public.usage_sources enable row level security;
alter table public.usage_sessions enable row level security;
alter table public.usage_turns enable row level security;

create policy "users own usage sources" on public.usage_sources for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "users own usage sessions" on public.usage_sessions for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "users own usage turns" on public.usage_turns for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create or replace function public.reject_stale_usage_session()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.token_event_count < old.token_event_count
     or (new.token_event_count = old.token_event_count and new.observed_at < old.observed_at) then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists usage_sessions_freshness on public.usage_sessions;
create trigger usage_sessions_freshness before update on public.usage_sessions
for each row execute function public.reject_stale_usage_session();

revoke all on function public.reject_stale_usage_session() from public;
grant execute on function public.reject_stale_usage_session() to authenticated;
