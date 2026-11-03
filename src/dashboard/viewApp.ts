/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The live dashboard View: DOM, protocol (ui/* over postMessage, hand-written, no package) and timers. It is
 * serialised into the page with Function.prototype.toString, so it must stay self-contained: it receives `win`,
 * `doc` and the pure functions `L` (viewLogic.ts) as arguments and touches nothing else.
 *
 * Rules that the tests enforce on the assembled page:
 *   - text reaches the DOM only through textContent (never innerHTML, never insertAdjacentHTML, never a template);
 *   - messages whose source is not the parent window are ignored;
 *   - the View answers {} to ping and ui/resource-teardown;
 *   - it never polls while hidden, off screen, torn down or retired, nor faster than 2 Hz;
 *   - the balance is requested only after the player clicks, and only the explicit "route" action sends it.
 */
export function dashboardMain(win: any, doc: any, L: any): any {
  const cfg = L.viewConfig();
  const SVG_NS = "http://www.w3.org/2000/svg";
  const clock = () => Date.now();

  // ---------------------------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------------------------
  let view = L.initialViewState();
  let hostCtx: any = {};
  let displayMode = "inline";
  let availableModes: string[] = ["inline"];
  let showBalance = false;
  let hidden = !!doc.hidden;
  let offscreen = false;
  let awaySince: number | null = hidden ? clock() : null;
  let tornDown = false;
  let retired = false;
  let initialised = false;
  let timer: any = null;
  let ticker: any = null;
  let inFlight: Promise<void> | null = null;
  let lastPollAt = 0;
  let gate = L.initialContextGate();
  let lastStreamId = "";
  let lastSize = "";
  const pins: Record<string, boolean> = {};

  // ---------------------------------------------------------------------------------------------
  // Protocol: JSON-RPC 2.0 over postMessage, written by hand
  // ---------------------------------------------------------------------------------------------
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const send = (message: any) => {
    win.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, message), "*");
  };
  const notify = (method: string, params?: any) => send({ method, params });
  const request = (method: string, params?: any): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const t = win.setTimeout(() => {
        pending.delete(id);
        reject(new Error("délai dépassé : " + method));
      }, cfg.requestTimeoutMs);
      pending.set(id, {
        resolve: (v) => {
          win.clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          win.clearTimeout(t);
          reject(e);
        },
      });
      send({ id, method, params });
    });

  // ---------------------------------------------------------------------------------------------
  // DOM helpers: text only goes through textContent
  // ---------------------------------------------------------------------------------------------
  const el = (tag: string, cls?: string, text?: string): any => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const add = (parent: any, ...kids: any[]): any => {
    for (const k of kids) if (k) parent.appendChild(k);
    return parent;
  };
  const setText = (n: any, text: string) => {
    if (n._t !== text) {
      n._t = text;
      n.textContent = text;
    }
  };
  const setAttr = (n: any, name: string, value: string) => {
    const key = "_a_" + name;
    if (n[key] !== value) {
      n[key] = value;
      n.setAttribute(name, value);
    }
  };
  const setVar = (n: any, name: string, value: string) => {
    const key = "_v_" + name;
    if (n[key] !== value) {
      n[key] = value;
      n.style.setProperty(name, value);
    }
  };
  const show = (n: any, on: boolean) => setAttr(n, "data-hidden", on ? "0" : "1");
  const button = (label: string, onClick: () => void, cls?: string): any => {
    const b = el("button", "btn" + (cls ? " " + cls : ""), label);
    b.setAttribute("type", "button");
    b.addEventListener("click", onClick);
    return b;
  };
  const svg = (tag: string): any => doc.createElementNS(SVG_NS, tag);

  // ---------------------------------------------------------------------------------------------
  // Building the interface once; render() only changes text and attributes afterwards
  // ---------------------------------------------------------------------------------------------
  const root = doc.getElementById("app");
  const R: any = { cards: [], pinButtons: [] };

  function tile(label: string, pinKey?: string): any {
    const t: any = { root: el("div", "tile") };
    t.label = el("div", "tile-label", label);
    t.value = el("div", "tile-value", "\u2014");
    t.sub = el("div", "tile-sub", "");
    t.bar = el("div", "bar");
    t.fill = el("div", "fill");
    add(t.bar, t.fill);
    add(t.root, t.label, t.value, t.bar, t.sub);
    t.pinKey = pinKey;
    return t;
  }

  function card(title: string): any {
    const c: any = { root: el("section", "card") };
    c.head = el("div", "card-head");
    c.title = el("h2", "card-title", title);
    c.age = el("span", "age", "");
    add(c.head, c.title, c.age);
    c.body = el("div", "card-body");
    add(c.root, c.head, c.body);
    R.cards.push(c);
    return c;
  }

  function row(label: string): any {
    const r: any = { root: el("div", "row") };
    r.label = el("span", "row-label", label);
    r.value = el("span", "row-value", "\u2014");
    add(r.root, r.label, r.value);
    return r;
  }

  function pinButton(key: string): any {
    const b = button(
      "Épingler",
      () => {
        pins[key] = !pins[key];
        render();
      },
      "mini",
    );
    b.setAttribute("aria-pressed", "false");
    b.setAttribute("title", "Afficher aussi cette donnée dans la vue réduite");
    b._key = key;
    R.pinButtons.push(b);
    return b;
  }

  function spark(): any {
    const s: any = { root: svg("svg") };
    s.root.setAttribute("viewBox", "0 0 120 28");
    s.root.setAttribute("class", "spark");
    s.root.setAttribute("aria-hidden", "true");
    s.line = svg("polyline");
    s.line.setAttribute("fill", "none");
    s.line.setAttribute("points", "");
    s.root.appendChild(s.line);
    return s;
  }

  function build() {
    // Header
    R.top = el("header", "top");
    R.status = el("div", "status");
    R.dot = el("span", "dot");
    R.statusLabel = el("span", "status-label", "Connexion\u2026");
    R.statusDetail = el("span", "status-detail", "");
    add(R.status, R.dot, R.statusLabel, R.statusDetail);
    R.topActions = el("div", "top-actions");
    R.age = el("span", "age", "");
    R.btnAnalyse = button("Analyser ma situation", () => sendAction("analyse"), "small");
    R.btnMode = button(
      "Plein écran",
      () => requestMode(displayMode === "fullscreen" ? "inline" : "fullscreen"),
      "primary",
    );
    add(R.topActions, R.age, R.btnAnalyse, R.btnMode);
    add(R.top, R.status, R.topActions);

    // Notice for every state that is not a live stream
    R.notice = el("div", "notice");
    R.noticeText = el("p", "notice-text", "");
    R.noticeCmd = el("code", "notice-cmd", "");
    R.btnResume = button("Reprendre", () => resume(), "primary");
    add(R.notice, R.noticeText, R.noticeCmd, R.btnResume);

    // Alerts band
    R.alerts = el("div", "alerts");
    R.alertsEmpty = el("span", "alerts-empty", "Aucune alerte récente");
    R.alertList = [];
    add(R.alerts, R.alertsEmpty);
    for (let i = 0; i < 3; i++) {
      const a = el("span", "alert");
      a.label = el("span", "alert-label", "");
      a.meta = el("span", "alert-meta", "");
      add(a, a.label, a.meta);
      R.alertList.push(a);
      add(R.alerts, a);
    }

    // Inline tiles
    R.tiles = el("div", "tiles");
    R.tShip = tile("Vaisseau");
    R.tSpeed = tile("Vitesse");
    R.tHydrogen = tile("Hydrogène");
    R.tHealth = tile("Santé");
    R.tBalance = tile("Solde");
    R.btnBalance = button("Afficher le solde", () => toggleBalance(), "mini");
    add(R.tBalance.root, R.btnBalance);
    add(R.tiles, R.tShip.root, R.tSpeed.root, R.tHydrogen.root, R.tHealth.root, R.tBalance.root);
    R.pinTiles = {};
    const pinLabels: any = {
      vspeed: "Vitesse verticale",
      altitude: "Altitude",
      g: "Force G",
      boost: "Réserve de boost",
      hunger: "Faim",
      thirst: "Soif",
      heart: "Rythme cardiaque",
      hydrogen_eta: "Autonomie hydrogène",
    };
    for (const key of Object.keys(pinLabels)) {
      const t = tile(pinLabels[key], key);
      R.pinTiles[key] = t;
      add(R.tiles, t.root);
    }

    // Full screen: cards
    R.full = el("div", "full");

    // Instruments
    const cIns = card("Instruments");
    R.ins = {};
    const insDefs: any[] = [
      ["speed", "Vitesse"],
      ["altitude", "Altitude"],
      ["vspeed", "Vitesse verticale"],
      ["g", "Force G"],
    ];
    for (const d of insDefs) {
      const r = row(d[1]);
      const s = spark();
      r.root.className = "row instrument";
      add(r.root, s.root);
      if (d[0] !== "speed") add(r.root, pinButton(d[0]));
      R.ins[d[0]] = { row: r, spark: s };
      add(cIns.body, r.root);
    }
    R.heading = row("Cap");
    add(cIns.body, R.heading.root);
    R.insNote = el("p", "note", "");
    add(cIns.body, R.insNote);

    // Energy and flight
    const cEn = card("Énergie et vol");
    R.gHydrogen = tile("Hydrogène");
    R.gBoost = tile("Réserve de boost");
    add(R.gBoost.root, pinButton("boost"));
    add(cEn.body, R.gHydrogen.root, R.gBoost.root);
    R.modes = el("div", "chips");
    R.modeChips = [];
    for (let i = 0; i < 6; i++) {
      const c = el("span", "chip", "");
      R.modeChips.push(c);
      add(R.modes, c);
    }
    R.power = el("div", "chips");
    R.powerChips = [];
    for (let i = 0; i < 9; i++) {
      const c = el("span", "chip", "");
      R.powerChips.push(c);
      add(R.power, c);
    }
    R.gear = row("Train / VTOL");
    add(
      cEn.body,
      el("h3", "sub-title", "Modes de vol"),
      R.modes,
      el("h3", "sub-title", "Alimentation (marche / arrêt, sans niveaux)"),
      R.power,
      R.gear.root,
    );

    // Warning lights
    const cLights = card("Voyants");
    R.lights = el("div", "lights");
    R.lightEls = [];
    for (let i = 0; i < 10; i++) {
      const l = el("span", "light");
      l.name = el("span", "light-name", "");
      l.state = el("span", "light-state", "");
      add(l, l.name, l.state);
      R.lightEls.push(l);
      add(R.lights, l);
    }
    add(
      cLights.body,
      R.lights,
      el(
        "p",
        "note",
        "Le niveau des boucliers n\u2019est pas fourni par le jeu : seul le voyant SHLD l\u2019indique. Les voyants en pointillé ne sont pas vérifiés.",
      ),
    );

    // Weapons
    const cWeap = card("Armes et contre-mesures");
    R.weapons = el("div", "weapons");
    R.weaponRows = [];
    for (let i = 0; i < 8; i++) {
      const w = row("");
      R.weaponRows.push(w);
      add(R.weapons, w.root);
    }
    R.weaponsNone = el("p", "note", "");
    R.cmDecoy = row("Leurres");
    R.cmNoise = row("Brouillage");
    add(
      cWeap.body,
      R.weapons,
      R.weaponsNone,
      R.cmDecoy.root,
      R.cmNoise.root,
      el("p", "note", "Munitions : non fournies par le jeu."),
    );

    // Pilot
    const cPilot = card("Pilote");
    R.pHealth = tile("Santé");
    R.pHunger = tile("Faim");
    add(R.pHunger.root, pinButton("hunger"));
    R.pThirst = tile("Soif");
    add(R.pThirst.root, pinButton("thirst"));
    R.pHeart = row("Rythme cardiaque");
    add(R.pHeart.root, pinButton("heart"));
    R.pLoco = row("Position du corps");
    R.pAir = row("Atmosphère");
    add(
      cPilot.body,
      R.pHealth.root,
      R.pHunger.root,
      R.pThirst.root,
      R.pHeart.root,
      R.pLoco.root,
      R.pAir.root,
    );

    // Estimates
    const cEta = card("Autonomies estimées");
    R.eta = {
      hydrogen: row("Hydrogène"),
      hunger: row("Faim"),
      thirst: row("Soif"),
    };
    add(R.eta.hydrogen.root, pinButton("hydrogen_eta"));
    R.etaNote = el("p", "note", "");
    add(cEta.body, R.eta.hydrogen.root, R.eta.hunger.root, R.eta.thirst.root, R.etaNote);

    // Session
    const cSes = card("Session et rythme");
    R.sesButtons = el("div", "btn-row");
    R.btnStart = button("Début de session", () => mark("start"), "small");
    R.btnEnd = button("Fin de session", () => mark("end"), "small");
    R.btnReset = button("Solde à zéro", () => mark("reset_delta"), "small");
    add(R.sesButtons, R.btnStart, R.btnEnd, R.btnReset);
    R.sesState = row("Session");
    R.sesTakeoffs = row("Décollages");
    R.sesLandings = row("Atterrissages");
    R.sesJumps = row("Sauts quantiques");
    R.sesFlight = row("Temps de vol (estimé)");
    R.sesBalance = row("Solde");
    R.btnBalance2 = button("Afficher le solde", () => toggleBalance(), "mini");
    add(R.sesBalance.root, R.btnBalance2);
    R.sesDelta = row("Variation");
    R.sesRate = row("Rythme");
    R.sesNote = el("p", "note", "");
    add(
      cSes.body,
      R.sesButtons,
      R.sesState.root,
      R.sesTakeoffs.root,
      R.sesLandings.root,
      R.sesJumps.root,
      R.sesFlight.root,
      R.sesBalance.root,
      R.sesDelta.root,
      R.sesRate.root,
      R.sesNote,
    );

    // Plan
    R.planCard = card("Plan de route");
    R.planLine = el("p", "plan-line", "");
    R.planNote = el("p", "plan-note", "");
    R.planExpected = row("Prévu");
    R.planActual = row("Réalisé");
    R.planBar = el("div", "bar");
    R.planFill = el("div", "fill");
    add(R.planBar, R.planFill);
    R.planCargo = el(
      "p",
      "note",
      "Cargaison non mesurée par le jeu : la variation du solde est la seule mesure.",
    );
    add(
      R.planCard.body,
      R.planLine,
      R.planNote,
      R.planExpected.root,
      R.planActual.root,
      R.planBar,
      R.planCargo,
    );

    // Events
    const cEv = card("Événements récents");
    R.events = el("ol", "events");
    R.eventRows = [];
    for (let i = 0; i < 12; i++) {
      const li = el("li", "event");
      li.time = el("span", "event-time", "");
      li.text = el("span", "event-text", "");
      li.badge = el("span", "badge", "");
      add(li, li.time, li.text, li.badge);
      R.eventRows.push(li);
      add(R.events, li);
    }
    R.eventsNone = el("p", "note", "");
    add(
      cEv.body,
      R.events,
      R.eventsNone,
      el(
        "p",
        "note",
        "Les événements sont déduits des changements d\u2019état : le jeu n\u2019en envoie presque pas. « non vérifié » : jamais vu fonctionner en conditions réelles.",
      ),
    );

    // Timeline
    const cTl = card("Chronologie de session");
    R.timeline = el("ol", "events timeline");
    R.timelineRows = [];
    for (let i = 0; i < 14; i++) {
      const li = el("li", "event");
      li.time = el("span", "event-time", "");
      li.text = el("span", "event-text", "");
      li.badge = el("span", "badge", "");
      add(li, li.time, li.text, li.badge);
      R.timelineRows.push(li);
      add(R.timeline, li);
    }
    R.timelineNone = el("p", "note", "");
    add(cTl.body, R.timeline, R.timelineNone);

    // Actions
    const cAct = card("Demander à Claude");
    R.btnAnalyse2 = button("Analyser ma situation", () => sendAction("analyse"));
    R.btnRoute = button("Route avec mon solde et ce vaisseau", () => sendAction("route"));
    R.btnBilan = button("Bilan de session", () => sendAction("bilan"));
    R.actionNote = el(
      "p",
      "note",
      "La route envoie ton solde dans la conversation, par ce bouton seulement. Les autres messages n\u2019en contiennent pas. Rien n\u2019est envoyé au jeu.",
    );
    R.actionCol = el("div", "btn-col");
    add(R.actionCol, R.btnAnalyse2, R.btnRoute, R.btnBilan);
    add(cAct.body, R.actionCol, R.actionNote);

    // What the stream does not contain
    R.missing = el("details", "missing");
    R.missingSummary = el("summary", "missing-summary", "Ce que le flux ne contient pas");
    R.missingList = el("ul", "missing-list");
    add(R.missing, R.missingSummary, R.missingList);
    const missing = [
      "Cargaison",
      "Position",
      "Direction de la caméra",
      "Niveau des boucliers",
      "Coque et composants",
      "Chaleur",
      "Munitions",
      "Répartition de l\u2019énergie",
      "Carburant quantique",
      "Portes",
      "Événements de mort",
      "Missiles",
    ];
    for (const m of missing) add(R.missingList, el("li", "", m));

    add(
      R.full,
      cIns.root,
      cEn.root,
      cLights.root,
      cWeap.root,
      cPilot.root,
      cEta.root,
      cSes.root,
      R.planCard.root,
      cEv.root,
      cTl.root,
      cAct.root,
      R.missing,
    );

    // Feedback line (the one polite live region: it changes on state changes and after an action only)
    R.live = el("div", "live", "");
    R.live.setAttribute("role", "status");
    R.live.setAttribute("aria-live", "polite");

    add(root, R.top, R.notice, R.alerts, R.tiles, R.full, R.live);
  }

  // ---------------------------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------------------------
  function setBar(t: any, info: any) {
    const frac =
      info && info.fraction !== null && info.fraction !== undefined ? info.fraction : null;
    setVar(t.fill, "--p", frac === null ? "0" : String(Math.round(frac * 1000) / 1000));
    setAttr(t.root, "data-level", info && info.level ? info.level : "none");
    setAttr(t.bar, "data-empty", frac === null ? "1" : "0");
  }

  function setTile(t: any, text: string, sub: string, info?: any) {
    setText(t.value, text);
    setText(t.sub, sub);
    setBar(t, info || null);
  }

  function fractionOf(poll: any, key: string): any {
    const ins = poll && poll.ship && poll.ship.instruments;
    if (key === "hydrogen") return L.fractionInfo(ins ? ins.hydrogen_fuel : undefined, 0.25, 0.1);
    if (key === "boost")
      return L.fractionInfo(ins && ins.boost ? ins.boost.reserves : undefined, 0.25, 0.1);
    const pilot = poll && poll.pilot;
    if (key === "hunger") return L.gaugeInfo(pilot && pilot.hunger, 0.25, 0.1);
    if (key === "thirst") return L.gaugeInfo(pilot && pilot.thirst, 0.25, 0.1);
    return L.fractionInfo(undefined, 0, 0);
  }

  function balanceInfo(poll: any): any {
    if (!showBalance || !poll || !poll.balance) return null;
    return poll.balance;
  }

  function renderTiles(now: number) {
    const p = view.poll;
    const ship = p && p.ship;
    const ins = ship && ship.instruments;
    const mode = L.modeInfo(p);
    // Ship
    setTile(
      R.tShip,
      ship
        ? L.shipTitle(ship)
        : mode.id === "foot" || mode.id === "eva"
          ? "Sans vaisseau"
          : "\u2014",
      mode.label,
    );
    setAttr(R.tShip.value, "title", ship ? L.shipTitle(ship) : "");
    // Speed
    setTile(
      R.tSpeed,
      ins ? L.fmtNum(ins.speed_ms, 0) + "\u00a0m/s" : "\u2014",
      ins ? (ship.landed ? "à l\u2019arrêt au sol" : "") : "pas de données de vaisseau",
    );
    // Hydrogen
    const h = fractionOf(p, "hydrogen");
    setTile(R.tHydrogen, h.text, ins ? "" : "pas de données de vaisseau", h);
    // Health
    const hp = L.healthInfo(p && p.pilot);
    setTile(
      R.tHealth,
      hp.text,
      hp.zero ? "le flux ne distingue pas les deux" : hp.known ? "" : "non fourni",
      hp,
    );
    // Balance
    const bal = balanceInfo(p);
    if (bal) {
      setTile(
        R.tBalance,
        L.fmtAuec(bal.uec) + "\u00a0aUEC",
        typeof bal.delta === "number" ? "variation " + L.fmtAuec(bal.delta, true) : "",
      );
      setText(R.btnBalance, "Masquer le solde");
    } else {
      setTile(
        R.tBalance,
        showBalance ? "\u2014" : "\u2022\u2022\u2022\u2022\u2022\u2022",
        showBalance ? "en attente du solde" : "masqué par défaut",
      );
      setText(R.btnBalance, "Afficher le solde");
    }
    // Pinned extras
    const pinned = (key: string, text: string, sub: string, info?: any) => {
      const t = R.pinTiles[key];
      show(t.root, !!pins[key]);
      if (pins[key]) setTile(t, text, sub, info);
    };
    pinned("vspeed", ins ? L.fmtNum(ins.vertical_speed_ms, 1) + "\u00a0m/s" : "\u2014", "");
    pinned(
      "altitude",
      ins && typeof ins.altitude_m === "number" ? L.formatDistance(ins.altitude_m) : "\u2014",
      ins && typeof ins.altitude_m !== "number" ? "hors champ planétaire" : "",
    );
    pinned("g", ins && ins.g ? L.fmtNum(ins.g.current, 1) + "\u00a0G" : "\u2014", "");
    const boost = fractionOf(p, "boost");
    pinned("boost", boost.text, "", boost);
    const hun = fractionOf(p, "hunger");
    pinned("hunger", hun.text, "", hun);
    const thi = fractionOf(p, "thirst");
    pinned("thirst", thi.text, "", thi);
    pinned(
      "heart",
      p && p.pilot && p.pilot.heart_rate_bpm > 0
        ? L.fmtNum(p.pilot.heart_rate_bpm, 0) + "\u00a0bpm"
        : "\u2014",
      "",
    );
    pinned(
      "hydrogen_eta",
      L.estimateText(L.trendEstimate(view.series.hydrogen, now)),
      "estimation",
    );
  }

  function renderAlerts(now: number) {
    const list = L.activeAlerts(L.visibleEvents(view, showBalance), now, 3);
    show(R.alertsEmpty, list.length === 0);
    for (let i = 0; i < R.alertList.length; i++) {
      const slot = R.alertList[i];
      const a = list[i];
      show(slot, !!a);
      if (a) {
        setAttr(slot, "data-tone", a.tone);
        setAttr(slot, "data-verified", a.verified ? "1" : "0");
        setText(slot.label, a.label);
        setText(
          slot.meta,
          (a.verified ? "" : "non vérifié \u00b7 ") + "il y a " + L.formatAge(a.ageMs),
        );
      }
    }
  }

  function renderStatus(now: number): any {
    const info = L.streamInfo(view, now);
    setAttr(root, "data-grey", info.grey ? "1" : "0");
    setAttr(root, "data-stream", info.id);
    setAttr(R.dot, "data-tone", info.tone);
    setText(R.statusLabel, info.label);
    setText(R.statusDetail, info.detail);
    const live = info.id === "live" || info.id === "stale";
    setText(R.age, live ? "Données de " + L.formatAge(L.frameAge(view, now)) : "");
    for (const c of R.cards) setText(c.age, live ? L.formatAge(L.frameAge(view, now)) : "");
    if (info.id !== lastStreamId) {
      lastStreamId = info.id;
      if (info.id !== "init")
        setText(R.live, info.label + (info.detail ? " : " + info.detail : ""));
    }
    const needsNotice = !live && info.id !== "init";
    show(R.notice, needsNotice || retired);
    if (retired) {
      setText(
        R.noticeText,
        "Vue en pause depuis longtemps pour ne pas solliciter le jeu pour rien.",
      );
      setText(R.noticeCmd, "");
    } else {
      setText(R.noticeText, needsNotice ? info.detail : "");
      setText(R.noticeCmd, info.help || "");
    }
    show(R.noticeCmd, !!info.help && !retired);
    show(R.btnResume, retired);
    return info;
  }

  function setRow(r: any, text: string, level?: string) {
    setText(r.value, text);
    if (level) setAttr(r.root, "data-level", level);
  }

  function renderFull(now: number) {
    const p = view.poll;
    const ship = p && p.ship;
    const ins = ship && ship.instruments;
    const pilot = p && p.pilot;
    const win60 = cfg.historyMs;
    const fmtMap: any = {
      speed: (v: number) => L.fmtNum(v, 0) + "\u00a0m/s",
      altitude: (v: number) => L.formatDistance(v),
      vspeed: (v: number) => L.fmtNum(v, 1) + "\u00a0m/s",
      g: (v: number) => L.fmtNum(v, 1) + "\u00a0G",
    };
    const cur: any = {
      speed: ins ? ins.speed_ms : undefined,
      altitude: ins ? ins.altitude_m : undefined,
      vspeed: ins ? ins.vertical_speed_ms : undefined,
      g: ins && ins.g ? ins.g.current : undefined,
    };
    for (const key of Object.keys(R.ins)) {
      const entry = R.ins[key];
      const v = cur[key];
      setRow(entry.row, typeof v === "number" ? fmtMap[key](v) : "\u2014");
      const sp = L.sparkPoints(view.series[key], now, win60, 120, 28);
      if (entry.spark.line._pts !== sp.points) {
        entry.spark.line._pts = sp.points;
        entry.spark.line.setAttribute("points", sp.points);
      }
    }
    setRow(
      R.heading,
      ins && typeof ins.heading_deg === "number"
        ? L.fmtNum(ins.heading_deg, 0) + "\u00b0"
        : "\u2014",
    );
    setText(
      R.insNote,
      ins && typeof ins.altitude_m !== "number"
        ? "Altitude, cap et altitude radar n\u2019existent que dans le champ d\u2019une planète ; le cap est figé pendant un saut."
        : ship
          ? "Courbes : les 60 dernières secondes, calculées par cette vue à partir des relevés."
          : "Pas de données de vaisseau (à pied, véhicule terrestre ou pas encore envoyées : 6 à 9 s après être assis).",
    );

    // Energy and flight
    const hyd = fractionOf(p, "hydrogen");
    setTile(R.gHydrogen, hyd.text, "", hyd);
    const boost = fractionOf(p, "boost");
    setTile(
      R.gBoost,
      boost.text,
      ins && ins.boost && ins.boost.engaged
        ? "boost engagé"
        : ins && ins.boost && ins.boost.critical
          ? "réserve critique"
          : "",
      boost,
    );
    const modes = L.flightModesInfo(ship && ship.flight_modes);
    for (let i = 0; i < R.modeChips.length; i++) {
      const m = modes[i];
      setText(R.modeChips[i], m.label);
      setAttr(R.modeChips[i], "data-on", !m.known ? "na" : m.active ? "1" : "0");
    }
    const power = L.powerInfo(ship && ship.power);
    for (let i = 0; i < R.powerChips.length; i++) {
      const c = power[i];
      setText(R.powerChips[i], c.label);
      setAttr(R.powerChips[i], "data-on", !c.known ? "na" : c.on ? "1" : "0");
    }
    setRow(
      R.gear,
      ship
        ? "train " + gearText(ship.gear) + (ship.vtol ? " \u00b7 VTOL " + gearText(ship.vtol) : "")
        : "\u2014",
    );

    // Lights
    const lights = L.lightsInfo(ship && ship.warning_lights);
    for (let i = 0; i < R.lightEls.length; i++) {
      const l = lights[i];
      const slot = R.lightEls[i];
      setText(slot.name, l.label);
      setText(slot.state, ship ? l.text : "\u2014");
      setAttr(slot, "data-tone", ship ? l.tone : "off");
      setAttr(slot, "data-verified", l.verified ? "1" : "0");
    }

    // Weapons
    const weapons = p && p.weapons;
    const wlist = weapons && Array.isArray(weapons.weapons) ? weapons.weapons : [];
    for (let i = 0; i < R.weaponRows.length; i++) {
      const w = wlist[i];
      show(R.weaponRows[i].root, !!w);
      if (w) {
        setText(R.weaponRows[i].label, w.name.replace(/_/g, " "));
        setRow(
          R.weaponRows[i],
          w.powered ? (w.ready ? "prête" : "sous tension") : "sans énergie",
          w.powered ? (w.ready ? "ok" : "warn") : "bad",
        );
      }
    }
    setText(
      R.weaponsNone,
      weapons
        ? wlist.length > 8
          ? "+ " + (wlist.length - 8) + " autres armes."
          : wlist.length === 0
            ? "Aucune arme dans la trame."
            : ""
        : "Pas de trame d\u2019armes : seulement à un poste d\u2019armes.",
    );
    const cm = weapons && weapons.countermeasures ? weapons.countermeasures : {};
    setRow(R.cmDecoy, typeof cm.decoy === "number" ? String(cm.decoy) : "non fourni");
    setRow(R.cmNoise, typeof cm.noise === "number" ? String(cm.noise) : "non fourni");

    // Pilot
    const hp = L.healthInfo(pilot);
    setTile(
      R.pHealth,
      hp.text,
      hp.zero ? "à terre ou mort : le flux ne distingue pas" : hp.known ? "" : "non fourni",
      hp,
    );
    const hun = fractionOf(p, "hunger");
    setTile(R.pHunger, hun.text, "", hun);
    const thi = fractionOf(p, "thirst");
    setTile(R.pThirst, thi.text, "", thi);
    setRow(
      R.pHeart,
      pilot && pilot.heart_rate_bpm > 0
        ? L.fmtNum(pilot.heart_rate_bpm, 0) + "\u00a0bpm"
        : "\u2014",
    );
    const locoNames: any = {
      on_foot: "à pied",
      eva: "EVA",
      seated: "assis",
      unspecified: "inconnu",
    };
    setRow(
      R.pLoco,
      pilot && pilot.locomotion ? locoNames[pilot.locomotion] || "inconnu" : "\u2014",
    );
    setRow(
      R.pAir,
      pilot && typeof pilot.breathable_atmosphere === "boolean"
        ? pilot.breathable_atmosphere
          ? "respirable"
          : "non respirable (non vérifié)"
        : "\u2014",
    );

    // Estimates
    const eh = L.trendEstimate(view.series.hydrogen, now);
    const ef = L.trendEstimate(view.series.hunger, now);
    const et = L.trendEstimate(view.series.thirst, now);
    setRow(R.eta.hydrogen, L.estimateText(eh));
    setRow(R.eta.hunger, L.estimateText(ef));
    setRow(R.eta.thirst, L.estimateText(et));
    const windows = [eh, ef, et].filter((e: any) => e.windowMs).map((e: any) => e.windowMs);
    setText(
      R.etaNote,
      "Estimation par une droite sur les dernières minutes" +
        (windows.length
          ? " (fenêtre jusqu\u2019à " + L.formatDuration(Math.max.apply(null, windows)) + ")"
          : "") +
        " : ce n\u2019est pas une mesure, et un changement de rythme la rend fausse.",
    );

    for (const b of R.pinButtons) {
      setAttr(b, "aria-pressed", pins[b._key] ? "true" : "false");
      setText(b, pins[b._key] ? "Épinglé" : "Épingler");
    }

    renderSession(now);
    renderEvents(now);
    renderMissing();
  }

  function gearText(v: string | undefined): string {
    const names: any = {
      retracted: "rentré",
      deploying: "en sortie",
      deployed: "sorti",
      retracting: "en rentrée",
    };
    return v ? names[v] || "inconnu" : "inconnu";
  }

  function renderSession(now: number) {
    const p = view.poll;
    const s = p && p.session;
    const started = s && s.started_at;
    setRow(
      R.sesState,
      !s || !started
        ? "pas de marqueur de début"
        : s.ended_at
          ? "terminée"
          : "depuis " + L.formatDuration(now - Date.parse(s.started_at)),
    );
    setRow(R.sesTakeoffs, started ? String(s.takeoffs) : "\u2014");
    setRow(R.sesLandings, started ? String(s.landings) : "\u2014");
    setRow(R.sesJumps, started ? String(s.jumps) : "\u2014");
    setRow(R.sesFlight, started ? "\u2248\u00a0" + L.formatDuration(s.flight_ms) : "\u2014");
    const bal = balanceInfo(p);
    setRow(
      R.sesBalance,
      bal ? L.fmtAuec(bal.uec) + "\u00a0aUEC" : showBalance ? "\u2014" : "masqué",
    );
    setText(R.btnBalance2, bal ? "Masquer" : "Afficher le solde");
    const label = L.baselineLabel(p);
    setRow(
      R.sesDelta,
      bal && typeof bal.delta === "number"
        ? L.fmtAuec(bal.delta, true) + "\u00a0aUEC " + label
        : "\u2014",
    );
    const rate = bal ? L.sessionRate(bal.delta, bal.since, now) : null;
    setRow(
      R.sesRate,
      rate
        ? L.fmtAuec(Math.round(rate.perHour), true) + "\u00a0aUEC/h"
        : bal
          ? "disponible après 2 min"
          : "\u2014",
    );
    setText(
      R.sesNote,
      "Le solde mêle achats, récompenses et amendes : la variation n\u2019est pas un bénéfice net. Le temps de vol est déduit des événements de décollage et d\u2019atterrissage.",
    );

    // Plan
    const plan = view.plan;
    show(R.planCard.root, !!plan);
    if (plan) {
      const route = [
        plan.commodity,
        plan.buy_terminal && plan.sell_terminal
          ? plan.buy_terminal + " \u2192 " + plan.sell_terminal
          : plan.buy_terminal || plan.sell_terminal,
      ]
        .filter(Boolean)
        .join(" \u00b7 ");
      setText(
        R.planLine,
        route + (typeof plan.scu === "number" ? " \u00b7 " + L.fmtNum(plan.scu) + " SCU" : ""),
      );
      setText(R.planNote, plan.note || "");
      const prog = L.planProgress(plan, bal ? bal.delta : null);
      setRow(
        R.planExpected,
        prog.expected !== null ? L.fmtAuec(prog.expected, true) + "\u00a0aUEC" : "\u2014",
      );
      setRow(
        R.planActual,
        bal && prog.actual !== null ? L.fmtAuec(prog.actual, true) + "\u00a0aUEC" : "solde masqué",
      );
      const frac = prog.ratio === null ? null : Math.max(0, Math.min(1, prog.ratio));
      setVar(R.planFill, "--p", frac === null ? "0" : String(Math.round(frac * 1000) / 1000));
      show(R.planBar, frac !== null);
    }
  }

  function renderEvents(now: number) {
    const events = L.visibleEvents(view, showBalance).slice().reverse();
    for (let i = 0; i < R.eventRows.length; i++) {
      const li = R.eventRows[i];
      const e = events[i];
      show(li, !!e);
      if (e) {
        setText(li.time, L.formatClock(e.at));
        setText(li.text, L.eventLabel(e));
        setText(li.badge, e.confidence === "confirmed" ? "confirmé" : "non vérifié");
        setAttr(li, "data-verified", e.confidence === "confirmed" ? "1" : "0");
      }
    }
    setText(
      R.eventsNone,
      events.length === 0 ? "Aucun événement depuis le démarrage du lecteur." : "",
    );
    const tl = L.timelineItems(
      L.visibleEvents(view, showBalance),
      view.poll && view.poll.session ? view.poll.session.markers : [],
      R.timelineRows.length,
    );
    for (let i = 0; i < R.timelineRows.length; i++) {
      const li = R.timelineRows[i];
      const e = tl[i];
      show(li, !!e);
      if (e) {
        setText(li.time, L.formatClock(e.at));
        setText(li.text, e.label);
        setText(li.badge, e.kind === "marker" ? "marqueur" : e.verified ? "" : "non vérifié");
        setAttr(li, "data-kind", e.kind);
      }
    }
    setText(
      R.timelineNone,
      tl.length === 0
        ? "Rien à afficher : pose un marqueur de début de session pour la suivre."
        : "",
    );
    void now;
  }

  function renderMissing() {
    // Static text, nothing to update. Kept so that a future change has one place.
  }

  function renderModeUi() {
    setAttr(root, "data-mode", displayMode);
    setText(R.btnMode, displayMode === "fullscreen" ? "Réduire" : "Plein écran");
    show(R.btnMode, availableModes.indexOf("fullscreen") >= 0);
    show(R.btnAnalyse, displayMode !== "fullscreen");
  }

  function render() {
    const now = clock();
    renderStatus(now);
    renderTiles(now);
    renderAlerts(now);
    if (displayMode === "fullscreen") renderFull(now);
    reportSize();
  }

  function reportSize() {
    const w = Math.ceil(doc.body.scrollWidth || 0);
    const h = Math.ceil(doc.body.scrollHeight || 0);
    const key = w + "x" + h;
    if (key !== lastSize && w > 0 && h > 0) {
      lastSize = key;
      notify("ui/notifications/size-changed", { width: w, height: h });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------------------------
  function decision(): any {
    const p = view.poll;
    return L.pollingDecision({
      tornDown,
      retired,
      hidden,
      offscreen,
      awaySince,
      now: clock(),
      state: p ? p.state : view.link === "init" ? "live" : "off",
      failures: view.failures,
    });
  }

  function pollOnce(): Promise<void> {
    if (inFlight) return inFlight;
    const args: any = showBalance ? { include_balance: true } : {};
    lastPollAt = clock();
    const run = (async () => {
      try {
        const r = await request("tools/call", { name: "sc_live_poll", arguments: args });
        const sc = r && r.structuredContent;
        if (!r || r.isError || !sc || typeof sc !== "object") throw new Error("réponse vide");
        view = L.reducePoll(view, sc, clock());
      } catch (err: any) {
        view = L.reducePollError(view, err && err.message ? err.message : "erreur", clock());
      }
      inFlight = null;
      render();
      contextTick();
    })();
    inFlight = run;
    return run;
  }

  /** A poll that carries the balance: one already in flight was asked without it, so ask again if needed. */
  async function pollWithBalance() {
    await pollOnce();
    if (showBalance && !(view.poll && view.poll.balance)) await pollOnce();
  }

  function stopTimers() {
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
    if (ticker !== null) win.clearInterval(ticker);
    ticker = null;
  }

  function schedule() {
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
    const d = decision();
    if (!d.run) {
      if (d.retire && !retired) {
        retired = true;
        stopTimers();
        render();
      }
      return;
    }
    const wait = Math.max(d.delayMs, cfg.minPollMs - (clock() - lastPollAt));
    timer = win.setTimeout(async () => {
      timer = null;
      await pollOnce();
      schedule();
    }, wait);
  }

  function startTicker() {
    if (ticker !== null || tornDown || retired) return;
    ticker = win.setInterval(() => {
      if (!tornDown && !hidden && !offscreen) render();
    }, 1000);
  }

  /** Poll now (if allowed) and keep going. */
  function resumeIfAllowed() {
    if (!initialised || tornDown || retired) return;
    const d = decision();
    if (!d.run) {
      schedule();
      return;
    }
    startTicker();
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
    if (clock() - lastPollAt >= cfg.minPollMs) {
      pollOnce().then(schedule);
    } else {
      schedule();
    }
  }

  function updateAway() {
    const away = hidden || offscreen;
    if (away && awaySince === null) {
      awaySince = clock();
      stopTimers();
    } else if (!away && awaySince !== null) {
      const gone = clock() - awaySince;
      awaySince = null;
      if (gone >= cfg.retireAfterMs) {
        retired = true;
        render();
        return;
      }
      resumeIfAllowed();
    }
  }

  function resume() {
    retired = false;
    awaySince = null;
    render();
    resumeIfAllowed();
  }

  // ---------------------------------------------------------------------------------------------
  // Actions: toward the conversation or the display, never toward the game
  // ---------------------------------------------------------------------------------------------
  function feedback(text: string) {
    setText(R.live, text);
  }

  async function sendAction(kind: string) {
    try {
      let balance: any;
      if (kind === "route") {
        // The button says it sends the balance: that click is the player's explicit choice.
        showBalance = true;
        await pollWithBalance();
        render();
        balance = view.poll && view.poll.balance ? view.poll.balance.uec : undefined;
      }
      const vehicle = view.poll && view.poll.ship ? view.poll.ship.name : "";
      const text = L.actionMessage(kind, { vehicle, balance });
      if (!text) {
        feedback(
          kind === "route" ? "Solde indisponible : rien n\u2019a été envoyé." : "Rien à envoyer.",
        );
        return;
      }
      await request("ui/message", { role: "user", content: [{ type: "text", text }] });
      feedback(
        kind === "route"
          ? "Message envoyé à Claude, avec ton solde. Réduis la vue pour lire sa réponse."
          : "Message envoyé à Claude. Réduis la vue pour lire sa réponse.",
      );
    } catch (err: any) {
      feedback("Envoi impossible : " + (err && err.message ? err.message : "erreur"));
    }
  }

  function contextTick() {
    const summary = L.contextSummary(view.poll, view.events);
    const d = L.contextDecision(gate, summary, clock());
    gate = d.gate;
    if (d.send) {
      request("ui/update-model-context", { content: [{ type: "text", text: d.text }] }).catch(
        () => undefined,
      );
    }
  }

  async function mark(action: string) {
    try {
      const r = await request("tools/call", { name: "sc_live_mark", arguments: { action } });
      const sc = r && r.structuredContent;
      feedback(sc && typeof sc.message === "string" ? sc.message : "Marqueur enregistré.");
      await pollOnce();
    } catch (err: any) {
      feedback("Marqueur impossible : " + (err && err.message ? err.message : "erreur"));
    }
  }

  function toggleBalance() {
    showBalance = !showBalance;
    if (!showBalance && view.poll) {
      // Hidden again: forget it here too. The next answers will not carry it.
      view = Object.assign({}, view, {
        poll: Object.assign({}, view.poll, { balance: undefined }),
      });
    }
    render();
    if (showBalance) void pollWithBalance().then(render);
  }

  async function requestMode(mode: string) {
    try {
      const r = await request("ui/request-display-mode", { mode });
      setMode(r && typeof r.mode === "string" ? r.mode : "inline");
    } catch {
      feedback("Changement d\u2019affichage refusé par l\u2019hôte.");
    }
  }

  function setMode(mode: string) {
    displayMode = mode === "fullscreen" ? "fullscreen" : "inline";
    renderModeUi();
    render();
  }

  // ---------------------------------------------------------------------------------------------
  // Host context (theme, style variables, display mode)
  // ---------------------------------------------------------------------------------------------
  function applyHost() {
    const rootEl = doc.documentElement;
    if (hostCtx.theme === "light" || hostCtx.theme === "dark") {
      rootEl.setAttribute("data-theme", hostCtx.theme);
      rootEl.style.setProperty("color-scheme", hostCtx.theme);
    }
    const vars = L.safeStyleVariables(hostCtx.styles && hostCtx.styles.variables);
    for (const kv of vars) rootEl.style.setProperty(kv[0], kv[1]);
    if (Array.isArray(hostCtx.availableDisplayModes))
      availableModes = hostCtx.availableDisplayModes.filter((m: any) => typeof m === "string");
    const insets = hostCtx.safeAreaInsets;
    if (insets && typeof insets === "object") {
      for (const side of ["top", "right", "bottom", "left"]) {
        const v = insets[side];
        rootEl.style.setProperty(
          "--safe-" + side,
          typeof v === "number" && v >= 0 && v < 400 ? v + "px" : "0px",
        );
      }
    }
    if (hostCtx.displayMode) setMode(hostCtx.displayMode);
    else renderModeUi();
  }

  // ---------------------------------------------------------------------------------------------
  // Incoming messages: only from the parent window
  // ---------------------------------------------------------------------------------------------
  win.addEventListener("message", (e: any) => {
    if (e.source !== win.parent) return;
    const m = e.data;
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return;
    if (m.method === undefined) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message || "erreur"));
      else p.resolve(m.result);
      return;
    }
    if (m.id !== undefined) {
      // A request from the host.
      if (m.method === "ping") {
        send({ id: m.id, result: {} });
      } else if (m.method === "ui/resource-teardown") {
        tornDown = true;
        stopTimers();
        send({ id: m.id, result: {} });
      } else {
        send({ id: m.id, error: { code: -32601, message: "Method not found" } });
      }
      return;
    }
    if (m.method === "ui/notifications/host-context-changed") {
      hostCtx = Object.assign({}, hostCtx, m.params || {});
      applyHost();
    } else if (m.method === "ui/notifications/tool-result") {
      const sc = m.params && m.params.structuredContent;
      if (sc && typeof sc === "object" && sc.plan) {
        view = Object.assign({}, view, { plan: L.cleanPlan(sc.plan) });
        render();
      }
      resumeIfAllowed();
    }
    // tool-input and everything else: not used. The plan is read from the validated result only.
  });

  doc.addEventListener("visibilitychange", () => {
    hidden = !!doc.hidden;
    updateAway();
  });
  if (typeof win.IntersectionObserver === "function") {
    new win.IntersectionObserver((entries: any[]) => {
      const last = entries[entries.length - 1];
      offscreen = !!last && !last.isIntersecting;
      updateAway();
    }).observe(doc.body);
  }
  if (typeof win.ResizeObserver === "function") {
    new win.ResizeObserver(() => reportSize()).observe(doc.body);
  }

  // ---------------------------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------------------------
  build();
  renderModeUi();
  render();
  (async () => {
    try {
      const r = await request("ui/initialize", {
        appInfo: { name: "sc-copilot-live-dashboard", version: "1" },
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
        protocolVersion: "2026-01-26",
      });
      hostCtx = (r && r.hostContext) || {};
      applyHost();
      notify("ui/notifications/initialized");
      initialised = true;
      resumeIfAllowed();
    } catch (err: any) {
      view = L.reducePollError(
        view,
        err && err.message ? err.message : "hôte sans MCP Apps",
        clock(),
      );
      render();
    }
  })();

  return {
    /** For the tests only. */
    debug: () => ({ view, showBalance, displayMode, hidden, offscreen, tornDown, retired, gate }),
  };
}
