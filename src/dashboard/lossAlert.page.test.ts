/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
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
import { TRADE_ACTIONS_CSS } from "./tradeActionsStyles.js";
import { TRADE_PREFLIGHT_CSS } from "./tradePreflightStyles.js";
import { VIEW_CSS } from "./viewStyles.js";
import { tradeBalanceAt, tradeLedger } from "./testing/tradeScenario.js";

/**
 * The ship loss as the gravest event of the dashboard, and the "Ask Claude" button that follows the situation, in the
 * assembled page against the fake host. Every new string is checked with the balance hidden AND shown: the amount paid for
 * the lost cargo (10 581 aUEC here) appears on the page only when shown, and in no message ever.
 */

const SECOND = 1000;
const NBSP_FREE = (s: string) =>
  s.replace(new RegExp("[" + String.fromCharCode(160, 0x202f) + "]", "g"), " ");
const PAID = /(?<![\d.])10\D?581(?!\d)/;

const fullscreen = async (w: PageWorld) => {
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: { displayMode: "fullscreen" },
  });
  await w.advance(100);
};

interface Options {
  /** The page starts with the amounts shown (the server's default), else hidden (the harness default). */
  shown?: boolean;
  lossAgoMs?: number | null;
  /** A second, older loss. */
  olderLossAgoMs?: number;
  /** Which run (0 = the newest) the loss is tied to. Default 0. */
  lossRun?: number;
  refusalAgoMs?: number;
  /** Kind of the refused price (default commodity). */
  refusalKind?: "commodity" | "item";
  /** The trade story variant (tradeScenario.ts): "partial" is a run still open, "story" a run complete, "second" two runs. */
  stage?: "partial" | "story" | "second";
  cause?: "collision" | "combat";
  causer?: "npc" | "other" | "unknown";
  noRun?: boolean;
  /** The second of the story the page is read at (default 215). */
  atSeconds?: number;
  /** What Game.log says about the connection. */
  conn?: "disconnected" | "menu" | "closed";
  /** Force a stream state. */
  forced?: "off" | "waiting";
}

async function page(opts: Options = {}) {
  const scenario = new Scenario();
  scenario.uec = tradeBalanceAt;
  // Made-up times are fixed on the story (not moving with every poll), so a status line can be compared 5 s later.
  const AT = scenario.epoch + (opts.atSeconds ?? 215) * SECOND;
  scenario.ledger = (include, nowMs) => {
    const l: any = tradeLedger(nowMs, scenario.epoch, include, opts.stage ?? "partial");
    const run = l.trade.runs[opts.lossRun ?? 0];
    const loss = (agoMs: number) => ({
      at: new Date(AT - agoMs).toISOString(),
      ship_class: "MISC_Hull_C",
      cause: opts.cause ?? "combat",
      causer: opts.causer ?? "other",
      zone: "OOC_Stanton_3a_Lyria",
      cargo_scu: 56,
      cargo_buys: 1,
      unconfirmed_buys: 1,
      unconfirmed_sells: 0,
      run_id: opts.noRun ? null : run.id,
      ...(include ? { paid_auec: 10_581 } : {}),
    });
    if (opts.lossAgoMs !== null && opts.lossAgoMs !== undefined) {
      l.trade.ship_losses = [
        ...(opts.olderLossAgoMs !== undefined ? [loss(opts.olderLossAgoMs)] : []),
        loss(opts.lossAgoMs),
      ];
    }
    if (opts.refusalAgoMs !== undefined)
      l.trade.price_refusals = [
        {
          at: new Date(AT - opts.refusalAgoMs).toISOString(),
          side: "sell",
          kind: opts.refusalKind ?? "commodity",
          confidence: "confirmed",
          superseded: false,
        },
      ];
    return l;
  };
  if (opts.conn)
    scenario.connection = {
      state: opts.conn,
      since: new Date(AT - 185_000).toISOString(),
      code: null,
      reason: null,
    };
  if (opts.forced) scenario.forced = opts.forced;
  const w = await startPage({ scenario, balanceHidden: opts.shown ? false : true });
  w.fromHost({
    jsonrpc: "2.0",
    method: "ui/notifications/tool-result",
    params: { structuredContent: { view: "sc_live_dashboard" } },
  });
  await w.advance((opts.atSeconds ?? 215) * SECOND);
  return w;
}

const compactLine = (w: PageWorld) =>
  findAll(w.root, (n) => n.className === "lg-line pf-line" && isShown(n))[0];
