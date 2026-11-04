/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import type { CalibrationSection } from "../providers/sessions/calibration.js";
import { buildCalibration, calibrationForPoll } from "../providers/sessions/calibration.js";
import { NOW as SESSION_NOW, session } from "../providers/sessions/fixtures.testing.js";
import type { SessionManager } from "../providers/sessions/manager.js";
import type { Telemetry } from "../providers/telemetry/index.js";
import {
  calibrationExpected,
  calibrationFromLedger,
  calibrationLine,
  calibrationNextTile,
  calibrationNormalize,
  calibrationPick,
} from "./calibrationPanel.js";
import { boundLedger, buildLedgerPayload, EMPTY_LEDGER } from "./ledger.js";
import {
  ledgerChannelClean,
  ledgerNum,
  ledgerOneOf,
  ledgerStripBalance,
  ledgerText,
} from "./ledgerPanel.js";
import { DashboardService } from "./service.js";
import {
  findAll,
  findButton,
  isShown,
  startPage,
  visibleText,
  type FakeNode,
  type PageWorld,
} from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import { specsSamples } from "./testing/specsFixtures.js";
import { tradeBalanceAt, tradeLedger } from "./testing/tradeScenario.js";

/**
 * Feature: the route calibration in the dashboard. The figures are the player's own runs against their plans: an estimate
 * with its number of runs. They are derived from the balance, so they exist only where the balance is shown. Every
 * figure here is invented.
 */

const L = { ledgerNum, ledgerText, ledgerOneOf };
const SECOND = 1000;
/** A right-to-left override, built from its code point (the repository refuses it as a literal). */
const BIDI = String.fromCodePoint(0x202e);
const NBSP_FREE = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

/** Ratios chosen so that they cannot appear by chance anywhere else in an answer. */
const GROSS = 0.737;
const NET = 0.762;
const FEE = 0.137;
const WIRE = /0\.737|0\.762|0\.137|gross_ratio|net_ratio|fee_rate|"calibration"/;

const group = (over: Record<string, unknown> = {}) => ({
  kind: "commodity",
  commodity: "Laranite",
  buy_terminal: null,
  sell_terminal: null,
  n: 4,
  confidence: "medium",
  reasons: [],
  gross_ratio: GROSS,
  gross_median: 0.74,
  gross_min: 0.65,
  gross_max: 0.83,
  high_variance: false,
  net_ratio: NET,
  net_n: 4,
  net_confidence: "medium",
  fee_rate: FEE,
  fee_n: 4,
  fee_measured: 4,
  last_run_at: "2026-11-03T18:00:00.000Z",
  last_run_age_days: 1,
  quantity_adjusted: 0,
  quantity_unknown: 0,
  unknown_version: 0,
  linked_by_prices: 4,
  excluded: { old: 0, other_patch: 0, quantity: 0, beyond_last: 0 },
  ...over,
});
const route = group({ kind: "route", buy_terminal: "Port Tressler", sell_terminal: "Area18 TDD" });
const gold = group({
  commodity: "Gold",
  n: 2,
  confidence: "low",
  reasons: ["few_runs"],
  net_n: 0,
  net_ratio: null,
});
const SECTION: CalibrationSection = {
  v: 1,
  patch_line: "4.10",
  groups: [group(), gold, route] as never,
};

