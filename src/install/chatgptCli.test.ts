import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  layout,
  parseArgs,
  removeTree,
  runChatgpt,
  type CliDeps,
  type ParsedArgs,
} from "./chatgptCli.js";
import { selectAsset, type TunnelAsset } from "./chatgptTunnel.js";
import { FAKE_BINARY, fakeTunnelArchive } from "./testing/zipFixture.js";
import { sha256 } from "./tunnelDownload.js";

const ID = "tunnel_0123456789abcdef0123456789abcdef";
const OTHER_ID = "tunnel_ffffffffffffffffffffffffffffffff";
const SECRET = "sk-proj-TESTSECRET0123456789abcdefXYZ";

let tmp: string;
let repo: string;
let home: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scmcp-chatgpt-"));
  // A user name with a space and a non-ASCII letter, like many real Windows profiles.
  repo = path.join(tmp, "Jos\u00e9 M\u00fcller", "sc-copilot-mcp");
  home = path.join(tmp, "Jos\u00e9 M\u00fcller", "AppData", "Local", "sc-copilot-mcp", "chatgpt");
  fs.mkdirSync(path.join(repo, "dist"), { recursive: true });
  fs.writeFileSync(path.join(repo, "dist", "index.js"), "// built server stand-in\n");
});

afterEach(() => {
  // fs.rmSync silently skips non-ASCII paths on Node 24.8 for Windows (see removeTree).
  removeTree(tmp);
});

interface Harness {
  deps: CliDeps;
  lines: string[];
  downloads: number;
  execs: { file: string; args: string[]; env: Record<string, string> }[];
  alive: Set<number>;
  port: "open" | "closed";
}

function harness(overrides: Partial<CliDeps> = {}): Harness {
  const archive = fakeTunnelArchive("win32");
  const asset: TunnelAsset = {
    ...(selectAsset("win32", "x64") as TunnelAsset),
    size: archive.length,
    sha256: sha256(archive),
    binarySha256: sha256(Buffer.from(FAKE_BINARY)),
  };
  const h: Harness = {
    deps: null as never,
    lines: [],
    downloads: 0,
    execs: [],
    alive: new Set(),
    port: "closed",
  };
  h.deps = {
    platform: "win32",
    arch: "x64",
    home,
    repoRoot: repo,
    nodePath: process.execPath,
    env: {
      PATH: "x",
      CONTROL_PLANE_API_KEY: "sk-env-should-not-pass-000000",
      SC_INSTALL_DIR: "D:\\SC",
    },
    pid: 4242,
    asset,
    download: async () => {
      h.downloads += 1;
      return archive;
    },
    readSecret: async () => SECRET,
    probe: async () => h.port,
    isAlive: (pid) => h.alive.has(pid),
    exec: async (file, args, env) => {
      h.execs.push({ file, args, env });
      return 0;
    },
    now: () => new Date("2026-11-06T12:00:00Z"),
    out: (line) => h.lines.push(line),
    ...overrides,
  };
  return h;
}

function args(argv: string[]): ParsedArgs {
  const a = parseArgs(argv);
  if ("error" in a) throw new Error(a.error);
  return a;
}

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}

