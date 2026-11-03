import path from "node:path";
import { describe, expect, it } from "vitest";
import { cachePathFor, fetchDataset, isSafeCollectionName, type Build } from "./versions.js";

/** Feature: a collection name chosen by the model can never leave the cache folder. */

const SHA = "f".repeat(40);
const BUILD: Build = { version: "4.10.0-LIVE.1", sha: SHA, date: "2026-09-01" };

describe("isSafeCollectionName", () => {
  it("accepts the plain names the dumps use", () => {
    for (const name of ["weapons", "quantumDrives", "mineableElements", "by_class-name", "v1.2"]) {
      expect(isSafeCollectionName(name), name).toBe(true);
    }
  });

  it("refuses separators, parent references, drive letters and empty names", () => {
    for (const name of [
      "",
      "..",
      "a..b",
      "../x",
      "..\\x",
      "ships__../../../x",
      "a/b",
      "a\\b",
      "C:x",
      "x:stream",
      "a b",
      "a\u0000b",
    ]) {
      expect(isSafeCollectionName(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("cachePathFor", () => {
  it("stays in one folder for a normal name", () => {
    const file = cachePathFor("ships", "vehicles", SHA);
    expect(path.basename(file)).toBe(`ships__vehicles__${SHA.slice(0, 10)}.json`);
  });

  it("throws for a name that would climb out, whatever the way it is spelled", () => {
    for (const name of ["../../../x", "..\\..\\x", "ships__../../../x", "/etc/passwd"]) {
      expect(() => cachePathFor("ships", name, SHA), name).toThrow(/Invalid collection name/);
    }
  });
});

describe("fetchDataset", () => {
  it("refuses a hostile collection before it reads or downloads anything", async () => {
    await expect(fetchDataset("ships", BUILD, "ships__../../../x")).rejects.toThrow(
      /Invalid collection name/,
    );
    await expect(fetchDataset("ships", BUILD, "..")).rejects.toThrow(/Invalid collection name/);
  });
});
