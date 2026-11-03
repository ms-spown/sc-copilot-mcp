import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyConnectionLine,
  ConnectionTracker,
  connectionFromText,
  UNKNOWN_CONNECTION,
} from "./connection.js";
import { GameLog } from "./reader.js";

/**
 * Where the player stands towards the servers, told as the log tells it. The lines are invented, in the shapes
 * seen in real logs (addresses, ids and the handle are made up and must never come back out).
 */
const HANDLE = "FakePilotQrs";
const at = (s: string) => `<2026-11-03T22:${s}Z>`;

const LOGIN = [`${at("00:00.000")} [Notice] <LoginCompleted> Login complete [Team_X]`];
const MENU_QUIT = `${at("00:05.000")} [Notice] <[EALobby] EALobbyQuit> [EALobby][CEALobby::RequestQuitLobby] ${HANDLE} Requesting QuitLobby [Team_CGP5]`;
const FRONTEND_TEARDOWN = `${at("01:00.291")} [Notice] <Channel Disconnected> cause=30010 reason="Nub destroyed" frame=980 isRemote=0 viewState=eCVS_InGame map="megamap" gamerules="SC_Frontend" hostType="Replicant" remoteAddr=127.0.0.1:12300 localAddr=127.0.0.1:16`;
const JOIN = [
  `${at("01:00.271")} [Notice] <Join PU> address[203.0.113.9] port[64315] shard[pub_test_1] locationId[1] [Team_GameServices]`,
  FRONTEND_TEARDOWN,
  `${at("01:00.291")} [Notice] <Session Manager [Request Connect]> Connecting 203.0.113.9:64315! [Team_Network]`,
  `${at("01:00.354")} [Notice] <CDisciplineServiceExternal::BeginSession> Beginning session [Team_GameSec][AntiCheat][EAC]`,
];
const KICK = [
  `${at("40:52.743")} [Notice] <Channel Disconnected> cause=30028 reason="Remote Disconnect - player inactive" frame=403825 isRemote=1 viewState=eCVS_InGame map="megamap" gamerules="SC_Default" hostType="Replicant" remoteAddr=203.0.113.9:64385`,
  `${at("40:52.743")} [Notice] <Channel Process Disconnection> cause=30028 reason="Remote Disconnect - player inactive" frame=403825 isRemote=1 map="megamap" gamerules="SC_Default"`,
  `${at("40:52.756")} [Notice] <Error Popup Opened> errorCode=30028 [Team_UI][Disconnection]`,
  `${at("40:52.772")} [Notice] <CDisciplineServiceExternal::EndSession> Ending session [Team_GameSec][AntiCheat][EAC]`,
  `${at("40:52.780")} [Notice] <Expect Incoming Connection> session=abc nickname="${HANDLE}" playerGEID=1 [Team_Network]`,
];

const run = (...parts: (string | string[])[]) => connectionFromText(parts.flat().join("\n"));

describe("connection state from the log", () => {
  it("knows nothing before any marker, and says so", () => {
    expect(run(`${at("00:00.000")} [Notice] <Something> unrelated`)).toEqual(UNKNOWN_CONNECTION);
  });

  it("is in the menu after login, and joining a server makes it online", () => {
    expect(run(LOGIN).state).toBe("menu");
    const online = run(LOGIN, MENU_QUIT, JOIN);
    expect(online.state).toBe("online");
    expect(online.since).toBe("2026-11-03T22:01:00.271Z");
  });

  it("does not take the menu's own link teardown (SC_Frontend) for a disconnection", () => {
    expect(run(LOGIN, FRONTEND_TEARDOWN).state).toBe("menu");
    expect(run(LOGIN, JOIN).state).toBe("online");
  });

  it("marks the kick for inactivity with its code and reason, at the time of the first line", () => {
    const state = run(LOGIN, JOIN, KICK);
    expect(state).toEqual({
      state: "disconnected",
      since: "2026-11-03T22:40:52.743Z",
      code: 30028,
      reason: "Remote Disconnect - player inactive",
    });
  });

  it("goes back to the menu after the popup is closed, and online again on the next join", () => {
    const back = run(LOGIN, JOIN, KICK, MENU_QUIT.replace("00:05", "43:00"));
    expect(back.state).toBe("menu");
    expect(run(LOGIN, JOIN, KICK, MENU_QUIT, JOIN).state).toBe("online");
  });

  it("does not leave the online state on a lobby quit alone", () => {
    expect(run(LOGIN, JOIN, MENU_QUIT).state).toBe("online");
  });

  it("marks a session end that came without the channel line, with no code", () => {
    const state = run(LOGIN, JOIN, KICK[3]);
    expect(state.state).toBe("disconnected");
    expect(state.code).toBeNull();
    expect(state.reason).toBeNull();
  });

  it("takes the code from the popup when the channel line did not carry one", () => {
    const state = run(LOGIN, JOIN, KICK[2]);
    expect(state).toMatchObject({ state: "disconnected", code: 30028 });
  });

  it("marks a game that wrote its quit line", () => {
    const quit = `${at("50:00.000")} [Notice] <SystemQuit> CSystem::Quit invoked exitCode=0 [Team_X]`;
    expect(run(LOGIN, JOIN, quit).state).toBe("closed");
  });

  it("keeps only a short safe reason: no markup, no control characters, bounded", () => {
    const hostile = `${at("40:00.000")} [Notice] <Channel Disconnected> cause=1 reason="<img src=x onerror=1>${"A".repeat(300)}" isRemote=1 gamerules="SC_Default"`;
    const state = applyConnectionLine(UNKNOWN_CONNECTION, hostile);
    expect(state.state).toBe("disconnected");
    expect(state.reason).toMatch(/^[A-Za-z0-9 ._:\-/()]{1,80}$/);
    expect(state.reason).not.toContain("<");
  });

  it("never carries the handle, an address or an id", () => {
    expect(JSON.stringify(run(LOGIN, JOIN, KICK, MENU_QUIT))).not.toMatch(
      new RegExp(`${HANDLE}|203\\.0\\.113|abc`),
    );
  });
});

