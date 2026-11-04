/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TEST SUPPORT (end-to-end replay): the REAL production objects, driven from ONE synthetic timeline.
 *
 * What is real: the telemetry service (fed over a loopback socket by the fake game, through the frame encoder), the
 * Game.log reader, the connection tracker, the ledger service, the session manager and its store (a file in a temp
 * folder), the dashboard service behind `sc_live_poll`, and every tool, called through an in-memory MCP client.
 * What is made up: the game (a fake server that sends hand-encoded frames), the log (a file this world grows), the
 * planner behind the action bar, and the clock (one `VirtualClock` that every part reads, so nothing sleeps).
 *
 * The timeline: `world.at(seconds)` schedules an event (log lines, a balance, a ship state, a cut of the stream);
 * `await world.playTo(seconds)` walks the clock to that second, one STEP at a time. A step is, in this order:
 *   1. the clock moves; the events due now run;
 *   2. the log grows (the due lines, and one filler line: the real game writes all the time, and the journal waits for a
 *      later line before it believes a cargo request went through);
 *   3. one frame goes out with the balance of the moment (unless the stream is cut) and the world waits until the
 *      telemetry service has counted it, so the balance is stamped with THIS step's time and no other;
 *   4. the ledger reads the log now (`refreshNow`), and the session manager looks at the game (`tick`).
 * Steps fall on a grid (`dt`, 2 s) and on every scheduled event. The grid matters: the commerce model only trusts a
 * balance that a frame vouched for within 3 s (TRADE_GAP_TOLERANCE_MS), so a stretch played with a coarse grid is a
 * stretch the telemetry did not cover.
 *
 * ASSUMPTIONS the world makes, named here so a scenario does not have to repeat them: the filler line is written at
 * every step; the game keeps streaming at the grid rate (the real one sends about 17 frames a second, which the
 * model's windows cannot tell apart from one every 2 s); a log line and the balance change it causes are a few
 * hundred milliseconds apart (the scenarios choose the delay).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { HttpClient } from "../../core/http.js";
import { UI_EXTENSION_ID, UI_MIME_TYPE } from "../../dashboard/constants.js";
import type { LedgerService } from "../../dashboard/ledgerService.js";
import { ConnectionTracker } from "../../providers/gamelog/connection.js";
import { GameLog } from "../../providers/gamelog/reader.js";
import type { SessionManager } from "../../providers/sessions/manager.js";
import { createSessionStack } from "../../providers/sessions/stack.js";
import type { StoreState } from "../../providers/sessions/types.js";
import { createTelemetry, type Telemetry } from "../../providers/telemetry/index.js";
import { createGameLogHint } from "../../providers/telemetry/gamelogHint.js";
import {
  actorField,
  frame,
  vehicleField,
  type ShipSpec,
} from "../../providers/telemetry/testing/encode.js";
import { startFakeGame, type FakeGame } from "../../providers/telemetry/testing/fakeServer.js";
import { createMcpServer } from "../../server.js";
import { dashboardTools } from "../../tools/dashboard.js";
import { createRegistry } from "../../tools/registry.js";
import { sessionDebriefTools } from "../../tools/sessionDebrief.js";
import { sessionTools } from "../../tools/sessions.js";
import { telemetryTools } from "../../tools/telemetry.js";
import { tradeJournalTools } from "../../tools/tradejournal.js";
import { waitFor } from "../waitFor.js";
import { fillerLine, headerLines, joinLines } from "./lines.js";
import { planResultFor, type RouteSpec } from "./planner.js";

/** 2026-11-04 18:00:00 UTC. */
export const REPLAY_EPOCH = Date.UTC(2026, 10, 4, 18, 0, 0);

export class VirtualClock {
  constructor(public t: number) {}
  now = (): number => this.t;
}

/** The ship the fake game flies: on its own it carries no condition. */
const FLYING: ShipSpec = {
  altitude: 2500,
  g: 1,
  hydrogen: 0.8,
  power: {
    powerplants: true,
    engines: true,
    weapons: true,
    coolers: true,
    life_support: true,
    gravity_generators: true,
    sensors: true,
    shield_generators: true,
    shield_emitters: true,
  },
  lights: { thr: "nominal", shld: "nominal", qdrv: "off" },
};
/** In quantum mode the shields go off and the quantum drive light comes on: two conditions the dashboard shows. */
export const QUANTUM: ShipSpec = {
  altitude: 3.4028235e38,
  g: 1,
  hydrogen: 0.8,
  power: { ...FLYING.power, shield_generators: false, shield_emitters: false },
  lights: { thr: "nominal", shld: "off", qdrv: "nominal" },
};
export { FLYING };

const unusedClient = {
  defaults: {},
  get: async () => {
    throw new Error("the replay world never reaches a network host");
  },
} as unknown as HttpClient;

/** Yields to the event loop (so a loopback socket can deliver) before it falls back on a slower wait. */
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  await waitFor(check, what, 20_000, 5);
}

