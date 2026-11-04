/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import {
  sessionBarInfo,
  sessionIdleText,
  sessionNoticeText,
  sessionBarNormalize,
  sessionBarStripBalance,
  sessionChannelClean,
  sessionDetailNormalize,
  sessionListNormalize,
  sessionRowInfo,
  sessionStatsNormalize,
  sessionSummaryNormalize,
  sessionWhen,
  SESSION_VIEW_FUNCTIONS,
} from "./sessionPanel.js";
import { sessionBar, sessionToolAnswer } from "./testing/sessionScenario.js";
import { tradeLossCargo, tradeLossCause } from "./tradePreflight.js";
import { dashboardHtml, viewScript } from "./page.js";
import {
  FakeBus,
  VirtualClock,
  findAll,
  findButton,
  isShown,
  startPage,
  visibleText,
  type PageWorld,
} from "./testing/pageHarness.js";
import type { FakeNode } from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import * as L from "./viewLogic.js";

/**
 * Feature: the session bar. The pure part under Node, then the assembled page run as it ships against the fake host.
 * The data are the server's (made-up here); the View distrusts them and never draws money it was not allowed to.
 */

const NOW = Date.UTC(2026, 11, 1, 20, 0, 0);
const NB = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const MONEY_DIGITS = /250\D?000|434\D?500|184\D?500|579\D?000|63\D?700/;

describe("Feature: the View distrusts the payload", () => {
  it("Given anything that is not a version 1 bar, Then it is dropped", () => {
    for (const bad of [null, undefined, 3, "x", [], {}, { v: 2 }])
      expect(sessionBarNormalize(bad, true)).toBeNull();
  });

  it("Given hostile fields, Then they are repaired or removed", () => {
    const bar: any = sessionBarNormalize(
      {
        v: 1,
        status: "<script>",
        notice: "X".repeat(900),
        gap_hours: "3",
        stale: "yes",
        current: {
          ...(sessionBar(NOW, true).current as any),
          id: "<b>",
          number: 5,
          last_location: `Port\u202E${"A".repeat(500)}`,
          money: {
            net_auec: "12",
            start_balance_auec: 5,
            start_balance_quality: "weird",
            extra: 1,
          },
          extra: "x",
        },
      },
      true,
    );
    expect(bar.status).toBe("off");
    expect(bar.notice.length).toBeLessThanOrEqual(200);
    expect(bar.stale).toBe(false);
    expect(bar.gap_hours).toBe(3);
    expect(bar.current.id).toBe("");
    expect(bar.current.last_location.length).toBeLessThanOrEqual(60);
    expect(bar.current.last_location).not.toContain("\u202E");
    expect(bar.current.money.net_auec).toBeNull();
    expect(bar.current.money.start_balance_quality).toBeNull();
    expect(bar.current).not.toHaveProperty("extra");
  });

  it("Given money that is not allowed, Then no figure survives, even when the data holds one", () => {
    const rich = sessionBar(NOW, true);
    expect((sessionBarNormalize(rich, false) as any).current.money).toBeNull();
    expect((sessionBarNormalize(rich, true) as any).current.money.net_auec).toBe(184_500);
  });

  it("Given a bar for the channel, Then it is rebuilt and stripped of every aUEC figure, and cleaning again changes nothing", () => {
    const rich = sessionBar(NOW, true);
    const clean: any = sessionChannelClean(rich);
    expect(JSON.stringify(clean)).not.toMatch(MONEY_DIGITS);
    expect(clean.current.money).toBe("withheld");
    expect(clean.current.trips).toBe(6);
    expect(sessionChannelClean(clean)).toEqual(clean);
    for (const bad of [null, 4, "x", [], { v: 3 }]) expect(sessionChannelClean(bad)).toBeNull();
    const stripped: any = sessionBarStripBalance(rich);
    expect(JSON.stringify(stripped)).not.toMatch(MONEY_DIGITS);
  });

  it("Given list, stats and detail answers, Then they are rebuilt and the money obeys the choice", () => {
    const list: any = sessionListNormalize(
      sessionToolAnswer("sc_session_list", { include_balance: true }, NOW),
      true,
    );
    expect(list.sessions[0].number).toBe(4);
    expect(list.sessions[0].money.net_auec).toBe(184_500);
    const hidden: any = sessionListNormalize(
      sessionToolAnswer("sc_session_list", { include_balance: true }, NOW),
      false,
    );
    expect(JSON.stringify(hidden)).not.toMatch(MONEY_DIGITS);
    const stats: any = sessionStatsNormalize(
      sessionToolAnswer("sc_session_stats", { include_balance: true }, NOW),
      true,
    );
    expect(stats.money.trend.direction).toBe("up");
    const noStats: any = sessionStatsNormalize(
      sessionToolAnswer("sc_session_stats", { include_balance: true }, NOW),
      false,
    );
    expect(noStats.money).toBeNull();
    const detail: any = sessionDetailNormalize(
      sessionToolAnswer("sc_session_current", { id: "s_fixture_2", include_balance: true }, NOW),
      false,
    );
    expect(JSON.stringify(detail)).not.toMatch(/310\D?500|84\D?000|12\D?500/);
    for (const bad of [null, 3, {}, { sessions: "x" }]) {
      expect(sessionListNormalize(bad, true)).toBeNull();
      expect(sessionStatsNormalize(bad, true)).toBeNull();
    }
    expect(sessionSummaryNormalize({ number: 1 }, true)).toBeNull();
  });
});

