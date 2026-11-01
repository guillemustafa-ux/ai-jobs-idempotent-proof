import { createServer, type AddressInfo } from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { callProvider } from '../src/provider-client.js';
import { CENTS_PER_CALL, completionFor, startFakeProvider, type FakeProvider } from './support/fake-provider.js';

// The scenario tests trust these two pieces: the fake's charge ledger and the client's
// classification of what happened. Both are checked here on their own.

let fake: FakeProvider;
beforeAll(async () => {
  fake = await startFakeProvider();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => fake.reset());

const call = (callKey: string, timeoutMs = 500) =>
  callProvider(fake.url, { callKey, model: 'fake-model-1', prompt: 'hello', timeoutMs });

describe('fake provider + client', () => {
  it('a normal call bills once and returns the deterministic completion', async () => {
    const outcome = await call('p1:a');
    expect(outcome).toEqual({ kind: 'ok', status: 200, completion: completionFor('fake-model-1', 'hello') });
    expect(fake.charges('p1:')).toBe(1);
    expect(fake.cents('p1:')).toBe(CENTS_PER_CALL);
  });

  it('429 and 500 are answered without billing and classified as rejected', async () => {
    fake.failNext('p2:', '429', '500');
    expect(await call('p2:a')).toEqual({ kind: 'rejected', status: 429 });
    expect(await call('p2:b')).toEqual({ kind: 'rejected', status: 500 });
    expect(fake.requests('p2:')).toBe(2);
    expect(fake.charges('p2:')).toBe(0);
  });

  it('a delay longer than the client timeout bills and is classified as unknown', async () => {
    fake.failNext('p3:', 'delay 400');
    const outcome = await call('p3:a', 100);
    expect(outcome.kind).toBe('unknown');
    expect(fake.charges('p3:')).toBe(1);
  });

  it('drop-after-charge bills and is classified as unknown', async () => {
    fake.failNext('p4:', 'drop-after-charge');
    const outcome = await call('p4:a');
    expect(outcome.kind).toBe('unknown');
    expect(fake.charges('p4:')).toBe(1);
  });

  it('a refused connection is classified as never_sent', async () => {
    const port = await closedPort();
    const outcome = await callProvider(`http://127.0.0.1:${port}`, {
      callKey: 'p5:a',
      model: 'fake-model-1',
      prompt: 'hello',
      timeoutMs: 500,
    });
    expect(outcome).toEqual({ kind: 'never_sent', error: 'ECONNREFUSED' });
  });
});

describe('database', () => {
  it('the migration created the three tables', async () => {
    const client = new pg.Client({ connectionString: inject('databaseUrl') });
    await client.connect();
    try {
      const { rows } = await client.query(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_name like 'ai\\_%' order by table_name`,
      );
      expect(rows.map((r) => r.table_name)).toEqual(['ai_calls', 'ai_jobs', 'ai_results']);
    } finally {
      await client.end();
    }
  });
});

function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
