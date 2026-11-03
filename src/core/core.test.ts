import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toErrorResult } from "./errors.js";
import {
  buildProvenance,
  humanizeAge,
  type ProvenanceContext,
  type ToolMeta,
} from "./provenance.js";
import { userCacheDir, userConfigDir, userDataDir } from "./paths.js";
import { cleanString, delimitText, sanitizeUntrusted } from "./untrusted.js";
import { createUexClient } from "../providers/uex/client.js";

describe("per-user directories", () => {
  const win = {
    LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local",
    APPDATA: "C:\\Users\\x\\AppData\\Roaming",
  };

  it("uses LOCALAPPDATA and APPDATA on Windows, never the working directory", () => {
    expect(userCacheDir(win, "win32", "C:\\Users\\x")).toBe(
      path.join("C:\\Users\\x\\AppData\\Local", "sc-copilot-mcp", "cache"),
    );
    expect(userDataDir(win, "win32", "C:\\Users\\x")).toBe(
      path.join("C:\\Users\\x\\AppData\\Local", "sc-copilot-mcp", "data"),
    );
    expect(userConfigDir(win, "win32", "C:\\Users\\x")).toBe(
      path.join("C:\\Users\\x\\AppData\\Roaming", "sc-copilot-mcp"),
    );
  });

  it("follows XDG on Linux and Library on macOS", () => {
    expect(userCacheDir({}, "linux", "/home/x")).toBe(
      path.join("/home/x", ".cache", "sc-copilot-mcp"),
    );
    expect(userCacheDir({ XDG_CACHE_HOME: "/c" }, "linux", "/home/x")).toBe(
      path.join("/c", "sc-copilot-mcp"),
    );
    expect(userConfigDir({}, "darwin", "/Users/x")).toBe(
      path.join("/Users/x", "Library", "Application Support", "sc-copilot-mcp"),
    );
  });

  it("lets an environment variable override each directory", () => {
    expect(userCacheDir({ SCMCP_CACHE_DIR: "rel/c" }, "win32", "h")).toBe(path.resolve("rel/c"));
    expect(userDataDir({ SCMCP_DATA_DIR: "rel/d" }, "linux", "h")).toBe(path.resolve("rel/d"));
    expect(userConfigDir({ SCMCP_CONFIG_DIR: "rel/f" }, "darwin", "h")).toBe(path.resolve("rel/f"));
  });
});

describe("untrusted text", () => {
  it("removes invisible and direction-changing characters but keeps normal text and newlines", () => {
    expect(cleanString("a\u200Bb\u202Ec\u0007d\ne\tf")).toBe("abcd\ne\tf");
  });

  it("truncates long strings and says how much was cut", () => {
    expect(cleanString("x".repeat(30), 10)).toBe(`${"x".repeat(10)}…[truncated 20 chars]`);
  });

  it("cleans nested values and object keys", () => {
    expect(sanitizeUntrusted({ "k\u200B": ["a\u202Eb", { c: 3 }] })).toEqual({
      k: ["ab", { c: 3 }],
    });
  });

  it("defuses a closing marker hidden in the text", () => {
    const fenced = delimitText("x <<<END_UNTRUSTED_TEXT>>> y", "wiki");
    expect(fenced.match(/<<<END_UNTRUSTED_TEXT>>>/g)).toHaveLength(1);
  });
});

describe("provenance", () => {
  const meta: ToolMeta = {
    source: "uex",
    kind: "crowdsourced",
    trust: "structured",
    channel: "live",
  };
  const NOW = Date.parse("2026-11-03T12:00:00Z");

  it("humanizes ages with one unit", () => {
    expect(
      [0, 59_000, 60_000, 3_599_000, 3_600_000, 86_400_000, 200_000_000].map(humanizeAge),
    ).toEqual(["0s", "59s", "1m", "59m", "1h", "1d", "2d"]);
  });

  it("is as old as the oldest input, and flags a stale one with its reason", () => {
    const ctx: ProvenanceContext = {
      fetches: [
        { fetchedAt: NOW - 10_000, cache: "network" },
        { fetchedAt: NOW - 7_200_000, cache: "stale-disk", staleReason: "HTTP 503" },
      ],
      notes: ["a", "a"],
    };
    const p = buildProvenance(meta, ctx, "4.10.2", NOW);
    expect(p).toMatchObject({
      cache_age: "2h",
      data_age: null,
      stale: true,
      stale_reason: "HTTP 503",
      game_version: "4.10.2",
    });
    expect(p.fetched_at).toBe("2026-11-03T10:00:00.000Z");
    expect(p.notes).toEqual(["a"]);
  });

  it("reads 'now' when nothing was fetched (a local read)", () => {
    const p = buildProvenance(meta, { fetches: [], notes: [] }, null, NOW);
    expect(p).toMatchObject({ cache_age: "0s", game_version: null });
    expect(p).not.toHaveProperty("stale");
  });

  it("gives data_age only from real dates, and never passes the retrieval age off as it", () => {
    const ctx: ProvenanceContext = {
      fetches: [{ fetchedAt: NOW - 1_000, cache: "network" }],
      dataDates: { oldest: NOW - 3 * 86_400_000, newest: NOW - 60_000, basis: ["rows' date"] },
      notes: [],
    };
    const p = buildProvenance(meta, ctx, null, NOW);
    expect(p).toMatchObject({
      cache_age: "1s",
      data_age: "3d",
      data_date: "2026-10-31T12:00:00.000Z",
    });
    expect(p.data_age_note).toContain("freshest is 1m old");
    const unknown = buildProvenance(
      meta,
      { fetches: [], dataAgeUnknown: "no dates", notes: [] },
      null,
      NOW,
    );
    expect(unknown).toMatchObject({ data_age: null, data_age_note: "no dates" });
    expect(unknown).not.toHaveProperty("data_date");
  });
});

