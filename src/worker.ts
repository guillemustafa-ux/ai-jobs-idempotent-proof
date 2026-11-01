/**
 * Worker process entry: `node --import tsx src/worker.ts`. Runs one worker pass and exits.
 *
 *   DATABASE_URL     Postgres connection string
 *   PROVIDER_URL     model provider base URL
 *   SIDE             honest (default) | naive
 *   LEASE_SECONDS    claim lease, default 30
 *   CALL_TIMEOUT_MS  provider call timeout, default 10000
 *   FAULT            before_call | after_charge: SIGKILL this process at that point (crash tests)
 */
import { CRASH_POINTS, type CrashPoint } from './crash.js';
import { createHonestQueue } from './honest/queue.js';
import { createNaiveQueue } from './naive/queue.js';

const env = (name: string): string => (process.env[name] || '').replace(/"/g, '');

const fault = env('FAULT');
if (fault && !CRASH_POINTS.includes(fault as CrashPoint)) {
  throw new Error(`FAULT must be one of ${CRASH_POINTS.join(', ')}; got "${fault}"`);
}

const options = {
  databaseUrl: env('DATABASE_URL'),
  providerUrl: env('PROVIDER_URL'),
  leaseSeconds: Number(env('LEASE_SECONDS') || 30),
  callTimeoutMs: Number(env('CALL_TIMEOUT_MS') || 10_000),
  crashAt: (fault || undefined) as CrashPoint | undefined,
};

const queue = env('SIDE') === 'naive' ? createNaiveQueue(options) : createHonestQueue(options);
try {
  const result = await queue.runWorker({ once: true });
  console.log(`worker: pass complete ${JSON.stringify(result)}`);
} finally {
  await queue.close();
}
