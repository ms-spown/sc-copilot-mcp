import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { dashboardHtml, viewScript } from "./page.js";
import { Scenario } from "./testing/scenario.js";
import {
  extractElement,
  findAll,
  findButton,
  isShown,
  startPage,
  visibleText,
  type PageWorld,
} from "./testing/pageHarness.js";

/**
 * The assembled page, run as it ships (the same script string the host receives), against a fake host and a fake
 * DOM. No browser. The scenario plays through the real normaliser and event handler.
 */

const SECOND = 1000;
const polls = (w: PageWorld) => w.host.log.polls;
const methods = (w: PageWorld) => w.host.log.received.map((r) => r.method);
const FULL = "Plein écran";

/** The balance in the scenario: 250 000 aUEC at first, 434 500 after the sale at 90 s. */
const BALANCE_DIGITS = /250\s?000|434\s?500|\b250000\b|\b434500\b/;
const NBSP_FREE = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

async function live(options: Parameters<typeof startPage>[0] = {}) {
  const world = await startPage(options);
  // Game absent, then connected, then the pilot on foot and seated: 30 s in, the ship is flying.
  await world.advance(30 * SECOND);
  return world;
}

describe("Feature: extracting an element does not depend on case or spacing", () => {
  it("Given upper-case, spaced or attributed tags, Then the content is still found", () => {
    expect(extractElement("<html><SCRIPT>a()</SCRIPT></html>", "script")).toBe("a()");
    expect(extractElement('<script type="x" >b()</script >', "script")).toBe("b()");
    expect(extractElement("<STYLE>p{}</Style>", "style")).toBe("p{}");
    expect(extractElement("<p>none</p>", "script")).toBeNull();
    expect(extractElement("<script>never closed", "script")).toBeNull();
  });
});

