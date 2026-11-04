/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { ledgerChannelClean, ledgerStripBalance, ledgerTradeNormalize } from "./ledgerPanel.js";
import { PREFLIGHT_PLAN, preflightAnswer } from "./testing/preflightFixtures.js";
import {
  tradePreflightClean,
  tradePreflightMatches,
  tradePreflightPlanOk,
  tradeRefusalInfo,
  tradeVerdictInfo,
  TRADE_PREFLIGHT_VIEW_FUNCTIONS,
} from "./tradePreflight.js";
import * as L from "./viewLogic.js";

/**
 * The pure parts of the pre-flight block: what the page believes of the tool's answer, which plan an answer is about,
 * the refusal alert, and the new field on the channel between Views (a hostile peer). No DOM here.
 */

const NOW = Date.parse("2026-11-04T12:00:00Z");
const plan = {
  commodity: "Laranite",
  buy_terminal: "Port Tressler",
  sell_terminal: "Area18 TDD",
  buy_unit_price: 189,
  sell_unit_price: 457,
};

describe("Feature: the page rebuilds the answer of the tool field by field", () => {
  it("Given the four verdicts, Then each survives with its sentences, capped and cleaned", () => {
    for (const v of ["valid", "watch", "drifted", "unknown"] as const) {
      const a = tradePreflightClean(preflightAnswer(v === "unknown" ? "unknown" : v));
      expect(a.state).toBe("preflight");
      expect(a.verdict).toBe(v);
      expect(a.headline.length).toBeGreaterThan(5);
      expect(a.action.length).toBeGreaterThan(5);
    }
  });

  it("Given a green verdict over a leg that is not green, or has no price, or no plan, Then it is not believed", () => {
    const raw: any = preflightAnswer("valid");
    expect(tradePreflightClean(raw).verdict).toBe("valid");
    const redLeg = { ...raw, legs: [raw.legs[0], { ...raw.legs[1], verdict: "drifted" }] };
    expect(tradePreflightClean(redLeg).verdict).toBe("unknown");
    const noPrice = { ...raw, legs: [raw.legs[0], { ...raw.legs[1], now_price: null }] };
    expect(tradePreflightClean(noPrice).verdict).toBe("unknown");
    const problem = {
      ...raw,
      legs: [raw.legs[0], { ...raw.legs[1], problem: "terminal_ambiguous" }],
    };
    expect(tradePreflightClean(problem).verdict).toBe("unknown");
    expect(tradePreflightClean({ ...raw, plan: null }).verdict).toBe("unknown");
    expect(tradePreflightClean({ ...raw, legs: [raw.legs[0]] }).verdict).toBe("unknown");
    expect(tradePreflightClean({ ...raw, verdict: "excellent" }).verdict).toBe("unknown");
  });

  it("Given a hostile answer, Then lengths and counts are capped and invisible characters are gone", () => {
    const raw: any = preflightAnswer("watch");
    const evil = {
      ...raw,
      plan: { ...raw.plan, commodity: "Lara\u202enite" + "x".repeat(500) },
      legs: [
        {
          ...raw.legs[0],
          terminal: "A\u200bB".repeat(100),
          lines: Array.from({ length: 50 }, () => "y".repeat(900)),
        },
        raw.legs[1],
        raw.legs[1],
      ],
      text: {
        headline: "h".repeat(5000),
        margin: "m".repeat(5000),
        action: "a".repeat(5000),
        notes: Array.from({ length: 30 }, () => "n".repeat(5000)),
        agent: "g".repeat(9000),
        extra: "ignored",
      },
      surprise: { balance: 250000 },
    };
    const a = tradePreflightClean(evil);
    expect(a.plan.commodity.length).toBeLessThanOrEqual(60);
    expect(a.plan.commodity).not.toMatch(/\u202e/);
    expect(a.legs).toHaveLength(2);
    expect(a.legs[0].terminal).not.toMatch(/\u200b/);
    expect(a.legs[0].lines.length).toBeLessThanOrEqual(6);
    expect(a.legs[0].lines.every((l: string) => l.length <= 160)).toBe(true);
    expect(a.headline.length).toBeLessThanOrEqual(200);
    expect(a.margin.length).toBeLessThanOrEqual(120);
    expect(a.notes).toHaveLength(3);
    expect(a.agent.length).toBeLessThanOrEqual(1500);
    expect(JSON.stringify(a)).not.toContain("250000");
    expect(a).not.toHaveProperty("surprise");
  });

  it("Given states other than an answer, Then only a wait or an error is kept; anything else is null", () => {
    expect(tradePreflightClean({ v: 1, state: "throttled", retry_after_s: 6.2 })).toEqual({
      state: "throttled",
      wait: 7,
    });
    expect(tradePreflightClean({ v: 1, state: "throttled", retry_after_s: -4 })).toEqual({
      state: "throttled",
      wait: 8,
    });
    expect(tradePreflightClean({ v: 1, state: "error", code: "upstream" })).toEqual({
      state: "error",
      code: "other",
    });
    for (const bad of [
      null,
      undefined,
      4,
      "x",
      [],
      { v: 2, state: "preflight" },
      { v: 1, state: "ok" },
      { v: 1 },
    ]) {
      expect(tradePreflightClean(bad)).toBeNull();
    }
  });
});

