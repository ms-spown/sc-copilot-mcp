import { ALLOWED_HOSTS, createGuardedClient } from "../../core/http.js";
import { USER_AGENT } from "../../core/useragent.js";

/** Star Citizen Wiki API client. Public, no credentials. */
export function createScwClient(baseURL: string) {
  return createGuardedClient({
    baseURL,
    allowedHosts: ALLOWED_HOSTS.wikiApi,
    userAgent: USER_AGENT,
    // The wiki API limits searches to 60 a minute.
    ratePerMinute: 50,
  });
}
