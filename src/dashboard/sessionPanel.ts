/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The session bar of the live dashboard View ("Session"): pure display logic and the DOM of one compact bar plus a
 * menu of past sessions. Shipped inside the page by page.ts next to the functions of viewLogic.ts, with the same
 * rules (they are serialised with Function.prototype.toString):
 *   - only function declarations, no imports, no module-level values (a function may call another one of this file);
 *   - the formatters of viewLogic.ts (fmtAuec, formatDuration) arrive through the `L` argument;
 *   - text reaches the DOM only through textContent.
 *
 * The data live on the SERVER (the session file, providers/sessions): two Views of two conversations show the same
 * session. The bar arrives in the poll (`sessions`); the list of past sessions, their statistics and one session's
 * detail are asked for by tool calls, only when the player opens the menu. Nothing is kept in the browser's storage.
 *
 * Money: every aUEC figure exists in the data only when the View asked for the balance, and the functions below also
 * drop it when `allowMoney` is false, so a hidden balance is never drawn even if a stale answer still holds it.
 * Nothing here invents a figure: an unknown value is shown as a dash, never as zero.
 */

export function sessionConfig() {
  return {
    maxRows: 30,
    maxTrips: 10,
    maxInterruptions: 5,
    maxRoutes: 3,
    textMax: 80,
    noteMax: 500,
  };
}