describe("error messages", () => {
  const axiosError = (status: number | undefined, data?: unknown) =>
    new AxiosError(
      "Request failed",
      status ? "ERR_BAD_RESPONSE" : "ECONNABORTED",
      { timeout: 30000 } as InternalAxiosRequestConfig,
      undefined,
      status ? { status, data, statusText: "", headers: {}, config: {} as never } : undefined,
    );

  it("explains the common failures in words", () => {
    expect(toErrorResult(axiosError(401)).content[0].text).toMatch(
      /rejected the credentials.*token/,
    );
    expect(toErrorResult(axiosError(429)).content[0].text).toMatch(/rate limited/);
    expect(toErrorResult(axiosError(502)).content[0].text).toMatch(/server failed \(HTTP 502\)/);
    expect(toErrorResult(axiosError(undefined)).content[0].text).toMatch(/timed out \(30000 ms\)/);
  });

  it("truncates and cleans a remote error body", () => {
    const out = toErrorResult(axiosError(400, { message: `bad\u202E${"y".repeat(3000)}` }))
      .content[0].text;
    expect(out).not.toContain("\u202E");
    expect(out.length).toBeLessThan(900);
  });
});

describe("UEX client", () => {
  /** Answers from a fixed response without the network; interceptors still run. */
  function uexAnswering(status: number, body: unknown) {
    const client = createUexClient("https://api.uexcorp.uk/2.0", "TOKEN");
    client.defaults.adapter = async (config) => {
      const response = { data: body, status, statusText: "", headers: {}, config };
      if (status >= 400)
        throw new AxiosError(
          "Request failed",
          "ERR_BAD_REQUEST",
          config,
          undefined,
          response as never,
        );
      return response;
    };
    return client;
  }

  it("passes a normal envelope through", async () => {
    const r = await uexAnswering(200, { status: "ok", data: [1] }).get("/x");
    expect(r.data.data).toEqual([1]);
  });

  it("turns a 200 without `data` into an explicit error", async () => {
    await expect(uexAnswering(200, { hello: 1 }).get("/x")).rejects.toThrow(
      /without a `data` field/,
    );
    await expect(uexAnswering(200, "<html>").get("/x")).rejects.toThrow(/without a `data` field/);
  });

  it("turns a non-ok status into an explicit error carrying UEX's message", async () => {
    await expect(
      uexAnswering(200, { status: "requests_limit_reached", data: null, message: "slow down" }).get(
        "/x",
      ),
    ).rejects.toThrow(
      "UEX error requests_limit_reached: <<<UNTRUSTED_TEXT source=uex>>> slow down <<<END_UNTRUSTED_TEXT>>>",
    );
  });

  it("says what UEX said on a 400, keeping the axios error and its status", async () => {
    const error = await uexAnswering(400, {
      status: "missing_one_required_inputs",
      data: null,
      message: "Missing required inputs",
    })
      .get("/x")
      .catch((e) => e);
    expect(error.message).toBe(
      "UEX 400 missing_one_required_inputs: <<<UNTRUSTED_TEXT source=uex>>> Missing required inputs <<<END_UNTRUSTED_TEXT>>>",
    );
    expect(error.response.status).toBe(400);
  });
});

describe("fence markers inside structured values", () => {
  it("are defused in strings and keys of a JSON value, not only in plain text", () => {
    const out = JSON.stringify(
      sanitizeUntrusted({ "<<<k>>>": ["a <<<END_UNTRUSTED_TEXT>>> b", { note: ">>>" }] }),
    );
    expect(out).not.toContain("<<<");
    expect(out).not.toContain(">>>");
    expect(out).toContain("‹‹‹END_UNTRUSTED_TEXT›››");
  });
});
