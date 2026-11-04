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

/** Is it the journal's id of a good (the first 8 characters of the game's GUID), which is not a name? */
export function tradeIsGoodsId(id: string | null | undefined): boolean {
  return typeof id === "string" && /^[0-9a-f]{8}$/.test(id);
}

/**
 * The journal names goods by an id only (the first 8 characters of the game's GUID). That id is never shown: a good
 * without a name is "marchandise inconnue". A plan's own name is always preferred where there is a plan.
 */
export function tradeGoodsLabel(id: string | null | undefined): string {
  if (!id) return "";
  return tradeIsGoodsId(id) ? "marchandise inconnue" : id;
}

/**
 * The goods of a run as words: the name the server resolved when there is one, else "marchandise inconnue" (the id of the
 * journal is never shown). "" without a run.
 */
export function tradeRunGoods(run: any): string {
  if (!run) return "";
  if (run.commodity_name) return run.commodity_name;
  return tradeGoodsLabel(run.commodity);
}

/** The name of the run's goods when there is one (resolved, or a journal label that is not an id); "" otherwise. */
export function tradeRunNamed(run: any): string {
  if (!run) return "";
  if (run.commodity_name) return String(run.commodity_name);
  return run.commodity && !tradeIsGoodsId(run.commodity) ? String(run.commodity) : "";
}

/** The route of the plan or of the run, as one line. */
export function tradeRouteText(L: any, plan: any, run: any): string {
  const parts: string[] = [];
  const goods = tradeRunNamed(run) || (plan && plan.commodity) || tradeRunGoods(run);
  if (goods) parts.push(goods);
  const from =
    (plan && plan.buy_terminal) || L.shopWords(run && run.buy_shops && run.buy_shops[0]) || "";
  const to =
    (plan && plan.sell_terminal) || L.shopWords(run && run.sell_shops && run.sell_shops[0]) || "";
  if (from && to) parts.push(from + " → " + to);
  else if (from || to) parts.push(from || to);
  return parts.join(" · ");
}

/** A time that has passed, coarsely: "moins d’1 min", "6 min", "1 h 05 min". Null when it is not a usable time. */
export function tradeAgo(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "moins d’1\u00a0min";
  if (minutes < 60) return minutes + "\u00a0min";
  const m = minutes % 60;
  return Math.floor(minutes / 60) + "\u00a0h\u00a0" + (m < 10 ? "0" + m : m) + "\u00a0min";
}

/** How long the run has lasted so far, from its first purchase to `now` (both in ms); null when unknown or in the future. */
export function tradeElapsed(run: any, now: any): number | null {
  if (!run || typeof now !== "number" || !Number.isFinite(now)) return null;
  const from = Date.parse(run.started_at);
  if (!Number.isFinite(from)) return null;
  // The log's clock and the page's can differ a little: a first purchase "in the future" says nothing.
  return now >= from ? now - from : null;
}

/** Like tradeAgo for a run that has been left: whole hours ("5 h"), and days from 48 h ("3 j"). */
export function tradeAgoLong(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return tradeAgo(ms);
  if (hours < 48) return hours + "\u00a0h";
  return Math.floor(hours / 24) + "\u00a0j";
}

/**
 * A run whose movement can no longer be claimed: its first purchase is more than 3 hours old, or the game says the player
 * is not in a server session (menu, disconnected, closed). Then the line says when the purchase was and nothing about a
 * trip under way or a plan. An unknown connection (no state read) does not make a run idle.
 */
export function tradeRunIdle(run: any, now: any, conn: any): boolean {
  if (conn === "menu" || conn === "disconnected" || conn === "closed") return true;
  const e = tradeElapsed(run, now);
  return e !== null && e > 3 * 3600000;
}

/**
 * When a run happened, in words a player reads at a glance: "aujourd’hui 14:05", "hier 22:14", "3 nov. 22:14" (the page's
 * own local time). "" when the time is not usable. `now` is the page's clock (ms); without it the date is always spelled out.
 */
export function tradeWhen(iso: any, now: any): string {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const two = (n: number) => (n < 10 ? "0" + n : String(n));
  const clock = two(d.getHours()) + ":" + two(d.getMinutes());
  if (typeof now === "number" && Number.isFinite(now)) {
    const key = (x: Date) => x.getFullYear() * 10000 + x.getMonth() * 100 + x.getDate();
    const n = new Date(now);
    if (key(d) === key(n)) return "aujourd’hui " + clock;
    if (key(d) === key(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1)))
      return "hier " + clock;
  }
  const months = [
    "janv.",
    "févr.",
    "mars",
    "avr.",
    "mai",
    "juin",
    "juil.",
    "août",
    "sept.",
    "oct.",
    "nov.",
    "déc.",
  ];
  return d.getDate() + "\u00a0" + months[d.getMonth()] + " " + clock;
}

