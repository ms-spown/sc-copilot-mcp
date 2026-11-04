/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * "Raccourcis": reminders of the actions that make sense NOW, chosen from what the stream and Game.log already say
 * (landing gear out, on foot, EVA, ground vehicle, powerplant off, quantum mode, hostile lock, shields cut). Shipped inside
 * the page next to viewLogic.ts, with the same rules (serialised with Function.prototype.toString): only function
 * declarations, no import (so nothing from `node:` can reach the browser), no module-level value, text only through
 * textContent. The table of keys is a function for that reason.
 *
 * What it will NOT do, on purpose:
 *   - guess a key. A default key is shown only where the public sources say so (`keys` + `src` in the table below), always
 *     labelled "défaut" with a tip that says to check it in the game's own settings. The rest is an action without a key.
 *   - say that the lights are off. `ship.lights_on` is read as a bool(): "off" and "not reported" look the same, so the
 *     lights reminder never states or deduces a state. `advanced_hud_enabled_scm/nav` are display preferences, not read.
 *   - detect darkness. Nothing in the stream or in the log says it. The suit light is listed on foot and in EVA at the
 *     lowest priority ("si besoin"); a button the player presses ("Il fait sombre", kept in this View's memory only)
 *     lifts the lights to the top.
 *   - show anything when the stream is not live, when Game.log says menu / disconnected / closed, or when the frames are
 *     stale. An unknown context says so (full screen) or shows nothing (compact view).
 *   - read the balance or any other figure: it reads states (gear, locomotion, conditions), never amounts.
 *   - read the player's own key bindings (actionmaps.xml): not built (ROADMAP "Next").
 */

/**
 * The actions and their default keys. Edit here, nothing else holds a key.
 * One row per action: [id, label, keys, source letters, held]. Expanded below into objects:
 *  - `keys`: the default key(s) of the game, as printed on the keycap ("Alt" + "C" is two caps). Empty: no key shown.
 *  - `hold`: the key is held, not tapped.
 *  - `src`: where the key comes from (letters of `sources`). A key without a source is never shown (a test enforces it).
 *  - `verified`: seen working in the game by the maintainer on `game`. None is yet: every key is a public-source default.
 * Labels are our own short wording; no text of the sources is copied. Conflicting sources (landing gear N or V, auto land
 * hold Ctrl or N or T, ship lights T or unlisted, power O/U/I/P, request landing Alt+N) leave the entry WITHOUT a key.
 * T is shown only for the suit light, from one source; other guides give it to the ship lights or to auto land.
 */
export function shortcutsTable(): any {
  const rows: any[][] = [
    ["ready", "Flight Ready (démarrer le vaisseau)", ["R"], "wg"],
    ["gear", "Train : sortir ou rentrer"],
    ["land_req", "Demander l’atterrissage"],
    ["land_auto", "Atterrissage automatique"],
    ["takeoff", "Demander le décollage"],
    ["qt", "Mode quantique : entrer ou quitter", ["B"], "w"],
    ["qt_go", "Engager le saut quantique", ["B"], "w", true],
    ["cruise", "Régulateur de vitesse (cruise)", ["C"], "w"],
    ["decoupled", "Mode découplé", ["Alt", "C"], "w"],
    ["brake", "Frein spatial", ["X"], "w"],
    ["decoy", "Leurres", ["H"], "w", true],
    ["noise", "Brouillage", ["J"], "w"],
    ["shield_pw", "Alimenter les boucliers"],
    ["exit", "Quitter le siège"],
    ["lights", "Phares"],
    ["suit", "Lampe de combinaison", ["T"], "w"],
  ];
  return {
    version: 1,
    checked: "2026-11-04",
    game: "4.10",
    sources: {
      w: "wiki Star Citizen Tools, page des commandes, révision du 13 juillet 2026",
      g: "guides de joueurs, versions 3.x à 4.x",
    },
    items: rows.map((r) => ({
      id: r[0],
      label: r[1],
      keys: r[2] || [],
      hold: !!r[4],
      src: r[3] || "",
      verified: false,
    })),
  };
}

/** The sentence on keys: the tip on "défaut" and the line in the unfolded part. */
export function shortcutsKeyNote(): string {
  return "Touche par défaut du jeu, d’après des sources publiques : à vérifier dans vos réglages (sans touche affichée : voir vos réglages). En AZERTY, les touches par défaut suivent l’emplacement QWERTY ; R, B, C, X, H, J et T sont les mêmes.";
}

/**
 * The reminders for a poll, most relevant first. `opts`: { grey } (the View's own verdict that the values are not current:
 * stale frames, no stream), { dark } (the player pressed "Il fait sombre"). Pure.
 * Result: { show, id, label, items, lightable, empty }. `show` false means: nothing at all (no stream, menu, disconnected,
 * closed, stale). `items` are { id, label, keys, hold, note, tier } with tier 0 = alert, 1 = now, 2 = general, 3 = if needed.
 */
export function shortcutsFor(L: any, poll: any, opts: any): any {
  const o = opts || {};
  const conn = poll && poll.connection && poll.connection.state;
  if (
    !poll ||
    poll.state !== "live" ||
    o.grey ||
    conn === "menu" ||
    conn === "disconnected" ||
    conn === "closed"
  ) {
    return { show: false, id: "idle", label: "", items: [], lightable: false, empty: "" };
  }
  const conds = Array.isArray(poll.conditions) ? poll.conditions : [];
  const cond = (id: string, kind?: string): any => {
    for (const c of conds) {
      if (c && c.id === id && (!kind || (c.data && c.data.kind === kind))) return c;
    }
    return null;
  };
  const NS = "état non lu";
  const FIRE = "verrouillage hostile";
  // [id, tier, note]: 0 alert, 1 now, 2 general, 3 if needed
  const plan: any = {
    off: [["ready", 1]],
    quantum: [
      ["qt_go", 1],
      ["qt", 2],
    ],
    landed: [
      ["takeoff", 1],
      ["exit", 2],
      ["lights", 2, NS],
    ],
    gear: [
      ["land_auto", 1, "si la demande est accordée"],
      ["land_req", 1],
      ["gear", 2],
      ["brake", 2],
      ["lights", 2, NS],
    ],
    planet: [
      ["land_req", 1],
      ["gear", 1],
      ["cruise", 2],
      ["brake", 2],
      ["lights", 2, NS],
    ],
    space: [
      ["qt", 1],
      ["cruise", 1],
      ["decoupled", 2],
      ["brake", 2],
    ],
    ship: [
      ["exit", 2],
      ["lights", 2, NS],
    ],
    foot: [["suit", 3, "si besoin"]],
    eva: [["suit", 3, "si besoin"]],
    ground: [
      ["lights", 1, NS],
      ["exit", 2],
    ],
    seated: [
      ["ready", 1, "si c’est un vaisseau"],
      ["exit", 2],
    ],
  };
  const names: any = {
    off: "Vaisseau éteint",
    jump: "Saut quantique",
    quantum: "Mode quantique",
    landed: "Posé",
    gear: "Train sorti, en vol",
    planet: "En vol, près d’une planète",
    space: "En vol, dans l’espace",
    ship: "À bord",
    foot: "À pied",
    eva: "EVA",
    ground: "Véhicule terrestre",
    seated: "Assis (vaisseau non reconnu)",
    down: "À terre",
    unknown: "Contexte inconnu",
  };
  const empties: any = {
    jump: "Rien à presser pendant le saut.",
    down: "À terre : aucun rappel.",
    unknown: "Contexte inconnu : aucun rappel pour l’instant.",
  };

  const ship = poll.ship;
  const d = poll.derived || {};
  const loc = poll.pilot && poll.pilot.locomotion;
  let id = "unknown";
  if (cond("down_or_dead")) id = "down";
  else if (ship) {
    if (L.shipIsOff(poll)) id = "off";
    else if (d.in_jump) id = "jump";
    else if (d.in_quantum_mode) id = "quantum";
    else if (ship.landed === true) id = "landed";
    else if (ship.landed === false) {
      id = ship.gear === "deployed" ? "gear" : d.in_planet_frame ? "planet" : "space";
    } else id = "ship";
  } else if (loc === "on_foot") id = "foot";
  else if (loc === "eva") id = "eva";
  else if (d.ground_vehicle) id = "ground";
  else if (loc === "seated") id = "seated";

  const picks: any[] = (plan[id] || []).slice();
  const lightable = id in plan && id !== "off" && id !== "quantum" && id !== "seated";
  if (ship && lightable && cond("hostile_lock")) {
    // A countermeasure the stream reports as spent is not offered.
    if (!cond("countermeasures_empty", "decoy")) picks.push(["decoy", 0, FIRE]);
    if (!cond("countermeasures_empty", "noise")) picks.push(["noise", 0, FIRE]);
  }
  // Shields are cut on purpose in quantum mode: no reminder there. The ship must be on.
  if (ship && lightable) {
    const sh = cond("shields_down") || cond("shields_off");
    if (sh) {
      picks.push(["shield_pw", 0, cond("shields_down") ? "boucliers tombés" : "boucliers coupés"]);
    }
  }
  if (o.dark && lightable) {
    // Pressed by the player: the light goes first among the reminders of the moment, without "si besoin".
    const key = id === "foot" || id === "eva" ? "suit" : "lights";
    picks.splice(0, 0, [key, 1]);
    for (let i = picks.length - 1; i > 0; i--) if (picks[i][0] === key) picks.splice(i, 1);
  }

  const byId: any = {};
  for (const e of shortcutsTable().items) byId[e.id] = e;
  const items: any[] = [];
  for (let tier = 0; tier <= 3; tier++) {
    for (const p of picks) {
      const e = byId[p[0]];
      if (p[1] !== tier || !e) continue;
      const keyed = !!e.src && e.keys.length > 0;
      items.push({
        id: e.id,
        label: e.label,
        keys: keyed ? e.keys : [],
        hold: keyed && e.hold,
        note: p[2] || "",
        tier,
      });
    }
  }
  return {
    show: true,
    id,
    label: names[id],
    items: items.slice(0, 8),
    lightable,
    empty: items.length === 0 ? empties[id] || "" : "",
  };
}

/**
 * The zone. Compact view: at most 3 reminders in a wrapping line, nothing when there is no context; full screen: at most 6,
 * the context named, the unknown context said. The rest, the explanation of the keys and the "Il fait sombre" button sit
 * behind ONE button (aria-expanded) that is the zone's only tab stop while folded. No live region, no storage, no tab stop
 * on a key (its tip is for the pointer; the same sentence is written in the unfolded part).
 * `render(poll, { grey, fullscreen })`.
 */
export function shortcutsPanel(doc: any, L: any): any {
  const { el, add, setText, setAttr, show, setTip } = L.domKit(doc);
  const MAX = 8;
  const root = el("section", "sc");
  root.setAttribute("aria-label", "Raccourcis");
  const head = el("div", "sc-head");
  const ctxName = el("span", "sc-ctx", "");
  const empty = el("p", "sc-empty", "");
  const list = el("ul", "sc-list");
  list.setAttribute("id", "sc-list");
  const rows: any[] = [];
  for (let i = 0; i < MAX; i++) {
    const li = el("li", "sc-row");
    li.t = el("span", "sc-t", "");
    li.n = el("span", "sc-n", "");
    li.k = el("span", "sc-k");
    li.kc = el("kbd", "sc-kc", "");
    li.h = el("span", "sc-h", "maintenir");
    add(li.k, li.kc, li.h, el("span", "sc-h", "défaut"));
    setTip(li.k, L.shortcutsKeyNote());
    add(li, li.t, li.n, li.k);
    rows.push(li);
    add(list, li);
  }
  const more = el("div", "sc-more");
  const dark = el("button", "btn mini", "Il fait sombre");
  dark.setAttribute("type", "button");
  add(more, dark, el("p", "sc-note", L.shortcutsKeyNote()));
  const fold = el("button", "btn mini sc-fold", "");
  fold.setAttribute("type", "button");
  fold.setAttribute("aria-controls", "sc-list");
  const foldText = el("span", "", "");
  const foldCaret = el("span", "", "");
  foldCaret.setAttribute("aria-hidden", "true");
  add(fold, foldText, foldCaret);
  add(head, el("h2", "sc-title", "Raccourcis"), ctxName, fold);
  add(root, head, empty, list, more);

  const st: any = { open: false, dark: false, last: null };
  fold.addEventListener("click", () => {
    st.open = !st.open;
    paint();
    fold.focus();
  });
  dark.addEventListener("click", () => {
    st.dark = !st.dark;
    paint();
  });

  function paint() {
    const a = st.last;
    const r = L.shortcutsFor(L, a.poll, { grey: a.grey, dark: st.dark });
    // The compact view spends no line on "no context" or "nothing to say".
    show(root, r.show && (a.fullscreen || r.items.length > 0));
    const vis = a.fullscreen ? 6 : 3;
    const extra = Math.max(0, r.items.length - vis);
    const canFold = extra > 0 || r.lightable || r.items.some((it: any) => it.keys.length > 0);
    setText(ctxName, r.label ? "· " + r.label : "");
    setText(empty, r.empty);
    show(empty, !!r.empty && a.fullscreen);
    show(list, r.items.length > 0);
    for (let i = 0; i < MAX; i++) {
      const li = rows[i];
      const it = r.items[i];
      show(li, !!it && (i < vis || st.open));
      if (!it) continue;
      setAttr(li, "data-tier", String(it.tier));
      setText(li.t, it.label);
      setText(li.n, it.note ? "· " + it.note : "");
      show(li.n, !!it.note);
      show(li.k, it.keys.length > 0);
      setText(li.kc, it.keys.join("+"));
      show(li.h, !!it.hold);
    }
    show(fold, canFold);
    show(more, canFold && st.open);
    show(dark, r.lightable);
    setAttr(dark, "aria-pressed", st.dark ? "true" : "false");
    setText(
      foldText,
      extra > 1
        ? "Voir les " + extra + " autres"
        : extra > 0
          ? "Voir 1 autre"
          : "À propos des touches",
    );
    setText(foldCaret, st.open ? " ▴" : " ▸");
    setAttr(fold, "aria-expanded", st.open ? "true" : "false");
  }

  return {
    root,
    render(poll: any, ctx: any) {
      st.last = { poll, grey: !!ctx.grey, fullscreen: !!ctx.fullscreen };
      paint();
    },
  };
}

/** Everything above that the page needs, in the order it is serialised. */
export const SHORTCUTS_VIEW_FUNCTIONS = [
  shortcutsTable,
  shortcutsKeyNote,
  shortcutsFor,
  shortcutsPanel,
];
