/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { healthNormalize, healthRows, healthTodo, healthLegend } from "./healthPanel.js";
import { healthSection, type HealthVariant } from "./testing/healthScenario.js";
import {
  FakeNode,
  FakeBus,
  VirtualClock,
  findAll,
  findButton,
  isShown,
  startPage,
  visibleText,
  type PageWorld,
} from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import { transportLedger } from "./testing/ledgerScenario.js";
import { dashboardHtml, pageCss, viewScript } from "./page.js";
import * as L from "./viewLogic.js";
import * as P from "./sessionPanel.js";

/**
 * Feature: the health strip and the legend. The pure part under Node, then the assembled page, as it ships, against the
 * fake host. The data are the server's (made up); the View distrusts them.
 */

const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const SECOND = 1000;
const LIB = { ...L, ...P };
const NB = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

const rowsFor = (variant: HealthVariant, poll: any = {}, ctx: any = {}) => {
  const h = healthNormalize(healthSection(variant, NOW));
  return healthRows(LIB, { state: "live", ...poll }, h, { showBalance: false, now: NOW, ...ctx });
};
const kinds = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.id, r.kind]));

describe("Feature: the View distrusts the health section", () => {
  it("Given anything that is not a version 1 section, Then it is dropped", () => {
    for (const bad of [null, undefined, 3, "x", [], {}, { v: 2 }, { v: 1 }]) {
      expect(healthNormalize(bad)).toBeNull();
    }
  });

  it("Given an unknown code, Then the whole section is dropped, never half-trusted", () => {
    const ok = healthSection("ok", NOW) as any;
    expect(healthNormalize({ ...ok, log: "<script>" })).toBeNull();
    expect(healthNormalize({ ...ok, registration: "maybe" })).toBeNull();
    expect(healthNormalize({ ...ok, sessions: "yes" })).toBeNull();
  });

  it("Given hostile optional fields, Then they are dropped and extra fields are not copied", () => {
    const h = healthNormalize({
      ...(healthSection("ok", NOW) as any),
      via: "C:\\Users\\jdoe-secret",
      label: "C:\\Users\\jdoe-secret\\Game.log",
      saved_at: "yesterday<b>",
      extra: "x".repeat(5000),
      balance: 123456,
    });
    expect(h).toEqual({ v: 1, log: "ok", registration: "seen", sessions: "on" });
  });

  it("Given a label from the fixed list, Then it is kept", () => {
    expect(healthNormalize(healthSection("ok", NOW))?.label).toBe("LIVE/Game.log");
    expect(healthNormalize(healthSection("custom", NOW))?.label).toBe("custom");
  });
});