/**
 * Which runs of the journal belong to the play session, and which are older. The journal (Game.log) knows nothing of the
 * session: it still holds the runs of the last game launch when the game is closed and a new session has just begun, and
 * a figure of such a run next to the session's own would read as a session result.
 *   scope = { known, start, end }: the saved play session in force (poll.sessions.current), epoch ms; `known` false when
 *           there is none to compare with (sessions off, or the bar is absent); `start` Infinity when no session exists yet.
 * A run is OF the session when its last transaction is not before the session's start (a purchase made just before a
 * manual "Nouvelle session" stays a trip under way) and its first one is not after the session's end. Without a known
 * session (sessions off) only the age decides: a run whose last transaction is over 3 hours old is not of the session. The
 * connection does not: a trip left in the menus 2 minutes ago is still a trip (the line says it is not finished).
 * Returns { trade, past }: `trade` is the section limited to the session's runs (a copy; `ship_losses` and the rest stay),
 * `past` the older runs, newest first. The input is never changed.
 */
export function tradeSplitBySession(trade: any, scope: any, now: any): any {
  if (!trade || trade.source !== "journal" || !Array.isArray(trade.runs) || trade.runs.length === 0)
    return { trade, past: [] };
  const known = !!scope && scope.known === true;
  const of = (r: any): boolean => {
    const last = Date.parse(r && r.ended_at);
    const first = Date.parse(r && r.started_at);
    if (!Number.isFinite(last)) return true;
    if (known) {
      if (typeof scope.start === "number" && last < scope.start) return false;
      if (typeof scope.end === "number" && Number.isFinite(first) && first > scope.end)
        return false;
      return true;
    }
    return !(typeof now === "number" && Number.isFinite(now) && now - last > 3 * 3600000);
  };
  const mine = trade.runs.filter(of);
  if (mine.length === trade.runs.length) return { trade, past: [] };
  return {
    trade: Object.assign({}, trade, { runs: mine }),
    past: trade.runs.filter((r: any) => !of(r)),
  };
}

/**
 * The play session in force, from the poll's session bar, as tradeSplitBySession wants it: { known, start, end } in epoch
 * ms. `known` is false when sessions are off or the bar is absent. `start` is Infinity when no session exists yet, so that
 * nothing of the journal is "of the session".
 */
export function tradeSessionScope(poll: any): any {
  const bar = poll && poll.sessions;
  if (!bar || typeof bar !== "object" || bar.status === "off") return { known: false };
  const cur = bar.current;
  if (!cur || typeof cur !== "object") return { known: true, start: Infinity, end: null };
  const start = Date.parse(cur.started_at);
  if (!Number.isFinite(start)) return { known: false };
  const end = typeof cur.ended_at === "string" ? Date.parse(cur.ended_at) : NaN;
  return { known: true, start, end: Number.isFinite(end) ? end : null };
}

/** The label of the last run known outside the session: "Dernier trajet connu · hier 22:14, hors session". */
export function tradePastLabel(run: any, now: any): string {
  const when = tradeWhen(run && run.ended_at, now);
  return "Dernier trajet connu" + (when ? " · " + when : "") + ", hors session";
}

/**
 * What a run left outside the session is, in a few facts (no amount): the goods, the places, the quantity, how long it took
 * and how it ended. A calm sentence that never reads as a result of the session.
 */
export function tradePastFacts(L: any, run: any): string {
  if (!run) return "";
  const route = tradeRouteText(L, null, run);
  const bits: string[] = [route || tradeRunGoods(run) || "marchandise inconnue"];
  if (run.scu_bought !== null && run.scu_bought !== undefined)
    bits.push(L.fmtNum(run.scu_bought) + "\u00a0SCU");
  if (run.stage === "complete" && run.duration_ms > 0)
    bits.push("durée " + L.formatDuration(run.duration_ms));
  bits.push(
    run.stage === "open" || run.stage === "partial"
      ? "non terminé"
      : tradeStageLabel(run.stage).toLowerCase(),
  );
  return bits.join(" · ");
}

/**
 * The compact line for a run outside the session: its goods and when, nothing else (no amount, no stage of a trip under way).
 * "" without such a run. The card in full screen holds the detail.
 */
export function tradePastLine(L: any, past: any, now: any): string {
  const run = past && past.length > 0 ? past[0] : null;
  if (!run) return "";
  const goods = tradeRunGoods(run) || "marchandise inconnue";
  const when = tradeWhen(run.ended_at, now);
  return "Hors session · dernier trajet connu : " + goods + (when ? ", " + when : "");
}

