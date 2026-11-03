import { ALLOWED_HOSTS, resolveBaseUrl } from "./http.js";

export interface Config {
  uexToken: string | undefined;
  uexBaseUrl: string;
  scwBaseUrl: string;
  sctBaseUrl: string;
  /**
   * Tools to advertise (SCMCP_TOOLS, comma-separated). null advertises everything.
   *
   * This exists for latency, not security: a client that sees many tools has to spend a
   * round trip searching for the right one, which is dead weight for a narrow use case
   * (a live voice assistant answering "what does X sell for" never touches
   * sc_local_datasets or sc_diff_versions). It only filters the listing: a tool that is
   * not advertised can still be called by name.
   */
  enabledTools: Set<string> | null;
  /** SCMCP_PROFILES, comma-separated (core, trade, data, local). Used when SCMCP_TOOLS is unset. */
  profiles: string[] | null;
}

/** Read the configuration from the environment. Throws if a base URL points outside its allowlist. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    uexToken: env.UEXTOKEN,
    uexBaseUrl: resolveBaseUrl(
      env.SCMCP_UEX_BASE_URL,
      "https://api.uexcorp.uk/2.0",
      { allowedHosts: ALLOWED_HOSTS.uex },
      "SCMCP_UEX_BASE_URL",
    ),
    scwBaseUrl: resolveBaseUrl(
      env.SCMCP_SCW_BASE_URL,
      "https://api.star-citizen.wiki/api/v2",
      { allowedHosts: ALLOWED_HOSTS.wikiApi },
      "SCMCP_SCW_BASE_URL",
    ),
    sctBaseUrl: resolveBaseUrl(
      env.SCMCP_SCT_BASE_URL,
      "https://starcitizen.tools",
      { allowedHosts: ALLOWED_HOSTS.wikiTools },
      "SCMCP_SCT_BASE_URL",
    ),
    enabledTools: env.SCMCP_TOOLS
      ? new Set(
          env.SCMCP_TOOLS.split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        )
      : null,
    profiles: env.SCMCP_PROFILES
      ? env.SCMCP_PROFILES.split(",")
          .map((p) => p.trim().toLowerCase())
          .filter(Boolean)
      : null,
  };
}