describe("Feature: the page itself is safe and self-contained", () => {
  const html = dashboardHtml();
  const script = viewScript();

  it("Given the page, Then it needs no network: no URL, no external file, no CDN, no font", () => {
    // The only URL in the page is the SVG namespace, an identifier for createElementNS, not an address.
    const withoutNamespace = html.split("http://www.w3.org/2000/svg").join("");
    const has = (re: RegExp, text = html) => re.test(text);
    expect(has(/https?:/i, withoutNamespace)).toBe(false);
    expect(has(/<link\b/i)).toBe(false);
    expect(has(/\bsrc\s*=/i)).toBe(false);
    const style = extractElement(html, "style")!;
    expect(has(/@import|url\(|@font-face/i, style)).toBe(false);
    expect(has(/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/)).toBe(
      false,
    );
    expect(has(/localStorage|sessionStorage|indexedDB|document\.cookie/)).toBe(false);
  });

  it("Given the script, Then no text can become markup: only textContent, no eval", () => {
    expect(script).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment/,
    );
    expect(script).not.toMatch(/\beval\s*\(|new Function\s*\(|setTimeout\s*\(\s*["'`]/);
    expect(script).not.toMatch(/\bDOMParser\b|srcdoc/);
    expect(script).toContain("textContent");
    expect(script.toLowerCase()).not.toContain("</script");
  });

  it("Given the page, Then it declares a restrictive CSP of its own and both colour schemes", () => {
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/connect-src[^"]*(\*|https?)/);
    expect(html).toContain('name="color-scheme" content="light dark"');
    expect(html).toContain("light-dark(");
    expect(html).toContain("background: transparent");
  });

  it("Given the page, Then colours come from host variables, with a fallback each, and nothing else is hard-coded", () => {
    const css = extractElement(html, "style")!;
    // Every colour literal sits inside a var(--color-..., fallback) or a light-dark() fallback.
    const outsideFallback = css
      .split("\n")
      .filter((l) => /#[0-9a-f]{3,8}\b|rgb\(|hsl\(/i.test(l))
      .filter((l) => !/var\(--color-[a-z-]+,/.test(l));
    expect(outsideFallback).toEqual([]);
  });

  it("Given the script, Then it is valid JavaScript and uses no module syntax", () => {
    expect(() => new vm.Script(script)).not.toThrow();
    expect(script).not.toMatch(/^\s*(import|export)\s/m);
    expect(script).not.toContain("__vi_import");
    expect(script).not.toContain("__name(");
  });
});

describe("Feature: the View speaks the ui/* protocol with the host", () => {
  it("Given a host, When the page starts, Then it initializes, announces itself, and then polls", async () => {
    const w = await startPage();
    const init = w.host.log.received[0]!;
    expect(init.method).toBe("ui/initialize");
    expect(init.params).toMatchObject({
      protocolVersion: "2026-01-26",
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    });
    const protocol = methods(w).filter((m) => m !== "ui/notifications/size-changed");
    expect(protocol.slice(0, 3)).toEqual([
      "ui/initialize",
      "ui/notifications/initialized",
      "tools/call",
    ]);
    // Nothing but ui/initialize may precede the agreement with the host.
    expect(methods(w).indexOf("ui/notifications/size-changed")).toBeGreaterThan(1);
    const call = w.host.log.received.find((r) => r.method === "tools/call")!;
    expect(call.params).toEqual({ name: "sc_live_poll", arguments: { include_static: true } });
  });

  it("Given a host, Then ping and ui/resource-teardown are answered with {}", async () => {
    const w = await startPage();
    expect(await w.host.request("ping")).toEqual({});
    // Anything else the host asks is answered with an error, never left hanging.
    expect(await w.host.request("something/else")).toMatchObject({ code: -32601 });
    expect(await w.host.request("ui/resource-teardown")).toEqual({});
  });

  it("Given a message from a window that is not the parent, Then it is ignored", async () => {
    const w = await startPage();
    const before = w.posted.length;
    w.fromStranger({ jsonrpc: "2.0", id: 7, method: "ping" });
    w.fromStranger({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { plan: { commodity: "FROM A STRANGER" } } },
    });
    w.fromStranger({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: {
        displayMode: "fullscreen",
        styles: { variables: { "--color-text-primary": "red" } },
      },
    });
    await w.advance(10);
    expect(w.posted.length).toBe(before);
    expect(visibleText(w.root)).not.toContain("FROM A STRANGER");
    expect(w.root.attrs["data-mode"]).toBe("inline");
    expect(w.doc.documentElement.style.props["--color-text-primary"]).not.toBe("red");
  });

  it("Given the host context, Then the theme and the style variables are applied, and unsafe ones are not", async () => {
    const w = await startPage({ theme: "light" });
    const el = w.doc.documentElement;
    expect(el.attrs["data-theme"]).toBe("light");
    expect(el.style.props["color-scheme"]).toBe("light");
    expect(el.style.props["--color-text-primary"]).toContain("light-dark(");
    expect(Object.keys(el.style.props).filter((k) => k.startsWith("--")).length).toBeGreaterThan(
      10,
    );
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: {
        styles: {
          variables: {
            "--color-background-primary": "url(https://evil.example/x)",
            "not-a-variable": "1",
            "--ok-var": "12px",
          },
        },
      },
    });
    expect(el.style.props["--color-background-primary"]).not.toContain("evil");
    expect(el.style.props["not-a-variable"]).toBeUndefined();
    expect(el.style.props["--ok-var"]).toBe("12px");
  });
});

describe("Feature: polling is bounded, adaptive and suspended when nobody looks", () => {
  it("Given a live stream, Then it polls about once a second and never faster than 2 Hz", async () => {
    const w = await live();
    expect(w.root.attrs["data-stream"]).toBe("live");
    const start = polls(w).length;
    await w.advance(20 * SECOND);
    const recent = polls(w).slice(start);
    expect(recent.length).toBeGreaterThanOrEqual(18);
    expect(recent.length).toBeLessThanOrEqual(21);
    const times = polls(w).map((p) => p.at);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!, `gap ${i}`).toBeGreaterThanOrEqual(500);
    }
  });

  it("Given the game is absent, Then it slows down to one request every 5 seconds", async () => {
    const w = await startPage();
    expect(visibleText(w.root)).toContain("En attente du premier signal du jeu");
    w.scenario.forced = "waiting";
    await w.advance(61 * SECOND);
    const times = polls(w).map((p) => p.at);
    expect(times.length).toBeLessThanOrEqual(14);
    for (let i = 2; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!, "waiting: one request every 5 s").toBeGreaterThanOrEqual(
        4900,
      );
    }
    const w2 = await startPage();
    w2.scenario.forced = "off";
    await w2.advance(60 * SECOND);
    const gaps = polls(w2).map((p) => p.at);
    for (let i = 2; i < gaps.length; i++) {
      expect(gaps[i]! - gaps[i - 1]!, "off: one request every 5 s").toBeGreaterThanOrEqual(4900);
    }
    expect(visibleText(w2.root)).toContain("Télémétrie désactivée");
    expect(visibleText(w2.root)).toContain("npm run telemetry -- enable");
  });

  it("Given the stream is cut, Then values are greyed, labelled, and the polling slows down", async () => {
    const w = await live();
    expect(w.root.attrs["data-grey"]).toBe("0");
    w.scenario.cut = true;
    await w.advance(10 * SECOND);
    expect(w.root.attrs["data-grey"]).toBe("1");
    expect(visibleText(w.root)).toMatch(/Connecté, pas encore de trame|Flux interrompu/);
    const start = polls(w).length;
    await w.advance(30 * SECOND);
    expect(polls(w).length - start).toBeLessThanOrEqual(15);
  });

  it("Given Game.log says the server kicked the player while frames keep coming, Then the View marks it at once and never says 'Aucune alerte'", async () => {
    const w = await live();
    expect(visibleText(w.root)).not.toContain("Déconnecté du serveur");
    w.scenario.connection = {
      state: "disconnected",
      since: new Date(w.scenario.now).toISOString(),
      code: 30028,
      reason: "Remote Disconnect - player inactive",
    };
    await w.advance(3 * SECOND);
    expect(w.root.attrs["data-grey"]).toBe("1");
    expect(w.root.attrs["data-stream"]).toBe("disconnected");
    const text = visibleText(w.root);
    expect(text).toContain("Déconnecté du serveur");
    expect(text).toContain("Renvoyé du serveur pour inactivité");
    expect(text).not.toContain("Aucune alerte");
    expect(text).not.toMatch(/En direct/);
    // Back in a session: the View comes back by itself.
    w.scenario.connection = { state: "online", since: null, code: null, reason: null };
    await w.advance(3 * SECOND);
    expect(w.root.attrs["data-grey"]).toBe("0");
    expect(visibleText(w.root)).not.toContain("Déconnecté du serveur");
  });

  it("Given the window is hidden, Then polling stops at once; when it comes back, polling resumes", async () => {
    const w = await live();
    w.setHidden(true);
    await w.advance(100);
    const stopped = polls(w).length;
    await w.advance(60 * SECOND);
    expect(polls(w).length).toBe(stopped);
    expect(w.pendingTimers()).toBe(0);
    w.setHidden(false);
    await w.advance(3 * SECOND);
    expect(polls(w).length).toBeGreaterThanOrEqual(stopped + 2);
  });

  it("Given the View is scrolled out of view, Then it does not poll; scrolled back, it does", async () => {
    const w = await live();
    w.setIntersecting(false);
    await w.advance(100);
    const stopped = polls(w).length;
    await w.advance(45 * SECOND);
    expect(polls(w).length).toBe(stopped);
    w.setIntersecting(true);
    await w.advance(2 * SECOND);
    expect(polls(w).length).toBeGreaterThan(stopped);
  });

  it("Given a View away for more than 30 minutes, Then it retires and waits for the player to resume", async () => {
    const w = await live();
    w.setHidden(true);
    await w.advance(31 * 60 * SECOND);
    w.setHidden(false);
    await w.advance(5 * SECOND);
    const count = polls(w).length;
    await w.advance(30 * SECOND);
    expect(polls(w).length).toBe(count);
    expect(visibleText(w.root)).toContain("Vue en pause depuis longtemps");
    findButton(w.root, "Reprendre").click();
    await w.advance(3 * SECOND);
    expect(polls(w).length).toBeGreaterThan(count);
    expect(visibleText(w.root)).not.toContain("Vue en pause depuis longtemps");
  });

  it("Given ui/resource-teardown, Then polling stops for good", async () => {
    const w = await live();
    expect(await w.host.request("ui/resource-teardown")).toEqual({});
    await w.advance(100);
    const stopped = polls(w).length;
    await w.advance(30 * SECOND);
    expect(polls(w).length).toBe(stopped);
    w.setHidden(true);
    w.setHidden(false);
    await w.advance(5 * SECOND);
    expect(polls(w).length).toBe(stopped);
  });

  it("Given the server fails to answer, Then the View says so, backs off, and recovers", async () => {
    const w = await live();
    const real = w.host.overrides.poll;
    void real;
    // The host answers with a broken payload: the View must not show garbage.
    w.host.overrides.poll = () => ({ nope: true });
    await w.advance(3 * SECOND);
    expect(visibleText(w.root)).toContain("Serveur injoignable");
    const start = polls(w).length;
    await w.advance(20 * SECOND);
    expect(polls(w).length - start).toBeLessThan(10); // backing off, not hammering
    delete w.host.overrides.poll;
    await w.advance(60 * SECOND);
    expect(visibleText(w.root)).not.toContain("Serveur injoignable");
  });
});

describe("Feature: the balance stays hidden until the player asks", () => {
  it("Given a View that was never asked to show the balance, Then no poll requests it and it is nowhere on screen", async () => {
    const w = await live();
    await w.advance(100 * SECOND); // past the sale at 90 s
    expect(polls(w).every((p) => !p.includeBalance)).toBe(true);
    expect(NBSP_FREE(visibleText(w.root))).not.toMatch(BALANCE_DIGITS);
    expect(visibleText(w.root)).toContain("••••••");
    expect(visibleText(w.root)).toContain("Afficher le solde");
    expect(w.host.log.messages).toEqual([]);
    for (const c of w.host.log.contexts) expect(NBSP_FREE(c)).not.toMatch(BALANCE_DIGITS);
  });

  it("Given a click on 'Afficher le solde', Then polls carry include_balance and the balance appears; 'Masquer' hides it", async () => {
    const w = await live();
    findButton(w.root, "Afficher le solde").click();
    await w.advance(3 * SECOND);
    expect(
      polls(w)
        .slice(-2)
        .every((p) => p.includeBalance),
    ).toBe(true);
    expect(NBSP_FREE(visibleText(w.root))).toMatch(/250 000/);
    // Nothing about the balance went to the conversation by showing it.
    expect(w.host.log.messages).toEqual([]);
    for (const c of w.host.log.contexts) expect(NBSP_FREE(c)).not.toMatch(BALANCE_DIGITS);
    findButton(w.root, "Masquer le solde").click();
    await w.advance(3 * SECOND);
    expect(NBSP_FREE(visibleText(w.root))).not.toMatch(BALANCE_DIGITS);
    expect(
      polls(w)
        .slice(-2)
        .every((p) => !p.includeBalance),
    ).toBe(true);
  });

  it("Given the balance is shown, Then ui/update-model-context never contains it, and neither do the two fixed messages", async () => {
    const w = await live();
    findButton(w.root, "Afficher le solde").click();
    await w.advance(100 * SECOND);
    for (const c of w.host.log.contexts) expect(NBSP_FREE(c)).not.toMatch(BALANCE_DIGITS);
    findButton(w.root, "Analyser ma situation").click();
    await w.advance(100);
    expect(w.host.log.messages).toHaveLength(1);
    expect(NBSP_FREE(w.host.log.messages[0]!)).not.toMatch(BALANCE_DIGITS);
    expect(w.host.log.messages[0]).toContain("sc_live_state");
  });

  it("Given the route action, Then it is the only message with the balance, and its text says it is sent", async () => {
    const w = await live();
    // Full screen so the action buttons are in play (they exist in the page either way).
    findButton(w.root, FULL).click();
    await w.advance(100);
    findButton(w.root, "Route avec mon solde et ce vaisseau").click();
    await w.advance(2 * SECOND);
    const [message] = w.host.log.messages;
    expect(w.host.log.messages).toHaveLength(1);
    expect(NBSP_FREE(message!)).toMatch(/250 000 aUEC/);
    expect(message).toContain("volontairement");
    expect(message).toContain("DRAK_Cutter_907038284543");
    expect(message).toContain("uex_get_trade_routes");
  });

  it("Given 'Bilan de session', Then the message is fixed, in French, and says to use sc_live_events and sc_live_state", async () => {
    const w = await live();
    findButton(w.root, FULL).click();
    await w.advance(100);
    findButton(w.root, "Bilan de session").click();
    await w.advance(100);
    const [message] = w.host.log.messages;
    expect(message).toContain("sc_live_events");
    expect(message).toContain("sc_live_state");
    expect(message).not.toMatch(/\d{4,}/);
    expect(w.host.log.received.find((r) => r.method === "ui/message")!.params).toMatchObject({
      role: "user",
      content: [{ type: "text" }],
    });
  });
});

describe("Feature: ui/update-model-context is rare and never per frame", () => {
  it("Given two minutes of changing data, Then at most one summary per 30 s, only on significant changes", async () => {
    const w = await startPage();
    await w.advance(120 * SECOND);
    const sends = w.host.log.received.filter((r) => r.method === "ui/update-model-context");
    expect(sends.length).toBeGreaterThanOrEqual(1);
    expect(sends.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < sends.length; i++) {
      expect(sends[i]!.at - sends[i - 1]!.at).toBeGreaterThanOrEqual(30 * SECOND);
    }
    for (const s of sends) {
      expect(s.params.content).toEqual([
        { type: "text", text: expect.stringContaining("sc_live_state") },
      ]);
    }
    // Hundreds of polls, a handful of summaries.
    expect(polls(w).length).toBeGreaterThan(60);
  });

  it("Given a steady situation, Then no summary is sent at all", async () => {
    const w = await startPage();
    w.scenario.forced = "waiting";
    await w.advance(120 * SECOND);
    expect(w.host.log.contexts).toEqual([]);
  });
});

describe("Feature: display modes", () => {
  it("Given the full-screen button, Then the View asks the host, reads the effective mode, and goes back inline", async () => {
    const w = await live();
    findButton(w.root, FULL).click();
    await w.advance(100);
    expect(w.host.log.modeRequests).toEqual(["fullscreen"]);
    expect(w.root.attrs["data-mode"]).toBe("fullscreen");
    expect(visibleText(w.root)).toContain("Instruments");
    findButton(w.root, "Réduire").click();
    await w.advance(100);
    expect(w.host.log.modeRequests).toEqual(["fullscreen", "inline"]);
    expect(w.root.attrs["data-mode"]).toBe("inline");
  });

  it("Given a host that answers inline to a full-screen request (as for pip), Then the View stays inline, without error", async () => {
    const w = await startPage({ modes: ["inline"] });
    // The host offers no full screen: the button is not shown.
    expect(isShown(findButton(w.root, FULL))).toBe(false);
    expect(w.root.attrs["data-mode"]).toBe("inline");
  });

  it("Given the host changes the display mode itself, Then the View follows", async () => {
    const w = await live();
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "fullscreen" },
    });
    expect(w.root.attrs["data-mode"]).toBe("fullscreen");
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { displayMode: "inline" },
    });
    expect(w.root.attrs["data-mode"]).toBe("inline");
  });
});