/** One text from the data: invisible characters out, one line, capped. The server did it already; so does the View. */
export function sessionText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const clean = value
    .replace(/[\p{Cf}\p{Cc}\p{Co}\p{Cn}\p{Cs}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(clean).slice(0, max).join("");
}

function sessionNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sessionIso(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function sessionCount(value: unknown, max: number): number {
  const n = sessionNum(value);
  return n === null ? 0 : Math.max(0, Math.min(max, Math.floor(n)));
}

/** The money of one session, rebuilt field by field. Null when absent, withheld, or not allowed. */
function sessionMoney(raw: any, allowMoney: boolean): any {
  if (!allowMoney || !raw || typeof raw !== "object") return null;
  const best = raw.best_trip && typeof raw.best_trip === "object" ? raw.best_trip : null;
  const plan = raw.plan && typeof raw.plan === "object" ? raw.plan : null;
  const qualities = ["game_start", "first_seen", "new_session", "late"];
  return {
    start_balance_auec: sessionNum(raw.start_balance_auec),
    start_balance_quality:
      qualities.indexOf(raw.start_balance_quality) >= 0 ? raw.start_balance_quality : null,
    last_balance_auec: sessionNum(raw.last_balance_auec),
    balance_change_auec: sessionNum(raw.balance_change_auec),
    net_auec: sessionNum(raw.net_auec),
    net_source: raw.net_source === "trips" || raw.net_source === "balance" ? raw.net_source : null,
    net_complete: typeof raw.net_complete === "boolean" ? raw.net_complete : null,
    turnover_auec: sessionNum(raw.turnover_auec),
    cost_auec: sessionNum(raw.cost_auec),
    fees_auec: sessionNum(raw.fees_auec),
    net_per_hour_auec: sessionNum(raw.net_per_hour_auec),
    avg_trip_net_auec: sessionNum(raw.avg_trip_net_auec),
    best_trip:
      best && sessionNum(best.net_auec) !== null
        ? {
            label: sessionText(best.label, 80),
            commodity: sessionText(best.commodity, 60),
            net_auec: sessionNum(best.net_auec),
            gross: best.gross === true,
          }
        : null,
    gross_margin_auec: sessionNum(raw.gross_margin_auec),
    measured_net_auec: sessionNum(raw.measured_net_auec),
    gross_only_trips: sessionCount(raw.gross_only_trips, 99999),
    overlap_excluded: sessionCount(raw.overlap_excluded, 99999),
    plan: plan
      ? {
          planned_auec: sessionNum(plan.planned_auec),
          measured_auec: sessionNum(plan.measured_auec),
          efficiency: sessionNum(plan.efficiency),
          trips: sessionCount(plan.trips, 9999),
        }
      : null,
  };
}

/** One session summary, rebuilt field by field; null when it is not one. */
export function sessionSummaryNormalize(raw: any, allowMoney: boolean): any {
  if (!raw || typeof raw !== "object" || typeof raw.number !== "number") return null;
  const startedAt = sessionIso(raw.started_at);
  if (!startedAt) return null;
  const channels = ["live", "ptu", "unknown"];
  return {
    id: typeof raw.id === "string" && /^[0-9a-z_]{4,48}$/.test(raw.id) ? raw.id : "",
    number: sessionCount(raw.number, 999999),
    status: raw.status === "ended" ? "ended" : "open",
    end_reason:
      ["manual", "new_session", "gap"].indexOf(raw.end_reason) >= 0 ? raw.end_reason : null,
    started_at: startedAt,
    ended_at: sessionIso(raw.ended_at),
    last_activity_at: sessionIso(raw.last_activity_at),
    duration_ms: sessionNum(raw.duration_ms),
    active_ms: sessionNum(raw.active_ms) || 0,
    interruptions: sessionCount(raw.interruptions, 999),
    game_version: sessionText(raw.game_version, 40),
    game_channel: channels.indexOf(raw.game_channel) >= 0 ? raw.game_channel : null,
    trips: sessionCount(raw.trips, 99999),
    contracts: sessionCount(raw.contracts, 99999),
    trips_with_net: sessionCount(raw.trips_with_net, 99999),
    trips_per_hour: sessionNum(raw.trips_per_hour),
    minutes_per_trip: sessionNum(raw.minutes_per_trip),
    last_location: sessionText(raw.last_location, 60),
    last_commodity: sessionText(raw.last_commodity, 60),
    note: sessionText(raw.note, 500),
    money: sessionMoney(raw.money, allowMoney),
  };
}

/** The bar of the poll, rebuilt; null when absent or not a bar. */
export function sessionBarNormalize(raw: any, allowMoney: boolean): any {
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  const statuses = ["ok", "off", "readonly", "degraded"];
  return {
    v: 1,
    status: statuses.indexOf(raw.status) >= 0 ? raw.status : "off",
    notice: sessionText(raw.notice, 200) || null,
    gap_hours: sessionNum(raw.gap_hours) || 3,
    stale: raw.stale === true,
    current: sessionSummaryNormalize(raw.current, allowMoney),
  };
}

/** What the channel between Views may carry and accept: the bar rebuilt and stripped of every aUEC figure. */
export function sessionChannelClean(raw: any): any {
  const bar = sessionBarNormalize(raw, false);
  if (!bar) return null;
  if (bar.current) bar.current.money = "withheld";
  return bar;
}

/** The raw bar without any aUEC figure (used when the player hides the balance again, and before sharing). */
export function sessionBarStripBalance(raw: any): any {
  if (!raw || typeof raw !== "object") return raw;
  const out: any = Object.assign({}, raw);
  if (raw.current && typeof raw.current === "object") {
    out.current = Object.assign({}, raw.current, { money: "withheld" });
  }
  return out;
}

/** "aujourd’hui 19:42", "hier 19:42", "03/11 19:42"; "" for anything that is not a date. */
export function sessionWhen(iso: any, now: number): string {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const two = (n: number) => (n < 10 ? "0" + n : String(n));
  const d = new Date(t);
  const today = new Date(now);
  const clock = two(d.getHours()) + ":" + two(d.getMinutes());
  const day = (x: Date) => x.getFullYear() * 10000 + x.getMonth() * 100 + x.getDate();
  if (day(d) === day(today)) return "aujourd’hui " + clock;
  const yesterday = new Date(now - 86400000);
  if (day(d) === day(yesterday)) return "hier " + clock;
  return two(d.getDate()) + "/" + two(d.getMonth() + 1) + " " + clock;
}

export function sessionStateLabel(cur: any, stale: boolean): string {
  if (!cur) return "";
  if (cur.status === "ended") return "terminée";
  return stale ? "inactive" : "en cours";
}

/** The three words of a break: the game closed itself, or no end marker was left. */
export function sessionInterruptionLabel(kind: string): string {
  return kind === "game_closed"
    ? "jeu fermé normalement"
    : "sans marqueur de fin (plantage, redémarrage du PC ou serveur arrêté)";
}

export function sessionQualityLabel(q: any): string {
  const labels: any = {
    game_start: "relevé dès le démarrage du jeu",
    first_seen: "premier solde vu par le serveur (le jeu tournait déjà)",
    new_session: "relevé au moment de la nouvelle session",
    late: "relevé longtemps après le début de la session",
  };
  return labels[q] || "";
}

/**
 * What the bar shows, as plain data. `kpis` come in the order the player wants them: the result first when the balance
 * is shown, else the trips and the playing time.
 */
export function sessionBarInfo(L: any, bar: any, ctx: any): any {
  const now = ctx && typeof ctx.now === "number" ? ctx.now : 0;
  const showBalance = !!(ctx && ctx.showBalance);
  if (!bar || bar.status === "off") return { visible: false };
  const cur = bar.current;
  const notice = bar.status === "readonly" || bar.status === "degraded" ? bar.notice || "" : "";
  if (!cur) {
    return {
      visible: true,
      empty: true,
      title: "Aucune session",
      chip: "",
      sub: "Elle démarre quand le jeu est détecté, ou avec « Nouvelle session ».",
      kpis: [],
      notes: notice ? [notice] : [],
      canEnd: false,
      stale: false,
    };
  }
  const money = showBalance ? cur.money : null;
  const hasMoney = !!money && typeof money === "object";
  const sub: string[] = [];
  const when = sessionWhen(cur.started_at, now);
  if (when) sub.push("depuis " + when);
  if (cur.active_ms > 0) sub.push(L.formatDuration(cur.active_ms) + " de jeu");
  if (cur.game_version) sub.push("jeu " + cur.game_version);
  const kpis: any[] = [];
  const trips = {
    id: "trips",
    label: "Trajets",
    value: String(cur.trips),
    sub:
      cur.contracts > 0
        ? "+ " + cur.contracts + (cur.contracts > 1 ? " autres contrats" : " autre contrat")
        : cur.trips_per_hour !== null
          ? cur.trips_per_hour + " par heure"
          : "",
    tone: "",
  };
  const play = {
    id: "time",
    label: "Temps de jeu",
    value: cur.active_ms > 0 ? L.formatDuration(cur.active_ms) : "—",
    sub: cur.minutes_per_trip !== null ? "≈\u00a0" + cur.minutes_per_trip + " min par trajet" : "",
    tone: "",
  };
  if (hasMoney) {
    // ONE basis (the sum of each trip's result, else the balance change); the parts are named in the small line.
    const net = money.net_auec;
    const grossOnly = money.net_source === "trips" && money.measured_net_auec === null;
    const parts: string[] = [];
    if (money.net_source === "trips" && money.gross_only_trips > 0 && !grossOnly)
      parts.push(money.gross_only_trips + " en marge brute, hors frais");
    const overlapNote =
      money.overlap_excluded > 0
        ? "total partiel : " +
          money.overlap_excluded +
          " contrat(s) non compté(s) (chevauche(nt) une cargaison, déjà comptée)"
        : "";
    if (overlapNote) parts.push(overlapNote);
    kpis.push({
      id: "net",
      label:
        money.net_source === "balance"
          ? "Variation du solde"
          : grossOnly
            ? "Marge brute des cargaisons"
            : "Résultat des trajets",
      value: net === null ? "—" : L.fmtAuec(net, true) + "\u00a0aUEC",
      sub:
        net === null
          ? "inconnu pour l’instant"
          : grossOnly
            ? "revenu − coût, hors frais" + (overlapNote ? " · " + overlapNote : "")
            : parts.length > 0
              ? parts.join(" · ")
              : money.net_source === "trips" && money.net_complete === false
                ? "partiel : " +
                  cur.trips_with_net +
                  " résultat(s) connu(s) sur " +
                  (cur.trips + cur.contracts)
                : "mesure brute (achats et amendes inclus)",
      tone: net === null ? "" : net < 0 ? "warn" : "ok",
    });
    kpis.push({
      id: "rate",
      label: "Par heure",
      value:
        money.net_per_hour_auec === null
          ? "—"
          : L.fmtAuec(money.net_per_hour_auec, true) + "\u00a0aUEC/h",
      sub: money.net_per_hour_auec === null ? "dès 10 min de jeu" : "sur le temps de jeu",
      tone: money.net_per_hour_auec === null ? "" : money.net_per_hour_auec < 0 ? "warn" : "ok",
    });
    kpis.push(trips);
    kpis.push(play);
  } else {
    kpis.push(trips);
    kpis.push(play);
    kpis.push({
      id: "net",
      label: "Gain",
      value: "masqué",
      sub: "Afficher le solde pour le voir",
      tone: "",
    });
  }
  const notes: string[] = [];
  if (bar.stale)
    notes.push(
      "Aucune activité depuis plus de " +
        bar.gap_hours +
        " h : la prochaine partie démarrera une nouvelle session.",
    );
  if (cur.interruptions > 0)
    notes.push(
      "Reprise après " +
        cur.interruptions +
        (cur.interruptions > 1 ? " coupures" : " coupure") +
        " (voir le détail).",
    );
  if (hasMoney && money.start_balance_quality && money.start_balance_quality !== "game_start")
    notes.push("Solde de départ : " + sessionQualityLabel(money.start_balance_quality) + ".");
  if (notice) notes.push(notice);
  return {
    visible: true,
    empty: false,
    title: "Session " + cur.number,
    chip: sessionStateLabel(cur, bar.stale),
    chipState: cur.status === "ended" ? "ended" : bar.stale ? "stale" : "open",
    sub: sub.join(" · "),
    kpis,
    notes,
    canEnd: cur.status === "open",
    stale: !!bar.stale,
  };
}

/** One row of the list of past sessions. */
export function sessionRowInfo(L: any, s: any, showBalance: boolean, now: number): any {
  const parts: string[] = [];
  parts.push(s.trips + (s.trips > 1 ? " trajets" : " trajet"));
  if (s.active_ms > 0) parts.push(L.formatDuration(s.active_ms));
  const m = showBalance && s.money && typeof s.money === "object" ? s.money : null;
  let result = "";
  if (m && m.net_auec !== null) {
    result = L.fmtAuec(m.net_auec, true) + "\u00a0aUEC";
    if (m.net_per_hour_auec !== null) result += " (" + L.fmtAuec(m.net_per_hour_auec, true) + "/h)";
  }
  return {
    number: "N°\u00a0" + s.number,
    when: sessionWhen(s.started_at, now),
    detail: parts.join(" · "),
    result,
    tone: m && m.net_auec !== null ? (m.net_auec < 0 ? "warn" : "ok") : "",
    open: s.status === "open",
  };
}

/** The list answer of sc_session_list, rebuilt. */
export function sessionListNormalize(raw: any, allowMoney: boolean): any {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.sessions)) return null;
  const cfg = sessionConfig();
  return {
    total: sessionCount(raw.total, 999999),
    sessions: raw.sessions
      .slice(0, cfg.maxRows)
      .map((s: any) => sessionSummaryNormalize(s, allowMoney))
      .filter((s: any) => s),
  };
}

