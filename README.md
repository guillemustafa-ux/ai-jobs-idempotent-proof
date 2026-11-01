# ai-jobs-idempotent-proof

AI background jobs in TypeScript + Postgres that survive a crashed worker, a timeout or a
double submit **without paying twice for the same model call**, and that say plainly when they
cannot know. Tested against a real Postgres, with a fake provider that bills over real HTTP and
worker processes that are killed with `SIGKILL` mid-job.

It answers three asks that keep coming up in AI product work:

| The ask | Where it is covered |
| --- | --- |
| "Make interrupted work safe ... no lost results, no stuck screens, no duplicate paid AI calls" | scenarios (c), (d), (e), (h), (i) |
| "background jobs that survive failure: retries, idempotency, recovery" | scenarios (a), (c), (d), (g), (i) |
| "job queue, workers, ... concurrency limits/retries/idempotency" | scenarios (b), (g); per-tenant rate limits are out of scope (see [Scope](#scope)) |

## What it proves

A remote call ends in one of three ways: **it worked**, **it failed**, or **nobody can tell**.
The third one is where money leaks. A worker that dies after the provider billed, or a client
that times out while the provider is still generating, leaves a call that may or may not have
been charged. Retrying it blindly pays twice; dropping it loses the result.

The guard has to live in your database. The reference pages for creating a completion, at both
Anthropic (Messages API) and OpenAI (chat completions), do not document an idempotency key;
both pages were downloaded and searched on 2026-11-01 (method and quotes in
[docs/sources.md](docs/sources.md)). That is an absence of documentation, not proof that no such
mechanism exists, so this repo does not rely on one.

The honest queue (`src/honest/`) does four things:

1. **Enqueue is idempotent.** The library derives `job_key` from `(tenant, resource,
   prompt_version, input_hash)`; `INSERT ... ON CONFLICT (job_key) DO NOTHING` makes a replayed
   enqueue return the existing job with `created: false`.
2. **One worker per job.** The claim is one `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP
   LOCKED LIMIT 1)` with a lease. A job whose lease ran out is claimed again.
3. **A ledger row before every call.** An `ai_calls` row (`call_key = job_key:attempt`, status
   `started`) is committed *before* the request leaves. The result, the ledger update and the
   job's `done` state are then written in one transaction.
4. **Unknown means stop, not retry.** A `started` row that is still `started` after the lease
   ran out (or a timeout the worker saw itself) marks the call `unknown` and the job
   `unconfirmed`. It is not called again unless `maxUnconfirmedRetries` (default `0`) allows it.
   An error status from the provider (the fake uses 429 and 500) comes with no charge from the
   fake, so it is retried, up to `maxAttempts`.

Plus a **result cache**: `ai_results` is keyed by `(input_hash, model, prompt_version)`; a new
job with an input that was already answered gets the stored result with zero provider calls.

The naive twin (`src/naive/`) is what a first version usually looks like: fetch the oldest queued
job without locking, call, save, mark done, retry on any error including timeouts. No ledger, no
lease, no cache. Same public API, so one suite drives both.

## A/B: what each side was billed

Every number below is a literal in an assertion in [`test/scenarios.test.ts`](test/scenarios.test.ts).
"Charges" are requests the fake provider billed.

| Scenario | Naive: charges, job state | Honest: charges, job state |
| --- | --- | --- |
| (a) the same request is enqueued twice | 0, 2 job rows, both `created: true` | 0, 1 job row, second enqueue `created: false`, same id |
| (b) two workers claim one queued job at once | 2, `done` | 1, `done` |
| (c) worker process killed after the claim, before the call | 1, `done` | 1, `done` (re-claimed after the lease expired) |
| (d) worker process killed after the provider billed, before the save | 2, `done` | 1, `unconfirmed`; the next worker pass makes no call |
| (e) client times out while the provider still completes and bills | 2, `done` | 1, `unconfirmed`; the next worker pass makes no call |
| (f) a second job (another resource) with identical input | 2 for the two jobs, results equal | 1 for the two jobs (0 for the second), results equal |
| (g) provider answers 429, then succeeds | not tested | 1, `done`, `attempt` 2 |
| (h) the app reopens the job by its key | not tested | 1; `getJob` returns the same id while `calling` and the result when `done` |
| (i) the same request is enqueued twice at the same time, then two workers run | 2 job rows, 2 charges | 1 job row, 1 charge, `done` |

In (c) the naive twin recovers by accident: it never marks a job as taken, so the next pass
simply finds it queued. The price of that shows up in (b), (d) and (e).

## The suite bites: footguns

Each file in [`footguns/`](footguns/) is a small patch that reintroduces one real mistake.
`npm run footgun <name>` applies it, runs the whole suite, reverts it, and prints `PASS` only when
**exactly** the tests listed in [`footguns/manifest.json`](footguns/manifest.json) fail and every
other test stays green. The workflow runs all six (not yet executed on GitHub Actions at the time
of writing).

| Footgun | The mistake | Tests that fail |
| --- | --- | --- |
| `no-claim-lock` | plain `SELECT` then `UPDATE`, no `FOR UPDATE SKIP LOCKED` | (b) honest, (i) honest |
| `no-enqueue-dedupe` | no unique `job_key`, no `ON CONFLICT`: rows identified only by a random id | (a) honest, (i) honest |
| `ledger-after-call` | the `ai_calls` row is written after the provider answers | (d) honest |
| `blind-retry-on-unconfirmed` | `maxUnconfirmedRetries` defaults to `Infinity` | (d) honest, (e) honest |
| `no-lease-expiry` | the claim only takes `queued` jobs; an expired lease is never taken back | (c) honest |
| `no-result-cache` | the worker never looks in `ai_results` before calling | (f) honest |

A result cache keyed by content absorbs a replay that runs after the first job finished; it
cannot help when both copies are in flight at once, which is what (i) runs. Under
`no-enqueue-dedupe`, (i) fails with `duplicate key value violates unique constraint
"ai_calls_pkey"`: the duplicate row's worker collides with the ledger's unique `call_key`.
`runWorker` lets a `processJob` error propagate (that is what makes (i) fail under
`no-enqueue-dedupe`); a production loop would catch it and mark the job.
(i) also fails under `no-claim-lock`: after the dedupe, its two workers race for the one job,
the same race as (b).

## Run it

Node 22.12 or later is declared in `engines`; exercised locally on Node 24.16, Node 22 not yet
verified. No Docker and no API key.

```bash
npm ci
npm test              # 22 tests: 16 scenarios + 6 for the fake provider, client and schema
npx tsc --noEmit
npm run footgun no-claim-lock
```

`npm test` uses `DATABASE_URL` if it is set; otherwise it starts Postgres 16 with the
[`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres) package in a fresh
directory under the OS temp dir and removes it afterwards. Either way the tests run in a new
database that is dropped at the end.

The workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs Ubuntu with a
`postgres:16` service container, Windows with embedded Postgres, and the footgun matrix on Ubuntu
(not yet executed on GitHub Actions at the time of writing).

Crash tests run the worker as a separate process (`node --import tsx src/worker.ts`) that kills
itself with `SIGKILL` at the point named by `FAULT=before_call|after_charge`. No exception stands
in for a crash: nothing after that point runs, not even a `finally`.

## Supabase notes

- **The migration applies as-is.** [`supabase/migrations/0001_ai_jobs.sql`](supabase/migrations/0001_ai_jobs.sql)
  is plain Postgres 16. Tests apply it to a vanilla Postgres; it has not been applied to a
  hosted Supabase project as part of this repo.
- **The tables are for server-side workers only.** The migration enables RLS on all three tables
  and creates no policies. Supabase's docs: "Once RLS is enabled, no data is accessible through
  the API when using a publishable key, until you create policies."
- **Workers use a server-side credential.** Per Supabase's docs, a secret key "authorizes access
  through the `service_role` Postgres role, which has the `bypassrls` attribute", and "Never use a
  secret key in the browser or expose it to customers." This repo's workers connect with a
  Postgres connection string through `pg`; per the Postgres docs, table owners "normally bypass
  row security".
- **Scheduling the sweep.** pg_cron is "a simple cron-based job scheduler for PostgreSQL ... that
  runs inside the database as an extension", and accepts intervals such as `'30 seconds'`. It runs
  SQL, while `sweep()` here is TypeScript: to schedule it with pg_cron you would port its query to
  a SQL function. That port is not included and not tested. Any scheduler that calls `sweep()`
  works as well.

Quotes and URLs: [docs/sources.md](docs/sources.md).

## Limitations, stated plainly

- **A charge that happened before a crash is not recovered.** It is made visible and bounded: the
  job stops in `unconfirmed` with an `unknown` call row. One unaccounted charge per crash is the
  floor.
- **`unconfirmed` is a decision point, not a recovery.** Something (the app, an operator, a
  policy) has to decide whether to pay again.
- **"Not billed" for an error status is the fake's rule.** The honest worker retries any non-2xx
  answer because the fake provider does not bill them. Whether a real provider bills a given error status was not
  verified here.
- **No real LLM.** The provider is a local fake with deterministic completions.
- **A single Postgres.** No replicas, no connection pooler in the tests, no failover.
- **No load test.** Concurrency is covered by one two-worker race, not by throughput numbers.
- **No fencing token.** A worker that outlives its lease is not stopped by the database; the
  library refuses a lease that does not outlast the call timeout, which narrows that window but
  does not close it.

## Scope

- No UI and no Next.js app. "The app reopens the job by id" is the library function
  `getJob(jobKey)`, covered by scenario (h), not a screen.
- Concurrency limits: covered only as "two workers, one job" in (b). Per-tenant rate limiting
  is out of scope.

## Layout

```text
supabase/migrations/0001_ai_jobs.sql   ai_jobs, ai_calls, ai_results (plain Postgres)
src/honest/queue.ts                    enqueue, getJob, runWorker, sweep: the guarded version
src/naive/queue.ts, schema.sql         the naive twin and its table (tests only)
src/provider-client.ts                 HTTP call -> ok | rejected | never_sent | unknown
src/worker.ts                          one worker pass as a process; FAULT=... kills it
test/scenarios.test.ts                 scenarios (a)-(i), honest and naive
test/provider.test.ts                  the fake's billing and the client's classification
test/support/                          fake provider, embedded Postgres setup, worker process
footguns/                              one patch per mistake + manifest of the tests it must fail
scripts/footgun.mjs                    apply, run, revert, strict verdict
```

## License

MIT
