import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "scmcp-localdata-"));
  await fs.writeFile(
    path.join(dir, "game-build-version.json"),
    JSON.stringify({ version: "4.10.x", launcherVersion: "4.10.0-live.12519617" }),
  );
  await fs.writeFile(
    path.join(dir, "game-mining.json"),
    JSON.stringify({
      _source: "Star Citizen Game Files (extracted)",
      _extracted: "2026-08-27",
      mineableElements: [
        { name: "Raw_Quantainium", instability: 1000, resistance: 0.95 },
        { name: "Raw_Gold", instability: 200, resistance: 0.4 },
      ],
      oreSignatures: { Quantainium: 1720, Gold: 1120 },
    }),
  );
  // A file outside the data dir, to prove traversal cannot reach it.
  await fs.writeFile(path.join(dir, "..", "scmcp-secret.json"), JSON.stringify({ token: "nope" }));
  vi.stubEnv("SCMCP_GAME_DATA_DIR", dir);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(path.join(dir, "..", "scmcp-secret.json"), { force: true });
});

/** Imported lazily so the module reads the stubbed env var. */
async function mod() {
  vi.resetModules();
  return import("./localdata.js");
}

describe("listDatasets", () => {
  it("reports the build version and each dataset's collections", async () => {
    const { listDatasets } = await mod();
    const result = await listDatasets();
    expect(result.build_version).toMatchObject({ launcherVersion: "4.10.0-live.12519617" });

    const mining = result.datasets.find((d) => d.dataset === "game-mining");
    expect(mining).toBeDefined();
    const names = mining!.collections.map((c) => c.name);
    expect(names).toContain("mineableElements");
    expect(names).toContain("oreSignatures");
    // Provenance keys are not game content.
    expect(names).not.toContain("_source");
    expect(names).not.toContain("_extracted");
  });

  it("orders collections by size so the substantial ones come first", async () => {
    const { listDatasets } = await mod();
    const mining = (await listDatasets()).datasets.find((d) => d.dataset === "game-mining")!;
    const counts = mining.collections.map((c) => c.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});

describe("searchDataset", () => {
  it("finds a record by name and labels it", async () => {
    const { searchDataset } = await mod();
    const result = await searchDataset("game-mining", "quantainium");
    expect(result.total_matches).toBe(2); // the element and the signature entry
    const element = result.hits.find((h) => h.collection === "mineableElements");
    expect(element?.label).toBe("Raw_Quantainium");
    expect(element?.record).toMatchObject({ instability: 1000 });
  });

  it("can be scoped to one collection", async () => {
    const { searchDataset } = await mod();
    const result = await searchDataset("game-mining", "quantainium", {
      collection: "oreSignatures",
    });
    expect(result.total_matches).toBe(1);
    expect(result.hits[0].collection).toBe("oreSignatures");
  });

  it("caps returned hits while still reporting the true total", async () => {
    const { searchDataset } = await mod();
    const result = await searchDataset("game-mining", "raw", { limit: 1 });
    expect(result.hits).toHaveLength(1);
    expect(result.total_matches).toBe(2);
  });

  it("accepts a dataset name with or without the .json suffix", async () => {
    const { searchDataset } = await mod();
    const a = await searchDataset("game-mining", "gold");
    const b = await searchDataset("game-mining.json", "gold");
    expect(a.total_matches).toBe(b.total_matches);
  });

  it("refuses to read outside the configured directory", async () => {
    const { searchDataset } = await mod();
    await expect(searchDataset("../scmcp-secret", "token")).rejects.toThrow(/Invalid dataset/);
    await expect(searchDataset("/etc/passwd", "root")).rejects.toThrow(/Invalid dataset/);
  });

  it("refuses Windows-style escapes: backslashes, drive letters, alternate data streams", async () => {
    const { searchDataset, readCollection } = await mod();
    for (const name of [
      "..\\scmcp-secret",
      "C:\\Windows\\win",
      "C:win",
      "game-mining.json:stream",
      "\\\\server\\share\\x",
    ]) {
      await expect(searchDataset(name, "x")).rejects.toThrow(/Invalid dataset/);
      await expect(readCollection(name, "x")).rejects.toThrow(/Invalid dataset/);
    }
  });
});

describe("readCollection", () => {
  it("pages through a collection", async () => {
    const { readCollection } = await mod();
    const page = await readCollection("game-mining", "mineableElements", { offset: 1, limit: 1 });
    expect(page.total).toBe(2);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0].label).toBe("Raw_Gold");
  });

  it("names the available collections when asked for one that is absent", async () => {
    const { readCollection } = await mod();
    await expect(readCollection("game-mining", "nope")).rejects.toThrow(/mineableElements/);
  });
});

describe("when SCMCP_GAME_DATA_DIR is unset", () => {
  it("explains how to configure it rather than failing obscurely", async () => {
    vi.stubEnv("SCMCP_GAME_DATA_DIR", "");
    vi.resetModules();
    const { listDatasets } = await import("./localdata.js");
    await expect(listDatasets()).rejects.toThrow(/SCMCP_GAME_DATA_DIR/);
    vi.stubEnv("SCMCP_GAME_DATA_DIR", dir);
  });
});

describe("collectLabels", () => {
  it("collects distinct labels across every dataset", async () => {
    const { collectLabels } = await mod();
    const result = await collectLabels();
    expect(result.datasets_scanned).toContain("game-mining");
    // "Raw_Quantainium" and "Raw_Gold" from mineableElements, "Quantainium" and "Gold"
    // (the keys, since oreSignatures' values are plain numbers) from oreSignatures.
    expect(result.labels).toEqual(
      expect.arrayContaining(["Raw_Quantainium", "Raw_Gold", "Quantainium", "Gold"]),
    );
  });

  it("drops all-digit and too-short labels, which are ids rather than words", async () => {
    const { collectLabels } = await mod();
    const result = await collectLabels();
    expect(result.labels.some((l) => /^\d+$/.test(l))).toBe(false);
    expect(result.labels.every((l) => l.length >= 3)).toBe(true);
  });

  it("scopes to one dataset when named", async () => {
    const { collectLabels } = await mod();
    const result = await collectLabels("game-build-version");
    expect(result.datasets_scanned).toEqual(["game-build-version"]);
    expect(result.labels).not.toContain("Raw_Gold");
  });

  it("stops at the limit rather than scanning everything", async () => {
    const { collectLabels } = await mod();
    const result = await collectLabels(undefined, { limit: 2 });
    expect(result.labels.length).toBeLessThanOrEqual(2);
  });
});