describe("Feature: the section is rebuilt field by field in the View", () => {
  it("Given a hostile section, Then unknown fields, long text, bad numbers and thin groups are dropped", () => {
    const n = calibrationNormalize(L, {
      v: 1,
      patch_line: "4.10<script>alert(1)</script>".padEnd(40, "x"),
      evil: "x",
      groups: [
        { ...group(), commodity: ("Laranite" + BIDI).padEnd(200, "z"), evil: { a: 1 }, n: 1e12 },
        { ...group(), n: 1 }, // one run: never a figure
        { ...group(), gross_ratio: "0.9" }, // a string is not a number
        { ...group(), gross_ratio: 9e99 },
        { ...group(), confidence: "certain" },
        "nope",
        null,
      ],
    });
    expect(n.patch_line.length).toBeLessThanOrEqual(12);
    // kept: the long one, the huge ratio and the unknown confidence; dropped: one run, a string, junk
    expect(n.groups).toHaveLength(3);
    expect(n.groups[0].commodity.length).toBeLessThanOrEqual(60);
    expect(n.groups[0].commodity).not.toContain(BIDI);
    expect(n.groups[0].n).toBeLessThanOrEqual(999);
    expect(n.groups[0]).not.toHaveProperty("evil");
    expect(n.groups[1].gross_ratio).toBe(100); // clamped, finite
    expect(n.groups[2].confidence).toBe("low");
    expect(calibrationNormalize(L, { v: 2, groups: [] })).toBeNull();
    expect(calibrationNormalize(L, null)).toBeNull();
    expect(calibrationFromLedger(L, { calibration: SECTION })!.groups).toHaveLength(3);
    expect(calibrationFromLedger(L, {})).toBeNull();
  });

  it("Given more groups than the View keeps, Then the surplus is dropped", () => {
    const many = Array.from({ length: 40 }, (_, i) => group({ commodity: `Goods ${i}` }));
    expect(calibrationNormalize(L, { v: 1, groups: many })!.groups).toHaveLength(14);
  });
});

describe("Feature: the line under a suggestion is quiet, honest and tied to its own goods", () => {
  const calib = calibrationNormalize(L, SECTION)!;

  it("Given a route with four runs, Then the line gives n, the realised share, the fee rate and the confidence, as an estimate", () => {
    const line = calibrationLine(calib, "Laranite", "Port Tressler", "Area18 TDD");
    expect(NBSP_FREE(line.text)).toBe(
      "Tes 4 derniers trajets sur cette route : réalisé (marge brute) ≈ 74 % du prévu, frais ≈ 14 % du chiffre d’affaires.",
    );
    expect(line.tag).toBe("estimé · confiance moyenne");
    expect(line.scope).toBe("route");
  });

  it("Given another route of the same goods, Then the goods' own group answers and the line says 'de cette marchandise'", () => {
    const line = calibrationLine(calib, "laranite", "Lorville CBD", "Area18 TDD");
    expect(line.scope).toBe("commodity");
    expect(line.text).toContain("Tes 4 derniers trajets de cette marchandise");
  });

  it("Given two runs, Then the line says that few runs only give an indication", () => {
    const line = calibrationLine(calib, "Gold", "Everus Harbor", "Seraphim Station");
    expect(NBSP_FREE(line.text)).toContain("Tes 2 derniers trajets de cette marchandise");
    expect(line.text).toContain("Peu de trajets : indicatif seulement.");
    expect(line.tag).toBe("estimé · confiance faible");
  });

  it("Given wild results, Then the range is shown", () => {
    const wild = calibrationNormalize(L, {
      v: 1,
      groups: [
        group({ high_variance: true, gross_min: 0.2, gross_max: 1.1, confidence: "low", n: 5 }),
      ],
    })!;
    const line = calibrationLine(wild, "Laranite", null, null);
    expect(NBSP_FREE(line.text)).toContain("Résultats très variables (de 20 % à 110 %).");
  });

  it("Given goods with no group, a prefix of a name, another goods or no data, Then nothing is said and nothing is borrowed", () => {
    expect(calibrationLine(calib, "Agricium", null, null)).toBeNull();
    expect(calibrationLine(calib, "Lara", null, null)).toBeNull();
    expect(calibrationLine(calib, "Laranite Ore", null, null)).toBeNull();
    expect(calibrationLine(calib, "", null, null)).toBeNull();
    expect(calibrationLine(null, "Laranite", null, null)).toBeNull();
    expect(calibrationPick({ groups: [] }, "Laranite", null, null)).toBeNull();
  });
});

