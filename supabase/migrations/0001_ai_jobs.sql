-- AI background jobs that survive crashes without paying twice for the same model call.
-- Plain Postgres (16+): no Supabase-only syntax, so it applies to a Supabase project as-is.
--
--   ai_jobs     one row per logical request; job_key is derived from the request, so a
--               replayed enqueue lands on the same row instead of creating a second job
--   ai_calls    the call ledger; a row is committed BEFORE every provider call, so a crash
--               after the provider billed us still leaves a trace that the sweep can see
--   ai_results  completed outputs keyed by (input_hash, model, prompt_version); a new job
--               with an input that was already answered reuses it with zero provider calls

create table if not exists public.ai_results (
  cache_key      text primary key,             -- sha256(input_hash, model, prompt_version)
  input_hash     text not null,
  model          text not null,
  prompt_version text not null,
  output         text not null,
  created_at     timestamptz not null default now()
);

create table if not exists public.ai_jobs (
  id             uuid primary key default gen_random_uuid(),
  job_key        text not null unique,         -- tenant + sha256(tenant, resource, prompt_version, input_hash)
  tenant         text not null,
  resource       text not null,
  prompt_version text not null,
  input_hash     text not null,
  model          text not null,
  prompt         text not null,
  cache_key      text not null,
  status         text not null default 'queued'
                 check (status in ('queued', 'claimed', 'calling', 'done', 'failed', 'unconfirmed')),
  attempt        integer not null default 0,   -- provider attempts started so far
  lease_until    timestamptz,                  -- a claimed/calling job whose lease passed is up for recovery
  result_key     text references public.ai_results (cache_key),
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists ai_jobs_claimable_idx
  on public.ai_jobs (created_at)
  where status in ('queued', 'claimed', 'calling');

create table if not exists public.ai_calls (
  call_key    text primary key,                -- job_key || ':' || attempt
  job_id      uuid not null references public.ai_jobs (id) on delete cascade,
  attempt     integer not null,
  -- started     committed before the request left; still 'started' later = outcome unknown
  -- succeeded   provider answered 2xx and the result was persisted
  -- rejected    provider answered an error status (429/5xx): reported as not billed
  -- never_sent  the connection was refused: the request never left this process
  -- unknown     timeout, dropped connection or dead worker: it may have been billed
  status      text not null
              check (status in ('started', 'succeeded', 'rejected', 'never_sent', 'unknown')),
  http_status integer,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  unique (job_id, attempt)
);

-- These tables are for server-side workers only. With RLS enabled and no policies, the
-- anon and authenticated API roles get no rows; the table owner bypasses RLS.
alter table public.ai_results enable row level security;
alter table public.ai_jobs    enable row level security;
alter table public.ai_calls   enable row level security;