describe("Feature: the command line of npm run chatgpt", () => {
  it("Given the documented commands, When parsed, Then they give the expected options", () => {
    expect(args(["setup", "--tunnel-id", ID, "--port", "8090", "--dry-run"])).toMatchObject({
      command: "setup",
      tunnelId: ID,
      port: 8090,
      dryRun: true,
    });
    expect(
      args(["run", "--telemetry", "on", "--balance", "hidden", "--profiles", "Core,Trade"]),
    ).toMatchObject({
      command: "start",
      telemetry: "on",
      balance: "hidden",
      profiles: "core,trade",
    });
    expect(args(["key", "--remove"])).toMatchObject({ command: "key", remove: true });
    expect(args([])).toMatchObject({ command: "help" });
  });

  it.each([
    [["deploy"], /Unknown command/],
    [["setup", "--tunnel-id"], /needs a value/],
    [["setup", "--tunnel-id", "abc"], /tunnel_/],
    [["start", "--balance", "maybe"], /shown or hidden/],
    [["start", "--telemetry", "yes"], /on or off/],
    [["key", "--dry-run"], /takes no option/],
    [["status", "--port", "8080"], /takes no option/],
    [["start", "--profiles", "core;calc"], /commas/],
    [["start", "--remove"], /start takes no option --remove/],
  ])("Given %j, When parsed, Then it is refused", (argv, message) => {
    const a = parseArgs(argv as string[]);
    expect("error" in a && a.error).toMatch(message);
  });

  it.each([
    [["key", SECRET]],
    [[SECRET]],
    [["start", SECRET]],
    [["setup", SECRET]],
    [["setup", "--tunnel-id", SECRET]],
    [["start", "--profiles", SECRET]],
    [["start", "--balance", SECRET]],
    [["setup", "--port", SECRET]],
    [["status", `--${SECRET}`]],
  ])(
    "Given a key typed on the command line (%j), When parsed, Then it is refused without being repeated",
    (argv) => {
      const a = parseArgs(argv);
      expect(a).toHaveProperty("error");
      expect(JSON.stringify(a)).not.toContain("TESTSECRET");
      // npm has already printed the command line by then: the player is told to revoke the key.
      expect("error" in a && a.error).toMatch(/Revoke that key/);
    },
  );

  it.each([
    [["key", "hunter2-not-a-key-but-private"]],
    [["hunter2-not-a-key-but-private"]],
    [["start", "--hunter2-not-a-key-but-private"]],
  ])(
    "Given another unknown argument (%j), When parsed, Then it is refused without being repeated",
    (argv) => {
      const a = parseArgs(argv);
      expect(a).toHaveProperty("error");
      expect(JSON.stringify(a)).not.toContain("hunter2");
    },
  );
});

describe("Feature: setup installs the pinned tunnel-client and writes the profile", () => {
  it("Given --dry-run, When setup runs, Then nothing is downloaded or written and the plan is shown", async () => {
    const h = harness();
    expect(await runChatgpt(args(["setup", "--tunnel-id", ID, "--dry-run"]), h.deps)).toBe(0);
    expect(h.downloads).toBe(0);
    expect(fs.existsSync(home)).toBe(false);
    const text = h.lines.join("\n");
    expect(text).toContain("Would download");
    expect(text).toContain(h.deps.asset!.sha256);
    expect(text).toContain("Dry run: nothing was downloaded or written");
    expect(text).toContain(`tunnel_id: "${ID}"`);
  });

  it("Given a tunnel ID, When setup runs, Then the archive is checked, extracted and the profile written", async () => {
    const h = harness();
    expect(await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps)).toBe(0);
    const lay = layout(home, "win32");
    expect(fs.readFileSync(lay.binary, "utf8")).toBe("fake tunnel-client binary for tests");
    expect(fs.existsSync(path.join(lay.binDir, "LICENSE"))).toBe(true);
    const yaml = fs.readFileSync(lay.profile, "utf8");
    expect(yaml).toContain(`tunnel_id: "${ID}"`);
    expect(yaml).toContain(`${repo.replace(/\\/g, "/")}/dist/index.js`);
    expect(yaml).toContain(`file:${lay.keyFile.replace(/\\/g, "/")}`);
    const state = JSON.parse(fs.readFileSync(lay.state, "utf8"));
    expect(state).toMatchObject({ tunnelId: ID, port: 8080, tunnelClientVersion: "0.0.19" });
    expect(h.lines.join("\n")).toContain("npm run chatgpt -- key");
    expect(h.lines.join("\n")).toContain("Authentication:  No authentication");
  });

  it("Given setup already done, When it runs again with another ID, Then it does not download again and replaces the profile", async () => {
    const h = harness();
    await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps);
    await runChatgpt(args(["setup", "--tunnel-id", OTHER_ID, "--port", "8090"]), h.deps);
    expect(h.downloads).toBe(1);
    const yaml = fs.readFileSync(layout(home, "win32").profile, "utf8");
    expect(yaml).toContain(OTHER_ID);
    expect(yaml).toContain("127.0.0.1:8090");
    expect(h.lines.join("\n")).toContain(`it replaces ${ID}`);
  });

  it("Given an archive that passes its check but holds another executable, When setup runs, Then nothing is installed", async () => {
    const h = harness();
    h.deps.asset = { ...h.deps.asset!, binarySha256: "0".repeat(64) };
    expect(await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps)).toBe(1);
    expect(filesUnder(home)).toEqual([]);
    expect(h.lines.join("\n")).toContain("is not the pinned one");
  });

  it("Given Windows holding the folder for a moment (EBUSY), When setup installs, Then it retries and succeeds", async () => {
    let failures = 2;
    const waits: number[] = [];
    const h = harness({
      rename: (from, to) => {
        if (failures-- > 0) throw Object.assign(new Error("busy"), { code: "EBUSY" });
        fs.renameSync(from, to);
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps)).toBe(0);
    expect(waits).toHaveLength(2);
    expect(fs.readFileSync(layout(home, "win32").binary, "utf8")).toBe(FAKE_BINARY);
  });

  it("Given a reinstall whose swap fails, When setup runs, Then the previous copy is put back", async () => {
    const h = harness();
    await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps);
    const lay = layout(home, "win32");
    fs.writeFileSync(lay.binary, "previous copy"); // not the pinned one: setup reinstalls
    h.deps.sleep = async () => undefined;
    h.deps.rename = (from, to) => {
      if (from.includes(".partial-")) throw Object.assign(new Error("denied"), { code: "EPERM" });
      fs.renameSync(from, to);
    };
    expect(await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps)).toBe(1);
    expect(fs.readFileSync(lay.binary, "utf8")).toBe("previous copy");
    expect(fs.readdirSync(path.dirname(lay.binDir))).toEqual(["v0.0.19"]);
  });

  it("Given an archive whose SHA-256 is not the pinned one, When setup runs, Then nothing is extracted or written", async () => {
    const h = harness();
    h.deps.download = async () =>
      Buffer.concat([fakeTunnelArchive("win32"), Buffer.from("x")]).subarray(1);
    expect(await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps)).toBe(1);
    expect(filesUnder(home)).toEqual([]);
    expect(h.lines.join("\n")).toMatch(/SHA-256[\s\S]*Nothing was installed/);
  });

  it("Given a download that fails, When setup runs, Then it says so and writes nothing", async () => {
    const h = harness({
      download: async () => {
        throw new Error("Download failed: offline");
      },
    });
    expect(await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps)).toBe(1);
    expect(filesUnder(home)).toEqual([]);
  });

  it("Given no dist/index.js, When setup runs, Then it asks for a build and warns about Claude Desktop", async () => {
    removeTree(path.join(repo, "dist"));
    const h = harness();
    expect(await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps)).toBe(1);
    expect(h.lines.join("\n")).toMatch(/npm run build[\s\S]*Claude Desktop/);
    expect(h.downloads).toBe(0);
  });

  it("Given a machine OpenAI publishes nothing for, When setup runs, Then it says so", async () => {
    const h = harness({ asset: null });
    expect(await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps)).toBe(1);
    expect(h.lines.join("\n")).toContain("publishes no tunnel-client");
  });

  it("Given no tunnel ID and no earlier setup, When setup runs, Then it says where to get one", async () => {
    const h = harness();
    expect(await runChatgpt(args(["setup"]), h.deps)).toBe(2);
    expect(h.lines.join("\n")).toContain("platform.openai.com/settings/organization/tunnels");
  });
});

