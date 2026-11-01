import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, onTestFinished } from 'vitest';
import { createHonestQueue } from '../src/honest/queue.js';
import { hashInput, jobKeyFor, type JobRequest } from '../src/keys.js';
import { createNaiveQueue } from '../src/naive/queue.js';
import { DEFAULT_MODEL, type Queue } from '../src/queue.js';
import { completionFor, startFakeProvider, type FakeProvider } from './support/fake-provider.js';
import { killedBySigkill, runWorkerProcess } from './support/worker-process.js';

// Every scenario runs against a real Postgres and a fake provider that bills over real HTTP.
// Each one asserts BOTH what the provider billed and what the database says afterwards.

const LEASE_SECONDS = 1;
const CALL_TIMEOUT_MS = 500;
const SLOW = 'delay 300' as const; // slower than a claim, faster than the call timeout
const TOO_SLOW = 'delay 1000' as const; // the provider finishes after the client gave up

const databaseUrl = inject('databaseUrl');
let fake: FakeProvider;
let db: pg.Pool;

beforeAll(async () => {
  fake = await startFakeProvider();
  db = new pg.Pool({ connectionString: databaseUrl });
});
afterAll(async () => {
  await db.end();
  await fake.close();
});
beforeEach(async () => {
  fake.reset();
  await db.query('truncate ai_calls, ai_jobs, ai_results, naive_jobs');
});

const options = () => ({ databaseUrl, providerUrl: fake.url, leaseSeconds: LEASE_SECONDS, callTimeoutMs: CALL_TIMEOUT_MS });

function queue(side: 'honest' | 'naive'): Queue {
  const q = side === 'honest' ? createHonestQueue(options()) : createNaiveQueue(options());
  onTestFinished(() => q.close());
  return q;
}

function request(tenant: string, resource = 'doc-1', input = 'Summarize the Q3 board report.'): JobRequest {
  return { tenant, resource, promptVersion: 'v1', inputHash: hashInput(input), prompt: input };
}

const prefix = (req: JobRequest) => `${req.tenant}:`;

async function rows(sql: string, params: unknown[] = []) {
  return (await db.query(sql, params)).rows;
}

async function honestJob(jobId: string) {
  const [job] = await rows('select status, attempt from ai_jobs where id = $1', [jobId]);
  const calls = await rows('select status, http_status from ai_calls where job_id = $1 order by attempt', [jobId]);
  return { ...job, calls };
}

async function naiveJob(jobId: string) {
  const [job] = await rows('select status, result from naive_jobs where id = $1', [jobId]);
  return job;
}