/**
 * Has the journal's shop no SPECIFIC word in common with the plan's place? Generic words (shop, cargo, port, station,
 * hub, admin, centre...) are ignored on both sides of the comparison: a word every place has proves nothing. A shop with
 * no specific word left, or a missing side, is not compared (false: it does not contradict).
 */
export function tradeShopContradicts(L: any, terminal: any, token: any): boolean {
  if (!terminal || !token) return false;
  const generic = [
    "scshop",
    "shop",
    "cargo",
    "commodity",
    "port",
    "station",
    "center",
    "centre",
    "admin",
    "hub",
    "outpost",
    "terminal",
    "trade",
    "trading",
    "depot",
    "market",
    "kiosk",
    "exchange",
    "tdd",
  ];
  const plain = (x: string) =>
    x
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  const words = plain(L.shopWords(token))
    .split(/[^a-z0-9]+/)
    .filter((w: string) => w.length >= 3 && generic.indexOf(w) < 0);
  if (words.length === 0) return false;
  const place = plain(String(terminal));
  return words.every((w: string) => place.indexOf(w) < 0);
}

/**
 * May the plan be said to be THIS run's? { ok, note }. Not when:
 *   - the run's goods are named and the plan names other goods;
 *   - the journal's shop (buying, or selling) has no specific word in the plan's place for it;
 *   - this View received the plan (`planAt`, ms) after the run's first purchase (note), or another run of the list
 *     (finished or not) began after `planAt` and before this one: the plan is spent, it belongs to the first run
 *     that began after it (note).
 * Without `planAt` the plan cannot be dated: it is attached as it is (the callers label it "d’après ton plan").
 * `runs` is the list of the payload (newest first, at most four): a run missing from it is older than all of those.
 */
export function tradePlanAttached(L: any, plan: any, run: any, planAt: any, runs: any): any {
  const no = (note: string) => ({ ok: false, note });
  if (!plan || typeof plan !== "object" || !run) return { ok: !!plan, note: "" };
  const known = tradeRunNamed(run);
  if (known && plan.commodity) {
    const a = known.toLowerCase();
    const b = String(plan.commodity).toLowerCase();
    if (a.indexOf(b) !== 0 && b.indexOf(a) !== 0) return no("");
  }
  const buyShop = run.buy_shops ? run.buy_shops[0] : null;
  const sellShop = run.sell_shops ? run.sell_shops[0] : null;
  if (
    tradeShopContradicts(L, plan.buy_terminal, buyShop) ||
    tradeShopContradicts(L, plan.sell_terminal, sellShop)
  )
    return no("");
  const first = Date.parse(run.started_at);
  if (typeof planAt === "number" && Number.isFinite(first)) {
    if (first < planAt) return no("plan reçu après le premier achat, non rattaché");
    const list = Array.isArray(runs) ? runs : [];
    for (const other of list) {
      const at = other && other !== run && other.id !== run.id ? Date.parse(other.started_at) : NaN;
      if (Number.isFinite(at) && at >= planAt && at < first)
        return no("plan déjà utilisé par un trajet précédent, non rattaché");
    }
  }
  return { ok: true, note: "" };
}

/**
 * The part of the plan that may be said about a run that is not over, each element only if the plan has it. The plan is
 * not checked against the journal (it names goods and places the journal does not): the caller says "d’après ton plan".
 * Nothing when `tradePlanAttached` says it is not this run's (with its note). The target price is a market price of the
 * plan, not the balance (a plan built from the balance never reaches here while the balance is hidden).
 * Returns { facts, note }.
 */
