import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HttpClient } from "../core/http.js";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { NOW, session } from "../providers/sessions/fixtures.testing.js";
import { SessionManager } from "../providers/sessions/manager.js";
import { SessionStore } from "../providers/sessions/store.js";
import type { Trip } from "../providers/sessions/types.js";
import type { Telemetry } from "../providers/telemetry/index.js";
import { MAX_INSTRUCTIONS_LENGTH, SERVER_INSTRUCTIONS } from "../instructions.js";
import { PROMPTS } from "../prompts.js";
import { allTools, createRegistry } from "./registry.js";

/**
 * Feature: sc_session_stats gains route_reliability, and it follows the balance exactly like the other money figures.
 * A pre-seeded session file, a fake telemetry: no game, no network.
 */

const unused = { defaults: {}, get: async () => ({ data: {} }) } as unknown as HttpClient;
const DAY = 86_400_000;
/** 73 700 realised over 100 000 planned, twice: a ratio that appears nowhere by chance. */
const RATIO = "0.737";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-sessions-tool-cal-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const trade = (n: number): Trip => ({
  key: `00000000000000${n.toString(16).padStart(2, "0")}`,
  kind: "trade",
  source: "trade_journal",
  started_at: new Date(NOW - n * DAY - 600_000).toISOString(),
  ended_at: new Date(NOW - n * DAY).toISOString(),
  label: null,
  commodity: "Laranite",
  buy_terminal: null,
  sell_terminal: null,
  scu: 100,
  cost_auec: 18_900,
  revenue_auec: 92_600,
  fees_auec: 1_000,
  gross_margin_auec: 73_700,
  net_auec: 72_700,
  net_kind: "balance_delta",
  planned_profit_auec: 100_000,
  planned_scu: 100,
  plan_buy_terminal: "Port Tressler",
  plan_sell_terminal: "Area18 TDD",
  plan_link: "prices",
  unexplained_auec: null,
  net_doubtful: null,
  fees_method: "mesure",
});

async function rig(trips: Trip[] = [trade(1), trade(2)]) {
  const file = path.join(dir, "sessions.json");
  const store = new SessionStore(file, { now: () => NOW });
  await store.transact((d) => {
    d.sessions.push(
      session(1, {
        game_version: "4.10.197.2878 (build 12881860)",
        trips,
        active_ms: 3_600_000,
      }),
    );
    d.next_number = 2;
    return { changed: true, result: null };
  });
  const telemetry: Telemetry = {
    enabled: true,
    status: async () => ({ state: "waiting" }) as never,
    snapshot: async () => null,
    events: async () => ({ events: [], last_seq: 0 }),
    resetUecDelta: async () => undefined,
    stop: async () => undefined,
  };
  const manager = new SessionManager({
    telemetry,
    store,
    config: { enabled: true, file, gapMs: 3 * 3_600_000 },
    now: () => NOW,
  });
  const registry = createRegistry(
    allTools(
      {
        uexClient: unused,
        scwClient: unused,
        sctClient: unused,
        scmdb: new Scmdb({ raw: unused, api: unused, repo: "o/r", cacheDir: () => "" }),
        gameLog: new GameLog({}),
        fleet: new FleetStore("unused.json"),
        telemetry,
        sessions: manager,
      },
      [],
    ),
  );
  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await registry.call(name, args);
    return { r, text: r.content[0].text, data: JSON.parse(r.content[0].text).data };
  };
  const call = (args: Record<string, unknown> = {}) => callTool("sc_session_stats", args);
  return { call, callTool, registry };
}

describe("Feature: what the plan said reaches the model only with the balance", () => {
  /** A quantity sized by the balance (a route built from "Budget = mon solde"): a made-up number found nowhere else. */
  const SIZED = 6937;

  it("Given a trip whose plan was sized by the balance, Then its quantity is withheld like the planned profit, and given only with include_balance", async () => {
    const t = await rig([{ ...trade(1), planned_scu: SIZED, unexplained_auec: 9137 }]);
    for (const [name, args] of [
      ["sc_session_current", {}],
      ["sc_session_list", {}],
      ["sc_session_stats", {}],
    ] as const) {
      const { text, r } = await t.callTool(name, args);
      expect(text, name).not.toContain(String(SIZED));
      expect(JSON.stringify(r.structuredContent ?? {}), name).not.toContain(String(SIZED));
      expect(text, name).not.toContain("100000"); // the planned profit
      expect(text, name).not.toContain("9137"); // what the balance holds beyond the run
      expect(text, name).not.toContain('net_doubtful":true');
    }
    const rich = await t.callTool("sc_session_current", { include_balance: true });
    expect(rich.text).toContain(String(SIZED));
    expect(rich.text).toContain("9137");
    // what carries no amount stays visible: the plan's places and how it was tied to the run
    const plain = await t.callTool("sc_session_current", {});
    expect(plain.text).toContain("Port Tressler");
    expect(plain.text).toContain("prices");
  });
});

describe("Feature: route_reliability in sc_session_stats", () => {
  it("Given two planned runs, When include_balance is true, Then the group shows its runs, its confidence and an estimate note", async () => {
    const t = await rig();
    const { data, text } = await t.call({ include_balance: true });
    const g = data.route_reliability.groups.find((x: { kind: string }) => x.kind === "commodity");
    expect(g).toMatchObject({ commodity: "Laranite", n: 2, confidence: "low" });
    expect(g.reasons).toContain("few_runs");
    expect(g.linked_by_prices).toBe(2);
    // the log never names goods: every real group says so, and the answer carries one sentence about it
    expect(g.goods_unverified).toBe(true);
    expect(data.route_reliability.note).toMatch(
      /goods_unverified true: plan tied to runs by price resemblance/,
    );
    expect(String(g.gross_ratio)).toBe(RATIO);
    expect(data.route_reliability.note).toMatch(/ESTIMATE/);
    expect(data.route_reliability.note).toMatch(/low confidence/);
    // the structured copy for the dashboard is the same answer
    expect(text).toContain("route_reliability");
  });

  it("Given include_balance is false or absent, Then the section is withheld and no ratio, rate or run count of it appears anywhere", async () => {
    const t = await rig();
    for (const args of [{}, { include_balance: false }, { last: 1 }]) {
      const { data, text, r } = await t.call(args);
      expect(data.route_reliability).toBe("withheld");
      expect(text).not.toContain(RATIO);
      expect(text).not.toContain("gross_ratio");
      expect(text).not.toContain("fee_rate");
      expect(text).not.toContain("73700");
      expect(JSON.stringify(r.structuredContent ?? {})).not.toContain(RATIO);
    }
  });

  it("Then the server instructions and the trade_copilot prompt tell Claude to quote it with its runs and confidence", () => {
    expect(SERVER_INSTRUCTIONS).toContain("route_reliability");
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_LENGTH);
    expect([...SERVER_INSTRUCTIONS].every((c) => c.charCodeAt(0) < 128)).toBe(true);
    const prompt = PROMPTS.find((p) => p.name === "trade_copilot")!.render({});
    expect(prompt).toContain("route_reliability");
    expect(prompt).toMatch(/number of runs and the confidence label/);
    expect(prompt).toMatch(/fewer than 2 runs there is none/);
  });

  it("Then the tool description stays within the limit and tells Claude the section is an estimate", async () => {
    const t = await rig();
    const tool = t.registry.list().find((x) => x.name === "sc_session_stats")!;
    expect(tool.description.length).toBeLessThanOrEqual(900);
    expect(tool.description).toMatch(/route_reliability/);
    expect(tool.description).toMatch(/estimate/);
    expect(tool.description).toMatch(/include_balance/);
  });
});
