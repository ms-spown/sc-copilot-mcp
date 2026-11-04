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
    // The most sessions the list can hold: the file keeps 200 at most (MAX_SESSIONS), and "Toutes les sessions" asks for all.
    maxRows: 200,
    // The list shows this many sessions (the current one included) until "Toutes les sessions" is pressed.
    latestRows: 3,
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
    // What was PAID for the cargo presumed lost with destroyed ships: a balance figure, so it lives here.
    lost_cargo_paid_auec: sessionNum(raw.lost_cargo_paid_auec),
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
    // True for an open session that holds nothing yet (the player's chronometer): restarting or ending it loses nothing.
    empty: raw.empty === true,
    game_closed_at: sessionIso(raw.game_closed_at),
    // The player archived this ended session: kept, hidden from the default list.
    archived: raw.archived === true,
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
    // Ships destroyed with the player aboard: fixed words and a quantity each, no amount (that is in `money`).
    ship_losses: (Array.isArray(raw.ship_losses) ? raw.ship_losses : [])
      .slice(-3)
      .filter((x: any) => x && typeof x === "object" && sessionIso(x.at))
      .map((x: any) => ({
        at: x.at,
        ship_class: sessionText(x.ship_class, 60) || null,
        cause: ["collision", "combat", "self_destruct"].indexOf(x.cause) >= 0 ? x.cause : "unknown",
        causer: ["self", "other", "npc"].indexOf(x.causer) >= 0 ? x.causer : "unknown",
        cargo_scu: sessionNum(x.cargo_scu),
      })),
    // How many were lost in all (the list above keeps the 3 newest): a count, no amount.
    ship_losses_count: Math.max(
      sessionCount(raw.ship_losses_count, 999),
      Math.min(3, Array.isArray(raw.ship_losses) ? raw.ship_losses.length : 0),
    ),
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

/**
 * Where the card stands, in one word: "none" (no session), "timing" (a session the player started that holds nothing yet: the
 * game was never seen during it, its chronometer runs from the click), "active" (in progress), "idle" (open but quiet for
 * longer than the gap), "ended" (closed: by hand, by a new session or by a gap).
 */
export function sessionPhase(cur: any, stale: boolean): string {
  if (!cur) return "none";
  if (cur.status === "ended") return "ended";
  if (cur.empty) return "timing";
  return stale ? "idle" : "active";
}

export function sessionStateLabel(cur: any, stale: boolean): string {
  const phase = sessionPhase(cur, stale);
  if (phase === "none") return "";
  if (phase === "ended") return "terminée";
  if (phase === "timing") return "en cours";
  return phase === "idle" ? "inactive" : "en cours";
}

/** How a session ended, in a few words ("" when unknown). */
export function sessionEndReasonText(reason: any): string {
  if (reason === "manual") return "fin manuelle";
  if (reason === "new_session") return "remplacée par une nouvelle session";
  if (reason === "gap") return "inactivité prolongée";
  return "";
}

/** "terminée à 16:10" (today), "terminée hier 22:10", "terminée le 03/11 22:10"; "terminée" when the time is unknown. */
export function sessionEndedText(cur: any, now: number): string {
  const when = cur ? sessionWhen(cur.ended_at, now) : "";
  if (!when) return "terminée";
  if (when.indexOf("aujourd’hui ") === 0) return "terminée à " + when.slice("aujourd’hui ".length);
  if (when.indexOf("hier ") === 0) return "terminée " + when;
  return "terminée le " + when;
}

function sessionTripsText(n: number): string {
  return n === 0 ? "aucun trajet" : n + (n > 1 ? " trajets" : " trajet");
}

/** "inactive depuis 2 h", "inactive depuis 12 min": how long an open session has been quiet. "inactive" when that is unknown. */
export function sessionIdleText(cur: any, now: number): string {
  const t =
    cur && typeof cur.last_activity_at === "string" ? Date.parse(cur.last_activity_at) : NaN;
  if (!Number.isFinite(t) || !Number.isFinite(now) || now <= t) return "inactive";
  const minutes = Math.floor((now - t) / 60000);
  if (minutes < 1) return "inactive";
  if (minutes < 60) return "inactive depuis " + minutes + "\u00a0min";
  return "inactive depuis " + Math.floor(minutes / 60) + "\u00a0h";
}

/**
 * What the store's notice says, in French. The server's own text is English and is never shown: the bar's status says
 * which case it is, and the start of the text which of the store's cases ("could not be saved" is the degraded status).
 */
