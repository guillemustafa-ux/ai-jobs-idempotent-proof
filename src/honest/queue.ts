import pg from 'pg';
import { crashIfAt } from '../crash.js';
import { cacheKeyFor, jobKeyFor, type JobRequest } from '../keys.js';
import { callProvider } from '../provider-client.js';
import { DEFAULT_MODEL, type JobView, type Queue, type QueueOptions } from '../queue.js';

interface JobRow {
  id: string;
  job_key: string;
  model: string;
  prompt: string;
  prompt_version: string;
  input_hash: string;
  cache_key: string;
}

/**
 * The honest queue. A remote call ends in one of three ways: it worked, it failed, or
 * nobody can tell. The guard lives in the database because the model call itself usually
 * cannot be deduplicated at the provider:
 *
 *   enqueue  derived job_key + ON CONFLICT DO NOTHING: a replay finds the existing job
 *   claim    FOR UPDATE SKIP LOCKED + lease: one worker per job; a dead worker's job comes back
 *   ledger   an ai_calls row is committed BEFORE the call: a crash after billing leaves a trace
 *   persist  result + job 'done' in ONE transaction after the call
 *   unknown  a call that may have been billed is NOT re-sent by default: the job stops in
 *            'unconfirmed', visible, at most one unaccounted charge per crash
 *   cache    a new job whose input was already answered reuses the result, 0 provider calls
 */