describe("Feature: the runtime key is stored in its own file and never shown", () => {
  it("Given a pasted key, When saved, Then only the key file holds it, and no output, profile or argument ever does", async () => {
    const h = harness();
    await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps);
    expect(await runChatgpt(args(["key"]), h.deps)).toBe(0);
    await runChatgpt(args(["start", "--dry-run"]), h.deps);
    await runChatgpt(args(["start", "--balance", "hidden"]), h.deps);
    await runChatgpt(args(["doctor"]), h.deps);
    h.port = "open";
    await runChatgpt(args(["status"]), h.deps);
    // A key pasted in the wrong place on the command line: refused, never echoed (what the script prints).
    for (const argv of [
      ["key", SECRET],
      [SECRET],
      ["start", SECRET],
      ["setup", "--tunnel-id", SECRET],
    ]) {
      const parsed = parseArgs(argv);
      if ("error" in parsed) h.lines.push(parsed.error);
      else await runChatgpt(parsed, h.deps);
    }

    const lay = layout(home, "win32");
    expect(fs.readFileSync(lay.keyFile, "utf8")).toBe(SECRET);
    for (const file of filesUnder(home).filter((f) => f !== lay.keyFile)) {
      expect(fs.readFileSync(file, "latin1"), file).not.toContain("TESTSECRET");
    }
    expect(h.lines.join("\n")).not.toContain("TESTSECRET");
    expect(h.execs.length).toBeGreaterThanOrEqual(3);
    for (const e of h.execs) {
      expect(JSON.stringify(e)).not.toContain("TESTSECRET");
      expect(e.env.CONTROL_PLANE_API_KEY).toBeUndefined();
    }
  });

  it("Given an admin key, When pasted, Then it is refused and nothing is written", async () => {
    const h = harness({ readSecret: async () => "sk-admin-0123456789abcdefghijklmnop" });
    expect(await runChatgpt(args(["key"]), h.deps)).toBe(1);
    expect(fs.existsSync(layout(home, "win32").keyFile)).toBe(false);
    expect(h.lines.join("\n")).not.toContain("0123456789abcdefghij");
  });

  it("Given a saved key, When key --remove runs, Then the file is gone and the player is told to revoke it", async () => {
    const h = harness();
    await runChatgpt(args(["key"]), h.deps);
    const leftover = `${layout(home, "win32").keyFile}.999.tmp`;
    fs.writeFileSync(leftover, SECRET);
    expect(await runChatgpt(args(["key", "--remove"]), h.deps)).toBe(0);
    expect(fs.existsSync(layout(home, "win32").keyFile)).toBe(false);
    expect(fs.existsSync(leftover)).toBe(false);
    expect(h.lines.join("\n")).toContain("revoke");
  });
});