function sessionAggregateSession(s: any): any {
  if (!s || typeof s !== "object") return null;
  return {
    number: sessionCount(s.number, 999999),
    net_per_hour_auec: sessionNum(s.net_per_hour_auec),
    net_auec: sessionNum(s.net_auec),
  };
}

/** The statistics answer of sc_session_stats, rebuilt. */
export function sessionStatsNormalize(raw: any, allowMoney: boolean): any {
  if (!raw || typeof raw !== "object" || typeof raw.sessions !== "number") return null;
  const cfg = sessionConfig();
  const m = allowMoney && raw.money && typeof raw.money === "object" ? raw.money : null;
  const trend = m && m.trend && typeof m.trend === "object" ? m.trend : null;
  return {
    sessions: sessionCount(raw.sessions, 999999),
    trips: sessionCount(raw.trips, 999999),
    contracts: sessionCount(raw.contracts, 999999),
    active_ms: sessionNum(raw.active_ms) || 0,
    trips_per_hour: sessionNum(raw.trips_per_hour),
    money: m
      ? {
          net_auec: sessionNum(m.net_auec),
          avg_net_per_hour_auec: sessionNum(m.avg_net_per_hour_auec),
          avg_net_per_session_auec: sessionNum(m.avg_net_per_session_auec),
          sessions_with_net: sessionCount(m.sessions_with_net, 999999),
          best_session: sessionAggregateSession(m.best_session),
          worst_session: sessionAggregateSession(m.worst_session),
          trend:
            trend && ["up", "down", "flat"].indexOf(trend.direction) >= 0
              ? {
                  direction: trend.direction,
                  recent_per_hour_auec: sessionNum(trend.recent_per_hour_auec),
                  previous_per_hour_auec: sessionNum(trend.previous_per_hour_auec),
                }
              : null,
          plan:
            m.plan && typeof m.plan === "object"
              ? {
                  efficiency: sessionNum(m.plan.efficiency),
                  trips: sessionCount(m.plan.trips, 99999),
                }
              : null,
          best_routes: (Array.isArray(m.best_routes) ? m.best_routes : [])
            .slice(0, cfg.maxRoutes)
            .filter((r: any) => r && typeof r === "object")
            .map((r: any) => ({
              commodity: sessionText(r.commodity, 60),
              buy_terminal: sessionText(r.buy_terminal, 60),
              sell_terminal: sessionText(r.sell_terminal, 60),
              trips: sessionCount(r.trips, 99999),
              avg_net_auec: sessionNum(r.avg_net_auec),
            })),
        }
      : null,
  };
}

