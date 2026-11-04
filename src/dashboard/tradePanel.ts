/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The commerce card of the live dashboard View ("Commerce"): what a trading run really earned, in plain words.
 * Pure display logic and the DOM of one full-screen card plus one compact line. Shipped inside the page by page.ts
 * with the same rules as ledgerPanel.ts (the functions are serialised with Function.prototype.toString):
 *   - only function declarations, no imports, no module-level values (a function may call another of this file);
 *   - the formatters of viewLogic.ts (fmtAuec, fmtNum, formatDuration) arrive through the `L` argument;
 *   - text reaches the DOM only through textContent (the SVG is built with createElementNS, no markup string).
 *
 * The figures come from the server's model (tradeRun.ts, normalised by ledgerTradeNormalize). Nothing is invented
 * here: an unknown figure is a dash with its reason, an estimate carries the word "estimé" and a hatched mark, a
 * measurement carries "mesuré". Amounts exist only while the player has chosen to show the balance.
 *
 * Information order (value first): the headline numbers and the next trip, then the waterfall, then the details.
 * The card holds a slot for an action bar (tradeActions.ts) right under the headline numbers: the player's own figures come first, then the search for the next route.
 */

export function tradeConfig() {
  return { waterfallRows: 5, maxRuns: 4, assumptionSlots: 6, minBarPct: 1.2 };
}

/** "13,7 %" from 0.137. */
export function tradePct(L: any, ratio: number | null | undefined, decimals?: number): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "—";
  return L.fmtNum(ratio * 100, decimals === undefined ? 1 : decimals) + "\u00a0%";
}

/** An amount of aUEC with its unit; a dash when unknown. */
export function tradeAmount(L: any, value: number | null | undefined, signed?: boolean): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return L.fmtAuec(value, !!signed) + "\u00a0aUEC";
}

export function tradeStageLabel(stage: string): string {
  const names: any = {
    open: "Achat fait, rien vendu",
    partial: "Vente en cours",
    complete: "Trajet terminé",
    sold_only: "Ventes seules",
  };
  return names[stage] || "Trajet";
}

/** How a figure was obtained, in one word. */
export function tradeMethodLabel(method: string): string {
  const names: any = {
    mesure: "mesuré",
    exact: "mesuré",
    groupe: "mesuré (groupé)",
    calcule: "calculé",
    estime: "estimé",
  };
  return names[method] || "";
}

/** Is it an estimate (hatched, tagged "estimé") rather than a measure? */
export function tradeIsEstimate(method: string): boolean {
  return method === "estime" || method === "calcule";
}

/** Why a net profit is missing, in words. */
export function tradeNetReason(reason: string): string {
  const names: any = {
    en_cours: "Le trajet n’est pas terminé : tout n’est pas encore vendu.",
    en_attente: "En attente : le solde final est lu quelques secondes après la dernière vente.",
    solde_avant_inconnu:
      "Inconnu : le tableau de bord n’a pas vu ton solde juste avant le premier achat (il était fermé ou le flux coupé).",
    solde_apres_inconnu: "Inconnu : le solde après la dernière vente n’a pas été suivi.",
    cout_inconnu: "Inconnu : le coût d’achat n’est pas dans le journal.",
    pas_de_solde: "Inconnu : le solde est masqué.",
  };
  return names[reason] || "Inconnu.";
}

/**
 * Names the origin of the net figure. It is the VARIATION OF THE BALANCE over the run (first purchase to the last
 * transaction + 8 s): everything that moved the balance in that time is in it, not only the run.
 */
export function tradeNetSource(net: any): string {
  if (!net || net.auec === null) return "";
  if (net.method === "mesure")
    return "variation du solde, du premier achat à la dernière vente : tout ce qui a bougé le solde y est compté";
  if (net.method === "calcule")
    return "marge brute − frais mesurés (le solde avant l’achat n’a pas été vu)";
  return "estimé";
}

/** The tag of the net figure: a balance variation is not "mesuré" in the sense of a log amount. */
export function tradeNetTag(net: any): string {
  if (!net || net.auec === null) return "";
  return net.method === "mesure"
    ? "variation du solde"
    : net.method === "calcule"
      ? "calculé"
      : "estimé";
}

/**
 * The journal names goods by an id only (the first 8 characters of the game's GUID): shown as "marchandise 5c2e9a41"
 * until a name lookup exists. A plan's own name is always preferred.
 */
export function tradeGoodsLabel(id: string | null | undefined): string {
  if (!id) return "";
  return /^[0-9a-f]{8}$/.test(id) ? "marchandise " + id : id;
}

/** The route of the plan or of the run, as one line. */
export function tradeRouteText(plan: any, run: any): string {
  const parts: string[] = [];
  const goods = (plan && plan.commodity) || tradeGoodsLabel(run && run.commodity);
  if (goods) parts.push(goods);
  const from = (plan && plan.buy_terminal) || (run && run.buy_shops && run.buy_shops[0]) || "";
  const to = (plan && plan.sell_terminal) || (run && run.sell_shops && run.sell_shops[0]) || "";
  if (from && to) parts.push(from + " → " + to);
  else if (from || to) parts.push(from || to);
  return parts.join(" · ");
}

/**
 * The waterfall: planned profit -> price gap -> gross margin -> fees -> real net. Each row is a total (a bar from
 * zero) or a delta (a floating bar from where the previous level was). Rows that cannot be computed are left out.
 */
