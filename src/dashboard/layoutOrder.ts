/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The order of the sections in full screen. Shipped inside the page next to viewLogic.ts, with the same rules (serialised
 * with Function.prototype.toString): only function declarations, no import, no module-level value, no storage.
 *
 * Two orders exist, and only the placement and the fold change, never the content of a section:
 *   - "station" (named "commerce" for the player): the order the page always had: ship banner, shortcuts, session, the
 *     commerce card, then the instruments. Preparing a route is the job there.
 *   - "flight" (named "vol"): the verdict and the alerts, the banner, the line of the trip under way, then the instruments;
 *     the shortcuts, the commerce card (folded while nothing fresh happened in it), the session and the rest follow.
 *
 * What decides, and nothing more: the stream is live, the connection is not menu / disconnected / closed, and the ship
 * section says "not landed" (flying, in quantum mode or in a jump) or "landed"; on foot, in EVA and in a ground vehicle
 * (no ship) are "station". Anything else (no stream, a ship whose state is not reported, a powered-off ship, a seat without
 * a ship, a contradiction between the ship and the pilot's locomotion) is "unknown", and unknown gets the default order and
 * says so on the button. The gear is not read: "gear out" would be a guess that the player is about to land.
 *
 * `why: "flux"` marks the unknown that comes from a grey or absent stream: it is not a change of situation, so the page keeps
 * the order it has (viewApp.ts); menu, disconnected, closed and a contradiction are real and send it back to the default.
 *
 * The page applies a change only after `stableMs` of stability (viewApp.ts), so that a `landed` that flips does not make
 * the page jump, never while the page is scrolled down, and never moves a node that holds the keyboard focus (`layoutPlace`).
 */

/**
 * The two numbers of the feature, both choices and not measures: how long a context must hold before the page follows it,
 * and how far down the page may be scrolled for an automatic change to be applied (px; below it the change waits).
 */
export function layoutConfig(): any {
  return { stableMs: 3000, scrollMaxPx: 200 };
}

/** What the data say about the situation: { id: "flight" | "station" | "unknown", why }. `grey`: the values are not current. */
export function layoutContext(L: any, poll: any, grey: boolean): any {
  if (!poll) return { id: "unknown", why: "flux" };
  // What Game.log says wins over the frames (as in the header): a menu or a kick is a real change, grey values or not.
  const conn = poll.connection && poll.connection.state;
  if (conn === "menu" || conn === "disconnected" || conn === "closed")
    return { id: "unknown", why: "connexion" };
  if (grey || poll.state !== "live") return { id: "unknown", why: "flux" };
  const ctx = L.shipContext(poll);
  const s = ctx.state.id;
  const loco = poll.pilot && poll.pilot.locomotion;
  if (ctx.has) {
    // A ship section while the pilot is out of it: the data contradict each other, nothing is deduced.
    if (loco === "on_foot" || loco === "eva") return { id: "unknown", why: "incohérent" };
    if (s === "planet" || s === "space" || s === "quantum" || s === "jump")
      return { id: "flight", why: "" };
    if (s === "landed") return { id: "station", why: "" };
    return { id: "unknown", why: "vaisseau" };
  }
  if (s === "foot" || s === "eva" || s === "ground") return { id: "station", why: "" };
  return { id: "unknown", why: "vaisseau" };
}

/** The order to show for the player's choice ("auto", "station" or "flight") and the situation. */
export function layoutWant(pref: string, contextId: string): string {
  if (pref === "station" || pref === "flight") return pref;
  return contextId === "flight" ? "flight" : "station";
}

/** The words on the button that picks the order. `applied`: the order on screen now. */
export function layoutLabel(pref: string, contextId: string, applied: string): string {
  if (pref === "station") return "Ordre : commerce (forcé)";
  if (pref === "flight") return "Ordre : vol (forcé)";
  if (applied === "flight") return "Ordre : auto · vol";
  if (contextId === "unknown") return "Ordre : auto · contexte inconnu, ordre commerce";
  return "Ordre : auto · commerce";
}

/** The next choice when the button is pressed: auto, then commerce, then vol, then auto again. */
export function layoutNextPref(pref: string): string {
  return pref === "auto" ? "station" : pref === "station" ? "flight" : "auto";
}

/** Is `active` the node or inside it? (The element that has the focus, against a section.) */
export function layoutHolds(node: any, active: any): boolean {
  for (let n = active; n; n = n.parentNode) if (n === node) return true;
  return false;
}

/**
 * Puts the children of some parents in the order wanted, moving as few nodes as possible. `steps`: [[parent, wanted], ...]
 * run in that order (a node wanted in another parent is taken from where it is). Returns false, and changes nothing, when
 * `active` (the element that has the keyboard focus) is inside a node that would be moved: a moved node loses the focus.
 * The moves are first played on copies of the child lists; nothing but `insertBefore` touches the page.
 */
export function layoutPlace(steps: any[], active: any): boolean {
  const run = (commit: boolean): any[] => {
    const lists = steps.map((s: any) => Array.prototype.slice.call(s[0].children));
    const moved: any[] = [];
    for (let k = 0; k < steps.length; k++) {
      const parent = steps[k][0];
      const wanted = steps[k][1];
      const mine = lists[k];
      for (let i = 0; i < wanted.length; i++) {
        const node = wanted[i];
        if (mine[i] === node) continue;
        for (let j = 0; j < lists.length; j++) {
          const at = lists[j].indexOf(node);
          if (at >= 0) lists[j].splice(at, 1);
        }
        mine.splice(i, 0, node);
        moved.push(node);
        if (commit) parent.insertBefore(node, mine[i + 1] || null);
      }
    }
    return moved;
  };
  const moved = run(false);
  if (active && moved.some((n: any) => layoutHolds(n, active))) return false;
  run(true);
  return true;
}

/** The functions of this file, in the order they are serialised (page.ts). */
export const LAYOUT_VIEW_FUNCTIONS = [
  layoutConfig,
  layoutContext,
  layoutWant,
  layoutLabel,
  layoutNextPref,
  layoutHolds,
  layoutPlace,
];