describe("Feature: the rows say what is wired, per combination", () => {
  it("Given everything wired, Then every line is ok or a fact, and nothing is to do", () => {
    const rows = rowsFor("ok", { connection: { state: "online" }, ledger: { status: "ok" } });
    expect(kinds(rows)).toEqual({
      telemetry: "ok",
      log: "ok",
      registration: "ok",
      connection: "ok",
      journal: "ok",
      sessions: "ok",
      balance: "info",
      data: "info",
    });
    expect(healthTodo(rows)).toEqual([]);
  });

  it("Given telemetry off, Then the one thing to do is the command, and the log is not claimed readable", () => {
    const rows = rowsFor("off", { state: "off" });
    const todo = healthTodo(rows);
    expect(todo.map((r: any) => r.id)).toEqual(["telemetry"]);
    expect(todo[0].fix.cmd).toBe("npm run telemetry -- enable");
    expect(kinds(rows).log).toBe("wait");
    expect(kinds(rows).sessions).toBe("info");
  });

  it("Given no game log, Then ONE thing is to do for the log, and the connection and journal lines point to it", () => {
    const rows = rowsFor("nolog");
    const todo = healthTodo(rows);
    expect(todo.map((r: any) => r.id)).toEqual(["log"]);
    expect(todo[0].fix.cmd).toContain("SC_INSTALL_DIR");
    expect(todo[0].detail).toContain("renvoi pour inactivité");
    expect(rows.find((r: any) => r.id === "connection").kind).toBe("todo");
    expect(rows.find((r: any) => r.id === "connection").detail).toContain("journal du jeu");
  });

  it("Given a log that cannot be read, Then the fix names the setting that is used, and not its value", () => {
    const rows = rowsFor("unreadable", { state: "waiting" });
    const log = rows.find((r: any) => r.id === "log");
    expect(log.kind).toBe("todo");
    // One plain sentence in the line; the setting that is used and what is read sit in the fix, behind the fold.
    expect(log.detail).toBe(
      "Game.log introuvable. Lance le jeu une fois, ou corrige le dossier du jeu.",
    );
    expect(log.fix.text).toContain("SC_INSTALL_DIR");
    expect(log.fix.text).toContain("LIVE/Game.log");
    expect(JSON.stringify(rows)).not.toMatch(/Users/);
  });

  it("Given a log configured by file, Then the line speaks of SC_GAME_LOG_PATH and a custom file", () => {
    const log = rowsFor("custom").find((r: any) => r.id === "log");
    expect(log.detail).toContain("SC_GAME_LOG_PATH");
    expect(log.detail).toContain("fichier .log personnalisé");
  });

  it("Given a game started without the variable, Then telemetry and registration share ONE fix", () => {
    const rows = rowsFor("unregistered", { state: "game_without_telemetry" });
    expect(kinds(rows).telemetry).toBe("todo");
    expect(kinds(rows).registration).toBe("todo");
    const todo = healthTodo(rows);
    expect(todo).toHaveLength(1);
    expect(todo[0].fix.text).toContain("RSI Launcher");
    expect(todo[0].fix.cmd).toBe("npm run telemetry -- status");
  });

  it("Given the registration is not known yet, Then it is waiting, not a problem", () => {
    const rows = rowsFor("ok", { state: "waiting" }, {});
    const waiting = healthNormalize({
      ...(healthSection("ok", NOW) as any),
      registration: "unknown",
    });
    const reg = healthRows(LIB, { state: "waiting" }, waiting, { showBalance: false, now: NOW });
    expect(reg.find((r: any) => r.id === "registration").kind).toBe("wait");
    expect(kinds(rows).telemetry).toBe("wait");
  });

  it.each<[HealthVariant, string]>([
    ["ok", "ok"],
    ["sessionsoff", "info"],
    ["degraded", "todo"],
    ["readonly", "todo"],
  ])("Given the sessions situation %s, Then its line is %s", (variant, kind) => {
    expect(kinds(rowsFor(variant)).sessions).toBe(kind);
  });

  it("Given sessions that are off, Then the line says which setting and a deliberate choice is not a to-do", () => {
    const row = rowsFor("sessionsoff").find((r: any) => r.id === "sessions");
    expect(row.detail).toContain("SC_SESSIONS");
    expect(healthTodo(rowsFor("sessionsoff"))).toEqual([]);
  });

  it("Given sessions that should run but did not answer, Then the line is a fact that does not blame SC_SESSIONS", () => {
    const h = healthNormalize({ ...(healthSection("ok", NOW) as any), sessions: "unavailable" });
    const row = healthRows(LIB, { state: "live" }, h, { showBalance: false, now: NOW }).find(
      (r: any) => r.id === "sessions",
    );
    expect(row.kind).toBe("info");
    expect(row.detail).not.toContain("SC_SESSIONS");
    expect(healthTodo([row])).toEqual([]);
  });

  it("Given a degraded write, Then the line says they stay in memory and when the last save was", () => {
    const row = rowsFor("degraded").find((r: any) => r.id === "sessions");
    expect(row.detail).toContain("en mémoire");
    expect(row.fix.text).toContain("Dernière écriture");
  });

  it("Given the balance, Then the line says what the button reveals and what stays local, in both states", () => {
    for (const showBalance of [false, true]) {
      const row = rowsFor("ok", {}, { showBalance }).find((r: any) => r.id === "balance");
      expect(row.detail).toContain(showBalance ? "Masquer le solde" : "Afficher le solde");
      expect(row.detail).toContain(
        showBalance ? "ET des outils de Claude" : "pour les outils de Claude",
      );
      expect(row.detail).toContain("mémoire de ce processus du serveur");
      expect(row.detail).not.toContain("s’il les demande");
      // Said in both states: Claude's tools give the amounts too unless the server starts hidden.
      expect(row.detail).toContain("SC_BALANCE=hidden");
      expect(row.detail).toContain("fichier local");
      expect(row.detail.startsWith(showBalance ? "Affiché" : "Masqué")).toBe(true);
    }
  });

  it("Given the ledger fails to load while the log is fine, Then the journal line is a to-do with its own fix", () => {
    const row = rowsFor("ok", { ledger: { status: "unreadable" } }).find(
      (r: any) => r.id === "journal",
    );
    expect(row.kind).toBe("todo");
    expect(row.fix.text).toContain("SC_INSTALL_DIR");
  });

  it("Given everything broken at once, Then at most four lines are offered and each carries its fix", () => {
    const rows = rowsFor("everything", { state: "game_without_telemetry" });
    const todo = healthTodo(rows);
    expect(todo.length).toBeLessThanOrEqual(4);
    expect(todo.length).toBeGreaterThanOrEqual(2);
    for (const r of todo) expect(r.fix, r.id).toBeTruthy();
  });

  it("Given the legend, Then it has the five words and a glyph for each (colour is never the only signal)", () => {
    const legend = healthLegend();
    expect(legend.map((t) => t[1])).toEqual(["Mesuré", "Calculé", "Estimé", "Probable", "Inconnu"]);
    expect(new Set(legend.map((t) => t[0])).size).toBe(5);
  });
});