export interface Output {
  tool: string;
  args: Record<string, unknown>;
  /** The text the model would read. */
  text: string;
  /** The structured copy the View reads (the host does not give it to the model). */
  structured: string;
  isError: boolean;
}

export interface Called {
  /** The `data` of the provenance envelope when there is one, else the parsed text. */
  data: any;
  /** The structured content, as the View receives it. */
  structured: any;
  text: string;
  isError: boolean;
}

export interface ReplayOptions {
  epoch?: number;
  /** The balance the fake game sends from the first frame. */
  startBalance?: number;
  /** The quiet time after which the next play period is a new session. Default 3 hours. */
  gapMs?: number;
  /** Seconds between two steps when nothing is scheduled. Default 2. */
  dt?: number;
  /** Reuse the folder of an earlier world (a restart of the whole test process). Default: a fresh one. */
  dir?: string;
}

type Action = { sec: number; order: number; run: () => void };

export class ReplayWorld {
  readonly clock: VirtualClock;
  readonly epoch: number;
  readonly dir: string;
  readonly logFile: string;
  readonly sessionsFile: string;
  readonly outputs: Output[] = [];
  /** The seconds at which a step was taken, in order (for the harness's own tests, and to diagnose a scenario). */
  readonly steps: number[] = [];
  game!: FakeGame;

  /** What the fake game sends. */
  balance: number;
  ship: ShipSpec = FLYING;
  /** False: no frame goes out (the game is in a menu, or the stream is cut). */
  streaming = false;
  /** The route the fake planner answers with. */
  route: RouteSpec = {
    commodity: "Laranite",
    from: "Port Tressler",
    to: "Area18 TDD",
    buyPrice: 190,
    sellPrice: 490,
    scu: 600,
  };

  // The server side. Replaced by `crash()` + `boot()`.
  telemetry!: Telemetry;
  gameLog!: GameLog;
  connection!: ConnectionTracker;
  ledger!: LedgerService;
  manager!: SessionManager;
  client!: Client;
  serverUp = false;

  private cur = 0;
  private dt: number;
  private gapMs: number;
  private order = 0;
  private actions: Action[] = [];
  private pendingLines: string[] = [];
  private lastMtime = 0;
  private searches = 0;
  private closeClient: (() => Promise<void>) | null = null;
  private ownsDir: boolean;

