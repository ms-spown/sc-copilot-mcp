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
  refusalAgoMs?: number;
  /** The trade story variant (tradeScenario.ts): "partial" is a run still open, "story" a run complete. */
  stage?: "partial" | "story";
  cause?: "collision" | "combat";
  causer?: "npc" | "other" | "unknown";
  noRun?: boolean;
  /** The second of the story the page is read at (default 215). */
  atSeconds?: number;
}

async function page(opts: Options = {}) {
  const scenario = new Scenario();
  scenario.uec = tradeBalanceAt;
  // Made-up times are fixed on the story (not moving with every poll), so a status line can be compared 5 s later.
  const AT = scenario.epoch + (opts.atSeconds ?? 215) * SECOND;
  scenario.ledger = (include, nowMs) => {
    const l: any = tradeLedger(nowMs, scenario.epoch, include, opts.stage ?? "partial");
    const run = l.trade.runs[0];
    if (opts.lossAgoMs !== null && opts.lossAgoMs !== undefined) {
      l.trade.ship_losses = [
        {
          at: new Date(AT - opts.lossAgoMs).toISOString(),
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
        },
      ];
    }
    if (opts.refusalAgoMs !== undefined)
      l.trade.price_refusals = [
        {
          at: new Date(AT - opts.refusalAgoMs).toISOString(),
          side: "sell",
          kind: "commodity",
          confidence: "confirmed",
          superseded: false,
        },
      ];
    return l;
  };
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
      expect(t).toContain("Le trajet en cours est interrompu : il ne sera pas terminé.");
      expect(t).toContain(
        "Une nouvelle session ou un nouveau trajet peut commencer quand tu veux.",
      );
      // the claim is not on the page (the dashboard does not receive it without the balance): neither "seen" nor "none seen"
      expect(NBSP_FREE(visibleText(w.root))).not.toMatch(/réclamation|aucune? .*vue?/i);
      // ... but the fold says, as a doubt, that what became of a claim is not logged
      expect(NBSP_FREE(folds(w)[0]!.textContent)).toContain("suite donnée à l’assurance");
      expect(t).not.toMatch(/coût de remplacement\s+\d|valeur.*\d/i);
    });

    it("Given a loss with no cargo bought for it, Then there is no 'trajet interrompu' sentence (nothing was cut that the journal knows)", async () => {
      const w = await page({ shown, lossAgoMs: 31 * SECOND, noRun: true });
      const t = NBSP_FREE(lossBoxes(w)[0]!.textContent);
      expect(t).not.toContain("Le trajet en cours est interrompu");
      expect(t).toContain("Une nouvelle session ou un nouveau trajet peut commencer");
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
      expect(m).toContain("include_balance false");
      expect(m).not.toMatch(/include_balance (true|vrai)/);
      expect(m).toContain("N’inclus pas mon solde");
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
      expect(m).toContain("include_balance false");
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