const verdict = (w: PageWorld) => findAll(w.root, (n) => n.className === "verdict")[0]!;
const lossBoxes = (w: PageWorld) => findAll(w.root, (n) => n.className === "pf-loss" && isShown(n));
const folds = (w: PageWorld) =>
  findAll(w.root, (n) => n.tag === "details" && n.className === "pf-why" && isShown(n));
const asks = (w: PageWorld) =>
  findAll(
    w.root,
    (n) => n.tag === "button" && isShown(n) && /^(Analyser|Que faire|Debrief)/.test(n.textContent),
  );

for (const shown of [false, true]) {
  const mode = shown ? "amounts shown" : "amounts hidden";

  describe(`Feature: a ship lost is the gravest event of the dashboard (${mode})`, () => {
    it("Given a fresh loss in the compact view, Then the header has the top tone, two lines say what happened and the cargo, and the doubts are folded", async () => {
      const w = await page({ shown, lossAgoMs: 31 * SECOND });
      expect(verdict(w).attrs["data-tone"]).toBe("fatal");
      expect(NBSP_FREE(verdict(w).textContent)).toMatch(/^Vaisseau détruit · il y a \d+ s/);
      const line = compactLine(w)!;
      expect(line.attrs["data-tone"]).toBe("fatal");
      const said = NBSP_FREE(line.textContent);
      const [first, second, ...rest] = said.split("\n");
      expect(rest).toEqual([]);
      expect(first).toMatch(
        /^Vaisseau détruit à \d{2}:\d{2}:\d{2}, joueur à bord \(MISC Hull C\) : combat\.$/,
      );
      expect(second).toContain("Cargo présumé perdu : 56 SCU");
      // the developer jargon and the doubts are not in the two lines
      expect(said).not.toMatch(/d’après le nom|non journalisé|non vérifiée|builds 2025|il y a/);
      if (shown) expect(second).toMatch(PAID);
      else expect(said).not.toMatch(PAID);
      // the doubts: one fold, closed, reachable by keyboard (a native details/summary), holding every caution
      const fold = folds(w);
      expect(fold).toHaveLength(1);
      const summary = fold[0]!.children.find((c) => c.tag === "summary")!;
      expect(summary.textContent).toBe("Pourquoi ce n’est pas certain ?");
      expect(fold[0]!.attrs["open"]).toBeUndefined();
      const why = NBSP_FREE(fold[0]!.textContent);
      expect(why).toContain("Propriété du vaisseau non vérifiée.");
      expect(why).toContain(
        "Valeur perdue, suite donnée à l’assurance, coût de remplacement et responsable : non journalisés.",
      );
      expect(why).toContain("builds 2025 seulement");
      expect(why).toContain(
        "Responsable d’après la forme du nom : un autre joueur ou une entité inconnue.",
      );
      expect(why).toContain("1 achat(s) non confirmé(s) ne sont pas comptés.");
      expect(why).not.toMatch(PAID);
    });

    it("Given a fresh loss, Then 'Et maintenant' holds facts only: the run cut, a new session or run may begin; nothing about the insurance, a value or a culprit", async () => {
      const w = await page({ shown, lossAgoMs: 31 * SECOND });
      const box = lossBoxes(w)[0]!;
      const t = NBSP_FREE(box.textContent);
      expect(t).toContain("Et maintenant");
      expect(t).toContain("Le trajet interrompu par la perte ne sera pas terminé.");
      expect(t).toContain(
        "Une nouvelle session ou un nouveau trajet peut commencer quand tu veux.",
      );
      // the claim is not on the page (the dashboard does not receive it without the balance): neither "seen" nor "none seen"
      expect(NBSP_FREE(visibleText(w.root))).not.toMatch(/réclamation|aucune? .*vue?/i);
      // ... but the fold says, as a doubt, that what became of a claim is not logged
      expect(NBSP_FREE(folds(w)[0]!.textContent)).toContain("suite donnée à l’assurance");
      expect(t).not.toMatch(/coût de remplacement\s+\d|valeur.*\d/i);
    });

    it("Given the compact view, Then 'Et maintenant' is a closed fold (room), and in full screen it is open text", async () => {
      const w = await page({ shown, lossAgoMs: 31 * SECOND });
      const nextFolds = () =>
        findAll(
          w.root,
          (n) => n.tag === "details" && n.className === "pf-why pf-next-fold" && isShown(n),
        );
      expect(nextFolds()).toHaveLength(1);
      const summary = nextFolds()[0]!.children.find((c) => c.tag === "summary")!;
      expect(summary.textContent).toBe("Et maintenant");
      expect(nextFolds()[0]!.attrs["open"]).toBeUndefined();
      await fullscreen(w);
      expect(nextFolds()).toHaveLength(0);
      expect(
        findAll(w.root, (n) => n.className === "pf-next-title" && isShown(n)).map(
          (n) => n.textContent,
        ),
      ).toEqual(["Et maintenant"]);
    });

    it("Given a loss with no cargo bought for it, Then there is no 'trajet interrompu' sentence (nothing was cut that the journal knows)", async () => {
      const w = await page({ shown, lossAgoMs: 31 * SECOND, noRun: true });
      const t = NBSP_FREE(lossBoxes(w)[0]!.textContent);
      expect(t).not.toContain("ne sera pas terminé");
      expect(t).toContain("Une nouvelle session ou un nouveau trajet peut commencer");
    });

    it("Given the loss cut the run before the CURRENT one (a respawn and a new run began), Then the box does not say the current run is cut", async () => {
      // the story's second run starts at 300 s: the loss is tied to the first run, which is no longer the newest
      const w = await page({
        shown,
        lossAgoMs: 31 * SECOND,
        stage: "second",
        lossRun: 1,
        atSeconds: 340,
      });
      const box = lossBoxes(w)[0]!;
      expect(box).toBeDefined();
      const t = NBSP_FREE(box.textContent);
      expect(t).not.toContain("ne sera pas terminé");
      expect(t).toContain("Une nouvelle session ou un nouveau trajet peut commencer");
      // and the same loss, tied to the newest run, does say it
      const w2 = await page({
        shown,
        lossAgoMs: 31 * SECOND,
        stage: "second",
        lossRun: 0,
        atSeconds: 340,
      });
      expect(NBSP_FREE(lossBoxes(w2)[0]!.textContent)).toContain("ne sera pas terminé");
    });

    it("Given two losses, Then the box and the verdict speak of the newest one only", async () => {
      const w = await page({ shown, lossAgoMs: 31 * SECOND, olderLossAgoMs: 8 * 60 * SECOND });
      const said = NBSP_FREE(compactLine(w)!.textContent);
      expect(said.match(/Vaisseau détruit à/g)).toHaveLength(1);
      expect(NBSP_FREE(verdict(w).textContent)).toMatch(/^Vaisseau détruit · il y a \d+ s/);
      expect(lossBoxes(w)).toHaveLength(1);
    });

    it("Given a loss and a new run begun after it, Then the loss is still in the box but the button asks about the loss, not the debrief", async () => {
      const w = await page({
        shown,
        lossAgoMs: 60 * SECOND,
        stage: "second",
        lossRun: 1,
        atSeconds: 340,
      });
      expect(asks(w).map((b) => b.textContent)).toContain("Analyser la perte");
      expect(asks(w).map((b) => b.textContent)).not.toContain("Debrief du trajet");
    });

    it("Given the full screen, Then the box says it once with the age outside the status line, and its own button asks Claude about the loss", async () => {
      const w = await page({ shown, lossAgoMs: 31 * SECOND });
      await fullscreen(w);
      const statuses = () =>
        findAll(w.root, (n) => n.attrs["role"] === "status" && isShown(n)).map(
          (n) => n.textContent,
        );
      const before = statuses();
      expect(before.join("\n")).toContain("Vaisseau détruit à");
      await w.advance(5 * SECOND);
      expect(statuses()).toEqual(before); // nothing ticks inside a live region
      const alertBox = findAll(w.root, (n) => n.className === "pf-alert" && isShown(n))[0]!;
      expect(alertBox.attrs["data-tone"]).toBe("fatal");
      expect(NBSP_FREE(alertBox.textContent)).toMatch(/il y a \d+ s \(à \d{2}:\d{2}:\d{2}\)/);
      expect(folds(w)).toHaveLength(1);
      // the loss is the first thing said: the compact line is hidden in full screen
      expect(compactLine(w)).toBeUndefined();
      const inBox = findAll(alertBox, (n) => n.tag === "button");
      expect(inBox.map((b) => b.textContent)).toEqual(["Analyser la perte"]);
    });

    it("Given a loss, Then no live region was added (at most the three the page already had)", async () => {
      const w = await page({ shown, lossAgoMs: 31 * SECOND });
      await fullscreen(w);
      expect(findAll(w.root, (n) => n.attrs["aria-live"] !== undefined).length).toBeLessThanOrEqual(
        3,
      );
      const inFold = findAll(
        folds(w)[0]!,
        (n) => n.attrs["role"] === "status" || n.attrs["aria-live"] !== undefined,
      );
      expect(inFold).toHaveLength(0);
    });

    it("Given a loss older than the 15 minutes, Then there is no box, no fatal tone and the button is the plain one", async () => {
      const w = await page({ shown, lossAgoMs: 40 * 60 * SECOND });
      expect(lossBoxes(w)).toHaveLength(0);
      expect(verdict(w).attrs["data-tone"]).not.toBe("fatal");
      expect(findButton(w.root, "Analyser").tag).toBe("button");
    });

    it("Given a loss and a refused price AFTER it, Then the slot keeps the newer refusal (amber), not the box of the loss", async () => {
      const w = await page({ shown, lossAgoMs: 120 * SECOND, refusalAgoMs: 20 * SECOND });
      expect(verdict(w).attrs["data-tone"]).toBe("warn");
      expect(lossBoxes(w)).toHaveLength(0);
      expect(compactLine(w)!.attrs["data-tone"]).toBe("warn");
      findButton(w.root, "Que faire maintenant ?");
    });
  });

  describe(`Feature: the Ask Claude button follows the situation (${mode})`, () => {
    const ask = async (w: PageWorld, label: string) => {
      const before = w.host.log.messages.length;
      findButton(w.root, label).click();
      await w.advance(100);
      expect(w.host.log.messages.length).toBe(before + 1);
      return NBSP_FREE(w.host.log.messages[before]!);
    };
    const clean = (m: string) => {
      expect(m).not.toMatch(PAID);
      expect(m).not.toMatch(/\d/);
      expect(m).not.toMatch(/MISC|Hull|Lyria|OOC_|<|>/);
      // The player's choice is read at CLICK time. Hidden: every tool call says include_balance false and the message says not to
      // include the balance. Shown: include_balance is not named at all (the server applies the choice).
      if (shown) {
        expect(m).not.toContain("include_balance");
        // Shown, the message says nothing at all about the balance: Claude gets what it needs.
        expect(m).not.toMatch(/solde|montants|balance/i);
      } else {
        expect(m).toContain("include_balance false");
        expect(m).toMatch(/N’inclus pas mon solde|Ne lis pas mon solde/);
      }
      expect(m).not.toMatch(/include_balance (true|vrai)/);
      expect(m).not.toContain("sc_live_poll");
      expect(m).not.toContain("sc_trade_suggest");
      expect(m).not.toContain("sc_live_mark");
      expect(m.length).toBeLessThan(700);
    };

    it("Given a loss, Then 'Analyser la perte' sends the fixed message that names the tools and carries nothing from the log", async () => {
      const w = await page({ shown, lossAgoMs: 31 * SECOND, cause: "combat", causer: "other" });
      const m = await ask(w, "Analyser la perte");
      clean(m);
      expect(m).toContain("sc_session_current");
      expect(m).toContain("sc_trade_journal");
      expect(m).toContain("valeur perdue");
      // the same words whatever the log said
      const w2 = await page({ shown, lossAgoMs: 90 * SECOND, cause: "collision", causer: "npc" });
      expect(await ask(w2, "Analyser la perte")).toBe(m);
    });

    it("Given a refused price, Then 'Que faire maintenant ?' sends the fixed message that names the price tools", async () => {
      const w = await page({ shown, refusalAgoMs: 20 * SECOND });
      expect(verdict(w).attrs["data-tone"]).toBe("warn");
      const m = await ask(w, "Que faire maintenant ?");
      clean(m);
      expect(m).toContain("sc_trade_journal");
      expect(m).toContain("uex_get_price_history");
    });

    it("Given a run that just ended, Then 'Debrief du trajet' sends the debrief message", async () => {
      const w = await page({ shown, stage: "story" });
      const names = asks(w).map((b) => b.textContent);
      expect(names).toContain("Debrief du trajet");
      const m = await ask(w, "Debrief du trajet");
      clean(m);
      expect(m).toContain("sc_trade_journal");
      expect(m).toContain("sc_session_current");
      expect(m).toContain("mesuré");
    });

    it("Given nothing special, Then the plain 'Analyser' keeps its message, and the full-screen card keeps its longer words", async () => {
      const w = await page({ shown });
      expect(asks(w).map((b) => b.textContent)).toContain("Analyser");
      const m = await ask(w, "Analyser");
      expect(m).toContain("sc_live_state");
      expect(m.includes("include_balance false")).toBe(!shown);
      expect(m.includes("include_balance")).toBe(!shown);
      await fullscreen(w);
      findButton(w.root, "Analyser ma situation");
    });

    it("Given the full screen after a loss, Then the card's button and the box's button say the same words and send the same message", async () => {
      const w = await page({ shown, lossAgoMs: 31 * SECOND });
      await fullscreen(w);
      const buttons = asks(w).filter((b) => b.textContent === "Analyser la perte");
      expect(buttons).toHaveLength(2);
      const sent: string[] = [];
      for (const b of buttons) {
        const before = w.host.log.messages.length;
        b.click();
        await w.advance(100);
        sent.push(w.host.log.messages[before]!);
      }
      expect(sent[0]).toBe(sent[1]);
    });
  });
}

