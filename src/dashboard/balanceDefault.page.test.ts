import { describe, expect, it } from "vitest";
import { Scenario } from "./testing/scenario.js";
import * as L from "./viewLogic.js";
import {
  FakeBus,
  VirtualClock,
  findAll,
  findButton,
  startPage,
  visibleText,
  type FakeNode,
  type PageWorld,
} from "./testing/pageHarness.js";

/**
 * The balance in the assembled page: SHOWN at the start (the server's default), HIDDEN at the start when the server is
 * set up with SC_BALANCE=hidden, and the player's toggle in both. Whatever the start, once the amounts are hidden NOTHING
 * derived from them stays anywhere: text, attributes, polls, the channel between Views, the context sent to the model.
 * (The other page suites run the hidden start, which is the path they exercise; this one runs the shown start.)
 */

const SECOND = 1000;
/** The balance in the scenario: 250 000 aUEC at first, 434 500 after the sale at 90 s. */
const BALANCE_DIGITS = /250 000|434 500|\b250000\b|\b434500\b/;
const NBSP_FREE = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const FULL = "Plein écran";
const BANNER = "Remplacé par un tableau de bord plus récent";

type Start = "shown" | "hidden";

async function live(start: Start) {
  const world = await startPage({ balanceHidden: start === "hidden" });
  await world.advance(30 * SECOND);
  return world;
}

/** Every string the page holds: the text of every node and the value of every attribute, hidden nodes included. */
function everything(root: FakeNode): string {
  const parts: string[] = [];
  for (const n of findAll(root, () => true)) {
    if (n.children.length === 0) parts.push(n.textContent);
    parts.push(...Object.values(n.attrs));
  }
  // The budget field of the commerce card shows "250000" as an EXAMPLE of what to type: not the balance.
  return NBSP_FREE(parts.join("\n")).replace("Un nombre : 250000, 2,5M", "");
}

/** No amount of the scenario in `text`; on failure, the words around it. */
function expectNoAmount(text: string) {
  const hit = BALANCE_DIGITS.exec(text);
  const around = hit ? text.slice(Math.max(0, hit.index - 120), hit.index + 60) : "";
  expect(hit, `an amount is in the page: ...${around}...`).toBeNull();
}

/** Is a button of this label on screen? (The page keeps both versions of a toggle and hides the one that does not apply.) */
const hasButton = (w: PageWorld, label: string) =>
  NBSP_FREE(visibleText(w.root)).split("\n").includes(label);

describe("Feature: the amounts are shown at the start unless the server starts hidden", () => {
  it("Given the default start, Then the first poll says include_balance true and the balance is on screen with a way to hide it", async () => {
    const w = await live("shown");
    expect(w.host.log.polls[0]!.includeBalance).toBe(true);
    await w.advance(100 * SECOND); // past the sale at 90 s
    expect(w.host.log.polls.every((p) => p.includeBalance)).toBe(true);
    expect(NBSP_FREE(visibleText(w.root))).toMatch(/250 000|434 500/);
    expect(hasButton(w, "Masquer le solde")).toBe(true);
    expect(hasButton(w, "Afficher le solde")).toBe(false);
  });

  it("Given the default start, Then the automatic context sent to the model never holds the balance and no message leaves by itself", async () => {
    const w = await live("shown");
    await w.advance(100 * SECOND);
    expect(w.host.log.messages).toEqual([]);
    for (const c of w.host.log.contexts) expect(NBSP_FREE(c)).not.toMatch(BALANCE_DIGITS);
  });

  it("Given SC_BALANCE=hidden, Then every poll says include_balance false, nothing is on screen, and the way back is visible", async () => {
    const w = await live("hidden");
    await w.advance(100 * SECOND);
    expect(w.host.log.polls.length).toBeGreaterThan(5);
    expect(w.host.log.polls.every((p) => !p.includeBalance)).toBe(true);
    expectNoAmount(everything(w.root));
    expect(NBSP_FREE(visibleText(w.root))).toContain("••••••");
    expect(hasButton(w, "Afficher le solde")).toBe(true);
  });

  it("Given a page with no data-balance attribute (an old page), Then it starts hidden", async () => {
    // The page is built to start SHOWN, but its root carries no attribute: the View must not guess "shown".
    // The server here is hidden too: the View asks for no amount until the server says otherwise.
    const w = await startPage({
      balanceHidden: false,
      omitBalanceAttribute: true,
      balanceServer: { hidden: true },
    });
    await w.advance(100 * SECOND);
    expect(w.host.log.polls.length).toBeGreaterThan(5);
    expect(w.host.log.polls.every((p) => !p.includeBalance)).toBe(true);
    expectNoAmount(everything(w.root));
    expect(hasButton(w, "Afficher le solde")).toBe(true);
    // ... and the very first poll asked for none, whatever the server would have said.
    const first = await startPage({ balanceHidden: false, omitBalanceAttribute: true });
    expect(first.host.log.polls[0]!.includeBalance).toBe(false);
  });
});

