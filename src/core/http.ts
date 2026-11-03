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

import axios, { type AxiosInstance } from "axios";

/** Hosts each upstream is allowed to be reached on. Change these in code review, not at runtime. */
export const ALLOWED_HOSTS = {
  // The UEX documentation names api.uexcorp.uk; api.uexcorp.space is the older name and still answers.
  uex: ["api.uexcorp.uk", "api.uexcorp.space"],
  wikiApi: ["api.star-citizen.wiki", "star-citizen.wiki"],
  wikiTools: ["starcitizen.tools"],
  githubApi: ["api.github.com"],
  githubRaw: ["raw.githubusercontent.com"],
} as const;

export const DEFAULT_TIMEOUT_MS = 30_000;
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
  headers?: Record<string, string>;
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

  client.interceptors.request.use((config) => {
    assertAllowedUrl(new URL(client.getUri(config)), policy);
    if (options.token) config.headers.set("Authorization", `Bearer ${options.token}`);
    return config;
  });

  return client;
}