export function tradeWaterfall(m: any): any[] {
  const rows: any[] = [];
  if (!m) return rows;
  const planned = m.planned_profit;
  const gross = m.gross_margin;
  if (typeof planned === "number") {
    rows.push({
      id: "planned",
      label: "Bénéfice prévu",
      hint: "plan, avant frais",
      tag: "plan",
      kind: "total",
      from: 0,
      to: planned,
      value: planned,
      estimate: false,
      tone: "info",
    });
  }
  if (typeof planned === "number" && typeof gross === "number" && typeof m.price_gap === "number") {
    rows.push({
      id: "gap",
      label: "Écart de prix",
      hint: m.gap_includes_quantity ? "prix et quantité mêlés" : "réel − prévu",
      tag: "calculé",
      kind: "delta",
      from: planned,
      to: gross,
      value: gross - planned,
      estimate: false,
      tone: gross - planned >= 0 ? "ok" : "warn",
    });
  }
  if (typeof gross === "number") {
    rows.push({
      id: "gross",
      label: "Marge brute",
      hint: m.cost_paired
        ? "ventes − coût des SCU vendus (premier entré, premier sorti)"
        : "ventes − achats",
      tag: "calculé",
      kind: "total",
      from: 0,
      to: gross,
      value: gross,
      estimate: false,
      tone: gross >= 0 ? "ok" : "bad",
    });
  }
  const fees = m.fees && typeof m.fees.total === "number" ? m.fees.total : null;
  if (typeof gross === "number" && fees !== null) {
    rows.push({
      id: "fees",
      label: "Frais",
      hint: m.fees.method === "mesure" ? "chargés en plus des prix" : "écart marge − solde",
      tag: m.fees.method === "mesure" ? "mesuré" : "estimé",
      kind: "delta",
      from: gross,
      to: gross - fees,
      value: -fees,
      estimate: tradeIsEstimate(m.fees.method),
      tone: "warn",
    });
  }
  if (m.net && typeof m.net.auec === "number") {
    rows.push({
      id: "net",
      label: "Bénéfice net",
      hint: tradeNetSource(m.net),
      tag: tradeNetTag(m.net),
      kind: "total",
      from: 0,
      to: m.net.auec,
      value: m.net.auec,
      estimate: tradeIsEstimate(m.net.method),
      tone: m.net.auec >= 0 ? "ok" : "bad",
    });
  }
  return rows;
}

/** Positions (in percent of the track) of the rows, on one common scale that always contains zero. */
export function tradeWaterfallLayout(rows: any[]): any {
  let lo = 0;
  let hi = 0;
  for (const r of rows) {
    lo = Math.min(lo, r.from, r.to);
    hi = Math.max(hi, r.from, r.to);
  }
  const span = hi - lo || 1;
  const pos = (v: number) => ((v - lo) / span) * 100;
  const min = tradeConfig().minBarPct;
  const placed = rows.map((r: any) => {
    const a = pos(r.from);
    const b = pos(r.to);
    return Object.assign({}, r, {
      left: Math.round(Math.min(a, b) * 100) / 100,
      width: Math.max(min, Math.round(Math.abs(b - a) * 100) / 100),
    });
  });
  return { rows: placed, zero: Math.round(pos(0) * 100) / 100 };
}

/** The price curve: points, the target price of the plan and the average price really obtained, on one scale. */
export function tradeCourse(plan: any, money: any): any {
  const points: number[] = plan && Array.isArray(plan.price_points) ? plan.price_points : [];
  if (points.length < 2) return null;
  const sellSide = !(plan && plan.price_points_for === "buy");
  const target = plan ? (sellSide ? plan.sell_unit_price : plan.buy_unit_price) : undefined;
  const realised = money ? (sellSide ? money.avg_sell_per_scu : money.avg_buy_per_scu) : null;
  let lo = Math.min.apply(null, points);
  let hi = Math.max.apply(null, points);
  const marks: number[] = [];
  if (typeof target === "number") marks.push(target);
  if (typeof realised === "number") marks.push(realised);
  for (const v of marks) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const span = hi - lo || 1;
  const frac = (v: number) => (v - lo) / span;
  let total = 0;
  for (const p of points) total += p;
  const mean = total / points.length;
  return {
    points,
    sellSide,
    lo,
    hi,
    mean,
    last: points[points.length - 1],
    target: typeof target === "number" ? target : null,
    realised: typeof realised === "number" ? realised : null,
    targetAt: typeof target === "number" ? frac(target) : null,
    realisedAt: typeof realised === "number" ? frac(realised) : null,
    meanAt: frac(mean),
    // The target against the average of the points, in percent (positive: above the average).
    targetVsMean: typeof target === "number" && mean > 0 ? target / mean - 1 : null,
    label: plan && plan.price_points_label ? plan.price_points_label : "",
  };
}

/** The polyline of the curve in a w by h box, y up. */
export function tradeCoursePoints(course: any, w: number, h: number): string {
  if (!course) return "";
  const pad = 4;
  const n = course.points.length;
  const span = course.hi - course.lo || 1;
  return course.points
    .map((v: number, i: number) => {
      const x = (i / (n - 1)) * w;
      const y = pad + (1 - (v - course.lo) / span) * (h - 2 * pad);
      return Math.round(x * 10) / 10 + "," + Math.round(y * 10) / 10;
    })
    .join(" ");
}

/** The y of a level (0..1 of the scale) in a box of height h. */
export function tradeLevelY(at: number, h: number): number {
  const pad = 4;
  return Math.round((pad + (1 - at) * (h - 2 * pad)) * 10) / 10;
}