export function sessionNoticeText(bar: any): string {
  if (!bar || (bar.status !== "readonly" && bar.status !== "degraded")) return "";
  const raw = typeof bar.notice === "string" ? bar.notice : "";
  if (bar.status === "degraded")
    return "Les sessions n’ont pas pu être enregistrées sur le disque : elles restent en mémoire et le prochain changement réessaiera.";
  if (raw.indexOf("larger than expected") >= 0)
    return "Le fichier des sessions est plus gros que prévu : il n’a pas été lu, les sessions restent en mémoire.";
  if (raw.indexOf("newer version") >= 0)
    return "Le fichier des sessions vient d’une version plus récente de ce serveur : il n’a pas été modifié et les sessions restent en mémoire jusqu’à la mise à jour.";
  if (raw.indexOf("could not be set aside") >= 0)
    return "Le fichier des sessions n’est pas valide et n’a pas pu être mis de côté : les sessions restent en mémoire.";
  return "Les sessions restent en mémoire : le fichier est en lecture seule.";
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
  const notice = sessionNoticeText(bar);
  if (!cur) {
    return {
      visible: true,
      empty: true,
      phase: "none",
      id: "",
      number: 0,
      title: "Aucune session en cours",
      line: "Aucune session en cours",
      chip: "",
      sub: "",
      hint: "Une session démarre toute seule quand le jeu est lancé et connecté, ou tout de suite avec « Démarrer une session » (le chrono part de ton clic, même jeu fermé).",
      kpis: [],
      notes: notice ? [notice] : [],
      canEnd: false,
      canNew: true,
      closes: false,
      newLabel: "Démarrer une session",
      newPrimary: true,
      endAsk: "",
      newAsk: "",
      stale: false,
    };
  }
  const phase = sessionPhase(cur, bar.stale);
  const money = showBalance ? cur.money : null;
  const hasMoney = !!money && typeof money === "object";
  const sub: string[] = [];
  const when = sessionWhen(cur.started_at, now);
  // A session the player started and the game has not filled yet: a chronometer that runs from the click.
  const started = Date.parse(cur.started_at);
  const elapsed = Number.isFinite(started) && now > started ? now - started : 0;
  if (phase === "timing") {
    if (when) sub.push("chrono lancé " + when);
    sub.push("rien d’enregistré pour l’instant");
  } else {
    const ending = phase === "ended" ? sessionEndReasonText(cur.end_reason) : "";
    if (ending) sub.push(ending);
    if (when) sub.push((phase === "ended" ? "début " : "depuis ") + when);
    if (cur.active_ms > 0) sub.push(L.formatDuration(cur.active_ms) + " de jeu");
    if (cur.game_version) sub.push("jeu " + cur.game_version);
  }
  const tripsText = sessionTripsText(cur.trips);
  // Closing a session that holds something asks first; a chronometer that holds nothing is restarted or deleted at once.
  // (A chronometer that ran for over 15 minutes asks too: restarting or deleting it throws that time away.)
  const longChrono = phase === "timing" && elapsed > 15 * 60000;
  const closes = phase === "active" || phase === "idle" || longChrono;
  const canEnd = closes || phase === "timing";
  const hints: any = {
    timing:
      "Le chrono tourne depuis ton clic et ne repart pas à zéro quand le jeu se lance ; il expire après 24 h sans activité. « Terminer la session » la supprime (elle ne contient rien : rien à archiver).",
    ended:
      "Rien n’est compté tant que tu ne démarres pas une nouvelle session ou que le jeu n’est pas relancé.",
  };
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
  if (phase === "timing") {
    // The game was never seen during this session: one figure only, the chronometer (never a dash for a missing result).
    kpis.push({
      id: "time",
      label: "Chrono",
      value: L.formatDuration(elapsed),
      sub: "depuis ton clic",
      tone: "",
    });
  } else if (hasMoney) {
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
      sub: "Solde masqué",
      tone: "",
    });
  }
  const notes: string[] = [];
  if (phase === "idle")
    notes.push(
      "Aucune activité depuis plus de " +
        bar.gap_hours +
        " h : la prochaine partie démarrera une nouvelle session.",
    );
  if (phase === "active" && cur.game_closed_at)
    notes.push(
      "Le jeu est fermé depuis " +
        L.formatClock(cur.game_closed_at) +
        " : la session reprend si tu le relances dans les " +
        bar.gap_hours +
        " h.",
    );
  if (cur.interruptions > 0)
    notes.push(
      "Session reprise après " +
        cur.interruptions +
        (cur.interruptions > 1 ? " arrêts" : " arrêt") +
        " du jeu (détail dans Sessions).",
    );
  if (hasMoney && money.start_balance_quality && money.start_balance_quality !== "game_start")
    notes.push("Solde de départ : " + sessionQualityLabel(money.start_balance_quality) + ".");
  if (notice) notes.push(notice);
  // Ships destroyed with the player aboard stay on the session for good (the alert in the header goes away).
  for (const l of cur.ship_losses) {
    notes.push(
      "Vaisseau détruit à " +
        L.formatClock(l.at) +
        " (" +
        (l.ship_class ? l.ship_class.replace(/_/g, " ") : "modèle inconnu") +
        ")" +
        ", joueur à bord : " +
        L.tradeLossCause(l) +
        ". " +
        L.tradeLossCargo(L, l, false),
    );
  }
  if (cur.ship_losses_count > cur.ship_losses.length)
    notes.push(
      "Les " +
        cur.ship_losses.length +
        " derniers vaisseaux détruits sur " +
        cur.ship_losses_count +
        " sont listés.",
    );
  if (cur.ship_losses.length > 0)
    notes.push(
      "Propriété du vaisseau non vérifiée ; valeur perdue, assurance et responsable non journalisés.",
    );
  if (cur.ship_losses.length > 0 && hasMoney && money.lost_cargo_paid_auec !== null)
    notes.push(
      "Payé pour ce cargo\u00a0: " +
        L.fmtAuec(money.lost_cargo_paid_auec) +
        "\u00a0aUEC (prix d’achat, pas la valeur ; valeur perdue, assurance et responsable non journalisés).",
    );
  // The compact view's one line: the net per hour comes from the same `money` as the kpis, so it exists only while the
  // balance is shown.
  const rate = hasMoney && money.net_per_hour_auec !== null ? money.net_per_hour_auec : null;
  const line = ["Session " + cur.number];
  if (phase === "timing") line.push("chrono " + L.formatDuration(elapsed));
  else {
    if (phase === "ended") line.push(sessionEndedText(cur, now));
    line.push(cur.trips + (cur.trips > 1 ? " trajets" : " trajet"));
    if (cur.active_ms > 0) line.push(L.formatDuration(cur.active_ms));
    if (rate !== null) line.push(L.fmtAuec(rate, true) + "\u00a0aUEC/h");
    if (phase === "idle") line.push(sessionIdleText(cur, now));
  }
  if (cur.ship_losses_count > 0)
    line.push(
      cur.ship_losses_count +
        (cur.ship_losses_count > 1
          ? "\u00a0vaisseaux\u00a0détruits"
          : "\u00a0vaisseau\u00a0détruit"),
    );
  // A warning note (a read-only or degraded store, a start balance that is not the game's) must not be hidden by the fold.
  // It says which one, not just that there is one.
  if (notice)
    line.push(bar.status === "degraded" ? "enregistrement impossible" : "fichier en lecture seule");
  if (hasMoney && money.start_balance_quality && money.start_balance_quality !== "game_start")
    line.push("solde de départ approximatif");
  return {
    visible: true,
    empty: false,
    phase,
    id: cur.id,
    number: cur.number,
    line: line.join(" · "),
    title: "Session " + cur.number,
    chip: phase === "ended" ? sessionEndedText(cur, now) : sessionStateLabel(cur, bar.stale),
    chipState: phase === "idle" ? "stale" : phase === "active" ? "open" : phase,
    sub: sub.join(" · "),
    hint: hints[phase] || "",
    kpis,
    notes,
    // What the buttons offer: starting a session is possible in EVERY state (a chronometer that holds nothing is restarted
    // at once); ending too, except once ended. `closes`: the click would close a session that holds something, so it asks.
    canEnd,
    canNew: true,
    closes,
    newLabel: phase === "timing" ? "Redémarrer le chrono" : "Nouvelle session",
    newPrimary: phase === "ended",
    endAsk:
      phase === "timing"
        ? "Supprimer la session " +
          cur.number +
          " ? Son chrono tourne depuis " +
          L.formatDuration(elapsed) +
          " et elle ne contient rien : elle sera supprimée, sans archive."
        : "Terminer la session " +
          cur.number +
          " (" +
          tripsText +
          ") ? Elle reste dans l’historique, et rien n’y sera plus compté tant que tu ne démarres pas une nouvelle session ou que le jeu n’est pas relancé.",
    newAsk:
      phase === "timing"
        ? "Redémarrer le chrono de la session " +
          cur.number +
          " ? Il tourne depuis " +
          L.formatDuration(elapsed) +
          " ; il repartira de maintenant."
        : "Démarrer une nouvelle session ? La session " +
          cur.number +
          " (" +
          tripsText +
          ") sera terminée et restera dans l’historique.",
    endYes: phase === "timing" ? "Confirmer la suppression" : "Confirmer la fin",
    newYes: phase === "timing" ? "Confirmer : redémarrer" : "Confirmer : nouvelle session",
    stale: !!bar.stale,
  };
}