describe("Feature: start runs one tunnel-client with the profile and the player's settings", () => {
  async function ready(h: Harness) {
    await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps);
    await runChatgpt(args(["key"]), h.deps);
    h.lines.length = 0;
  }

  it("Given everything in place, When start runs, Then tunnel-client run gets the profile and the mapped settings", async () => {
    const h = harness();
    await ready(h);
    const lay = layout(home, "win32");
    let lockDuringRun = false;
    h.deps.exec = async (file, a, env) => {
      lockDuringRun = fs.existsSync(lay.lock);
      h.execs.push({ file, args: a, env });
      return 0;
    };
    expect(
      await runChatgpt(args(["start", "--telemetry", "on", "--balance", "hidden"]), h.deps),
    ).toBe(0);
    const run = h.execs[0];
    expect(run.file).toBe(lay.binary);
    expect(run.args).toEqual(["run", "--config", lay.profile]);
    await runChatgpt(args(["start", "--verbose", "--balance", "hidden"]), h.deps);
    expect(h.execs[1].args).toEqual(["run", "--config", lay.profile, "--log.level", "info"]);
    expect(run.env).toMatchObject({
      SC_TELEMETRY: "on",
      SC_BALANCE: "hidden",
      SCMCP_PROFILES: "core,trade,data,local",
      SC_INSTALL_DIR: "D:\\SC",
      PATH: "x",
    });
    expect(lockDuringRun).toBe(true);
    expect(fs.existsSync(lay.lock)).toBe(false);
    const text = h.lines.join("\n");
    expect(text).toContain("Runtime key: present.");
    expect(text).toContain("Not passed on");
    expect(text).toContain("CONTROL_PLANE_API_KEY");
    expect(text).not.toContain("shown by default");
  });

  it("Given the balance left shown, When start runs, Then the player is told it reaches ChatGPT and how to hide it", async () => {
    const h = harness();
    await ready(h);
    await runChatgpt(args(["start", "--dry-run"]), h.deps);
    expect(h.lines.join("\n")).toMatch(/shown by default[\s\S]*--balance hidden/);
    expect(h.execs).toHaveLength(0);
  });

  it("Given another start of this command still running, When start runs, Then it refuses (one client per tunnel)", async () => {
    const h = harness();
    await ready(h);
    const lay = layout(home, "win32");
    fs.writeFileSync(lay.lock, JSON.stringify({ pid: 777, tunnelId: ID, startedAt: "x" }));
    h.alive.add(777);
    expect(await runChatgpt(args(["start"]), h.deps)).toBe(1);
    expect(h.lines.join("\n")).toContain("already running (process 777)");
    expect(h.execs).toHaveLength(0);
  });

  it("Given two starts a few milliseconds apart and a slow port probe, When both run, Then only one runs tunnel-client", async () => {
    const h = harness();
    await ready(h);
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 40));
      return "closed" as const;
    };
    const execs: number[] = [];
    const make = (pid: number) =>
      harness({
        pid,
        probe: slow,
        isAlive: (p) => p === 101 || p === 102,
        exec: async () => {
          execs.push(pid);
          await new Promise((r) => setTimeout(r, 100));
          return 0;
        },
      });
    const a = make(101);
    const b = make(102);
    const results = await Promise.all([
      runChatgpt(args(["start", "--balance", "hidden"]), a.deps),
      new Promise((r) => setTimeout(r, 5)).then(() =>
        runChatgpt(args(["start", "--balance", "hidden"]), b.deps),
      ),
    ]);
    expect(execs).toHaveLength(1);
    expect([...results].sort()).toEqual([0, 1]);
    expect([...a.lines, ...b.lines].join("\n")).toMatch(/already running \(process 10[12]\)/);
    expect(fs.existsSync(layout(home, "win32").lock)).toBe(false);
  });

  it("Given an unreadable lock left behind, When start runs, Then it is taken over", async () => {
    const h = harness();
    await ready(h);
    fs.writeFileSync(layout(home, "win32").lock, "not json");
    expect(await runChatgpt(args(["start"]), h.deps)).toBe(0);
    expect(h.execs).toHaveLength(1);
  });

  it("Given a stale lock from a closed window, When start runs, Then it takes over", async () => {
    const h = harness();
    await ready(h);
    fs.writeFileSync(
      layout(home, "win32").lock,
      JSON.stringify({ pid: 777, tunnelId: ID, startedAt: "x" }),
    );
    expect(await runChatgpt(args(["start"]), h.deps)).toBe(0);
    expect(h.execs).toHaveLength(1);
  });

  it("Given the status port already in use, When start runs, Then it refuses and names the fix", async () => {
    const h = harness();
    await ready(h);
    h.port = "open";
    expect(await runChatgpt(args(["start"]), h.deps)).toBe(1);
    expect(h.lines.join("\n")).toContain("setup --port 8090");
    expect(h.execs).toHaveLength(0);
  });

  it("Given no key yet, When start runs, Then it says only that the key is absent", async () => {
    const h = harness();
    await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps);
    expect(await runChatgpt(args(["start"]), h.deps)).toBe(1);
    expect(h.lines.join("\n")).toContain("No runtime key yet: npm run chatgpt -- key");
  });

  it("Given the installed tunnel-client changed on disk, When start runs, Then it refuses to run it", async () => {
    const h = harness();
    await ready(h);
    fs.writeFileSync(layout(home, "win32").binary, "something else");
    expect(await runChatgpt(args(["start"]), h.deps)).toBe(1);
    expect(h.lines.join("\n")).toContain("changed on disk");
    expect(h.execs).toHaveLength(0);
  });

  it("Given nothing set up, When start, doctor or status run, Then each says to run setup", async () => {
    for (const c of ["start", "doctor", "status"]) {
      const h = harness();
      expect(await runChatgpt(args([c]), h.deps)).toBe(1);
      expect(h.lines.join("\n")).toContain("npm run chatgpt -- setup --tunnel-id");
    }
  });
});