  private constructor(opts: ReplayOptions) {
    this.epoch = opts.epoch ?? REPLAY_EPOCH;
    this.clock = new VirtualClock(this.epoch);
    this.balance = opts.startBalance ?? 320_000;
    this.dt = opts.dt ?? 2;
    this.gapMs = opts.gapMs ?? 3 * 3_600_000;
    this.ownsDir = opts.dir === undefined;
    this.dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "sc-replay-"));
    this.logFile = path.join(this.dir, "Game.log");
    this.sessionsFile = path.join(this.dir, "sessions.json");
  }

  /**
   * A world with the server up, the game's log opened (header and a joined server), the fake game listening and the
   * telemetry reader connected, no frame sent yet. Time starts at the epoch, second 0.
   */
  static async create(opts: ReplayOptions = {}): Promise<ReplayWorld> {
    const w = new ReplayWorld(opts);
    w.game = await startFakeGame();
    // The log starts a minute before second 0: a game that had just been started.
    w.writeLog(
      [...headerLines(w.epoch - 60_000), ...joinLines(w.epoch - 50_000)],
      w.epoch - 50_000,
    );
    await w.boot();
    return w;
  }

  // ---------------------------------------------------------------------------------------------------------
  // The timeline
  // ---------------------------------------------------------------------------------------------------------

  /** Epoch milliseconds of second `s` of the timeline. */
  ms(s: number): number {
    return this.epoch + Math.round(s * 1000);
  }

  get seconds(): number {
    return this.cur;
  }

  /** Schedules things at second `s`. They run at the step that falls on `s` (never earlier). */
  at(s: number) {
    if (s < this.cur - 1e-9) throw new Error(`second ${s} is in the past (now ${this.cur})`);
    const add = (run: () => void) => {
      this.actions.push({ sec: s, order: this.order++, run });
      this.actions.sort((a, b) => a.sec - b.sec || a.order - b.order);
    };
    return {
      /** Lines the game writes in Game.log at this second. They must carry their own time. */
      log: (...lines: (string | string[])[]) => add(() => this.pendingLines.push(...lines.flat())),
      /** The balance the game sends from now on. */
      balance: (uec: number) =>
        add(() => {
          this.balance = uec;
        }),
      /** Adds to the balance (negative: spends). */
      change: (delta: number) =>
        add(() => {
          this.balance += delta;
        }),
      ship: (spec: ShipSpec) =>
        add(() => {
          this.ship = spec;
        }),
      /** The stream is cut: no frame until `resume`. */
      cut: () =>
        add(() => {
          this.streaming = false;
        }),
      resume: () =>
        add(() => {
          this.streaming = true;
        }),
      run: add,
    };
  }

  /** The game starts streaming (call before the first step). */
  startStream(): void {
    this.streaming = true;
  }

  /**
   * Walks the timeline to second `target`, step by step (see the header). `dt` overrides the grid for this call only:
   * a long quiet stretch can use a coarse one, but the telemetry does not vouch for the balance across it.
   */
  async playTo(target: number, opts: { dt?: number } = {}): Promise<void> {
    const dt = opts.dt ?? this.dt;
    // Something scheduled for the second we stand on (or before): run it now, not at the next grid point.
    if (this.actions.some((a) => a.sec <= this.cur + 1e-9)) await this.step(this.cur);
    while (this.cur < target - 1e-9) {
      const nextAction = this.actions.find((a) => a.sec > this.cur + 1e-9)?.sec ?? Infinity;
      await this.step(Math.min(nextAction, this.cur + dt, target));
    }
  }

  /** One step at second `s` (>= the current one). */
  async step(s: number): Promise<void> {
    this.cur = Math.max(this.cur, s);
    this.steps.push(this.cur);
    this.clock.t = this.ms(this.cur);
    while (this.actions.length > 0 && this.actions[0]!.sec <= this.cur + 1e-9) {
      this.actions.shift()!.run();
    }
    this.writeLog([...this.pendingLines, fillerLine(this.clock.t)], this.clock.t);
    this.pendingLines = [];
    if (!this.serverUp) return;
    if (this.streaming) await this.pushFrame();
    await this.ledger.refreshNow();
    await this.manager.tick();
  }

  /** The seconds the server is not running pass (a crash, a closed laptop): the game and its log go on. */
  async playDownTo(target: number, dt = 10): Promise<void> {
    if (this.serverUp) throw new Error("the server is up: use playTo");
    await this.playTo(target, { dt });
  }

  // ---------------------------------------------------------------------------------------------------------
  // The game side
  // ---------------------------------------------------------------------------------------------------------

  private writeLog(lines: string[], mtimeMs: number): void {
    const text = lines.join("\n") + "\n";
    // Distinct, increasing dates: the ledger reads the file again only when its date changed.
    this.lastMtime = Math.max(mtimeMs, this.lastMtime + 1);
    // One handle for the whole step (create if missing, append, set the date): no check of the file before its use.
    const fd = fs.openSync(this.logFile, "a");
    try {
      fs.writeSync(fd, text);
      fs.futimesSync(fd, this.lastMtime / 1000, this.lastMtime / 1000);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Writes lines to the log at once (outside the timeline: for a scenario that needs a line NOW). */
  appendNow(...lines: (string | string[])[]): void {
    this.pendingLines.push(...lines.flat());
  }

  private async pushFrame(): Promise<void> {
    const before = (await this.telemetry.status(false)).frames_received;
    this.game.send(
      frame(vehicleField(this.ship), actorField({ uec: this.balance, locomotion: 3, health: 100 })),
    );
    await until(
      async () => (await this.telemetry.status(false)).frames_received > before,
      "the telemetry service to count the frame",
    );
  }

  // ---------------------------------------------------------------------------------------------------------
  // The server side
  // ---------------------------------------------------------------------------------------------------------

  /** Builds the server's objects on the world's files, as `index.ts` does at start. */
  async boot(): Promise<void> {
    const connectionsBefore = this.game.connections();
    this.gameLog = new GameLog({ logPath: this.logFile }, this.clock.now);
    this.connection = new ConnectionTracker(this.gameLog, this.clock.now);
    this.telemetry = createTelemetry({
      enabled: true,
      options: {
        endpointForTests: { host: "127.0.0.1", port: this.game.port },
        reader: { retryMs: [20, 20], connectTimeoutMs: 500 },
        now: this.clock.now,
        frameIntervalMs: 0,
        gameLogHint: createGameLogHint(this.gameLog, this.clock.now),
      },
    });
    const stack = createSessionStack({
      telemetry: this.telemetry,
      gameLog: this.gameLog,
      connection: this.connection,
      config: { enabled: true, file: this.sessionsFile, gapMs: this.gapMs },
      now: this.clock.now,
      newId: (() => {
        let n = 0;
        return () => `s_replay_${this.clock.t.toString(36)}_${n++}`;
      })(),
    });
    this.ledger = stack.ledger;
    this.manager = stack.manager;

    const tools = [
      ...telemetryTools({
        telemetry: this.telemetry,
        gameLog: this.gameLog,
        connection: this.connection,
      }),
      ...dashboardTools(
        {
          telemetry: this.telemetry,
          connection: this.connection,
          gameLog: this.gameLog,
          sessions: this.manager,
        },
        {
          plan: async () => planResultFor(this.route),
          now: this.clock.now,
          minIntervalMs: 0,
        },
      ),
      ...sessionTools({ sessions: this.manager }),
      ...sessionDebriefTools({ sessions: this.manager }),
      ...tradeJournalTools({ gameLog: this.gameLog, scwClient: unusedClient }),
    ];
    const registry = createRegistry(tools, {}, { now: this.clock.now });
    const server = createMcpServer(registry);
    // The replay plays the dashboard View too (it polls and asks for reports): the client declares the UI extension, as
    // Claude Desktop does; the server refuses the app-only tools to a client that does not.
    this.client = new Client(
      { name: "replay", version: "1" },
      {
        capabilities: {
          extensions: { [UI_EXTENSION_ID]: { mimeTypes: [UI_MIME_TYPE] } },
        } as Record<string, unknown>,
      },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), this.client.connect(b)]);
    const client = this.client;
    this.closeClient = async () => {
      await client.close();
    };

    // Start the reader and wait for the fake game to be reached.
    await this.telemetry.status(true);
    await until(
      () => this.game.connections() > connectionsBefore,
      "the reader to reach the fake game",
    );
    await until(
      async () => ["connected", "live"].includes((await this.telemetry.status(false)).state),
      "the telemetry state to be connected",
    );
    this.serverUp = true;
  }

  /**
   * A crash of the server process: the reader goes away, every in-memory object is dropped, nothing is flushed or
   * closed on purpose. Files stay as they are. The game and its log go on (use `playDownTo`).
   */
  async crash(): Promise<void> {
    this.serverUp = false;
    const closed = this.game.closedConnections();
    await this.closeClient?.().catch(() => undefined);
    await this.telemetry.stop();
    await until(() => this.game.closedConnections() > closed, "the game to see the reader leave");
    this.closeClient = null;
  }

  /** The server starts again on the same files. In-memory state (balance history, the plan, the poll cache) is gone. */
  async restart(): Promise<void> {
    if (this.serverUp) await this.crash();
    await this.boot();
  }

  async close(): Promise<void> {
    this.serverUp = false;
    await this.closeClient?.().catch(() => undefined);
    await this.telemetry?.stop().catch(() => undefined);
    await this.game.close();
    if (this.ownsDir) fs.rmSync(this.dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------------------------------------------
  // Asking the server (always through the MCP client)
  // ---------------------------------------------------------------------------------------------------------

  /** A tool call through the in-memory MCP client. Every call is recorded in `outputs`. */
  async call(name: string, args: Record<string, unknown> = {}): Promise<Called> {
    const r: any = await this.client.callTool({ name, arguments: args });
    const text: string = r.content?.[0]?.text ?? "";
    const structured = r.structuredContent;
    this.outputs.push({
      tool: name,
      args,
      text,
      structured: structured === undefined ? "" : JSON.stringify(structured),
      isError: r.isError === true,
    });
    let data: any;
    try {
      const parsed = JSON.parse(text);
      data = parsed && typeof parsed === "object" && "provenance" in parsed ? parsed.data : parsed;
    } catch {
      data = text;
    }
    return { data, structured, text, isError: r.isError === true };
  }

  /** What `sc_live_poll` answers to a View that asked for the balance or not (the full answer, no delta). */
  async poll(includeBalance = false): Promise<any> {
    const r = await this.call("sc_live_poll", { include_balance: includeBalance });
    return r.structured;
  }

  /** The route plan applied through the action bar's own tool: a search, then "apply" on its first option. */
  async applyPlan(route: RouteSpec = this.route): Promise<any> {
    this.route = route;
    // Each search is a different question for the short cache, so the fake planner is asked again.
    this.searches += 1;
    const found = await this.call("sc_trade_suggest", {
      action: "search",
      objective: "profit",
      cargo_scu: route.scu,
      budget: 1_000_000 + this.searches,
      use_ship: false,
    });
    const option = found.structured?.options?.[0];
    if (!option) throw new Error(`the planner gave no option: ${found.text}`);
    const applied = await this.call("sc_trade_suggest", { action: "apply", id: option.id });
    if (applied.structured?.state !== "applied") {
      throw new Error(`the plan was not applied: ${applied.text}`);
    }
    return applied.structured.plan;
  }

  // ---------------------------------------------------------------------------------------------------------
  // The session file
  // ---------------------------------------------------------------------------------------------------------

  sessionsBytes(): string {
    try {
      return fs.readFileSync(this.sessionsFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  sessionsJson(): StoreState {
    return JSON.parse(this.sessionsBytes()) as StoreState;
  }
}
