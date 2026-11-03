import { describe, expect, it } from "vitest";
import { collectStatus, type StatusProbe } from "./status.js";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const ok = (id: string, live: string | null, extra = {}): StatusProbe => ({
  id,
  run: async () => ({ status: "ok", live: { version: live }, fetchedAt: NOW - 120_000, ...extra }),
});

describe("collectStatus", () => {
  it("reports each source's version and age", async () => {
    const out = await collectStatus([ok("uex", "4.10.2")], NOW);
    expect(out.live_versions).toEqual([{ source: "uex", version: "4.10.2" }]);
    expect(out.sources[0]).toMatchObject({ id: "uex", status: "ok", data_age: "2m" });
    expect(out.warnings).toEqual([]);
  });

  it("treats 4.10.2 and 4.10.2-LIVE.12881860 as the same release", async () => {
    const out = await collectStatus([ok("uex", "4.10.2"), ok("wiki", "4.10.2-LIVE.12881860")], NOW);
    expect(out.warnings).toEqual([]);
  });

  it("shows a version mismatch instead of picking a winner", async () => {
    const out = await collectStatus([ok("uex", "4.10.2"), ok("dumps", "4.9.5-LIVE.1")], NOW);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(
      /LIVE differs between sources: uex=4\.10\.2, dumps=4\.9\.5-LIVE\.1/,
    );
  });

  it("reports a failing source as an error with its message, never as an empty value", async () => {
    const down: StatusProbe = {
      id: "wiki",
      run: async () => {
        throw new Error("HTTP 503");
      },
    };
    const out = await collectStatus([down, ok("uex", "4.10.2")], NOW);
    expect(out.sources.find((s) => s.id === "wiki")).toMatchObject({
      status: "error",
      error: "HTTP 503",
    });
    expect(out.sources.find((s) => s.id === "uex")?.status).toBe("ok");
    expect(out.warnings).toContain("wiki is unavailable: HTTP 503");
  });

  it("lists a source that is not configured without calling it a failure", async () => {
    const off: StatusProbe = {
      id: "local-files",
      run: async () => ({ status: "not_configured", note: "unset" }),
    };
    const out = await collectStatus([off], NOW);
    expect(out.sources[0]).toMatchObject({ status: "not_configured" });
    expect(out.warnings).toEqual([]);
  });

  it("warns about a degraded source (stale data)", async () => {
    const stale = ok("uex", "4.10.2", { status: "degraded", error: "serving the last good copy" });
    const out = await collectStatus([stale], NOW);
    expect(out.warnings).toEqual(["uex is degraded: serving the last good copy"]);
  });
});

describe("build comparison", () => {
  it("compares build numbers when sources give them, and says which differ", async () => {
    const out = await collectStatus(
      [
        ok("wiki", "4.10.2-LIVE.12881860"),
        ok("scmdb", "4.10.2-live.12913470"),
        ok("game-log", "4.10.197.2878 (build 12881860)"),
      ],
      NOW,
    );
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(/LIVE builds differ.*wiki=.*12881860.*scmdb=.*12913470/);
  });

  it("does not mistake a file version (4.10.197.2878) for a public release", async () => {
    const out = await collectStatus([ok("uex", "4.10.2"), ok("game-log", "4.10.197.2878")], NOW);
    expect(out.warnings).toEqual([]);
  });
});
