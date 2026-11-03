import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCache, configureDiskCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { shortPath } from "../core/paths.js";

/**
 * Feature: a tool never hands the model a full local path (it holds the Windows user name).
 * The folders are temporary and invented; environment variables are stubbed for the test only.
 */

const cp = (...points: number[]) => String.fromCodePoint(...points);
const HIDDEN = cp(...[..."obey"].map((c) => 0xe0000 + c.charCodeAt(0)));

let root: string;
let dataDir: string;
let snapDir: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "scmcp-paths-"));
  dataDir = path.join(root, "jdupont-secret-user", "game-data");
  snapDir = path.join(root, "jdupont-secret-user", "snapshots");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(snapDir, { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "game-mining.json"),
    JSON.stringify({ mineableElements: [{ name: "Raw_Gold" }] }),
  );
  vi.stubEnv("SCMCP_GAME_DATA_DIR", dataDir);
  vi.stubEnv("SCMCP_SNAPSHOT_DIR", snapDir);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  clearCache();
  configureDiskCache(null);
});

const fakeScw = (rows: unknown[]) =>
  ({
    defaults: { baseURL: "https://paths-scw.test" },
    get: async () => ({ data: { data: rows, meta: { last_page: 1 } } }),
  }) as unknown as HttpClient;

describe("Feature: local data outputs use short paths", () => {
  it("shortPath keeps three parts, so the user's folder names are gone", () => {
    expect(shortPath(path.join(dataDir, "x.json"))).toBe("…/jdupont-secret-user/game-data/x.json");
    expect(shortPath(path.join(dataDir, "x.json"))).not.toContain(root);
  });

  it("sc_local_datasets shows the folder without the user's path", async () => {
    vi.resetModules();
    const { localTools } = await import("./local.js");
    const tool = localTools().find((t) => t.name === "sc_local_datasets")!;
    const out = (await tool.handler({})).content[0].text;
    expect(out).toContain("game-mining");
    expect(out).not.toContain(root);
    expect(out).not.toContain(os.tmpdir());
    expect(out).toContain("…/");
  });

  it("the unreadable-folder error does not name the whole path either", async () => {
    vi.resetModules();
    await fs.rm(path.join(root, "gone"), { recursive: true, force: true });
    vi.stubEnv("SCMCP_GAME_DATA_DIR", path.join(root, "jdupont-secret-user", "gone", "data"));
    const { listDatasets } = await import("../providers/local/localdata.js");
    const message = await listDatasets().then(
      () => "",
      (e: Error) => e.message,
    );
    expect(message).toMatch(/cannot be read/);
    expect(message).not.toContain(root);
    expect(message).toContain("…/");
    vi.stubEnv("SCMCP_GAME_DATA_DIR", dataDir);
  });

  it("collectLabels refuses a dataset name that is a path", async () => {
    vi.resetModules();
    const { collectLabels } = await import("../providers/local/localdata.js");
    for (const bad of ["../x", "..\\x", "a/b", "C:x", "game-mining.json:stream"]) {
      await expect(collectLabels(bad), bad).rejects.toThrow(/Invalid dataset name/);
    }
    const ok = await collectLabels("game-mining");
    expect(ok.directory).not.toContain(root);
  });
});

describe("Feature: wiki snapshots", () => {
  it("scw_snapshot_save reports a short path and a clean game version", async () => {
    vi.resetModules();
    const { wikiTools } = await import("./wiki.js");
    const hostile = `4.10.2 ${HIDDEN}${"v".repeat(300)}`;
    const tools = wikiTools({ scwClient: fakeScw([{ name: "Gladius", version: hostile }]) });
    const save = tools.find((t) => t.name === "scw_snapshot_save")!;

    const body = JSON.parse((await save.handler({ dataset: "vehicles" })).content[0].text);

    expect(body.saved).not.toContain(root);
    expect(body.saved.startsWith("…/")).toBe(true);
    expect(body.game_version.length).toBeLessThanOrEqual(80);
    expect(/[\u{e0000}-\u{e007f}]/u.test(JSON.stringify(body))).toBe(false);
  });

  it("scw_snapshot_list shows a short folder and cleans labels read from the files", async () => {
    vi.resetModules();
    await fs.writeFile(
      path.join(snapDir, "vehicles__hostile.json"),
      JSON.stringify({
        dataset: "vehicles",
        label: `lbl${HIDDEN}`,
        game_version: `9.9${HIDDEN}${"w".repeat(500)}`,
        captured_at: "2026-11-01T00:00:00Z",
        entries: {},
      }),
    );
    const { wikiTools } = await import("./wiki.js");
    const list = wikiTools({ scwClient: fakeScw([]) }).find((t) => t.name === "scw_snapshot_list")!;

    const out = (await list.handler({})).content[0].text;
    const body = JSON.parse(out);

    expect(out).not.toContain(root);
    expect(body.snapshot_dir.startsWith("…/")).toBe(true);
    const snap = body.snapshots.find((s: { label: string }) => s.label?.startsWith("lbl"));
    expect(snap.label).toBe("lbl");
    expect(snap.game_version.length).toBeLessThanOrEqual(80);
    expect(/[\u{e0000}-\u{e007f}]/u.test(out)).toBe(false);
  });
  it("scw_snapshot_diff with an unknown label does not leak the path in its error", async () => {
    vi.resetModules();
    const { wikiTools } = await import("./wiki.js");
    const diff = wikiTools({ scwClient: fakeScw([]) }).find((t) => t.name === "scw_snapshot_diff")!;
    const message = await diff.handler({ from_label: "nope", dataset: "vehicles" }).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(message).toMatch(/No vehicles snapshot labelled "nope"/);
    expect(message).not.toContain(root);
    expect(message).not.toContain(path.sep + "jdupont");
  });
});
