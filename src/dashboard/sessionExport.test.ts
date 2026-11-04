/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { sessionDebriefNormalize, sessionExportText } from "./sessionPanel.js";
import { sessionBar, sessionToolAnswer } from "./testing/sessionScenario.js";
import {
  findAll,
  findButton,
  isShown,
  startPage,
  visibleText,
  type PageWorld,
} from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";

/**
 * Feature: the "Copier le bilan" control of the session detail. The text comes from the server (sc_session_export, tested
 * on its own); here the page is run as it ships against the fake host: copy first, a selectable fallback when the host
 * refuses the clipboard, a file only when the page can make one, and no amount that the balance choice does not allow.
 */

const SECOND = 1000;
const NB = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const text = (w: PageWorld) => NB(visibleText(w.root));
const NET = /310\D?500/;
const BALANCES = /216\D?000|526\D?500/;

async function page(opts: {
  clipboard?: "refuses" | string[];
  downloads?: { name: string; mime: string; text: string }[];
}) {
  const scenario = new Scenario();
  const w = await startPage({ scenario, ...opts });
  w.host.overrides.poll = (base: any, include: boolean) => ({
    ...base,
    sessions: sessionBar(scenario.epoch + scenario.t, include, "story"),
  });
  w.host.overrides.tool = (name, args) =>
    sessionToolAnswer(name, args, scenario.epoch + scenario.t);
  await w.advance(5 * SECOND);
  return w;
}

async function openDetail(w: PageWorld) {
  findAll(w.root, (n) => n.tag === "button" && n.textContent.startsWith("Sessions"))[0]?.click?.();
  await w.advance(500);
  findAll(
    w.root,
    (n) => n.tag === "button" && n.attrs["aria-label"]?.startsWith("Ouvrir la session 2"),
  )[0]?.click?.();
  await w.advance(500);
}

async function showBalance(w: PageWorld) {
  findAll(w.root, (n) => n.tag === "button" && n.textContent === "Afficher le solde")[0]?.click?.();
  await w.advance(3 * SECOND);
}

const pre = (w: PageWorld) => findAll(w.root, (n) => n.className === "ses-export-pre")[0]!;
const debriefCalls = (w: PageWorld) =>
  w.host.log.tools.filter((t) => t.name === "sc_session_export");
const control = (w: PageWorld, label: string) =>
  findAll(w.root, (n) => n.tag === "button" && n.textContent === label)[0];

describe("Feature: the pure part", () => {
  it("Given an answer, Then the View rebuilds two bounded, clean strings", () => {
    const out = sessionDebriefNormalize(
      {
        markdown: "# Bilan\u202e\u200b\nligne\u0007",
        csv: "a,b\r\n" + "x".repeat(500_000),
        money_included: false,
        balances_included: false,
        truncated: true,
        trips_total: 12,
      },
      false,
      false,
    );
    expect(out.markdown).toBe("# Bilan\nligne");
    expect(out.csv.length).toBe(400_000);
    expect(out.csv.startsWith("a,b\r\n")).toBe(true);
    expect(out.truncated).toBe(true);
    expect(sessionExportText(42, 10)).toBe("");
  });

  it("Given an answer with amounts the View may not draw, or balances nobody asked for, Then it is dropped", () => {
    const base = { markdown: "# x", csv: "", truncated: false, trips_total: 1 };
    expect(sessionDebriefNormalize({ ...base, money_included: true }, false, false)).toBeNull();
    expect(
      sessionDebriefNormalize(
        { ...base, money_included: true, balances_included: true },
        true,
        false,
      ),
    ).toBeNull();
    expect(
      sessionDebriefNormalize(
        { ...base, money_included: false, balances_included: true },
        false,
        true,
      ),
    ).toBeNull();
    expect(
      sessionDebriefNormalize(
        { ...base, money_included: true, balances_included: true },
        true,
        true,
      ),
    ).not.toBeNull();
    for (const bad of [null, 3, "x", [], {}, { markdown: 3 }, { markdown: "" }])
      expect(sessionDebriefNormalize(bad, true, true)).toBeNull();
  });
});

