import { fetchWithCache } from "../core/cache.js";
import type { ToolMeta } from "../core/provenance.js";
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

export function createProbes({
  uexClient,
  scwClient,
  sctClient,
  scmdb,
}: ToolClients): StatusProbe[] {
  return [
    {
      id: "uex",
      run: async () => {
        const r = await fetchWithCache(uexClient, "/game_versions", undefined, quiet);
        const v = r.data?.data ?? {};
        const stale = r.cache === "stale-disk";
        return {
          status: stale ? "degraded" : "ok",
          live: { version: v.live ?? null },
          ptu: { version: v.ptu ?? null },
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
          live: { version: row?.version ?? null, as_of: row?.updated_at ?? null },
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
          return { version: c?.version ?? null, as_of: c?.generated_at ?? null };
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
        const builds = await listBuilds(5);
        return {
          status: "ok",
          unlabelled: builds.map((b) => ({ version: b.version, as_of: b.date || null })),
          note: "Build tags do not say LIVE or PTU, so they are listed, not classified. Tags can be republished: results are cached by commit.",
          fetchedAt: Date.now(),
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
          unlabelled: [{ version: info?.launcherVersion ?? info?.version ?? null }],
          note: "Version of the extracted files on disk, which may lag the installed game.",
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
      return r.data?.data?.live ?? null;
    }
    if (meta.source.startsWith("star-citizen.wiki")) {
      const r = await fetchWithCache(scwClient, "/vehicles", WIKI_PROBE, quiet);
      return r.data?.data?.[0]?.version ?? null;
    }
    return null;
  };
}