async function waitForLeaseExpiry(jobId: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const [row] = await rows('select lease_until < now() as expired from ai_jobs where id = $1', [jobId]);
    if (row?.expired) return;
    if (Date.now() > deadline) throw new Error('lease did not expire');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const worker = (side: 'honest' | 'naive', fault: 'before_call' | 'after_charge') =>
  runWorkerProcess({ side, fault, databaseUrl, providerUrl: fake.url, leaseSeconds: LEASE_SECONDS, callTimeoutMs: CALL_TIMEOUT_MS });

describe('(a) enqueue the same request twice', () => {
  it('(a) honest: 1 ai_jobs row, the second enqueue returns created:false and the same id', async () => {
    const q = queue('honest');
    const req = request('a-honest');
    const first = await q.enqueue(req);
    const second = await q.enqueue(req);
    expect(first.created).toBe(true);
    expect(second).toEqual({ jobId: first.jobId, created: false });
    expect(await rows('select id from ai_jobs')).toHaveLength(1);
  });

  it('(a) naive: 2 job rows, both created:true', async () => {
    const q = queue('naive');
    const req = request('a-naive');
    const first = await q.enqueue(req);
    const second = await q.enqueue(req);
    expect([first.created, second.created]).toEqual([true, true]);
    expect(second.jobId).not.toBe(first.jobId);
    expect(await rows('select id from naive_jobs')).toHaveLength(2);
  });
});

describe('(b) two workers claim one queued job concurrently', () => {
  for (const side of ['honest', 'naive'] as const) {
    const expected = side === 'honest' ? 1 : 2;
    it(`(b) ${side}: exactly ${expected} provider call(s)`, async () => {
      const req = request(`b-${side}`);
      fake.failNext(prefix(req), SLOW, SLOW);
      const { jobId } = await queue(side).enqueue(req);
      const [w1, w2] = [queue(side), queue(side)];
      await Promise.all([w1.getJob(jobKeyFor(req)), w2.getJob(jobKeyFor(req))]); // open both connections first

      await Promise.all([w1.runWorker({ once: true }), w2.runWorker({ once: true })]);

      if (side === 'honest') {
        expect(fake.charges(prefix(req))).toBe(1);
        expect(await honestJob(jobId)).toEqual({ status: 'done', attempt: 1, calls: [{ status: 'succeeded', http_status: 200 }] });
      } else {
        expect(fake.charges(prefix(req))).toBe(2);
        expect((await naiveJob(jobId)).status).toBe('done');
      }
    });
  }
});

describe('(c) the worker process dies after the claim, before the call', () => {
  it('(c) honest: lease expires, sweep leaves it alone, it is re-claimed -> 1 call total', async () => {
    const q = queue('honest');
    const req = request('c-honest');
    const { jobId } = await q.enqueue(req);

    const exit = await worker('honest', 'before_call');
    expect(exit.crashedAt).toBe('before_call');
    expect(killedBySigkill(exit)).toBe(true);
    expect(exit.completed).toBe(false);
    expect(fake.charges(prefix(req))).toBe(0);
    expect(await honestJob(jobId)).toEqual({ status: 'claimed', attempt: 0, calls: [] });

    await waitForLeaseExpiry(jobId);
    expect(await q.sweep()).toEqual({ unconfirmed: 0, requeued: 0 }); // nothing was sent: safe to re-run
    await q.runWorker({ once: true });

    expect(fake.charges(prefix(req))).toBe(1);
    expect(await honestJob(jobId)).toEqual({ status: 'done', attempt: 1, calls: [{ status: 'succeeded', http_status: 200 }] });
  });

  it('(c) naive: the job never left queued, the next pass calls -> 1 call total', async () => {
    const q = queue('naive');
    const req = request('c-naive');
    const { jobId } = await q.enqueue(req);

    const exit = await worker('naive', 'before_call');
    expect(exit.crashedAt).toBe('before_call');
    expect(killedBySigkill(exit)).toBe(true);
    expect(fake.charges(prefix(req))).toBe(0);

    await q.runWorker({ once: true });
    expect(fake.charges(prefix(req))).toBe(1);
    expect((await naiveJob(jobId)).status).toBe('done');
  });
});

describe('(d) the worker process dies after the provider billed, before the result is saved', () => {
  it('(d) honest: 1 charge, job unconfirmed, no second call on the next worker pass', async () => {
    const q = queue('honest');
    const req = request('d-honest');
    const { jobId } = await q.enqueue(req);

    const exit = await worker('honest', 'after_charge');
    expect(exit.crashedAt).toBe('after_charge');
    expect(killedBySigkill(exit)).toBe(true);
    expect(fake.charges(prefix(req))).toBe(1);
    expect(await honestJob(jobId)).toEqual({ status: 'calling', attempt: 1, calls: [{ status: 'started', http_status: null }] });

    await waitForLeaseExpiry(jobId);
    expect(await q.sweep()).toEqual({ unconfirmed: 1, requeued: 0 });
    expect(await honestJob(jobId)).toEqual({ status: 'unconfirmed', attempt: 1, calls: [{ status: 'unknown', http_status: null }] });

    await q.runWorker({ once: true });
    expect(fake.charges(prefix(req))).toBe(1);
    expect((await honestJob(jobId)).status).toBe('unconfirmed');
    expect(await rows('select cache_key from ai_results')).toHaveLength(0);
  });

  it('(d) naive: 2 charges, job done', async () => {
    const q = queue('naive');
    const req = request('d-naive');
    const { jobId } = await q.enqueue(req);

    const exit = await worker('naive', 'after_charge');
    expect(exit.crashedAt).toBe('after_charge');
    expect(killedBySigkill(exit)).toBe(true);
    expect(fake.charges(prefix(req))).toBe(1);

    await q.runWorker({ once: true });
    expect(fake.charges(prefix(req))).toBe(2);
    expect((await naiveJob(jobId)).status).toBe('done');
  });
});

describe('(e) the client times out while the provider still completes and bills', () => {
  it('(e) honest: 1 charge, job unconfirmed, no second call', async () => {
    const q = queue('honest');
    const req = request('e-honest');
    fake.failNext(prefix(req), TOO_SLOW);
    const { jobId } = await q.enqueue(req);

    await q.runWorker({ once: true });
    expect(fake.charges(prefix(req))).toBe(1);
    expect(await honestJob(jobId)).toEqual({ status: 'unconfirmed', attempt: 1, calls: [{ status: 'unknown', http_status: null }] });

    await q.runWorker({ once: true });
    expect(fake.charges(prefix(req))).toBe(1);
  });

  it('(e) naive: 2 charges, job done', async () => {
    const q = queue('naive');
    const req = request('e-naive');
    fake.failNext(prefix(req), TOO_SLOW);
    const { jobId } = await q.enqueue(req);

    await q.runWorker({ once: true });
    expect(fake.charges(prefix(req))).toBe(2);
    expect((await naiveJob(jobId)).status).toBe('done');
  });
});

describe('(f) a second job with identical input', () => {
  it('(f) honest: 0 new calls, result equal', async () => {
    const q = queue('honest');
    const first = request('f-honest', 'doc-1');
    const second = request('f-honest', 'doc-2'); // another resource, same input, same prompt version
    await q.enqueue(first);
    await q.runWorker({ once: true });
    expect(fake.charges(prefix(first))).toBe(1);

    const { jobId, created } = await q.enqueue(second);
    expect(created).toBe(true);
    await q.runWorker({ once: true });

    expect(fake.charges(prefix(first))).toBe(1);
    expect(await honestJob(jobId)).toEqual({ status: 'done', attempt: 0, calls: [] });
    const a = await q.getJob(jobKeyFor(first));
    const b = await q.getJob(jobKeyFor(second));
    expect(b?.result).toBe(a?.result);
    expect(b?.result).toBe(completionFor(DEFAULT_MODEL, first.prompt));
  });

  it('(f) naive: 2 calls, result equal', async () => {
    const q = queue('naive');
    const first = request('f-naive', 'doc-1');
    const second = request('f-naive', 'doc-2');
    const one = await q.enqueue(first);
    await q.runWorker({ once: true });
    const two = await q.enqueue(second);
    await q.runWorker({ once: true });

    expect(fake.charges(prefix(first))).toBe(2);
    expect((await naiveJob(two.jobId)).result).toBe((await naiveJob(one.jobId)).result);
  });
});

describe('(g) the provider answers 429, then succeeds', () => {
  it('(g) honest: retried because the 429 was not billed -> 1 charge, attempt 2', async () => {
    const q = queue('honest');
    const req = request('g-honest');
    fake.failNext(prefix(req), '429');
    const { jobId } = await q.enqueue(req);

    await q.runWorker({ once: true });

    expect(fake.requests(prefix(req))).toBe(2);
    expect(fake.charges(prefix(req))).toBe(1);
    expect(await honestJob(jobId)).toEqual({
      status: 'done',
      attempt: 2,
      calls: [
        { status: 'rejected', http_status: 429 },
        { status: 'succeeded', http_status: 200 },
      ],
    });
  });
});

describe('(h) the app reopens the job by its key', () => {
  it('(h) honest: getJob returns the same id while running and the result when done', async () => {
    const q = queue('honest');
    const req = request('h-honest');
    fake.failNext(prefix(req), SLOW);
    const { jobId } = await q.enqueue(req);

    const running = q.runWorker({ once: true });
    let seen = await q.getJob(jobKeyFor(req));
    while (seen?.status !== 'calling') {
      await new Promise((r) => setTimeout(r, 10));
      seen = await q.getJob(jobKeyFor(req));
    }
    expect(seen).toMatchObject({ id: jobId, status: 'calling', result: null });

    await running;
    expect(await q.getJob(jobKeyFor(req))).toEqual({
      id: jobId,
      jobKey: jobKeyFor(req),
      status: 'done',
      attempt: 1,
      result: completionFor(DEFAULT_MODEL, req.prompt),
    });
    expect(fake.charges(prefix(req))).toBe(1);
  });
});

describe('(i) the same request is enqueued twice at the same time, then two workers run', () => {
  for (const side of ['honest', 'naive'] as const) {
    const expected = side === 'honest' ? 1 : 2;
    it(`(i) ${side}: ${expected} job row(s) and exactly ${expected} provider charge(s)`, async () => {
      const req = request(`i-${side}`);
      fake.failNext(prefix(req), SLOW, SLOW); // both calls overlap, so the result cache cannot help
      const [w1, w2] = [queue(side), queue(side)];
      await Promise.all([w1.getJob(jobKeyFor(req)), w2.getJob(jobKeyFor(req))]); // open both connections first

      const enqueued = await Promise.all([w1.enqueue(req), w2.enqueue(req)]); // a double submit
      await Promise.all([w1.runWorker({ once: true }), w2.runWorker({ once: true })]);

      const table = side === 'honest' ? 'ai_jobs' : 'naive_jobs';
      expect(fake.charges(prefix(req))).toBe(expected);
      expect(await rows(`select id from ${table}`)).toHaveLength(expected);
      if (side === 'honest') {
        expect(enqueued.map((e) => e.created).sort()).toEqual([false, true]);
        expect(enqueued[0].jobId).toBe(enqueued[1].jobId);
        expect(await honestJob(enqueued[0].jobId)).toEqual({ status: 'done', attempt: 1, calls: [{ status: 'succeeded', http_status: 200 }] });
      } else {
        expect(enqueued.map((e) => e.created)).toEqual([true, true]);
        expect(enqueued[0].jobId).not.toBe(enqueued[1].jobId);
      }
    });
  }
});
