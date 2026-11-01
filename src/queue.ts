import type { CrashPoint } from './crash.js';
import type { JobRequest } from './keys.js';

/** Both the honest queue and the naive twin expose this shape, so one test suite drives both. */
export interface Queue {
  /** Idempotent on the request identity: a replay returns the existing job with `created: false`. */
  enqueue(req: JobRequest): Promise<{ jobId: string; created: boolean }>;
  /** The "app reopens the job" path: look the job up by its key, running or finished. */
  getJob(jobKey: string): Promise<JobView | undefined>;
  /** Claim and process queued work; `once: true` processes at most one job. */
  runWorker(opts?: { once: boolean }): Promise<{ processed: number }>;
  /** Settle jobs whose worker died mid-call: mark them unconfirmed (or re-queue per policy). */
  sweep(): Promise<{ unconfirmed: number; requeued: number }>;
  close(): Promise<void>;
}

export interface JobView {
  id: string;
  jobKey: string;
  status: string;
  attempt: number;
  result: string | null;
}

export interface QueueOptions {
  databaseUrl: string;
  providerUrl: string;
  model?: string;
  /** How long a claim is valid. Must be longer than `callTimeoutMs`. */
  leaseSeconds?: number;
  callTimeoutMs?: number;
  /** Provider attempts per job when the provider reports a non-billed failure (429/5xx). */
  maxAttempts?: number;
  /** Re-calls allowed after an outcome that may have been billed. Default 0: stop and surface it. */
  maxUnconfirmedRetries?: number;
  /** Test-only fault injection: the process SIGKILLs itself at this point. */
  crashAt?: CrashPoint;
}

export const DEFAULT_MODEL = 'fake-model-1';