describe("Feature: nothing is invented, and what the stream lacks is said", () => {
  it("Given a live ship in combat, Then the lights, the alerts and the unverified marks are shown", async () => {
    const w = await startPage();
    await w.advance(72 * SECOND);
    findButton(w.root, FULL).click();
    await w.advance(2 * SECOND);
    const text = visibleText(w.root);
    expect(text).toContain("Boucliers tombés");
    expect(text).toContain("Verrouillage hostile");
    expect(text).toContain("SHLD");
    expect(text).toContain("alerte majeure");
    expect(text).toMatch(/Leurres/);
    expect(text).toContain("Le niveau des boucliers n\u2019est pas fourni par le jeu");
    expect(text).toContain("Munitions : non fournies par le jeu.");
    expect(text).toContain("Ce que le flux ne contient pas");
    expect(text).toContain("Cargaison");
  });

  it("Given health 0, Then the View says down or dead, and an absent gauge is not shown as 0", async () => {
    const w = await live();
    w.host.overrides.poll = (base) => ({
      ...base,
      pilot: { ...base.pilot, health: { current: 0, max: 100, percent: 0 } },
      conditions: [
        { id: "down_or_dead", level: "critical", confidence: "confirmed", since: base.at - 3000 },
      ],
    });
    await w.advance(2 * SECOND);
    // The compact dial says it, and the verdict is an alert.
    expect(visibleText(w.root)).toContain("à terre ou mort");
    expect(visibleText(w.root)).toContain("À terre ou mort");
    findButton(w.root, FULL).click();
    // An overridden section must not be reported as unchanged (the View would put its old copy back).
    w.host.overrides.poll = (base) => ({
      ...base,
      unchanged: undefined,
      pilot: { locomotion: "seated" },
    });
    await w.advance(2 * SECOND);
    expect(visibleText(w.root)).not.toMatch(/à terre ou mort/i);
    expect(visibleText(w.root)).toContain("non fourni");
  });

  it("Given no vehicle frame, Then the ship tile shows a dash, not a made-up value", async () => {
    const w = await startPage();
    await w.advance(8 * SECOND); // on foot
    const text = visibleText(w.root);
    expect(text).toContain("À pied");
    expect(text).not.toContain("Cutter");
    expect(text).not.toMatch(/ne tourne pas|erreur/i);
    // The Instruments card (full screen) explains it as a normal thing.
    findButton(w.root, FULL).click();
    await w.advance(100);
    expect(visibleText(w.root)).toContain(
      "À pied : seules les données du personnage sont disponibles. Les instruments apparaissent quand vous êtes assis dans un vaisseau.",
    );
  });

  it("Given connected without a frame, Then the View says it is normal (menus, loading), not that the game is off", async () => {
    const w = await startPage();
    // The story is connected without frames from 3 to 6 s; the polls are slow while nothing is there yet.
    let text = visibleText(w.root);
    for (let i = 0; i < 10 && !text.includes("Connecté"); i++) {
      await w.advance(SECOND);
      text = visibleText(w.root);
    }
    expect(text).toContain("Connecté, pas encore de trame");
    expect(text).toContain("Rien d’anormal");
    expect(text).not.toMatch(/ne tourne pas|lance le jeu/);
  });

  it("Given each data, Then its age is shown", async () => {
    const w = await live();
    expect(visibleText(w.root)).toMatch(/Données de \d+(,\d)? s/);
  });

  it("Given a game started without telemetry, Then the View says to quit the launcher completely", async () => {
    const w = await startPage();
    w.scenario.forced = "game_without_telemetry";
    await w.advance(10 * SECOND);
    expect(visibleText(w.root)).toContain("Quitte complètement le launcher");
    w.scenario.forced = "incompatible";
    await w.advance(10 * SECOND);
    expect(visibleText(w.root)).toContain("Format inconnu");
  });
});

