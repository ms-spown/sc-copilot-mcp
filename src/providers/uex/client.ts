import { ALLOWED_HOSTS, createGuardedClient } from "../../core/http.js";
import { USER_AGENT } from "../../core/useragent.js";

/** UEX Corp API client. The bearer token is attached per request, and only to UEX hosts. */
export function createUexClient(baseURL: string, token: string | undefined) {
  return createGuardedClient({
    baseURL,
    allowedHosts: ALLOWED_HOSTS.uex,
    userAgent: USER_AGENT,
    token,
  });
}