describe("Feature: copy the report", () => {
  it("Given the balance is hidden, When 'Copier le bilan' is pressed, Then the clipboard gets a report with no amount", async () => {
    const copied: string[] = [];
    const w = await page({ clipboard: copied });
    await openDetail(w);
    expect(isShown(findButton(w.root, "Copier le bilan"))).toBe(true);
    expect(text(w)).toContain("Solde masqué : le bilan ne contient aucun montant");
    expect(text(w)).toContain("Relis-le avant de le partager.");
    // the start-balance choice does not exist while the balance is hidden
    expect(isShown(control(w, "Soldes de départ et final : non")!)).toBe(false);
    findButton(w.root, "Copier le bilan").click();
    await w.advance(500);
    expect(debriefCalls(w).at(-1)!.args).toEqual({
      id: "s_fixture_2",
      include_balance: false,
      include_start_balance: false,
    });
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("# Bilan de la session 2");
    expect(NB(copied[0]!)).not.toMatch(NET);
    expect(copied[0]).not.toMatch(BALANCES);
    expect(text(w)).toContain("Copié dans le presse-papiers.");
    // copied: nothing is left on screen
    expect(isShown(pre(w))).toBe(false);
    expect(pre(w).textContent).toBe("");
  });

  it.each([
    ["refuses", "refuses" as const],
    ["none", undefined],
  ])(
    "Given a host that gives no clipboard (%s), Then the text is shown selected and the player is told to press Ctrl+C",
    async (_n, clipboard) => {
      const w = await page(clipboard ? { clipboard } : {});
      await openDetail(w);
      findButton(w.root, "Copier le bilan").click();
      await w.advance(500);
      expect(isShown(pre(w))).toBe(true);
      expect(pre(w).textContent).toContain("# Bilan de la session 2");
      expect(w.selected()).toBe(pre(w));
      expect(text(w)).toContain("fais Ctrl+C");
    },
  );

  it("Given the balance is shown, Then the report has the amounts but not the balances, until the player asks", async () => {
    const copied: string[] = [];
    const w = await page({ clipboard: copied });
    await showBalance(w);
    await openDetail(w);
    expect(text(w)).toContain(
      "Le bilan contient des montants, mais pas les soldes de départ et final. Relis-le avant de le partager.",
    );
    findButton(w.root, "Copier le bilan").click();
    await w.advance(500);
    expect(NB(copied[0]!)).toMatch(NET);
    expect(copied[0]).not.toMatch(BALANCES);
    expect(debriefCalls(w).at(-1)!.args).toMatchObject({
      include_balance: true,
      include_start_balance: false,
    });
    // the explicit choice, per use
    control(w, "Soldes de départ et final : non")!.click();
    await w.advance(50);
    expect(text(w)).toContain("Le bilan contient des montants et les soldes de départ et final.");
    expect(control(w, "Soldes de départ et final : oui")!.attrs["aria-pressed"]).toBe("true");
    findButton(w.root, "Copier le bilan").click();
    await w.advance(500);
    expect(debriefCalls(w).at(-1)!.args).toMatchObject({
      include_balance: true,
      include_start_balance: true,
    });
    expect(NB(copied[1]!)).toMatch(BALANCES);
  });
});

