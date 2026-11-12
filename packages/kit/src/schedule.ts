import { ensure, Fault } from "./fault.js";

export interface WindowRun<T> {
  /** Unix seconds; the first attempt happens once `now >= opensAt`. */
  opensAt: bigint;
  /** Unix seconds; no attempt starts once `now >= closesAt`. */
  closesAt: bigint;
  attempt(): Promise<T>;
  /** Errors that end the run instead of being retried. */
  isFinal?(error: unknown): boolean;
  onRetry?(error: unknown, delayMs: number): void;
  pollMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface WindowHandle<T> {
  result: Promise<T>;
  stop(): void;
}

/**
 * Retry `attempt` with exponential backoff while the time window is open.
 * Used for the provider's pre-deadline claim and the hive's post-deadline refund.
 */
export function runInWindow<T>(run: WindowRun<T>): WindowHandle<T> {
  const poll = run.pollMs ?? 1000;
  const initial = run.initialBackoffMs ?? 1000;
  const maximum = run.maxBackoffMs ?? 10_000;
  for (const value of [poll, initial, maximum])
    ensure(Number.isSafeInteger(value) && value >= 10, "INVALID_SCHEDULE");
  ensure(initial <= maximum && run.opensAt < run.closesAt, "INVALID_SCHEDULE");
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let busy = false;
  let nextAttemptAt = 0;
  let backoff = initial;
  let settle!: { resolve(value: T): void; reject(error: unknown): void };
  const result = new Promise<T>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
  const tick = async () => {
    if (stopped || busy || Date.now() < nextAttemptAt) return;
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now < run.opensAt) return;
    if (now >= run.closesAt) {
      stop();
      settle.reject(new Fault("WINDOW_CLOSED"));
      return;
    }
    busy = true;
    try {
      const value = await run.attempt();
      stop();
      settle.resolve(value);
    } catch (error) {
      if (run.isFinal?.(error)) {
        stop();
        settle.reject(error);
      } else {
        nextAttemptAt = Date.now() + backoff;
        run.onRetry?.(error, backoff);
        backoff = Math.min(maximum, backoff * 2);
      }
    } finally {
      busy = false;
    }
  };
  timer = setInterval(() => void tick(), poll);
  void tick();
  return {
    result,
    stop() {
      if (stopped) return;
      stop();
      settle.reject(new Fault("STOPPED"));
    },
  };
}