// ------------------------------------------------------------------------------------------------ the assembled page

const text = (w: PageWorld) => NB(visibleText(w.root));

const WIRED: HealthVariant[] = ["ok", "sessionsoff", "custom", "degraded"];

async function page(
  variant: HealthVariant | null,
  options: Parameters<typeof startPage>[0] & { fullscreen?: boolean } = {},
  poll: (base: any) => any = (b) => b,
) {
  const { fullscreen, ...startOptions } = options;
  const scenario = options.scenario ?? new Scenario();
  // Where the log is read and the game is there, the connection and the ledger exist: that is what "wired" looks like.
  if (variant && WIRED.includes(variant) && !scenario.forced) {
    scenario.connection = {
      state: "online",
      since: new Date(scenario.now).toISOString(),
      code: null,
      reason: null,
    };
    scenario.ledger = (include, nowMs) => transportLedger(nowMs, scenario.epoch, include, "story");
  }
  const w = await startPage({ ...startOptions, scenario });
  if (fullscreen)
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "fullscreen" },
    });
  // A wired setup is past the menus: the stream is live (30 s into the story).
  if (variant && WIRED.includes(variant) && !scenario.forced) await w.advance(30 * SECOND);
  w.host.overrides.poll = (base: any) => {
    const next = poll(base);
    return variant
      ? { ...next, health: healthSection(variant, scenario.epoch + scenario.t) }
      : next;
  };
  return w;
}

const FLAG = "sc-copilot-help-seen";
const isOpen = (w: PageWorld) => text(w).includes("Comment lire ce tableau");
/** The strip is one line ("N réglages à faire · Voir ▸") until the player unfolds it. */
const unfold = async (w: PageWorld) => {
  findButton(w.root, "Voir ▸").click();
  await w.advance(1500);
};

