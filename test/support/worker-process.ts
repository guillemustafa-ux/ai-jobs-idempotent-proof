import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CrashPoint } from '../../src/crash.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The worker printed its normal end-of-pass line. */
  completed: boolean;
  /** The worker reached this crash point and killed itself there. */
  crashedAt: CrashPoint | undefined;
  output: string;
}

/** Run one worker pass in a separate OS process: `node --import tsx src/worker.ts`. */
export function runWorkerProcess(opts: {
  side: 'honest' | 'naive';
  fault?: CrashPoint;
  databaseUrl: string;
  providerUrl: string;
  leaseSeconds: number;
  callTimeoutMs: number;
}): Promise<WorkerExit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/worker.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: opts.databaseUrl,
        PROVIDER_URL: opts.providerUrl,
        SIDE: opts.side,
        FAULT: opts.fault ?? '',
        LEASE_SECONDS: String(opts.leaseSeconds),
        CALL_TIMEOUT_MS: String(opts.callTimeoutMs),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      const crashed = /crash: (before_call|after_charge)/.exec(output);
      resolve({
        code,
        signal,
        completed: output.includes('worker: pass complete'),
        crashedAt: crashed?.[1] as CrashPoint | undefined,
        output,
      });
    });
  });
}

/** How the OS reports a process that SIGKILLed itself: a signal on POSIX, exit code 1 on Windows. */
export function killedBySigkill(exit: WorkerExit): boolean {
  return process.platform === 'win32' ? exit.code === 1 && exit.signal === null : exit.signal === 'SIGKILL';
}