describe("Feature: what the bar says first", () => {
  const info = (variant: any, show: boolean) =>
    sessionBarInfo(L, sessionBarNormalize(sessionBar(NOW, show, variant), show), {
      showBalance: show,
      now: NOW,
    });

  it("Given the balance is shown, Then the result comes first, then the rate, the trips and the time", () => {
    const i = info("story", true);
    expect(i.kpis.map((k: any) => k.id)).toEqual(["net", "rate", "trips", "time"]);
    expect(NB(i.kpis[0].value)).toBe("+184 500 aUEC");
    expect(i.kpis[0].tone).toBe("ok");
    expect(i.title).toBe("Session 4");
    expect(i.chip).toBe("en cours");
    expect(i.kpis[2].sub).toContain("autre contrat");
  });

  it("Given the balance is hidden, Then trips and time lead, and the result says it is hidden without a figure", () => {
    const i = info("story", false);
    expect(i.kpis.map((k: any) => k.id)).toEqual(["trips", "time", "net"]);
    expect(i.kpis[2].value).toBe("masqué");
    expect(JSON.stringify(i)).not.toMatch(MONEY_DIGITS);
  });

  it("Given no measured result but cargo runs, Then the gross margin is shown and called what it is", () => {
    const i = info("gross", true);
    expect(i.kpis[0].label).toBe("Marge brute des cargaisons");
    expect(i.kpis[0].sub).toContain("hors frais");
    expect(NB(i.kpis[0].value)).toBe("+61 250 aUEC");
    expect(i.notes.join(" ")).toContain("premier solde vu");
  });

  it("Given gross margins only and a contract left out because it overlaps a run, Then the total says it is partial", () => {
    const bar: any = sessionBar(NOW, true, "gross");
    bar.current.money.overlap_excluded = 2;
    const i = sessionBarInfo(L, sessionBarNormalize(bar, true), { showBalance: true, now: NOW });
    expect(i.kpis[0].label).toBe("Marge brute des cargaisons");
    expect(i.kpis[0].sub).toContain("hors frais");
    expect(i.kpis[0].sub).toContain("total partiel : 2 contrat(s) non compté(s)");
    // Without any overlap the line is unchanged.
    expect(info("gross", true).kpis[0].sub).not.toContain("partiel");
  });

  it("Given no session, a quiet one, an ended one, a read-only store and an off server, Then each is told straight", () => {
    expect(info("empty", true).empty).toBe(true);
    expect(info("stale", true).notes.join(" ")).toContain("nouvelle session");
    expect(info("stale", true).chip).toBe("inactive");
    expect(info("ended", true).chip).toBe("terminée");
    expect(info("ended", true).canEnd).toBe(false);
    expect(info("readonly", true).notes.join(" ")).toContain(
      "vient d’une version plus récente de ce serveur",
    );
    expect(info("readonly", true).notes.join(" ")).not.toMatch(/newer version|session file/);
    expect(info("off", true).visible).toBe(false);
    expect(sessionBarInfo(L, null, { showBalance: false, now: NOW }).visible).toBe(false);
  });

  it("Given the store's notices, Then the page says them in French and never prints the server's English", () => {
    const say = (status: string, notice: string | null) => sessionNoticeText({ status, notice });
    expect(
      say(
        "degraded",
        "Sessions could not be saved (EACCES); they are kept in memory and the next change tries again.",
      ),
    ).toBe(
      "Les sessions n’ont pas pu être enregistrées sur le disque : elles restent en mémoire et le prochain changement réessaiera.",
    );
    expect(say("readonly", "The session file is larger than expected and was not read.")).toContain(
      "plus gros que prévu",
    );
    expect(say("readonly", "The session file is not valid and could not be set aside.")).toContain(
      "pas pu être mis de côté",
    );
    expect(say("readonly", "anything else")).toBe(
      "Les sessions restent en mémoire : le fichier est en lecture seule.",
    );
    expect(
      say("ok", "The session file is not valid and will be set aside at the next change."),
    ).toBe("");
    for (const status of ["readonly", "degraded"])
      expect(say(status, "The session file is from a newer version (3)")).not.toMatch(
        /[A-Za-z]+ file|Sessions could/,
      );
  });

  it("Given a quiet session, Then the pill says for how long, and the notes of the pill name their cause", () => {
    const hours = (h: number) => ({
      last_activity_at: new Date(NOW - h * 3_600_000).toISOString(),
    });
    expect(sessionIdleText(hours(2), NOW)).toBe("inactive depuis 2\u00a0h");
    expect(sessionIdleText(hours(0.2), NOW)).toBe("inactive depuis 12\u00a0min");
    expect(sessionIdleText({}, NOW)).toBe("inactive");
    expect(sessionIdleText(hours(-1), NOW)).toBe("inactive");
    const line = (variant: any, show: boolean) =>
      NB(
        sessionBarInfo(
          { ...L, tradeLossCargo, tradeLossCause },
          sessionBarNormalize(sessionBar(NOW, show, variant), show),
          { showBalance: show, now: NOW },
        ).line,
      );
    // "inactive · note" told nothing: now the time, and which note
    expect(line("stale", false)).toContain("inactive depuis 3 h");
    expect(line("readonly", false)).toContain("fichier en lecture seule");
    expect(line("losses", true)).toContain("enregistrement impossible");
    expect(line("losses", true)).toContain("solde de départ approximatif");
    expect(line("losses", false)).not.toContain("solde de départ approximatif");
    expect(line("losses", true)).not.toMatch(/\bnote\b/);
  });

  it("Given an unknown rate, Then it is a dash with the reason, never zero", () => {
    const bar: any = sessionBar(NOW, true);
    bar.current.money.net_per_hour_auec = null;
    const i = sessionBarInfo(L, sessionBarNormalize(bar, true), { showBalance: true, now: NOW });
    expect(i.kpis[1].value).toBe("\u2014");
    expect(i.kpis[1].sub).toContain("10 min");
  });

  it("Given rows of the list, Then the result is shown only with the balance", () => {
    const s: any = sessionSummaryNormalize(sessionBar(NOW, true).current as any, true);
    const withMoney = sessionRowInfo(L, s, true, NOW);
    expect(NB(withMoney.result)).toContain("+184 500 aUEC");
    expect(sessionRowInfo(L, s, false, NOW).result).toBe("");
  });

  it("Given dates, Then they read as today, yesterday or a day", () => {
    const at = (d: Date) => d.toISOString();
    const noon = new Date(NOW);
    expect(sessionWhen(at(noon), NOW)).toMatch(/^aujourd’hui \d\d:\d\d$/);
    expect(sessionWhen(at(new Date(NOW - 86_400_000)), NOW)).toMatch(/^hier /);
    expect(sessionWhen(at(new Date(NOW - 5 * 86_400_000)), NOW)).toMatch(/^\d\d\/\d\d \d\d:\d\d$/);
    expect(sessionWhen("not a date", NOW)).toBe("");
  });
});