describe("Feature: first open, the legend; afterwards, a quiet '?'", () => {
  it("Given a first open in the compact view with everything wired, Then nothing opens (the dials stay first); the '?' brings the legend", async () => {
    const w = await page("ok", { storage: new Map() });
    await w.advance(5 * SECOND);
    expect(isOpen(w)).toBe(false);
    expect(text(w)).not.toContain("Tout est branché");
    findAll(w.root, (n) => n.tag === "button" && n.textContent === "?")[0]!.click();
    await w.advance(100);
    expect(text(w)).toContain("Tout est branché");
    expect(isOpen(w)).toBe(true);
  });

  it("Given a first open with something to set up in the compact view, Then it opens for that, and 'Compris' keeps ONE flag", async () => {
    const store = new Map<string, string>();
    const w = await page("nolog", { storage: store });
    await w.advance(5 * SECOND);
    expect(isOpen(w)).toBe(true);
    findButton(w.root, "Compris").click();
    await w.advance(100);
    expect(isOpen(w)).toBe(false);
    expect([...store.entries()]).toEqual([[FLAG, "1"]]);
  });

  it("Given a first open with everything wired in full screen, Then 'Tout est branché' and the legend show, with the five words", async () => {
    const w = await page("ok", { storage: new Map(), fullscreen: true });
    await w.advance(5 * SECOND);
    const t = text(w);
    expect(t).toContain("Tout est branché");
    for (const word of ["Mesuré", "Calculé", "Estimé", "Probable", "Inconnu"]) {
      expect(t).toContain(word);
    }
    expect(t).toContain("La couleur n’est jamais le seul signal");
  });

  it("Given nothing to set up but a game that has not started, Then it says 'Rien à régler pour l’instant', not 'Tout est branché'", async () => {
    const scenario = new Scenario();
    scenario.forced = "waiting";
    const w = await page("ok", { scenario, storage: new Map(), fullscreen: true });
    await w.advance(8 * SECOND);
    expect(text(w)).toContain("Rien à régler pour l’instant");
    expect(text(w)).not.toContain("Tout est branché");
  });

  it("Given 'Compris', Then the block closes and the browser keeps ONE flag, nothing else", async () => {
    const store = new Map<string, string>();
    const w = await page("ok", { storage: store });
    await w.advance(5 * SECOND);
    findButton(w.root, "Compris").click();
    await w.advance(200);
    expect(isOpen(w)).toBe(false);
    expect([...store.entries()]).toEqual([[FLAG, "1"]]);
  });

  it("Given the flag from an earlier open, Then everything wired shows NOTHING, and the '?' brings the block back", async () => {
    const store = new Map([[FLAG, "1"]]);
    const w = await page("ok", { storage: store });
    await w.advance(5 * SECOND);
    expect(isOpen(w)).toBe(false);
    expect(text(w)).not.toContain("Tout est branché");
    const help = findAll(w.root, (n) => n.tag === "button" && n.textContent === "?")[0]!;
    expect(isShown(help)).toBe(true);
    expect(help.attrs["aria-label"]).toContain("comment le lire");
    expect(help.attrs["aria-expanded"]).toBe("false");
    help.click();
    await w.advance(100);
    expect(help.attrs["aria-expanded"]).toBe("true");
    expect(text(w)).toContain("Tout est branché");
    expect(isOpen(w)).toBe(true);
    help.click();
    await w.advance(100);
    expect(isOpen(w)).toBe(false);
  });

  it.each([
    ["whose storage throws", { storage: "throws" as const }],
    ["with no storage at all", {}],
  ])(
    "Given a browser %s and nothing to set up, Then the legend does NOT push the cockpit down at each open",
    async (_n, options) => {
      const w = await page("ok", options);
      await w.advance(5 * SECOND);
      expect(isOpen(w)).toBe(false);
      expect(text(w)).not.toContain("À régler");
      // The "?" still brings it, and closing it again stays closed for the session (nothing could be stored).
      findAll(w.root, (n) => n.tag === "button" && n.textContent === "?")[0]!.click();
      await w.advance(100);
      expect(isOpen(w)).toBe(true);
      findButton(w.root, "Compris").click();
      await w.advance(5 * SECOND);
      expect(isOpen(w)).toBe(false);
      expect(w.host.log.polls.length).toBeGreaterThanOrEqual(2);
    },
  );

  it("Given a browser whose storage throws and something to set up, Then the help opens for it, and 'Compris' keeps it closed in memory", async () => {
    const w = await page("nolog", { storage: "throws" });
    await w.advance(5 * SECOND);
    expect(isOpen(w)).toBe(true);
    findButton(w.root, "Compris").click();
    await w.advance(3 * SECOND);
    expect(isOpen(w)).toBe(false);
    expect(text(w)).toMatch(/\d réglages? à faire/);
  });

  it("Given a working storage, Then the legend opens once and the flag decides, with or without something to set up", async () => {
    const first = await page("nolog", { storage: new Map() });
    await first.advance(5 * SECOND);
    expect(isOpen(first)).toBe(true);
    const seen = await page("nolog", { storage: new Map([[FLAG, "1"]]) });
    await seen.advance(5 * SECOND);
    expect(isOpen(seen)).toBe(false);
  });

  it("Given 'Compris', 'Plus tard' or the '?', Then the focus goes to the '?' button (the pressed one disappears)", async () => {
    const w = await page("nolog", { storage: new Map() });
    await w.advance(5 * SECOND);
    const help = findAll(w.root, (n) => n.tag === "button" && n.textContent === "?")[0]!;
    findButton(w.root, "Compris").click();
    await w.advance(100);
    expect(FakeNode.focused).toBe(help);
    FakeNode.focused = null;
    findButton(w.root, "Plus tard").click();
    await w.advance(100);
    expect(FakeNode.focused).toBe(help);
    help.click();
    await w.advance(100);
    FakeNode.focused = null;
    help.click(); // closes it again
    await w.advance(100);
    expect(FakeNode.focused).toBe(help);
  });

  it("Given the line to copy for the log, Then it has no trailing comma and the text says to add one if another line follows", async () => {
    const w = await page("nolog", { storage: new Map([[FLAG, "1"]]) });
    await w.advance(5 * SECOND);
    const row = rowsFor("nolog").find((r: any) => r.id === "log");
    expect(row.fix.cmd).not.toMatch(/,\s*$/);
    expect(row.fix.text).toContain("une virgule si une autre ligne suit");
    await unfold(w);
    expect(text(w)).toContain("une virgule si une autre ligne suit");
  });

  it("Given the 'Voir' control, Then it names what it controls, its arrow is hidden from its name, and the focus stays on it", async () => {
    const w = await page("nolog", { storage: new Map([[FLAG, "1"]]) });
    await w.advance(5 * SECOND);
    const b = findAll(w.root, (n) => n.tag === "button" && n.textContent === "Voir ▸")[0]!;
    const list = findAll(w.root, (n) => n.className === "hl-list")[0]!;
    expect(b.attrs["aria-controls"]).toBe(list.attrs["id"]);
    expect(b.children[0]!.textContent).toBe("Voir");
    expect(b.children[1]!.attrs["aria-hidden"]).toBe("true");
    FakeNode.focused = null;
    b.click();
    await w.advance(100);
    expect(FakeNode.focused).toBe(b);
    expect(b.textContent).toBe("Masquer ▴");
    expect(b.attrs["aria-expanded"]).toBe("true");
  });

  it("Given a server without health (an older one), Then there is no strip and no '?'", async () => {
    const w = await page(null, { storage: new Map() });
    await w.advance(5 * SECOND);
    expect(isOpen(w)).toBe(false);
    const help = findAll(w.root, (n) => n.tag === "button" && n.textContent === "?")[0]!;
    expect(isShown(help)).toBe(false);
  });

  it("Given the first poll has not come back yet, Then nothing flashes 'missing'", async () => {
    const w = await page("nolog", { storage: new Map([[FLAG, "1"]]) });
    await w.advance(1);
    expect(text(w)).not.toContain("À régler");
  });
});