export function createHonestQueue(opts: QueueOptions): Queue {
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 4 });
  const model = opts.model ?? DEFAULT_MODEL;
  const leaseSeconds = opts.leaseSeconds ?? 30;
  const callTimeoutMs = opts.callTimeoutMs ?? 10_000;
  const maxAttempts = opts.maxAttempts ?? 3;
  const maxUnconfirmedRetries = opts.maxUnconfirmedRetries ?? 0;
  if (leaseSeconds * 1000 <= callTimeoutMs) {
    throw new Error('leaseSeconds must outlast callTimeoutMs, or a live call could be taken for a dead one');
  }

  async function enqueue(req: JobRequest) {
    const jobKey = jobKeyFor(req);
    const inserted = await pool.query(
      `insert into ai_jobs (job_key, tenant, resource, prompt_version, input_hash, model, prompt, cache_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (job_key) do nothing
       returning id`,
      [jobKey, req.tenant, req.resource, req.promptVersion, req.inputHash, model, req.prompt,
        cacheKeyFor(req.inputHash, model, req.promptVersion)],
    );
    if (inserted.rowCount === 1) return { jobId: inserted.rows[0].id as string, created: true };
    const existing = await pool.query(`select id from ai_jobs where job_key = $1`, [jobKey]);
    return { jobId: existing.rows[0].id as string, created: false };
  }

  async function getJob(jobKey: string): Promise<JobView | undefined> {
    const { rows } = await pool.query(
      `select j.id, j.job_key, j.status, j.attempt, r.output
         from ai_jobs j left join ai_results r on r.cache_key = j.result_key
        where j.job_key = $1
        order by j.created_at
        limit 1`,
      [jobKey],
    );
    const row = rows[0];
    return row && { id: row.id, jobKey: row.job_key, status: row.status, attempt: row.attempt, result: row.output };
  }

  /** Take the oldest queued job, or one whose owner's lease ran out. Never the same job twice. */
  async function claimNext(): Promise<JobRow | undefined> {
    const { rows } = await pool.query(
      `update ai_jobs
          set status = 'claimed', lease_until = now() + make_interval(secs => $1), updated_at = now()
        where id = (select id from ai_jobs
                     where status = 'queued'
                        or (status in ('claimed', 'calling') and lease_until < now())
                     order by created_at
                     for update skip locked
                     limit 1)
        returning *`,
      [leaseSeconds],
    );
    return rows[0];
  }

  async function processJob(job: JobRow): Promise<void> {
    // A previous owner died (or hung) mid-call. That call may have been billed.
    const pending = await pool.query(`select 1 from ai_calls where job_id = $1 and status = 'started'`, [job.id]);
    if (pending.rowCount && (await settleUnknown(pool, job.id, { requeue: false })) === 'unconfirmed') return;

    const cached = await pool.query(`select 1 from ai_results where cache_key = $1`, [job.cache_key]);
    if (cached.rowCount) {
      await pool.query(
        `update ai_jobs set status = 'done', result_key = $2, lease_until = null, updated_at = now() where id = $1`,
        [job.id, job.cache_key],
      );
      return;
    }

    crashIfAt(opts.crashAt, 'before_call');
    for (;;) {
      const attempt = await nextAttempt(job.id);
      const callKey = `${job.job_key}:${attempt}`;
      await recordCallStarted(callKey, job.id, attempt); // committed BEFORE the request leaves
      const outcome = await callProvider(opts.providerUrl, { callKey, model: job.model, prompt: job.prompt, timeoutMs: callTimeoutMs });
      crashIfAt(opts.crashAt, 'after_charge');

      if (outcome.kind === 'ok') {
        await persistResult(job, callKey, outcome.completion);
        return;
      }
      if (outcome.kind === 'unknown') {
        await finishCall(callKey, 'unknown', null);
        if ((await settleUnknown(pool, job.id, { requeue: false })) === 'unconfirmed') return;
        continue; // policy allows another paid attempt
      }
      // The provider answered (429/5xx) or the request never left: nothing was billed.
      await finishCall(callKey, outcome.kind, outcome.kind === 'rejected' ? outcome.status : null);
      if (attempt >= maxAttempts) {
        await pool.query(
          `update ai_jobs set status = 'failed', lease_until = null, last_error = $2, updated_at = now() where id = $1`,
          [job.id, `${outcome.kind} after ${attempt} attempts`],
        );
        return;
      }
    }
  }

  async function nextAttempt(jobId: string): Promise<number> {
    const { rows } = await pool.query(
      `update ai_jobs
          set status = 'calling', attempt = attempt + 1,
              lease_until = now() + make_interval(secs => $2), updated_at = now()
        where id = $1
        returning attempt`,
      [jobId, leaseSeconds],
    );
    return rows[0].attempt;
  }

  async function recordCallStarted(callKey: string, jobId: string, attempt: number): Promise<void> {
    await pool.query(`insert into ai_calls (call_key, job_id, attempt, status) values ($1, $2, $3, 'started')`, [callKey, jobId, attempt]);
  }

  async function finishCall(callKey: string, status: string, httpStatus: number | null): Promise<void> {
    await pool.query(`update ai_calls set status = $2, http_status = $3, finished_at = now() where call_key = $1`, [callKey, status, httpStatus]);
  }

  /** Result, ledger and job state change together or not at all. */
  async function persistResult(job: JobRow, callKey: string, completion: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into ai_results (cache_key, input_hash, model, prompt_version, output)
         values ($1, $2, $3, $4, $5) on conflict (cache_key) do nothing`,
        [job.cache_key, job.input_hash, job.model, job.prompt_version, completion],
      );
      await client.query(`update ai_calls set status = 'succeeded', http_status = 200, finished_at = now() where call_key = $1`, [callKey]);
      await client.query(
        `update ai_jobs set status = 'done', result_key = $2, lease_until = null, updated_at = now() where id = $1`,
        [job.id, job.cache_key],
      );
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * A call whose outcome is unknown may already have been billed. Mark it 'unknown' and, unless
   * the policy allows another paid attempt, stop the job in 'unconfirmed' for the app to decide.
   */
  async function settleUnknown(db: pg.Pool | pg.PoolClient, jobId: string, { requeue }: { requeue: boolean }) {
    await db.query(`update ai_calls set status = 'unknown', finished_at = now() where job_id = $1 and status = 'started'`, [jobId]);
    const { rows } = await db.query(`select count(*)::int as n from ai_calls where job_id = $1 and status = 'unknown'`, [jobId]);
    if (rows[0].n > maxUnconfirmedRetries) {
      await db.query(`update ai_jobs set status = 'unconfirmed', lease_until = null, updated_at = now() where id = $1`, [jobId]);
      return 'unconfirmed' as const;
    }
    if (requeue) {
      await db.query(`update ai_jobs set status = 'queued', lease_until = null, updated_at = now() where id = $1`, [jobId]);
    }
    return 'retry' as const;
  }

  /**
   * Meant to run on a schedule (pg_cron, or any cron). Finds jobs whose lease ran out while a call
   * was in flight and settles them. A job that died before its call has nothing to settle: the
   * next claim simply takes it again.
   */
  async function sweep() {
    const client = await pool.connect();
    let unconfirmed = 0;
    let requeued = 0;
    try {
      await client.query('begin');
      const { rows } = await client.query(
        `select j.id from ai_jobs j
          where j.status in ('claimed', 'calling') and j.lease_until < now()
            and exists (select 1 from ai_calls c where c.job_id = j.id and c.status = 'started')
          for update skip locked`,
      );
      for (const { id } of rows) {
        if ((await settleUnknown(client, id, { requeue: true })) === 'unconfirmed') unconfirmed++;
        else requeued++;
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
    return { unconfirmed, requeued };
  }

  return {
    enqueue,
    getJob,
    async runWorker({ once } = { once: true }) {
      let processed = 0;
      for (let job = await claimNext(); job; job = once ? undefined : await claimNext()) {
        await processJob(job);
        processed++;
      }
      return { processed };
    },
    sweep,
    close: () => pool.end(),
  };
}
