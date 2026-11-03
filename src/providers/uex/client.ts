import axios from "axios";
import { ALLOWED_HOSTS, createGuardedClient } from "../../core/http.js";
import { USER_AGENT } from "../../core/useragent.js";
import { remoteText } from "../../core/untrusted.js";

/**
 * UEX answers every call with {status, http_code, data, message}; status is "ok" on success
 * and a code such as "missing_one_required_inputs" otherwise. Both shapes are checked here so
 * a bad or changed response becomes an explicit error instead of an empty answer.
 */
function isEnvelope(body: unknown): body is { status?: string; message?: string; data?: unknown } {
  return typeof body === "object" && body !== null;
}

/**
 * What UEX said about a failure: its status code and message are third-party text (a hostile or
 * compromised answer can put anything there), so they are cleaned, cut and fenced.
 */
function describeUexFailure(status: unknown, message: unknown): string {
  // A status is a code such as "missing_one_required_inputs"; anything else is text, so it is fenced.
  const plain = typeof status === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(status);
  const code = plain ? status : remoteText(status, "uex", 80);
  return `${code}${message ? `: ${remoteText(message, "uex")}` : ""}`;
}

/** UEX Corp API client. The bearer token is attached per request, and only to UEX hosts. */
export function createUexClient(baseURL: string, token: string | undefined) {
  const client = createGuardedClient({
    baseURL,
    allowedHosts: ALLOWED_HOSTS.uex,
    userAgent: USER_AGENT,
    token,
    // UEX allows 120 requests a minute per key; stay well under it.
    ratePerMinute: 100,
  });

  client.interceptors.response.use(
    (response) => {
      const body = response.data;
      if (!isEnvelope(body) || !("data" in body)) {
        throw new Error(
          "UEX returned a response without a `data` field; its API may have changed.",
        );
      }
      if (body.status !== undefined && body.status !== "ok") {
        throw new Error(`UEX error ${describeUexFailure(body.status, body.message)}`);
      }
      return response;
    },
    (error: unknown) => {
      // Keep the axios error (callers still need its status) but say what UEX said.
      if (axios.isAxiosError(error) && isEnvelope(error.response?.data)) {
        const { status, message } = error.response.data;
        if (status)
          error.message = `UEX ${error.response.status} ${describeUexFailure(status, message)}`;
      }
      return Promise.reject(error);
    },
  );

  return client;
}