export function tradePlanFacts(L: any, plan: any, run: any, planAt: any, runs: any): any {
  const out: any = { facts: [], note: "" };
  if (!plan || typeof plan !== "object") return out;
  const att = tradePlanAttached(L, plan, run, planAt, runs);
  if (!att.ok) {
    out.note = att.note;
    return out;
  }
  const known = tradeRunNamed(run);
  const facts: string[] = out.facts;
  if (plan.commodity && !known) facts.push(plan.commodity);
  if (plan.buy_terminal && plan.sell_terminal)
    facts.push(plan.buy_terminal + " → " + plan.sell_terminal);
  else if (plan.buy_terminal || plan.sell_terminal)
    facts.push(plan.buy_terminal || plan.sell_terminal);
  if (plan.est_trip_minutes) facts.push("estimé " + plan.est_trip_minutes + "\u00a0min");
  if (typeof plan.sell_unit_price === "number")
    facts.push("vente visée " + L.fmtNum(Math.round(plan.sell_unit_price)) + "/SCU");
  return out;
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

/**
 * The compact line of the small view; "" when there is nothing to say. Amounts only with the balance.
 * A run under way says what the journal gives (the goods when named, the SCU, how long ago the first purchase was) and,
 * apart, what the plan says ("d’après ton plan": goods, route, estimated time, target price). Each element is there only
 * if its data exists; an id of the journal is never shown. `plan` is the plan already cleaned of what the balance
 * choice hides; `now` is the page's clock (ms); `extra` = { conn, planAt }: the connection state read from Game.log and when
 * this View received the plan. A run more than 3 hours old, or with the game not in a server session, is "non terminé":
 * only when its first purchase was, no trip under way, no plan.
 */
export function tradeInlineText(
  L: any,
  trade: any,
  showBalance: boolean,
  plan?: any,
  now?: any,
  extra?: any,
): string {
  if (!trade || trade.source !== "journal" || trade.runs.length === 0) return "";
  const r = trade.runs[0];
  const goods = tradeRunGoods(r) || "marchandise inconnue";
  // The run a destroyed ship interrupted is over, whatever its stage says.
  if (Array.isArray(trade.ship_losses) && trade.ship_losses.some((l: any) => l.run_id === r.id))
    return "Trajet interrompu · " + goods + " · vaisseau détruit";
  if (r.stage === "open" || r.stage === "partial") {
    const idle = tradeRunIdle(r, now, extra && extra.conn);
    const attached = idle
      ? { facts: [], note: "" }
      : tradePlanFacts(L, plan, r, extra && extra.planAt, trade.runs);
    // When the plan names the goods, the journal's "inconnue" would contradict it: the plan's name leads its own group.
    const planNamesGoods = !tradeRunNamed(r) && attached.facts.length > 0 && !!plan.commodity;
    const parts: string[] = [idle ? "Trajet non terminé" : "Trajet en cours"];
    if (!planNamesGoods) parts.push(goods);
    if (r.stage === "open") {
      if (r.scu_bought !== null) parts.push(L.fmtNum(r.scu_bought) + "\u00a0SCU achetés");
    } else if (r.scu_sold !== null && r.scu_bought !== null) {
      parts.push(L.fmtNum(r.scu_sold) + " / " + L.fmtNum(r.scu_bought) + "\u00a0SCU vendus");
    }
    const elapsed = tradeElapsed(r, now);
    const ago = idle ? tradeAgoLong(elapsed) : tradeAgo(elapsed);
    if (ago)
      parts.push(
        idle || r.stage === "partial" ? "premier achat il y a " + ago : "en route depuis " + ago,
      );
    if (attached.facts.length > 0) parts.push("d’après ton plan : " + attached.facts.join(", "));
    else if (attached.note) parts.push(attached.note);
    return parts.join(" · ");
  }
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
  return "";
}

/**
 * Is a trip under way, in the journal's own words: the newest run is open or partial and no ship loss ended it? (The line that
 * says where it goes is shown in full screen only for that case, when the page is in its flight order.)
 */
export function tradeIsUnderWay(trade: any): boolean {
  if (!trade || trade.source !== "journal" || !trade.runs || trade.runs.length === 0) return false;
  const r = trade.runs[0];
  if (Array.isArray(trade.ship_losses) && trade.ship_losses.some((l: any) => l.run_id === r.id))
    return false;
  return r.stage === "open" || r.stage === "partial";
}

/**
 * Builds the card and the compact line once; `render(ctx)` then only changes text, attributes and custom properties.
 * svgNs is the SVG namespace name, handed in by the View (one place names it).
 * ctx: { trade, plan, showBalance, fullscreen, balance, baseline, decomposition }
 *   trade    the normalised commerce section of the ledger (or null)
 *   plan     the cleaned plan (or null)
 *   balance  the poll's balance { delta, since } while shown (fallback when no trade journal exists)
 *   baseline where the balance change is counted from, in words
 *   decomposition the net taken apart change by change (movementsPanel.ts), or null
 */
export function tradePanel(doc: any, L: any, svgNs: string): any {
  const cfg = tradeConfig();
  const SVG = svgNs;
  const { el, add, setText, setAttr, setVar, show, setTip } = L.domKit(doc);
  const svg = (tag: string, attrs: any): any => {
    const n = doc.createElementNS(SVG, tag);
    for (const k of Object.keys(attrs)) n.setAttribute(k, String(attrs[k]));
    return n;
  };

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
  const warn = el("div", "tr-warn");
  const warnText = el("p", "tr-warn-text", "");
  // The account of the balance movements is one fold away: this opens it.
  // The arrow is a decoration (aria-hidden): the accessible name is "Détail" and aria-expanded says the rest.
  const warnMore = el("button", "btn mini", "");
  const warnCaret = el("span", "", " ▸");
  warnCaret.setAttribute("aria-hidden", "true");
  add(warnMore, el("span", "", "Détail"), warnCaret);
  warnMore.setAttribute("type", "button");
  warnMore.setAttribute("aria-controls", "mv");
  warnMore.setAttribute("aria-expanded", "false");
  let mvBlock: any = null;
  // The label and aria-expanded follow the block, whoever opened it (this button or the summary of the block).
  const syncMore = () => {
    const on = !!mvBlock && mvBlock.isOpen();
    setText(warnCaret, on ? " ▴" : " ▸");
    setAttr(warnMore, "aria-expanded", on ? "true" : "false");
  };
  warnMore.addEventListener("click", () => {
    if (!mvBlock) return;
    more.open = true;
    mvBlock.toggle();
    syncMore();
  });
  add(warn, warnText, warnMore);

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

  // ---- the last run known outside the play session (tradeSplitBySession): folded, calm, kept apart from the session's figures
  const last = el("details", "tr-last");
  last.setAttribute("data-hidden", "1");
  const lastSum = el("summary", "tr-last-sum", "");
  const lastBody = el("div", "tr-last-body");
  const lastFacts = el("p", "tr-last-facts", "");
  const lastMoney = el("p", "tr-last-money", "");
  const lastNote = el(
    "p",
    "note",
    "Ce trajet date d’avant cette session : il n’entre dans aucun chiffre de la session. Il vient du journal du jeu.",
  );
  add(lastBody, lastFacts, lastMoney, lastNote);
  add(last, lastSum, lastBody);

  add(root, head, message, hero, warn, slot, flow, duo, courseBox, last, more);

  // What the last render decided, for the page's fold bar (viewApp.ts): is the card on screen, and its one-line summary.
  let lastVisible = false;
  let lastSummary = "";

  function render(ctx: any) {
    // The runs of the journal that are not of the play session are set apart (tradeSplitBySession): the card, its figures
    // and its line speak of the session's own runs only; the older ones are "dernier trajet connu, hors session".
    const split = tradeSplitBySession(
      ctx && ctx.trade ? ctx.trade : null,
      ctx && ctx.scope,
      ctx && ctx.now,
    );
    const trade = split.trade;
    const pastRuns: any[] = split.past;
    const showBalance = !!(ctx && ctx.showBalance);
    // A plan built from the player's balance shows its quantity and profit only while the balance is shown.
    const plan = ctx && ctx.plan && !(ctx.plan.private === true && !showBalance) ? ctx.plan : null;
    const full = !!(ctx && ctx.fullscreen);
    mvBlock = ctx && ctx.movements ? ctx.movements : null;
    const run = trade && trade.runs && trade.runs.length > 0 ? trade.runs[0] : null;
    const m = run && showBalance ? run.money : null;

    // Full screen has the card; in its flight order the line of a trip under way stands above the instruments (the same text).
    const flightLine = full && !!(ctx && ctx.flightLine) && tradeIsUnderWay(trade);
    const inline =
      full && !flightLine
        ? ""
        : tradeInlineText(L, trade, showBalance, plan, ctx && ctx.now, {
            conn: ctx && ctx.conn,
            planAt: ctx && ctx.planAt,
          });
    // Nothing of the session to say: the compact view still tells that an older run exists, calmly, without any amount.
    const pastLine = !full && inline === "" ? tradePastLine(L, pastRuns, ctx && ctx.now) : "";
    setText(line, inline || pastLine);
    setAttr(line, "data-past", pastLine !== "" ? "1" : "0");
    show(line, inline !== "" || pastLine !== "");

    // The action bar (tradeActions.ts) needs the card even before there is a run or a plan to show.
    const bare = !run && !plan;
    const hasPast = pastRuns.length > 0;
    const visible = full && (!bare || hasPast || !!(ctx && ctx.actionsEnabled));
    show(root, visible);
    show(slot, visible && !!(ctx && ctx.actionsEnabled));
    lastVisible = visible;
    lastSummary = "";
    if (!visible) return;

    // The run a destroyed ship interrupted: it will not be finished, whatever the stage says ("rien vendu", "pas terminé").
    const lost =
      run && trade && Array.isArray(trade.ship_losses)
        ? trade.ship_losses.find((l: any) => l.run_id === run.id)
        : null;

    // ---- header
    // The header says the plan only if it may be this run's (the same rule as the compact line, tradePlanAttached), and a
    // run left behind (old, or the game not in a server session) is not a trip under way, so it has no plan either.
    const att =
      run && plan ? tradePlanAttached(L, plan, run, ctx && ctx.planAt, trade && trade.runs) : null;
    const left =
      !!run &&
      (run.stage === "open" || run.stage === "partial") &&
      tradeRunIdle(run, ctx && ctx.now, ctx && ctx.conn);
    const headPlan = plan && (!run || (att && att.ok && !left)) ? plan : null;
    const routeText = tradeRouteText(L, headPlan, run);
    setText(route, routeText);
    const metaParts: string[] = [];
    const scu =
      run && run.scu_bought !== null
        ? run.scu_bought
        : plan && typeof plan.scu === "number"
          ? plan.scu
          : null;
    if (scu !== null) metaParts.push(L.fmtNum(scu) + "\u00a0SCU");
    if (headPlan && headPlan.est_trip_minutes)
      metaParts.push("trajet estimé " + headPlan.est_trip_minutes + " min");
    // A run under way has no duration yet: what exists is the time since its first purchase (its last transaction is
    // only the latest purchase). The final duration is for a finished run; an interrupted one has neither.
    if (run && !lost) {
      if (run.stage === "open" || run.stage === "partial") {
        const idle = tradeRunIdle(run, ctx && ctx.now, ctx && ctx.conn);
        const elapsed = tradeElapsed(run, ctx && ctx.now);
        const ago = idle ? tradeAgoLong(elapsed) : tradeAgo(elapsed);
        if (ago) metaParts.push(idle ? "premier achat il y a " + ago : "en cours depuis " + ago);
      } else if (run.duration_ms > 0) {
        metaParts.push("durée " + L.formatDuration(run.duration_ms));
      }
    }
    if (run && run.failed > 0) metaParts.push(run.failed + " échec(s) non compté(s)");
    if (run && run.uncertain > 0)
      metaParts.push(run.uncertain + " ligne(s) non confirmée(s) non comptée(s)");
    if (headPlan && headPlan.safety_note) metaParts.push(headPlan.safety_note);
    if (headPlan && headPlan.note) metaParts.push(headPlan.note);
    if (att && !att.ok && att.note) metaParts.push(att.note);
    setText(meta, metaParts.join(" · "));
    const stageText = lost
      ? "Trajet interrompu"
      : run
        ? tradeStageLabel(run.stage)
        : plan
          ? "Plan seul"
          : "";
    setText(stage, stageText);
    // What the folded card says in one line (no amount: the stage and the route only).
    lastSummary = bare
      ? hasPast
        ? "aucun trajet dans cette session"
        : ""
      : [stageText, routeText].filter((t: string) => t !== "").join(" · ");
    show(stage, !bare);
    setAttr(stage, "data-stage", run ? run.stage : "plan");

    // ---- what is missing, said once and plainly
    let msg = "";
    if (!trade || trade.source !== "journal") {
      const st = ctx && ctx.ledgerStatus;
      msg =
        st === "loading"
          ? "Lecture du journal de jeu… le bilan réel du trajet apparaîtra ensuite."
          : "Journal du jeu non lisible : pas de bilan réel pour ce trajet (voir les réglages à faire en haut de la page).";
    } else if (!run) {
      msg = hasPast
        ? "Aucun trajet dans cette session pour l’instant : le bilan (chiffre d’affaires, frais, bénéfice net) apparaîtra après le premier trajet. Le dernier trajet connu est plus bas, hors session."
        : "Aucune transaction de marchandise dans le journal pour l’instant : le bilan (chiffre d’affaires, frais, bénéfice net) apparaîtra après le trajet.";
    } else if (!showBalance) {
      msg =
        "Le solde est masqué : les montants du bilan (chiffre d’affaires, frais, bénéfice net) apparaissent quand tu affiches le solde.";
    }
    // With the action bar alone (no run, no plan) there is no bilan to explain: the bar comes first and alone. An older run
    // outside the session is the exception: the card says plainly that the session has no trip yet.
    if (bare && !hasPast) msg = "";
    // The run a destroyed ship interrupted says so, with the cargo presumed lost (tradePreflight.ts words it). The alert box
    // above (fresh for 15 minutes) already says all of it: then the chip and the alert are the two places, not three.
    if (lost) {
      // The alert box holds the NEWER of the loss and a refused price, and only while the actions are on (a server that
      // answers): the sentence stays in the card unless the box really shows this loss.
      const shown =
        ctx && ctx.actionsEnabled && typeof ctx.now === "number"
          ? L.tradeAlertInfo(L, trade, ctx.now, showBalance)
          : null;
      const inAlert = !!shown && shown.loss === true;
      msg = inAlert
        ? msg
        : "Vaisseau détruit : trajet interrompu. " +
          L.tradeLossCargo(L, lost, showBalance) +
          (msg ? " " + msg : "");
    }
    setText(message, msg);
    show(message, msg !== "");

    // ---- headline tiles
    const net = m ? m.net : null;
    setText(tiles.turnover.label, "Chiffre d’affaires");
    setText(tiles.fees.label, "Frais");
    const tileValue = (
      t: any,
      text: string,
      tone: string,
      tag: string,
      estimate: boolean,
      sub: string,
    ) => {
      show(t.root, true);
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
        tileValue(
          tiles.net,
          "—",
          "",
          "inconnu",
          true,
          lost ? "Trajet interrompu : le vaisseau a été détruit." : tradeNetReason(net.reason),
        );
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
          // The balance movement block calls these fees "ambigu" when another possible cause sits in their window:
          // the tile says the same word instead of a plain "mesuré".
          ctx.decomposition && ctx.decomposition.fees_doubtful
            ? "ambigu"
            : tradeMethodLabel(m.fees.method),
          (ctx.decomposition && ctx.decomposition.fees_doubtful) || tradeIsEstimate(m.fees.method),
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
      // The player's own saved runs of this route or goods, when there are enough of them (calibrationPanel.ts).
      const calibrated =
        ctx && ctx.calibration ? L.calibrationNextTile(ctx.calibration, plan, m) : null;
      if (calibrated) {
        tileValue(
          tiles.next,
          "≈ " + tradeAmount(L, calibrated.auec, true),
          calibrated.auec >= 0 ? "ok" : "bad",
          calibrated.tag,
          true,
          calibrated.sub,
        );
        setTip(tiles.next.tag, calibrated.hint, true);
      } else if (next !== null && next !== undefined) {
        setTip(tiles.next.tag, "", true);
        tileValue(
          tiles.next,
          "≈ " + tradeAmount(L, next, true),
          next >= 0 ? "ok" : "bad",
          "estimé",
          true,
          m.planned_net
            ? "bénéfice prévu − frais au taux " +
                (m.planned_net.rate_from === "trajet_precedent"
                  ? "du trajet précédent"
                  : "observé") +
                " (" +
                tradePct(L, m.planned_net.fee_rate) +
                ")"
            : "même résultat que ce trajet",
        );
      } else {
        setTip(tiles.next.tag, "", true);
        tileValue(tiles.next, "—", "", "", false, "il faut un plan et des frais observés");
      }
    } else {
      // Nothing measured yet (no run, or the balance is hidden): no wall of dashes, only what exists is drawn.
      for (const k of ["net", "turnover", "fees", "next"]) show(tiles[k].root, false);
      setTip(tiles.next.tag, "", true);
      if (plan && typeof plan.expected_profit_auec === "number") {
        setText(tiles.turnover.label, "Bénéfice prévu");
        tileValue(
          tiles.turnover,
          tradeAmount(L, plan.expected_profit_auec, true),
          "",
          "plan",
          false,
          "marge du plan, avant frais",
        );
      }
      // No journal: the balance change, called by its name.
      if (plan && (!trade || trade.source !== "journal") && showBalance && ctx.balance) {
        const bal = ctx.balance;
        if (typeof bal.delta === "number") {
          setText(tiles.fees.label, "Variation du solde");
          tileValue(
            tiles.fees,
            tradeAmount(L, bal.delta, true),
            "",
            "",
            false,
            (ctx.baseline || "") + " · pas un bénéfice : tout est mêlé",
          );
        }
      }
    }
    const shownTiles = ["net", "turnover", "fees", "next"].filter(
      (k) => tiles[k].root["_a_data-hidden"] !== "1",
    ).length;
    show(hero, !bare && shownTiles > 0);

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
      // Fees measured next to another possible cause carry the same word here as in the movements block.
      const doubtRow = row.id === "fees" && !!ctx.decomposition && ctx.decomposition.fees_doubtful;
      setText(r.tag, doubtRow ? "ambigu" : row.tag);
      setAttr(r.tag, "data-estimate", row.estimate || doubtRow ? "1" : "0");
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
      // The net is taken apart change by change (movementsPanel.ts / balanceMovements.ts): say what it is made of.
      warns.push(
        ctx.decomposition
          ? L.movementsWarningText(L, ctx.decomposition)
          : "Le solde a bougé de " +
              tradeAmount(L, Math.abs(m.fees.unexplained)) +
              " de plus que la marge brute et les frais ne l’expliquent : ce n’est pas le bénéfice de ce trajet seul.",
      );
    // Fees measured in a window that also holds another possible cause (a shop item, a contract reward, an insurance or
    // hangar cost): the "mesuré" tag stays, but the card must say they may include it, whatever the size of the gap.
    const dec = ctx.decomposition;
    if (dec && dec.fees_doubtful && warns.join(" ").indexOf(L.movementsWarningText(L, dec)) < 0)
      warns.push(
        "Les frais mesurés tombent dans une fenêtre qui contient aussi une autre cause possible (achat d’objet, récompense ou assurance) : ils peuvent l’inclure.",
      );
    if (dec && dec.unmatched_transactions > 0 && m && m.fees.total !== null)
      warns.push(
        dec.unmatched_transactions +
          " ligne(s) du journal n’ont trouvé aucun mouvement du solde correspondant : les frais mesurés sont à lire avec prudence.",
      );
    setText(warnText, warns.length ? "Attention : " + warns.join(" ") : "");
    show(warn, warns.length > 0);
    show(warnMore, !!dec);
    syncMore();

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
            : "estimé, flux interrompu ou fenêtre illisible : marge brute − bénéfice net, sans détail par côté. Ce chiffre peut contenir une autre dépense : il ne sert ni au calibrage ni au taux du trajet suivant",
        );
        setAttr(feeRows[2].root, "data-estimate", tradeIsEstimate(fm.method) ? "1" : "0");
      }
      let fn = "";
      // A reason (another movement, earlier stock, unconfirmed lines) is already said by the tile and the warning above.
      if (fm.total === null) {
        fn = fm.reason
          ? ""
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

    // ---- the last run known outside the session: folded, calm, no amount until it is opened
    const older = hasPast ? pastRuns[0] : null;
    show(last, !!older);
    if (older) {
      setText(lastSum, tradePastLabel(older, ctx && ctx.now));
      setText(lastFacts, tradePastFacts(L, older));
      const om = showBalance ? older.money : null;
      const money: string[] = [];
      if (om) {
        if (om.turnover !== null) money.push("Chiffre d’affaires " + tradeAmount(L, om.turnover));
        money.push(
          om.net.auec !== null
            ? "Bénéfice net " +
                tradeAmount(L, om.net.auec, true) +
                " (" +
                tradeMethodLabel(om.net.method) +
                ")"
            : "Bénéfice net inconnu",
        );
      } else if (!showBalance) money.push("Montants masqués.");
      setText(lastMoney, money.join(" · "));
      show(lastMoney, money.length > 0);
    }

    // ---- folded details
    const earlierRuns: any[] = (trade && trade.runs ? trade.runs.slice(1) : []).concat(
      pastRuns.slice(1),
    );
    const moreOn = (!!trade && trade.source === "journal" && !!run) || earlierRuns.length > 0;
    show(more, moreOn || !!pj);
    const list: string[] = pj && pj.assumptions ? pj.assumptions : [];
    show(assumptionsTitle, list.length > 0);
    show(assumptions, list.length > 0);
    for (let i = 0; i < assumptionItems.length; i++) {
      show(assumptionItems[i], i < list.length);
      setText(assumptionItems[i], list[i] || "");
    }
    show(historyTitle, earlierRuns.length > 0);
    show(history, earlierRuns.length > 0);
    for (let i = 0; i < historyItems.length; i++) {
      const r = earlierRuns[i];
      show(historyItems[i], !!r);
      if (!r) continue;
      const bits = [
        (tradeRunGoods(r) || "marchandise") + " · " + tradeStageLabel(r.stage).toLowerCase(),
      ];
      // A run of an older session: said, with its date, so that it never reads as a result of this one.
      if (pastRuns.indexOf(r) >= 0)
        bits.push("hors session, " + tradeWhen(r.ended_at, ctx && ctx.now));
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
  }

  // `more` is the body of the folded details: blocks of other modules (the balance movements) are added to it.
  return {
    line,
    card: root,
    slot,
    more: moreBody,
    render,
    visible: () => lastVisible,
    summary: () => lastSummary,
  };
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
  tradeIsGoodsId,
  tradeGoodsLabel,
  tradeRunGoods,
  tradeRunNamed,
  tradeRouteText,
  tradeAgo,
  tradeElapsed,
  tradeAgoLong,
  tradeRunIdle,
  tradeWhen,
  tradeSplitBySession,
  tradeSessionScope,
  tradePastLabel,
  tradePastFacts,
  tradePastLine,
  tradeShopContradicts,
  tradeIsUnderWay,
  tradePlanAttached,
  tradePlanFacts,
  tradeWaterfall,
  tradeWaterfallLayout,
  tradeCourse,
  tradeCoursePoints,
  tradeLevelY,
  tradeInlineText,
  tradePanel,
];