describe("Feature: the history makes room for a ship loss", () => {
  const chips = (w: PageWorld) =>
    findAll(
      w.root,
      (n: FakeNode) =>
        /(^| )alert( |$)/.test(n.className) && !n.className.includes("condition") && isShown(n),
    );

  it("Given a fresh loss and events older than a minute, Then those chips are reduced and keep their words, while the live conditions are not", async () => {
    const w = await page({ lossAgoMs: 20 * SECOND, atSeconds: 160 });
    const list = chips(w);
    expect(list.map((c) => c.attrs["data-reduced"])).toEqual(["1", "1"]);
    expect(NBSP_FREE(list.map((c) => c.textContent).join(" "))).toMatch(
      /Touché.*Verrouillage hostile/,
    );
    // the live conditions are never reduced
    const conds = findAll(w.root, (n) => n.className.includes("condition") && isShown(n));
    for (const c of conds) expect(c.attrs["data-reduced"]).toBeUndefined();
  });

  it("Given no loss, Then no chip is reduced", async () => {
    const w = await page({ atSeconds: 160 });
    expect(chips(w).length).toBeGreaterThan(0);
    expect(findAll(w.root, (n: FakeNode) => n.attrs["data-reduced"] === "1")).toHaveLength(0);
  });

  it("Given a recent event (under a minute) during a loss, Then it is not reduced", async () => {
    const w = await page({ lossAgoMs: 10 * SECOND, atSeconds: 80 });
    expect(chips(w).map((c) => c.attrs["data-reduced"])).toContain("0");
  });
});