describe.each<Start>(["shown", "hidden"])(
  "Feature: the player's toggle, from the %s start",
  (start) => {
    /** Puts the page in the state the test names, whatever the start. */
    async function setTo(w: PageWorld, wanted: Start) {
      const label = wanted === "shown" ? "Afficher le solde" : "Masquer le solde";
      if (!hasButton(w, label)) return; // already in that state
      findButton(w.root, label).click();
      await w.advance(3 * SECOND);
    }

    it("Given the amounts are hidden by the player, Then nothing derived from them is anywhere, and the next polls say false", async () => {
      const w = await live(start);
      await w.advance(100 * SECOND);
      await setTo(w, "hidden");
      await w.advance(5 * SECOND);
      expectNoAmount(everything(w.root));
      expect(w.host.log.polls.slice(-2).every((p) => !p.includeBalance)).toBe(true);
      expect(hasButton(w, "Afficher le solde")).toBe(true);
      expect(NBSP_FREE(visibleText(w.root))).toContain("••••••");
      expect(w.host.log.messages).toEqual([]);
      for (const c of w.host.log.contexts) expect(NBSP_FREE(c)).not.toMatch(BALANCE_DIGITS);
    });

    it("Given the amounts were hidden and the player shows them again, Then the polls say true and the balance is back", async () => {
      const w = await live(start);
      await setTo(w, "hidden");
      await setTo(w, "shown");
      await w.advance(100 * SECOND);
      expect(w.host.log.polls.slice(-2).every((p) => p.includeBalance)).toBe(true);
      expect(NBSP_FREE(visibleText(w.root))).toMatch(/250 000|434 500/);
      expect(hasButton(w, "Masquer le solde")).toBe(true);
    });
  },
);

describe.each<Start>(["shown", "hidden"])(
  "Feature: what the dashboard asks Claude to call never invites a balance it was told to leave out (%s start)",
  (start) => {
    it("Given the player hid the amounts and presses 'Analyser' or 'Bilan', Then the message tells Claude to pass include_balance false", async () => {
      const w = await live(start);
      if (hasButton(w, "Masquer le solde")) {
        findButton(w.root, "Masquer le solde").click();
        await w.advance(3 * SECOND);
      }
      findButton(w.root, "Analyser").click();
      await w.advance(500);
      expect(w.host.log.messages).toHaveLength(1);
      const message = NBSP_FREE(w.host.log.messages[0]!);
      expect(message).toContain("sc_live_state");
      expect(message).toContain("include_balance false");
      expect(message).toContain("Ne lis pas mon solde");
      expect(message).not.toMatch(BALANCE_DIGITS);
    });
  },
);

describe("Feature: the automatic context sent to the model follows the hidden balance", () => {
  const poll = {
    state: "live",
    ship: { name: "DRAK_Cutter_1" },
    pilot: { health: { current: 80 } },
  };

  it("Given the amounts are hidden, Then the summary tells Claude to call sc_live_state with include_balance false", () => {
    const hidden = L.contextSummary(poll, [], true);
    expect(hidden.text).toContain("sc_live_state avec include_balance false");
    expect(hidden.text).not.toMatch(BALANCE_DIGITS);
  });

  it("Given the amounts are shown, Then the summary is the plain one, and never holds an amount", () => {
    const shown = L.contextSummary(poll, [], false);
    expect(shown.text).toContain("appelle sc_live_state.");
    expect(shown.text).not.toContain("include_balance");
    expect(L.contextSummary(poll, []).text).toBe(shown.text);
  });
});