describe("Feature: what is missing shows with its fix, once, and nothing when all is well", () => {
  it("Given no game log, Then the block names what is lost and offers the line to copy", async () => {
    const w = await page("nolog", { storage: new Map([[FLAG, "1"]]) });
    await w.advance(5 * SECOND);
    // Folded: one line and a control, nothing of the fix yet.
    const folded = text(w);
    expect(folded).toContain("1 réglage à faire");
    expect(folded).not.toContain("renvoi pour inactivité");
    const fold = findButton(w.root, "Voir ▸");
    expect(fold.attrs["aria-expanded"]).toBe("false");
    await unfold(w);
    expect(findButton(w.root, "Masquer ▴").attrs["aria-expanded"]).toBe("true");
    const t = text(w);
    expect(t).toContain("1 réglage à faire");
    expect(t).toContain("Journal du jeu (Game.log)");
    expect(t).toContain("renvoi pour inactivité");
    expect(t).toContain('"SC_INSTALL_DIR"');
    // The legend stays closed, the lines that only depend on the log are not repeated.
    expect(isOpen(w)).toBe(false);
    expect(t).not.toContain("État de connexion");
  });

  it("Given 'Copier', Then the clipboard gets exactly the command, and the confirmation uses the existing polite zone", async () => {
    const copied: string[] = [];
    const w = await page("nolog", { storage: new Map([[FLAG, "1"]]), clipboard: copied });
    await w.advance(5 * SECOND);
    findButton(w.root, "Copier").click();
    await w.advance(100);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('"SC_INSTALL_DIR": "C:\\\\Program Files');
    expect(findButton(w.root, "Copié")).toBeTruthy();
    const toast = findAll(w.root, (n) => n.className === "toast toast-top")[0]!;
    expect(toast.textContent).toContain("Copié");
    await w.advance(5 * SECOND);
    expect(findButton(w.root, "Copier")).toBeTruthy();
  });

  it.each([
    ["refuses", "refuses" as const],
    ["absent", undefined],
  ])(
    "Given a host that gives no clipboard (%s), Then the command is selected and the player is told to press Ctrl+C",
    async (_n, clipboard) => {
      const w = await page("nolog", {
        storage: new Map([[FLAG, "1"]]),
        ...(clipboard ? { clipboard } : {}),
      });
      await w.advance(5 * SECOND);
      findButton(w.root, "Copier").click();
      await w.advance(100);
      expect(w.selected()?.className).toBe("hl-cmd");
      expect(w.selected()?.textContent).toContain("SC_INSTALL_DIR");
      expect(findButton(w.root, "Ctrl+C")).toBeTruthy();
      expect(text(w)).toContain("fais Ctrl+C");
    },
  );

  it("Given telemetry off, Then the command shows once (the notice leaves its own out) and has a copy button", async () => {
    const scenario = new Scenario();
    scenario.forced = "off";
    const w = await page("off", { scenario, storage: new Map([[FLAG, "1"]]) });
    await w.advance(8 * SECOND);
    const t = text(w);
    // Folded, the strip carries no command: the notice keeps its own, so the fix is never behind a click.
    expect(t.split("npm run telemetry -- enable")).toHaveLength(2);
    expect(t).toMatch(/\d réglages? à faire/);
    await unfold(w);
    // Unfolded, the strip owns the command (with its copy button) and the notice leaves its own out: still once.
    expect(text(w).split("npm run telemetry -- enable")).toHaveLength(2);
    expect(isShown(findButton(w.root, "Copier"))).toBe(true);
  });

  it("Given a game started without the variable, Then the strip gives the launcher fix and the status command", async () => {
    const scenario = new Scenario();
    scenario.forced = "game_without_telemetry";
    const w = await page("unregistered", { scenario, storage: new Map([[FLAG, "1"]]) });
    await w.advance(8 * SECOND);
    await unfold(w);
    const t = text(w);
    expect(t).toContain("lancé sans la télémétrie");
    expect(t).toContain("npm run telemetry -- status");
    expect(t).toContain("RSI Launcher");
  });

  it("Given 'Plus tard', Then the reminders go away for this View and come back with the '?'", async () => {
    const w = await page("nolog", { storage: new Map([[FLAG, "1"]]) });
    await w.advance(5 * SECOND);
    findButton(w.root, "Plus tard").click();
    await w.advance(1500);
    expect(text(w)).not.toMatch(/réglages? à faire/);
    findAll(w.root, (n) => n.tag === "button" && n.textContent === "?")[0]!.click();
    await w.advance(100);
    expect(text(w)).toContain("1 point à régler");
    expect(text(w)).toContain("État de connexion");
  });

  it("Given sessions switched off on purpose, Then it is not a reminder, only a line behind the '?'", async () => {
    const w = await page("sessionsoff", { storage: new Map([[FLAG, "1"]]) });
    await w.advance(5 * SECOND);
    expect(text(w)).not.toContain("À régler");
    findAll(w.root, (n) => n.tag === "button" && n.textContent === "?")[0]!.click();
    await w.advance(100);
    expect(text(w)).toContain("SC_SESSIONS");
    expect(text(w)).toContain("Tout est branché");
  });

  it("Given a degraded session file, Then it IS a reminder, with its fix and the last save time", async () => {
    const w = await page("degraded", { storage: new Map([[FLAG, "1"]]) });
    await w.advance(5 * SECOND);
    await unfold(w);
    expect(text(w)).toContain("Sessions enregistrées");
    expect(text(w)).toContain("en mémoire");
    expect(text(w)).toContain("SCMCP_SESSIONS_FILE");
  });
});