/** The compact line of the small view; "" when there is nothing to say. Amounts only with the balance. */
export function tradeInlineText(L: any, trade: any, showBalance: boolean): string {
  if (!trade || trade.source !== "journal" || trade.runs.length === 0) return "";
  const r = trade.runs[0];
  const goods = tradeGoodsLabel(r.commodity) || "marchandise";
  if (r.stage === "complete" && showBalance && r.money && r.money.net.auec !== null) {
    return (
      "Dernier trajet · " +
      goods +
      " : bénéfice net " +
      tradeAmount(L, r.money.net.auec, true) +
      " (" +
      tradeMethodLabel(r.money.net.method) +
      ")"
    );
  }
  if (r.stage === "complete") return "Dernier trajet · " + goods + " : terminé";
  if (r.stage === "open")
    return (
      "Trajet en cours · " +
      goods +
      (r.scu_bought !== null ? " · " + L.fmtNum(r.scu_bought) + "\u00a0SCU achetés" : "")
    );
  if (r.stage === "partial")
    return (
      "Trajet en cours · " +
      goods +
      (r.scu_sold !== null && r.scu_bought !== null
        ? " · " + L.fmtNum(r.scu_sold) + " / " + L.fmtNum(r.scu_bought) + "\u00a0SCU vendus"
        : "")
    );
  return "";
}

/**
 * Builds the card and the compact line once; `render(ctx)` then only changes text, attributes and custom properties.
 * svgNs is the SVG namespace name, handed in by the View (one place names it).
 * ctx: { trade, plan, showBalance, fullscreen, balance, baseline }
 *   trade    the normalised commerce section of the ledger (or null)
 *   plan     the cleaned plan (or null)
 *   balance  the poll's balance { delta, since } while shown (fallback when no trade journal exists)
 *   baseline where the balance change is counted from, in words
 */