describe("Feature: the calibrated expectation and the tile 'Si tu refais ce trajet'", () => {
  const calib = calibrationNormalize(L, SECTION)!;
  const plan = {
    commodity: "Laranite",
    buy_terminal: "Port Tressler",
    sell_terminal: "Area18 TDD",
    scu: 696,
    sell_unit_price: 457,
  };

  it("Given the net ratio of four runs, Then the tile is the planned profit times it, an estimate with n and the confidence", () => {
    const tile = calibrationNextTile(calib, plan, { planned_profit: 180_000 });
    expect(tile.auec).toBe(Math.round(180_000 * NET));
    expect(tile.tag).toBe("estimé · confiance moyenne");
    expect(NBSP_FREE(tile.sub)).toBe("prévu × 76 % (net typique de tes 4 trajets sur cette route)");
    expect(tile.basis).toBe("net_ratio");
  });

  it("Given two runs without a net ratio, Then the gross ratio less the usual fees on the plan's turnover is used, and said", () => {
    const only = calibrationNormalize(L, {
      v: 1,
      groups: [group({ net_ratio: null, net_n: 0, n: 3, fee_n: 3, confidence: "low" })],
    })!;
    const tile = calibrationNextTile(
      only,
      { ...plan, buy_terminal: "", sell_terminal: "" },
      {
        planned_profit: 180_000,
      },
    );
    // 180 000 x 0.737 minus 0.137 x (457 x 696)
    expect(tile.auec).toBe(Math.round(180_000 * GROSS - FEE * 457 * 696));
    expect(NBSP_FREE(tile.sub)).toBe(
      "prévu × 74 % (marge brute typique de tes 3 trajets sur cette marchandise), moins les frais habituels (14 % du chiffre d’affaires du plan) · peu de trajets : indicatif seulement",
    );
    expect(tile.tag).toBe("estimé · confiance faible");
    // no turnover for the plan: nothing is invented
    expect(
      calibrationNextTile(only, { commodity: "Laranite" }, { planned_profit: 180_000 }),
    ).toBeNull();
  });

  it("Given no plan figure, another goods or fewer than two runs, Then the tile keeps the card's own figure (null here)", () => {
    expect(calibrationNextTile(calib, plan, { planned_profit: null })).toBeNull();
    expect(
      calibrationNextTile(calib, { ...plan, commodity: "Agricium" }, { planned_profit: 1 }),
    ).toBeNull();
    expect(calibrationNextTile(calib, null, { planned_profit: 1 })).toBeNull();
    expect(calibrationExpected(null, 100)).toBeNull();
  });
});

