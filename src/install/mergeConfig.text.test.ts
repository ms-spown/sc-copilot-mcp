import { describe, expect, it } from "vitest";
import { describePlan, planMerge, type ServerEntry } from "./mergeConfig.js";

/**
 * Feature: the installer changes ONE entry of the Claude Desktop config and leaves every other byte
 * alone. Samples are invented; the BOM is written as an escape, never typed.
 */

const BOM = String.fromCharCode(0xfeff);
const entry: ServerEntry = {
  command: "node",
  args: ["C:/x/dist/index.js"],
  env: { SCMCP_PROFILES: "core" },
};
const NAME = "sc-copilot";

/** Other servers hold a huge integer and a "1.0": JSON.stringify would rewrite both. */
const others = (eol: string, unit: string) =>
  [
    "{",
    `${unit}"limit": 12345678901234567890,`,
    `${unit}"ratio": 1.0,`,
    `${unit}"mcpServers": {`,
    `${unit}${unit}"other": { "command": "npx", "id": 9007199254740993 }`,
    `${unit}}`,
    "}",
    "",
  ].join(eol);

describe("planMerge text, adding the entry", () => {
  for (const [label, eol, unit] of [
    ["LF and two spaces", "\n", "  "],
    ["CRLF and four spaces", "\r\n", "    "],
    ["CRLF and tabs", "\r\n", "\t"],
  ] as const) {
    it(`keeps big numbers, 1.0 and line endings (${label})`, () => {
      const raw = others(eol, unit);
      const plan = planMerge(raw, NAME, entry);
      expect(plan.action).toBe("add");
      const text = plan.text as string;

      expect(text).toContain("12345678901234567890");
      expect(text).toContain('"ratio": 1.0,');
      expect(text).toContain("9007199254740993");
      // Every line ending is the file's own.
      expect(eol === "\r\n" ? /(?<!\r)\n/.test(text) : /\r/.test(text)).toBe(false);
      // The new member sits one indent step inside mcpServers, like its sibling.
      expect(text).toContain(
        `${eol}${unit}${unit}"${NAME}": {${eol}${unit}${unit}${unit}"command"`,
      );
      // Only an insertion: the original text is still all there, in order.
      const kept = raw.slice(0, raw.indexOf("9007199254740993") + "9007199254740993 }".length);
      expect(text.startsWith(kept)).toBe(true);
      expect(JSON.parse(text).mcpServers[NAME]).toEqual(entry);
      // Idempotent.
      expect(planMerge(text, NAME, entry).action).toBe("unchanged");
      expect(planMerge(text, NAME, entry).text).toBeNull();
    });
  }

  it("keeps the BOM exactly once", () => {
    const plan = planMerge(BOM + others("\r\n", "  "), NAME, entry);
    const text = plan.text as string;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.charCodeAt(1)).toBe("{".charCodeAt(0));
    expect(text.indexOf(BOM, 1)).toBe(-1);
    expect(JSON.parse(text.slice(1)).mcpServers[NAME]).toEqual(entry);
  });

  it("does not add a BOM to a file that had none", () => {
    expect((planMerge(others("\n", "  "), NAME, entry).text as string).startsWith(BOM)).toBe(false);
  });

  it("adds mcpServers when the file has none, and when it is an empty object", () => {
    const noServers = '{\r\n  "theme": "dark"\r\n}\r\n';
    const a = planMerge(noServers, NAME, entry).text as string;
    expect(a.startsWith('{\r\n  "theme": "dark",')).toBe(true);
    expect(JSON.parse(a)).toEqual({ theme: "dark", mcpServers: { [NAME]: entry } });

    const b = planMerge('{ "mcpServers": {} }', NAME, entry).text as string;
    expect(JSON.parse(b)).toEqual({ mcpServers: { [NAME]: entry } });
    expect(JSON.parse(planMerge("{}", NAME, entry).text as string)).toEqual({
      mcpServers: { [NAME]: entry },
    });
  });

  it("writes a whole new file when there is none, ending with a newline", () => {
    for (const raw of [null, "", "  \n"]) {
      const text = planMerge(raw, NAME, entry).text as string;
      expect(JSON.parse(text)).toEqual({ mcpServers: { [NAME]: entry } });
      expect(text.endsWith("}\n")).toBe(true);
    }
  });
});

describe("planMerge text, updating the entry", () => {
  it("replaces only that entry, in place, and keeps the rest byte for byte", () => {
    const eol = "\r\n";
    const old = `${BOM}{${eol}  "limit": 12345678901234567890,${eol}  "mcpServers": {${eol}    "${NAME}": { "command": "old", "args": [], "env": {} },${eol}    "other": { "command": "npx", "n": 1.50 }${eol}  }${eol}}${eol}`;
    const plan = planMerge(old, NAME, entry);
    expect(plan.action).toBe("update");
    const text = plan.text as string;

    expect(text.startsWith(BOM + `{${eol}  "limit": 12345678901234567890,`)).toBe(true);
    expect(text.endsWith(`"other": { "command": "npx", "n": 1.50 }${eol}  }${eol}}${eol}`)).toBe(
      true,
    );
    expect(/(?<!\r)\n/.test(text)).toBe(false);
    expect(JSON.parse(text.slice(1)).mcpServers[NAME]).toEqual(entry);
  });

  it("carries SC_TELEMETRY over and writes it in", () => {
    const old = `{"mcpServers":{"${NAME}":{"command":"old","env":{"SC_TELEMETRY":"on"}}}}`;
    const text = planMerge(old, NAME, entry).text as string;
    expect(JSON.parse(text).mcpServers[NAME].env).toEqual({
      SCMCP_PROFILES: "core",
      SC_TELEMETRY: "on",
    });
  });
});

describe("describePlan hides what the user's own file holds", () => {
  // A throwaway invented value standing in for a token typed into the file by hand.
  const FAKE = "FAKE-TOKEN-VALUE-0123456789";
  const raw = JSON.stringify({
    mcpServers: {
      [NAME]: {
        command: "node",
        args: ["old.js", "--api-token", FAKE, `--secret=${FAKE}`, "keep.js"],
        env: { UEXTOKEN: FAKE, SCMCP_PROFILES: "all", OTHER: `x${FAKE}` },
        headers: { Authorization: `Bearer ${FAKE}` },
      },
      other: { command: "npx", env: { API_KEY: FAKE } },
    },
  });

  it("Given a token already in the entry, When I preview an update, Then it is not printed", () => {
    const plan = planMerge(raw, NAME, entry);
    expect(plan.action).toBe("update");
    const shown = describePlan(plan, NAME);
    expect(shown).not.toContain(FAKE);
    expect(shown).toContain("UEXTOKEN"); // the key name is shown, never the value
    expect(shown).toContain("(value hidden)");
    expect(shown).toContain("keep.js");
    expect(shown).not.toContain("Bearer");
  });

  it("Given the same file, Then neither the plan's text nor an error carries it either", () => {
    const plan = planMerge(raw, NAME, entry);
    // The installer replaces the command, the arguments and any other key of the old entry (the flag, the header);
    // the env keys are the user's and stay (the value is written back, never printed: see the preview test above).
    expect(plan.text).not.toContain("--api-token");
    expect(plan.text).not.toContain("Bearer");
    expect(JSON.parse(plan.text as string).mcpServers[NAME].env.UEXTOKEN).toBe(FAKE);
    let message = "";
    try {
      planMerge(raw, NAME, { ...entry, env: { UEXTOKEN: "x" } });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/keep secrets in .env/);
    expect(message).not.toContain(FAKE);
  });
});
