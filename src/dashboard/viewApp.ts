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
  let toastTimer: any = null;
  let streamLive = false;
  let inFlight: Promise<void> | null = null;
  let lastPollAt = 0;
  let gate = L.initialContextGate();
  let lastStreamId = "";
  let lastSize = "";
  const pins: Record<string, boolean> = {};
  // Several Views of one conversation: only the leader polls (see viewLogic.electLeader).
  const viewId: string = L.makeViewId(clock(), Math.random());
  let rank = clock();
  let peers: any = {};
  let channel: any = null;
  let leaderId: string | null = viewId;
  let heartbeats = 0;
  let lastShareAt = 0;

  // ---------------------------------------------------------------------------------------------
  // Protocol: JSON-RPC 2.0 over postMessage, written by hand
  // ---------------------------------------------------------------------------------------------
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const send = (message: any) => {
    win.parent.postMessage(Object.assign({ jsonrpc: "2.0" }, message), "*");
  };
  const notify = (method: string, params?: any) => send({ method, params });
  const request = (method: string, params?: any, timeoutMs?: number): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const t = win.setTimeout(() => {
        pending.delete(id);
        reject(new Error("délai dépassé : " + method));
      }, timeoutMs || cfg.requestTimeoutMs);
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
  const R: any = { cards: [], widgets: {} };
  /** Marks a node as a widget of the coverage table (the test looks for every id of coverage.ts in the page). */
  const widget = (id: string, node: any): any => {
    node.setAttribute("data-w", id);
    return node;
  };
  const arcD = (r: number): string => {
    const k = Math.SQRT1_2 * r;
    const f = (n: number) => String(Math.round(n * 100) / 100);
    return (
      "M " +
      f(50 - k) +
      " " +
      f(50 + k) +
      " A " +
      r +
      " " +
      r +
      " 0 1 1 " +
      f(50 + k) +
      " " +
      f(50 + k)
    );
  };
  const arcPath = (r: number, cls: string): any => {
    const p = svg("path");
    p.setAttribute("d", arcD(r));
    p.setAttribute("pathLength", "100");
    p.setAttribute("class", cls);
    p.setAttribute("fill", "none");
    return p;
  };
  const pct = (fraction: number | null): string =>
    fraction === null || fraction === undefined ? "0" : String(Math.round(fraction * 1000) / 10);

  // --- a dial: a 270 degree arc, ticks, threshold zones, a "highest seen" mark, the value in the middle ---------
  function dial(key: string, label: string, size: string, zones?: any[]): any {
    const d: any = { root: el("div", "dial " + size) };
    d.root.setAttribute("data-key", key);
    d.svg = svg("svg");
    d.svg.setAttribute("viewBox", "0 0 100 100");
    d.svg.setAttribute("class", "dial-svg");
    d.svg.setAttribute("aria-hidden", "true");
    add(d.svg, arcPath(40, "arc-track"));
    for (const z of zones || []) {
      const p = arcPath(47.5, "arc-zone");
      p.setAttribute("data-tone", z[2]);
      p.setAttribute("stroke-dasharray", "0 " + z[0] * 100 + " " + (z[1] - z[0]) * 100 + " 200");
      add(d.svg, p);
    }
    const ticks = arcPath(47.5, "arc-ticks");
    ticks.setAttribute("stroke-dasharray", "0.5 9.5");
    add(d.svg, ticks);
    d.fill = arcPath(40, "arc-fill");
    d.peak = arcPath(40, "arc-peak");
    add(d.svg, d.fill, d.peak);
    if (key === "speed") {
      // Marks of the ship's sheet (specsView.ts): SCM speed and top speed, drawn on the arc like the peak.
      d.markScm = arcPath(40, "arc-mark");
      d.markScm.setAttribute("data-kind", "scm");
      d.markMax = arcPath(40, "arc-mark");
      d.markMax.setAttribute("data-kind", "max");
      add(d.svg, d.markScm, d.markMax);
    }
    d.body = el("div", "dial-body");
    d.value = el("div", "dial-value", "—");
    d.label = el("div", "dial-label", label);
    d.sub = el("div", "dial-sub", "");
    add(d.body, d.value, d.label);
    add(d.root, d.svg, d.body, d.sub);
    return d;
  }

  function setDial(d: any, info: any) {
    setText(d.value, info.text);
    setAttr(d.value, "data-unit", info.unit || "");
    setText(d.sub, info.sub || "");
    const frac = typeof info.fraction === "number" ? info.fraction : null;
    setAttr(d.fill, "stroke-dasharray", pct(frac) + " 200");
    const peak = typeof info.peak === "number" ? info.peak : null;
    setAttr(
      d.peak,
      "stroke-dasharray",
      peak === null ? "0 0 0 200" : "0 " + Math.max(0, peak * 100 - 0.6) + " 1.2 200",
    );
    setAttr(d.root, "data-level", info.level || "none");
    setAttr(d.root, "data-known", info.known === false ? "0" : "1");
    if (d.markScm) {
      const marks = info.marks || null;
      const at = (m: any, v: any): string =>
        typeof v === "number" ? "0 " + Math.max(0, v * 100 - 0.6) + " 1.2 200" : "0 0 0 200";
      setAttr(d.markScm, "stroke-dasharray", at(d.markScm, marks ? marks.scm : null));
      setAttr(d.markMax, "stroke-dasharray", at(d.markMax, marks ? marks.max : null));
      setAttr(d.root, "data-over", info.over || "none");
      setAttr(d.root, "data-sheet", marks ? "1" : "0");
    }
  }

  // --- a horizontal gauge with threshold zones -----------------------------------------------------------------
  function gauge(zones?: any[]): any {
    const g: any = { root: el("div", "gauge") };
    g.zoneEls = [];
    for (const z of zones || []) {
      const n = el("span", "gauge-zone");
      n.setAttribute("data-tone", z[2]);
      n.style.setProperty("left", z[0] * 100 + "%");
      n.style.setProperty("width", (z[1] - z[0]) * 100 + "%");
      add(g.root, n);
    }
    g.fill = el("span", "gauge-fill");
    add(g.root, g.fill);
    return g;
  }
  function setGauge(g: any, fraction: number | null, level: string) {
    setVar(g.fill, "--p", pct(fraction));
    setAttr(g.root, "data-level", level || "none");
    setAttr(g.root, "data-empty", fraction === null ? "1" : "0");
  }

  /** A gauge line: label and value above, the bar below, a small line of detail. */
  function meter(label: string, zones?: any[]): any {
    const m: any = { root: el("div", "meter") };
    m.head = el("div", "meter-head");
    m.label = el("span", "meter-label", label);
    m.value = el("span", "meter-value", "—");
    add(m.head, m.label, m.value);
    m.gauge = gauge(zones);
    m.sub = el("div", "meter-sub", "");
    add(m.root, m.head, m.gauge.root, m.sub);
    return m;
  }
  function setMeter(m: any, info: any) {
    setText(m.value, info.text);
    setText(m.sub, info.sub || "");
    setGauge(m.gauge, typeof info.fraction === "number" ? info.fraction : null, info.level);
    setAttr(m.root, "data-level", info.level || "none");
  }

  function fact(label: string): any {
    const r: any = { root: el("div", "fact") };
    r.label = el("span", "fact-label", label);
    r.value = el("span", "fact-value", "—");
    add(r.root, r.label, r.value);
    return r;
  }

  function pinIcon(): any {
    const s = svg("svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("class", "pin-icon");
    s.setAttribute("aria-hidden", "true");
    const p = svg("path");
    p.setAttribute("d", "M9 3h6l-1 6 3 3v2h-4v6l-1 1-1-1v-6H7v-2l3-3z");
    add(s, p);
    return s;
  }
  /** A pin on a data: shown on hover or focus (and always when pinned); pinned data go to the bar at the top. */
  function pinButton(key: string, label: string): any {
    const b = el("button", "pin");
    b.setAttribute("type", "button");
    b.setAttribute("aria-pressed", "false");
    b.setAttribute("aria-label", "Épingler : " + label);
    b.setAttribute("title", "Épingler en haut : " + label);
    add(b, pinIcon());
    b._key = key;
    b.addEventListener("click", () => {
      pins[key] = !pins[key];
      render();
    });
    R.pinButtons.push(b);
    return b;
  }

  function card(title: string, cls?: string): any {
    const c: any = { root: el("section", "card" + (cls ? " " + cls : "")) };
    c.head = el("div", "card-head");
    c.title = el("h2", "card-title", title);
    c.age = el("span", "age", "");
    add(c.head, c.title, c.age);
    c.body = el("div", "card-body");
    add(c.root, c.head, c.body);
    R.cards.push(c);
    return c;
  }

  function chip(cls?: string): any {
    return el("span", "chip" + (cls ? " " + cls : ""), "");
  }

  function spark(): any {
    const s: any = { root: el("div", "curve") };
    s.head = el("div", "curve-head");
    s.label = el("span", "curve-label", "");
    s.value = el("span", "curve-value", "—");
    add(s.head, s.label, s.value);
    s.svg = svg("svg");
    s.svg.setAttribute("viewBox", "0 0 120 32");
    s.svg.setAttribute("preserveAspectRatio", "none");
    s.svg.setAttribute("class", "spark");
    s.svg.setAttribute("aria-hidden", "true");
    s.line = svg("polyline");
    s.line.setAttribute("fill", "none");
    s.line.setAttribute("points", "");
    add(s.svg, s.line);
    s.range = el("div", "curve-range", "");
    add(s.root, s.head, s.svg, s.range);
    return s;
  }

  const CURVES: any[] = [
    [
      "speed",
      "Vitesse",
      (v: number) => {
        const f = L.formatSpeed(v);
        return f.value + "\u00a0" + f.unit;
      },
    ],
    ["altitude", "Altitude", (v: number) => L.formatDistance(v)],
    ["g", "Force G", (v: number) => L.fmtNum(v, 1) + "\u00a0G"],
    ["hydrogen", "Hydrogène", (v: number) => L.fmtNum(Math.round(v * 100)) + "\u00a0%"],
    ["heart", "Rythme cardiaque", (v: number) => L.fmtNum(v, 0) + "\u00a0bpm"],
    ["health", "Santé", (v: number) => L.fmtNum(Math.round(v * 100)) + "\u00a0%"],
  ];

  // ---------------------------------------------------------------------------------------------
  // The page, built once. render() only changes text and attributes afterwards.
  // ---------------------------------------------------------------------------------------------
  function build() {
    R.pinButtons = [];

    // Header: stream state, the verdict at a glance, the buttons
    R.top = el("header", "top");
    R.status = el("div", "status");
    R.dot = el("span", "dot");
    R.statusLabel = el("span", "status-label", "Connexion…");
    R.statusDetail = el("span", "status-detail", "");
    add(R.status, R.dot, R.statusLabel, R.statusDetail);
    R.verdict = el("span", "verdict", "");
    R.topActions = el("div", "top-actions");
    R.age = el("span", "age", "");
    R.btnAnalyse = button("Analyser", () => sendAction("analyse"), "small");
    R.btnAnalyse.setAttribute(
      "title",
      "Analyser ma situation : demande à Claude d’analyser la télémétrie",
    );
    R.btnMode = button(
      "Plein écran",
      () => requestMode(displayMode === "fullscreen" ? "inline" : "fullscreen"),
      "primary",
    );
    // The health strip (healthPanel.ts): what is wired and what is missing. Its "?" button sits in the header.
    R.health = L.healthPanel(doc, L, {
      get: storageGet,
      set: storageSet,
      copy: copyText,
      say: (text: string) => feedback(text),
      later: (fn: () => void, ms: number) => win.setTimeout(fn, ms),
    });
    add(R.topActions, R.age, R.btnAnalyse, R.health.help, R.btnMode);
    add(R.top, R.status, R.verdict, R.topActions);
    R.toastTop = el("div", "toast toast-top", "");
    R.toastTop.setAttribute("aria-hidden", "true");

    // Notices: another dashboard polls / the stream is not live
    R.supersede = el("div", "notice");
    R.supersedeText = el("p", "notice-text", "Remplacé par un tableau de bord plus récent");
    R.btnLead = button("Reprendre ici", () => takeLead(), "primary");
    add(R.supersede, R.supersedeText, R.btnLead);
    R.notice = el("div", "notice");
    R.noticeText = el("p", "notice-text", "");
    R.noticeCmd = el("code", "notice-cmd", "");
    R.btnResume = button("Reprendre", () => resume(), "primary");
    add(R.notice, R.noticeText, R.noticeCmd, R.btnResume);

    // The ship, in one banner: name, maker, where it is, gear and lights
    R.ctx = el("section", "ctx offable");
    R.ctxMain = el("div", "ctx-main");
    R.ctxTitle = widget("ship", el("div", "ctx-title", "—"));
    R.ctxMaker = el("div", "ctx-maker", "");
    add(R.ctxMain, R.ctxTitle, R.ctxMaker);
    R.ctxChips = el("div", "ctx-chips");
    R.ctxState = widget("mode", chip("state"));
    R.ctxGear = widget("gear", chip());
    R.ctxLights = widget("headlights", chip("unverified-chip"));
    add(R.ctxChips, R.ctxState, R.ctxGear, R.ctxLights);
    add(R.ctx, R.ctxMain, R.ctxChips);

    // Conditions first (what is true now), then the recent events
    R.alerts = el("div", "alerts");
    widget("conditions", R.alerts);
    R.alertsEmpty = el("span", "alerts-empty", "Aucune alerte");
    R.condList = [];
    R.alertList = [];
    add(R.alerts, R.alertsEmpty);
    for (let i = 0; i < 8; i++) {
      const c = el("span", "alert condition");
      c.label = el("span", "alert-label", "");
      c.meta = el("span", "alert-meta", "");
      add(c, c.label, c.meta);
      R.condList.push(c);
      add(R.alerts, c);
    }
    for (let i = 0; i < 3; i++) {
      const a = el("span", "alert");
      a.label = el("span", "alert-label", "");
      a.meta = el("span", "alert-meta", "");
      add(a, a.label, a.meta);
      R.alertList.push(a);
      add(R.alerts, a);
    }

    // Pinned data
    R.pinbar = el("div", "pinbar");
    R.pinChips = [];
    for (let i = 0; i < 10; i++) {
      const c = el("span", "pin-chip");
      c.label = el("span", "pin-chip-label", "");
      c.value = el("span", "pin-chip-value", "");
      add(c, c.label, c.value);
      R.pinChips.push(c);
      add(R.pinbar, c);
    }

    // ---------------------------------------------------------------- compact view
    R.inline = el("section", "inline offable");
    R.iSpeed = dial("speed", "Vitesse", "small");
    R.iHydrogen = dial("hydrogen", "Hydrogène", "small", [
      [0, 0.1, "bad"],
      [0.1, 0.25, "warn"],
    ]);
    R.iHealth = dial("health", "Santé", "small", [
      [0, 0.15, "bad"],
      [0.15, 0.3, "warn"],
    ]);
    R.iDials = el("div", "dials");
    add(R.iDials, R.iSpeed.root, R.iHydrogen.root, R.iHealth.root);
    R.iBalance = el("div", "balance-row");
    R.iBalanceLabel = el("span", "balance-label", "Solde");
    R.iBalanceValue = el("span", "balance-value", "••••••");
    R.btnBalance = button("Afficher le solde", () => toggleBalance(), "mini");
    add(R.iBalance, R.iBalanceLabel, R.iBalanceValue, R.btnBalance);
    add(R.inline, R.iDials, R.iBalance);

    // ---------------------------------------------------------------- cockpit
    R.full = el("div", "full");
    R.offNote = el(
      "p",
      "off-note",
      "Vaisseau éteint : la centrale est hors service, les instruments ne sont plus alimentés.",
    );

    // Left: instruments
    R.colInstr = el("div", "col col-instr");
    const cIns = card("Instruments", "pinnable-card");
    R.xSpeed = dial("speed", "Vitesse", "xl");
    widget("speed", R.xSpeed.root);
    R.xG = dial("g", "Force G", "m", [
      [0.7, 0.9, "warn"],
      [0.9, 1, "bad"],
    ]);
    widget("g", R.xG.root);
    add(R.xSpeed.root, pinButton("speed", "vitesse"));
    add(R.xG.root, pinButton("g", "force G"));
    R.dialsRow = el("div", "dials-row");
    add(R.dialsRow, R.xSpeed.root, R.xG.root);
    // Altitude and vertical speed
    R.altBox = widget("altitude", el("div", "alt-box pinnable"));
    R.altLabel = el("div", "meter-label", "Altitude");
    R.altValue = el("div", "val-l", "—");
    R.altRadar = el("div", "meter-sub", "");
    R.altSub = el("div", "meter-sub", "");
    add(R.altBox, R.altLabel, R.altValue, R.altRadar, R.altSub, pinButton("altitude", "altitude"));
    R.vsBox = widget("vspeed", el("div", "vs-box pinnable"));
    R.vsHead = el("div", "meter-head");
    R.vsLabel = el("span", "meter-label", "Vitesse verticale");
    R.vsValue = el("span", "meter-value", "—");
    add(R.vsHead, R.vsLabel, R.vsValue);
    R.vsBar = el("div", "bidi");
    R.vsNeg = el("span", "bidi-fill bidi-neg");
    R.vsPos = el("span", "bidi-fill bidi-pos");
    R.vsZero = el("span", "bidi-zero");
    add(R.vsBar, R.vsNeg, R.vsPos, R.vsZero);
    R.vsSub = el("div", "meter-sub", "");
    add(R.vsBox, R.vsHead, R.vsBar, R.vsSub, pinButton("vspeed", "vitesse verticale"));
    R.altRow = el("div", "alt-row");
    add(R.altRow, R.altBox, R.vsBox);
    // Compass
    R.compass = widget("heading", el("div", "compass"));
    R.compassSvg = svg("svg");
    R.compassSvg.setAttribute("viewBox", "0 0 100 100");
    R.compassSvg.setAttribute("class", "compass-svg");
    R.compassSvg.setAttribute("aria-hidden", "true");
    const ringA = svg("circle");
    ringA.setAttribute("cx", "50");
    ringA.setAttribute("cy", "50");
    ringA.setAttribute("r", "43");
    ringA.setAttribute("pathLength", "360");
    ringA.setAttribute("transform", "rotate(-90 50 50)");
    ringA.setAttribute("class", "ring-minor");
    ringA.setAttribute("stroke-dasharray", "0.8 9.2");
    const ringB = svg("circle");
    ringB.setAttribute("cx", "50");
    ringB.setAttribute("cy", "50");
    ringB.setAttribute("r", "43");
    ringB.setAttribute("pathLength", "360");
    ringB.setAttribute("transform", "rotate(-90 50 50)");
    ringB.setAttribute("class", "ring-major");
    ringB.setAttribute("stroke-dasharray", "2 88");
    add(R.compassSvg, ringA, ringB);
    const letters: any[] = [
      ["N", 50, 28],
      ["E", 72, 51],
      ["S", 50, 74],
      ["O", 28, 51],
    ];
    for (const l of letters) {
      const t = svg("text");
      t.setAttribute("x", String(l[1]));
      t.setAttribute("y", String(l[2]));
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("class", "compass-letter");
      t.textContent = l[0];
      add(R.compassSvg, t);
    }
    R.needle = svg("g");
    R.needle.setAttribute("class", "needle");
    const arrow = svg("polygon");
    arrow.setAttribute("points", "50,22 56,52 50,47 44,52");
    add(R.needle, arrow);
    add(R.compassSvg, R.needle);
    R.compassBody = el("div", "compass-body");
    R.compassValue = el("div", "compass-value", "—");
    R.compassCard = el("div", "compass-card", "");
    add(R.compassBody, R.compassValue, R.compassCard);
    R.compassSub = el("div", "meter-sub compass-sub", "");
    add(R.compass, R.compassSvg, R.compassBody);
    R.compassWrap = el("div", "compass-wrap");
    add(R.compassWrap, R.compass, R.compassSub);
    R.insNote = el("p", "note", "");
    R.density = widget("atmosphere", el("div", "meter-sub", ""));
    add(cIns.body, R.dialsRow, R.altRow, R.compassWrap, R.density, R.insNote);
    add(R.colInstr, cIns.root);

    // The sheet of the ship, from the wiki (specsView.ts): what does not fit on a dial
    const cSpecs = card("Fiche du vaisseau (wiki)");
    // Its age is the sheet's own (a row below), not the frame's: the card is left out of the ticking ages.
    R.cards.pop();
    R.specsRows = [];
    R.specsFacts = el("div", "facts");
    for (let i = 0; i < 6; i++) {
      const r = fact("");
      R.specsRows.push(r);
      add(R.specsFacts, r.root);
    }
    add(cSpecs.body, R.specsFacts);
    R.specsLine = el("p", "note", "");
    R.specsNote = el("p", "note", "");
    add(cSpecs.body, R.specsLine, R.specsNote);
    add(R.colInstr, cSpecs.root);

    // Centre: the ship
    R.colShip = el("div", "col col-ship");
    const cEn = card("Énergie");
    R.xHydrogen = meter("Hydrogène", [
      [0, 0.1, "bad"],
      [0.1, 0.25, "warn"],
    ]);
    widget("hydrogen", R.xHydrogen.root);
    add(R.xHydrogen.root, pinButton("hydrogen", "hydrogène"));
    R.xBoost = meter("Boost : réserve", [
      [0, 0.1, "bad"],
      [0.1, 0.25, "warn"],
    ]);
    widget("boost", R.xBoost.root);
    add(R.xBoost.root, pinButton("boost", "boost"));
    R.boostGauge = gauge();
    R.boostOutWrap = el("div", "meter small-meter");
    R.boostOutHead = el("div", "meter-head");
    R.boostOutLabel = el("span", "meter-label", "Boost : sortie");
    R.boostOutValue = el("span", "meter-value", "—");
    add(R.boostOutHead, R.boostOutLabel, R.boostOutValue);
    add(R.boostOutWrap, R.boostOutHead, R.boostGauge.root);
    R.etaNote = el("p", "note", "");
    add(cEn.body, R.xHydrogen.root, R.xBoost.root, R.boostOutWrap, R.etaNote);
    // Power diagram
    const cPwr = card("Alimentation");
    R.pwr = widget("power", el("div", "pwr"));
    R.pwrPlant = el("div", "pwr-node pwr-plant");
    R.pwrPlant.label = el("span", "pwr-label", "Centrale");
    R.pwrPlant.state = el("span", "pwr-state", "");
    add(R.pwrPlant, R.pwrPlant.label, R.pwrPlant.state);
    R.pwrGrid = el("div", "pwr-grid");
    R.pwrNodes = [];
    for (let i = 0; i < 8; i++) {
      const n = el("div", "pwr-node");
      n.label = el("span", "pwr-label", "");
      n.state = el("span", "pwr-state", "");
      add(n, n.label, n.state);
      R.pwrNodes.push(n);
      add(R.pwrGrid, n);
    }
    add(R.pwr, R.pwrPlant, R.pwrGrid);
    R.modes = widget("modes", el("div", "chips"));
    R.modeChips = [];
    for (let i = 0; i < 6; i++) {
      const c = chip();
      R.modeChips.push(c);
      add(R.modes, c);
    }
    add(cPwr.body, R.pwr, el("h3", "sub-title", "Modes de vol"), R.modes);
    // Warning lights as an annunciator panel
    const cLights = card("Voyants");
    R.lights = widget("lights", el("div", "lamps"));
    R.lightEls = [];
    for (let i = 0; i < 10; i++) {
      const l = el("div", "lamp");
      l.name = el("span", "lamp-name", "");
      l.state = el("span", "lamp-state", "");
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
        "Le niveau des boucliers n’est pas fourni par le jeu : seul le voyant SHLD l’indique. Les voyants en pointillé ne sont pas vérifiés.",
      ),
    );
    // Weapons and countermeasures
    const cWeap = card("Armes et contre-mesures");
    R.weaponSummary = widget("weapons", el("p", "weap-summary", ""));
    R.weapons = el("div", "weapons");
    R.weaponRows = [];
    for (let i = 0; i < 8; i++) {
      const w = el("div", "weap");
      w.dot = el("span", "weap-dot");
      w.name = el("span", "weap-name", "");
      w.state = el("span", "weap-state", "");
      add(w, w.dot, w.name, w.state);
      R.weaponRows.push(w);
      add(R.weapons, w);
    }
    R.gimbals = widget("gimbals", chip("unverified-chip"));
    R.cm = widget("cm", el("div", "cms"));
    R.cmRows = [];
    for (let i = 0; i < 2; i++) {
      const m = meter(i === 0 ? "Leurres" : "Brouillage");
      R.cmRows.push(m);
      add(R.cm, m.root);
    }
    add(
      cWeap.body,
      R.weaponSummary,
      R.weapons,
      R.gimbals,
      R.cm,
      el(
        "p",
        "note",
        "Munitions : non fournies par le jeu. La barre compare au plus haut niveau vu pour ce vaisseau.",
      ),
    );
    add(R.colShip, cEn.root, cPwr.root, cLights.root, cWeap.root);

    // Right: the pilot
    R.colPilot = el("div", "col col-pilot");
    const cPilot = card("Pilote");
    R.xHealth = dial("health", "Santé", "m", [
      [0, 0.15, "bad"],
      [0.15, 0.3, "warn"],
    ]);
    widget("health", R.xHealth.root);
    add(R.xHealth.root, pinButton("health", "santé"));
    R.xHunger = dial("hunger", "Faim", "s", [
      [0, 0.1, "bad"],
      [0.1, 0.25, "warn"],
    ]);
    widget("hunger", R.xHunger.root);
    add(R.xHunger.root, pinButton("hunger", "faim"));
    R.xThirst = dial("thirst", "Soif", "s", [
      [0, 0.1, "bad"],
      [0.1, 0.25, "warn"],
    ]);
    widget("thirst", R.xThirst.root);
    add(R.xThirst.root, pinButton("thirst", "soif"));
    R.vitalDials = el("div", "dials-row vitals");
    add(R.vitalDials, R.xHealth.root, R.xHunger.root, R.xThirst.root);
    R.fHeart = fact("Rythme cardiaque");
    widget("heart", R.fHeart.root);
    add(R.fHeart.root, pinButton("heart", "rythme cardiaque"));
    R.fGravity = fact("Gravité");
    widget("gravity", R.fGravity.root);
    R.fPressure = fact("Pression");
    widget("pressure", R.fPressure.root);
    R.fTemp = fact("Température ext.");
    widget("temperature", R.fTemp.root);
    R.fAir = fact("Atmosphère");
    widget("air", R.fAir.root);
    R.fLoco = fact("Position du corps");
    widget("locomotion", R.fLoco.root);
    R.fCrew = fact("Rôle");
    widget("crew", R.fCrew.root);
    R.facts = el("div", "facts");
    add(
      R.facts,
      R.fHeart.root,
      R.fGravity.root,
      R.fPressure.root,
      R.fTemp.root,
      R.fAir.root,
      R.fLoco.root,
      R.fCrew.root,
    );
    R.seat = el("div", "meter-sub", "");
    R.vitalsNote = el("p", "note", "");
    add(cPilot.body, R.vitalDials, R.facts, R.seat, R.vitalsNote);
    add(R.colPilot, cPilot.root);

    // Wide cards
    R.wide = el("div", "wide");
    const cCurves = card("Courbes · 60 dernières secondes");
    R.curves = el("div", "curves");
    R.curveEls = [];
    for (const def of CURVES) {
      const s = spark();
      setText(s.label, def[1]);
      R.curveEls.push(s);
      add(R.curves, s.root);
    }
    add(
      cCurves.body,
      R.curves,
      el(
        "p",
        "note",
        "Calculées par cette vue à partir des relevés reçus : rien n’est enregistré.",
      ),
    );
    // Session
    const cSes = card("Compteurs de vol");
    R.sesEmpty = el(
      "p",
      "empty-note",
      "Appuie sur « Début des compteurs » pour mesurer décollages, sauts, temps de vol et rythme.",
    );
    R.sesButtons = el("div", "btn-row");
    R.btnStart = button("Début des compteurs", () => mark("start"), "small");
    R.btnEnd = button("Fin des compteurs", () => mark("end"), "small");
    R.btnReset = button("Solde à zéro", () => mark("reset_delta"), "small");
    add(R.sesButtons, R.btnStart, R.btnEnd, R.btnReset);
    R.sesRows = el("div", "facts ses-facts");
    R.sesState = fact("Session");
    R.sesTakeoffs = fact("Décollages");
    R.sesLandings = fact("Atterrissages");
    R.sesJumps = fact("Sauts quantiques");
    R.sesFlight = fact("Temps de vol (estimé)");
    add(
      R.sesRows,
      R.sesState.root,
      R.sesTakeoffs.root,
      R.sesLandings.root,
      R.sesJumps.root,
      R.sesFlight.root,
    );
    R.sesBalanceBox = widget("balance", el("div", "facts ses-balance"));
    R.sesBalance = fact("Solde");
    R.btnBalance2 = button("Afficher le solde", () => toggleBalance(), "mini");
    add(R.sesBalance.root, R.btnBalance2);
    R.sesDelta = fact("Variation");
    R.sesRate = fact("Rythme");
    add(R.sesBalanceBox, R.sesBalance.root, R.sesDelta.root, R.sesRate.root);
    R.sesNote = el("p", "note", "");
    add(cSes.body, R.sesEmpty, R.sesButtons, R.sesRows, R.sesBalanceBox, R.sesNote);
    // One chronology
    const cEv = card("Chronologie");
    R.filter = "all";
    R.filterRow = el("div", "seg");
    R.filterRow.setAttribute("role", "group");
    R.filterRow.setAttribute("aria-label", "Filtrer la chronologie");
    R.filterBtns = [];
    for (const f of [
      ["all", "Tout"],
      ["alerts", "Alertes"],
      ["markers", "Mes marqueurs"],
    ]) {
      const b = button(
        f[1] as string,
        () => {
          R.filter = f[0];
          render();
        },
        "mini",
      );
      b._filter = f[0];
      b.setAttribute("aria-pressed", "false");
      R.filterBtns.push(b);
      add(R.filterRow, b);
    }
    R.events = widget("events", el("ol", "events"));
    R.eventRows = [];
    for (let i = 0; i < 14; i++) {
      const li = el("li", "event");
      li.time = el("span", "event-time", "");
      li.text = el("span", "event-text", "");
      li.badge = el("span", "badge", "");
      add(li, li.time, li.text, li.badge);
      R.eventRows.push(li);
      add(R.events, li);
    }
    R.eventsNone = el("p", "empty-note", "");
    add(
      cEv.body,
      R.filterRow,
      R.events,
      R.eventsNone,
      el(
        "p",
        "note",
        "Les événements sont déduits des changements d’état : le jeu n’en envoie presque pas. « non vérifié » : jamais vu fonctionner en conditions réelles.",
      ),
    );
    // Ask Claude, with its confirmation next to the buttons
    const cAct = card("Demander à Claude");
    R.btnAnalyse2 = button("Analyser ma situation", () => sendAction("analyse"));
    R.btnRoute = button("Route avec mon solde et ce vaisseau", () => sendAction("route"));
    R.btnBilan = button("Bilan de session", () => sendAction("bilan"));
    R.actionCol = el("div", "btn-col");
    add(R.actionCol, R.btnAnalyse2, R.btnRoute, R.btnBilan);
    R.toast = el("div", "toast", "");
    R.toast.setAttribute("role", "status");
    R.toast.setAttribute("aria-live", "polite");
    R.actionNote = el(
      "p",
      "note",
      "La route envoie ton solde dans la conversation, par ce bouton seulement. Les autres messages n’en contiennent pas. Rien n’est envoyé au jeu.",
    );
    add(cAct.body, R.actionCol, R.toast, R.actionNote);
    // Unverified values and what the stream lacks
    R.unverified = widget("unverified", el("details", "missing"));
    R.unverifiedSummary = el(
      "summary",
      "missing-summary",
      "Valeurs non vérifiées (présentes dans le flux, jamais vues en conditions réelles)",
    );
    R.unverifiedList = el("ul", "unverified-list");
    R.unverifiedItems = [];
    for (let i = 0; i < 14; i++) {
      const li = el("li", "unverified-item");
      li.label = el("span", "unverified-label", "");
      li.text = el("span", "unverified-text", "");
      li.tag = el("span", "badge", "non vérifié");
      add(li, li.label, li.text, li.tag);
      R.unverifiedItems.push(li);
      add(R.unverifiedList, li);
    }
    add(R.unverified, R.unverifiedSummary, R.unverifiedList);
    R.missing = el("details", "missing");
    R.missingSummary = el("summary", "missing-summary", "Ce que le flux ne contient pas");
    R.missingList = el("ul", "missing-list");
    R.missingEls = [];
    for (let i = 0; i < 20; i++) {
      const li = el("li", "", "");
      R.missingEls.push(li);
      add(R.missingList, li);
    }
    add(R.missing, R.missingSummary, R.missingList);
    add(R.colInstr, cCurves.root);
    add(R.wide, cSes.root, cEv.root, cAct.root, R.unverified, R.missing);

    // Transport ledger (ledgerPanel.ts): a card in the pilot column, a compact line under the small view
    R.ledger = L.ledgerPanel(doc, L);
    add(R.colPilot, R.ledger.card);

    // Saved play sessions (sessionPanel.ts): the bar under the header; the data live on the server.
    R.sessions = L.sessionPanel(doc, L, {
      call: callSessionTool,
      copy: copyText,
      download: downloadText,
      canDownload: canDownload,
      refresh: () => pollOnce(),
      say: (text: string) => feedback(text),
      toggleBalance: () => toggleBalance(),
      setTimeout: (fn: () => void, ms: number) => win.setTimeout(fn, ms),
      clearTimeout: (t: any) => win.clearTimeout(t),
    });

    // Commerce card (tradePanel.ts): full width at the top of the cockpit, a compact line under the small view.
    // Its action bar (tradeActions.ts) is a separate component in a slot of the card; in the small view only a
    // button that opens the full screen is shown.
    R.trade = L.tradePanel(doc, L, SVG_NS);
    R.tradeActions = L.tradeActionsPanel(doc, L);
    add(R.trade.slot, R.tradeActions.root);
    // "Mouvements du solde" (movementsPanel.ts): a folded block in the card's details.
    R.movements = L.movementsPanel(doc, L);
    add(R.trade.more, R.movements.root);

    add(R.full, R.offNote, R.trade.card, R.colInstr, R.colShip, R.colPilot, R.wide);

    // Stream state changes are announced here, out of sight: the header already shows them.
    R.sr = el("div", "sr-only", "");
    R.sr.setAttribute("role", "status");
    R.sr.setAttribute("aria-live", "polite");

    add(
      root,
      R.top,
      R.sessions.root,
      R.toastTop,
      R.supersede,
      R.notice,
      R.health.root,
      R.ctx,
      R.alerts,
      R.pinbar,
      R.inline,
      R.ledger.line,
      R.trade.line,
      R.tradeActions.opener,
      R.full,
      R.sr,
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Rendering: only text and attributes that change are written
  // ---------------------------------------------------------------------------------------------
  function renderStatus(now: number, conds: any[]): any {
    const info = L.streamInfo(view, now);
    setAttr(root, "data-grey", info.grey ? "1" : "0");
    setAttr(root, "data-stream", info.id);
    setAttr(R.dot, "data-tone", info.tone);
    setText(R.statusLabel, info.label);
    // The notice below carries the detail of the states that have one: do not say it twice.
    const detailInNotice = info.id !== "live" && info.id !== "stale" && info.id !== "init";
    setText(R.statusDetail, detailInNotice ? "" : info.detail);
    const live = info.id === "live" || info.id === "stale";
    setText(R.age, live ? "Données de " + L.formatAge(L.frameAge(view, now)) : "");
    if (displayMode === "fullscreen") {
      for (const c of R.cards) setText(c.age, live ? L.formatAge(L.frameAge(view, now)) : "");
    }
    if (info.id !== lastStreamId) {
      lastStreamId = info.id;
      if (info.id !== "init") setText(R.sr, info.label + (info.detail ? " : " + info.detail : ""));
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
    // The health strip carries the same command with a copy button: say it once.
    show(
      R.noticeCmd,
      !!info.help && !retired && !(info.id === "off" && R.health.ownsTelemetryFix()),
    );
    show(R.btnResume, retired);
    show(R.supersede, isFollower() && !retired);
    // The verdict at a glance
    const verdict = info.grey ? null : L.summaryInfo(view.poll, conds);
    show(R.verdict, !!verdict);
    if (verdict) {
      setAttr(R.verdict, "data-tone", verdict.tone);
      setText(R.verdict, verdict.label);
    }
    return info;
  }

  function renderContext(now: number) {
    const ctx = L.shipContext(view.poll);
    show(R.ctx, ctx.has || ctx.state.label !== "");
    setText(R.ctxTitle, ctx.has ? ctx.title : ctx.state.label || "—");
    setText(R.ctxMaker, ctx.has ? ctx.maker : "");
    setText(R.ctxState, ctx.has ? ctx.state.label : "");
    show(R.ctxState, ctx.has);
    setAttr(R.ctxState, "data-state", ctx.state.id);
    const byId: any = {};
    for (const c of ctx.chips) byId[c.id] = c;
    const gear = byId.gear || byId.vtol;
    const gearText =
      (byId.gear ? byId.gear.label : "") +
      (byId.gear && byId.vtol ? " · " : "") +
      (byId.vtol ? byId.vtol.label : "");
    show(R.ctxGear, !!gear);
    setText(R.ctxGear, gearText);
    show(R.ctxLights, !!byId.lights);
    setText(R.ctxLights, byId.lights ? byId.lights.label + " (non vérifié)" : "");
    void now;
  }

  /** `current` is false when the values are greyed: an empty list then means "unknown", never "no alert". */
  function renderAlerts(now: number, conds: any[], current: boolean) {
    for (let i = 0; i < R.condList.length; i++) {
      const slot = R.condList[i];
      const c = conds[i];
      show(slot, !!c);
      if (c) {
        setAttr(slot, "data-tone", c.tone);
        setAttr(slot, "data-verified", c.verified ? "1" : "0");
        setText(slot.label, c.label);
        setText(
          slot.meta,
          (c.verified ? "" : "non vérifié · ") +
            (c.ageMs === null ? "" : "depuis " + L.formatAge(c.ageMs)),
        );
      }
    }
    const list = L.activeAlerts(
      L.visibleEvents(view, showBalance),
      now,
      3,
      L.coveredAlertKeys(view.poll),
    );
    show(R.alertsEmpty, current && list.length === 0 && conds.length === 0);
    for (let i = 0; i < R.alertList.length; i++) {
      const slot = R.alertList[i];
      const a = list[i];
      show(slot, !!a);
      if (a) {
        setAttr(slot, "data-tone", a.tone);
        setAttr(slot, "data-verified", a.verified ? "1" : "0");
        setText(slot.label, a.label);
        setText(slot.meta, (a.verified ? "" : "non vérifié · ") + "il y a " + L.formatAge(a.ageMs));
      }
    }
  }

  function renderPins(I: any, now: number) {
    const items = L.pinnedItems(view.poll, view, pins);
    show(R.pinbar, items.length > 0);
    for (let i = 0; i < R.pinChips.length; i++) {
      const c = R.pinChips[i];
      const it = items[i];
      show(c, !!it);
      if (it) {
        setText(c.label, it.label);
        setText(c.value, it.text);
      }
    }
    void I;
    void now;
  }

  function balanceInfo(poll: any): any {
    if (!showBalance || !poll || !poll.balance) return null;
    return poll.balance;
  }

  function renderInline(I: any, V: any, now: number) {
    setDial(R.iSpeed, Object.assign({}, I.speed, { sub: I.speed.subShort || I.speed.sub }));
    setDial(R.iHydrogen, {
      text: I.hydrogen.text.replace("\u00a0%", ""),
      unit: I.hydrogen.known ? "%" : "",
      fraction: I.hydrogen.fraction,
      level: I.hydrogen.level,
      known: I.hydrogen.known,
      sub: I.off ? "\u00e9teint" : "",
    });
    const hp = V.health;
    setDial(R.iHealth, {
      text: hp.zero ? "0" : hp.text.replace("\u00a0%", ""),
      unit: hp.known && !hp.zero ? "%" : "",
      fraction: hp.fraction,
      level: hp.level,
      known: hp.known,
      sub: hp.zero ? "à terre ou mort" : "",
    });
    const bal = balanceInfo(view.poll);
    setText(
      R.iBalanceValue,
      bal ? L.fmtAuec(bal.uec) + "\u00a0aUEC" : showBalance ? "—" : "••••••",
    );
    setText(R.btnBalance, bal ? "Masquer le solde" : "Afficher le solde");
    void now;
  }

  function setRow(r: any, text: string, level?: string) {
    setText(r.value, text);
    if (level) setAttr(r.root, "data-level", level);
  }

  function renderFull(I: any, V: any, now: number) {
    const p = view.poll;
    const ship = p && p.ship;
    const ins = ship && ship.instruments;
    const mode = L.modeInfo(p);
    show(R.offNote, I.off);

    // The sheet of the ship
    const sheet = L.specsInfo(ship && p ? p.specs : null, L.specsAgeMs(p, view.receivedAt, now));
    for (let i = 0; i < R.specsRows.length; i++) {
      const r = sheet.rows[i];
      show(R.specsRows[i].root, !!r);
      if (r) {
        setText(R.specsRows[i].label, r[0]);
        setText(R.specsRows[i].value, r[1]);
      }
    }
    show(R.specsFacts, sheet.rows.length > 0);
    setText(R.specsLine, ship ? sheet.line : "");
    show(R.specsLine, !!(ship && sheet.line));
    setText(
      R.specsNote,
      !ship
        ? "Pas de vaisseau : pas de fiche."
        : sheet.status === "none"
          ? "Pas de fiche du vaisseau pour l\u2019instant. " + sheet.note
          : sheet.status === "ready" || sheet.status === "ambiguous"
            ? sheet.note
            : L.specsScaleReason(p.specs) + ". " + sheet.note,
    );

    // Instruments
    setDial(R.xSpeed, I.speed);
    setDial(R.xG, I.g);
    setText(R.altValue, I.altitude.text);
    setText(R.altRadar, I.altitude.radar);
    setText(R.altSub, I.altitude.sub);
    setText(R.vsValue, I.vspeed.known ? I.vspeed.text + "\u00a0m/s" : "—");
    setText(R.vsSub, I.vspeed.sub);
    setVar(R.vsNeg, "--p", pct(I.vspeed.signed < 0 ? -I.vspeed.signed : 0));
    setVar(R.vsPos, "--p", pct(I.vspeed.signed > 0 ? I.vspeed.signed : 0));
    setAttr(R.compass, "data-valid", I.heading.valid ? "1" : "0");
    setText(R.compassValue, I.heading.text);
    setText(R.compassCard, I.heading.cardinal);
    setText(R.compassSub, I.heading.sub);
    setAttr(R.needle, "transform", "rotate(" + Math.round(I.heading.deg) + " 50 50)");
    setText(R.density, I.density ? "Densité atmosphérique " + I.density + " (non vérifié)" : "");
    setText(
      R.insNote,
      ins
        ? "Altitude, cap et altitude radar n’existent que dans le champ d’une planète ; le cap est figé pendant un saut."
        : mode.id === "foot"
          ? "À pied : seules les données du personnage sont disponibles. Les instruments apparaissent quand vous êtes assis dans un vaisseau."
          : "Pas de données de vaisseau pour l’instant (véhicule terrestre, ou pas encore envoyées : 6 à 9 s après être assis dans un vaisseau).",
    );

    // Energy
    const eh = L.trendEstimate(view.series.hydrogen, now, 90000);
    setMeter(R.xHydrogen, {
      text: I.hydrogen.text,
      fraction: I.hydrogen.fraction,
      level: I.hydrogen.level,
      sub: I.off
        ? "éteint"
        : I.hydrogen.known && eh.kind !== "none"
          ? "autonomie " + L.estimateText(eh) + " (estimée)"
          : "",
    });
    setMeter(R.xBoost, {
      text: I.boost.reserve.text,
      fraction: I.boost.reserve.fraction,
      level: I.boost.level,
      sub: I.boost.critical ? "réserve critique" : I.boost.engaged ? "boost engagé" : "",
    });
    setText(R.boostOutValue, I.boost.output.text);
    setGauge(R.boostGauge, I.boost.output.fraction, I.boost.engaged ? "info" : "none");
    setText(
      R.etaNote,
      "Autonomie : estimation par une droite sur les dernières minutes, ce n’est pas une mesure et un changement de rythme la rend fausse.",
    );

    // Power diagram and flight modes
    const power = L.powerInfo(ship && ship.power);
    const plant = power[0];
    setAttr(R.pwr, "data-plant", !plant.known ? "na" : plant.on ? "on" : "off");
    setText(R.pwrPlant.label, "Centrale");
    setText(R.pwrPlant.state, !plant.known ? "?" : plant.on ? "en marche" : "hors service");
    setAttr(R.pwrPlant, "data-on", !plant.known ? "na" : plant.on ? "1" : "0");
    for (let i = 0; i < R.pwrNodes.length; i++) {
      const c = power[i + 1];
      const n = R.pwrNodes[i];
      setText(n.label, c.label);
      setText(n.state, !c.known ? "?" : c.on ? "alimenté" : "coupé");
      setAttr(n, "data-on", !c.known ? "na" : c.on ? "1" : "0");
      setAttr(n, "title", c.title + " : " + (!c.known ? "inconnu" : c.on ? "alimenté" : "coupé"));
    }
    const modes = L.flightModesInfo(ship && ship.flight_modes);
    for (let i = 0; i < R.modeChips.length; i++) {
      const m = modes[i];
      setText(R.modeChips[i], m.label);
      setAttr(R.modeChips[i], "data-on", !m.known ? "na" : m.active ? "1" : "0");
    }

    // Lights
    const lights = L.lightsInfo(ship && ship.warning_lights);
    for (let i = 0; i < R.lightEls.length; i++) {
      const l = lights[i];
      const slot = R.lightEls[i];
      setText(slot.name, l.label);
      setText(slot.state, ship ? l.text : "—");
      setAttr(slot, "data-tone", ship ? l.tone : "off");
      setAttr(slot, "data-verified", l.verified ? "1" : "0");
      setAttr(slot, "title", l.title + " : " + (ship ? l.text : "pas de données"));
    }

    // Weapons
    const W = L.weaponsInfo(p && p.weapons, I.off);
    setText(R.weaponSummary, W.summary);
    for (let i = 0; i < R.weaponRows.length; i++) {
      const row = R.weaponRows[i];
      const w = W.rows[i];
      show(row, !!w);
      if (w) {
        setText(row.name, w.name);
        setText(row.state, w.text);
        setAttr(row, "data-state", w.state);
      }
    }
    show(R.gimbals, !!W.gimbals);
    setText(R.gimbals, W.gimbals ? W.gimbals + " (non vérifié)" : "");
    const cms = L.cmInfo(p && p.weapons, view.peaks);
    for (let i = 0; i < R.cmRows.length; i++) {
      const c = cms[i];
      setText(R.cmRows[i].label, c.label);
      setMeter(R.cmRows[i], {
        text: c.known ? c.text + (c.peak > 0 ? " / " + L.fmtNum(c.peak) : "") : "non fourni",
        fraction: c.known ? c.fraction : null,
        level: c.known ? c.level : "none",
        sub: "",
      });
    }

    // Pilot
    setDial(R.xHealth, {
      text: V.health.zero ? "0" : V.health.text.replace("\u00a0%", ""),
      unit: V.health.known && !V.health.zero ? "%" : "",
      fraction: V.health.fraction,
      level: V.health.level,
      known: V.health.known,
      sub: V.health.zero
        ? "à terre ou mort : le flux ne distingue pas"
        : V.health.known
          ? ""
          : "non fourni",
    });
    const eHunger = L.trendEstimate(view.series.hunger, now);
    const eThirst = L.trendEstimate(view.series.thirst, now);
    setDial(R.xHunger, {
      text: V.hunger.text.replace("\u00a0%", ""),
      unit: V.hunger.known ? "%" : "",
      fraction: V.hunger.fraction,
      level: V.hunger.level,
      known: V.hunger.known,
      sub:
        V.hunger.known && eHunger.kind !== "none"
          ? "≈ " + L.estimateText(eHunger).replace("≈\u00a0", "")
          : "",
    });
    setDial(R.xThirst, {
      text: V.thirst.text.replace("\u00a0%", ""),
      unit: V.thirst.known ? "%" : "",
      fraction: V.thirst.fraction,
      level: V.thirst.level,
      known: V.thirst.known,
      sub:
        V.thirst.known && eThirst.kind !== "none"
          ? "≈ " + L.estimateText(eThirst).replace("≈\u00a0", "")
          : "",
    });
    setRow(R.fHeart, V.heart === "—" ? "—" : V.heart + "\u00a0bpm");
    setRow(R.fGravity, V.gravity === "—" ? "—" : V.gravity + "\u00a0g");
    setRow(R.fPressure, V.pressure);
    setRow(R.fTemp, V.temperature === "—" ? "—" : V.temperature + "\u00a0°C");
    setRow(R.fAir, V.air === "non respirable" ? "non respirable (non vérifié)" : V.air);
    setRow(R.fLoco, V.locomotion);
    setRow(R.fCrew, V.crew);
    setText(R.seat, V.seat ? "Poste : " + V.seat : "");
    setText(
      R.vitalsNote,
      "Faim et soif : estimation par une droite sur les dernières minutes. L’unité de la pression n’est pas donnée par le jeu.",
    );

    // Curves
    const win60 = cfg.historyMs;
    for (let i = 0; i < CURVES.length; i++) {
      const def = CURVES[i];
      const s = R.curveEls[i];
      const series = view.series[def[0]];
      const sp = L.sparkPoints(series, now, win60, 120, 32);
      if (s.line._pts !== sp.points) {
        s.line._pts = sp.points;
        s.line.setAttribute("points", sp.points);
      }
      const last = series && series.length ? series[series.length - 1][1] : null;
      const shipOff = I.off && ["speed", "altitude", "g", "hydrogen"].indexOf(def[0]) >= 0;
      setText(s.value, last === null || !streamLive || shipOff ? "—" : def[2](last));
      setText(
        s.range,
        sp.min === null
          ? "pas assez de relevés"
          : "min " + def[2](sp.min) + " · max " + def[2](sp.max),
      );
    }

    renderSession(now);
    renderChronology();
    renderMissing();
  }

  function renderSession(now: number) {
    const p = view.poll;
    const s = p && p.session;
    const started = !!(s && s.started_at);
    show(R.sesEmpty, !started);
    show(R.sesRows, started);
    show(R.btnEnd, started && !s.ended_at);
    show(R.btnReset, started);
    setText(R.btnStart, started ? "Remise à zéro des compteurs" : "Début des compteurs");
    if (started) {
      setRow(
        R.sesState,
        s.ended_at ? "terminée" : "depuis " + L.formatDuration(now - Date.parse(s.started_at)),
      );
      setRow(R.sesTakeoffs, String(s.takeoffs));
      setRow(R.sesLandings, String(s.landings));
      setRow(R.sesJumps, String(s.jumps));
      setRow(R.sesFlight, "≈\u00a0" + L.formatDuration(s.flight_ms));
    }
    const bal = balanceInfo(p);
    setRow(R.sesBalance, bal ? L.fmtAuec(bal.uec) + "\u00a0aUEC" : showBalance ? "—" : "masqué");
    setText(R.btnBalance2, bal ? "Masquer" : "Afficher le solde");
    show(R.sesDelta.root, !!bal);
    show(R.sesRate.root, !!bal);
    if (bal) {
      const label = L.baselineLabel(p);
      setRow(
        R.sesDelta,
        typeof bal.delta === "number" ? L.fmtAuec(bal.delta, true) + "\u00a0aUEC " + label : "—",
      );
      const rate = L.sessionRate(bal.delta, bal.since, now);
      setRow(
        R.sesRate,
        rate
          ? L.fmtAuec(Math.round(rate.perHour), true) + "\u00a0aUEC/h"
          : "disponible après 2 min",
      );
    }
    setText(
      R.sesNote,
      bal
        ? "Le solde mêle achats, récompenses et amendes : la variation n’est pas un bénéfice net."
        : "",
    );
  }

  function renderChronology() {
    const events = L.visibleEvents(view, showBalance);
    const markers = view.poll && view.poll.session ? view.poll.session.markers : [];
    const items = L.chronology(events, markers, R.filter, R.eventRows.length);
    for (const b of R.filterBtns)
      setAttr(b, "aria-pressed", b._filter === R.filter ? "true" : "false");
    for (let i = 0; i < R.eventRows.length; i++) {
      const li = R.eventRows[i];
      const e = items[i];
      show(li, !!e);
      if (e) {
        setText(li.time, L.formatClock(e.at));
        setText(li.text, e.label);
        setText(li.badge, e.kind === "marker" ? "marqueur" : e.verified ? "" : "non vérifié");
        setAttr(li, "data-kind", e.kind);
        setAttr(li, "data-alert", e.alert ? "1" : "0");
        setAttr(li, "data-verified", e.verified ? "1" : "0");
      }
    }
    setText(
      R.eventsNone,
      items.length === 0
        ? R.filter === "markers"
          ? "Aucun marqueur : pose un début de session pour suivre ta session."
          : "Aucun événement depuis le démarrage du lecteur."
        : "",
    );
  }

  function renderMissing() {
    const items = L.unverifiedItems(view.poll);
    show(R.unverified, items.length > 0);
    for (let i = 0; i < R.unverifiedItems.length; i++) {
      const li = R.unverifiedItems[i];
      const it = items[i];
      show(li, !!it);
      if (it) {
        setText(li.label, it.label);
        setText(li.text, it.text);
      }
    }
    const names = L.missingItems(view.notInStream);
    for (let i = 0; i < R.missingEls.length; i++) {
      const li = R.missingEls[i];
      const name = names[i];
      show(li, !!name);
      if (name) setText(li, name);
    }
  }

  function renderModeUi() {
    setAttr(root, "data-mode", displayMode);
    setText(R.btnMode, displayMode === "fullscreen" ? "Réduire" : "Plein écran");
    show(R.btnMode, availableModes.indexOf("fullscreen") >= 0);
    show(R.btnAnalyse, displayMode !== "fullscreen");
  }

  function render() {
    const now = clock();
    // A route plan built from the balance (its quantity and profit give the budget away) does not outlive the balance
    // being shown: hidden again, it is dropped here, whichever way the balance was hidden.
    if (view.plan && view.plan.private === true && !showBalance) {
      view = Object.assign({}, view, { plan: null });
    }
    // The ship banner already says "mode quantique" and "saut quantique": no second chip for them.
    const conds = L.conditionItems(view.poll, now, view.receivedAt, 12)
      .filter((c: any) => c.id !== "in_quantum" && c.id !== "in_jump")
      .slice(0, R.condList.length);
    R.health.render(view.poll, { showBalance, now, link: view.link });
    const info = renderStatus(now, conds);
    streamLive = !info.grey;
    renderContext(now);
    renderAlerts(now, conds, !info.grey);
    R.sessions.render(view.poll && view.poll.sessions, { showBalance, now });
    R.ledger.render(view.poll && view.poll.ledger, {
      showBalance,
      fullscreen: displayMode === "fullscreen",
      now,
    });
    // The commerce card: the plan from the model, the commerce section of the ledger, and the balance change only
    // as a labelled fallback while no trade journal feeds the dashboard.
    const tradeLedger = L.ledgerNormalize(view.poll && view.poll.ledger);
    // The action bar asks the server for routes; it needs a server that answers, not a live stream.
    const actionsOn =
      initialised && !tornDown && !retired && !!view.poll && view.poll.state !== "off";
    // Where the money went: read from the raw payload (ledgerNormalize does not keep it), drawn only with the balance.
    const moved = showBalance
      ? L.movementsFromLedger(L, view.poll && view.poll.ledger)
      : { section: null, decomposition: null };
    // How the player's own runs compare with their plans: derived from the balance, so read only while it is shown.
    const calibration = showBalance
      ? L.calibrationFromLedger(L, view.poll && view.poll.ledger)
      : null;
    R.trade.render({
      calibration,
      trade: tradeLedger?.trade ?? null,
      ledgerStatus: tradeLedger ? tradeLedger.status : null,
      plan: view.plan,
      showBalance,
      fullscreen: displayMode === "fullscreen",
      balance: showBalance && view.poll ? view.poll.balance : null,
      baseline: L.baselineLabel(view.poll),
      actionsEnabled: actionsOn,
      decomposition: moved.decomposition,
    });
    R.movements.render({
      section: moved.section,
      decomposition: moved.decomposition,
      showBalance,
      fullscreen: displayMode === "fullscreen",
    });
    R.tradeActions.render(
      tradeActionsContext(actionsOn, tradeLedger ? tradeLedger.trade : null, now, calibration),
    );
    const I = L.instrumentInfo(view.poll, view);
    const sheetIns = view.poll && view.poll.ship && view.poll.ship.instruments;
    I.speed = L.speedWithSheet(
      I.speed,
      view.poll && view.poll.specs,
      sheetIns ? sheetIns.speed_ms : null,
      I.quantum,
    );
    const V = L.vitalsInfo(view.poll);
    setAttr(root, "data-ship", I.off ? "off" : "on");
    renderPins(I, now);
    for (const b of R.pinButtons) {
      setAttr(b, "aria-pressed", pins[b._key] ? "true" : "false");
      setAttr(b.parentNode, "data-pinned", pins[b._key] ? "1" : "0");
    }
    if (displayMode === "fullscreen") renderFull(I, V, now);
    else renderInline(I, V, now);
    reportSize();
  }

  /** What the commerce action bar may use: the balance only while it is shown, and only as a number for its own screen. */
  function tradeActionsContext(on: boolean, trade: any, now: number, calibration: any): any {
    const specs = view.poll && view.poll.specs;
    const bal = balanceInfo(view.poll);
    return {
      enabled: on,
      fullscreen: displayMode === "fullscreen",
      follower: isFollower(),
      now,
      clock,
      balance: bal ? bal.uec : null,
      sheetCargo:
        specs && specs.status === "ready" && typeof specs.cargo_scu === "number"
          ? specs.cargo_scu
          : null,
      trade,
      calibration,
      plan: view.plan,
      call: async (name: string, args: any, timeoutMs: number) =>
        request("tools/call", { name, arguments: args }, timeoutMs),
      say: (text: string) =>
        request("ui/message", { role: "user", content: [{ type: "text", text }] }),
      setPlan: (plan: any) => {
        view = Object.assign({}, view, { plan });
        render();
      },
      feedback,
      takeLead,
      // Without a full-screen mode the bar has no room: the compact view offers no way in.
      openFull: availableModes.indexOf("fullscreen") >= 0 ? () => requestMode("fullscreen") : null,
      later: (fn: () => void, ms: number) => win.setTimeout(fn, ms),
      cancel: (id: any) => win.clearTimeout(id),
      changed: render,
    };
  }

  function reportSize() {
    // The host has not agreed on anything before ui/initialize is answered.
    if (!initialised) return;
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
      follower: isFollower(),
      noChannel: channel === null,
      now: clock(),
      state: p ? p.state : view.link === "init" ? "live" : "off",
      failures: view.failures,
    });
  }

  function pollOnce(): Promise<void> {
    if (inFlight) return inFlight;
    const args: any = L.pollArguments(view, showBalance);
    lastPollAt = clock();
    const run = (async () => {
      try {
        const r = await request("tools/call", { name: "sc_live_poll", arguments: args });
        const sc = r && r.structuredContent;
        if (!r || r.isError || !sc || typeof sc !== "object") throw new Error("réponse vide");
        view = L.reducePoll(view, sc, clock());
        share();
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
    if (toastTimer !== null) win.clearTimeout(toastTimer);
    toastTimer = null;
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
      if (tornDown || hidden || offscreen) return;
      // The heartbeat lets the others know this View is alive (and notice when the leader is not).
      if (
        channel !== null &&
        ++heartbeats % Math.max(1, Math.round(cfg.heartbeatMs / 1000)) === 0
      ) {
        announce("hello");
      }
      reelect();
      render();
    }, 1000);
  }

  /** Poll now (if allowed) and keep going. */
  function resumeIfAllowed() {
    if (!initialised || tornDown || retired) return;
    const d = decision();
    if (!d.run) {
      // A follower stays on screen and keeps its clock (ages, durations) going; it only does not call the server.
      if (d.reason === "follower") startTicker();
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
      announce("hello"); // visible: false, so the others do not wait for this View
    } else if (!away && awaySince !== null) {
      const gone = clock() - awaySince;
      awaySince = null;
      if (gone >= (channel === null ? cfg.noChannelRetireMs : cfg.retireAfterMs)) {
        retired = true;
        render();
        return;
      }
      announce("hello");
      reelect();
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
  // Coordination between the Views of this connector: BroadcastChannel, no network. Everything that arrives
  // on it is data from another page: parseChannelMessage checks it, and it never reaches the JSON-RPC handler.
  // ---------------------------------------------------------------------------------------------
  function isFollower(): boolean {
    return channel !== null && leaderId !== null && leaderId !== viewId;
  }

  function channelSend(message: any) {
    if (channel === null) return;
    try {
      channel.postMessage(message);
    } catch {
      /* a closed or broken channel: this View simply works alone */
    }
  }

  function announce(kind: string) {
    channelSend({ t: kind, id: viewId, rank, visible: !hidden && !offscreen && !tornDown });
  }

  /** The leader shares what it knows, at most about once a second, and only when somebody can listen. */
  function share() {
    if (channel === null || isFollower() || !view.poll) return;
    if (Object.keys(peers).length === 0 || clock() - lastShareAt < cfg.snapshotMinMs) return;
    lastShareAt = clock();
    // The ledger goes without anything derived from the balance (gain, total, pace, planned against measured).
    const shared = Object.assign({}, L.sharablePoll(view.poll), {
      ledger: L.ledgerStripBalance(view.poll.ledger),
      sessions: L.sessionBarStripBalance(view.poll.sessions),
    });
    channelSend({ t: "snapshot", id: viewId, rank, poll: shared });
  }

  function reelect() {
    if (channel === null) return;
    const was = isFollower();
    const res = L.electLeader({ id: viewId, rank, visible: !hidden && !offscreen }, peers, clock());
    leaderId = res.leaderId;
    const now = isFollower();
    if (now === was) return;
    if (now) {
      // Replaced: stop calling the server, forget the balance (it is not shared), show the banner.
      if (timer !== null) win.clearTimeout(timer);
      timer = null;
      showBalance = false;
      view = Object.assign({}, view, {
        poll: view.poll
          ? Object.assign({}, view.poll, {
              balance: undefined,
              ledger: L.ledgerStripBalance(view.poll.ledger),
              sessions: L.sessionBarStripBalance(view.poll.sessions),
            })
          : view.poll,
      });
      if (!hidden && !offscreen) startTicker();
      render();
    } else {
      render();
      resumeIfAllowed();
    }
  }

  function takeLead() {
    if (channel === null) return;
    rank = L.claimRank(peers, clock());
    announce("claim");
    reelect();
  }

  function onChannelMessage(event: any) {
    if (tornDown) return;
    const m = L.parseChannelMessage(event && event.data, clock());
    if (!m || m.id === viewId) return;
    const known = peers[m.id] !== undefined;
    peers = L.notePeer(peers, m, clock());
    reelect();
    // A View that has just appeared does not know the others yet: say hello back once.
    if (m.t === "hello" && !known && !hidden && !offscreen) announce("hello");
    if (m.t === "snapshot" && isFollower() && m.id === leaderId) {
      const sheet = L.specsClean(event.data && event.data.poll ? event.data.poll.specs : null);
      // Rebuilt and stripped of anything derived from the balance, whatever the sender claims.
      const ledger = L.ledgerChannelClean(
        event.data && event.data.poll ? event.data.poll.ledger : null,
      );
      // The session bar is rebuilt the same way, without any aUEC figure.
      const sessions = L.sessionChannelClean(
        event.data && event.data.poll ? event.data.poll.sessions : null,
      );
      // The health codes are rebuilt too (cleanPoll leaves them out, like the sections above).
      const health = L.healthNormalize(
        event.data && event.data.poll ? event.data.poll.health : null,
      );
      const shared = Object.assign(
        {},
        m.poll,
        health ? { health } : {},
        sheet ? { specs: sheet } : {},
        ledger ? { ledger } : {},
        sessions ? { sessions } : {},
      );
      view = L.reducePoll(view, shared, clock());
      render();
    }
  }

  function closeChannel() {
    if (channel === null) return;
    announce("bye");
    try {
      channel.close();
    } catch {
      /* already closed */
    }
    channel = null;
  }

  function openChannel() {
    try {
      if (typeof win.BroadcastChannel !== "function") return;
      channel = new win.BroadcastChannel(cfg.channelName);
      channel.addEventListener("message", onChannelMessage);
    } catch {
      channel = null; // not available here (opaque origin, old browser): the old behaviour applies
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Actions: toward the conversation or the display, never toward the game
  // ---------------------------------------------------------------------------------------------
  /** The confirmation of an action, next to the buttons that caused it; it clears itself after a few seconds. */
  function feedback(text: string) {
    setText(R.toast, text);
    setText(R.toastTop, text);
    if (toastTimer !== null) win.clearTimeout(toastTimer);
    toastTimer = win.setTimeout(() => {
      toastTimer = null;
      setText(R.toast, "");
      setText(R.toastTop, "");
    }, 6000);
  }

  /**
   * What this View remembers about the player, best effort and never needed: one flag, "the help was read". Reaching the
   * storage may throw (an opaque origin, blocked site data): then nothing is remembered and the page works the same.
   */
  function storageGet(key: string): string | null | undefined {
    try {
      return win.localStorage.getItem(key);
    } catch {
      return undefined; // unavailable (not "empty"): the caller must not count on remembering anything
    }
  }
  function storageSet(key: string, value: string) {
    try {
      win.localStorage.setItem(key, value);
    } catch {
      /* not available here */
    }
  }

  /** Copies a command. The clipboard may be refused in the host's sandbox: then the text is selected and the player copies it. */
  function copyText(text: string, node: any): Promise<boolean> {
    const select = () => {
      try {
        const sel = win.getSelection();
        const range = doc.createRange();
        range.selectNodeContents(node);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch {
        /* the text stays selectable by hand (user-select: all) */
      }
    };
    try {
      const clip = win.navigator && win.navigator.clipboard;
      if (clip && typeof clip.writeText === "function") {
        return Promise.resolve(clip.writeText(text)).then(
          () => true,
          () => {
            select();
            return false;
          },
        );
      }
    } catch {
      /* falls through to the selection */
    }
    select();
    return Promise.resolve(false);
  }

  /** Can this page make a file at all? (The host may still refuse the download: it is never required.) */
  function canDownload(): boolean {
    try {
      const u = win.URL;
      return (
        typeof win.Blob === "function" &&
        !!u &&
        typeof u.createObjectURL === "function" &&
        typeof doc.createElement === "function"
      );
    } catch {
      return false;
    }
  }

  /** Offers a text as a file through a temporary link. True when the click was made; the host decides what follows. */
  function downloadText(name: string, mime: string, text: string): boolean {
    try {
      if (!canDownload()) return false;
      // A byte-order mark lets a spreadsheet read the accents of a CSV as UTF-8.
      const bom = mime === "text/csv" ? "\uFEFF" : "";
      const blob = new win.Blob([bom + text], { type: mime + ";charset=utf-8" });
      const url = win.URL.createObjectURL(blob);
      const a = doc.createElement("a");
      a.setAttribute("href", url);
      a.setAttribute("download", name);
      a.click();
      win.setTimeout(() => {
        try {
          win.URL.revokeObjectURL(url);
        } catch {
          /* nothing to release */
        }
      }, 10000);
      return true;
    } catch {
      return false;
    }
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

  /** A call of a session tool (player action in the bar or its menu): the structured answer, or an error. */
  async function callSessionTool(name: string, args: any): Promise<any> {
    const r = await request("tools/call", { name, arguments: args });
    if (!r || r.isError) {
      const text =
        r && r.content && r.content[0] && typeof r.content[0].text === "string"
          ? r.content[0].text
          : "";
      throw new Error(text ? text.slice(0, 120) : "réponse vide");
    }
    return r.structuredContent && typeof r.structuredContent === "object"
      ? r.structuredContent
      : null;
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
    // A View that follows another one never gets the balance (it is not shared): taking over comes first.
    if (isFollower()) takeLead();
    showBalance = !showBalance;
    if (!showBalance && view.poll) {
      // Hidden again: forget it here too. The next answers will not carry it.
      view = Object.assign({}, view, {
        poll: Object.assign({}, view.poll, {
          balance: undefined,
          ledger: L.ledgerStripBalance(view.poll.ledger),
          sessions: L.sessionBarStripBalance(view.poll.sessions),
        }),
        // The hash held for the ledger stood for the version with amounts: forget it, the next answer brings the plain one.
        hash: Object.assign({}, view.hash, { ledger: undefined }),
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
  const onWindowMessage = (e: any) => {
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
        send({ id: m.id, result: {} });
        dispose();
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
  };
  const onVisibility = () => {
    hidden = !!doc.hidden;
    updateAway();
  };
  const onPageHide = () => dispose();
  win.addEventListener("message", onWindowMessage);
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("pagehide", onPageHide);
  const observers: any[] = [];
  if (typeof win.IntersectionObserver === "function") {
    const io = new win.IntersectionObserver((entries: any[]) => {
      const last = entries[entries.length - 1];
      offscreen = !!last && !last.isIntersecting;
      updateAway();
    });
    io.observe(doc.body);
    observers.push(io);
  }
  if (typeof win.ResizeObserver === "function") {
    const ro = new win.ResizeObserver(() => reportSize());
    ro.observe(doc.body);
    observers.push(ro);
  }

  /** The View is going away (the host tears it down, or the page is hidden for good): nothing stays registered. */
  function dispose() {
    tornDown = true;
    stopTimers();
    // The action bar's own timers (a re-search after an option changed, a wait) must not fire in a dead View.
    if (R.tradeActions) R.tradeActions.dispose();
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
    closeChannel();
    for (const o of observers) {
      try {
        o.disconnect();
      } catch {
        /* already gone */
      }
    }
    observers.length = 0;
    win.removeEventListener("message", onWindowMessage);
    doc.removeEventListener("visibilitychange", onVisibility);
    win.removeEventListener("pagehide", onPageHide);
  }

  // ---------------------------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------------------------
  build();
  openChannel();
  announce("hello");
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
      render();
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
    debug: () => ({
      view,
      showBalance,
      displayMode,
      hidden,
      offscreen,
      tornDown,
      retired,
      gate,
      viewId,
      leaderId,
      follower: isFollower(),
    }),
  };
}