export function tradePanel(doc: any, L: any, svgNs: string): any {
  const cfg = tradeConfig();
  const SVG = svgNs;
  const el = (tag: string, cls?: string, text?: string): any => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const svg = (tag: string, attrs: any): any => {
    const n = doc.createElementNS(SVG, tag);
    for (const k of Object.keys(attrs)) n.setAttribute(k, String(attrs[k]));
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

  // ---- the compact line of the small view
  const line = el("p", "lg-line tr-line", "");
  line.setAttribute("data-hidden", "1");

  // ---- the card
  const root = el("section", "card trade");
  root.setAttribute("data-hidden", "1");
  root.setAttribute("aria-label", "Commerce : bilan du trajet");
  const head = el("div", "tr-head");
  const titles = el("div", "tr-titles");
  const title = el("h2", "card-title", "Commerce");
  const route = el("p", "tr-route", "");
  const meta = el("p", "tr-meta", "");
  add(titles, title, route, meta);
  const stage = el("span", "tr-stage", "");
  add(head, titles, stage);

  // The slot of the action bar (tradeActions.ts): a separate component, hidden until it has something to show.
  const slot = el("div", "tr-actions-slot");
  slot.setAttribute("data-slot", "trade-actions");
  slot.setAttribute("data-hidden", "1");

  const message = el("p", "tr-message", "");
  // Warnings that change how a figure must be read (shown with the word "Attention", never by colour alone).
  const warn = el("p", "tr-warn", "");

  // ---- the headline numbers (value first)
  const hero = el("div", "tr-hero");
  const tiles: any = {};
  const tile = (key: string, label: string, big: boolean): any => {
    const t: any = { root: el("div", "tr-tile" + (big ? " tr-tile-big" : "")) };
    t.label = el("span", "tr-tile-label", label);
    t.value = el("span", "tr-tile-value", "—");
    t.tag = el("span", "tr-tag", "");
    t.sub = el("span", "tr-tile-sub", "");
    const row = el("div", "tr-tile-row");
    add(row, t.label, t.tag);
    add(t.root, row, t.value, t.sub);
    tiles[key] = t;
    return t;
  };
  add(
    hero,
    tile("net", "Bénéfice net", true).root,
    tile("turnover", "Chiffre d’affaires", false).root,
    tile("fees", "Frais", false).root,
    tile("next", "Si tu refais ce trajet", false).root,
  );

  // ---- the waterfall
  const flow = el("div", "tr-block tr-flow");
  const flowTitle = el("h3", "sub-title", "Du prévu au réel");
  const wfList = el("div", "tr-wf");
  wfList.setAttribute("role", "list");
  const wf: any[] = [];
  for (let i = 0; i < cfg.waterfallRows; i++) {
    const r: any = { root: el("div", "tr-wf-row") };
    r.root.setAttribute("role", "listitem");
    r.label = el("span", "tr-wf-label", "");
    r.hint = el("span", "tr-wf-hint", "");
    r.track = el("div", "tr-wf-track");
    r.bar = el("div", "tr-wf-bar");
    r.zero = el("div", "tr-wf-zero");
    add(r.track, r.zero, r.bar);
    r.value = el("span", "tr-wf-value", "");
    r.tag = el("span", "tr-tag", "");
    const names = el("div", "tr-wf-names");
    add(names, r.label, r.hint);
    const vals = el("div", "tr-wf-vals");
    add(vals, r.value, r.tag);
    add(r.root, names, r.track, vals);
    wf.push(r);
    add(wfList, r.root);
  }
  const flowNote = el("p", "note tr-flow-note", "");
  add(flow, flowTitle, wfList, flowNote);

  // ---- fees and pace, side by side
  const duo = el("div", "tr-duo");
  const feeBox = el("div", "tr-block tr-fees");
  const feeTitle = el("h3", "sub-title", "Frais");
  const feeRows: any[] = [];
  const feeList = el("div", "tr-lines");
  for (let i = 0; i < 3; i++) {
    const r: any = { root: el("div", "tr-line-row") };
    r.label = el("span", "tr-line-label", "");
    r.value = el("span", "tr-line-value", "");
    r.sub = el("span", "tr-line-sub", "");
    add(r.root, r.label, r.value, r.sub);
    feeRows.push(r);
    add(feeList, r.root);
  }
  const feeNote = el("p", "note", "");
  add(feeBox, feeTitle, feeList, feeNote);

  const paceBox = el("div", "tr-block tr-pace");
  const paceTitle = el("h3", "sub-title", "Rythme et projection");
  const paceRows: any[] = [];
  const paceList = el("div", "tr-lines");
  for (let i = 0; i < 5; i++) {
    const r: any = { root: el("div", "tr-line-row") };
    r.label = el("span", "tr-line-label", "");
    r.value = el("span", "tr-line-value", "");
    r.sub = el("span", "tr-line-sub", "");
    add(r.root, r.label, r.value, r.sub);
    paceRows.push(r);
    add(paceList, r.root);
  }
  const paceNote = el("p", "note", "");
  add(paceBox, paceTitle, paceList, paceNote);
  add(duo, feeBox, paceBox);

  // ---- the price curve ("cours")
  const courseBox = el("div", "tr-block tr-course");
  const courseTitle = el("h3", "sub-title", "Cours");
  const W = 300;
  const H = 72;
  const chart = svg("svg", {
    viewBox: "0 0 " + W + " " + H,
    preserveAspectRatio: "none",
    class: "tr-chart",
  });
  chart.setAttribute("role", "img");
  const area = svg("polygon", { class: "tr-area", points: "" });
  const curve = svg("polyline", { class: "tr-curve", points: "" });
  const meanLine = svg("line", { class: "tr-mean", x1: 0, x2: W, y1: 0, y2: 0 });
  const targetLine = svg("line", { class: "tr-target", x1: 0, x2: W, y1: 0, y2: 0 });
  const realisedLine = svg("line", { class: "tr-real", x1: 0, x2: W, y1: 0, y2: 0 });
  add(chart, area, meanLine, targetLine, realisedLine, curve);
  // The last price is a dot in HTML: a circle inside a stretched SVG would be squashed.
  const lastDot = el("span", "tr-dot");
  const chartWrap = el("div", "tr-chart-wrap");
  add(chartWrap, chart, lastDot);
  const courseRange = el("div", "tr-range");
  const rangeBar = el("div", "tr-range-bar");
  const rangeTarget = el("span", "tr-range-mark tr-range-target");
  const rangeReal = el("span", "tr-range-mark tr-range-real");
  add(rangeBar, rangeTarget, rangeReal);
  const rangeEnds = el("div", "tr-range-ends");
  const rangeLo = el("span", "", "");
  const rangeHi = el("span", "", "");
  add(rangeEnds, rangeLo, rangeHi);
  add(courseRange, rangeBar, rangeEnds);
  const legend = el("ul", "tr-legend");
  const legendItems: any[] = [];
  for (let i = 0; i < 4; i++) {
    const li = el("li", "tr-legend-item");
    li.swatch = el("span", "tr-swatch");
    li.text = el("span", "", "");
    add(li, li.swatch, li.text);
    legendItems.push(li);
    add(legend, li);
  }
  const courseNote = el("p", "note", "");
  add(courseBox, courseTitle, chartWrap, courseRange, legend, courseNote);

  // ---- details, folded
  const more = el("details", "tr-more");
  const moreSum = el("summary", "tr-more-sum", "Détails, hypothèses et trajets précédents");
  const moreBody = el("div", "tr-more-body");
  const history = el("ul", "tr-history");
  const historyItems: any[] = [];
  for (let i = 0; i < cfg.maxRuns; i++) {
    const li = el("li", "tr-history-item", "");
    historyItems.push(li);
    add(history, li);
  }
  const assumptions = el("ul", "tr-assumptions");
  const assumptionItems: any[] = [];
  for (let i = 0; i < cfg.assumptionSlots; i++) {
    const li = el("li", "", "");
    assumptionItems.push(li);
    add(assumptions, li);
  }
  const assumptionsTitle = el("h3", "sub-title", "Hypothèses de la projection");
  const defsTitle = el("h3", "sub-title", "Ce que veulent dire les chiffres");
  const defs = el(
    "p",
    "note",
    "Bénéfice prévu : la marge du plan, avant frais. Chiffre d’affaires : ce que les ventes ont rapporté. Marge brute : ventes moins achats, à comparer au prévu. Frais : ce que le service de chargement prend en plus des prix ; le journal du jeu n’a pas de ligne de frais, ils sont donc mesurés contre ton solde ou déduits. Bénéfice net : solde à la fin moins solde juste avant le premier achat, seul chiffre qui dit ce que tu as vraiment gagné.",
  );
  const historyTitle = el("h3", "sub-title", "Trajets précédents");
  add(moreBody, assumptionsTitle, assumptions, defsTitle, defs, historyTitle, history);
  add(more, moreSum, moreBody);

  add(root, head, message, warn, hero, slot, flow, duo, courseBox, more);

  function render(ctx: any) {
    const trade = ctx && ctx.trade ? ctx.trade : null;
    const plan = ctx && ctx.plan ? ctx.plan : null;
    const showBalance = !!(ctx && ctx.showBalance);
    const full = !!(ctx && ctx.fullscreen);
    const run = trade && trade.runs && trade.runs.length > 0 ? trade.runs[0] : null;
    const m = run && showBalance ? run.money : null;

    const inline = full ? "" : tradeInlineText(L, trade, showBalance);
    setText(line, inline);
    show(line, inline !== "");

    // The action bar (tradeActions.ts) needs the card even before there is a run or a plan to show.
    const bare = !run && !plan;
    const visible = full && (!bare || !!(ctx && ctx.actionsEnabled));
    show(root, visible);
    show(slot, visible && !!(ctx && ctx.actionsEnabled));
    if (!visible) return;

    // ---- header
    setText(route, tradeRouteText(plan, run));
    const metaParts: string[] = [];
    const scu =
      run && run.scu_bought !== null
        ? run.scu_bought
        : plan && typeof plan.scu === "number"
          ? plan.scu
          : null;
    if (scu !== null) metaParts.push(L.fmtNum(scu) + "\u00a0SCU");
    if (plan && plan.est_trip_minutes)
      metaParts.push("trajet estimé " + plan.est_trip_minutes + " min");
    if (run && run.duration_ms > 0) metaParts.push("durée " + L.formatDuration(run.duration_ms));
    if (run && run.failed > 0) metaParts.push(run.failed + " échec(s) non compté(s)");
    if (run && run.uncertain > 0)
      metaParts.push(run.uncertain + " ligne(s) non confirmée(s) non comptée(s)");
    if (plan && plan.safety_note) metaParts.push(plan.safety_note);
    if (plan && plan.note) metaParts.push(plan.note);
    setText(meta, metaParts.join(" · "));
    setText(stage, run ? tradeStageLabel(run.stage) : plan ? "Plan seul" : "");
    show(stage, !bare);
    setAttr(stage, "data-stage", run ? run.stage : "plan");

    // ---- what is missing, said once and plainly
    let msg = "";
    let statusOk = true;
    if (!trade || trade.source !== "journal") {
      statusOk = false;
      const st = ctx && ctx.ledgerStatus;
      msg =
        st === "loading"
          ? "Lecture du journal de jeu… le bilan réel du trajet apparaîtra ensuite."
          : "Le journal de jeu est désactivé ou illisible (voir sc_log_status) : le bilan réel du trajet (chiffre d’affaires, frais, bénéfice net) n’est pas calculé. Ci-dessous, le plan et la variation du solde, qui n’est pas un bénéfice.";
    } else if (!run) {
      statusOk = false;
      msg = "Aucune transaction de marchandise dans le journal pour l’instant.";
    } else if (!showBalance) {
      statusOk = false;
      msg =
        "Le solde est masqué : les montants du bilan (chiffre d’affaires, frais, bénéfice net) apparaissent quand tu affiches le solde.";
    }
    setText(message, msg);
    show(message, msg !== "");

    // ---- headline tiles
    const net = m ? m.net : null;
    const tileValue = (
      t: any,
      text: string,
      tone: string,
      tag: string,
      estimate: boolean,
      sub: string,
    ) => {
      setText(t.value, text);
      setAttr(t.value, "data-tone", tone);
      setText(t.tag, tag);
      setAttr(t.tag, "data-estimate", estimate ? "1" : "0");
      show(t.tag, tag !== "");
      setText(t.sub, sub);
      show(t.sub, sub !== "");
    };
    if (m && net) {
      if (net.auec !== null) {
        tileValue(
          tiles.net,
          tradeAmount(L, net.auec, true),
          net.auec >= 0 ? "ok" : "bad",
          tradeNetTag(net),
          tradeIsEstimate(net.method),
          tradeNetSource(net),
        );
      } else {
        tileValue(tiles.net, "—", "", "inconnu", true, tradeNetReason(net.reason));
      }
      tileValue(
        tiles.turnover,
        tradeAmount(L, m.turnover),
        "",
        m.turnover !== null ? "mesuré" : "",
        false,
        m.turnover !== null
          ? "ventes" +
              (m.avg_sell_per_scu
                ? " · " + L.fmtNum(m.avg_sell_per_scu) + " aUEC/SCU en moyenne"
                : "")
          : "rien vendu pour l’instant",
      );
      if (m.fees.total !== null) {
        tileValue(
          tiles.fees,
          tradeAmount(L, -m.fees.total, true),
          "",
          tradeMethodLabel(m.fees.method),
          tradeIsEstimate(m.fees.method),
          m.turnover ? tradePct(L, m.fees.total / m.turnover) + " du chiffre d’affaires" : "",
        );
      } else {
        const why: any = {
          solde_autre_raison:
            "le solde a bougé pour une autre raison : l’écart avec la marge n’est pas un frais plausible",
          lignes_non_confirmees: "des lignes non confirmées du journal empêchent de les déduire",
          stock_anterieur: "des SCU vendus n’ont pas été achetés ici : impossible de les déduire",
        };
        tileValue(
          tiles.fees,
          "—",
          "",
          "inconnu",
          true,
          why[m.fees.reason] || "ni mesurés ni déductibles pour l’instant",
        );
      }
      const next = m.projection
        ? m.projection.next_run_net
        : m.planned_net
          ? m.planned_net.auec
          : null;
      if (next !== null && next !== undefined) {
        tileValue(
          tiles.next,
          "≈ " + tradeAmount(L, next, true),
          next >= 0 ? "ok" : "bad",
          "estimé",
          true,
          m.planned_net
            ? "bénéfice prévu − frais au taux " +
                (m.fees.rate_from === "trajet_precedent" ? "du trajet précédent" : "observé") +
                " (" +
                tradePct(L, m.planned_net.fee_rate) +
                ")"
            : "même résultat que ce trajet",
        );
      } else {
        tileValue(tiles.next, "—", "", "", false, "il faut un plan et des frais observés");
      }
    } else {
      const hidden = run && !showBalance ? "solde masqué" : "";
      tileValue(tiles.net, "—", "", "", false, hidden || "pas de bilan sans journal");
      tileValue(tiles.turnover, "—", "", "", false, hidden);
      tileValue(tiles.fees, "—", "", "", false, hidden);
      tileValue(tiles.next, "—", "", "", false, hidden);
    }
    show(hero, !bare);

    // ---- waterfall
    const layout = tradeWaterfallLayout(tradeWaterfall(m));
    show(flow, !!m && layout.rows.length > 0);
    for (let i = 0; i < wf.length; i++) {
      const r = wf[i];
      const row = layout.rows[i];
      show(r.root, !!row);
      if (!row) continue;
      setText(r.label, row.label);
      setText(r.hint, row.hint);
      setAttr(r.root, "data-kind", row.kind);
      setAttr(r.root, "data-tone", row.tone);
      setAttr(r.root, "data-estimate", row.estimate ? "1" : "0");
      setVar(r.bar, "--l", String(row.left));
      setVar(r.bar, "--w", String(row.width));
      setVar(r.zero, "--z", String(layout.zero));
      setText(r.value, tradeAmount(L, row.value, true));
      setText(r.tag, row.tag);
      setAttr(r.tag, "data-estimate", row.estimate ? "1" : "0");
    }
    let flowText = "";
    if (m) {
      if (m.plan_match === "non_verifie")
        flowText =
          "Le plan est supposé être celui de ce trajet : le journal du jeu ne nomme pas les marchandises, impossible de le vérifier. ";
      if (m.price_gap !== null && m.gap_includes_quantity)
        flowText += "La quantité achetée diffère du plan : l’écart mêle prix et quantité. ";
      if (m.cost_paired)
        flowText +=
          "La marge ne valorise que les SCU vendus et achetés pendant ce trajet (premier entré, premier sorti, comme sc_trade_journal). ";
    }
    setText(flowNote, flowText.trim());
    show(flowNote, flowText !== "");

    // ---- warnings: what changes how a figure must be read
    const warns: string[] = [];
    if (run && run.prior_stock_scu > 0)
      warns.push(
        "Stock antérieur : " +
          L.fmtNum(run.prior_stock_scu, 2) +
          "\u00a0SCU vendus n’ont pas été achetés pendant ce trajet. Ils ne sont pas valorisés dans la marge, mais leur vente est dans le solde : la variation du solde est gonflée.",
      );
    if (m && m.fees.reason === "solde_autre_raison")
      warns.push(
        "Le solde a bougé pour une autre raison que les frais : l’écart de " +
          tradeAmount(L, m.fees.unexplained, true) +
          " entre la marge brute et la variation du solde n’est pas un frais plausible (0 à 50 % du chiffre d’affaires), il n’est donc pas affiché comme tel.",
      );
    else if (
      m &&
      m.fees.unexplained !== null &&
      m.turnover &&
      Math.abs(m.fees.unexplained) > m.turnover * 0.02
    )
      warns.push(
        "Le solde a " +
          (m.fees.unexplained > 0 ? "baissé" : "monté") +
          " de " +
          tradeAmount(L, Math.abs(m.fees.unexplained)) +
          " de plus que la marge brute et les frais ne l’expliquent (" +
          (m.fees.unexplained > 0
            ? "un autre achat ou une autre dépense pendant le trajet ?"
            : "une récompense ou la vente d’autre chose ?") +
          ") : la variation du solde n’est pas le bénéfice de ce seul trajet.",
      );
    setText(warn, warns.length ? "Attention : " + warns.join(" ") : "");
    show(warn, warns.length > 0);

    // ---- fees
    const fm = m ? m.fees : null;
    show(feeBox, !!m);
    if (fm) {
      const sideRow = (r: any, label: string, side: any, base: number | null) => {
        show(r.root, !!side);
        if (!side) return;
        setText(r.label, label);
        setText(r.value, tradeAmount(L, -side.auec, true));
        setText(
          r.sub,
          (base ? tradePct(L, side.auec / base) + " du montant · " : "") +
            tradeMethodLabel(side.method),
        );
        setAttr(r.root, "data-estimate", tradeIsEstimate(side.method) ? "1" : "0");
      };
      sideRow(feeRows[0], "Achat", fm.buy, m.cost_paired ? null : m.cost);
      sideRow(feeRows[1], "Vente", fm.sell, m.turnover);
      show(feeRows[2].root, fm.total !== null);
      if (fm.total !== null) {
        setText(feeRows[2].label, "Total");
        setText(feeRows[2].value, tradeAmount(L, -fm.total, true));
        setText(
          feeRows[2].sub,
          fm.method === "mesure"
            ? "mesuré contre ton solde, côté par côté"
            : "estimé : marge brute − bénéfice net, sans détail par côté",
        );
        setAttr(feeRows[2].root, "data-estimate", tradeIsEstimate(fm.method) ? "1" : "0");
      }
      let fn = "";
      if (fm.total === null) {
        fn =
          fm.reason === "solde_autre_raison"
            ? "Le solde a bougé pour une autre raison : l’écart avec la marge n’est pas un frais plausible, il n’est pas affiché comme tel."
            : fm.reason === "stock_anterieur"
              ? "Des SCU vendus n’ont pas été achetés pendant ce trajet : les frais ne peuvent pas être déduits du solde."
              : run && run.uncertain > 0
                ? "Des lignes non confirmées du journal empêchent de mesurer ou de déduire les frais : elles ont peut-être bougé le solde."
                : "Le journal n’a pas de ligne de frais. Ils sont mesurés quand le solde a bougé à côté d’une transaction, ou déduits de l’écart entre la marge et le bénéfice net ; ici aucun des deux n’est possible.";
      } else if (fm.rate_from === "trajet_precedent") {
        fn =
          "Taux de frais repris du trajet précédent : " +
          tradePct(L, fm.rate) +
          " du chiffre d’affaires.";
      } else if (fm.rate !== null) {
        fn = "Taux observé : " + tradePct(L, fm.rate) + " du chiffre d’affaires (achat + vente).";
      }
      setText(feeNote, fn);
      show(feeNote, fn !== "");
    }

    // ---- pace: the duration is not money, the rest is
    const pj = m ? m.projection : null;
    show(paceBox, !!run && run.duration_ms > 0);
    const paceRow = (
      r: any,
      label: string,
      value: string,
      sub: string,
      estimate: boolean,
      on: boolean,
    ) => {
      show(r.root, on);
      if (!on) return;
      setText(r.label, label);
      setText(r.value, value);
      setText(r.sub, sub);
      setAttr(r.root, "data-estimate", estimate && value !== "—" ? "1" : "0");
    };
    if (run) {
      paceRow(
        paceRows[0],
        "Durée du trajet",
        L.formatDuration(run.duration_ms),
        "du premier achat à la dernière transaction",
        false,
        true,
      );
      paceRow(
        paceRows[1],
        "Bénéfice net par heure",
        pj && pj.net_per_hour !== null ? tradeAmount(L, pj.net_per_hour, true) : "—",
        pj
          ? pj.net_doubtful
            ? "indisponible : le solde contient d’autres mouvements"
            : "estimé, à ce rythme"
          : showBalance
            ? "disponible après 2 min d’un trajet terminé"
            : "solde masqué",
        true,
        true,
      );
      paceRow(
        paceRows[2],
        "Répétitions par heure",
        pj ? L.fmtNum(pj.runs_per_hour, 1) : "—",
        pj
          ? pj.basis === "cycle_observe"
            ? "estimé : 3 600 s ÷ cycle observé de " + L.formatDuration(pj.cycle_ms)
            : "estimé : 3 600 s ÷ (trajet + " +
              Math.round(pj.overhead_ms / 60000) +
              " min d’attente et de trajet à vide supposées)"
          : "",
        true,
        !!pj,
      );
      paceRow(
        paceRows[3],
        pj ? "Sur " + pj.day_hours + " h de jeu" : "",
        pj && pj.net_per_day !== null ? tradeAmount(L, pj.net_per_day, true) : "—",
        pj && pj.runs_per_day !== null
          ? L.fmtNum(pj.runs_per_day, 0) + " trajets · hypothèse de " + pj.day_hours + " h de jeu"
          : "",
        true,
        !!pj && pj.runs_per_day !== null,
      );
      paceRow(
        paceRows[4],
        "Prochain trajet, net de frais",
        pj && pj.next_run_net !== null ? tradeAmount(L, pj.next_run_net, true) : "—",
        m && m.planned_net
          ? m.planned_net.basis === "prix_du_plan"
            ? "plan − frais au taux observé, sur le chiffre d’affaires du plan"
            : "plan − frais au taux observé, sur le chiffre d’affaires de ce trajet"
          : pj && pj.next_run_net !== null
            ? "même résultat que ce trajet"
            : "il faut un bénéfice net mesuré ou un plan et des frais observés",
        true,
        !!pj,
      );
    }
    setText(
      paceNote,
      pj
        ? "Extrapolation, pas une promesse : voir les hypothèses plus bas." +
            (pj.runs_per_day === null
              ? " Le chiffre « sur N h de jeu » apparaît après deux trajets mesurés."
              : "")
        : "",
    );
    show(paceNote, !!pj);
    show(duo, !!m || (!!run && run.duration_ms > 0));

    // ---- the curve
    const course = tradeCourse(plan, m);
    show(courseBox, !!course);
    if (course) {
      setText(
        courseTitle,
        "Cours " +
          (course.sellSide ? "de vente" : "d’achat") +
          (course.label ? " · " + course.label : ""),
      );
      const poly = tradeCoursePoints(course, W, H);
      setAttr(curve, "points", poly);
      setAttr(area, "points", poly + " " + W + "," + H + " 0," + H);
      const y = (at: number) => tradeLevelY(at, H);
      setAttr(meanLine, "y1", String(y(course.meanAt)));
      setAttr(meanLine, "y2", String(y(course.meanAt)));
      show(targetLine, course.target !== null);
      show(realisedLine, course.realised !== null);
      if (course.target !== null) {
        setAttr(targetLine, "y1", String(y(course.targetAt)));
        setAttr(targetLine, "y2", String(y(course.targetAt)));
      }
      if (course.realised !== null) {
        setAttr(realisedLine, "y1", String(y(course.realisedAt)));
        setAttr(realisedLine, "y2", String(y(course.realisedAt)));
      }
      const lastAt = (course.last - course.lo) / (course.hi - course.lo || 1);
      setVar(lastDot, "--y", String(Math.round((y(lastAt) / H) * 1000) / 10));
      setVar(
        rangeTarget,
        "--at",
        String(course.targetAt === null ? 0 : Math.round(course.targetAt * 1000) / 10),
      );
      show(rangeTarget, course.target !== null);
      setVar(
        rangeReal,
        "--at",
        String(course.realisedAt === null ? 0 : Math.round(course.realisedAt * 1000) / 10),
      );
      show(rangeReal, course.realised !== null);
      setText(rangeLo, "min " + L.fmtNum(course.lo));
      setText(rangeHi, "max " + L.fmtNum(course.hi));
      const unit = "\u00a0aUEC/SCU";
      const items: string[][] = [
        [
          "curve",
          "Dernier cours : " +
            L.fmtNum(course.last) +
            unit +
            " (" +
            course.points.length +
            " relevés)",
        ],
        ["mean", "Moyenne des relevés : " + L.fmtNum(course.mean) + unit],
      ];
      if (course.target !== null)
        items.push(["target", "Prix visé par le plan : " + L.fmtNum(course.target) + unit]);
      if (course.realised !== null)
        items.push([
          "real",
          "Prix obtenu en moyenne (mesuré) : " + L.fmtNum(course.realised) + unit,
        ]);
      for (let i = 0; i < legendItems.length; i++) {
        const it = items[i];
        show(legendItems[i], !!it);
        if (!it) continue;
        setAttr(legendItems[i].swatch, "data-kind", it[0] as string);
        setText(legendItems[i].text, it[1] as string);
      }
      let cn =
        "Relevés fournis par Claude à partir des prix UEX (la courbe ne vient jamais d’un appel du tableau de bord à UEX) ; ils peuvent dater.";
      if (course.targetVsMean !== null)
        cn =
          "Le prix visé est " +
          tradePct(L, Math.abs(course.targetVsMean)) +
          (course.targetVsMean >= 0 ? " au-dessus" : " en dessous") +
          " de la moyenne des relevés. " +
          cn;
      setText(courseNote, cn);
      setAttr(
        chart,
        "aria-label",
        "Courbe des " +
          course.points.length +
          " derniers cours, de " +
          L.fmtNum(course.lo) +
          " à " +
          L.fmtNum(course.hi) +
          " aUEC par SCU",
      );
    }

    // ---- folded details
    const moreOn = !!trade && trade.source === "journal" && !!run;
    show(more, moreOn || !!pj);
    const list: string[] = pj && pj.assumptions ? pj.assumptions : [];
    show(assumptionsTitle, list.length > 0);
    show(assumptions, list.length > 0);
    for (let i = 0; i < assumptionItems.length; i++) {
      show(assumptionItems[i], i < list.length);
      setText(assumptionItems[i], list[i] || "");
    }
    const past = trade && trade.runs ? trade.runs.slice(1) : [];
    show(historyTitle, past.length > 0);
    show(history, past.length > 0);
    for (let i = 0; i < historyItems.length; i++) {
      const r = past[i];
      show(historyItems[i], !!r);
      if (!r) continue;
      const bits = [
        (tradeGoodsLabel(r.commodity) || "marchandise") +
          " · " +
          tradeStageLabel(r.stage).toLowerCase(),
      ];
      if (r.scu_bought !== null) bits.push(L.fmtNum(r.scu_bought) + "\u00a0SCU");
      if (showBalance && r.money && r.money.net.auec !== null)
        bits.push(
          "net " +
            tradeAmount(L, r.money.net.auec, true) +
            " (" +
            tradeMethodLabel(r.money.net.method) +
            ")",
        );
      setText(historyItems[i], bits.join(" · "));
    }

    // ---- no journal: the plan, and the balance change called by its name
    if (!statusOk && (!trade || trade.source !== "journal") && plan) {
      const bal =
        showBalance && ctx.balance && typeof ctx.balance.delta === "number" ? ctx.balance : null;
      setText(tiles.net.sub, "pas de bilan sans journal");
      if (typeof plan.expected_profit_auec === "number") {
        setText(tiles.turnover.label, "Bénéfice prévu");
        setText(tiles.turnover.value, tradeAmount(L, plan.expected_profit_auec, true));
        setText(tiles.turnover.sub, "marge du plan, avant frais");
        show(tiles.turnover.sub, true);
      }
      if (bal) {
        setText(tiles.fees.label, "Variation du solde");
        setText(tiles.fees.value, tradeAmount(L, bal.delta, true));
        setText(tiles.fees.sub, (ctx.baseline || "") + " · pas un bénéfice : tout est mêlé");
        show(tiles.fees.sub, true);
      }
    } else {
      setText(tiles.turnover.label, "Chiffre d’affaires");
      setText(tiles.fees.label, "Frais");
    }
  }

  return { line, card: root, slot, render };
}

/** The functions of this file, in the order they are serialised (page.ts). */
export const TRADE_VIEW_FUNCTIONS = [
  tradeConfig,
  tradePct,
  tradeAmount,
  tradeStageLabel,
  tradeMethodLabel,
  tradeIsEstimate,
  tradeNetReason,
  tradeNetSource,
  tradeNetTag,
  tradeGoodsLabel,
  tradeRouteText,
  tradeWaterfall,
  tradeWaterfallLayout,
  tradeCourse,
  tradeCoursePoints,
  tradeLevelY,
  tradeInlineText,
  tradePanel,
];