describe("Feature: the reduced history keeps its facts", () => {
  const chips = (w: PageWorld) =>
    findAll(
      w.root,
      (n: FakeNode) =>
        /(^| )alert( |$)/.test(n.className) && !n.className.includes("condition") && isShown(n),
    );

  it("Given reduced chips, Then each keeps its age, its verified flag and its label in the tree", async () => {
    const w = await page({ lossAgoMs: 20 * SECOND, atSeconds: 160 });
    const list = chips(w);
    expect(list.length).toBeGreaterThan(0);
    for (const c of list) {
      expect(c.attrs["data-reduced"]).toBe("1");
      expect(c.attrs["data-verified"]).toMatch(/^[01]$/);
      const meta = findAll(c, (n) => n.className === "alert-meta")[0]!;
      expect(NBSP_FREE(meta.textContent)).toMatch(/il y a \d/);
      expect(isShown(meta)).toBe(true);
    }
  });

  it("Given the style sheet, Then a reduced chip loses size and tint only: no opacity, no hidden meta, no border shorthand over the dashed style", () => {
    const rules = VIEW_CSS.split("\n").filter((l) => l.includes('[data-reduced="1"]'));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r).not.toMatch(/display:\s*none/);
      expect(r).not.toMatch(/opacity:\s*0?\.\d/);
      expect(r).not.toMatch(/(^|[ {;])border:/);
    }
    expect(rules.join("\n")).toContain("opacity: 1");
    // the text colour is the secondary text colour (about 8:1 in light and 10:1 in dark), not the faint one
    expect(rules.join("\n")).toContain("color: var(--sc-text2)");
  });

  it("Given the glyphs of the alerts, Then each has an empty alternative text so a screen reader does not read it", () => {
    const all = [VIEW_CSS, TRADE_PREFLIGHT_CSS, TRADE_ACTIONS_CSS].join("\n");
    const lines = all.split("\n").filter((l) => /2715|26A0/.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) expect(line).toContain('/ ""');
  });
});