describe("Feature: the section is in the ledger only for a caller allowed the balance", () => {
  const input = (includeBalance: boolean, calibration?: CalibrationSection) => ({
    base: EMPTY_LEDGER,
    history: [],
    includeBalance,
    nowMs: SESSION_NOW,
    ...(calibration ? { calibration } : {}),
  });

  it("Given the balance is asked, Then the section is carried; given it is not, Then it is not, whatever the caller passed", () => {
    expect(buildLedgerPayload(input(true, SECTION)).calibration).toEqual(SECTION);
    const plain = buildLedgerPayload(input(false, SECTION));
    expect(plain).not.toHaveProperty("calibration");
    expect(JSON.stringify(plain)).not.toMatch(WIRE);
    // the answer built without the balance is the same whatever the calibration holds (so is its hash)
    const other = { ...SECTION, groups: [group({ gross_ratio: 0.511 })] as never };
    expect(JSON.stringify(buildLedgerPayload(input(false, other)))).toBe(JSON.stringify(plain));
    expect(JSON.stringify(buildLedgerPayload(input(false)))).toBe(JSON.stringify(plain));
  });

  it("Given a section with no group, Then the key is left out", () => {
    expect(buildLedgerPayload(input(true, { ...SECTION, groups: [] }))).not.toHaveProperty(
      "calibration",
    );
  });

  it("Given a payload over its budget, Then the calibration is the first thing cut", () => {
    const payload = buildLedgerPayload(input(true, SECTION));
    const cut = boundLedger(payload, 200);
    expect(cut).not.toHaveProperty("calibration");
    expect(cut.truncated).toContain("calibration dropped");
  });

  it("Given a section from real sessions, Then it is small enough for the ledger's budget", () => {
    const trips = Array.from({ length: 30 }, (_, i) => ({
      key: `00000000000000${i.toString(16).padStart(2, "0")}`,
      kind: "trade" as const,
      source: "trade_journal" as const,
      started_at: new Date(SESSION_NOW - (i + 1) * 3_600_000 - 600_000).toISOString(),
      ended_at: new Date(SESSION_NOW - (i + 1) * 3_600_000).toISOString(),
      label: null,
      commodity: `Goods ${i % 14}`,
      buy_terminal: null,
      sell_terminal: null,
      scu: 100,
      cost_auec: 1,
      revenue_auec: 80_001,
      fees_auec: 100,
      gross_margin_auec: 80_000,
      net_auec: 79_900,
      net_kind: "balance_delta" as const,
      planned_profit_auec: 100_000,
      planned_scu: 100,
      plan_buy_terminal: `Terminal ${i % 14} with a long name of sixty characters or so ....`,
      plan_sell_terminal: `Destination ${i % 14} with a long name of sixty characters ....`,
      plan_link: "prices" as const,
      fees_method: "mesure" as const,
    }));
    const poll = calibrationForPoll(
      buildCalibration(
        [
          session(1, {
            trips: [
              ...trips,
              ...trips.map((t) => ({
                ...t,
                key: `${t.key.slice(0, 14)}ff`,
                started_at: new Date(Date.parse(t.started_at) - 1000).toISOString(),
                ended_at: new Date(Date.parse(t.ended_at) - 1000).toISOString(),
              })),
            ],
          }),
        ],
        { nowMs: SESSION_NOW },
      ),
    );
    expect(poll.groups.length).toBeGreaterThan(0);
    expect(JSON.stringify(poll).length).toBeLessThan(8000);
  });

  it("Given the Views' channel, Then the sender's strip and the receiver's clean both remove the section", () => {
    const rich: any = { ...buildLedgerPayload(input(true, SECTION)) };
    expect(JSON.stringify(rich)).toMatch(WIRE);
    expect(JSON.stringify(ledgerStripBalance(rich))).not.toMatch(WIRE);
    expect(JSON.stringify(ledgerChannelClean(rich))).not.toMatch(WIRE);
    // a hostile sender that puts it under another name still gets nothing through the field-by-field rebuild
    const sneaky = ledgerChannelClean({ ...rich, calibrations: SECTION, trade: undefined });
    expect(JSON.stringify(sneaky)).not.toMatch(WIRE);
  });
});

