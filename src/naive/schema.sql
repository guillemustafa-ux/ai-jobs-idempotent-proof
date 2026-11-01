-- The naive twin's table: what a first version usually looks like. No unique request key,
-- no lease, no call ledger, no result cache. It exists only so the tests can show the
-- difference; it is NOT part of the Supabase migration.
create table if not exists public.naive_jobs (
  id             uuid primary key default gen_random_uuid(),
  job_key        text not null,
  tenant         text not null,
  resource       text not null,
  prompt_version text not null,
  input_hash     text not null,
  model          text not null,
  prompt         text not null,
  status         text not null default 'queued',
  result         text,
  created_at     timestamptz not null default now()
);