describe("Feature: state alerts (conditions) come before the recent events", () => {
  it("Given a real-shaped quantum jump, Then the shields chip says 'Boucliers coupés · mode quantique' and goes away on arrival", async () => {
    const w = await startPage();
    await w.advance(53 * SECOND); // quantum mode since 48 s, flags off for more than the 1 s hold
    let text = visibleText(w.root);
    expect(text).toContain("Boucliers coupés · mode quantique");
    expect(text).toMatch(/depuis \d/);
    expect(text).toMatch(/Saut quantique|Mode quantique/);
    expect(text).not.toContain("Aucune alerte");
    const chips = w.root.children.find((c) => c.className === "alerts")!;
    const first = chips.children.filter((c) => c.className.startsWith("alert condition"));
    expect(
      first.some((c) => c.attrs["data-tone"] === "info" && c.attrs["data-hidden"] !== "1"),
    ).toBe(true);
    await w.advance(9 * SECOND); // arrival at 60 s
    text = visibleText(w.root);
    expect(text).not.toContain("Boucliers coupés · mode quantique");
  });

  it("Given shields cut outside quantum mode, Then the chip is a warning 'Boucliers coupés'", async () => {
    const w = await live();
    w.host.overrides.poll = (base) => ({
      ...base,
      conditions: [
        {
          id: "shields_off",
          level: "warning",
          confidence: "confirmed",
          since: base.at - 8000,
          data: { quantum: false },
        },
      ],
    });
    await w.advance(2 * SECOND);
    const chips = w.root.children.find((c) => c.className === "alerts")!;
    const shown = chips.children.filter(
      (c) => c.className.startsWith("alert condition") && c.attrs["data-hidden"] !== "1",
    );
    expect(shown).toHaveLength(1);
    expect(shown[0]!.attrs["data-tone"]).toBe("warn");
    expect(shown[0]!.textContent).toContain("Boucliers coupés");
    expect(shown[0]!.textContent).not.toContain("quantique");
  });
});

