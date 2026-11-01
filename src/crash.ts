import { writeSync } from 'node:fs';

/**
 * Fault injection for the crash tests. The worker process kills itself with SIGKILL at the
 * selected point: no `finally`, no shutdown hook, no chance to write anything else.
 * A thrown exception would let cleanup code run, which is exactly what a real crash does not.
 */
export const CRASH_POINTS = ['before_call', 'after_charge'] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export function crashIfAt(selected: CrashPoint | undefined, point: CrashPoint): void {
  if (selected !== point) return;
  writeSync(2, `crash: ${point}\n`); // synchronous, so the marker is out before the process dies
  process.kill(process.pid, 'SIGKILL');
}