describe("Feature: a text that must not outlive the balance choice", () => {
  it("Given a report shown for hand copying, When the balance is hidden again, Then the text, the message and the start-balance choice are gone", async () => {
    const w = await page({ clipboard: "refuses" });
    await showBalance(w);
    await openDetail(w);
    control(w, "Soldes de départ et final : non")!.click();
    await w.advance(50);
    findButton(w.root, "Copier le bilan").click();
    await w.advance(500);
    expect(NB(pre(w).textContent)).toMatch(NET);
    expect(pre(w).textContent).toMatch(BALANCES);
    // hide the balance again
    const hide = findAll(
      w.root,
      (n) => n.tag === "button" && /Masquer le solde/.test(n.textContent),
    )[0];
    expect(hide).toBeTruthy();
    hide!.click();
    await w.advance(3 * SECOND);
    const t = text(w);
    expect(t).not.toMatch(NET);
    expect(t).not.toMatch(BALANCES);
    expect(pre(w).textContent).toBe("");
    expect(isShown(pre(w))).toBe(false);
    // (the polite zone of the page may still say "Copie impossible", it holds no text of the report)
    const msg = findAll(
      w.root,
      (n) => n.className === "ses-note" && n.attrs["role"] === "status",
    )[0];
    expect(msg!.textContent).toBe("");
    // and a new report starts from the plain choice
    await showBalance(w);
    expect(control(w, "Soldes de départ et final : non")).toBeTruthy();
  });

  it("Given the player leaves the detail, Then the text is cleared and the next session starts without the balances", async () => {
    const w = await page({ clipboard: "refuses" });
    await openDetail(w);
    findButton(w.root, "Copier le bilan").click();
    await w.advance(500);
    expect(pre(w).textContent).not.toBe("");
    findButton(w.root, "Retour à la liste").click();
    await w.advance(50);
    expect(pre(w).textContent).toBe("");
    expect(isShown(pre(w))).toBe(false);
  });

  it("Given a host that answers with amounts although the balance is hidden, Then nothing is copied or shown", async () => {
    const copied: string[] = [];
    const w = await page({ clipboard: copied });
    w.host.overrides.tool = (name, args) =>
      name === "sc_session_export"
        ? { ...sessionToolAnswer(name, { ...args, include_balance: true }, 0) }
        : sessionToolAnswer(name, args, 0);
    await openDetail(w);
    findButton(w.root, "Copier le bilan").click();
    await w.advance(500);
    expect(copied).toEqual([]);
    expect(isShown(pre(w))).toBe(false);
    expect(text(w)).toContain("Bilan impossible");
    expect(text(w)).not.toMatch(NET);
  });

  it("Given the tool fails, Then the control says so and keeps working", async () => {
    const w = await page({ clipboard: [] });
    w.host.overrides.tool = (name, args) =>
      name === "sc_session_export"
        ? new Error("the session file is busy")
        : sessionToolAnswer(name, args, 0);
    await openDetail(w);
    findButton(w.root, "Copier le bilan").click();
    await w.advance(500);
    expect(text(w)).toContain("Bilan impossible : ");
    expect(isShown(findButton(w.root, "Copier le bilan"))).toBe(true);
  });
});

describe("Feature: files, only when the page can make one", () => {
  it("Given a page that cannot make files, Then the copy control is there and the download controls are not", async () => {
    const w = await page({ clipboard: [] });
    await openDetail(w);
    expect(isShown(findButton(w.root, "Copier le bilan"))).toBe(true);
    expect(isShown(findButton(w.root, "Télécharger .md"))).toBe(false);
    expect(isShown(findButton(w.root, "Télécharger .csv"))).toBe(false);
    expect(isShown(findButton(w.root, "Télécharger .csv (Excel FR)"))).toBe(false);
  });

  it("Given a page that can, Then .md and .csv are offered as files, the CSV with a byte-order mark for spreadsheets", async () => {
    const files: { name: string; mime: string; text: string }[] = [];
    const w = await page({ clipboard: [], downloads: files });
    await openDetail(w);
    findButton(w.root, "Télécharger .md").click();
    await w.advance(500);
    findButton(w.root, "Télécharger .csv").click();
    await w.advance(500);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ name: "bilan-session-2.md", mime: "text/markdown" });
    expect(files[0]!.text).toContain("# Bilan de la session 2");
    expect(files[1]).toMatchObject({ name: "bilan-session-2.csv", mime: "text/csv" });
    expect(files[1]!.text.startsWith("\ufeffsession,ended_at,kind,label,scu\r\n")).toBe(true);
    expect(files.every((f) => !NET.test(f.text))).toBe(true);
    expect(text(w)).toContain("Si rien ne s’enregistre");
    // a file is never the only way: nothing is kept on screen, the copy button is still there
    expect(isShown(pre(w))).toBe(false);
    expect(isShown(findButton(w.root, "Copier le bilan"))).toBe(true);
  });
});