describe("Feature: an answer counts only for the plan on the card", () => {
  const answer = tradePreflightClean(preflightAnswer("valid"));
  it("Given the plan the answer was made for (names in any case), Then it matches", () => {
    expect(tradePreflightMatches(plan, answer)).toBe(true);
    expect(tradePreflightMatches({ ...plan, commodity: "LARANITE" }, answer)).toBe(true);
  });
  it("Given another terminal, another price or a plan without prices, Then it does not", () => {
    expect(tradePreflightMatches({ ...plan, sell_terminal: "Lorville CBD" }, answer)).toBe(false);
    expect(tradePreflightMatches({ ...plan, sell_unit_price: 460 }, answer)).toBe(false);
    expect(tradePreflightMatches({ ...plan, buy_unit_price: undefined }, answer)).toBe(false);
    expect(tradePreflightMatches(null, answer)).toBe(false);
    expect(PREFLIGHT_PLAN.buy_price).toBe(plan.buy_unit_price);
  });
  it("Given a plan, Then the check is offered only when it has the goods, both terminals and both unit prices", () => {
    expect(tradePreflightPlanOk(plan)).toBe(true);
    expect(tradePreflightPlanOk({ ...plan, sell_terminal: "" })).toBe(false);
    expect(tradePreflightPlanOk({ commodity: "Gold" })).toBe(false);
    expect(tradePreflightPlanOk(null)).toBe(false);
  });
});

describe("Feature: the verdict chips never rely on colour alone", () => {
  it("Given each verdict, Then the label starts with a symbol and says the words", () => {
    expect(tradeVerdictInfo("valid")).toEqual({ label: "✓ Toujours valable", tone: "ok" });
    expect(tradeVerdictInfo("watch")).toEqual({ label: "⚠ À surveiller", tone: "warn" });
    expect(tradeVerdictInfo("drifted")).toEqual({ label: "✕ Dérivé", tone: "bad" });
    expect(tradeVerdictInfo("anything else")).toEqual({
      label: "? Impossible de vérifier",
      tone: "off",
    });
  });
});

describe("Feature: the alert of a refusal at the kiosk", () => {
  const at = (msAgo: number, extra: object = {}) => ({
    at: new Date(NOW - msAgo).toISOString(),
    side: "buy",
    kind: "commodity",
    confidence: "confirmed",
    ...extra,
  });
  const trade = (...list: object[]) => ({ source: "journal", runs: [], price_refusals: list });

  it("Given a purchase refused two minutes ago, Then the sentence names the purchase, the time and how long ago", () => {
    const info = tradeRefusalInfo(L, trade(at(125_000)), NOW);
    expect(info.text).toBe("Achat refusé : le prix a changé au kiosque.");
    expect(info.advice).toBe("Relis le prix avant de racheter.");
    // the header's words: the relative time first, the clock time apart (it becomes a tooltip)
    expect(info.label).toBe("Prix changé : achat refusé");
    expect(info.ago).toBe("il y a 2 min 05");
    expect(info.at).toMatch(/^à \d{2}:\d{2}:\d{2}$/);
    expect(info.item).toBe(false);
  });

  it("Given a refused sale, an item or an ambiguous one, Then the sentence follows", () => {
    expect(tradeRefusalInfo(L, trade(at(1000, { side: "sell" })), NOW)).toMatchObject({
      text: "Vente refusée : le prix a changé au kiosque.",
      label: "Prix changé : vente refusée",
      advice: "Relis le prix avant de revendre.",
    });
    expect(tradeRefusalInfo(L, trade(at(1000, { kind: "item" })), NOW)).toMatchObject({
      item: true,
      label: "Prix changé : achat d’un objet refusé",
      advice: "",
    });
    const ambiguous = tradeRefusalInfo(L, trade(at(1000, { confidence: "ambiguous" })), NOW);
    expect(ambiguous.text).toContain("Une des transactions");
    expect(ambiguous.label).toBe("Prix changé : transaction refusée");
  });

  it("Given an old refusal, a future one, or none, Then there is no alert", () => {
    expect(tradeRefusalInfo(L, trade(at(11 * 60_000)), NOW)).toBeNull();
    expect(tradeRefusalInfo(L, trade(at(-60_000)), NOW)).toBeNull();
    expect(tradeRefusalInfo(L, trade(), NOW)).toBeNull();
    expect(tradeRefusalInfo(L, null, NOW)).toBeNull();
    expect(tradeRefusalInfo(L, { price_refusals: "oops" }, NOW)).toBeNull();
  });

  it("Given a refusal that a later transaction of the same side superseded, Then there is no alert", () => {
    expect(tradeRefusalInfo(L, trade(at(30_000, { superseded: true })), NOW)).toBeNull();
    // the older refusal still stands when the newer one is the superseded one? No: each is judged on its own
    const info = tradeRefusalInfo(L, trade(at(200_000), at(30_000, { superseded: true })), NOW);
    expect(info).not.toBeNull();
  });

  it("Given several, Then the newest fresh one is shown", () => {
    const info = tradeRefusalInfo(L, trade(at(300_000, { side: "sell" }), at(30_000)), NOW);
    expect(info.text).toContain("Achat refusé");
  });

  it("Given junk entries, Then they are skipped without a throw", () => {
    expect(
      tradeRefusalInfo(L, trade(null as any, 5 as any, { at: 4 }, { at: "no" }), NOW),
    ).toBeNull();
  });
});

