import { createHash } from 'node:crypto';

/** What the caller asks for. The caller supplies the identity; the library derives the keys. */
export interface JobRequest {
  tenant: string;
  resource: string;
  promptVersion: string;
  /** Hash of the input the prompt is built from (see `hashInput`). */
  inputHash: string;
  /** The prompt text sent to the model. */
  prompt: string;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export function hashInput(input: string): string {
  return sha256(input);
}

/**
 * The same request always maps to the same key, so a replayed enqueue (double click,
 * client retry, app restart) finds the existing job instead of creating a second one.
 * The tenant stays readable as a prefix so ledgers and logs can be grouped by tenant.
 */
export function jobKeyFor(req: Pick<JobRequest, 'tenant' | 'resource' | 'promptVersion' | 'inputHash'>): string {
  const digest = sha256([req.tenant, req.resource, req.promptVersion, req.inputHash].join('\u0000'));
  return `${req.tenant}:${digest.slice(0, 32)}`;
}

/** Results are shared across jobs that ask the same model the same thing. */
export function cacheKeyFor(inputHash: string, model: string, promptVersion: string): string {
  return sha256([inputHash, model, promptVersion].join('\u0000'));
}
