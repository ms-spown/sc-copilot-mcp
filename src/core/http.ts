/**
 * Outbound HTTP, with a hard-coded host allowlist.
 *
 * Every request this server makes goes through a client built here. Two rules
 * hold for all of them, and they exist so that a bearer token can never leave
 * for a host it was not issued for:
 *
 *  1. The final URL of a request (base URL + path, or an absolute URL) must be
 *     https and its host must be in that client's allowlist. This is checked on
 *     every request, so a path argument that turns out to be an absolute URL
 *     cannot redirect traffic - or a credential - elsewhere.
 *  2. Redirects are followed only to hosts in the same allowlist, and anything
 *     else fails the request instead of being followed.
 *
 * The credential is attached per request by the interceptor, never stored in
 * the client's default headers, so it is only ever set after rule 1 passed.
 * Base URLs may be overridden from the environment, but only to another host
 * from the hard-coded list: the list is the trust decision, not the environment.
 */

import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from "axios";
import { createRateLimiter, defaultSleep, isRetriableStatus, retryDelay } from "./resilience.js";

/** Hosts each upstream is allowed to be reached on. Change these in code review, not at runtime. */
export const ALLOWED_HOSTS = {
  // The UEX documentation names api.uexcorp.uk; api.uexcorp.space is the older name and still answers.
  uex: ["api.uexcorp.uk", "api.uexcorp.space"],
  wikiApi: ["api.star-citizen.wiki", "star-citizen.wiki"],
  wikiTools: ["starcitizen.tools"],
  githubApi: ["api.github.com"],
  githubRaw: ["raw.githubusercontent.com"],
} as const;

/** Longest a request may stay silent. axios restarts this timer at every byte, so it is NOT a limit on the whole call. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Longest a whole call may take, retries and rate-limit waits included, whatever arrives meanwhile (a server that
 * drips one byte now and then never trips the idle timeout). One and a half times the idle timeout unless set:
 * 45 s by default, 180 s for the clients that download big files (120 s idle). The planner's own limits (25 s for a
 * plan, 20 s for a lookup) stop waiting earlier; this one releases the socket and the cache entry behind them.
 */
export const DEADLINE_FACTOR = 1.5;
/** Largest response body accepted from an API; dump downloads raise it for themselves. */
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface HostPolicy {
  /** Lower-case hostnames that may be contacted. */
  allowedHosts: readonly string[];
  /** Tests only: lets a loopback http server stand in for an upstream. Never set from configuration. */
  allowInsecureHttp?: boolean;
}

/** Throws unless `url` is https (or http when the policy allows it) on an allowed host. */
export function assertAllowedUrl(url: URL, policy: HostPolicy, what = "request"): void {
  const secure =
    url.protocol === "https:" || (policy.allowInsecureHttp && url.protocol === "http:");
  if (!secure) {
    throw new Error(`Blocked ${what} to ${url.protocol}//${url.host}: only https is allowed.`);
  }
  if (url.username || url.password) {
    throw new Error(`Blocked ${what} to ${url.host}: credentials in a URL are not allowed.`);
  }
  if (!policy.allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(
      `Blocked ${what} to ${url.hostname}: host is not in the allowlist (${policy.allowedHosts.join(", ")}).`,
    );
  }
}

/**
 * Resolve a base URL, from an optional override, and refuse any host outside the allowlist.
 * The result has no trailing slash.
 */