describe("Feature: privacy of the strip", () => {
  it("Given every situation, Then the page shows no user name, no full path, no amount, even with the balance shown", async () => {
    for (const variant of [
      "ok",
      "nolog",
      "unreadable",
      "custom",
      "everything",
      "degraded",
    ] as const) {
      const w = await page(variant, { storage: new Map() });
      await w.advance(3 * SECOND);
      findAll(w.root, (n) => n.tag === "button" && n.textContent === "?")[0]!.click();
      await w.advance(100);
      const t = text(w);
      expect(t, variant).not.toMatch(/Users|jdoe|AppData|\\Desktop/);
      // The only path in the page is the generic example the fix gives (the standard install folder).
      expect(t.match(/[A-Z]:\\/g) ?? [], variant).toSatisfy((m: string[]) => m.length <= 1);
      expect(t, variant).not.toMatch(/\d{1,3}(?: \d{3})+ aUEC/);
    }
  });

  it("Given the strip, Then nothing in it sits in a live region and the page keeps its three", async () => {
    const w = await page("everything", { storage: new Map() });
    await w.advance(5 * SECOND);
    findAll(w.root, (n) => n.tag === "button" && n.textContent === "?")[0]!.click();
    await w.advance(100);
    const strip = findAll(w.root, (n) => n.className === "hl")[0]!;
    expect(findAll(strip, (n) => n.attrs["aria-live"] !== undefined)).toHaveLength(0);
    const live = findAll(w.root, (n) => n.attrs["aria-live"] !== undefined);
    expect(live.length).toBeLessThanOrEqual(3);
  });

  it("Given every button of the strip, Then it has a name", async () => {
    const w = await page("everything", { storage: new Map() });
    await w.advance(5 * SECOND);
    const strip = findAll(w.root, (n) => n.className === "hl")[0]!;
    for (const b of findAll(strip, (n) => n.tag === "button")) {
      expect(b.textContent || b.attrs["aria-label"]).toBeTruthy();
    }
  });

  it("Given the page, Then the strip adds no storage key but one, no network and no markup string", () => {
    const html = dashboardHtml();
    const script = viewScript();
    expect(script).toContain(FLAG);
    expect(script.match(/sc-copilot-[a-z-]+/g)!.filter((k) => /help|health/.test(k))).toEqual([
      FLAG,
    ]);
    expect(html).not.toMatch(/innerHTML|insertAdjacentHTML/);
    // No `node:` import reaches the page path (health.ts, the server side, is not among its modules).
    expect(script).not.toMatch(/["']node:[a-z_/]+["']|\brequire\(|\bimport\(/);
  });
});

describe("Feature: the other Views of the conversation show the same strip", () => {
  it("Given a follower, Then it gets the health through the channel, rebuilt, and shows the same reminder", async () => {
    const scenario = new Scenario();
    const clock = new VirtualClock(scenario.epoch);
    const bus = new FakeBus();
    const a = await page("nolog", { bus, clock, scenario, storage: new Map([[FLAG, "1"]]) });
    await clock.advance(50);
    const b = await page("nolog", { bus, clock, scenario, storage: new Map([[FLAG, "1"]]) });
    await clock.advance(6 * SECOND);
    // b leads; a only follows and still shows what is missing.
    expect(text(a)).toMatch(/\d réglages? à faire/);
    expect(text(b)).toMatch(/\d réglages? à faire/);
    await unfold(a);
    expect(text(a)).toContain("Journal du jeu (Game.log)");
  });

  it("Given a hostile peer that posts a health with a path and amounts, Then the follower draws none of it", async () => {
    const scenario = new Scenario();
    const clock = new VirtualClock(scenario.epoch);
    const bus = new FakeBus();
    const a = await page("ok", { bus, clock, scenario, storage: new Map([[FLAG, "1"]]) });
    await clock.advance(6 * SECOND);
    const evil = {
      t: "snapshot",
      id: "viewimpostor1",
      rank: scenario.epoch + 9_999_999,
      poll: {
        v: 1,
        state: "live",
        health: {
          v: 1,
          log: "unreadable",
          registration: "seen",
          sessions: "on",
          label: "C:\\Users\\jdoe-secret\\Game.log",
          via: "install_dir",
        },
      },
    };
    bus.inject("sc-copilot-dashboard-v2", {
      t: "hello",
      id: evil.id,
      rank: clock.now + 1000,
      visible: true,
    });
    await clock.advance(10);
    bus.inject("sc-copilot-dashboard-v2", { ...evil, rank: clock.now + 1000 });
    await clock.advance(1500);
    await unfold(a);
    expect(text(a)).not.toContain("jdoe-secret");
    // The snapshot WAS taken (the code "unreadable" got through), only the label that is not on the list was dropped.
    expect(text(a)).toContain("Game.log introuvable");
    expect(text(a)).toContain("mais illisible");
    expect(text(a)).toContain("Configuré (Game.log) mais illisible");
  });
});

describe("Feature: it works from 360 to 2000 px, in both themes (structure, not pixels)", () => {
  it("Given the stylesheet, Then the strip uses only tokens and wraps instead of overflowing", () => {
    // The sheet as written (the page ships it compacted: see pageCss.test.ts for what compaction keeps).
    const css = pageCss();
    const hl = css.split("\n").filter((l) => l.startsWith(".hl") || l.startsWith(".btn.quiet"));
    expect(hl.length).toBeGreaterThan(10);
    for (const line of hl) expect(line, line).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|url\(/i);
    expect(css).toMatch(/\.hl-cmd \{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.hl-cmd \{[^}]*user-select: all/);
    expect(css).toMatch(/\.hl-line \{[^}]*flex-wrap: wrap/);
  });
});
