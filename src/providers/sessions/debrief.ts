import { calibrationKey } from "../../dashboard/calibrationPanel.js";
import { sessionInterruptionLabel, sessionQualityLabel } from "../../dashboard/sessionPanel.js";
import { stripInvisible } from "../../core/untrusted.js";
import type { CalibrationGroup, CalibrationReport } from "./calibration.js";
import {
  aggregate,
  effectiveResults,
  MIN_RATE_ACTIVE_MS,
  summarizeSession,
  type SessionSummary,
} from "./stats.js";
import { LABEL_MAX, MAX_TRIPS, NOTE_MAX, PLACE_MAX, type Session, type Trip } from "./types.js";

/**
 * The session debrief: a compact Markdown report and a CSV of the trips of one session (or of the last few), made to be
 * TAKEN OUT of the server (shared with a crew, kept as a log, pasted into a spreadsheet). PURE: sessions in, two strings
 * out, no clock, no file, no network, no locale (UTC times, own number grouping): the same input gives the same bytes.
 *
 * PRIVACY, by construction. Every aUEC figure is derived from the player's balance, so the amounts exist in the output
 * only when `includeMoney` is true (the caller was allowed the balance: the View shows it, or the tool got
 * include_balance). Without it the report is the non-monetary one (counts, durations, SCU, labels) and says so. In that
 * mode no money field of a session or of a trip is READ at all (see `moneyOf`), and the things that follow the money are
 * withheld with it: which trip was the best, the trips' methods and counted/excluded markers, the plan efficiency and the
 * route reliability (its confidence comes from the spread of the ratios). The start and last balance never appear unless
 * `includeBalances` is set too (a separate, explicit choice: the export is meant to be shared).
 *
 * No handle, account id, address, GUID, raw log line or path exists in the sessions (see types.ts); the free text that does
 * (labels, places, the note) is cleaned again here (invisible and direction-changing characters out, one line, bounded),
 * escaped for Markdown and neutralised for spreadsheets (CSV injection). Honest by design: an unknown figure stays
 * unknown (never 0), an estimate says so, and nothing is extrapolated (no trend).
 */

export const DEBRIEF_LIMITS = {
  /** Trips drawn in the Markdown table (the newest); the rest is counted and named in a note. */
  markdownRows: 100,
  /** Trips in the CSV (the newest); a session keeps at most 500 trips, so one session is always complete. */
  csvRows: 500,
  /** Characters of the Markdown table and of the CSV (hostile text at its longest must still be bounded). */
  markdownTableChars: 40_000,
  csvChars: 150_000,
  /** Sessions in one export. */
  sessions: 10,
  /** Interruptions listed per session. */
  breaks: 10,
  /** Route reliability lines. */
  reliabilityLines: 8,
} as const;

/**
 * The bound the registry applies to each string of a debrief answer (catalog.ts `maxText` of sc_session_debrief, a test keeps
 * them equal). Above the worst case the caps below allow, so a report is never cut by the envelope.
 */
export const DEBRIEF_MAX_TEXT = 400_000;

export interface DebriefOptions {
  /** The balance was allowed: aUEC figures are included. False: the non-monetary report. */
  includeMoney: boolean;
  /** Only with includeMoney: also the balance at the start and at the last sighting. Default false. */
  includeBalances?: boolean;
  /** The route calibration over the player's history. Used only with includeMoney. */
  calibration?: CalibrationReport | null;
  markdownRows?: number;
  csvRows?: number;
}

export interface Debrief {
  markdown: string;
  csv: string;
  /** Session numbers covered, oldest first. */
  sessions: number[];
  /** Trips (and contracts) of the covered sessions, each counted once. */
  trips_total: number;
  markdown_rows: number;
  csv_rows: number;
  /** True when the Markdown table or the CSV does not hold every trip. */
  truncated: boolean;
  money_included: boolean;
  balances_included: boolean;
}

// -------------------------------------------------------------------------------------------------
// Text: cleaning, Markdown escaping, CSV quoting
// -------------------------------------------------------------------------------------------------

const NBSP = "\u00a0";

/** One line of free text: invisible and direction-changing characters out, one line, at most `max` characters. */
export function debriefText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const clean = stripInvisible(value).replace(/\s+/g, " ").trim();
  return Array.from(clean).slice(0, max).join("");
}

/**
 * Free text for a Markdown line or table cell: HTML and Markdown syntax made literal. `<`, `>` and `&` become entities
 * (no HTML can be written), the characters that open emphasis, code, links, strikethrough, headings or a table cell are
 * backslash-escaped, and the three shapes that renderers turn into links on their own (a scheme, an address, www.) are
 * broken. The text is already one line (see debriefText).
 */