describe("Feature: the loss leads the verdict only for a while, and never over a newer red condition", () => {
  const T = (w: PageWorld) => verdict(w).attrs["data-tone"];

  it("Given a loss six minutes ago and no other condition, Then the verdict is amber and still says it; the box keeps it", async () => {
    const w = await page({ lossAgoMs: 6 * 60 * SECOND });
    expect(T(w)).toBe("warn");
    expect(NBSP_FREE(verdict(w).textContent)).toMatch(/^Vaisseau détruit · il y a 6 min/);
    expect(compactLine(w)!.attrs["data-tone"]).toBe("fatal");
    expect(lossBoxes(w)).toHaveLength(1);
  });

  it("Given a loss six minutes ago and shields down now, Then the live red condition leads the verdict", async () => {
    const w = await page({ lossAgoMs: 6 * 60 * SECOND, atSeconds: 70 });
    expect(T(w)).toBe("bad");
    expect(NBSP_FREE(verdict(w).textContent)).toMatch(/^Alerte : /);
    expect(lossBoxes(w)).toHaveLength(1);
  });

  it("Given a loss that came BEFORE the red condition, Then the condition leads; if the condition is older, the loss leads", async () => {
    // the shields went down at about 65 s of the story
    const after = await page({ lossAgoMs: 60 * SECOND, atSeconds: 70 });
    expect(T(after)).toBe("bad");
    const before = await page({ lossAgoMs: 1 * SECOND, atSeconds: 70 });
    expect(T(before)).toBe("fatal");
  });

  it("Given a fresh loss only, Then the verdict is fatal and the history reduces; after the lead time it does not", async () => {
    const fresh = await page({ lossAgoMs: 20 * SECOND, atSeconds: 160 });
    expect(T(fresh)).toBe("fatal");
    const late = await page({ lossAgoMs: 5 * 60 * SECOND, atSeconds: 160 });
    expect(T(late)).toBe("warn");
    expect(findAll(late.root, (n: FakeNode) => n.attrs["data-reduced"] === "1")).toHaveLength(0);
  });
});