describe("Feature: doctor and status wrap tunnel-client's own checks", () => {
  it("Given everything in place, When doctor runs, Then tunnel-client doctor --explain gets the profile", async () => {
    const h = harness();
    await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps);
    await runChatgpt(args(["key"]), h.deps);
    expect(await runChatgpt(args(["doctor"]), h.deps)).toBe(0);
    const lay = layout(home, "win32");
    expect(h.execs.at(-1)?.args).toEqual(["doctor", "--config", lay.profile, "--explain"]);
  });

  it("Given the tunnel not running, When status runs, Then it says so without calling tunnel-client", async () => {
    const h = harness();
    await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps);
    expect(await runChatgpt(args(["status"]), h.deps)).toBe(0);
    expect(h.lines.join("\n")).toContain("the tunnel is not running");
    expect(h.lines.join("\n")).toContain("Runtime key:   absent");
    expect(h.execs).toHaveLength(0);
  });

  it("Given the tunnel running, When status runs, Then tunnel-client health is asked on the loopback port", async () => {
    const h = harness();
    await runChatgpt(args(["setup", "--tunnel-id", ID]), h.deps);
    h.port = "open";
    await runChatgpt(args(["status"]), h.deps);
    expect(h.execs.at(-1)?.args).toEqual([
      "health",
      "--port",
      "8080",
      "--require-control-plane-poll",
    ]);
  });
});

describe("Feature: removals work in a user folder with a non-ASCII name", () => {
  it("Given a folder and a file under a name with an accent, When removed, Then they are gone (fs.rmSync skips them on Node 24.8)", () => {
    const dir = path.join(tmp, "José Müller", "partial");
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sub", "a.txt"), "x");
    const file = path.join(tmp, "José Müller", "lone.txt");
    fs.writeFileSync(file, "x");
    removeTree(dir);
    removeTree(file);
    removeTree(path.join(tmp, "absent"));
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });
});