describe("Feature: the poll carries the section only to a View that asked for the balance", () => {
  const stub = () =>
    ({
      enabled: true,
      status: vi.fn(async () => ({ state: "live", cause: "x", frames_received: 1 })),
      snapshot: vi.fn(async () => null),
      events: vi.fn(async () => ({ events: [], last_seq: 0 })),
      resetUecDelta: vi.fn(async () => undefined),
      balanceHistory: vi.fn(async () => []),
      stop: vi.fn(async () => undefined),
    }) as unknown as Telemetry;

  const rig = (section: CalibrationSection = SECTION) => {
    const calibrationSection = vi.fn(async () => section);
    const sessions = {
      enabled: true,
      bar: async () => ({
        v: 1,
        status: "ok",
        notice: null,
        gap_hours: 3,
        current: null,
        stale: false,
      }),
      calibrationSection,
    } as unknown as SessionManager;
    const service = new DashboardService(
      stub(),
      () => SESSION_NOW,
      undefined,
      undefined,
      undefined,
      undefined,
      sessions,
    );
    return { service, calibrationSection };
  };

  it("Given the balance is not asked, Then the section is not even computed and nothing of it is in the answer", async () => {
    const { service, calibrationSection } = rig();
    const poll = await service.poll({ includeBalance: false });
    expect(calibrationSection).not.toHaveBeenCalled();
    expect(JSON.stringify(poll)).not.toMatch(WIRE);
  });

  it("Given the balance is asked, Then the section is in the ledger, and the two hashes differ while the plain answer never changes", async () => {
    const { service } = rig();
    const rich = await service.poll({ includeBalance: true });
    expect((rich.ledger as any).calibration.groups).toHaveLength(3);
    const plain = await service.poll({ includeBalance: false });
    // the same service with another calibration: the plain answer and its hash are unchanged
    const { service: other } = rig({
      ...SECTION,
      groups: [group({ gross_ratio: 0.511 })] as never,
    });
    const plain2 = await other.poll({ includeBalance: false });
    expect(plain2.hash!.ledger).toBe(plain.hash!.ledger);
    expect(rich.hash!.ledger).not.toBe(plain.hash!.ledger);
    // a View that holds the hash of the rich answer but did not ask for the balance gets the plain one again
    const tailored = await service.poll({
      includeBalance: false,
      have: { ledger: rich.hash!.ledger },
    });
    expect(JSON.stringify(tailored)).not.toMatch(WIRE);
  });

  it("Given the calibration fails, Then the poll still answers without it", async () => {
    const calibrationSection = vi.fn(async () => {
      throw new Error("boom");
    });
    const service = new DashboardService(
      stub(),
      () => SESSION_NOW,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        enabled: true,
        bar: async () => undefined,
        calibrationSection,
      } as unknown as SessionManager,
    );
    const poll = await service.poll({ includeBalance: true });
    expect(JSON.stringify(poll)).not.toMatch(WIRE);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The assembled page
// ---------------------------------------------------------------------------------------------------------------

const PLAN = {
  commodity: "Laranite",
  buy_terminal: "Port Tressler",
  sell_terminal: "Area18 TDD",
  scu: 696,
  expected_profit_auec: 180_000,
  buy_unit_price: 189,
  sell_unit_price: 457,
};

async function page(opts: { always?: boolean; plan?: boolean } = {}) {
  const scenario = new Scenario();
  scenario.specs = specsSamples(scenario.now).ready;
  scenario.uec = tradeBalanceAt;
  scenario.ledger = (include, nowMs) => {
    const base = tradeLedger(nowMs, scenario.epoch, include, "story", PLAN);
    // `always`: a hostile or buggy server that sends the section even to a View that did not ask for the balance
    return include || opts.always ? ({ ...base, calibration: SECTION } as any) : base;
  };
  const w = await startPage({ scenario });
  if (opts.plan) {
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { view: "sc_live_dashboard", plan: PLAN } },
    });
  }
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { displayMode: "fullscreen" },
  });
  await w.advance(215 * SECOND);
  return w;
}
const text = (w: PageWorld) => NBSP_FREE(visibleText(w.root));
const shown = (w: PageWorld, label: string): FakeNode[] =>
  findAll(w.root, (n) => n.tag === "button" && n.textContent === label && isShown(n));

