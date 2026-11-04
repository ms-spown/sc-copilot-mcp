/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import {
  tradePastFacts,
  tradePastLabel,
  tradePastLine,
  tradeSessionScope,
  tradeSplitBySession,
  tradeWhen,
} from "./tradePanel.js";
import * as L from "./viewLogic.js";

/** The rule that keeps a run of an older play session from reading as a result of the current one. */

const HOUR = 3_600_000;
const NOW = new Date(2026, 10, 4, 15, 0, 0).getTime(); // local time, as the page reads it
const at = (ms: number) => new Date(ms).toISOString();
const run = (id: string, startMs: number, endMs: number, extra: Record<string, unknown> = {}) => ({
  id,
  commodity: "Waste",
  commodity_name: "Waste",
  more_commodities: [],
  buy_shops: ["Admin lt base g"],
  sell_shops: ["Admin lt base g"],
  stage: "complete",
  started_at: at(startMs),
  ended_at: at(endMs),
  duration_ms: endMs - startMs,
  scu_bought: 696,
  scu_sold: 696,
  prior_stock_scu: 0,
  buys: 1,
  sells: 1,
  failed: 0,
  uncertain: 0,
  ignored: 0,
  money: null,
  ...extra,
});
const section = (...runs: any[]) => ({
  v: 1,
  source: "journal",
  runs,
  runs_total: runs.length,
  ship_losses: [{ run_id: "x" }],
});

describe("Feature: which runs of the journal are of the play session", () => {
  const yesterday = run("old", NOW - 20 * HOUR, NOW - 19.5 * HOUR);
  const recent = run("new", NOW - 30 * 60_000, NOW - 10 * 60_000);
  const scope = (startMsAgo: number, endMsAgo?: number) => ({
    known: true,
    start: NOW - startMsAgo,
    end: endMsAgo === undefined ? null : NOW - endMsAgo,
  });

  it("Given a session that began after the last transaction, Then the run is outside it", () => {
    const s = section(yesterday);
    const split = tradeSplitBySession(s, scope(5 * 60_000), NOW);
    expect(split.trade.runs).toEqual([]);
    expect(split.past).toEqual([yesterday]);
    // The section it came from is untouched.
    expect(s.runs).toEqual([yesterday]);
  });

  it("Given a session that began before the run, Then nothing is set apart and the same section comes back", () => {
    const s = section(recent);
    const split = tradeSplitBySession(s, scope(2 * HOUR), NOW);
    expect(split.trade).toBe(s);
    expect(split.past).toEqual([]);
  });

  it("Given a new session begun in the middle of a run, Then the run is still the session's (its last transaction is after)", () => {
    const split = tradeSplitBySession(section(recent), scope(20 * 60_000), NOW);
    expect(split.trade.runs).toEqual([recent]);
  });

  it("Given both an old and a recent run, Then they are split, newest first, and the rest of the section stays", () => {
    const s = section(recent, yesterday);
    const split = tradeSplitBySession(s, scope(HOUR), NOW);
    expect(split.trade.runs).toEqual([recent]);
    expect(split.past).toEqual([yesterday]);
    expect(split.trade.ship_losses).toBe(s.ship_losses);
    expect(split.trade.runs_total).toBe(2);
  });

  it("Given an ended session, Then a run that began after its end is outside it", () => {
    const split = tradeSplitBySession(section(recent), scope(3 * HOUR, 2 * HOUR), NOW);
    expect(split.past).toEqual([recent]);
  });

  it("Given a bar with no session in it, Then the scope is unknown and the age decides", () => {
    const scopeOf = tradeSessionScope({ sessions: { v: 1, status: "ok", current: null } });
    expect(scopeOf).toEqual({ known: false });
    const split = tradeSplitBySession(section(recent, yesterday), scopeOf, NOW);
    expect(split.trade.runs).toEqual([recent]);
    expect(split.past).toEqual([yesterday]);
  });

  it("Given an unfinished run whose last transaction is before the session's start, Then it is still the trip under way", () => {
    const open = run("open", NOW - 2 * HOUR, NOW - 90 * 60_000, { stage: "open" });
    const partial = run("part", NOW - 2 * HOUR, NOW - 90 * 60_000, { stage: "partial" });
    for (const r of [open, partial]) {
      const split = tradeSplitBySession(section(r), scope(10 * 60_000), NOW);
      expect(split.trade.runs).toEqual([r]);
      expect(split.past).toEqual([]);
    }
    // the same times, finished: outside the session
    const done = run("done", NOW - 2 * HOUR, NOW - 90 * 60_000, { stage: "complete" });
    expect(tradeSplitBySession(section(done), scope(10 * 60_000), NOW).past).toEqual([done]);
  });

  it("Given an unfinished run left over 3 hours ago, or begun after the session's end, Then it is outside", () => {
    const left = run("left", NOW - 5 * HOUR, NOW - 4 * HOUR, { stage: "open" });
    expect(tradeSplitBySession(section(left), scope(10 * 60_000), NOW).past).toEqual([left]);
    const later = run("later", NOW - 30 * 60_000, NOW - 20 * 60_000, { stage: "open" });
    expect(tradeSplitBySession(section(later), scope(3 * HOUR, HOUR), NOW).past).toEqual([later]);
  });

  it("Given sessions are off, Then only a run over 3 hours old is outside; the connection does not decide", () => {
    const off = { known: false };
    expect(tradeSplitBySession(section(recent), off, NOW).past).toEqual([]);
    expect(tradeSplitBySession(section(yesterday), off, NOW).past).toEqual([yesterday]);
    expect(tradeSplitBySession(section(yesterday, recent), undefined, NOW).trade.runs).toEqual([
      recent,
    ]);
  });

  it("Given no journal, or a run without a usable time, Then nothing is moved", () => {
    expect(tradeSplitBySession(null, scope(HOUR), NOW)).toEqual({ trade: null, past: [] });
    const none = { v: 1, source: "none", runs: [], runs_total: 0 };
    expect(tradeSplitBySession(none, scope(HOUR), NOW).trade).toBe(none);
    const odd = run("odd", NOW, NOW, { ended_at: "garbage" });
    expect(tradeSplitBySession(section(odd), scope(5 * 60_000), NOW).past).toEqual([]);
  });

  it("Given the poll's session bar, Then the scope reads its start and end", () => {
    const bar = (extra: any) => ({ sessions: { v: 1, status: "ok", ...extra } });
    expect(tradeSessionScope({})).toEqual({ known: false });
    expect(tradeSessionScope(bar({ status: "off", current: null }))).toEqual({ known: false });
    expect(tradeSessionScope(bar({ current: null }))).toEqual({ known: false });
    expect(
      tradeSessionScope(bar({ current: { started_at: at(NOW - HOUR), ended_at: null } })),
    ).toEqual({ known: true, start: NOW - HOUR, end: null, ended: false });
    expect(
      tradeSessionScope(bar({ current: { started_at: at(NOW - HOUR), ended_at: at(NOW - 1000) } })),
    ).toEqual({ known: true, start: NOW - HOUR, end: NOW - 1000, ended: true });
    expect(tradeSessionScope(bar({ current: { started_at: "nope" } }))).toEqual({ known: false });
  });
});