describe("ConnectionTracker follows the end of the log", () => {
  let dir: string;
  let file: string;
  let clock: number;
  const tracker = () => new ConnectionTracker(new GameLog({ logPath: file }), () => clock);
  const append = (lines: string[]) => fs.appendFileSync(file, lines.join("\n") + "\n");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-conn-"));
    file = path.join(dir, "Game.log");
    clock = 1_000_000;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is null when the log is not configured or does not exist", async () => {
    expect(await new ConnectionTracker(new GameLog({}), () => clock).current()).toBeNull();
    expect(await tracker().current()).toBeNull();
  });

  it("reads the whole log the first time, then only what was added", async () => {
    append([...LOGIN, ...JOIN]);
    const t = tracker();
    expect((await t.current())?.state).toBe("online");
    clock += 1000;
    append(KICK);
    expect(await t.current()).toMatchObject({ state: "disconnected", code: 30028 });
    clock += 1000;
    append([MENU_QUIT]);
    expect((await t.current())?.state).toBe("menu");
  });

  it("does not look at the file again within 400 ms", async () => {
    append([...LOGIN, ...JOIN]);
    const t = tracker();
    expect((await t.current())?.state).toBe("online");
    append(KICK);
    clock += 100;
    expect((await t.current())?.state).toBe("online");
    clock += 400;
    expect((await t.current())?.state).toBe("disconnected");
  });

  it("waits for the end of a line cut in the middle by a write", async () => {
    append([...LOGIN, ...JOIN]);
    const t = tracker();
    await t.current();
    const [first, ...rest] = KICK;
    fs.appendFileSync(file, first.slice(0, 60));
    clock += 1000;
    expect((await t.current())?.state).toBe("online");
    fs.appendFileSync(file, first.slice(60) + "\n" + rest.join("\n") + "\n");
    clock += 1000;
    expect((await t.current())?.state).toBe("disconnected");
  });

  it("starts again from zero when the game recreates the log", async () => {
    append([...LOGIN, ...JOIN, ...KICK]);
    const t = tracker();
    expect((await t.current())?.state).toBe("disconnected");
    fs.writeFileSync(file, LOGIN.join("\n") + "\n");
    clock += 1000;
    expect((await t.current())?.state).toBe("menu");
  });

  it("starts in the middle of a large log without taking a cut line for a marker", async () => {
    const filler = Array.from(
      { length: 3000 },
      (_, i) => `${at("00:00.000")} [Notice] <Filler> line ${i} ${"x".repeat(1500)}`,
    );
    append([...LOGIN, ...JOIN, ...filler]);
    const t = tracker();
    // Only the tail is read: the markers are further back, so nothing is claimed.
    expect((await t.current())?.state).toBe("unknown");
  });
});

describe("the pure part stays loadable in a browser harness", () => {
  it("connectionState.ts imports nothing from node (the preview page loads poll.ts, which imports it)", () => {
    const source = fs.readFileSync(new URL("./connectionState.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/from\s+["']\.\/(parser|reader)\.js["']/);
  });
});