describe("Feature: the line under the suggestions, in the assembled page", () => {
  it("Given the balance is shown, When routes are searched, Then each card of a known goods carries its quiet line with n, the share, the fees and the confidence", async () => {
    const w = await page();
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    findButton(w.root, "Plus rentable").click();
    await w.advance(300);
    const t = text(w);
    // Laranite, Port Tressler -> Area18 TDD: the route's own group
    expect(t).toContain(
      "Tes 4 derniers trajets sur cette route : réalisé (marge brute) ≈ 74 % du prévu, frais ≈ 14 % du chiffre d’affaires.",
    );
    // Gold: two runs, said to be an indication only
    expect(t).toContain("Tes 2 derniers trajets de cette marchandise");
    expect(t).toContain("Peu de trajets : indicatif seulement.");
    expect(t).toContain("estimé · confiance moyenne");
    expect(t).toContain("estimé · confiance faible");
    // goods with no group have no line (Quartz, Scrap, Agricium); the chain that also starts with Laranite has the same one
    expect(t.match(/Tes \d+ derniers trajets/g)).toHaveLength(3);
  });

  it("Given the balance is hidden, Then there is no line, even when the server sent the section anyway", async () => {
    const w = await page({ always: true });
    findButton(w.root, "Plus rentable").click();
    await w.advance(300);
    const t = text(w);
    expect(t).toContain("Port Tressler");
    expect(t).not.toContain("Tes 4 derniers trajets");
    expect(t).not.toContain("réalisé (marge brute)");
    expect(t).not.toMatch(/74\s%|14\s%/);
  });

  it("Given the balance is shown then hidden again, Then the lines go with it", async () => {
    const w = await page();
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    findButton(w.root, "Plus rentable").click();
    await w.advance(300);
    expect(text(w)).toContain("Tes 4 derniers trajets");
    findButton(w.root, "Masquer").click();
    await w.advance(3 * SECOND);
    expect(text(w)).not.toContain("Tes 4 derniers trajets");
  });

  it("Given the line is shown, Then it is in no message to the agent, no context update and no message on the channel", async () => {
    const w = await page();
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    findButton(w.root, "Plus rentable").click();
    await w.advance(300);
    expect(text(w)).toContain("Tes 4 derniers trajets");
    shown(w, "Demander à l’agent")[0]!.click();
    await w.advance(2 * SECOND);
    expect(w.host.log.messages.length).toBeGreaterThan(0);
    for (const m of w.host.log.messages) {
      const clean = NBSP_FREE(m);
      expect(clean).not.toMatch(/derniers trajets|réalisé|marge brute|74 %|14 %|0\.737/);
    }
    for (const c of w.host.log.contexts)
      expect(c).not.toMatch(/derniers trajets|réalisé|74 %|0\.737/);
    for (const posted of w.bus!.log) expect(JSON.stringify(posted.data)).not.toMatch(WIRE);
  });
});

describe("Feature: the tile 'Si tu refais ce trajet' prefers the player's own runs", () => {
  it("Given the balance is shown and a plan of a known route, Then the tile is the calibrated estimate with its sample size", async () => {
    const w = await page({ plan: true });
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const t = text(w);
    // 180 000 x 0.762
    expect(t).toMatch(/Si tu refais ce trajet\s*estimé · confiance moyenne\s*≈ \+137 160 aUEC/);
    expect(t).toContain("prévu × 76 % (net typique de tes 4 trajets sur cette route)");
    expect(t).not.toMatch(/Si tu refais ce trajet\s*estimé\s*≈ \+136 432/);
  });

  it("Given the balance is hidden, Then the tile shows no calibrated figure at all", async () => {
    const w = await page({ plan: true, always: true });
    const t = text(w);
    expect(t).not.toContain("137 160");
    expect(t).not.toContain("net typique de tes");
  });

  it("Given a plan of goods with no group, Then the card keeps its own figure", async () => {
    const w = await page({ plan: true });
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        structuredContent: {
          view: "sc_live_dashboard",
          plan: { ...PLAN, commodity: "Agricium", buy_terminal: "A", sell_terminal: "B" },
        },
      },
    });
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    expect(text(w)).not.toContain("net typique de tes");
    expect(text(w)).toMatch(/Si tu refais ce trajet\s*estimé\s*≈ \+136 432/);
  });
});