describe("Feature: how the older run is worded", () => {
  const FR = L as any;
  const Lx = { ...FR, shopWords: (s: string) => s || "" };
  const old = run("old", NOW - 20 * HOUR, NOW - 20 * HOUR + 24 * 60_000 + 25_000);

  it("Given dates, Then today, yesterday or the day are said with the local clock", () => {
    const p = (n: number) => (n < 10 ? "0" + n : String(n));
    const d = new Date(NOW - 20 * HOUR);
    const clock = p(d.getHours()) + ":" + p(d.getMinutes());
    expect(tradeWhen(at(NOW - 60_000), NOW)).toMatch(/^aujourd’hui \d{2}:\d{2}$/);
    expect(tradeWhen(at(NOW - 20 * HOUR), NOW)).toBe("hier " + clock);
    expect(tradeWhen(at(NOW - 5 * 24 * HOUR), NOW).replace(/\u00a0/g, " ")).toMatch(
      /^\d{1,2} (janv\.|févr\.|mars|avr\.|mai|juin|juil\.|août|sept\.|oct\.|nov\.|déc\.) \d{2}:\d{2}$/,
    );
    expect(tradeWhen("garbage", NOW)).toBe("");
    expect(tradeWhen(undefined, NOW)).toBe("");
    // without a clock the date is spelled out
    expect(tradeWhen(at(NOW - 60_000), undefined)).toMatch(/^\d{1,2}\u00a0nov\. \d{2}:\d{2}$/);
  });

  it("Given the older run, Then the label, the facts and the compact line say it is outside the session", () => {
    expect(tradePastLabel(old, NOW)).toMatch(
      /^Dernier trajet connu · .+ \d{2}:\d{2}, hors session$/,
    );
    const facts = tradePastFacts(Lx, old).replace(/\u00a0/g, " ");
    expect(facts).toContain("Waste");
    expect(facts).toContain("696 SCU");
    expect(facts).toContain("durée 24 min 25 s");
    expect(facts).toContain("trajet terminé");
    expect(tradePastLine(Lx, [old], NOW).replace(/\u00a0/g, " ")).toMatch(
      /^Hors session · dernier trajet connu : Waste, .+ \d{2}:\d{2}$/,
    );
    expect(tradePastLine(Lx, [], NOW)).toBe("");
    // An unfinished run is said so, not as a trip under way.
    const open = run("o", NOW - 20 * HOUR, NOW - 20 * HOUR, { stage: "open", duration_ms: 0 });
    expect(tradePastFacts(Lx, open)).toContain("non terminé");
    expect(tradePastFacts(Lx, open)).not.toContain("en cours");
  });
});