/** The state of one session in the list, in words: in progress / chronometer without the game yet / ended (and how). */
export function sessionRowStatus(s: any): string {
  if (s.status === "ended") {
    const how = sessionEndReasonText(s.end_reason);
    return "terminée" + (how ? " · " + how : "") + (s.archived ? " · archivée" : "");
  }
  if (s.empty) return "en cours · chrono";
  return s.game_closed_at ? "en cours · jeu fermé" : "en cours";
}

/** Does a filter of the sessions view keep this session? "all" is every session that is not archived. */
export function sessionFilterMatch(filter: string, s: any): boolean {
  if (filter === "archived") return !!s.archived;
  if (s.archived) return false;
  if (filter === "open") return s.status === "open";
  if (filter === "ended") return s.status === "ended";
  return true;
}

/** How many sessions each filter of the sessions view keeps: { all, open, ended, archived }. */
export function sessionFilterCounts(sessions: any[]): any {
  const out: any = { all: 0, open: 0, ended: 0, archived: 0 };
  for (const s of sessions) {
    if (s.archived) out.archived += 1;
    else {
      out.all += 1;
      if (s.status === "open") out.open += 1;
      else out.ended += 1;
    }
  }
  return out;
}

/** The note under the statistics: how many archived sessions they leave out ("0 session archivée non comptée" included). */
export function sessionArchivedNote(n: number): string {
  return n + (n > 1 ? " sessions archivées non comptées" : " session archivée non comptée");
}

/**
 * The question asked before a session is deleted for good (no amount in it). `comesBack`: the game is running and nothing before
 * this session would hold the card, so the game starts another one at once.
 */
export function sessionDeleteAsk(s: any, comesBack?: boolean): string {
  return (
    "Supprimer la session " +
    s.number +
    " (" +
    sessionTripsText(s.trips) +
    ") ? Elle est retirée du fichier pour de bon : ni archive, ni retour possible ; ses trajets ne comptent plus dans les statistiques ni l’étalonnage des routes." +
    (comesBack ? " Le jeu tourne : une nouvelle session va démarrer tout de suite." : "")
  );
}

/** What the player is told once the server answered archive / unarchive / delete of one session: French, no amount. */
export function sessionManageText(action: string, raw: any): string {
  const r = raw && typeof raw === "object" ? raw : {};
  const s = sessionSummaryNormalize(r.session, false);
  const n = s ? s.number : 0;
  const unsaved =
    r.persistence && r.persistence.saved === false
      ? " Attention : le changement n’a pas pu être enregistré sur le disque, il reste en mémoire."
      : "";
  if (r.reason === "open_session")
    return (
      "La session " +
      n +
      " est en cours : termine-la d’abord (Terminer), puis tu pourras l’archiver ou la supprimer."
    );
  if (r.reason === "not_found") return "Cette session n’existe plus : la liste est relue.";
  if (r.reason === "unchanged")
    return (
      "La session " +
      n +
      (action === "archive" ? " était déjà archivée." : " n’était pas archivée.")
    );
  // When the disk could not be written, the change is only in memory: never say "du fichier" then.
  const memory = unsaved !== "";
  if (action === "delete")
    return (
      "Session " +
      n +
      (memory ? " supprimée (en mémoire seulement)." : " supprimée du fichier.") +
      unsaved
    );
  if (action === "archive")
    return (
      "Session " +
      n +
      (memory ? " archivée (en mémoire seulement)" : " archivée") +
      " : elle reste dans le filtre « Archivées »." +
      unsaved
    );
  return "Session " + n + " désarchivée : elle est de retour dans la liste." + unsaved;
}

/**
 * What the player is told once the server answered "Terminer" (`kind` "end") or "Nouvelle session" ("new"): French, built from the
 * structured answer (never the server's English message), no amount. An answer that changed nothing says why.
 */
