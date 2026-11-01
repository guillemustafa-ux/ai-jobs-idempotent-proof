import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { crashIfAt } from '../crash.js';
import { jobKeyFor, type JobRequest } from '../keys.js';
import { callProvider } from '../provider-client.js';
import { DEFAULT_MODEL, type JobView, type Queue, type QueueOptions } from '../queue.js';

/**
 * The naive twin: what a first version of an AI job queue usually looks like.
 * Fetch the oldest queued job without locking, call the provider, save, mark done.
 * Retry on any error, timeouts included. No unique request key, no lease, no call
 * ledger, no result cache. It exists so the tests can show what each guard buys.
 */
export function createNaiveQueue(opts: QueueOptions): Queue {
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 4 });
  const model = opts.model ?? DEFAULT_MODEL;
  const callTimeoutMs = opts.callTimeoutMs ?? 10_000;
  const maxAttempts = opts.maxAttempts ?? 3;

  async function enqueue(req: JobRequest) {
    const { rows } = await pool.query(
      `insert into naive_jobs (job_key, tenant, resource, prompt_version, input_hash, model, prompt)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [jobKeyFor(req), req.tenant, req.resource, req.promptVersion, req.inputHash, model, req.prompt],
    );
    return { jobId: rows[0].id as string, created: true };
  }

  async function getJob(jobKey: string): Promise<JobView | undefined> {
    const { rows } = await pool.query(
      `select id, job_key, status, result from naive_jobs where job_key = $1 order by created_at limit 1`,
      [jobKey],
    );
    const row = rows[0];
    return row && { id: row.id, jobKey: row.job_key, status: row.status, attempt: 0, result: row.result };
  }

  async function processOne(): Promise<boolean> {
    const { rows } = await pool.query(`select * from naive_jobs where status = 'queued' order by created_at limit 1`);
    const job = rows[0];
    if (!job) return false;

    crashIfAt(opts.crashAt, 'before_call');
    for (let attempt = 1; ; attempt++) {
      // A fresh key per request: nothing ties a retry to the request it repeats.
      const outcome = await callProvider(opts.providerUrl, {
        callKey: `${job.job_key}:naive-${randomUUID()}`,
        model: job.model,
        prompt: job.prompt,
        timeoutMs: callTimeoutMs,
      });
      crashIfAt(opts.crashAt, 'after_charge');
      if (outcome.kind === 'ok') {
        await pool.query(`update naive_jobs set status = 'done', result = $2 where id = $1`, [job.id, outcome.completion]);
        return true;
      }
      if (attempt >= maxAttempts) {
        await pool.query(`update naive_jobs set status = 'failed' where id = $1`, [job.id]);
        return true;
      }
    }
  }

  return {
    enqueue,
    getJob,
    async runWorker({ once } = { once: true }) {
      let processed = 0;
      while (await processOne()) {
        processed++;
        if (once) break;
      }
      return { processed };
    },
    async sweep() {
      return { unconfirmed: 0, requeued: 0 }; // nothing to sweep: the naive queue keeps no lease or ledger
    },
    close: () => pool.end(),
  };
}
