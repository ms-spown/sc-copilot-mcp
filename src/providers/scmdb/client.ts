import { ALLOWED_HOSTS, createGuardedClient, type HttpClient } from "../../core/http.js";
import { userCacheDir } from "../../core/paths.js";
import { USER_AGENT } from "../../core/useragent.js";
import { Scmdb } from "./store.js";

/** SCMDB reader: public raw files, plus api.github.com only to learn the current commit SHA. */
export function createScmdb(overrides: { raw?: HttpClient; api?: HttpClient } = {}): Scmdb {
  return new Scmdb({
    raw:
      overrides.raw ??
      createGuardedClient({
        baseURL: "https://raw.githubusercontent.com",
        allowedHosts: ALLOWED_HOSTS.githubRaw,
        userAgent: USER_AGENT,
        timeoutMs: 120_000,
      }),
    api:
      overrides.api ??
      createGuardedClient({
        baseURL: "https://api.github.com",
        allowedHosts: ALLOWED_HOSTS.githubApi,
        userAgent: USER_AGENT,
        // Optional, only raises the rate limit; a dedicated variable, never an ambient token.
        token: process.env.SCMCP_GITHUB_TOKEN,
      }),
    repo: process.env.SCMCP_SCMDB_REPO || "KrovaxCode/SCMDB_DATA",
    cacheDir: () => userCacheDir(),
  });
}
