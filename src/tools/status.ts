import { humanizeAge } from "../core/provenance.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * sc_data_status: which game version each source is on, how old it is, and which sources are
 * down or not configured. A source that fails is reported as failed with its error; it is
 * never replaced by an empty value, because "no data" and "could not ask" are different facts.
 */

export interface ChannelInfo {
  version: string | null;
  /** When that source says its data was produced, if it says. */
  as_of?: string | null;
}

export interface SourceStatus {
  status: "ok" | "degraded" | "error" | "not_configured";
  live?: ChannelInfo;
  ptu?: ChannelInfo;
  /** For a source whose versions do not say LIVE or PTU: shown as is, never classified. */
  unlabelled?: ChannelInfo[];
  /** When we last got this from the source (epoch ms). */
  fetchedAt?: number;
  error?: string;
  note?: string;
}

export interface StatusProbe {
  id: string;
  run: () => Promise<SourceStatus>;
}

const PROBE_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A public release: "4.10.2" or "4.10.2-LIVE.12881860". A file version such as "4.10.197.2878" is not one. */
function release(version: string | null | undefined): string | null {
  const m = version?.match(/^(\d+\.\d+\.\d+)(?:-|$)/);
  return m ? m[1] : null;
}

/** The 7 or 8 digit build number inside a version string, when it has one. */
function build(version: string | null | undefined): string | null {
  return version?.match(/\b(\d{7,8})\b/)?.[1] ?? null;
}

export async function collectStatus(probes: StatusProbe[], now: number = Date.now()) {
  const settled = await Promise.all(
    probes.map(async (probe) => {
      try {
        return { id: probe.id, ...(await withTimeout(probe.run(), PROBE_TIMEOUT_MS)) };
      } catch (error) {
        return {
          id: probe.id,
          status: "error" as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  // as_of is the date the source gives for its data: say how old that is. cache_age is only
  // how long ago this server asked.
  const dated = (info: ChannelInfo | undefined) => {
    const at = info?.as_of ? Date.parse(info.as_of) : NaN;
    return info && Number.isFinite(at) ? { ...info, as_of_age: humanizeAge(now - at) } : info;
  };
  const sources = settled.map(({ fetchedAt, ...rest }) => ({
    ...rest,
    ...("live" in rest ? { live: dated(rest.live) } : {}),
    ...("ptu" in rest ? { ptu: dated(rest.ptu) } : {}),
    ...("unlabelled" in rest && rest.unlabelled
      ? { unlabelled: rest.unlabelled.map((c) => dated(c)) }
      : {}),
    ...(fetchedAt !== undefined
      ? { fetched_at: new Date(fetchedAt).toISOString(), cache_age: humanizeAge(now - fetchedAt) }
      : {}),
  }));

  const warnings: string[] = [];
  const reported = (channel: "live" | "ptu") =>
    sources.flatMap((s) => {
      const version = s[channel]?.version;
      return version ? [{ source: s.id, version }] : [];
    });

  for (const channel of ["live", "ptu"] as const) {
    const versions = reported(channel);
    const label = (list: { source: string; version: string }[]) =>
      list.map((v) => `${v.source}=${v.version}`).join(", ");

    // Sources that name a build are compared on it: that is where LIVE really differs.
    const withBuild = versions.filter((v) => build(v.version));
    if (new Set(withBuild.map((v) => build(v.version))).size > 1) {
      warnings.push(
        `${channel.toUpperCase()} builds differ between sources: ${label(withBuild)}. Sources sync at different times; the highest build number is the newest.`,
      );
    }
    // Others are compared on the public release number, when they have one.
    const withRelease = versions.filter((v) => release(v.version));
    if (new Set(withRelease.map((v) => release(v.version))).size > 1) {
      warnings.push(
        `${channel.toUpperCase()} differs between sources: ${label(withRelease)}. Sources sync at different times; trust the one with the newest build.`,
      );
    }
  }
  for (const s of sources) {
    if (s.status === "error") warnings.push(`${s.id} is unavailable: ${s.error}`);
    if (s.status === "degraded")
      warnings.push(`${s.id} is degraded: ${s.error ?? s.note ?? "see its entry"}`);
  }

  return {
    checked_at: new Date(now).toISOString(),
    live_versions: reported("live"),
    ptu_versions: reported("ptu"),
    warnings,
    sources,
  };
}

export function statusTools(probes: StatusProbe[]): ToolDefinition[] {
  return [
    {
      name: "sc_data_status",
      description:
        "Check how fresh and reliable this server's data is: the LIVE and PTU game versions each source reports (UEX, Star Citizen Wiki, patch dumps, local files), how old each is, differences between them, and which sources are down or not configured. Call it first when a question depends on the current patch, or when another tool's answer looks wrong or stale.",
      inputSchema: { type: "object", properties: {} },
      handler: async (): Promise<ToolResult> => ({
        content: [{ type: "text", text: JSON.stringify(await collectStatus(probes), null, 2) }],
      }),
    },
  ];
}