/** The detail answer of sc_session_current (for one session), rebuilt. */
export function sessionDetailNormalize(raw: any, allowMoney: boolean): any {
  if (!raw || typeof raw !== "object") return null;
  const cfg = sessionConfig();
  const session = sessionSummaryNormalize(raw.session, allowMoney);
  if (!session) return null;
  return {
    session,
    trips: (Array.isArray(raw.recent_trips) ? raw.recent_trips : [])
      .slice(-cfg.maxTrips)
      .filter((t: any) => t && typeof t === "object")
      .map((t: any) => ({
        ended_at: sessionIso(t.ended_at),
        label: sessionText(t.label, 80),
        commodity: sessionText(t.commodity, 60),
        buy_terminal: sessionText(t.buy_terminal, 60),
        sell_terminal: sessionText(t.sell_terminal, 60),
        net_auec: allowMoney ? sessionNum(t.net_auec) : null,
      })),
    interruptions: (Array.isArray(raw.interruptions) ? raw.interruptions : [])
      .slice(-cfg.maxInterruptions)
      .filter((i: any) => i && typeof i === "object")
      .map((i: any) => ({
        from: sessionIso(i.from),
        to: sessionIso(i.to),
        kind: i.kind === "game_closed" ? "game_closed" : "unclean",
      })),
  };
}

/**
 * Text of a report the View is about to copy or save: the server cleaned it already; the View removes again what must never
 * reach a clipboard or a file (control, invisible and direction-changing characters, but not the line breaks), and bounds it.
 */
export function sessionExportText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const clean = value.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, (c) =>
    c === "\n" || c === "\r" || c === "\t" ? c : "",
  );
  return clean.length > max ? clean.slice(0, max) : clean;
}

/**
 * The answer of sc_session_export (the dashboard's own tool), rebuilt: two bounded strings and the choices it was made with. Dropped (null) when it
 * holds amounts the View was not allowed to draw, or the balances although they were not asked for.
 */
export function sessionDebriefNormalize(
  raw: any,
  allowMoney: boolean,
  allowBalances: boolean,
  kind: string,
): any {
  const field = kind === "csv" ? raw && raw.csv : raw && raw.markdown;
  if (!raw || typeof raw !== "object" || typeof field !== "string") return null;
  if (raw.money_included === true && !allowMoney) return null;
  if (raw.balances_included === true && !(allowMoney && allowBalances)) return null;
  const text = sessionExportText(field, 200000);
  if (!text) return null;
  return {
    text,
    money: raw.money_included === true,
    balances: raw.balances_included === true,
    truncated: raw.truncated === true,
    tripsTotal: sessionCount(raw.trips_total, 999999),
  };
}