for (const shown of [false, true]) {
  describe(`Feature: a refused item, the stream states and the button (${shown ? "amounts shown" : "amounts hidden"})`, () => {
    it("Given a refused ITEM, Then the button stays the plain one (there is no trip and no goods to ask about)", async () => {
      const w = await page({ shown, refusalAgoMs: 20 * SECOND, refusalKind: "item" });
      const labels = asks(w).map((b) => b.textContent);
      expect(labels).toContain("Analyser");
      for (const l of labels) expect(["Analyser", "Analyser ma situation"]).toContain(l);
      findButton(w.root, "Analyser").click();
      await w.advance(100);
      const m = NBSP_FREE(w.host.log.messages.at(-1)!);
      expect(m).toContain("sc_live_state");
      expect(m).not.toMatch(/marchandise|trajet|uex_get_price_history/);
    });

    it("Given a refused price for goods, Then the message tells Claude not to guess the selling terminal", async () => {
      const w = await page({ shown, refusalAgoMs: 20 * SECOND });
      findButton(w.root, "Que faire maintenant ?").click();
      await w.advance(100);
      expect(NBSP_FREE(w.host.log.messages.at(-1)!)).toContain(
        "utilise le terminal de vente nommé par le journal ou par moi, sinon demande-le-moi",
      );
    });

    for (const [name, opts] of [
      ["disconnected", { conn: "disconnected" }],
      ["in the menus", { conn: "menu" }],
      ["a forced waiting stream", { forced: "waiting" }],
      ["telemetry off", { forced: "off" }],
    ] as const) {
      it(`Given a loss and ${name}, Then the page still renders, shows no fatal verdict over a stream that is not live, and a click sends a fixed message without amounts`, async () => {
        const w = await page({ shown, lossAgoMs: 31 * SECOND, ...opts });
        const v = verdict(w);
        if (isShown(v)) expect(v.attrs["data-tone"]).not.toBe("fatal");
        const labels = asks(w).map((b) => b.textContent);
        expect(labels.length).toBeGreaterThan(0);
        for (const l of labels)
          expect(["Analyser", "Analyser ma situation", "Analyser la perte"]).toContain(l);
        findButton(w.root, labels[0]!).click();
        await w.advance(100);
        expect(NBSP_FREE(w.host.log.messages.at(-1) ?? "")).not.toMatch(PAID);
      });
    }
  });
}