export function sessionActionText(kind: string, raw: any, now: number): string {
  const r = raw && typeof raw === "object" ? raw : {};
  const s = sessionSummaryNormalize(r.session, false);
  const n = s ? s.number : 0;
  const unsaved =
    r.persistence && r.persistence.saved === false
      ? " Attention : le changement n’a pas pu être enregistré sur le disque, il reste en mémoire."
      : "";
  if (kind === "end") {
    if (r.reason === "discarded")
      return (
        "Session " + n + " supprimée : elle ne contenait rien, il n’y a rien à archiver." + unsaved
      );
    if (r.ok === true && s)
      return (
        "Session " +
        n +
        " " +
        sessionEndedText(s, now) +
        " (" +
        sessionTripsText(s.trips) +
        "). Elle reste dans l’historique." +
        unsaved
      );
    if (r.reason === "already_ended") return "La session " + n + " est déjà terminée.";
    if (r.reason === "none") return "Il n’y a aucune session à terminer.";
    return "Fin de session : réponse inattendue du serveur.";
  }
  if (r.restarted === true)
    return (
      "Chrono de la session " +
      n +
      " redémarré : il repart de maintenant (la session ne contenait rien)." +
      unsaved
    );
  return (
    "Session " +
    n +
    " démarrée." +
    (typeof r.closed_session === "number"
      ? " La session " + r.closed_session + " est terminée et reste dans l’historique."
      : "") +
    unsaved
  );
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
    status: sessionRowStatus(s),
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
    // How many archived sessions the file holds (the list holds them only when they were asked for).
    archived: sessionCount(raw.archived, 999999),
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
    // Archived sessions the server left out of these figures.
    archived_not_counted: sessionCount(raw.archived_not_counted, 999999),
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
  const { el, add, setText, setAttr, show } = L.domKit(doc);
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
  bar.setAttribute("id", "ses-bar");
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
  // The compact view's one line, and the control that unfolds the card (the card stays whole in full screen).
  // The line is the text; the arrow is a decoration (aria-hidden), so that the accessible name is the line alone.
  const one = button("", () => toggleFold(), "ses-one");
  const oneText = el("span", "", "Session");
  const oneCaret = el("span", "", " ▾");
  oneCaret.setAttribute("aria-hidden", "true");
  add(one, oneText, oneCaret);
  one.setAttribute("aria-expanded", "false");
  one.setAttribute("aria-controls", "ses-bar");
  const actions = el("div", "ses-actions");
  // The two actions on the session itself sit on the card (not in the menu of past sessions): "Terminer" only while the
  // session holds something, "Nouvelle session" never on a session that is still empty. A button that could change nothing is
  // not drawn; the line under the card says why.
  const btnEnd = button("Terminer la session", () => ask("end"), "small");
  const btnNew = button("Nouvelle session", () => ask("new"), "small");
  const btnMenu = button("Sessions", () => toggleMenu(), "small");
  btnMenu.setAttribute("aria-expanded", "false");
  // No balance button here: the header's "Solde" zone holds the one show/hide control of the page.
  add(actions, btnMenu, btnEnd, btnNew);
  add(bar, id, kpiBox, actions);
  // The explanation of what the card offers (or why it offers nothing), the inline confirmation, and the result of the last
  // action. The result is ONE live region, present from the start and never hidden (a region that appears together with its
  // text is not always announced); it holds no amount, so hiding the balance never has to clear it.
  const hint = el("p", "ses-hint", "");
  const confirmBox = el("div", "ses-confirm");
  confirmBox.setAttribute("role", "group");
  confirmBox.setAttribute("aria-label", "Confirmation");
  const confirmText = el("p", "ses-confirm-text", "");
  // The question is what the group and the confirm button are described by: a screen reader reads it with them.
  confirmText.setAttribute("id", "ses-confirm-text");
  confirmBox.setAttribute("aria-describedby", "ses-confirm-text");
  const confirmRow = el("div", "ses-confirm-row");
  const btnYes = button("Confirmer", () => void run(), "small primary");
  btnYes.setAttribute("aria-describedby", "ses-confirm-text");
  const btnNo = button("Annuler", () => cancel(), "small");
  add(confirmRow, btnYes, btnNo);
  add(confirmBox, confirmText, confirmRow);
  confirmBox.addEventListener("keydown", (e: any) => {
    if (e && e.key === "Escape") cancel();
  });
  const status = el("p", "ses-status", "");
  status.setAttribute("role", "status");
  status.setAttribute("tabindex", "-1");
  const notes = el("div", "ses-notes");
  const noteEls: any[] = [];
  // Room for every note the card can hold at once (stale, resumed, start balance, store notice, 3 losses and their count, the
  // ownership warning, the amount paid): none is dropped in silence.
  for (let i = 0; i < 12; i++) {
    const p = el("p", "ses-note", "");
    noteEls.push(p);
    add(notes, p);
  }

  // ------------------------------------------------------------------------------ the menu
  const menu = el("div", "ses-menu");
  const menuHead = el("div", "ses-menu-head");
  // The Sessions VIEW (the dedicated tab of the dashboard) is a second instance of this panel, `api.tab`: it holds only this
  // menu, with every saved session, filters, the actions of each row, and the selected session's detail next to the list.
  const tabMode = !!api.tab;
  const menuTitle = el(
    "h3",
    "ses-menu-title",
    tabMode ? "Toutes les sessions" : "Sessions passées",
  );
  // One button opens and closes the list: "Sessions ▾/▴" on the card (aria-expanded flips with it); no separate "Fermer".
  add(menuHead, menuTitle);
  // The filters of the view: which sessions the list shows. "Toutes" is every session that is not archived.
  const FILTERS = [
    ["all", "Toutes"],
    ["open", "En cours"],
    ["ended", "Terminées"],
    ["archived", "Archivées"],
  ];
  const filterBar = el("div", "ses-filters");
  filterBar.setAttribute("role", "group");
  filterBar.setAttribute("aria-label", "Filtrer les sessions");
  const filterBtns: any[] = [];
  for (const f of FILTERS) {
    const b = button(f[1], () => setFilter(f[0]), "mini");
    b.setAttribute("aria-pressed", "false");
    b._f = f[0];
    b._label = f[1];
    filterBtns.push(b);
    add(filterBar, b);
  }
  // The result of the last action on a row (archive, delete): a live region, always present, no amount in it.
  const viewStatus = el("p", "ses-status", "");
  viewStatus.setAttribute("role", "status");
  viewStatus.setAttribute("tabindex", "-1");
  const listEmpty = el("p", "ses-note", "");
  // Always there in the view: the statistics leave the archived sessions out, and say how many.
  const archNote = el("p", "ses-note", "");
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
  // Rows are made as the list needs them (3 at first; the Sessions view may need up to the 200 the file keeps). A row is a
  // wrapper with the button that opens the session and, in the view only, its actions (archive, delete) and the question
  // that precedes a deletion.
  const addRow = () => {
    const wrap = el("div", "ses-rowwrap");
    const r = el("button", "ses-row");
    r.setAttribute("type", "button");
    r.setAttribute("aria-label", "Ouvrir cette session");
    r.n = el("span", "ses-r-n", "");
    r.when = el("span", "ses-r-when", "");
    r.detail = el("span", "ses-r-detail", "");
    r.result = el("span", "ses-r-result", "");
    r.status = el("span", "ses-r-status", "");
    add(r, r.n, r.when, r.detail, r.result, r.status);
    r.addEventListener("click", () => openDetail(r._id));
    r._wrap = wrap;
    add(wrap, r);
    if (tabMode) {
      const acts = el("div", "ses-r-acts");
      r.btnArch = button("Archiver", () => void onArchive(r._id), "mini");
      r.btnDel = button("Supprimer", () => askDelete(r._id), "mini");
      add(acts, r.btnArch, r.btnDel);
      r.acts = acts;
      r.conf = el("div", "ses-r-confirm");
      r.conf.setAttribute("role", "group");
      r.confText = el("p", "ses-confirm-text", "");
      r.btnYes = button("Confirmer la suppression", () => void doDelete(r._id), "mini");
      r.btnNo = button("Annuler", () => cancelDelete(), "mini");
      r.conf.addEventListener("keydown", (e: any) => {
        if (e && e.key === "Escape") cancelDelete();
      });
      const confRow = el("div", "ses-confirm-row");
      add(confRow, r.btnYes, r.btnNo);
      add(r.conf, r.confText, confRow);
      add(wrap, acts, r.conf);
    }
    rows.push(r);
    add(list, wrap);
  };
  for (let i = 0; i < cfg.latestRows; i++) addRow();
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
  // The inline list shows the latest sessions only; this button opens the Sessions view (the dedicated tab) for all of them.
  const btnAll = button("Toutes les sessions", () => api.openView && api.openView(), "mini");
  if (tabMode) {
    // The view: filters and the result line on top, the cross-session statistics, then the list and the selected session's
    // detail side by side (stacked when narrow).
    const split = el("div", "ses-split");
    const listCol = el("div", "ses-listcol");
    add(listCol, list, listEmpty);
    add(split, listCol, detail);
    add(menu, menuHead, filterBar, viewStatus, menuMsg, stats, archNote, split);
    root.className = "ses-view ses";
    add(root, menu);
  } else {
    add(menu, menuHead, menuMsg, stats, list, btnAll, detail);
    add(root, one, bar, hint, confirmBox, status, notes, menu);
  }

  // ------------------------------------------------------------------------------ state
  const st: any = {
    open: false,
    fold: true, // compact view: the card is one line until the player unfolds it
    view: "list", // "list" | "detail"
    ctx: { showBalance: false, now: 0, running: false },
    asked: null, // the balance choice the menu data was fetched with
    loading: false,
    error: "",
    list: null,
    stats: null,
    detail: null,
    // The Sessions view (api.tab only): is it the tab on screen, which filter, which row is selected, which row asks before a
    // deletion, whether an action is under way, the result line, and the card's session the list was read for.
    active: false,
    filter: "all",
    sel: "",
    rowConfirm: "",
    rowBusy: false,
    vmsg: "",
    barKey: null,
    // The inline confirmation: null, or what is being confirmed ({ kind: "end" | "new", id }). It has no timer: it stays until
    // the player confirms or cancels (or the session it was opened for is no longer the current one).
    confirm: null,
    // A call to the server is under way ("end" | "new" | null): the action buttons are not offered meanwhile.
    busy: null,
    // The last result, shown in the live region: { text, number } (number: the session it is about, to drop it once a newer
    // session is on the card). Never holds an amount.
    flash: null,
    token: 0,
    dtoken: 0, // the detail of a session is asked for apart from the list (in the view both are on screen)
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

  // ------------------------------------------------------------------------------ the two actions on the session
  // "Terminer" and "Nouvelle session". A session that holds something (trips, a balance, played time) is closed only after an
  // inline confirmation that has NO timer and a cancel; a harmless action (a new session after an ended one, or when there is
  // none) is done at once. The result is always written in the live region under the card, and the card itself changes: it
  // shows the session as ended (with its time and its result) or the new one.

  /**
   * The result line. `anchor` is the id of the session the card shows once the answer is in (null while the action is under way):
   * the line goes as soon as the card shows another session (a newer one started, even under the same number).
   */
  function setFlash(text: string, anchor: string | null) {
    st.flash = text ? { text, anchor } : null;
  }

  /** The first click: asks for the confirmation, or does it at once when nothing would be closed. */
  function ask(kind: string) {
    const info = st.info;
    if (!info || st.busy || st.confirm) return;
    if (kind === "end" ? !info.canEnd : !info.canNew) return;
    // Only a session that holds something is closed with a question. A chronometer that holds nothing is restarted or deleted at
    // once, an ended session is not closed again, and with no session there is nothing to close.
    if (!info.closes) {
      st.confirm = { kind, id: info.id };
      void run();
      return;
    }
    st.flash = null;
    st.confirm = { kind, id: info.id };
    renderActions();
    btnYes.focus();
  }

  function cancel() {
    const c = st.confirm;
    if (!c || st.busy) return;
    st.confirm = null;
    const info = st.info;
    setFlash(
      c.kind === "end"
        ? "Fin de session annulée : la session continue."
        : "Nouvelle session annulée : la session continue.",
      info ? info.id : "",
    );
    renderActions();
    (c.kind === "end" ? btnEnd : btnNew).focus();
  }

  async function run() {
    const c = st.confirm;
    if (!c || st.busy) return;
    st.confirm = null;
    st.busy = c.kind;
    setFlash(
      c.kind === "end" ? "Fin de la session en cours…" : "Démarrage de la nouvelle session…",
      null,
    );
    renderActions();
    let done = false;
    try {
      const r = await api.call(c.kind === "end" ? "sc_session_end" : "sc_session_new", {});
      setFlash(sessionActionText(c.kind, r, st.ctx.now), null);
      done = true;
    } catch (err: any) {
      setFlash(
        (c.kind === "end" ? "Fin de session impossible : " : "Nouvelle session impossible : ") +
          sessionText(err && err.message ? err.message : "erreur", 100),
        null,
      );
    }
    // The card follows the server: ask for the bar again (and the list, when the menu is open), whatever the answer was. The
    // buttons stay away until it is back, so that a stale card never offers the action that was just done.
    renderActions();
    if (done) st.asked = null;
    try {
      if (api.refresh) await api.refresh();
      if (st.open) await loadMenu();
    } catch {
      /* the next poll shows the truth */
    }
    // From now on the line belongs to the session the card shows.
    if (st.flash) st.flash.anchor = st.info ? st.info.id : "";
    st.busy = null;
    renderActions();
    // The button that was pressed may be gone (a session that has ended offers another one): the focus goes to the next
    // thing to do, else to the result, so that a keyboard user never loses their place.
    if (st.info && st.info.canNew) btnNew.focus();
    else status.focus();
  }

  function toggleFold() {
    st.fold = !st.fold;
    renderFold();
    one.focus();
  }

  function renderFold() {
    setAttr(root, "data-fold", st.fold ? "1" : "0");
    setAttr(one, "aria-expanded", st.fold ? "false" : "true");
    setText(oneText, (st.info && st.info.line) || "Session");
    setText(oneCaret, st.fold ? " ▾" : " ▴");
  }

  function toggleMenu() {
    if (st.open) closeMenu();
    else openMenu();
  }

  function openMenu() {
    st.open = true;
    st.view = "list";
    renderMenu();
    renderActions(); // the one button flips to "Sessions ▴" (aria-expanded true) at once, not at the next poll
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
      setText(r.status, "");
    }
    setText(detailTitle, "");
  }

  /**
   * The balance is hidden: the answers already held are rebuilt without any aUEC figure, BEFORE anything is drawn again (the
   * reload that follows may be slow or fail, and a redraw in the meantime must not bring a figure back).
   */
  function stripMoney() {
    if (st.stats) st.stats.money = null;
    if (st.list) for (const s of st.list.sessions) s.money = null;
    if (st.detail) {
      st.detail.session.money = null;
      for (const t of st.detail.trips) t.net_auec = null;
    }
  }

  /** A closed menu keeps no data and no text (they may hold balances): reopening fetches them again. */
  function blankMenu() {
    st.list = null;
    st.stats = null;
    st.detail = null;
    st.asked = null;
    st.view = "list";
    st.sel = "";
    st.rowConfirm = "";
    blankNodes();
  }

  function closeMenu() {
    clearExport(true);
    blankMenu();
    st.open = false;
    renderMenu();
    renderActions();
  }

  function backToList() {
    clearExport(true);
    st.view = "list";
    st.detail = null;
    st.sel = "";
    blankNodes();
    renderMenu();
  }

  /** The list of sessions and the statistics across them: the latest few inline, every saved session (archived too) in the view. */
  async function loadMenu() {
    const money = !!st.ctx.showBalance;
    const token = ++st.token;
    st.loading += 1;
    st.error = "";
    renderMenu();
    try {
      const listRes = await api.call(
        "sc_session_list",
        tabMode
          ? { limit: cfg.maxRows, include_archived: true, include_balance: money }
          : { limit: cfg.latestRows, include_balance: money },
      );
      const statsRes = await api.call("sc_session_stats", { include_balance: money });
      if (token === st.token) {
        st.list = sessionListNormalize(listRes, money);
        st.stats = sessionStatsNormalize(statsRes, money);
        st.asked = money;
      }
    } catch (err: any) {
      if (token === st.token)
        st.error = sessionText(err && err.message ? err.message : "erreur", 100);
    }
    st.loading -= 1;
    renderMenu();
  }

  /** One session's detail. In the view it opens next to the list (the list stays), inline it takes the list's place. */
  async function openDetail(sessionId: string) {
    if (!sessionId) return;
    const money = !!st.ctx.showBalance;
    const token = ++st.dtoken;
    clearExport(true);
    st.view = "detail";
    st.sel = sessionId;
    st.detail = null;
    st.loading += 1;
    st.error = "";
    renderMenu();
    try {
      const res = await api.call("sc_session_current", { id: sessionId, include_balance: money });
      if (token === st.dtoken) {
        st.detail = sessionDetailNormalize(res, money);
        st.asked = money;
      }
    } catch (err: any) {
      if (token === st.dtoken)
        st.error = sessionText(err && err.message ? err.message : "erreur", 100);
    }
    st.loading -= 1;
    renderMenu();
  }

  // ------------------------------------------------------------------------------ the Sessions view
  /** The view is shown (or left) by the page: on, it reads the sessions; off, it keeps no data and no text. */
  function setActive(on: boolean) {
    if (!tabMode || st.active === on) return;
    st.active = on;
    if (on) {
      st.open = true;
      st.view = "list";
      st.vmsg = "";
      renderMenu();
      void loadMenu();
    } else {
      clearExport(true);
      blankMenu();
      st.open = false;
      st.vmsg = "";
      renderMenu();
    }
  }

  function setFilter(f: string) {
    st.filter = f;
    st.rowConfirm = "";
    renderMenu();
  }

  const findSession = (id: string): any => {
    const l = st.list;
    if (l) for (const s of l.sessions) if (s.id === id) return s;
    return null;
  };
  const rowOf = (id: string): any => {
    for (const r of rows) if (r._id === id && r["_a_data-hidden"] !== "1") return r;
    return null;
  };

  /** Archive or unarchive: harmless (the session stays in the file), so no question. */
  async function onArchive(id: string) {
    const s = findSession(id);
    if (!s || s.status !== "ended" || st.rowBusy) return;
    await manageCall(s.archived ? "unarchive" : "archive", id);
  }

  /** Delete is for good: the question comes first, inline under the row, with a cancel and no timer. */
  function askDelete(id: string) {
    const s = findSession(id);
    if (!s || s.status !== "ended" || st.rowBusy) return;
    st.rowConfirm = id;
    st.vmsg = "";
    renderMenu();
    const r = rowOf(id);
    if (r) r.btnNo.focus();
  }

  function cancelDelete() {
    const id = st.rowConfirm;
    if (!id) return;
    st.rowConfirm = "";
    st.vmsg = "Suppression annulée : la session est conservée.";
    renderMenu();
    const r = rowOf(id);
    if (r) r.btnDel.focus();
  }

  async function doDelete(id: string) {
    if (st.rowConfirm !== id) return;
    await manageCall("delete", id);
  }

  /** The server does it (the session in progress is refused there too); the answer is said in the live region. */
  async function manageCall(action: string, id: string) {
    if (st.rowBusy) return;
    st.rowBusy = true;
    st.rowConfirm = "";
    st.vmsg = "Un instant…";
    // Where the player was in the list, so that the focus lands on the affected row (or its neighbour) afterwards.
    const shownRows = () => rows.filter((r: any) => r["_a_data-hidden"] !== "1");
    const at = shownRows().findIndex((r: any) => r._id === id);
    renderMenu();
    try {
      const r = await api.call("sc_session_manage", { id, action });
      st.vmsg = sessionManageText(action, r);
      if (r && r.reason === "done" && action === "delete" && st.sel === id) {
        // The detail of the deleted session goes with it (it may hold amounts).
        clearExport(true);
        st.view = "list";
        st.detail = null;
        st.sel = "";
        blankNodes();
      }
    } catch (err: any) {
      st.vmsg =
        "Action impossible : " + sessionText(err && err.message ? err.message : "erreur", 100);
    }
    try {
      await loadMenu();
      // The card's own list (when it is open) and the card itself may change (an archived session leaves the default list, the
      // last session archived or deleted leaves the card): tell the page, and ask for the bar again.
      if (api.changed) api.changed();
      if (api.refresh) await api.refresh();
    } catch {
      /* the next poll shows the truth */
    }
    st.rowBusy = false;
    renderMenu();
    // The focus goes to the row that was acted on (still there after a failure, an unchanged answer), else to the row that took
    // its place, else to the filter in force: never to the top of the view.
    const now = shownRows();
    const target =
      now.length > 0 ? now[Math.max(0, Math.min(at < 0 ? 0 : at, now.length - 1))] : null;
    const same = now.find((r: any) => r._id === id);
    if (same) (same.btnDel || same).focus();
    else if (target) target.focus();
    else for (const b of filterBtns) if (b._f === st.filter) b.focus();
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
          ? "Le bilan exporté contient des montants et les soldes de départ et final. Relis-le avant de le partager."
          : "Le bilan exporté contient des montants, mais pas les soldes de départ et final (le détail affiché plus bas, lui, les montre). Relis-le avant de le partager."
        : "Solde masqué : le bilan ne contient aucun montant (trajets, durées, SCU). Relis-le avant de le partager.",
    );
    setText(exportMsg, st.exportMsg);
    show(exportMsg, !!st.exportMsg);
    show(exportPre, st.exportText !== null);
    if (st.exportText === null) setText(exportPre, "");
  }

  // ------------------------------------------------------------------------------ rendering
  /** The buttons, the explanation line, the inline confirmation and the result line: all of them follow `st` and `st.info`. */
  function renderActions() {
    const info = st.info;
    const free = !!info && !st.busy && !st.confirm;
    show(btnEnd, free && !!info.canEnd);
    show(btnNew, free && !!info.canNew);
    if (info) {
      setText(btnNew, info.newLabel);
      const cls = "btn small" + (info.newPrimary ? " primary" : "");
      if (btnNew.className !== cls) btnNew.className = cls;
    }
    const c = st.confirm;
    show(confirmBox, !!c && !st.busy && !!info);
    if (c && info) {
      setText(confirmText, c.kind === "end" ? info.endAsk : info.newAsk);
      setText(btnYes, c.kind === "end" ? info.endYes : info.newYes);
    }
    setText(hint, info && !st.busy && !c ? info.hint : "");
    show(hint, !!(info && info.hint) && !st.busy && !c);
    setText(status, st.flash ? st.flash.text : "");
    setText(btnMenu, st.open ? "Sessions ▴" : "Sessions ▾");
    setAttr(btnMenu, "aria-expanded", st.open ? "true" : "false");
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
    // Money only while the balance is shown (a stale answer that still holds it is never drawn).
    const m = st.ctx.showBalance ? s.money : null;
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
    const fetched = l ? l.sessions : [];
    // The view filters the full list it asked for; the inline list is the latest few, archived ones left out by the server.
    const sessions = tabMode
      ? fetched.filter((s: any) => sessionFilterMatch(st.filter, s))
      : fetched;
    const limit = tabMode ? cfg.maxRows : cfg.latestRows;
    while (rows.length < Math.min(limit, sessions.length)) addRow();
    if (tabMode) {
      const counts = sessionFilterCounts(fetched);
      for (const b of filterBtns) {
        setText(b, b._label + " (" + counts[b._f] + ")");
        setAttr(b, "aria-pressed", st.filter === b._f ? "true" : "false");
      }
      setText(
        listEmpty,
        l && sessions.length === 0 && !st.loading ? "Aucune session dans ce filtre." : "",
      );
      show(listEmpty, !!l && sessions.length === 0 && !st.loading);
    } else {
      // The button appears only when there is more than the latest few; it opens the Sessions view for all of them.
      // It is also there when archived sessions exist: the view is the way to reach them.
      const total = l ? Math.max(l.total, fetched.length) : 0;
      const archived = l ? l.archived : 0;
      show(btnAll, total > cfg.latestRows || archived > 0);
      setText(
        btnAll,
        "Toutes les sessions (" +
          total +
          (archived > 0 ? " · " + archived + (archived > 1 ? " archivées" : " archivée") : "") +
          ")",
      );
    }
    for (let i = 0; i < rows.length; i++) {
      const s = i < limit ? sessions[i] : undefined;
      show(rows[i], !!s);
      show(rows[i]._wrap, !!s);
      if (!s) continue;
      const info = sessionRowInfo(L, s, !!st.ctx.showBalance, st.ctx.now);
      setText(rows[i].n, info.number);
      setText(rows[i].when, info.when);
      setText(rows[i].detail, info.detail);
      setText(rows[i].result, info.result);
      setText(rows[i].status, info.status);
      setAttr(rows[i].result, "data-tone", info.tone);
      setAttr(rows[i], "data-open", info.open ? "1" : "0");
      setAttr(
        rows[i],
        "aria-label",
        "Ouvrir la session " +
          s.number +
          " : " +
          info.when +
          ", " +
          info.detail +
          ", " +
          info.status,
      );
      rows[i]._id = s.id;
      if (tabMode) {
        const r = rows[i];
        const selected = st.sel === s.id && st.view === "detail";
        setAttr(r, "aria-pressed", selected ? "true" : "false");
        setAttr(r, "data-sel", selected ? "1" : "0");
        // The actions of a row: only an ENDED session has any (the one in progress is ended with "Terminer" first).
        const ended = s.status === "ended";
        show(r.acts, ended);
        setText(r.btnArch, s.archived ? "Désarchiver" : "Archiver");
        setAttr(
          r.btnArch,
          "aria-label",
          (s.archived ? "Désarchiver" : "Archiver") + " la session " + s.number,
        );
        setAttr(r.btnDel, "aria-label", "Supprimer la session " + s.number);
        const asking = st.rowConfirm === s.id;
        show(r.conf, ended && asking);
        // The game running and nothing before the last session that would hold the card (no earlier session, or one that did
        // not end by hand): the game starts another session as soon as this one is gone.
        const at = fetched.indexOf(s);
        const before = at >= 0 ? fetched[at + 1] : undefined;
        const comesBack =
          !!st.ctx.running && at === 0 && (!before || before.end_reason !== "manual");
        setText(r.confText, asking ? sessionDeleteAsk(s, comesBack) : "");
        setAttr(r.btnYes, "aria-label", "Confirmer la suppression de la session " + s.number);
      }
    }
  }

  function renderDetail() {
    const d = st.detail;
    show(detail, st.view === "detail");
    if (st.view !== "detail" || !d) return;
    const s = d.session;
    const m = st.ctx.showBalance ? s.money : null;
    setText(
      detailTitle,
      "Session " +
        s.number +
        (s.status === "ended" ? " (terminée)" : s.empty ? " (en cours, chrono)" : " (en cours)"),
    );
    const f: string[] = [];
    const how = s.ended_at ? sessionEndReasonText(s.end_reason) : "";
    f.push(
      "Début : " +
        sessionWhen(s.started_at, st.ctx.now) +
        (s.ended_at
          ? " · fin : " + sessionWhen(s.ended_at, st.ctx.now) + (how ? " (" + how + ")" : "")
          : ""),
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
    // Inline, the list and one session's detail take turns; in the view they are side by side (the list stays).
    const showList = tabMode || inList;
    const showDetail = !inList;
    show(list, showList);
    show(btnBack, showDetail && !tabMode);
    show(menuTitle, showList);
    show(detailHead, showDetail);
    show(stats, showList && !!st.stats);
    setText(
      menuMsg,
      st.loading ? "Chargement…" : st.error ? "Impossible de lire les sessions : " + st.error : "",
    );
    show(menuMsg, !!st.loading || !!st.error);
    if (tabMode) {
      show(filterBar, true);
      setText(viewStatus, st.vmsg);
      setText(
        archNote,
        sessionArchivedNote(
          st.stats ? st.stats.archived_not_counted : st.list ? st.list.archived : 0,
        ),
      );
    }
    if (showList) {
      renderStats();
      renderList();
    } else {
      show(btnAll, false);
    }
    if (showDetail) renderDetail();
    else show(detail, false);
    renderExport();
  }

  // Everything in the menu starts hidden: only an open menu draws anything.
  renderMenu();

  return {
    root,
    /** For the tests only. */
    state: () => st,
    /** The Sessions view only: the page shows it (reads the sessions) or leaves it (keeps nothing). */
    setActive,
    /** Puts the focus on the card's entry point (its folded line, or its "Sessions" button): where it goes when the tab bar goes. */
    focusEntry() {
      (st.fold ? one : btnMenu).focus();
    },
    /** The card's own list, if it is open, is read again (the Sessions view changed the saved sessions). */
    reload() {
      if (!tabMode && st.open && !st.loading) void loadMenu();
    },
    /** The page is going away: nothing of a report stays in it. */
    dropExport() {
      clearExport(true);
      blankMenu();
    },
    render(rawBar: any, ctx: any) {
      st.ctx = {
        showBalance: !!(ctx && ctx.showBalance),
        now: ctx && ctx.now ? ctx.now : 0,
        // The game is running (the stream is live): deleting the last session then lets it start another at once.
        running: !!(ctx && ctx.running),
      };
      // A report made with the other balance choice is not reused: it goes, and so does the start-balance choice.
      if ((st.exportText !== null || st.exportMsg) && st.exportMoney !== st.ctx.showBalance)
        clearExport(true);
      else if (!st.ctx.showBalance && st.exportBalances) st.exportBalances = false;
      // The balance is hidden again: nothing the menu drew with it stays in the page, even in nodes that are not shown.
      if (!st.ctx.showBalance && st.asked === true) {
        stripMoney();
        blankNodes();
      }
      const bar2 = sessionBarNormalize(rawBar, st.ctx.showBalance);
      const info = sessionBarInfo(L, bar2, st.ctx);
      st.info = info;
      if (tabMode) {
        // The Sessions view has no card: the page shows it or not (setActive). While it is shown it reads the sessions again
        // when the card's session changed (another View or the game started or ended one) or the balance choice did.
        const key = info.visible ? info.id + "|" + info.phase : "none";
        const changed = st.barKey !== null && key !== st.barKey;
        st.barKey = key;
        if (st.active && !st.loading && !st.rowBusy) {
          if (changed) void loadMenu();
          else if (st.asked !== null && st.asked !== st.ctx.showBalance) {
            void loadMenu();
            if (st.view === "detail" && st.detail) void openDetail(st.detail.session.id);
          }
        }
        if (st.open) renderMenu();
        return;
      }
      // What was asked of a session that is no longer the one on the card (another View ended it, the game started a new one,
      // the sessions went off) is dropped, and the player is told. A result about an older session goes once a newer one shows.
      const c = st.confirm;
      // (Both confirmations exist only for a session that holds something: the one that "Terminer" closes.)
      if (c && !st.busy && (!info.visible || info.id !== c.id || !info.closes)) {
        st.confirm = null;
        setFlash(
          "La session a changé pendant que tu hésitais : la confirmation est annulée, rien n’a été fait.",
          info.id,
        );
      }
      // The result line belongs to the session the card showed when the action finished: another one (a newer session, even
      // under the same number) takes it away.
      if (st.flash && (!info.visible || (st.flash.anchor !== null && info.id !== st.flash.anchor)))
        st.flash = null;
      show(root, info.visible);
      if (!info.visible) return;
      setAttr(root, "data-empty", info.empty ? "1" : "0");
      setAttr(root, "data-phase", info.phase);
      setAttr(root, "data-state", info.chipState || "");
      renderFold();
      setText(title, info.title);
      setText(chip, info.chip);
      show(chip, !!info.chip);
      setText(sub, info.sub);
      show(sub, !!info.sub);
      show(kpiBox, info.kpis.length > 0);
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
      renderActions();
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
  sessionPhase,
  sessionStateLabel,
  sessionEndReasonText,
  sessionEndedText,
  sessionTripsText,
  sessionIdleText,
  sessionNoticeText,
  sessionInterruptionLabel,
  sessionQualityLabel,
  sessionBarInfo,
  sessionActionText,
  sessionRowStatus,
  sessionFilterMatch,
  sessionFilterCounts,
  sessionDeleteAsk,
  sessionArchivedNote,
  sessionManageText,
  sessionRowInfo,
  sessionListNormalize,
  sessionAggregateSession,
  sessionStatsNormalize,
  sessionDetailNormalize,
  sessionExportText,
  sessionDebriefNormalize,
  sessionPanel,
];