export function resolveBaseUrl(
  override: string | undefined,
  fallback: string,
  policy: HostPolicy,
  variableName = "base URL",
): string {
  const raw = override?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variableName} is not a valid URL.`);
  }
  assertAllowedUrl(url, policy, variableName);
  return url.toString().replace(/\/+$/, "");
}

/** What the cache and the providers need from a client: tests can pass a small fake. */
export type HttpClient = Pick<AxiosInstance, "get" | "defaults">;

export interface GuardedClientOptions extends HostPolicy {
  baseURL: string;
  userAgent: string;
  /** Sent as a bearer token on every request that passes the host check; omitted when unset or empty. */
  token?: string;
  timeoutMs?: number;
  /** Total time one call may take, in ms (default: 1.5 times timeoutMs). The call fails as a timeout (ECONNABORTED). */
  deadlineMs?: number;
  headers?: Record<string, string>;
  /** Extra tries after a failure that says "try again" (no answer, 429, 502-504). Default 2; 0 turns it off. */
  retries?: number;
  /** Most requests per minute this client will send; beyond that it waits briefly, then fails clearly. */
  ratePerMinute?: number;
  /** Longest a request will wait for a rate-limit slot before failing instead (default 10 s). */
  maxRateWaitMs?: number;
  /** Tests only: replace the clock and the waiting. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type RetryConfig = InternalAxiosRequestConfig & {
  __attempt?: number;
  /** Set once per call, on the first attempt: retries share the same clock. */
  __deadline?: AbortSignal;
};

/** The total deadline of a client built with these options. */
export function totalDeadlineMs(options: { timeoutMs?: number; deadlineMs?: number }): number {
  if (options.deadlineMs !== undefined) return options.deadlineMs;
  return Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) * DEADLINE_FACTOR);
}

/** Build an axios client that enforces the host policy on requests and redirects. */
export function createGuardedClient(options: GuardedClientOptions): AxiosInstance {
  const policy: HostPolicy = {
    allowedHosts: options.allowedHosts.map((h) => h.toLowerCase()),
    allowInsecureHttp: options.allowInsecureHttp,
  };
  // The base URL itself must satisfy the policy, so a bad constant fails at startup.
  assertAllowedUrl(new URL(options.baseURL), policy, "base URL");

  const client = axios.create({
    baseURL: options.baseURL,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxContentLength: DEFAULT_MAX_BYTES,
    maxRedirects: MAX_REDIRECTS,
    headers: { "User-Agent": options.userAgent, ...options.headers },
    beforeRedirect: (redirectOptions) => {
      const target = new URL(
        `${redirectOptions.protocol ?? "https:"}//${redirectOptions.hostname ?? redirectOptions.host ?? ""}`,
      );
      assertAllowedUrl(target, policy, "redirect");
    },
  });

  const takeSlot = options.ratePerMinute
    ? createRateLimiter(options.ratePerMinute, {
        now: options.now,
        sleep: options.sleep,
        maxWaitMs: options.maxRateWaitMs,
      })
    : null;

  const deadlineMs = totalDeadlineMs(options);
  client.interceptors.request.use(async (config: RetryConfig) => {
    assertAllowedUrl(new URL(client.getUri(config)), policy);
    // The clock of the whole call starts here, once: a retry goes through this interceptor again and keeps it.
    if (deadlineMs > 0 && !config.__deadline) {
      config.__deadline = AbortSignal.timeout(deadlineMs);
      config.signal = config.signal
        ? AbortSignal.any([config.signal as AbortSignal, config.__deadline])
        : config.__deadline;
    }
    // After the host check, so a blocked request does not use up quota.
    if (takeSlot) await takeSlot();
    if (options.token) config.headers.set("Authorization", `Bearer ${options.token}`);
    return config;
  });

  const maxRetries = options.retries ?? 2;
  const sleep = options.sleep ?? defaultSleep;
  client.interceptors.response.use(undefined, async (error: unknown) => {
    if (!axios.isAxiosError(error) || !error.config) throw error;
    const config = error.config as RetryConfig;
    // The deadline cut the call (axios reports an abort as "canceled", or a broken stream): say what happened, as a
    // timeout without a response, which the cache treats as an outage and never retries.
    if (config.__deadline?.aborted) {
      throw new AxiosError(
        `Request exceeded its ${Math.round(deadlineMs / 100) / 10} s total deadline`,
        AxiosError.ECONNABORTED,
        config,
        error.request,
      );
    }
    const attempt = (config.__attempt ?? 0) + 1;
    const method = (config.method ?? "get").toLowerCase();
    if (method !== "get" || attempt > maxRetries || !isRetriableStatus(error.response?.status)) {
      throw error;
    }
    // A timeout already cost the full wait: trying again would leave the question hanging for minutes.
    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") throw error;
    const header = error.response?.headers?.["retry-after"];
    const wait = retryDelay(attempt, typeof header === "string" ? header : undefined);
    if (wait === null) throw error; // the server asked for longer than a question can wait
    await sleep(wait);
    config.__attempt = attempt;
    return client.request(config);
  });

  return client;
}