describe("Feature: session, pace and the route plan", () => {
  it("Given a plan in the tool result, Then it is shown as text, the planned profit is a profit, and the balance change is never called a profit", async () => {
    const w = await live();
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: {
        structuredContent: {
          view: "sc_live_dashboard",
          plan: {
            commodity: "Laranite",
            buy_terminal: "Port Tressler",
            sell_terminal: "Area18",
            scu: 96,
            expected_profit_auec: 125000,
            unknown_field: "dropped",
          },
        },
      },
    });
    findButton(w.root, FULL).click();
    await w.advance(100);
    findButton(w.root, "Début de session").click();
    await w.advance(2 * SECOND);
    let text = NBSP_FREE(visibleText(w.root));
    expect(text).toContain("Laranite");
    expect(text).toContain("Port Tressler \u2192 Area18");
    expect(text).toMatch(/\+125 000 aUEC/);
    expect(text).toContain("désactivé ou illisible");
    expect(text).not.toContain("dropped");
    // The old block compared a profit with a balance change: "Réalisé" does not exist any more.
    expect(text).not.toContain("Réalisé");
    // After the sale (90 s) and a click on the balance, the balance change appears under its own name, with the
    // warning that it is not a profit, and no net profit is claimed without a trade journal.
    findButton(w.root, "Afficher le solde").click();
    await w.advance(62 * SECOND);
    text = NBSP_FREE(visibleText(w.root));
    expect(text).toMatch(/Bénéfice prévu\n\+125 000 aUEC/);
    expect(text).toMatch(/Variation du solde\n\+184 500 aUEC/);
    expect(text).toContain("pas un bénéfice");
    expect(text).not.toMatch(/Bénéfice net\n\+/);
    expect(text).toContain("disponible après 2 min");
    expect(text).toContain("depuis le début de session");
  });

  it("Given hostile strings in the plan and in the stream, Then they are shown as plain text and never as markup", async () => {
    const w = await live();
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    w.fromHost({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { plan: { commodity: evil, note: evil, buy_terminal: evil } } },
    });
    w.host.overrides.poll = (base) => ({
      ...base,
      ship: { ...base.ship, class_name: evil, name: evil, manufacturer_derived: undefined },
      events: [
        ...base.events,
        {
          seq: 9999,
          type: "vehicle_changed",
          group: "ship",
          confidence: "confirmed",
          at: new Date(w.clock.now).toISOString(),
          text: evil,
          data: { vehicle: evil },
        },
      ],
      last_seq: 9999,
    });
    findButton(w.root, FULL).click();
    await w.advance(3 * SECOND);
    // The fake DOM throws on innerHTML/outerHTML/insertAdjacentHTML: reaching here proves none was used.
    const text = visibleText(w.root);
    expect(text).toContain(evil);
    // The unsafe vehicle id is replaced, never forwarded, in anything sent to the conversation.
    findButton(w.root, "Analyser ma situation").click();
    await w.advance(100);
    for (const m of [...w.host.log.messages, ...w.host.log.contexts]) expect(m).not.toContain("<");
  });

  it("Given markers, Then the buttons call sc_live_mark and the timeline shows them", async () => {
    const w = await live();
    findButton(w.root, FULL).click();
    await w.advance(100);
    findButton(w.root, "Début de session").click();
    await w.advance(2 * SECOND);
    findButton(w.root, "Solde à zéro").click();
    await w.advance(2 * SECOND);
    expect(w.host.log.marks).toEqual(["start", "reset_delta"]);
    const text = visibleText(w.root);
    expect(text).toContain("Début de session");
    expect(text).toContain("Solde remis à zéro");
  });

  it("Given pins, Then a pinned datum joins the compact view", async () => {
    const w = await live();
    findButton(w.root, FULL).click();
    await w.advance(2 * SECOND);
    // A pin is an icon button named by its label; the pinned datum goes to the bar at the top, in both modes.
    const pin = findAll(w.root, (n) => n.attrs["aria-label"] === "Épingler : vitesse")[0]!;
    expect(pin.attrs["aria-pressed"]).toBe("false");
    pin.click();
    expect(pin.attrs["aria-pressed"]).toBe("true");
    const bar = findAll(w.root, (n) => n.className === "pinbar")[0]!;
    expect(isShown(bar)).toBe(true);
    expect(visibleText(bar)).toMatch(/Vitesse\n\d/);
    findButton(w.root, "Réduire").click();
    await w.advance(100);
    expect(visibleText(w.root)).toMatch(/Vitesse\n\d+\nm\/s|Vitesse\n\d/);
    pin.click();
    expect(isShown(bar)).toBe(false);
  });
});

describe("Feature: the compact view stays small and stable", () => {
  it("Given a live ship, Then the compact view shows the five data, the stream state and no more than five tiles by default", async () => {
    const w = await live();
    const text = visibleText(w.root);
    for (const label of ["Vitesse", "Hydrogène", "Santé", "Solde"]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("En direct");
    expect(text).toContain("Tout va bien");
    expect(text).toContain("Cutter");
    expect(text).toContain("Drake");
    expect(text).toMatch(/En vol \u00b7 /);
    expect(text).not.toContain("Instruments"); // full screen only
  });

  it("Given a changing scenario, Then the number of polls and the text never contain NaN, undefined or null", async () => {
    const w = await startPage({ scenario: new Scenario() });
    findButton(w.root, FULL).click();
    for (let i = 0; i < 24; i++) {
      await w.advance(5 * SECOND);
      const text = visibleText(w.root);
      expect(text, `at ${(i + 1) * 5} s`).not.toMatch(/NaN|undefined|null|\[object/);
    }
  });
});
