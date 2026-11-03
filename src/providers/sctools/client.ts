import { ALLOWED_HOSTS, createGuardedClient } from "../../core/http.js";
import { USER_AGENT } from "../../core/useragent.js";

/** Star Citizen Tools (starcitizen.tools) client. Public MediaWiki, no credentials. */
export function createSctClient(baseURL: string) {
  return createGuardedClient({
    baseURL,
    allowedHosts: ALLOWED_HOSTS.wikiTools,
    userAgent: USER_AGENT,
  });
}