describe("Feature: the server's state is followed, and the player's own click is not lost", () => {
  it("Given the server restarts and forgets the click (shown, from its configuration), Then a View holding its own Masquer says it again instead of showing the balance", async () => {
    const server: { hidden: boolean; source?: "click" | "config" } = { hidden: false };
    const w = await startPage({ balanceHidden: false, balanceServer: server });
    await w.advance(30 * SECOND);
    findButton(w.root, "Masquer le solde").click();
    await w.advance(3 * SECOND);
    expect(server.hidden).toBe(true);
    // the server process restarts: memory lost, the configuration says shown
    server.hidden = false;
    server.source = "config";
    const before = w.host.log.polls.length;
    await w.advance(5 * SECOND);
    expectNoAmount(everything(w.root));
    expect(hasButton(w, "Afficher le solde")).toBe(true);
    const after = w.host.log.polls.slice(before);
    expect(after.some((p) => p.choice === "hidden")).toBe(true);
    // no poll of this View asked for the balance after the restart was noticed, except the one before it said so
    expect(after.filter((p) => p.includeBalance).length).toBeLessThanOrEqual(1);
    expect(server.hidden).toBe(true); // the server is hidden again
    expect(server.source).toBe("click");
  });

  it("Given another dashboard clicked Afficher (source click), Then this View follows it and shows the balance", async () => {
    const server: { hidden: boolean; source?: "click" | "config" } = { hidden: false };
    const w = await startPage({ balanceHidden: false, balanceServer: server });
    await w.advance(30 * SECOND);
    findButton(w.root, "Masquer le solde").click();
    await w.advance(3 * SECOND);
    server.hidden = false;
    server.source = "click";
    await w.advance(5 * SECOND);
    expect(NBSP_FREE(visibleText(w.root))).toMatch(/250 000|434 500/);
    expect(hasButton(w, "Masquer le solde")).toBe(true);
  });

  it("Given a poll in flight when the player clicks Masquer and its old answer says shown, Then the screen keeps the click and the next poll carries it", async () => {
    // The server's state comes from a click of another dashboard (source "click"), so the stale answer cannot be
    // told apart by its source: only the two guards (a click not yet delivered, a click since the poll was sent) save it.
    const server: { hidden: boolean; source?: "click" | "config" } = {
      hidden: false,
      source: "click",
    };
    const w = await startPage({ balanceHidden: false, balanceServer: server });
    await w.advance(30 * SECOND);
    w.host.hold.on = true;
    await w.advance(2 * SECOND); // a poll is now in flight, its answer held (the server said shown)
    expect(w.host.hold.held.length).toBeGreaterThan(0);
    findButton(w.root, "Masquer le solde").click();
    await w.advance(100);
    // the OLD answer arrives late, saying shown; the next poll (which carries the click) is held too, so that the
    // screen is looked at BETWEEN the stale answer and the answer to the click
    w.host.releasePolls();
    await w.advance(100);
    expectNoAmount(everything(w.root));
    expect(hasButton(w, "Afficher le solde")).toBe(true);
    expect(w.host.log.polls.some((p) => p.choice === "hidden")).toBe(true);
    w.host.hold.on = false;
    w.host.releasePolls();
    await w.advance(100);
    expectNoAmount(everything(w.root));
    expect(hasButton(w, "Afficher le solde")).toBe(true);
    // the click is delivered by a poll sent after it
    await w.advance(4 * SECOND);
    expect(w.host.log.polls.some((p) => p.choice === "hidden")).toBe(true);
    expect(server.hidden).toBe(true);
    expectNoAmount(everything(w.root));
    expect(w.host.log.polls.slice(-2).every((p) => !p.includeBalance)).toBe(true);
  });

  it("Given a click Afficher, Then the View sends the page's token with it, and the route button sends it with its one-off", async () => {
    const w = await live("hidden");
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    const shown = w.host.log.polls.find((p) => p.choice === "shown");
    expect(shown?.token).toBe(w.token);
    expect(shown?.refused).toBeUndefined();
    findButton(w.root, FULL).click();
    await w.advance(100);
    findButton(w.root, "Route avec mon solde et ce vaisseau").click();
    await w.advance(2 * SECOND);
    const once = w.host.log.polls.find((p) => p.once);
    expect(once?.token).toBe(w.token);
  });

  it("Given a page without a token, Then its click on Afficher is refused by the server and it stays hidden", async () => {
    const w = await startPage({ balanceHidden: true, balanceToken: "" });
    await w.advance(30 * SECOND);
    findButton(w.root, "Afficher le solde").click();
    await w.advance(4 * SECOND);
    const asked = w.host.log.polls.find((p) => p.choice === "shown");
    expect(asked?.token).toBeUndefined();
    expect(asked?.refused).toBe(true);
    expectNoAmount(everything(w.root));
    expect(hasButton(w, "Afficher le solde")).toBe(true);
  });

  it("Given a hiding click, Then it never needs a token", async () => {
    const w = await startPage({ balanceHidden: false, balanceToken: "" });
    await w.advance(30 * SECOND);
    findButton(w.root, "Masquer le solde").click();
    await w.advance(3 * SECOND);
    const hid = w.host.log.polls.find((p) => p.choice === "hidden");
    expect(hid).toBeDefined();
    expect(hid?.refused).toBeUndefined();
    expectNoAmount(everything(w.root));
  });
});