/** Builds the bar and its menu once; `render(bar, ctx)` then only changes text and attributes. */
export function sessionPanel(doc: any, L: any, api: any): any {
  const cfg = sessionConfig();
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
  const show = (n: any, on: boolean) => setAttr(n, "data-hidden", on ? "0" : "1");
  const button = (label: string, onClick: () => void, cls?: string): any => {
    const b = el("button", "btn" + (cls ? " " + cls : ""), label);
    b.setAttribute("type", "button");
    b.addEventListener("click", onClick);
    return b;
  };

  // ------------------------------------------------------------------------------ the bar
  const root = el("section", "ses");
  root.setAttribute("aria-label", "Session");
  const bar = el("div", "ses-bar");
  const id = el("div", "ses-id");
  const title = el("span", "ses-title", "Session");
  const chip = el("span", "ses-chip", "");
  const sub = el("span", "ses-sub", "");
  add(id, el("div", "ses-line", ""), sub);
  add(id.firstChild, title, chip);
  const kpiBox = el("div", "ses-kpis");
  const kpis: any[] = [];
  for (let i = 0; i < 4; i++) {
    const k = el("div", "ses-kpi");
    k.label = el("span", "ses-k-label", "");
    k.value = el("span", "ses-k-value", "");
    k.sub = el("span", "ses-k-sub", "");
    add(k, k.label, k.value, k.sub);
    kpis.push(k);
    add(kpiBox, k);
  }
  const actions = el("div", "ses-actions");
  const btnNew = button("Nouvelle session", () => onNew(), "small primary");
  const btnMenu = button("Sessions", () => toggleMenu(), "small");
  btnMenu.setAttribute("aria-expanded", "false");
  const btnBalance = button("Afficher le solde", () => api.toggleBalance(), "small");
  add(actions, btnBalance, btnMenu, btnNew);
  add(bar, id, kpiBox, actions);
  const notes = el("div", "ses-notes");
  const noteEls: any[] = [];
  for (let i = 0; i < 4; i++) {
    const p = el("p", "ses-note", "");
    noteEls.push(p);
    add(notes, p);
  }

  // ------------------------------------------------------------------------------ the menu
  const menu = el("div", "ses-menu");
  const menuHead = el("div", "ses-menu-head");
  const menuTitle = el("h3", "ses-menu-title", "Sessions passées");
  const btnEnd = button("Terminer la session", () => onEnd(), "mini");
  const btnClose = button("Fermer", () => closeMenu(), "mini");
  add(menuHead, menuTitle, btnEnd, btnClose);
  const menuMsg = el("p", "ses-note", "");
  const stats = el("div", "ses-stats");
  const statEls: any[] = [];
  for (let i = 0; i < 6; i++) {
    const s = el("p", "ses-stat", "");
    statEls.push(s);
    add(stats, s);
  }
  const list = el("div", "ses-list");
  const rows: any[] = [];
  for (let i = 0; i < cfg.maxRows; i++) {
    const r = el("button", "ses-row");
    r.setAttribute("type", "button");
    r.setAttribute("aria-label", "Ouvrir cette session");
    r.n = el("span", "ses-r-n", "");
    r.when = el("span", "ses-r-when", "");
    r.detail = el("span", "ses-r-detail", "");
    r.result = el("span", "ses-r-result", "");
    add(r, r.n, r.when, r.detail, r.result);
    r.addEventListener("click", () => openDetail(r._id));
    rows.push(r);
    add(list, r);
  }
  const detail = el("div", "ses-detail");
  const detailHead = el("div", "ses-detail-head");
  const detailTitle = el("h3", "ses-menu-title", "");
  const btnBack = button("Retour à la liste", () => backToList(), "mini");
  add(detailHead, detailTitle, btnBack);
  const facts = el("div", "ses-facts");
  const factEls: any[] = [];
  for (let i = 0; i < 9; i++) {
    const f = el("p", "ses-fact", "");
    factEls.push(f);
    add(facts, f);
  }
  const tripsTitle = el("p", "ses-sub-title", "Derniers trajets");
  const tripList = el("ul", "ses-trips");
  const tripEls: any[] = [];
  for (let i = 0; i < cfg.maxTrips; i++) {
    const li = el("li", "ses-trip", "");
    tripEls.push(li);
    add(tripList, li);
  }
  const breaksList = el("ul", "ses-trips");
  const breakEls: any[] = [];
  for (let i = 0; i < cfg.maxInterruptions; i++) {
    const li = el("li", "ses-trip", "");
    breakEls.push(li);
    add(breaksList, li);
  }
  const breaksTitle = el("p", "ses-sub-title", "Coupures");

  // The report to take out: copy first (the clipboard may be refused in the host's sandbox: then the text is shown
  // selected), a file only when the page can make one (and the host may still refuse it).
  const exportBox = el("div", "ses-export");
  const exportRow = el("div", "ses-export-row");
  const btnCopy = button("Copier le bilan", () => void onExport("copy"), "mini");
  const btnMd = button("Télécharger .md", () => void onExport("md"), "mini");
  const btnCsv = button("Télécharger .csv", () => void onExport("csv"), "mini");
  const btnCsvFr = button("Télécharger .csv (Excel FR)", () => void onExport("csvfr"), "mini");
  const btnBalances = button("Soldes de départ et final : non", () => onToggleBalances(), "mini");
  add(exportRow, btnCopy, btnMd, btnCsv, btnCsvFr, btnBalances);
  const exportHint = el("p", "ses-note", "");
  const exportMsg = el("p", "ses-note", "");
  exportMsg.setAttribute("role", "status");
  const exportPre = el("pre", "ses-export-pre", "");
  exportPre.setAttribute("aria-label", "Texte du bilan");
  add(exportBox, exportRow, exportHint, exportMsg, exportPre);
  add(detail, detailHead, exportBox, facts, tripsTitle, tripList, breaksTitle, breaksList);
  add(menu, menuHead, menuMsg, stats, list, detail);
  add(root, bar, notes, menu);

  // ------------------------------------------------------------------------------ state
  const st: any = {
    open: false,
    view: "list", // "list" | "detail"
    ctx: { showBalance: false, now: 0 },
    asked: null, // the balance choice the menu data was fetched with
    loading: false,
    error: "",
    list: null,
    stats: null,
    detail: null,
    confirmNew: false,
    confirmEnd: false,
    timer: null,
    token: 0,
    // The report to take out: never kept across a change of the balance choice, never stored, never sent anywhere.
    exportText: null, // the text shown for hand copying, or null
    exportMsg: "",
    exportMoney: false, // the balance choice the text was made with
    exportBalances: false, // the player asked for the start and last balance (per use, never remembered)
    exportToken: 0,
  };

  /** The confirmation goes to the View's own polite message area (the same one every action uses). */
  function say(text: string) {
    if (api.say) api.say(text);
  }

  function resetConfirm() {
    st.confirmNew = false;
    st.confirmEnd = false;
  }

  async function onNew() {
    if (!st.confirmNew) {
      resetConfirm();
      st.confirmNew = true;
      renderButtons();
      if (st.timer !== null) api.clearTimeout(st.timer);
      st.timer = api.setTimeout(() => {
        st.timer = null;
        st.confirmNew = false;
        renderButtons();
      }, 5000);
      return;
    }
    resetConfirm();
    renderButtons();
    try {
      const r = await api.call("sc_session_new", {});
      say(
        r && typeof r.message === "string"
          ? sessionText(r.message, 120)
          : "Nouvelle session démarrée.",
      );
      st.asked = null;
      if (api.refresh) await api.refresh();
      if (st.open) await loadMenu();
    } catch (err: any) {
      say(
        "Nouvelle session impossible : " +
          sessionText(err && err.message ? err.message : "erreur", 100),
      );
    }
  }

  async function onEnd() {
    if (!st.confirmEnd) {
      resetConfirm();
      st.confirmEnd = true;
      renderButtons();
      return;
    }
    resetConfirm();
    renderButtons();
    try {
      const r = await api.call("sc_session_end", {});
      say(r && typeof r.message === "string" ? sessionText(r.message, 120) : "Session terminée.");
      st.asked = null;
      if (api.refresh) await api.refresh();
      if (st.open) await loadMenu();
    } catch (err: any) {
      say(
        "Fin de session impossible : " +
          sessionText(err && err.message ? err.message : "erreur", 100),
      );
    }
  }

  function toggleMenu() {
    if (st.open) closeMenu();
    else openMenu();
  }

  function openMenu() {
    st.open = true;
    st.view = "list";
    renderMenu();
    void loadMenu();
  }

  /** Every text the menu holds (statistics, rows, detail) is emptied: they may hold amounts. State is left alone. */
  function blankNodes() {
    for (const n of statEls.concat(factEls, tripEls, breakEls)) setText(n, "");
    for (const r of rows) {
      setText(r.n, "");
      setText(r.when, "");
      setText(r.detail, "");
      setText(r.result, "");
    }
    setText(detailTitle, "");
  }

  /** A closed menu keeps no data and no text (they may hold balances): reopening fetches them again. */
  function blankMenu() {
    st.list = null;
    st.stats = null;
    st.detail = null;
    st.asked = null;
    st.view = "list";
    blankNodes();
  }

  function closeMenu() {
    clearExport(true);
    blankMenu();
    st.open = false;
    resetConfirm();
    renderMenu();
    renderButtons();
  }

  function backToList() {
    clearExport(true);
    st.view = "list";
    st.detail = null;
    blankNodes();
    renderMenu();
  }

  async function loadMenu() {
    const money = !!st.ctx.showBalance;
    const token = ++st.token;
    st.loading = true;
    st.error = "";
    renderMenu();
    try {
      const listRes = await api.call("sc_session_list", {
        limit: cfg.maxRows,
        include_balance: money,
      });
      const statsRes = await api.call("sc_session_stats", { include_balance: money });
      if (token !== st.token) return;
      st.list = sessionListNormalize(listRes, money);
      st.stats = sessionStatsNormalize(statsRes, money);
      st.asked = money;
    } catch (err: any) {
      if (token !== st.token) return;
      st.error = sessionText(err && err.message ? err.message : "erreur", 100);
    }
    st.loading = false;
    renderMenu();
  }

  async function openDetail(sessionId: string) {
    if (!sessionId) return;
    const money = !!st.ctx.showBalance;
    const token = ++st.token;
    clearExport(true);
    st.view = "detail";
    st.detail = null;
    st.loading = true;
    st.error = "";
    renderMenu();
    try {
      const res = await api.call("sc_session_current", { id: sessionId, include_balance: money });
      if (token !== st.token) return;
      st.detail = sessionDetailNormalize(res, money);
      st.asked = money;
    } catch (err: any) {
      if (token !== st.token) return;
      st.error = sessionText(err && err.message ? err.message : "erreur", 100);
    }
    st.loading = false;
    renderMenu();
  }

  // ------------------------------------------------------------------------------ the report
  function clearExport(resetChoice: boolean) {
    st.exportToken++;
    st.exportText = null;
    st.exportMsg = "";
    // The nodes are emptied HERE, not by a later render: a render that returns early (the menu is closed) must not leave a
    // report, with its amounts, in the page.
    setText(exportPre, "");
    setText(exportMsg, "");
    show(exportPre, false);
    if (resetChoice) st.exportBalances = false;
  }

  function onToggleBalances() {
    st.exportBalances = !st.exportBalances;
    clearExport(false);
    renderMenu();
  }

  /** Puts the text in the selectable block and tries the clipboard; if it is refused the text stays there, selected. */
  function offerText(text: string, lead: string) {
    st.exportText = text;
    setText(exportPre, text);
    renderExport();
    const p = api.copy ? api.copy(text, exportPre) : Promise.resolve(false);
    return p.then((ok: boolean) => {
      if (ok) {
        st.exportText = null;
        st.exportMsg = lead + "Copié dans le presse-papiers.";
      } else {
        st.exportMsg = lead + "Copie impossible ici : le texte est sélectionné, fais Ctrl+C.";
      }
      say(st.exportMsg);
      renderMenu();
    });
  }

  async function onExport(kind: string) {
    const d = st.detail;
    if (!d || !d.session.id) return;
    const money = !!st.ctx.showBalance;
    const withBalances = money && st.exportBalances;
    clearExport(false);
    const token = st.exportToken;
    st.exportMoney = money;
    st.exportMsg = "Préparation du bilan…";
    renderMenu();
    try {
      const csvFr = kind === "csvfr";
      const res = await api.call(
        "sc_session_export",
        Object.assign(
          {
            id: d.session.id,
            kind: kind === "csv" || kind === "csvfr" ? "csv" : "md",
            include_balance: money,
            include_start_balance: withBalances,
          },
          csvFr ? { csv_delimiter: ";" } : {},
        ),
      );
      if (token !== st.exportToken) return;
      // The balance was hidden (or shown) while the report was made: a report made with the other choice is dropped.
      if (!!st.ctx.showBalance !== money) {
        clearExport(true);
        st.exportMsg = "Le choix du solde a changé : relance le bilan.";
        renderMenu();
        return;
      }
      const out = sessionDebriefNormalize(
        res,
        money,
        withBalances,
        kind === "csv" || csvFr ? "csv" : "md",
      );
      if (!out) throw new Error("réponse inattendue");
      const number = String(d.session.number).replace(/[^0-9]/g, "") || "x";
      const csv = kind === "csv" || csvFr;
      const text = out.text;
      if (!text) throw new Error("bilan vide");
      if (kind === "copy") {
        await offerText(text, "");
        return;
      }
      const ok =
        !!api.download &&
        api.download(
          "bilan-session-" + number + (csv ? ".csv" : ".md"),
          csv ? "text/csv" : "text/markdown",
          text,
        );
      if (ok) {
        st.exportMsg =
          "Téléchargement lancé. Si rien ne s’enregistre (l’hôte peut le bloquer), utilise « Copier le bilan ».";
        say("Téléchargement du bilan lancé.");
        renderMenu();
      } else {
        await offerText(text, "Téléchargement impossible ici. ");
      }
    } catch (err: any) {
      if (token !== st.exportToken) return;
      st.exportMsg =
        "Bilan impossible : " + sessionText(err && err.message ? err.message : "erreur", 100);
      renderMenu();
    }
  }

  function renderExport() {
    // The text and the message are emptied first, whatever is shown: a hidden node must not keep a report.
    if (st.exportText === null) setText(exportPre, "");
    if (!st.exportMsg) setText(exportMsg, "");
    const d = st.detail;
    const on = st.view === "detail" && !!d && !!d.session.id;
    show(exportBox, on);
    if (!on) return;
    const money = !!st.ctx.showBalance;
    const canDownload = !!(api.canDownload && api.canDownload());
    show(btnMd, canDownload);
    show(btnCsv, canDownload);
    show(btnCsvFr, canDownload);
    show(btnBalances, money);
    setText(
      btnBalances,
      "Soldes de départ et final : " + (money && st.exportBalances ? "oui" : "non"),
    );
    setAttr(btnBalances, "aria-pressed", money && st.exportBalances ? "true" : "false");
    setText(
      exportHint,
      money
        ? st.exportBalances
          ? "Le bilan contient des montants et les soldes de départ et final. Relis-le avant de le partager."
          : "Le bilan contient des montants, mais pas les soldes de départ et final. Relis-le avant de le partager."
        : "Solde masqué : le bilan ne contient aucun montant (trajets, durées, SCU). Relis-le avant de le partager.",
    );
    setText(exportMsg, st.exportMsg);
    show(exportMsg, !!st.exportMsg);
    show(exportPre, st.exportText !== null);
    if (st.exportText === null) setText(exportPre, "");
  }

  // ------------------------------------------------------------------------------ rendering
  function renderButtons() {
    const info = st.info;
    setText(btnNew, st.confirmNew ? "Confirmer : nouvelle session" : "Nouvelle session");
    setAttr(btnNew, "aria-pressed", st.confirmNew ? "true" : "false");
    setText(btnEnd, st.confirmEnd ? "Confirmer la fin" : "Terminer la session");
    show(btnEnd, !!(info && info.canEnd));
    setText(btnMenu, st.open ? "Sessions ▴" : "Sessions ▾");
    setAttr(btnMenu, "aria-expanded", st.open ? "true" : "false");
    show(btnBalance, !st.ctx.showBalance);
  }

  const fmtMoney = (n: any, signed: boolean) =>
    typeof n === "number" ? L.fmtAuec(n, signed) + "\u00a0aUEC" : "—";

  function renderStats() {
    const s = st.stats;
    const show1 = !!s && s.sessions > 0;
    show(stats, show1);
    if (!show1) return;
    const lines: string[] = [];
    lines.push(
      s.sessions +
        (s.sessions > 1 ? " sessions" : " session") +
        " · " +
        s.trips +
        (s.trips > 1 ? " trajets" : " trajet") +
        " · " +
        L.formatDuration(s.active_ms) +
        " de jeu" +
        (s.trips_per_hour !== null ? " · " + s.trips_per_hour + " trajets/h" : ""),
    );
    const m = s.money;
    if (m) {
      if (m.net_auec !== null)
        lines.push(
          "Total : " +
            fmtMoney(m.net_auec, true) +
            (m.avg_net_per_hour_auec !== null
              ? " · moyenne " + fmtMoney(m.avg_net_per_hour_auec, true) + "/h"
              : " · moyenne par heure inconnue"),
        );
      if (m.best_session && m.worst_session)
        lines.push(
          "Meilleure : N°\u00a0" +
            m.best_session.number +
            " (" +
            fmtMoney(m.best_session.net_per_hour_auec, true) +
            "/h) · la moins bonne : N°\u00a0" +
            m.worst_session.number +
            " (" +
            fmtMoney(m.worst_session.net_per_hour_auec, true) +
            "/h)",
        );
      if (m.trend) {
        const words: any = { up: "en hausse", down: "en baisse", flat: "stable" };
        lines.push(
          "Tendance : " +
            words[m.trend.direction] +
            " (" +
            fmtMoney(m.trend.previous_per_hour_auec, true) +
            "/h → " +
            fmtMoney(m.trend.recent_per_hour_auec, true) +
            "/h)",
        );
      }
      if (m.plan && m.plan.efficiency !== null)
        lines.push(
          "Efficacité face au plan : " +
            Math.round(m.plan.efficiency * 100) +
            " % sur " +
            m.plan.trips +
            " trajet(s)",
        );
      if (m.best_routes.length > 0) {
        const r = m.best_routes[0];
        lines.push(
          "Meilleur trajet connu : " +
            r.commodity +
            (r.buy_terminal || r.sell_terminal
              ? " (" + (r.buy_terminal || "?") + " → " + (r.sell_terminal || "?") + ")"
              : "") +
            " · " +
            fmtMoney(r.avg_net_auec, true) +
            " en moyenne sur " +
            r.trips,
        );
      }
    } else {
      lines.push("Montants masqués : afficher le solde pour les chiffres d’argent.");
    }
    for (let i = 0; i < statEls.length; i++) {
      setText(statEls[i], lines[i] || "");
      show(statEls[i], !!lines[i]);
    }
  }

  function renderList() {
    const l = st.list;
    const sessions = l ? l.sessions : [];
    for (let i = 0; i < rows.length; i++) {
      const s = sessions[i];
      show(rows[i], !!s);
      if (!s) continue;
      const info = sessionRowInfo(L, s, !!st.ctx.showBalance, st.ctx.now);
      setText(rows[i].n, info.number);
      setText(rows[i].when, info.when);
      setText(rows[i].detail, info.detail);
      setText(rows[i].result, info.result);
      setAttr(rows[i].result, "data-tone", info.tone);
      setAttr(rows[i], "data-open", info.open ? "1" : "0");
      setAttr(
        rows[i],
        "aria-label",
        "Ouvrir la session " + s.number + " : " + info.when + ", " + info.detail,
      );
      rows[i]._id = s.id;
    }
  }

  function renderDetail() {
    const d = st.detail;
    show(detail, st.view === "detail");
    if (st.view !== "detail" || !d) return;
    const s = d.session;
    const m = s.money;
    setText(
      detailTitle,
      "Session " + s.number + (s.status === "ended" ? " (terminée)" : " (en cours)"),
    );
    const f: string[] = [];
    f.push(
      "Début : " +
        sessionWhen(s.started_at, st.ctx.now) +
        (s.ended_at ? " · fin : " + sessionWhen(s.ended_at, st.ctx.now) : ""),
    );
    f.push(
      "Temps de jeu : " +
        L.formatDuration(s.active_ms) +
        " sur " +
        L.formatDuration(s.duration_ms) +
        " de durée totale" +
        (s.interruptions > 0 ? " (" + s.interruptions + " coupure(s) non comptée(s))" : ""),
    );
    f.push(
      "Trajets : " +
        s.trips +
        (s.contracts > 0 ? " (+ " + s.contracts + " autre(s) contrat(s))" : "") +
        (s.minutes_per_trip !== null
          ? " · ≈\u00a0" + s.minutes_per_trip + " min par trajet (estimé)"
          : ""),
    );
    if (m) {
      f.push(
        "Solde : " +
          fmtMoney(m.start_balance_auec, false) +
          " → " +
          fmtMoney(m.last_balance_auec, false) +
          (m.start_balance_quality
            ? " · départ " + sessionQualityLabel(m.start_balance_quality)
            : ""),
      );
      f.push(
        (m.net_source === "trips" ? "Résultat des trajets : " : "Variation du solde : ") +
          fmtMoney(m.net_auec, true) +
          (m.net_per_hour_auec !== null
            ? " · " + fmtMoney(m.net_per_hour_auec, true) + "/h"
            : " · rythme inconnu") +
          " · mesure brute",
      );
      if (m.gross_margin_auec !== null)
        f.push(
          "Marge brute des cargaisons : " +
            fmtMoney(m.gross_margin_auec, true) +
            " (revenu − coût des cargaisons soldées, hors frais : estimation du journal de commerce)",
        );
      if (m.best_trip)
        f.push(
          "Meilleur trajet : " +
            (m.best_trip.label || m.best_trip.commodity || "sans titre") +
            " · " +
            fmtMoney(m.best_trip.net_auec, true),
        );
      if (m.plan && m.plan.efficiency !== null)
        f.push(
          "Efficacité face au plan : " +
            Math.round(m.plan.efficiency * 100) +
            " % (" +
            fmtMoney(m.plan.measured_auec, true) +
            " mesurés pour " +
            fmtMoney(m.plan.planned_auec, true) +
            " prévus, " +
            m.plan.trips +
            " trajet(s))",
        );
    } else {
      f.push("Montants masqués : afficher le solde pour les voir.");
    }
    if (s.note) f.push("Note : " + s.note);
    for (let i = 0; i < factEls.length; i++) {
      setText(factEls[i], f[i] || "");
      show(factEls[i], !!f[i]);
    }
    for (let i = 0; i < tripEls.length; i++) {
      const t = d.trips[d.trips.length - 1 - i];
      show(tripEls[i], !!t);
      if (!t) continue;
      const route =
        t.buy_terminal || t.sell_terminal
          ? (t.buy_terminal || "?") + " → " + (t.sell_terminal || "?")
          : "";
      setText(
        tripEls[i],
        [
          sessionWhen(t.ended_at, st.ctx.now),
          t.label || t.commodity,
          route,
          m && t.net_auec !== null ? fmtMoney(t.net_auec, true) : "",
        ]
          .filter((x) => x)
          .join(" · "),
      );
    }
    show(tripsTitle, d.trips.length > 0);
    show(breaksTitle, d.interruptions.length > 0);
    for (let i = 0; i < breakEls.length; i++) {
      const b = d.interruptions[d.interruptions.length - 1 - i];
      show(breakEls[i], !!b);
      if (!b) continue;
      const ms = Date.parse(b.to) - Date.parse(b.from);
      setText(
        breakEls[i],
        sessionWhen(b.from, st.ctx.now) +
          " · " +
          L.formatDuration(ms) +
          " · " +
          sessionInterruptionLabel(b.kind),
      );
    }
  }

  function renderMenu() {
    show(menu, st.open);
    setAttr(root, "data-menu", st.open ? "1" : "0");
    if (!st.open) return;
    const inList = st.view === "list";
    show(list, inList);
    show(btnBack, !inList);
    show(menuTitle, inList);
    show(detailHead, !inList);
    show(btnEnd, inList && !!(st.info && st.info.canEnd));
    show(stats, inList && !!st.stats);
    setText(
      menuMsg,
      st.loading ? "Chargement…" : st.error ? "Impossible de lire les sessions : " + st.error : "",
    );
    show(menuMsg, st.loading || !!st.error);
    if (inList) {
      renderStats();
      renderList();
      show(detail, false);
    } else {
      show(stats, false);
      renderDetail();
    }
    renderExport();
  }

  // Everything in the menu starts hidden: only an open menu draws anything.
  renderMenu();

  return {
    root,
    /** For the tests only. */
    state: () => st,
    /** The page is going away: nothing of a report stays in it. */
    dropExport() {
      clearExport(true);
      blankMenu();
    },
    render(rawBar: any, ctx: any) {
      st.ctx = { showBalance: !!(ctx && ctx.showBalance), now: ctx && ctx.now ? ctx.now : 0 };
      // A report made with the other balance choice is not reused: it goes, and so does the start-balance choice.
      if ((st.exportText !== null || st.exportMsg) && st.exportMoney !== st.ctx.showBalance)
        clearExport(true);
      else if (!st.ctx.showBalance && st.exportBalances) st.exportBalances = false;
      // The balance is hidden again: nothing the menu drew with it stays in the page, even in nodes that are not shown.
      if (!st.ctx.showBalance && st.asked === true) blankNodes();
      const bar2 = sessionBarNormalize(rawBar, st.ctx.showBalance);
      const info = sessionBarInfo(L, bar2, st.ctx);
      st.info = info;
      show(root, info.visible);
      if (!info.visible) return;
      setAttr(root, "data-empty", info.empty ? "1" : "0");
      setAttr(root, "data-state", info.chipState || "");
      setText(title, info.title);
      setText(chip, info.chip);
      show(chip, !!info.chip);
      setText(sub, info.sub);
      setAttr(kpiBox, "data-count", String(info.kpis.length));
      for (let i = 0; i < kpis.length; i++) {
        const k = info.kpis[i];
        show(kpis[i], !!k);
        if (!k) continue;
        setText(kpis[i].label, k.label);
        setText(kpis[i].value, k.value);
        setText(kpis[i].sub, k.sub);
        setAttr(kpis[i], "data-tone", k.tone);
        setAttr(kpis[i], "data-kpi", k.id);
        setAttr(kpis[i], "data-first", i === 0 ? "1" : "0");
      }
      for (let i = 0; i < noteEls.length; i++) {
        setText(noteEls[i], info.notes[i] || "");
        show(noteEls[i], !!info.notes[i]);
      }
      show(notes, info.notes.length > 0);
      renderButtons();
      // The menu was fetched with another balance choice: ask again so that no figure is drawn that was not asked for.
      if (st.open && st.asked !== null && st.asked !== st.ctx.showBalance && !st.loading) {
        if (st.view === "detail" && st.detail) void openDetail(st.detail.session.id);
        else void loadMenu();
      }
      if (st.open) renderMenu();
    },
  };
}

/** Everything above that the page needs, in the order it is serialised. */
export const SESSION_VIEW_FUNCTIONS = [
  sessionConfig,
  sessionText,
  sessionNum,
  sessionIso,
  sessionCount,
  sessionMoney,
  sessionSummaryNormalize,
  sessionBarNormalize,
  sessionChannelClean,
  sessionBarStripBalance,
  sessionWhen,
  sessionStateLabel,
  sessionInterruptionLabel,
  sessionQualityLabel,
  sessionBarInfo,
  sessionRowInfo,
  sessionListNormalize,
  sessionAggregateSession,
  sessionStatsNormalize,
  sessionDetailNormalize,
  sessionExportText,
  sessionDebriefNormalize,
  sessionPanel,
];
