/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import {
  sessionDeleteAsk,
  sessionFilterCounts,
  sessionFilterMatch,
  sessionManageText,
} from "./sessionPanel.js";
import { sessionFake, type SessionVariant } from "./testing/sessionScenario.js";
import {
  FakeNode,
  findAll,
  isShown,
  startPage,
  visibleText,
  walk,
  type PageWorld,
} from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";

/**
 * Feature: the Sessions view, the dedicated tab of the dashboard. The full list of the saved sessions, filters (en cours,
 * terminées, archivées), the actions of each row (archive, unarchive, delete with an inline question), the selected session's
 * detail next to the list, the statistics across sessions, and the amounts under the balance choice. The server is a stateful
 * fake (testing/sessionScenario.ts) that moves like the real one.
 */

const SECOND = 1000;
const NB = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

/** An amount, matched as a WHOLE figure (never a substring of a longer number, a clock millisecond or an id). */
function amountIn(text: string, amount: number): boolean {
  const grouped = String(Math.abs(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return new RegExp(`(?<![\\d.,])${grouped}(?![\\d.,]?\\d)`).test(NB(text));
}
/** The session figures of the fixtures (net of each session, and the totals of the statistics). */
const AMOUNTS = [96_000, 310_500, 12_000, 184_500, 579_000, 125_795, 98_100];

async function managed(variant: SessionVariant = "story") {
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
const button = (w: PageWorld, label: string): FakeNode | null =>
  findAll(w.root, (n) => n.tag === "button" && n.textContent === label)[0] ?? null;
const byLabel = (w: PageWorld, label: string): FakeNode | null =>
  findAll(w.root, (n) => n.tag === "button" && n.attrs["aria-label"] === label)[0] ?? null;
const offeredLabel = (w: PageWorld, label: string) => {
  const b = byLabel(w, label);
  return !!b && isShown(b);
};
const click = async (w: PageWorld, label: string, wait = 500) => {
  const b = button(w, label) ?? byLabel(w, label);
  expect(b, `no button "${label}"`).not.toBeNull();
  expect(isShown(b!), `button "${label}" is hidden`).toBe(true);
  b!.click();
  await w.advance(wait);
};
const view = (w: PageWorld): FakeNode => findAll(w.root, (n) => n.className === "ses-view ses")[0]!;
const viewShown = (w: PageWorld) => isShown(view(w));
const rowsOf = (w: PageWorld) =>
  findAll(view(w), (n) => n.className === "ses-row" && isShown(n)).map((n) =>
    NB(n.attrs["aria-label"] ?? ""),
  );
const rowNumbers = (w: PageWorld) => rowsOf(w).map((l) => /^Ouvrir la session (\d+)/.exec(l)![1]);
const said = (w: PageWorld) =>
  NB(findAll(view(w), (n) => n.className === "ses-status")[0]!.textContent);
const manageCalls = (w: PageWorld) =>
  w.host.log.tools.filter((t) => t.name === "sc_session_manage");
/** Everything under the view, hidden nodes and attributes included. */
const everything = (n: FakeNode): string => {
  const parts: string[] = [];
  walk(n, (x) => {
    if (x.children.length === 0) parts.push(x.textContent);
    parts.push(...Object.values(x.attrs));
  });
  return NB(parts.join("\n"));
};
const openView = async (w: PageWorld) => {
  await click(w, "Sessions ▾", 300);
  await click(w, "Toutes les sessions (4)", 1500);
};

describe("Feature: the pure parts of the view", () => {
  const s = (over: any) => ({ status: "ended", archived: false, ...over });

  it("Given the filters, Then 'Toutes' is every session that is not archived, and archived ones have a filter of their own", () => {
    const list = [
      s({ status: "open" }),
      s({}),
      s({ archived: true }),
      s({ archived: true, status: "open" }),
    ];
    const keeps = (f: string) => list.filter((x) => sessionFilterMatch(f, x)).length;
    expect([keeps("all"), keeps("open"), keeps("ended"), keeps("archived")]).toEqual([2, 1, 1, 2]);
    expect(sessionFilterCounts(list)).toEqual({ all: 2, open: 1, ended: 1, archived: 2 });
  });

  it("Given the questions and the answers, Then they are French, name the session, and hold no amount", () => {
    expect(sessionDeleteAsk({ number: 7, trips: 6 })).toBe(
      "Supprimer la session 7 (6 trajets) ? Elle est retirée du fichier pour de bon : ni archive, ni retour possible.",
    );
    const session = {
      number: 7,
      started_at: "2026-12-01T10:00:00Z",
      status: "ended",
      id: "s_abcd",
    };
    const t = (action: string, r: any) => sessionManageText(action, { session, ...r });
    expect(t("delete", { reason: "done" })).toBe("Session 7 supprimée du fichier.");
    expect(t("archive", { reason: "done" })).toBe(
      "Session 7 archivée : elle reste dans le filtre « Archivées ».",
    );
    expect(t("unarchive", { reason: "done" })).toBe(
      "Session 7 désarchivée : elle est de retour dans la liste.",
    );
    expect(t("archive", { reason: "open_session" })).toContain("termine-la d’abord (Terminer)");
    expect(t("archive", { reason: "unchanged" })).toBe("La session 7 était déjà archivée.");
    expect(t("delete", { reason: "not_found" })).toContain("n’existe plus");
    expect(t("delete", { reason: "done", persistence: { saved: false } })).toContain(
      "Attention : le changement n’a pas pu être enregistré sur le disque",
    );
  });
});

describe("Feature: the card's list leads to the Sessions view", () => {
  it("Given more than 3 sessions, Then the inline list shows the 3 latest and 'Toutes les sessions' opens the view in full screen", async () => {
    const { w } = await managed("story");
    expect(viewShown(w)).toBe(false);
    await click(w, "Sessions ▾", 300);
    const inline = findAll(w.root, (n) => n.className === "ses-row" && isShown(n));
    expect(inline).toHaveLength(3);
    await click(w, "Toutes les sessions (4)", 1500);
    expect(w.host.log.modeRequests).toContain("fullscreen");
    expect(viewShown(w)).toBe(true);
    // The dashboard's other sections are not on screen, the tabs are, and "Sessions" is the selected one.
    expect(w.root.attrs["data-view"]).toBe("sessions"); // the stylesheet hides the rest of the page
    expect(button(w, "Sessions")!.attrs["aria-selected"]).toBe("true");
    expect(button(w, "Tableau de bord")!.attrs["aria-selected"]).toBe("false");
    expect(rowNumbers(w)).toEqual(["4", "3", "2", "1"]);
  });

  it("Given the tabs, Then 'Tableau de bord' brings the dashboard back and the view keeps nothing; the arrow keys switch tabs", async () => {
    const { w } = await managed("story");
    await openView(w);
    await click(w, "Tableau de bord", 300);
    expect(viewShown(w)).toBe(false);
    expect(w.root.attrs["data-view"]).toBe("dash");
    // Nothing the view drew stays in the page (it may hold amounts).
    for (const a of AMOUNTS) expect(amountIn(everything(view(w)), a)).toBe(false);
    expect(findAll(view(w), (n) => n.className === "ses-r-n" && n.textContent !== "")).toEqual([]);
    // Keyboard: the arrow on the selected tab moves to the other one.
    button(w, "Tableau de bord")!.listeners["keydown"]![0]!({ key: "ArrowRight" });
    await w.advance(1000);
    expect(viewShown(w)).toBe(true);
    expect(FakeNode.focused).toBe(button(w, "Sessions"));
    button(w, "Sessions")!.listeners["keydown"]![0]!({ key: "ArrowLeft" });
    await w.advance(1000);
    expect(viewShown(w)).toBe(false);
  });
});

describe("Feature: the full list and its filters", () => {
  it("Given the view, Then every session is there with its state, and the filters count and keep what they say", async () => {
    const { w } = await managed("story");
    await openView(w);
    expect(button(w, "Toutes (4)")!.attrs["aria-pressed"]).toBe("true");
    expect(button(w, "En cours (1)")).not.toBeNull();
    expect(button(w, "Terminées (3)")).not.toBeNull();
    expect(button(w, "Archivées (0)")).not.toBeNull();
    const labels = rowsOf(w).join(" | ");
    expect(labels).toContain("Ouvrir la session 4");
    expect(labels).toContain("en cours");
    expect(labels).toContain("terminée · inactivité prolongée");
    await click(w, "En cours (1)", 100);
    expect(rowNumbers(w)).toEqual(["4"]);
    await click(w, "Terminées (3)", 100);
    expect(rowNumbers(w)).toEqual(["3", "2", "1"]);
    await click(w, "Archivées (0)", 100);
    expect(rowNumbers(w)).toEqual([]);
    expect(text(w)).toContain("Aucune session dans ce filtre.");
  });

  it("Given more than 30 sessions (45), Then the view asks the server for up to 200, archived included, and shows all 45", async () => {
    const { w, fake } = await managed("story");
    fake.extraSessions = 41;
    await click(w, "Sessions ▾", 300);
    await click(w, "Toutes les sessions (45)", 1500);
    const asks = w.host.log.tools.filter((t) => t.name === "sc_session_list").map((t) => t.args);
    expect(asks.at(-1)).toMatchObject({ limit: 200, include_archived: true });
    expect(rowsOf(w)).toHaveLength(45);
    expect(button(w, "Toutes (45)")).not.toBeNull();
  });
});

describe("Feature: the actions of a row", () => {
  it("Given the session in progress, Then its row has no archive and no delete (it is ended first, with Terminer)", async () => {
    const { w } = await managed("story");
    await openView(w);
    expect(offeredLabel(w, "Archiver la session 4")).toBe(false);
    expect(offeredLabel(w, "Supprimer la session 4")).toBe(false);
    expect(offeredLabel(w, "Archiver la session 3")).toBe(true);
    expect(offeredLabel(w, "Supprimer la session 3")).toBe(true);
  });

  it("Given 'Archiver', Then the session leaves the default list at once, is kept under 'Archivées', and 'Désarchiver' brings it back", async () => {
    const { w, fake } = await managed("story");
    await openView(w);
    await click(w, "Archiver la session 3", 1500);
    expect(manageCalls(w).map((t) => t.args)).toEqual([{ id: "s_fixture_3", action: "archive" }]);
    expect(said(w)).toBe("Session 3 archivée : elle reste dans le filtre « Archivées ».");
    expect(rowNumbers(w)).toEqual(["4", "2", "1"]);
    expect(button(w, "Archivées (1)")).not.toBeNull();
    expect(fake.marks.archived.has("s_fixture_3")).toBe(true);
    await click(w, "Archivées (1)", 100);
    expect(rowNumbers(w)).toEqual(["3"]);
    expect(rowsOf(w)[0]).toContain("archivée");
    expect(offeredLabel(w, "Désarchiver la session 3")).toBe(true);
    await click(w, "Désarchiver la session 3", 1500);
    expect(said(w)).toBe("Session 3 désarchivée : elle est de retour dans la liste.");
    expect(rowNumbers(w)).toEqual([]);
    await click(w, "Toutes (4)", 100);
    expect(rowNumbers(w)).toEqual(["4", "3", "2", "1"]);
  });

  it("Given an archived session, Then it is hidden from the card's own list too (the server leaves it out by default)", async () => {
    const { w } = await managed("story");
    await openView(w);
    await click(w, "Archiver la session 3", 1500);
    await click(w, "Tableau de bord", 300);
    // (the card's own menu stays closed unless it was opened: open it, and let a poll pass)
    if (button(w, "Sessions ▾")) await click(w, "Sessions ▾", 500);
    await w.advance(6 * SECOND);
    const inline = findAll(w.root, (n) => n.className === "ses-row" && isShown(n)).map((n) =>
      NB(n.attrs["aria-label"] ?? ""),
    );
    expect(inline.join(" | ")).not.toContain("Ouvrir la session 3");
    expect(inline).toHaveLength(3);
  });

  it("Given 'Supprimer', Then an inline question comes first (nothing is sent), 'Annuler' and Escape keep the session, 'Confirmer' removes it for good", async () => {
    const { w, fake } = await managed("story");
    await openView(w);
    await click(w, "Supprimer la session 2", 100);
    expect(manageCalls(w)).toEqual([]);
    expect(text(w)).toContain(
      "Supprimer la session 2 (9 trajets) ? Elle est retirée du fichier pour de bon",
    );
    expect(FakeNode.focused).toBe(byLabel(w, "Confirmer la suppression de la session 2"));
    // Annuler: nothing happens, said, the focus goes back to the button.
    const annuler = findAll(
      view(w),
      (n) => n.tag === "button" && n.textContent === "Annuler" && isShown(n),
    );
    expect(annuler).toHaveLength(1);
    annuler[0]!.click();
    await w.advance(100);
    expect(said(w)).toBe("Suppression annulée : la session est conservée.");
    expect(FakeNode.focused).toBe(byLabel(w, "Supprimer la session 2"));
    expect(manageCalls(w)).toEqual([]);
    expect(rowNumbers(w)).toContain("2");
    // Escape does the same.
    await click(w, "Supprimer la session 2", 100);
    const conf = findAll(view(w), (n) => n.className === "ses-r-confirm" && isShown(n))[0]!;
    conf.listeners["keydown"]![0]!({ key: "Escape" });
    await w.advance(100);
    expect(manageCalls(w)).toEqual([]);
    // Confirmer: the server is asked once, the row goes, it is said, and the list shows what is left.
    await click(w, "Supprimer la session 2", 100);
    await click(w, "Confirmer la suppression de la session 2", 1500);
    expect(manageCalls(w).map((t) => t.args)).toEqual([{ id: "s_fixture_2", action: "delete" }]);
    expect(said(w)).toBe("Session 2 supprimée du fichier.");
    expect(rowNumbers(w)).toEqual(["4", "3", "1"]);
    expect(button(w, "Toutes (3)")).not.toBeNull();
    expect(fake.marks.deleted.has("s_fixture_2")).toBe(true);
    // It is gone for good: not even under "Archivées".
    await click(w, "Archivées (0)", 100);
    expect(rowNumbers(w)).toEqual([]);
  });

  it("Given a failure of the server, Then the player is told and the question does not hang", async () => {
    const { w, fake, at } = await managed("story");
    await openView(w);
    w.host.overrides.tool = (name: string, args: any) =>
      name === "sc_session_manage"
        ? new Error("the session file is busy")
        : fake.tool(name, args, at());
    await click(w, "Supprimer la session 3", 100);
    await click(w, "Confirmer la suppression de la session 3", 1500);
    expect(said(w)).toContain("Action impossible : ");
    expect(offeredLabel(w, "Supprimer la session 3")).toBe(true);
    expect(findAll(view(w), (n) => n.className === "ses-r-confirm" && isShown(n))).toHaveLength(0);
  });
});

describe("Feature: selecting a session shows its detail next to the list", () => {
  it("Given a row, Then its detail (trips, breaks, the report controls) opens in place and the list stays", async () => {
    const { w } = await managed("story");
    await openView(w);
    findAll(
      view(w),
      (n) =>
        n.className === "ses-row" &&
        (n.attrs["aria-label"] ?? "").startsWith("Ouvrir la session 2"),
    )[0]!.click();
    await w.advance(500);
    expect(w.host.log.tools.at(-1)).toMatchObject({
      name: "sc_session_current",
      args: { id: "s_fixture_2" },
    });
    const t = text(w);
    expect(t).toContain("Session 2 (terminée)");
    expect(t).toContain("Waste Disposal | Easy");
    expect(t).toContain("sans marqueur de fin");
    expect(button(w, "Copier le bilan")).not.toBeNull();
    // The list is still there, with the selected row marked.
    expect(rowNumbers(w)).toEqual(["4", "3", "2", "1"]);
    const sel = findAll(
      view(w),
      (n) => n.className === "ses-row" && n.attrs["aria-pressed"] === "true",
    );
    expect(sel).toHaveLength(1);
    // Another row replaces the detail; "Retour à la liste" is not needed in the view.
    expect(button(w, "Retour à la liste")?.attrs["data-hidden"] ?? "1").toBe("1");
    expect(isShown(button(w, "Retour à la liste")!)).toBe(false);
  });

  it("Given the selected session is deleted, Then its detail goes with it", async () => {
    const { w } = await managed("story");
    await openView(w);
    const row = findAll(
      view(w),
      (n) =>
        n.className === "ses-row" &&
        (n.attrs["aria-label"] ?? "").startsWith("Ouvrir la session 3"),
    )[0]!;
    row.click();
    await w.advance(500);
    expect(text(w)).toContain("Session 3 (terminée)");
    await click(w, "Supprimer la session 3", 100);
    await click(w, "Confirmer la suppression de la session 3", 1500);
    expect(text(w)).not.toContain("Session 3 (terminée)");
    expect(rowNumbers(w)).toEqual(["4", "2", "1"]);
  });

  it("Given the statistics across sessions, Then they are on the view with the list", async () => {
    const { w } = await managed("story");
    await openView(w);
    expect(text(w)).toMatch(/4 sessions · 24 trajets/);
  });
});

describe("Feature: the amounts of the view follow the balance choice", () => {
  it("Given the balance hidden, Then no amount is anywhere in the view; shown, the results appear; hidden again, they are gone from every node", async () => {
    const { w } = await managed("story");
    await openView(w);
    const row = findAll(
      view(w),
      (n) =>
        n.className === "ses-row" &&
        (n.attrs["aria-label"] ?? "").startsWith("Ouvrir la session 2"),
    )[0]!;
    row.click();
    await w.advance(500);
    for (const a of AMOUNTS) {
      expect(amountIn(everything(view(w)), a), `amount ${a} on a hidden balance`).toBe(false);
    }
    expect(text(w)).toContain("Montants masqués");
    await click(w, "Afficher le solde", 3 * SECOND);
    expect(amountIn(text(w), 310_500)).toBe(true); // the detail's result
    expect(amountIn(text(w), 579_000)).toBe(true); // the statistics' total
    expect(
      w.host.log.tools.filter((t) => t.args["include_balance"] === true).length,
    ).toBeGreaterThan(0);
    await click(w, "Masquer le solde", 3 * SECOND);
    for (const a of AMOUNTS) {
      expect(amountIn(everything(view(w)), a), `amount ${a} after hiding`).toBe(false);
    }
    // The actions never say an amount, whatever the choice.
    await click(w, "Archiver la session 3", 1500);
    expect(said(w)).not.toMatch(/\d{3}/);
  });
});