describe("Feature: two Views of one conversation, the amounts and the channel", () => {
  async function views(start: Start, count: number) {
    const scenario = new Scenario();
    const clock = new VirtualClock(scenario.epoch);
    const bus = new FakeBus();
    const pages: PageWorld[] = [];
    for (let i = 0; i < count; i++) {
      pages.push(await startPage({ scenario, clock, bus, balanceHidden: start === "hidden" }));
      await clock.advance(50);
    }
    return { scenario, clock, bus, pages };
  }

  it("Given a leader that shows the balance from the start, Then the wire carries no amount, and the follower shows none", async () => {
    const { clock, bus, pages } = await views("shown", 2);
    const [follower, leader] = pages as [PageWorld, PageWorld];
    await clock.advance(120 * SECOND);
    expect(NBSP_FREE(visibleText(leader.root))).toMatch(/250 000|434 500/);
    expect(bus.log.length).toBeGreaterThan(20);
    const wire = JSON.stringify(bus.log);
    expect(wire).not.toMatch(BALANCE_DIGITS);
    expect(wire).not.toContain("uec_changed");
    expect(wire).not.toContain('"balance"');
    expectNoAmount(everything(follower.root));
    expect(NBSP_FREE(visibleText(follower.root))).toContain(BANNER);
  });

  it("Given a leader that is replaced and leads again, Then it goes back to the player's choice (shown by default)", async () => {
    const { scenario, clock, bus, pages } = await views("shown", 2);
    const [, leader] = pages as [PageWorld, PageWorld];
    await clock.advance(20 * SECOND);
    expect(NBSP_FREE(visibleText(leader.root))).toMatch(/250 000/);
    // A newer View takes the lead: this one forgets the balance at once (it is not shared)...
    const scenarioPage = await startPage({ scenario, clock, bus, balanceHidden: false });
    await clock.advance(10 * SECOND);
    expect(NBSP_FREE(visibleText(leader.root))).toContain(BANNER);
    expectNoAmount(everything(leader.root));
    // ... and when the newer one goes away it leads again and shows the balance, as before.
    scenarioPage.firePageHide();
    await clock.advance(60 * SECOND);
    expect(NBSP_FREE(visibleText(leader.root))).not.toContain(BANNER);
    expect(NBSP_FREE(visibleText(leader.root))).toMatch(/250 000|434 500/);
  });

  it("Given a leader that hid the balance and is replaced, then leads again, Then it is still hidden", async () => {
    const { scenario, clock, bus, pages } = await views("shown", 2);
    const [, leader] = pages as [PageWorld, PageWorld];
    await clock.advance(20 * SECOND);
    findButton(leader.root, "Masquer le solde").click();
    await clock.advance(3 * SECOND);
    const newer = await startPage({ scenario, clock, bus, balanceHidden: false });
    await clock.advance(10 * SECOND);
    newer.firePageHide();
    await clock.advance(60 * SECOND);
    expectNoAmount(everything(leader.root));
    expect(leader.host.log.polls.slice(-2).every((p) => !p.includeBalance)).toBe(true);
  });
});