/** Every node of the page, hidden or not, with the text it holds. */
const allText = (w: PageWorld) => {
  const parts: string[] = [];
  const walk = (n: any) => {
    parts.push(n.textContent ?? "");
    for (const c of n.children ?? []) walk(c);
  };
  walk(w.root);
  return NB(parts.join("\n"));
};

describe("Feature: a report is gone from the page, not just hidden, whenever the player lets go of it", () => {
  const withReport = async () => {
    const w = await page({ clipboard: "refuses" });
    await showBalance(w);
    await openDetail(w);
    control(w, "Soldes de départ et final : non")!.click();
    await w.advance(50);
    findButton(w.root, "Copier le bilan").click();
    await w.advance(500);
    expect(NB(pre(w).textContent)).toMatch(NET);
    expect(pre(w).textContent).toMatch(BALANCES);
    return w;
  };
  const gone = (w: PageWorld) => {
    expect(pre(w).textContent).toBe("");
    // the whole DOM, hidden nodes included: no amount of the report, no balance, no copy of the text
    const all = allText(w);
    expect(all).not.toContain("# Bilan de la session 2");
    expect(all).not.toContain("Fin (UTC)");
    expect(all).not.toContain("au dernier relevé");
    // (the page's own polite zone may still say "Copie impossible": it holds no text of the report)
    const msg = findAll(
      w.root,
      (n) => n.className === "ses-note" && n.attrs["role"] === "status",
    )[0];
    expect(msg!.textContent).toBe("");
  };

  it("Given the menu is closed, Then the text is not left in the DOM", async () => {
    const w = await withReport();
    findButton(w.root, "Fermer").click();
    await w.advance(100);
    gone(w);
  });

  it("Given the balance is hidden again with the menu closed, Then it is gone and does not come back when the menu opens", async () => {
    const w = await withReport();
    findButton(w.root, "Fermer").click();
    await w.advance(100);
    findAll(
      w.root,
      (n) => n.tag === "button" && /Masquer le solde/.test(n.textContent),
    )[0]!.click();
    await w.advance(3 * SECOND);
    gone(w);
    expect(allText(w)).not.toMatch(BALANCES);
    findAll(w.root, (n) => n.tag === "button" && n.textContent.startsWith("Sessions"))[0]!.click();
    await w.advance(500);
    expect(pre(w).textContent).toBe("");
    expect(allText(w)).not.toMatch(NET);
  });

  it("Given the player leaves the detail, Then it is gone", async () => {
    const w = await withReport();
    findButton(w.root, "Retour à la liste").click();
    await w.advance(100);
    gone(w);
  });

  it("Given the page is hidden for good (pagehide), Then it is gone", async () => {
    const w = await withReport();
    w.firePageHide();
    await w.advance(100);
    gone(w);
  });
});

describe("Feature: the CSV for Excel in French", () => {
  it("Given the 'Excel FR' download, Then the server is asked for the semicolon file and it is offered with a byte-order mark", async () => {
    const files: { name: string; mime: string; text: string }[] = [];
    const w = await page({ clipboard: [], downloads: files });
    await openDetail(w);
    findButton(w.root, "Télécharger .csv (Excel FR)").click();
    await w.advance(500);
    expect(debriefCalls(w).at(-1)!.args).toMatchObject({ csv_delimiter: ";" });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: "bilan-session-2.csv", mime: "text/csv" });
    expect(files[0]!.text.startsWith("\uFEFFsession;ended_at;kind;label;scu\r\n")).toBe(true);
    // the plain button asks for no delimiter
    findButton(w.root, "Télécharger .csv").click();
    await w.advance(500);
    expect(debriefCalls(w).at(-1)!.args).not.toHaveProperty("csv_delimiter");
  });
});
