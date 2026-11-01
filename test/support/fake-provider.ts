import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake paid model provider served over real HTTP. It bills every request it accepts
 * (a cents counter per call key) and answers with a deterministic completion. Faults are
 * injected by call-key prefix, consumed one per request, in order:
 *
 *   'drop-after-charge'  bills, then closes the socket without answering
 *   'delay <ms>'         bills, answers <ms> later
 *   '429' | '500'        answers that status and does NOT bill
 */
export type Fault = 'drop-after-charge' | `delay ${number}` | '429' | '500';

export const CENTS_PER_CALL = 2;

export interface FakeProvider {
  url: string;
  /** Number of billed requests whose call key starts with `prefix`. */
  charges(prefix?: string): number;
  /** Billed cents for call keys starting with `prefix`. */
  cents(prefix?: string): number;
  /** Requests received (billed or not) whose call key starts with `prefix`. */
  requests(prefix?: string): number;
  /** The next requests whose call key starts with `prefix` get these faults, one each. */
  failNext(prefix: string, ...faults: Fault[]): void;
  reset(): void;
  close(): Promise<void>;
}

export function completionFor(model: string, prompt: string): string {
  return `[${model}] summary ${createHash('sha256').update(prompt).digest('hex').slice(0, 12)}`;
}

export async function startFakeProvider(): Promise<FakeProvider> {
  const billed: { callKey: string; cents: number }[] = [];
  const received: string[] = [];
  const rules: { prefix: string; faults: Fault[] }[] = [];
  const timers = new Set<NodeJS.Timeout>();

  const server = createServer(async (req, res) => {
    const { model, prompt } = JSON.parse(await readBody(req)) as { model: string; prompt: string };
    const callKey = String(req.headers['x-call-key'] ?? '');
    received.push(callKey);

    const rule = rules.find((r) => callKey.startsWith(r.prefix) && r.faults.length > 0);
    const fault = rule?.faults.shift();

    if (fault === '429' || fault === '500') {
      res.writeHead(Number(fault), { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: fault === '429' ? 'rate_limited' : 'internal_error' }));
      return;
    }

    // Every other path does the (paid) work before answering.
    billed.push({ callKey, cents: CENTS_PER_CALL });

    if (fault === 'drop-after-charge') {
      req.socket.destroy();
      return;
    }

    const answer = () => {
      if (res.destroyed) return; // the client gave up; the charge stands
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ completion: completionFor(model, prompt) }));
    };
    if (fault?.startsWith('delay ')) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        answer();
      }, Number(fault.slice('delay '.length)));
      timers.add(timer);
      return;
    }
    answer();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const withPrefix = (prefix: string) => (key: string) => key.startsWith(prefix);

  return {
    url: `http://127.0.0.1:${port}`,
    charges: (prefix = '') => billed.filter((c) => c.callKey.startsWith(prefix)).length,
    cents: (prefix = '') => billed.filter((c) => c.callKey.startsWith(prefix)).reduce((sum, c) => sum + c.cents, 0),
    requests: (prefix = '') => received.filter(withPrefix(prefix)).length,
    failNext: (prefix, ...faults) => {
      rules.push({ prefix, faults });
    },
    reset: () => {
      billed.length = 0;
      received.length = 0;
      rules.length = 0;
    },
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