export function markdownText(value: unknown, max: number): string {
  return debriefText(value, max)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]|~#]/g, (c) => "\\" + c)
    .replace(/:(?=\/\/)/g, "\\:")
    .replace(/@/g, "\\@")
    .replace(/\bwww\./gi, (m) => m.slice(0, 3) + "\\.");
}

/**
 * One CSV text cell (RFC 4180 quoting). A cell a spreadsheet would read as a formula (it starts with = + - @, a tab or a
 * carriage return) is prefixed with an apostrophe, so it stays text. Numbers never go through here.
 */
export function csvText(value: unknown, max: number): string {
  let t = debriefText(value, max);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}

/** A number cell: a plain decimal, empty when unknown. */
export function csvNumber(value: number | null | undefined, decimals = 0): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const r = Number(value.toFixed(decimals));
  if (!Number.isSafeInteger(Math.round(r * 100))) return "";
  return String(r);
}

// -------------------------------------------------------------------------------------------------
// Numbers and times (own formatting: no Intl, no default locale)
// -------------------------------------------------------------------------------------------------

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** 1234567 -> "1 234 567" (no-break spaces); "-" for a negative one. Unknown is the caller's word, never this. */
export function fmtInt(n: number): string {
  const r = Math.round(n);
  return (r < 0 ? "-" : "") + group(String(Math.abs(r)));
}

function fmtDec(n: number, decimals: number): string {
  const fixed = Math.abs(n).toFixed(decimals);
  const [i, f] = fixed.split(".") as [string, string | undefined];
  const body = group(i!) + (f ? "," + f : "");
  return (n < 0 && Number(fixed) !== 0 ? "-" : "") + body;
}

const aUEC = (n: number) => fmtInt(n) + NBSP + "aUEC";