// ---------------------------------------------------------------------------------------------
// The assembled page
// ---------------------------------------------------------------------------------------------

const SECOND = 1000;
const text = (w: PageWorld) => NB(visibleText(w.root));

async function page(
  variant: any = "story",
  opts: { bus?: FakeBus | null; clock?: VirtualClock; scenario?: Scenario } = {},
) {
  const scenario = opts.scenario ?? new Scenario();
  const w = await startPage({
    scenario,
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.bus !== undefined ? { bus: opts.bus } : {}),
  });
  w.host.overrides.poll = (base: any, include: boolean) => ({
    ...base,
    sessions: sessionBar(scenario.epoch + scenario.t, include, variant),
  });
  w.host.overrides.tool = (name, args) =>
    sessionToolAnswer(name, args, scenario.epoch + scenario.t);
  return w;
}

describe("Feature: the bar in the page", () => {
  it("Given a session, When the page runs without the balance, Then the bar shows it with no money and a way to show the balance", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    const t = text(w);
    expect(t).toContain("Session 4");
    expect(t).toContain("en cours");
    expect(t).toContain("Trajets");
    // The menu of past sessions is closed until the player opens it: nothing of it is drawn.
    expect(t).not.toContain("Sessions passées");
    expect(t).not.toContain("Retour à la liste");
    expect(t).not.toContain("Terminer la session");
    expect(t).not.toMatch(MONEY_DIGITS);
    expect(isShown(findButton(w.root, "Nouvelle session"))).toBe(true);
    expect(w.host.log.polls.every((p) => p.includeBalance === false)).toBe(true);
  });

  it("Given the balance is shown, Then the money appears in the bar, and hiding it again removes it at once", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    const show = findAll(
      w.root,
      (n) => n.tag === "button" && n.textContent === "Afficher le solde",
    )[0] as FakeNode;
    show.click?.();
    await w.advance(3 * SECOND);
    expect(text(w)).toMatch(/\+184 500 aUEC/);
    findAll(
      w.root,
      (n) => n.tag === "button" && n.textContent === "Masquer le solde",
    )[0]?.click?.();
    await w.advance(100);
    expect(text(w)).not.toMatch(MONEY_DIGITS);
  });

  it("Given no session yet, Then the bar says so and the server is not asked for anything", async () => {
    const w = await page("empty");
    await w.advance(5 * SECOND);
    expect(text(w)).toContain("Aucune session");
    expect(w.host.log.tools).toEqual([]);
  });

  it("Given the server has sessions off, Then there is no bar at all", async () => {
    const w = await page("off");
    await w.advance(5 * SECOND);
    expect(text(w)).not.toContain("Nouvelle session");
  });

  it("Given 'Nouvelle session', Then the first click asks to confirm, the second calls the tool once and the bar is refreshed", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    const polls = w.host.log.polls.length;
    findButton(w.root, "Nouvelle session").click?.();
    await w.advance(100);
    expect(w.host.log.tools).toEqual([]);
    expect(text(w)).toContain("Confirmer : nouvelle session");
    findButton(w.root, "Confirmer : nouvelle session").click?.();
    await w.advance(500);
    expect(w.host.log.tools.map((t) => t.name)).toEqual(["sc_session_new"]);
    expect(w.host.log.polls.length).toBeGreaterThan(polls);
  });

  it("Given a failure of the tool, Then the player is told and nothing breaks", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    w.host.overrides.tool = () => new Error("the session file is busy");
    findButton(w.root, "Nouvelle session").click?.();
    findButton(w.root, "Confirmer : nouvelle session").click?.();
    await w.advance(500);
    expect(text(w)).toContain("Nouvelle session impossible");
  });

  it("Given the menu, Then it lists past sessions with their key numbers, and asks for money only when the balance is shown", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    findAll(
      w.root,
      (n) => n.tag === "button" && n.textContent.startsWith("Sessions"),
    )[0]?.click?.();
    await w.advance(500);
    const calls = w.host.log.tools.map((t) => `${t.name}:${t.args.include_balance}`);
    expect(calls).toEqual(["sc_session_list:false", "sc_session_stats:false"]);
    const t = text(w);
    expect(t).toContain("Sessions passées");
    expect(t).toContain("N° 3");
    expect(t).toContain("5 trajets");
    expect(t).not.toMatch(MONEY_DIGITS);
    expect(t).toContain("Montants masqués");
  });

  it("Given a past session is opened, Then its detail is read-only: balance, trips and breaks, from the server", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    findAll(
      w.root,
      (n) => n.tag === "button" && n.textContent.startsWith("Sessions"),
    )[0]?.click?.();
    await w.advance(500);
    findAll(
      w.root,
      (n) => n.tag === "button" && n.attrs["aria-label"]?.startsWith("Ouvrir la session 2"),
    )[0]?.click?.();
    await w.advance(500);
    expect(w.host.log.tools.at(-1)).toMatchObject({
      name: "sc_session_current",
      args: { id: "s_fixture_2", include_balance: false },
    });
    const t = text(w);
    expect(t).toContain("Session 2 (terminée)");
    expect(t).toContain("sans marqueur de fin");
    expect(t).toContain("Waste Disposal | Easy");
    expect(t).not.toMatch(/310\D?500|84\D?000/);
    expect(isShown(findButton(w.root, "Retour à la liste"))).toBe(true);
  });

  it("Given the balance is shown while the menu is open, Then the menu is fetched again with the balance and shows the statistics", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    findAll(
      w.root,
      (n) => n.tag === "button" && n.textContent.startsWith("Sessions"),
    )[0]?.click?.();
    await w.advance(500);
    findAll(
      w.root,
      (n) => n.tag === "button" && n.textContent === "Afficher le solde",
    )[0]?.click?.();
    await w.advance(3 * SECOND);
    const last = w.host.log.tools.filter((t) => t.args.include_balance === true).map((t) => t.name);
    expect(last).toEqual(["sc_session_list", "sc_session_stats"]);
    const t = text(w);
    expect(t).toContain("Tendance : en hausse");
    expect(t).toContain("Meilleure : N° 2");
  });

  it("Given 'Terminer', Then it needs a confirmation and calls sc_session_end once", async () => {
    const w = await page();
    await w.advance(5 * SECOND);
    findAll(
      w.root,
      (n) => n.tag === "button" && n.textContent.startsWith("Sessions"),
    )[0]?.click?.();
    await w.advance(500);
    findButton(w.root, "Terminer la session").click?.();
    await w.advance(50);
    expect(w.host.log.tools.some((t) => t.name === "sc_session_end")).toBe(false);
    findButton(w.root, "Confirmer la fin").click?.();
    await w.advance(500);
    expect(w.host.log.tools.filter((t) => t.name === "sc_session_end")).toHaveLength(1);
  });

  it("Given the page, Then the markup rules hold: text only through textContent, no session data in the browser's storage", () => {
    const script = viewScript();
    // The only thing the page remembers is the health strip's "legend read" flag (see viewPage.test.ts); sessions never.
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|sessionStorage|indexedDB/);
    // The session code does not touch any storage, and is given no way to: its api has no get / set.
    for (const f of SESSION_VIEW_FUNCTIONS)
      expect(f.toString(), f.name).not.toMatch(/localStorage|Storage|api\.(get|set)\b/);
    expect(dashboardHtml()).toContain("Session");
  });
});

describe("Feature: two Views of one conversation show the same session, without money on the channel", () => {
  it("Given a leader that shows the balance, Then the follower shows the session and no figure", async () => {
    const scenario = new Scenario();
    const clock = new VirtualClock(scenario.epoch);
    const bus = new FakeBus();
    const a = await page("story", { bus, clock, scenario });
    await clock.advance(50);
    const b = await page("story", { bus, clock, scenario });
    await clock.advance(5 * SECOND);
    // b is the leader (most recent). It shows the balance.
    findAll(
      b.root,
      (n) => n.tag === "button" && n.textContent === "Afficher le solde",
    )[0]?.click?.();
    await clock.advance(4 * SECOND);
    expect(text(b)).toMatch(/\+184 500 aUEC/);
    expect(text(a)).toContain("Session 4");
    expect(text(a)).not.toMatch(MONEY_DIGITS);
  });
});
