/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import {
  sessionActionText,
  sessionBarInfo,
  sessionBarNormalize,
  sessionEndedText,
  sessionPhase,
  sessionRowStatus,
} from "./sessionPanel.js";
import { sessionBar, sessionFake, type SessionVariant } from "./testing/sessionScenario.js";
import {
  FakeNode,
  findAll,
  isShown,
  startPage,
  visibleText,
  type PageWorld,
} from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import * as L from "./viewLogic.js";

/**
 * Feature: managing the session from the card. Every state of the card x every click has a visible, durable result:
 * nothing is offered that cannot change anything, a confirmation exists only where a session holding something would be
 * closed (inline, without a timer, with a cancel), the result stays in a live region, and the card shows the new state.
 * (This replaces the tests of the old two-click loop with a 5 s timer.)
 */

const NOW = Date.UTC(2026, 11, 1, 20, 0, 0);
const SECOND = 1000;
const NB = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

/** An amount, matched as a WHOLE figure (never a substring of a longer number, a clock millisecond or an id). */
function amountIn(text: string, amount: number): boolean {
  const grouped = String(Math.abs(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return new RegExp(`(?<![\\d.,])${grouped}(?![\\d.,]?\\d)`).test(NB(text));
}
const AMOUNTS = [184_500, 250_000, 434_500, 61_250, 125_795];

const info = (variant: SessionVariant, show = true) =>
  sessionBarInfo(L, sessionBarNormalize(sessionBar(NOW, show, variant), show), {
    showBalance: show,
    now: NOW,
  });

describe("Feature: what the card offers in each state", () => {
  it("Given the five states, Then each offers exactly what can change something", () => {
    const offers = (v: SessionVariant) => {
      const i = info(v);
      return [i.phase, i.canEnd, i.canNew, i.newPrimary, i.newLabel];
    };
    expect(offers("empty")).toEqual(["none", false, true, true, "Démarrer une session"]);
    expect(offers("waiting")).toEqual(["waiting", false, false, false, "Nouvelle session"]);
    expect(offers("story")).toEqual(["active", true, true, false, "Nouvelle session"]);
    expect(offers("stale")).toEqual(["idle", true, true, false, "Nouvelle session"]);
    expect(offers("ended")).toEqual(["ended", false, true, true, "Nouvelle session"]);
  });

  it("Given a session waiting for the game, Then it says so (no 'en cours', no dash) and explains why nothing is offered", () => {
    const i = info("waiting");
    expect(i.chip).toBe("en attente du jeu");
    expect(i.line).toBe("Session 5 · en attente du jeu");
    expect(i.kpis).toEqual([]);
    expect(i.hint).toContain("Rien à terminer ni à recommencer");
    expect(i.sub).toMatch(/^créée /);
    expect(JSON.stringify(i)).not.toContain("en cours");
    expect(JSON.stringify(i.kpis)).not.toContain("\u2014");
  });

  it("Given an ended session, Then the card says when and how it ended, keeps its result, and says what happens next", () => {
    const i = info("ended");
    expect(i.chip).toMatch(/^terminée (à \d\d:\d\d|hier \d\d:\d\d)$/);
    expect(i.line).toMatch(/^Session 4 · terminée (à \d\d:\d\d|hier \d\d:\d\d) · 6 trajets/);
    expect(i.sub).toContain("fin manuelle");
    expect(i.kpis.map((k: any) => k.id)).toEqual(["net", "rate", "trips", "time"]);
    expect(NB(i.kpis[0].value)).toBe("+184 500 aUEC");
    expect(i.hint).toContain("Rien n’est compté tant que tu ne démarres pas une nouvelle session");
  });

  it("Given a session that holds trips, Then the questions name the session and its trips, in words", () => {
    const i = info("story");
    expect(i.endAsk).toContain("Terminer la session 4 (6 trajets) ?");
    expect(i.endAsk).toContain("Elle reste dans l’historique");
    expect(i.newAsk).toContain("La session 4 (6 trajets) sera terminée");
    expect(i.endAsk + i.newAsk).not.toMatch(/aUEC/);
  });

  it("Given how a session ended, Then the words are plain, and an unknown reason adds none", () => {
    const row = (s: any) => sessionRowStatus(s);
    expect(row({ status: "ended", end_reason: "manual" })).toBe("terminée · fin manuelle");
    expect(row({ status: "ended", end_reason: "new_session" })).toBe(
      "terminée · remplacée par une nouvelle session",
    );
    expect(row({ status: "ended", end_reason: "gap" })).toBe("terminée · inactivité prolongée");
    expect(row({ status: "ended", end_reason: null })).toBe("terminée");
    expect(row({ status: "open", empty: true })).toBe("en attente du jeu");
    expect(row({ status: "open", empty: false })).toBe("en cours");
    expect(row({ status: "open", empty: false, game_closed_at: "2026-12-01T19:00:00Z" })).toBe(
      "en cours · jeu fermé",
    );
    expect(sessionPhase(null, false)).toBe("none");
    expect(sessionEndedText({ ended_at: null }, NOW)).toBe("terminée");
  });

  it("Given the server's answers, Then the player reads French built from the fields, never the server's English", () => {
    const ended = {
      ok: true,
      reason: "ended",
      message: "Session 4 ended.",
      session: {
        ...(sessionBar(NOW, false, "ended").current as any),
      },
    };
    const t = (kind: string, r: any) => NB(sessionActionText(kind, r, NOW));
    expect(t("end", ended)).toMatch(
      /^Session 4 terminée (à \d\d:\d\d|hier \d\d:\d\d) \(6 trajets\)\. Elle reste dans l’historique\.$/,
    );
    const waiting = sessionBar(NOW, false, "waiting").current;
    expect(t("end", { ok: false, reason: "empty", session: waiting })).toBe(
      "Rien à terminer : la session 5 attend le jeu.",
    );
    expect(t("end", { ok: false, reason: "already_ended", session: ended.session })).toBe(
      "La session 4 est déjà terminée.",
    );
    expect(t("end", { ok: false, reason: "none" })).toBe("Il n’y a aucune session à terminer.");
    expect(t("new", { ok: true, started: true, closed_session: 4, session: waiting })).toBe(
      "Session 5 démarrée. La session 4 est terminée et reste dans l’historique.",
    );
    expect(t("new", { ok: true, started: true, closed_session: null, session: waiting })).toBe(
      "Session 5 démarrée.",
    );
    expect(t("new", { ok: true, started: false, session: waiting })).toBe(
      "Rien à démarrer : la session 5 attend déjà le jeu.",
    );
    expect(
      t("new", { ok: true, started: true, persistence: { saved: false }, session: waiting }),
    ).toContain("Attention : le changement n’a pas pu être enregistré sur le disque");
    for (const s of [
      t("end", ended),
      t("new", { started: true, message: "Session 5 started." }),
      t("end", { ok: false, reason: "empty", message: "Nothing ended: session 5 is empty." }),
    ])
      expect(s).not.toMatch(/started|ended|Nothing|session file/i);
  });
});

// ---------------------------------------------------------------------------------------------
// The assembled page, with a server stand-in that moves like the real one
// ---------------------------------------------------------------------------------------------

async function managed(variant: SessionVariant) {
  const scenario = new Scenario();
  const fake = sessionFake(variant);
  const w = await startPage({ scenario });
  const at = () => scenario.epoch + scenario.t;
  w.host.overrides.poll = (base: any, include: boolean) => ({
    ...base,
    sessions: fake.bar(at(), include),
  });
  w.host.overrides.tool = (name: string, args: any) => fake.tool(name, args, at());
  await w.advance(5 * SECOND);
  return { w, fake, at };
}

const text = (w: PageWorld) => NB(visibleText(w.root));
const button = (w: PageWorld, label: string): FakeNode | null => {
  const found = findAll(w.root, (n) => n.tag === "button" && n.textContent === label);
  return found.length > 0 ? found[0]! : null;
};
const offered = (w: PageWorld, label: string) => {
  const b = button(w, label);
  return !!b && isShown(b);
};
const click = async (w: PageWorld, label: string, wait = 500) => {
  const b = button(w, label);
  expect(b, `no button "${label}"`).not.toBeNull();
  expect(isShown(b!), `button "${label}" is hidden`).toBe(true);
  b!.click();
  await w.advance(wait);
};
const statusLine = (w: PageWorld): FakeNode => {
  const n = findAll(w.root, (x) => x.className === "ses-status")[0];
  expect(n, "the live region of the session card").toBeDefined();
  return n!;
};
const said = (w: PageWorld) => NB(statusLine(w).textContent);
const toolNames = (w: PageWorld) => w.host.log.tools.map((t) => t.name);
const kpiValues = (w: PageWorld) =>
  findAll(w.root, (n) => n.className === "ses-k-value" && isShown(n)).map((n) => NB(n.textContent));

describe("Feature: the card of a session in progress", () => {
  it("Given a session in progress, Then 'Terminer' and 'Nouvelle session' are on the card, and the live region exists from the start", async () => {
    const { w } = await managed("story");
    expect(offered(w, "Terminer la session")).toBe(true);
    expect(offered(w, "Nouvelle session")).toBe(true);
    expect(button(w, "Nouvelle session")!.className).toBe("btn small");
    const s = statusLine(w);
    expect(s.attrs["role"]).toBe("status");
    expect(s.attrs["data-hidden"]).toBeUndefined();
    expect(s.textContent).toBe("");
  });

  it("Given 'Terminer', Then the question appears next to the button, nothing is sent, and it does not go away by itself", async () => {
    const { w } = await managed("story");
    await click(w, "Terminer la session", 100);
    expect(toolNames(w)).toEqual([]);
    expect(text(w)).toContain("Terminer la session 4 (6 trajets) ?");
    expect(offered(w, "Confirmer la fin")).toBe(true);
    expect(offered(w, "Annuler")).toBe(true);
    // The two actions are not offered meanwhile (one question at a time).
    expect(offered(w, "Terminer la session")).toBe(false);
    expect(offered(w, "Nouvelle session")).toBe(false);
    expect(FakeNode.focused).toBe(button(w, "Confirmer la fin"));
    // No timer: a minute later the question is still there and nothing happened.
    await w.advance(60 * SECOND);
    expect(offered(w, "Confirmer la fin")).toBe(true);
    expect(toolNames(w)).toEqual([]);
  });

  it("Given the question, Then the group and the confirm button are described by its text, so a screen reader reads it", async () => {
    const { w } = await managed("story");
    await click(w, "Terminer la session", 100);
    const q = findAll(w.root, (n) => n.className === "ses-confirm-text")[0]!;
    const id = q.attrs["id"];
    expect(id).toBeTruthy();
    expect(NB(q.textContent)).toContain("Terminer la session 4 (6 trajets) ?");
    const box = findAll(w.root, (n) => n.className === "ses-confirm")[0]!;
    expect(box.attrs["aria-describedby"]).toBe(id);
    expect(button(w, "Confirmer la fin")!.attrs["aria-describedby"]).toBe(id);
    expect(findAll(w.root, (n) => n.attrs["id"] === id)).toHaveLength(1);
  });

  it("Given a poll in flight (asked before the end) when the end is confirmed, Then its old answer does not bring the card back to 'en cours'", async () => {
    const { w, fake } = await managed("story");
    await click(w, "Terminer la session", 100);
    // From now on the answers of polls are held: the next poll is asked while the session is still in progress.
    w.host.hold.on = true;
    await w.advance(8 * SECOND);
    expect(w.host.hold.held.length).toBeGreaterThan(0);
    await click(w, "Confirmer la fin", 200);
    expect(fake.variant).toBe("ended"); // the server ended it
    // The old poll answers (session still open): the card must not show it, and the buttons stay away.
    w.host.releasePolls();
    await w.advance(200);
    expect(offered(w, "Terminer la session")).toBe(false);
    // The fresh poll, asked after the end, answers: the card shows the ended session and keeps it.
    w.host.hold.on = false;
    w.host.releasePolls();
    await w.advance(2 * SECOND);
    expect(text(w)).toMatch(/Session 4\nterminée /);
    expect(text(w)).not.toMatch(/Session 4\nen cours/);
    expect(offered(w, "Nouvelle session")).toBe(true);
    expect(offered(w, "Terminer la session")).toBe(false);
    expect(said(w)).toContain("Session 4 terminée");
  });

  it("Given a cancelled question, Then it says so in the live region, the session continues and the focus goes back to the button", async () => {
    const { w, fake } = await managed("story");
    await click(w, "Terminer la session", 100);
    await click(w, "Annuler", 100);
    expect(said(w)).toBe("Fin de session annulée : la session continue.");
    expect(offered(w, "Terminer la session")).toBe(true);
    expect(offered(w, "Confirmer la fin")).toBe(false);
    expect(FakeNode.focused).toBe(button(w, "Terminer la session"));
    expect(fake.calls).toEqual([]);
    // Escape does the same.
    await click(w, "Nouvelle session", 100);
    expect(text(w)).toContain(
      "Démarrer une nouvelle session ? La session 4 (6 trajets) sera terminée",
    );
    const box = findAll(w.root, (n) => n.className === "ses-confirm")[0]!;
    box.listeners["keydown"]![0]!({ key: "Escape" });
    await w.advance(50);
    expect(said(w)).toBe("Nouvelle session annulée : la session continue.");
    expect(fake.calls).toEqual([]);
  });

  it("Given the confirmed end, Then the server is asked once, the card shows the session as ended with its result and a primary 'Nouvelle session', and it stays so", async () => {
    const { w, fake } = await managed("story");
    await click(w, "Terminer la session", 100);
    await click(w, "Confirmer la fin", 1500);
    expect(toolNames(w)).toEqual(["sc_session_end"]);
    expect(fake.calls).toEqual(["sc_session_end"]);
    // The card: ended, when, how, its figures stay; the old buttons are gone.
    const t = text(w);
    expect(t).toMatch(/Session 4\nterminée (à \d\d:\d\d|hier \d\d:\d\d)/);
    expect(t).toContain("fin manuelle");
    expect(t).toContain("Trajets");
    expect(offered(w, "Terminer la session")).toBe(false);
    expect(offered(w, "Confirmer la fin")).toBe(false);
    expect(offered(w, "Nouvelle session")).toBe(true);
    expect(button(w, "Nouvelle session")!.className).toBe("btn small primary");
    expect(t).toContain("Rien n’est compté tant que tu ne démarres pas une nouvelle session");
    // The live region keeps the result (no timer), in French.
    expect(said(w)).toMatch(
      /^Session 4 terminée (à \d\d:\d\d|hier \d\d:\d\d) \(6 trajets\)\. Elle reste dans l’historique\.$/,
    );
    expect(FakeNode.focused).toBe(button(w, "Nouvelle session"));
    // The dashboard keeps polling: the ended state does not flip back, the message does not vanish, nothing more is sent.
    await w.advance(120 * SECOND);
    expect(text(w)).toMatch(/Session 4\nterminée /);
    expect(offered(w, "Terminer la session")).toBe(false);
    expect(said(w)).toContain("Session 4 terminée");
    expect(toolNames(w)).toEqual(["sc_session_end"]);
  });

  it("Given an ended session, When 'Nouvelle session' is pressed, Then nothing is asked (nothing is closed) and the waiting session 5 appears with the result", async () => {
    const { w } = await managed("ended");
    expect(text(w)).toMatch(/Session 4\nterminée /);
    await click(w, "Nouvelle session", 1500);
    expect(toolNames(w)).toEqual(["sc_session_new"]);
    expect(said(w)).toBe("Session 5 démarrée.");
    expect(text(w)).toContain("Session 5");
    expect(text(w)).toContain("en attente du jeu");
    expect(offered(w, "Terminer la session")).toBe(false);
    expect(offered(w, "Nouvelle session")).toBe(false);
    expect(text(w)).toContain("Rien à terminer ni à recommencer");
    // Still there a minute later (the poll does not erase it).
    await w.advance(60 * SECOND);
    expect(said(w)).toBe("Session 5 démarrée.");
  });

  it("Given a session in progress, When 'Nouvelle session' is confirmed, Then the old one is said to be closed and the new one waits", async () => {
    const { w } = await managed("story");
    await click(w, "Nouvelle session", 100);
    expect(toolNames(w)).toEqual([]);
    await click(w, "Confirmer : nouvelle session", 1500);
    expect(toolNames(w)).toEqual(["sc_session_new"]);
    expect(said(w)).toBe(
      "Session 5 démarrée. La session 4 est terminée et reste dans l’historique.",
    );
    expect(text(w)).toContain("en attente du jeu");
  });
});

describe("Feature: nothing is offered that cannot change anything", () => {
  it("Given a session that waits for the game, Then there is no 'Terminer' and no 'Nouvelle session', and nothing is ever sent", async () => {
    const { w } = await managed("waiting");
    expect(text(w)).toContain("en attente du jeu");
    expect(text(w)).toContain(
      "Rien à terminer ni à recommencer : cette session démarre toute seule dès que le jeu est détecté.",
    );
    expect(offered(w, "Terminer la session")).toBe(false);
    expect(offered(w, "Nouvelle session")).toBe(false);
    // No KPI, so no dash standing for a figure that does not exist.
    expect(kpiValues(w)).toEqual([]);
    await w.advance(30 * SECOND);
    expect(toolNames(w)).toEqual([]);
  });

  it("Given no session at all, Then one button starts it at once, as the primary action, and it is said", async () => {
    const { w } = await managed("empty");
    expect(text(w)).toContain("Aucune session");
    expect(offered(w, "Terminer la session")).toBe(false);
    expect(button(w, "Démarrer une session")!.className).toBe("btn small primary");
    await click(w, "Démarrer une session", 1500);
    expect(toolNames(w)).toEqual(["sc_session_new"]);
    expect(said(w)).toBe("Session 5 démarrée.");
    expect(text(w)).toContain("en attente du jeu");
  });

  it("Given a quiet session, Then it can still be ended, with the question", async () => {
    const { w } = await managed("stale");
    expect(offered(w, "Terminer la session")).toBe(true);
    await click(w, "Terminer la session", 100);
    expect(text(w)).toContain("Terminer la session 4 (6 trajets) ?");
  });
});

describe("Feature: what goes wrong is said, and stays said", () => {
  it("Given a failure of the tool, Then the player is told in the live region, the buttons come back, and nothing flips silently", async () => {
    const { w } = await managed("story");
    w.host.overrides.tool = () => new Error("the session file is busy");
    await click(w, "Terminer la session", 100);
    await click(w, "Confirmer la fin", 1500);
    expect(said(w)).toContain("Fin de session impossible : ");
    expect(offered(w, "Terminer la session")).toBe(true);
    expect(offered(w, "Confirmer la fin")).toBe(false);
    await w.advance(60 * SECOND);
    expect(said(w)).toContain("Fin de session impossible : ");
  });

  it("Given an answer that says the change is only in memory, Then the player is warned", async () => {
    const { w, fake, at } = await managed("story");
    w.host.overrides.tool = (name: string, args: any) => ({
      ...(fake.tool(name, args, at()) as object),
      persistence: { saved: false, status: "Sessions could not be saved" },
    });
    await click(w, "Terminer la session", 100);
    await click(w, "Confirmer la fin", 1500);
    expect(said(w)).toContain("Attention : le changement n’a pas pu être enregistré sur le disque");
  });

  it("Given another View ended the session while the question was open, Then the question is withdrawn, the player is told, and nothing is sent", async () => {
    const { w, fake } = await managed("story");
    await click(w, "Terminer la session", 100);
    fake.variant = "ended";
    await w.advance(6 * SECOND);
    expect(offered(w, "Confirmer la fin")).toBe(false);
    expect(said(w)).toBe(
      "La session a changé pendant que tu hésitais : la confirmation est annulée, rien n’a été fait.",
    );
    expect(toolNames(w)).toEqual([]);
    expect(offered(w, "Nouvelle session")).toBe(true);
  });

  it("Given the game starts a new session after an end, Then the old result makes room for the new card", async () => {
    const { w, fake } = await managed("story");
    await click(w, "Terminer la session", 100);
    await click(w, "Confirmer la fin", 1500);
    expect(said(w)).toContain("Session 4 terminée");
    fake.variant = "waiting"; // the game was relaunched: the server made the next session (number 5)
    await w.advance(6 * SECOND);
    expect(said(w)).toBe("");
    expect(text(w)).toContain("en attente du jeu");
  });
});

describe("Feature: the compact line, the past sessions and the amounts follow the state", () => {
  it("Given the compact view, Then the folded line carries the state: waiting, or ended at a time", async () => {
    const waiting = await managed("waiting");
    const fold = (w: PageWorld) =>
      NB(findAll(w.root, (n) => n.className.split(" ").includes("ses-one"))[0]!.textContent);
    expect(fold(waiting.w)).toContain("Session 5 · en attente du jeu");
    const ended = await managed("ended");
    expect(fold(ended.w)).toMatch(/Session 4 · terminée (à \d\d:\d\d|hier \d\d:\d\d) · 6 trajets/);
  });

  it("Given the list of past sessions, Then each row says in words whether it is in progress, waiting or ended, and how", async () => {
    const { w } = await managed("story");
    await click(w, "Sessions ▾");
    const rowLabels = findAll(
      w.root,
      (n) =>
        n.tag === "button" &&
        n.attrs["aria-label"]?.startsWith("Ouvrir la session ") === true &&
        isShown(n),
    ).map((n) => NB(n.attrs["aria-label"]!));
    expect(
      rowLabels.some((l) => l.startsWith("Ouvrir la session 4") && l.endsWith(", en cours")),
    ).toBe(true);
    expect(
      rowLabels.some(
        (l) =>
          l.startsWith("Ouvrir la session 1") && l.endsWith(", terminée · inactivité prolongée"),
      ),
    ).toBe(true);
    // The menu no longer holds "Terminer": it is on the card.
    expect(
      findAll(w.root, (n) => n.tag === "button" && n.textContent === "Terminer la session"),
    ).toHaveLength(1);
    expect(text(w)).toContain("terminée · inactivité prolongée");
  });

  it("Given a session ended by hand, Then its row says so and it opens for its detail as before", async () => {
    const { w } = await managed("story");
    await click(w, "Terminer la session", 100);
    await click(w, "Confirmer la fin", 1500);
    await click(w, "Sessions ▾");
    expect(text(w)).toContain("terminée · fin manuelle");
    const row = findAll(
      w.root,
      (n) =>
        n.tag === "button" && n.attrs["aria-label"]?.startsWith("Ouvrir la session 4") === true,
    )[0]!;
    row.click();
    await w.advance(500);
    expect(w.host.log.tools.at(-1)).toMatchObject({
      name: "sc_session_current",
      args: { id: "s_fixture_4" },
    });
    expect(text(w)).toContain("Session 4 (terminée)");
    expect(text(w)).toContain("(fin manuelle)");
    expect(offered(w, "Retour à la liste")).toBe(true);
  });

  it("Given the ended card, Then its result obeys the balance choice, matched as whole figures", async () => {
    const { w } = await managed("ended");
    // Hidden at the start of these pages: no amount anywhere, not in the card, the line or the status.
    for (const a of AMOUNTS)
      expect(amountIn(text(w), a), `amount ${a} on a hidden balance`).toBe(false);
    expect(kpiValues(w).join(" | ")).toContain("masqué");
    await click(w, "Afficher le solde", 3 * SECOND);
    expect(kpiValues(w)[0]).toBe("+184 500 aUEC");
    expect(amountIn(text(w), 184_500)).toBe(true);
    // The action messages never hold an amount, so hiding again has nothing of them to clear.
    await click(w, "Nouvelle session", 1500);
    expect(said(w)).toBe("Session 5 démarrée.");
    await click(w, "Masquer le solde", 3 * SECOND);
    for (const a of AMOUNTS) expect(amountIn(text(w), a), `amount ${a} after hiding`).toBe(false);
  });
});