/** "2 h 50 min", "12 min", "45 s"; the caller says "inconnu" for what it does not know. */
function dur(ms: number): string {
  const total = Math.round(Math.max(0, ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => (n < 10 ? "0" + n : String(n));
  if (h > 0) return `${h} h ${two(m)} min`;
  if (m > 0) return `${m} min ${two(s)} s`;
  return `${s} s`;
}

function utc(iso: string | null): string {
  const t = iso === null ? NaN : Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "?";
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function isoSec(iso: string | null): string {
  const t = iso === null ? NaN : Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 19) + "Z";
}

const pct = (ratio: number) => Math.round(ratio * 100) + NBSP + "%";
const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

// -------------------------------------------------------------------------------------------------
// Rows
// -------------------------------------------------------------------------------------------------

/** What one trip holds of money. Built ONLY when the balance was allowed; otherwise it does not exist. */
interface TripMoney {
  cost: number | null;
  revenue: number | null;
  grossMargin: number | null;
  fees: number | null;
  feesMethod: Trip["fees_method"];
  net: number | null;
  netKind: Trip["net_kind"];
  planned: number | null;
  planLink: Trip["plan_link"];
  unexplained: number | null;
  doubtful: boolean | null;
}

/** A finite number, else unknown (the schema forbids anything else; this keeps the formatter total on its own). */
const fin = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);

function moneyOf(t: Trip): TripMoney {
  return {
    cost: fin(t.cost_auec),
    revenue: fin(t.revenue_auec),
    grossMargin: fin(t.gross_margin_auec),
    fees: fin(t.fees_auec),
    feesMethod: t.fees_method,
    net: fin(t.net_auec),
    netKind: t.net_kind,
    planned: fin(t.planned_profit_auec),
    planLink: t.plan_link,
    unexplained: fin(t.unexplained_auec),
    doubtful: t.net_doubtful,
  };
}

interface Row {
  session: number;
  kind: Trip["kind"];
  endedAt: string;
  endedMs: number;
  key: string;
  label: string;
  commodity: string;
  buy: string;
  sell: string;
  scu: number | null;
  /** A contract whose balance change overlapped a cargo run: its result is not counted (the run holds it). */
  excluded: boolean;
  /** Present only with includeMoney. */
  m: TripMoney | null;
  planBuy: string;
  planSell: string;
}

const placeOf = (v: unknown) => debriefText(v, PLACE_MAX);

function rowsOf(s: Session, includeMoney: boolean): { rows: Row[]; duplicates: number } {
  const rows: Row[] = [];
  let duplicates = 0;
  for (const e of effectiveResults(s.trips)) {
    if (e.duplicate) {
      duplicates += 1;
      continue;
    }
    const t = e.trip;
    const endedMs = Date.parse(t.ended_at);
    rows.push({
      session: s.number,
      kind: t.kind,
      endedAt: t.ended_at,
      endedMs: Number.isFinite(endedMs) ? endedMs : 0,
      key: typeof t.key === "string" ? t.key : "",
      label: debriefText(t.label, LABEL_MAX),
      commodity: placeOf(t.commodity),
      buy: placeOf(t.buy_terminal),
      sell: placeOf(t.sell_terminal),
      scu: typeof t.scu === "number" && Number.isFinite(t.scu) ? t.scu : null,
      // Which contracts were left out of the total depends on the balance figures: said only with them.
      excluded: includeMoney && e.excluded,
      m: includeMoney ? moneyOf(t) : null,
      planBuy: includeMoney ? placeOf(t.plan_buy_terminal) : "",
      planSell: includeMoney ? placeOf(t.plan_sell_terminal) : "",
    });
  }
  // Oldest first, a full tie-break so that the order never depends on the order of the input.
  rows.sort((a, b) => a.endedMs - b.endedMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { rows, duplicates };
}

const KIND_WORD: Record<Trip["kind"], string> = {
  trade: "Cargaison",
  hauling: "Transport",
  contract: "Contrat",
};
const kindWord = (k: unknown) => KIND_WORD[k as Trip["kind"]] ?? "Trajet";

type Method = "measured" | "computed" | "estimated" | "unknown";

const FR_METHOD: Record<Method, string> = {
  measured: "mesuré",
  computed: "calculé",
  estimated: "estimé",
  unknown: "inconnu",
};

function netMethod(m: TripMoney): Method {
  if (m.net === null) return "unknown";
  return m.netKind === "balance_delta"
    ? "measured"
    : m.netKind === "transactions"
      ? "computed"
      : "unknown";
}

function feesMethod(m: TripMoney): Method {
  if (m.fees === null) return "unknown";
  return m.feesMethod === "mesure"
    ? "measured"
    : m.feesMethod === "estime"
      ? "estimated"
      : "unknown";
}

// -------------------------------------------------------------------------------------------------
// The report
// -------------------------------------------------------------------------------------------------

const DASH = "—";

function sessionHeader(
  s: Session,
  sum: SessionSummary,
  opts: { money: boolean; balances: boolean },
): string[] {
  const out: string[] = [];
  const state =
    s.ended_at === null
      ? "en cours"
      : s.end_reason === "manual"
        ? "terminée à la demande du joueur"
        : s.end_reason === "new_session"
          ? "terminée par une nouvelle session"
          : s.end_reason === "gap"
            ? "terminée après une longue inactivité"
            : "terminée";
  out.push(`## Session ${sum.number} (${state})`);
  const endIso = s.ended_at ?? s.last_activity_at;
  out.push(
    `- Début : ${utc(s.started_at)} · ${s.ended_at === null ? "dernière activité" : "fin"} : ${utc(endIso)} · durée totale ${dur(sum.duration_ms)}`,
  );
  out.push(
    `- Temps de jeu (jeu vu en cours d’exécution par le serveur) : ${sum.active_ms > 0 ? dur(sum.active_ms) : "inconnu"}`,
  );
  const version = debriefText(s.game_version, 40);
  const channel = s.game_channel && s.game_channel !== "unknown" ? s.game_channel : "";
  if (version || channel)
    out.push(
      `- Jeu : ${markdownText(version, 40) || "version inconnue"}${channel ? ` · canal ${channel}` : ""}`,
    );
  else out.push("- Jeu : version et canal inconnus");
  if (s.interruptions.length > 0) {
    out.push(
      `- Coupures : ${s.interruptions.length}. Le temps coupé n’est pas compté dans le temps de jeu.`,
    );
    for (const b of s.interruptions.slice(-DEBRIEF_LIMITS.breaks)) {
      const ms = Date.parse(b.to) - Date.parse(b.from);
      out.push(
        `  - ${utc(b.from)} → ${utc(b.to)}${Number.isFinite(ms) ? ` (${dur(ms)})` : ""} : ${sessionInterruptionLabel(b.kind)}`,
      );
    }
    if (s.interruptions.length > DEBRIEF_LIMITS.breaks)
      out.push(
        `  - … ${s.interruptions.length - DEBRIEF_LIMITS.breaks} coupure(s) plus ancienne(s) non listée(s)`,
      );
  }
  if (opts.money && opts.balances) {
    const q = sessionQualityLabel(s.start_balance_quality);
    out.push(
      `- Solde : ${s.start_balance === null ? "inconnu" : aUEC(s.start_balance)} au départ${q ? ` (${q})` : ""} → ${s.last_balance === null ? "inconnu" : aUEC(s.last_balance)} au dernier relevé`,
    );
  }
  const note = markdownText(s.note, NOTE_MAX);
  if (note) out.push(`- Note du joueur : ${note}`);
  return out;
}

function headline(
  sum: SessionSummary,
  rows: Row[],
  opts: { money: boolean },
): { lines: string[]; unexplained: string[] } {
  const lines: string[] = [];
  const unexplained: string[] = [];
  // Counted from the rows listed below (a run stored twice is one): the headline and the table agree.
  const tripsN = rows.filter((r) => r.kind !== "contract").length;
  const contractsN = rows.length - tripsN;
  const rated = tripsN > 0 && sum.active_ms >= MIN_RATE_ACTIVE_MS;
  const perHour = rated ? Math.round((tripsN / (sum.active_ms / 3_600_000)) * 10) / 10 : null;
  const minPerTrip = rated ? Math.round((sum.active_ms / tripsN / 60_000) * 10) / 10 : null;
  lines.push(
    `- Trajets : ${tripsN}${contractsN > 0 ? ` (+ ${contractsN} ${plural(contractsN, "autre contrat", "autres contrats")})` : ""}` +
      (perHour !== null ? ` · ${fmtDec(perHour, 1)} par heure` : "") +
      (minPerTrip !== null
        ? ` · ≈${NBSP}${fmtDec(minPerTrip, 1)} min par trajet (estimé : temps de jeu divisé par les trajets)`
        : ""),
  );
  const withScu = rows.filter((r) => r.scu !== null);
  if (rows.length > 0) {
    const total = withScu.reduce((a, r) => a + (r.scu as number), 0);
    lines.push(
      withScu.length > 0
        ? `- SCU déplacés : ${fmtDec(total, total % 1 === 0 ? 0 : 1)} (connu pour ${withScu.length} trajet(s) sur ${rows.length})`
        : "- SCU déplacés : inconnu",
    );
  }
  if (sum.trips_dropped > 0)
    unexplained.push(
      `${sum.trips_dropped} trajet(s) plus ancien(s) ont été retirés du fichier de sessions (limite de ${MAX_TRIPS} par session) : ils ne sont ni dans le tableau ni dans les totaux.`,
    );
  if (!opts.money) {
    lines.push(
      "- Montants (résultat, marge, frais, rythme en aUEC/h) : masqués. Ils viennent du solde du joueur, qui n’a pas été partagé pour ce bilan.",
    );
    return { lines, unexplained };
  }
  const m = sum.money;
  const grossOnly = m.net_source === "trips" && m.measured_net_auec === null;
  const known = rows.filter(
    (r) => r.m !== null && !r.excluded && (r.m.net ?? r.m.grossMargin) !== null,
  ).length;
  const netLabel =
    m.net_source === "balance"
      ? "Variation du solde"
      : grossOnly
        ? "Marge brute des cargaisons (hors frais, ce n’est pas un net)"
        : "Résultat des trajets";
  if (m.net_auec === null) lines.push("- Résultat : inconnu");
  else {
    const parts: string[] = [];
    if (m.net_source === "trips" && m.net_complete === false)
      parts.push(`partiel : ${known} résultat(s) connu(s) sur ${rows.length}`);
    if (m.net_source === "trips" && m.gross_only_trips > 0 && !grossOnly)
      parts.push(`${m.gross_only_trips} en marge brute, hors frais`);
    parts.push(
      m.net_source === "balance"
        ? "mesure brute du solde, achats et amendes inclus"
        : grossOnly
          ? "calculé : revenu moins coût du journal"
          : "mesuré ou calculé trajet par trajet, voir la méthode dans le tableau",
    );
    lines.push(`- ${netLabel} : ${aUEC(m.net_auec)} (${parts.join(" ; ")})`);
  }
  lines.push(
    `- Par heure de jeu : ${
      m.net_per_hour_auec === null
        ? "inconnu (il faut au moins 10 min de jeu et un résultat)"
        : `${aUEC(m.net_per_hour_auec)}/h`
    }`,
  );
  if (m.gross_margin_auec !== null)
    lines.push(
      `- Marge brute des cargaisons : ${aUEC(m.gross_margin_auec)} (calculé : revenu moins coût, hors frais)`,
    );
  if (m.turnover_auec !== null || m.cost_auec !== null)
    lines.push(
      `- Chiffre d’affaires : ${m.turnover_auec === null ? "inconnu" : aUEC(m.turnover_auec)} · coût : ${m.cost_auec === null ? "inconnu" : aUEC(m.cost_auec)}`,
    );
  const feeKinds = rows.filter((r) => r.m !== null && r.m.fees !== null);
  const tradeRows = rows.filter((r) => r.kind === "trade");
  if (m.fees_auec !== null)
    lines.push(
      `- Frais : ${aUEC(m.fees_auec)}` +
        (feeKinds.length < tradeRows.length
          ? ` (partiel : connus pour ${feeKinds.length} cargaison(s) sur ${tradeRows.length})`
          : ""),
    );
  else if (tradeRows.length > 0) lines.push("- Frais : inconnus");
  if (m.best_trip) {
    const name =
      markdownText(m.best_trip.label ?? m.best_trip.commodity ?? "", LABEL_MAX) || "sans titre";
    lines.push(
      `- Meilleur trajet : ${name} · ${aUEC(m.best_trip.net_auec)}${m.best_trip.gross ? " (marge brute, hors frais)" : ""}`,
    );
  }
  if (m.plan) {
    lines.push(
      m.plan.efficiency === null
        ? `- Efficacité face au plan : inconnue (${m.plan.trips} trajet(s) avec un plan, profit prévu nul)`
        : `- Efficacité face au plan : ${pct(m.plan.efficiency)} (${aUEC(m.plan.measured_auec)} mesurés pour ${aUEC(m.plan.planned_auec)} prévus, ${m.plan.trips} ${plural(m.plan.trips, "trajet", "trajets")}). Estimation : le profit prévu vient de prix UEX collaboratifs.` +
            (m.plan.price_linked_trips > 0
              ? ` Dont ${m.plan.price_linked_trips} rattaché(s) au plan par les prix : marchandise non vérifiée (lien par prix).`
              : ""),
    );
  }
  // What the figures do not explain.
  if (m.overlap_excluded > 0)
    unexplained.push(
      `${m.overlap_excluded} contrat(s) dont la variation du solde chevauche une cargaison ne sont pas comptés dans le total (la cargaison les contient déjà).`,
    );
  if (m.gross_only_trips > 0)
    unexplained.push(
      `${m.gross_only_trips} trajet(s) comptent leur marge brute seulement : les frais de chargement, le carburant et les autres coûts n’y sont pas.`,
    );
  const unknownResults = rows.length - known - rows.filter((r) => r.excluded).length;
  if (unknownResults > 0)
    unexplained.push(
      `${unknownResults} trajet(s) ou contrat(s) n’ont pas de résultat connu : ils ne comptent pas dans le total.`,
    );
  const unexplainedSum = rows.reduce<number | null>(
    (a, r) => (r.m !== null && r.m.unexplained !== null ? (a ?? 0) + r.m.unexplained : a),
    null,
  );
  if (unexplainedSum !== null && Math.round(unexplainedSum) !== 0)
    unexplained.push(
      `Écart entre la variation du solde, la marge brute et les frais des cargaisons : ${aUEC(unexplainedSum)} au total (un achat fait ailleurs, une récompense, une amende... la cause n’est pas connue).`,
    );
  const doubtful = rows.filter((r) => r.m !== null && r.m.doubtful === true).length;
  if (doubtful > 0)
    unexplained.push(
      `${doubtful} net(s) sont signalés douteux : ils contiennent probablement un mouvement du solde étranger au trajet.`,
    );
  if (
    m.net_source === "trips" &&
    m.balance_change_auec !== null &&
    m.net_auec !== null &&
    Math.round(m.balance_change_auec - m.net_auec) !== 0
  )
    unexplained.push(
      `La variation du solde sur la session (${aUEC(m.balance_change_auec)}) diffère du résultat des trajets de ${aUEC(m.balance_change_auec - m.net_auec)} : achats, réparations, amendes, récompenses ou trajets non vus. La cause n’est pas connue.`,
    );
  return { lines, unexplained };
}

const CONFIDENCE_WORD: Record<string, string> = {
  none: "aucune",
  low: "faible",
  medium: "moyenne",
  high: "élevée",
};

function reliabilityLine(g: CalibrationGroup): string {
  const where =
    g.kind === "route"
      ? `${markdownText(g.commodity, PLACE_MAX)}, ${markdownText(g.buy_terminal ?? "?", PLACE_MAX)} → ${markdownText(g.sell_terminal ?? "?", PLACE_MAX)}`
      : markdownText(g.commodity, PLACE_MAX);
  const conf = CONFIDENCE_WORD[g.confidence] ?? "faible";
  const caveat = g.goods_unverified ? " Marchandise non vérifiée (lien par prix)." : "";
  if (g.n < 2 || g.gross_ratio === null)
    return `- ${where} : n = ${g.n}, trop peu de trajets pour un chiffre (confiance ${conf}).${caveat}`;
  const ratio =
    Math.abs(g.gross_ratio) > 5
      ? "écart très élevé entre le réalisé (marge brute) et le prévu"
      : `réalisé ≈ ${pct(g.gross_ratio)} du prévu (marge brute)`;
  const fees =
    g.fee_rate !== null
      ? ` Frais ≈ ${pct(g.fee_rate)} du chiffre d’affaires (n = ${g.fee_n}).`
      : "";
  const cap = g.confidence_capped ? " Confiance plafonnée à « moyenne »." : "";
  return `- ${where} : ${ratio}, n = ${g.n}, confiance ${conf} (estimation).${fees}${caveat}${cap}`;
}

/** The reliability groups that speak of what this export holds: its goods, and its routes when the plan named them. */
function reliabilityFor(
  rows: readonly Row[],
  report: CalibrationReport | null | undefined,
): string[] {
  if (!report) return [];
  const goods = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.kind !== "trade" || r.commodity === "") continue;
    const ck = calibrationKey(r.commodity);
    if (ck === "") continue;
    const routes = goods.get(ck) ?? new Set<string>();
    const b = calibrationKey(r.planBuy);
    const s = calibrationKey(r.planSell);
    if (b !== "" && s !== "") routes.add(`${b}|${s}`);
    goods.set(ck, routes);
  }
  const picked: CalibrationGroup[] = [];
  for (const [ck, routes] of [...goods.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const own = report.groups.filter((g) => calibrationKey(g.commodity) === ck);
    const routeGroups = own.filter(
      (g) =>
        g.kind === "route" &&
        g.n >= 2 &&
        routes.has(`${calibrationKey(g.buy_terminal)}|${calibrationKey(g.sell_terminal)}`),
    );
    const commodity = own.find((g) => g.kind === "commodity");
    if (routeGroups.length > 0) picked.push(...routeGroups);
    else if (commodity) picked.push(commodity);
  }
  return picked.slice(0, DEBRIEF_LIMITS.reliabilityLines).map(reliabilityLine);
}

function tripCell(r: Row, money: boolean): string {
  const name = markdownText(r.label || r.commodity, LABEL_MAX) || "sans titre";
  const route =
    r.buy || r.sell
      ? `${markdownText(r.buy || "?", PLACE_MAX)} → ${markdownText(r.sell || "?", PLACE_MAX)}`
      : "";
  const link = money && r.m !== null && r.m.planLink === "prices" ? "plan lié par les prix" : "";
  return [kindWord(r.kind), name, route, link].filter((x) => x).join(" · ");
}

function moneyCell(value: number | null, applicable: boolean, method?: Method): string {
  if (!applicable) return DASH;
  if (value === null) return "inconnu";
  if (method === undefined) return fmtInt(value);
  return `${fmtInt(value)} (${method === "unknown" ? "origine non précisée" : FR_METHOD[method]})`;
}

function tableRow(r: Row, money: boolean, multi: boolean): string {
  const cells: string[] = [];
  if (multi) cells.push(String(r.session));
  cells.push(utc(r.endedAt).replace(" UTC", ""));
  cells.push(tripCell(r, money));
  cells.push(r.scu === null ? "inconnu" : fmtDec(r.scu, r.scu % 1 === 0 ? 0 : 1));
  if (money && r.m !== null) {
    const trade = r.kind === "trade";
    const m = r.m;
    cells.push(moneyCell(m.cost, trade));
    cells.push(moneyCell(m.revenue, trade));
    cells.push(moneyCell(m.grossMargin, trade, "computed"));
    cells.push(moneyCell(m.fees, trade, feesMethod(m)));
    cells.push(
      r.excluded ? "non compté (chevauche une cargaison)" : moneyCell(m.net, true, netMethod(m)),
    );
  }
  return "| " + cells.join(" | ") + " |";
}

function tableHeader(money: boolean, multi: boolean): string[] {
  const cols: [string, boolean][] = [
    ...(multi ? ([["Session", false]] as [string, boolean][]) : []),
    ["Fin (UTC)", false],
    ["Trajet", false],
    ["SCU", true],
    ...(money
      ? ([
          ["Coût", true],
          ["Revenu", true],
          ["Marge brute", true],
          ["Frais", true],
          ["Net", true],
        ] as [string, boolean][])
      : []),
  ];
  return [
    "| " + cols.map((c) => c[0]).join(" | ") + " |",
    "|" + cols.map((c) => (c[1] ? " ---: |" : " --- |")).join(""),
  ];
}

// -------------------------------------------------------------------------------------------------
// The CSV
// -------------------------------------------------------------------------------------------------

export const CSV_COLUMNS_BASE = [
  "session",
  "ended_at",
  "kind",
  "label",
  "commodity",
  "buy_terminal",
  "sell_terminal",
  "scu",
] as const;
export const CSV_COLUMNS_MONEY = [
  "cost_auec",
  "revenue_auec",
  "gross_margin_auec",
  "fees_auec",
  "fees_method",
  "net_auec",
  "net_method",
  "counted",
  "planned_profit_auec",
  "plan_link",
] as const;

function csvRow(r: Row, money: boolean): string {
  const cells: string[] = [
    String(r.session),
    isoSec(r.endedAt),
    r.kind,
    csvText(r.label, LABEL_MAX),
    csvText(r.commodity, PLACE_MAX),
    csvText(r.buy, PLACE_MAX),
    csvText(r.sell, PLACE_MAX),
    csvNumber(r.scu, 2),
  ];
  if (money && r.m !== null) {
    const m = r.m;
    cells.push(
      csvNumber(m.cost),
      csvNumber(m.revenue),
      csvNumber(m.grossMargin),
      csvNumber(m.fees),
      m.fees === null && r.kind !== "trade" ? "" : feesMethod(m),
      // A contract whose balance change is already inside a cargo run is exported with no net (so that a sum of the
      // column is the session's total) and says why.
      r.excluded ? "" : csvNumber(m.net),
      r.excluded ? "excluded_overlap" : netMethod(m),
      r.excluded ? "no" : "yes",
      csvNumber(m.planned),
      m.planLink ?? "",
    );
  }
  return cells.join(",");
}

// -------------------------------------------------------------------------------------------------
// Assembly
// -------------------------------------------------------------------------------------------------

/**
 * A session as the report may see it when the balance was not allowed: the non-money fields are copied BY NAME and every
 * money field is null, so nothing downstream (the stats, the rows, a later edit of this file) can leak an amount by mistake.
 */
function withoutMoneyFields(s: Session): Session {
  return {
    ...s,
    start_balance: null,
    start_balance_at: null,
    start_balance_quality: null,
    last_balance: null,
    last_balance_at: null,
    trips: s.trips.map((t): Trip => ({
      key: t.key,
      kind: t.kind,
      source: t.source,
      started_at: t.started_at,
      ended_at: t.ended_at,
      label: t.label,
      commodity: t.commodity,
      buy_terminal: t.buy_terminal,
      sell_terminal: t.sell_terminal,
      scu: t.scu,
      cost_auec: null,
      revenue_auec: null,
      fees_auec: null,
      gross_margin_auec: null,
      net_auec: null,
      net_kind: null,
      planned_profit_auec: null,
      planned_scu: null,
      plan_buy_terminal: null,
      plan_sell_terminal: null,
      plan_link: null,
      unexplained_auec: null,
      net_doubtful: null,
      fees_method: null,
    })),
  };
}

/** The newest items of a list, at most `maxItems` and as many as fit in `maxChars` once rendered (at least one). */
function newest<T>(
  items: readonly T[],
  render: (x: T) => string,
  maxItems: number,
  maxChars: number,
): T[] {
  const out: T[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0 && out.length < maxItems; i--) {
    const len = render(items[i]!).length + 2;
    if (out.length > 0 && used + len > maxChars) break;
    used += len;
    out.unshift(items[i]!);
  }
  return out;
}

export function buildDebrief(sessions: readonly Session[], options: DebriefOptions): Debrief {
  const money = options.includeMoney === true;
  const balances = money && options.includeBalances === true;
  const mdCap = Math.max(1, Math.floor(options.markdownRows ?? DEBRIEF_LIMITS.markdownRows));
  const csvCap = Math.max(1, Math.floor(options.csvRows ?? DEBRIEF_LIMITS.csvRows));
  const picked = [...sessions]
    .map((s) => (money ? s : withoutMoneyFields(s)))
    .sort((a, b) => a.number - b.number || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(-DEBRIEF_LIMITS.sessions);
  const multi = picked.length > 1;

  const built = picked.map((s) => {
    const sum = summarizeSession(s);
    const { rows, duplicates } = rowsOf(s, money);
    return { s, sum, rows, duplicates };
  });
  const allRows = built.flatMap((b) => b.rows);
  const duplicates = built.reduce((a, b) => a + b.duplicates, 0);

  const header = [...CSV_COLUMNS_BASE, ...(money ? CSV_COLUMNS_MONEY : [])].join(",");
  const csvRows = newest(allRows, (r) => csvRow(r, money), csvCap, DEBRIEF_LIMITS.csvChars);
  const csv = [header, ...csvRows.map((r) => csvRow(r, money))].join("\r\n") + "\r\n";
  const shown = newest(
    allRows,
    (r) => tableRow(r, money, multi),
    mdCap,
    DEBRIEF_LIMITS.markdownTableChars,
  );

  const md: string[] = [];
  md.push(
    picked.length === 0
      ? "# Bilan de session"
      : multi
        ? `# Bilan : ${picked.length} sessions (n°${NBSP}${picked[0]!.number} à ${picked[picked.length - 1]!.number})`
        : `# Bilan de la session ${picked[0]!.number}`,
  );
  md.push("");
  md.push(
    "_Rapport local de sc-copilot-mcp, tiré de la télémétrie du jeu et du journal de jeu de ce PC. Heures en UTC._",
  );
  md.push("");
  if (picked.length === 0) {
    md.push("Aucune session à résumer.");
    md.push("");
  }

  if (multi) {
    const agg = aggregate(picked);
    md.push("## Total");
    md.push(
      `- ${agg.sessions} sessions · ${agg.trips} trajets${agg.contracts > 0 ? ` (+ ${agg.contracts} autres contrats)` : ""} · ${dur(agg.active_ms)} de jeu` +
        (agg.trips_per_hour !== null
          ? ` · ${fmtDec(agg.trips_per_hour, 1)} trajets par heure`
          : ""),
    );
    if (money) {
      const m = agg.money;
      md.push(
        `- Somme des résultats des sessions : ${m.net_auec === null ? "inconnue" : aUEC(m.net_auec)} · moyenne par heure de jeu : ${m.avg_net_per_hour_auec === null ? "inconnue" : `${aUEC(m.avg_net_per_hour_auec)}/h`}`,
      );
    } else {
      md.push("- Montants : masqués (ils viennent du solde du joueur).");
    }
    md.push("");
  }

  const unexplainedAll: string[] = [];
  for (const b of built) {
    md.push(...sessionHeader(b.s, b.sum, { money, balances }));
    md.push("");
    md.push("### Chiffres clés");
    const h = headline(b.sum, b.rows, { money });
    md.push(...h.lines);
    md.push("");
    for (const u of h.unexplained)
      unexplainedAll.push(multi ? `Session ${b.sum.number} : ${u}` : u);
    const unclean = b.s.interruptions.filter((i) => i.kind === "unclean").length;
    if (unclean > 0)
      unexplainedAll.push(
        `${multi ? `Session ${b.sum.number} : ` : ""}${unclean} coupure(s) sans marqueur de fin (plantage, redémarrage du PC ou serveur arrêté) : ce qui s’est passé pendant ce temps n’est pas connu.`,
      );
  }

  if (money) {
    const rel = reliabilityFor(allRows, options.calibration);
    if (rel.length > 0) {
      md.push("## Fiabilité des routes (estimation)");
      md.push(
        "_Réalisé contre prévu, tiré de tes propres trajets enregistrés (au plus 8 par marchandise ou route). Peu de trajets veut dire peu de confiance. Aucune cause n’est avancée._",
      );
      md.push(...rel);
      md.push("");
    }
  } else {
    md.push("## Fiabilité des routes");
    md.push("Masquée : elle se déduit du solde du joueur.");
    md.push("");
  }

  // The table.
  md.push("## Trajets");
  if (allRows.length === 0) {
    md.push("Aucun trajet enregistré.");
  } else {
    if (shown.length < allRows.length)
      md.push(
        `_${shown.length} derniers trajets sur ${allRows.length} : les ${allRows.length - shown.length} plus anciens sont omis ici${csvRows.length === allRows.length ? " (le CSV les contient)" : ""}._`,
      );
    md.push(...tableHeader(money, multi));
    for (const r of shown) md.push(tableRow(r, money, multi));
    if (money)
      md.push(
        `_${DASH} : sans objet pour ce type de trajet. « inconnu » : non relevé, jamais compté comme zéro._`,
      );
  }
  md.push("");

  if (duplicates > 0)
    unexplainedAll.push(
      `${duplicates} trajet(s) enregistré(s) deux fois (ancien fichier) ne sont listés qu’une fois.`,
    );
  md.push("## Ce qui n’est pas expliqué");
  if (unexplainedAll.length === 0) md.push("Rien à signaler dans les données de ce bilan.");
  else for (const u of unexplainedAll) md.push(`- ${u.trim()}`);
  md.push("");

  // The plain footer.
  md.push("## Lecture");
  md.push(
    "- **Mesuré** : la variation du solde du joueur (télémétrie du jeu) et les heures où le jeu a été vu en cours d’exécution. **Calculé** : une marge brute (revenu moins coût) ou un net (marge moins frais) tiré du journal de jeu. **Estimé** : le temps par trajet, les frais déduits, l’efficacité face au plan et la fiabilité des routes. **Inconnu** : non relevé, jamais remplacé par zéro.",
  );
  md.push(
    "- Les prix UEX sont collaboratifs (déclarés par des joueurs, parfois anciens) : un profit prévu est une estimation. Le journal de jeu ne nomme pas les marchandises : un plan rattaché à un trajet par les prix lui ressemble, ce n’est pas une preuve. Un achat, une amende ou une réparation faits entre deux trajets se mêlent à une variation du solde.",
  );
  if (money)
    md.push(
      balances
        ? "- Ce bilan contient des montants et, à ta demande, les soldes de départ et du dernier relevé. Relis-le avant de le partager."
        : "- Ce bilan contient des montants, mais pas les soldes de départ ni du dernier relevé. Relis-le avant de le partager.",
    );
  else
    md.push(
      "- Ce bilan ne contient aucun montant en aUEC : afficher le solde dans le tableau de bord, ou autoriser include_balance, pour l’obtenir avec les chiffres d’argent.",
    );
  md.push(
    "- Aucun pseudo, identifiant de compte, adresse, ligne brute du journal ni chemin de fichier n’y figure.",
  );

  const truncated = shown.length < allRows.length || csvRows.length < allRows.length;

  return {
    markdown: md.join("\n") + "\n",
    csv,
    sessions: picked.map((s) => s.number),
    trips_total: allRows.length,
    markdown_rows: shown.length,
    csv_rows: csvRows.length,
    truncated,
    money_included: money,
    balances_included: balances,
  };
}
