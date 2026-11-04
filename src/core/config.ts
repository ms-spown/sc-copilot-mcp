import { parseBalanceEnv } from "./balance.js";
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
  /**
   * SC_TELEMETRY=on switches on the server side of the live telemetry reader. Off unless set explicitly; the
   * game-side switch is separate and never touched by this process.
   */
  telemetry: boolean;
  /**
   * SC_BALANCE=hidden starts the server with the aUEC amounts hidden (dashboard and tools). Unset or "shown": shown,
   * which is the default. An unrecognised value hides them (a typo fails toward privacy) and `balanceEnvUnrecognised`
   * lets the entry point say so on stderr.
   */
  balanceHiddenByDefault: boolean;
  balanceEnvUnrecognised: boolean;
}

/** Read the configuration from the environment. Throws if a base URL points outside its allowlist. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const balance = parseBalanceEnv(env.SC_BALANCE);
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
    telemetry: /^(on|1|true|yes)$/i.test(env.SC_TELEMETRY?.trim() ?? ""),
    balanceHiddenByDefault: balance.hiddenByDefault,
    balanceEnvUnrecognised: balance.unrecognised,
  };
}