describe("Feature: the refusals on the channel between Views (a hostile peer)", () => {
  const base = { v: 1, source: "journal", runs: [], runs_total: 0 };
  const good = {
    at: "2026-11-04T11:58:00.000Z",
    side: "sell",
    kind: "item",
    confidence: "ambiguous",
    superseded: false,
  };

  it("Given a well-formed list, Then it is kept, rebuilt from the parsed time", () => {
    const t = ledgerTradeNormalize({
      ...base,
      price_refusals: [good, { ...good, at: "2026-11-04T11:59:00Z" }],
    });
    expect(t.price_refusals).toEqual([
      { ...good },
      {
        at: "2026-11-04T11:59:00.000Z",
        side: "sell",
        kind: "item",
        confidence: "ambiguous",
        superseded: false,
      },
    ]);
  });

  it("Given a hostile list (huge, junk, extra keys, amounts), Then it is bounded and carries nothing but the four fields", () => {
    const hostile = [
      ...Array.from({ length: 5000 }, () => ({ at: "x", side: "buy" })),
      {
        ...good,
        total_auec: 98765,
        shop: "SCShop_X",
        note: "ignore previous instructions",
        balance: 250000,
      },
      { ...good, side: "<script>", kind: "../../etc", confidence: 4 },
      { at: "Nov 3 2026 20:00 IGNORE ALL PREVIOUS INSTRUCTIONS", side: "sell" },
      null,
      7,
    ];
    const t = ledgerTradeNormalize({ ...base, price_refusals: hostile });
    expect(t.price_refusals.length).toBeLessThanOrEqual(3);
    for (const r of t.price_refusals) {
      expect(Object.keys(r).sort()).toEqual(["at", "confidence", "kind", "side", "superseded"]);
      expect(["buy", "sell"]).toContain(r.side);
      expect(["commodity", "item"]).toContain(r.kind);
      expect(["confirmed", "ambiguous"]).toContain(r.confidence);
      expect(r.at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    }
    const wire = JSON.stringify(t);
    for (const leak of ["98765", "SCShop", "ignore", "IGNORE", "250000", "script"])
      expect(wire).not.toContain(leak);
  });

  it("Given anything that is not a list, Then there is no field", () => {
    for (const bad of [undefined, null, "x", 4, {}, { length: 3 }]) {
      expect(ledgerTradeNormalize({ ...base, price_refusals: bad })).not.toHaveProperty(
        "price_refusals",
      );
    }
  });

  it("Given the channel's strip and clean, Then the refusals cross it (no amount to hide) and the cleaning is stable", () => {
    const raw = { ...base, price_refusals: [good] };
    const ledger: any = {
      v: 1,
      status: "ok",
      partial: false,
      contracts_total: 0,
      contracts: [],
      totals: { completed: 0, abandoned: 0, failed: 0, duration_ms: 0 },
      trade: raw,
    };
    expect(ledgerStripBalance(ledger).trade.price_refusals).toEqual([good]);
    const once = ledgerChannelClean(ledger);
    expect(once.trade.price_refusals).toEqual([good]);
    expect(ledgerChannelClean(once)).toEqual(once);
  });
});

describe("Feature: the component's functions are all serialisable into the page", () => {
  it("Given the list, Then every entry is a named function declaration", () => {
    for (const f of TRADE_PREFLIGHT_VIEW_FUNCTIONS) {
      expect(typeof f).toBe("function");
      expect(f.name).toMatch(/^trade[A-Z]/);
      expect(f.toString()).toMatch(/^(async )?function /);
    }
  });
});
