export class TimeoutError extends Error {}

/** Thrown to unwind the replay once a failure has been reported; it carries no finding itself. */
export class StoppedError extends Error {
  constructor() { super("Replay stopped after a failure."); }
}

export const maxTimerMs = 2147483647;

export function isValidTimeout(ms: number): boolean {
  return Number.isSafeInteger(ms) && ms > 0 && ms <= maxTimerMs;
}

/**
 * Race `promise` against a deadline and an optional abort signal.
 * Timers and abort listeners are always removed, so a long replay does not accumulate waiters.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms} ms.`)), ms);
        if (signal) {
          onAbort = () => reject(new StoppedError());
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
