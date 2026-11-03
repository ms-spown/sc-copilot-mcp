/**
 * Retry and rate limiting for outbound requests.
 *
 * Retries are for failures that say "try again": no answer at all, a timeout, HTTP 429 or a 5xx.
 * A 400, 401, 403 or 404 is never retried: repeating a request the server rejected only wastes
 * quota. Only GET is retried, and the wait is short (this server answers a person, not a batch job).
 */

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** HTTP statuses worth another try. */
export function isRetriableStatus(status: number | undefined): boolean {
  return (
    status === undefined || status === 429 || status === 502 || status === 503 || status === 504
  );
}

/**
 * How long to wait before attempt number `attempt` (1 = first retry), in ms. A Retry-After of up to
 * `maxWaitMs` is honoured; a longer one means "not now": null, and the caller gives up.
 */
export function retryDelay(
  attempt: number,
  retryAfterHeader: string | undefined,
  maxWaitMs = 5000,
  random: () => number = Math.random,
): number | null {
  if (retryAfterHeader !== undefined) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      const ms = seconds * 1000;
      return ms <= maxWaitMs ? ms : null;
    }
  }
  const base = 400 * 3 ** (attempt - 1); // 400 ms, 1.2 s, 3.6 s ...
  return Math.min(maxWaitMs, base + Math.floor(random() * 200));
}

/**
 * Sliding-window limiter: at most `perMinute` requests in any 60 seconds. When the window is full
 * it waits, but never longer than `maxWaitMs`: past that it fails with a clear message instead of
 * leaving a question hanging.
 */
export function createRateLimiter(
  perMinute: number,
  options: { now?: () => number; sleep?: (ms: number) => Promise<void>; maxWaitMs?: number } = {},
): () => Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const maxWaitMs = options.maxWaitMs ?? 10_000;
  const stamps: number[] = [];

  return async function take() {
    for (;;) {
      const t = now();
      while (stamps.length > 0 && t - stamps[0] >= 60_000) stamps.shift();
      if (stamps.length < perMinute) {
        stamps.push(t);
        return;
      }
      const wait = 60_000 - (t - stamps[0]);
      if (wait > maxWaitMs) {
        throw new Error(
          `Local rate limit reached (${perMinute} requests per minute for this source). Try again in ${Math.ceil(wait / 1000)} s.`,
        );
      }
      await sleep(wait);
    }
  };
}
