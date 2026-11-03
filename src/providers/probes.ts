import { fetchWithCache } from "../core/cache.js";
import type { ToolMeta } from "../core/provenance.js";
import { cleanLabel } from "../core/untrusted.js";
import type { StatusProbe } from "../tools/status.js";
import type { ToolClients } from "../tools/registry.js";
import { listBuilds } from "./dumps/versions.js";
import { GAME_DATA_DIR, listDatasets } from "./local/localdata.js";

/**
 * One probe per data source, for sc_data_status. They go through the same cache as the tools
 * (so a status check does not hammer the upstreams) but are not recorded as a tool's inputs.
 */

const quiet = { record: false } as const;
const WIKI_PROBE = { params: { "page[number]": 1, "page[size]": 1 } };

/** What a probe reaches outside the clients. Tests replace it so that no probe touches the network. */
export interface ProbeSources {
  listBuilds?: typeof listBuilds;
}

export function createProbes(
  { uexClient, scwClient, sctClient, scmdb, gameLog, telemetry }: ToolClients,
  sources: ProbeSources = {},
): StatusProbe[] {
  const builds = sources.listBuilds ?? listBuilds;
  return [
    {
      id: "uex",
      run: async () => {
        const r = await fetchWithCache(uexClient, "/game_versions", undefined, quiet);
        const v = r.data?.data ?? {};
        const stale = r.cache === "stale-disk";
        return {
          status: stale ? "degraded" : "ok",
          // UEX and the wiki are third parties: their versions are cleaned and bounded here.
          live: { version: cleanLabel(v.live) },
          ptu: { version: cleanLabel(v.ptu) },
          fetchedAt: r.fetchedAt,
          ...(stale ? { error: r.staleReason } : {}),
        };
      },
    },
    {
      id: "star-citizen.wiki",
      run: async () => {
        const r = await fetchWithCache(scwClient, "/vehicles", WIKI_PROBE, quiet);
        const row = r.data?.data?.[0];
        const stale = r.cache === "stale-disk";
        return {
          status: stale ? "degraded" : "ok",
          live: { version: cleanLabel(row?.version), as_of: cleanLabel(row?.updated_at) },
          ptu: { version: null },
          note: "The wiki API serves one environment (LIVE); it has no PTU data.",
          fetchedAt: r.fetchedAt,
          ...(stale ? { error: r.staleReason } : {}),
        };
      },
    },
    {
      id: "starcitizen.tools",
      run: async () => {
        const r = await fetchWithCache(
          sctClient,
          "/api.php",
          { params: { action: "query", meta: "siteinfo", format: "json" } },
          quiet,
        );
        return {
          status: r.cache === "stale-disk" ? "degraded" : "ok",
          note: "Wiki articles carry no game version; this checks that the site answers.",
          fetchedAt: r.fetchedAt,
          ...(r.cache === "stale-disk" ? { error: r.staleReason } : {}),
        };
      },
    },
    {
      id: "scmdb",
      run: async () => {
        const { manifest, fetchedAt, stale } = await scmdb.manifest();
        const channel = (name: string) => {
          const c = manifest.channels[name];
          // sc_data_status is a structured tool: strings that come from a third-party file are cleaned.
          return {
            version: cleanLabel(c?.version),
            as_of: cleanLabel(c?.generated_at),
          };
        };
        return {
          status: stale ? "degraded" : "ok",
          live: channel("live"),
          ptu: channel("ptu"),
          fetchedAt,
          note: "as_of is when the maintainer last regenerated that channel.",
          ...(stale ? { error: stale } : {}),
        };
      },
    },
    {
      id: "sc-gamedata-dumps",
      run: async () => {
        const found = await builds(5);
        return {
          status: "ok",
          unlabelled: found.map((b) => ({
            version: cleanLabel(b.version),
            as_of: cleanLabel(b.date),
          })),
          note: "Build tags do not say LIVE or PTU, so they are listed, not classified. Tags can be republished: results are cached by commit.",
          fetchedAt: Date.now(),
        };
      },
    },
    {
      id: "game-log",
      run: async () => {
        if (!gameLog.configured) {
          return {
            status: "not_configured",
            note: "Set SC_GAME_LOG_PATH or SC_INSTALL_DIR to enable the sc_log_* tools.",
          };
        }
        const r = await gameLog.read();
        const s = r.parsed.session;
        const info = {
          version: cleanLabel(
            s.game_version ? `${s.game_version}${s.build ? ` (build ${s.build})` : ""}` : null,
          ),
          as_of: cleanLabel(s.started_local),
        };
        return {
          status: "ok",
          ...(s.channel === "ptu"
            ? { ptu: info }
            : s.channel === "live"
              ? { live: info }
              : { unlabelled: [info] }),
          fetchedAt: r.modifiedAt,
          note: "The game on this PC, from its own log header. Its file version has a different format from the public version number; compare builds.",
        };
      },
    },
    {
      id: "live-telemetry",
      run: async () => {
        if (!telemetry?.enabled) {
          return {
            status: "not_configured",
            state: "off",
            note: "Live telemetry is off (the default). sc_live_status explains how to enable it; nothing is read or connected while it is off.",
          };
        }
        // Peek only: asking for the status of the sources must not start the reader.
        const s = await telemetry.status(false);
        return {
          status: s.state === "incompatible" ? "degraded" : "ok",
          state: s.state,
          ...(s.state === "incompatible" ? { error: s.cause } : {}),
          note: `${s.cause} The game-side switch is separate (GRPC_CLIENT_SERVER_ENABLED); see sc_live_status.`,
        };
      },
    },
    {
      id: "local-files",
      run: async () => {
        if (!GAME_DATA_DIR) {
          return {
            status: "not_configured",
            note: "Set SCMCP_GAME_DATA_DIR to enable the sc_*_local tools.",
          };
        }
        const { build_version } = await listDatasets();
        const info = build_version as { version?: string; launcherVersion?: string } | undefined;
        return {
          status: "ok",
          unlabelled: [{ version: cleanLabel(info?.launcherVersion ?? info?.version) }],
          note: "Build the local game-*.json files say they come from; it may lag the installed game.",
          fetchedAt: Date.now(),
        };
      },
    },
  ];
}

/** Game version to put in a tool's provenance, for sources whose rows do not carry it. */
export function createGameVersionResolver({ uexClient, scwClient }: ToolClients) {
  return async (meta: ToolMeta): Promise<string | null> => {
    if (meta.source === "uex") {
      const r = await fetchWithCache(uexClient, "/game_versions", undefined, quiet);
      return cleanLabel(r.data?.data?.live);
    }
    if (meta.source.startsWith("star-citizen.wiki")) {
      const r = await fetchWithCache(scwClient, "/vehicles", WIKI_PROBE, quiet);
      return cleanLabel(r.data?.data?.[0]?.version);
    }
    return null;
  };
}
