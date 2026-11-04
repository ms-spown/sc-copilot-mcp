import type { LegView, TripOption } from "../providers/uex/tripPlanner.js";
import { fmtNum } from "./viewLogic.js";

/**
 * "How far can this route card be trusted?", in French, written on the SERVER from the planner's own data.
 *
 * The planner ranks routes by an estimated profit per hour. That figure rests on assumptions (a UEX price nobody reported, the
 * whole displayed stock bought at its current price, a fixed time per stop). This module turns what the planner already knows
 * about each leg into
 *   - a LEVEL for the evidence behind the prices (the rule is below, explicit and tested),
 *   - the few most decisive REASONS, each with the source and, where it has one, the age of the fact,
 *   - a prudent first run ("trajet de test") sized from the same per-SCU figures,
 *   - a fixed sentence on what the estimate leaves out.
 *
 * Nothing here is a guarantee and nothing says a route is safe or good: the words are heuristic ("ressemble à", "UEX prévient").
 * Nothing here invents a signal: a field the planner did not read is null, and a null never produces a reason, never counts as a
 * report, and never lifts the level. The players' balance is not read; a plan sized from it (`private`) keeps its cost out.
 *
 * LEVEL (evidence behind the prices only; the other caveats are reasons, they do not move it). An "end" is one price of one leg:
 * the buy price at the origin, the sell price at the destination. A round trip has four.
 *   reported  every end rests on at least one player report, and none is older than RELIABLE_MAX_AGE_DAYS;
 *   partial   some ends rest on player reports and some do not (or are unknown), or all do but one price is older than that;
 *   estimate  no end has a player report and UEX counts 0 on at least one: the prices are UEX estimates;
 *   unchecked no end could be checked (the report check failed, was skipped, or the option comes without it).
 * `evidence_rank` orders them 3 / 2 / 1 / 0, for the "Mieux vérifiée" marker.
 */

export type ReliabilityLevel = "reported" | "partial" | "estimate" | "unchecked";

export type ReasonCode =
  | "unchecked"
  | "no_reports"
  | "sell_ceiling"
  | "whole_stock"
  | "same_orbit"
  | "sale_pressure"
  | "old_prices"
  | "no_quantum_speed"
  | "commodity_unreported";

export interface ReliabilityReason {
  code: ReasonCode;
  text: string;
  /** Where the fact comes from and how old it is ("UEX · prix mis à jour il y a 2,9 j"). */
  source: string;
}

export interface TrialTrip {
  /** Quantity of each leg for the test, in SCU. */
  scu: number[];
  /** True when the test is the whole plan (it is already small). */
  whole: boolean;
  /** Estimated profit for those quantities: the planner's per-SCU margin times the quantity. */
  profit: number;
  /** Estimated outlay; absent when the budget is the player's balance. */
  cost?: number;
  /** The headline and the instructions, in French. */
  lines: string[];
}

export interface Reliability {
  level: ReliabilityLevel;
  label: string;
  evidence_rank: 0 | 1 | 2 | 3;
  /** The most decisive reason in a few words, for the line under the big figure. */
  why: string;
  reasons: ReliabilityReason[];
  /** The reasons found beyond the five shown, in a few words each (not dropped silently). */
  others: string[];
  /** What the estimate leaves out, as a sentence. */
  limits: string;
  trial: TrialTrip | null;
  /** Set by the caller: a better-evidenced option than the first of the list. */
  better_than_first?: boolean;
}

export interface ReliabilityContext {
  speedKnown: boolean;
  stopMinutes: number;
  localHopMinutes: number;
  /** The budget is the player's balance: no outlay in the answer. */
  private: boolean;
}

/** Prices older than this (days) keep "reported" from being the level. A choice, not a measure. */
export const RELIABLE_MAX_AGE_DAYS = 3;
/** A price older than this (days) is named as a reason. A choice, not a measure. */
export const OLD_PRICE_DAYS = 2;
/** A margin below this share of the buy price is called thin. A choice, not a measure. */
export const THIN_MARGIN = 0.1;
/** Terminals showing the very same sell price from which that is worth saying. */
export const SAME_PRICE_PEERS = 3;
/** Terminals trading a commodity from which "nobody reported it" is worth saying. */
export const UNREPORTED_COMMODITY_MIN_TERMINALS = 5;
/** The test run: a quarter of the leg, at least this many SCU, at most the next constant, never more than the leg. */
export const TRIAL_MIN_SCU = 100;
export const TRIAL_MAX_SCU = 150;
export const TRIAL_FRACTION = 0.25;
export const MAX_REASONS = 5;

const LABEL: Record<ReliabilityLevel, string> = {
  reported: "Relevée par des joueurs",
  partial: "Partiellement relevée",
  estimate: "Estimation non vérifiée",
  unchecked: "Relevés non vérifiés",
};

/** The "partial" level when every price has a report but one is older than RELIABLE_MAX_AGE_DAYS (or undated). */
const LABEL_OLD = "Relevée, mais prix de plus de 3 jours";

const RANK: Record<ReliabilityLevel, 0 | 1 | 2 | 3> = {
  reported: 3,
  partial: 2,
  estimate: 1,
  unchecked: 0,
};

/** A few words per reason, for the line under the big figure. */
const WHY: Record<ReasonCode, string> = {
  unchecked: "relevés joueurs non vérifiés",
  no_reports: "aucun relevé joueur",
  sell_ceiling: "prix de vente au plafond",
  whole_stock: "tout le stock acheté",
  same_orbit: "cycle sans vol quantique",
  sale_pressure: "vente sous pression",
  old_prices: "prix anciens",
  no_quantum_speed: "vitesse quantique inconnue",
  commodity_unreported: "marchandise jamais relevée",
};

/** The order reasons are kept in when there are more than MAX_REASONS. */
const ORDER: ReasonCode[] = [
  "unchecked",
  "no_reports",
  "sell_ceiling",
  "whole_stock",
  "same_orbit",
  "sale_pressure",
  "old_prices",
  "no_quantum_speed",
  "commodity_unreported",
];

export const RELIABILITY_LIMITS_NOTE =
  "Ces figures sont des estimations sur des prix UEX de la communauté. Ne sont pas comptés : le temps de chargement, le carburant, la taille des pads, la piraterie, l’effet de tes achats et de tes ventes sur le prix.";

interface End {
  leg: number;
  side: "buy" | "sell";
  price: number;
  reports: number | null;
  age: number | null;
  range: { low: number; high: number } | null;
}

function endsOf(legs: readonly LegView[]): End[] {
  const out: End[] = [];
  legs.forEach((l, i) => {
    out.push({
      leg: i,
      side: "buy",
      price: l.buy_price,
      reports: l.reports.origin,
      age: l.price_age_days.buy,
      range: l.market?.buy_range ?? null,
    });
    out.push({
      leg: i,
      side: "sell",
      price: l.sell_price,
      reports: l.reports.destination,
      age: l.price_age_days.sell,
      range: l.market?.sell_range ?? null,
    });
  });
  return out;
}

/** The level of the evidence behind the prices (rule in the header of this file). */
export function levelOf(ends: readonly Pick<End, "reports" | "age">[]): ReliabilityLevel {
  const known = ends.filter((e) => e.reports !== null);
  if (known.length === 0) return "unchecked";
  const reported = ends.filter((e) => (e.reports ?? 0) >= 1);
  if (reported.length === ends.length) {
    return ends.some((e) => e.age === null || e.age > RELIABLE_MAX_AGE_DAYS)
      ? "partial"
      : "reported";
  }
  return reported.length === 0 ? "estimate" : "partial";
}

/** The age of a price, for a source line. */
const ageWords = (days: number | null): string =>
  days === null
    ? "date du prix inconnue"
    : days < 0.05
      ? "prix mis à jour à l’instant"
      : `prix mis à jour il y a ${fmtNum(days, 1)}\u00a0j`;

/** The oldest known age of a set of prices; null when none has a date. */
const oldest = (ages: (number | null)[]): number | null => {
  const known = ages.filter((a): a is number => a !== null);
  return known.length > 0 ? Math.max(...known) : null;
};

/** "8" or "2,5": minutes without a useless decimal. */
const minutes = (n: number): string => fmtNum(n, Number.isInteger(n) ? 0 : 1);

/** "Aller", "Retour", "Trajet 1"... : empty for a single leg. */
function legName(o: TripOption, i: number): string {
  if (o.legs.length < 2) return "";
  if (o.mode === "round_trip") return i === 0 ? "Aller" : "Retour";
  return `Trajet ${i + 1}`;
}
const prefix = (name: string): string => (name ? `${name} : ` : "");

/** The test run's quantity for a leg of `scu` SCU. Never more than the leg, whatever the bounds say. */
export function trialQuantity(scu: number): number {
  const want = Math.max(TRIAL_MIN_SCU, Math.ceil(scu * TRIAL_FRACTION));
  return Math.max(1, Math.min(scu, TRIAL_MAX_SCU, want));
}

function trialOf(o: TripOption, ctx: ReliabilityContext): TrialTrip | null {
  if (o.legs.length === 0 || o.legs.some((l) => !(l.scu >= 1))) return null;
  const scu = o.legs.map((l) => trialQuantity(l.scu));
  const whole = scu.every((q, i) => q >= o.legs[i].scu);
  const profit = o.legs.reduce((s, l, i) => s + scu[i] * l.profit_per_scu, 0);
  const cost = o.legs.reduce((s, l, i) => Math.max(s, scu[i] * l.buy_price), 0);
  const total = scu.reduce((a, b) => a + b, 0);
  const lines: string[] = [];
  lines.push(
    whole
      ? `Ton plan est déjà petit (${fmtNum(total)}\u00a0SCU) : fais-le tel quel comme premier trajet de test.`
      : `Premier trajet de test : ${scu.map((q) => fmtNum(q)).join(" puis ")}\u00a0SCU au lieu de ${o.legs
          .map((l) => fmtNum(l.scu))
          .join(" puis ")}\u00a0SCU.`,
  );
  lines.push(
    `Gain estimé pour cette quantité : environ ${fmtNum(profit)}\u00a0aUEC (estimation : prix UEX multipliés par la quantité, sans effet de tes achats ni de tes ventes sur le prix).`,
  );
  lines.push(
    "Avant d’acheter, regarde au terminal le prix et le stock réels. Au retour, note le prix de vente réel et la durée réelle du cycle, puis augmente la quantité seulement ensuite.",
  );
  return { scu, whole, profit, ...(ctx.private ? {} : { cost }), lines };
}

/**
 * The reliability of one option. Pure: the same option and context always give the same answer.
 * `better_than_first` is left to the caller, who knows the other options.
 */
export function assessReliability(o: TripOption, ctx: ReliabilityContext): Reliability {
  const ends = endsOf(o.legs);
  const level = levelOf(ends);
  const found: ReliabilityReason[] = [];
  const add = (code: ReasonCode, text: string, source: string) =>
    found.push({ code, text, source });

  // 1. Player reports.
  const unknown = ends.filter((e) => e.reports === null);
  const zero = ends.filter((e) => e.reports === 0);
  if (level === "unchecked") {
    add(
      "unchecked",
      "UEX n’a pas pu être interrogé sur les relevés de joueurs pour cette route : on ignore si ces prix sont des estimations.",
      "UEX · vérification des relevés non faite",
    );
  } else if (zero.length > 0) {
    const head =
      zero.length === ends.length
        ? `0 relevé joueur sur cette route : les ${fmtNum(ends.length)} prix sont des estimations UEX.`
        : `${fmtNum(zero.length)} prix sur ${fmtNum(ends.length)} sans relevé joueur (estimations UEX)${
            unknown.length > 0
              ? `, ${fmtNum(unknown.length)} non vérifié${unknown.length > 1 ? "s" : ""}`
              : ""
          }.`;
    add(
      "no_reports",
      head,
      `UEX · nombre de relevés joueurs · ${ageWords(oldest(zero.map((e) => e.age)))}`,
    );
  }

  o.legs.forEach((l, i) => {
    const name = legName(o, i);
    const sell = ends[i * 2 + 1];
    const buy = ends[i * 2];

    // 2. Sell price at the top of its range.
    const r = sell.range;
    if (r && r.high > r.low && sell.price >= r.high) {
      const peers = l.market?.sell_peers;
      add(
        "sell_ceiling",
        `${prefix(name)}le prix de vente (${fmtNum(sell.price)}) est au plus haut de la fourchette connue d’UEX pour ce terminal (${fmtNum(r.low)} à ${fmtNum(r.high)}, sans indication de période)${
          peers && peers.same_price >= SAME_PRICE_PEERS
            ? `; ce prix est partagé par ${fmtNum(peers.same_price)} terminaux sur ${fmtNum(peers.priced)}`
            : ""
        }.`,
        `UEX · fourchette du terminal · ${ageWords(sell.age)}`,
      );
    }

    // 3. The plan takes the whole displayed stock.
    if (l.limited_by === "stock") {
      add(
        "whole_stock",
        `${prefix(name)}le plan achète tout le stock affiché (${fmtNum(l.scu)}\u00a0SCU) : le prix monte quand le stock baisse, ce n’est pas modélisé.`,
        `UEX · stock affiché · ${ageWords(buy.age)}`,
      );
    }

    // 5. The sale: a buyer close to saturation, less demand than the plan sells, a thin margin.
    const parts: string[] = [];
    const inv = l.market?.sell_inventory;
    if (inv && inv.code === 6) {
      parts.push(
        `le terminal acheteur est très rempli${inv.fill ? ` (${inv.fill.replace("-", " à ")})` : ""} : UEX prévient que le prix baisse vite quand on vend`,
      );
    } else if (inv && inv.code === 7) {
      parts.push(
        "UEX indique que le terminal acheteur est au maximum de son inventaire : plus de demande, il peut refuser la vente",
      );
    }
    if (l.destination_demand_scu !== null && l.scu > l.destination_demand_scu) {
      parts.push(
        `le plan vend ${fmtNum(l.scu)}\u00a0SCU, le terminal n’en demande que ${fmtNum(l.destination_demand_scu)}\u00a0SCU d’après UEX`,
      );
    }
    if (l.buy_price > 0 && l.profit_per_scu / l.buy_price < THIN_MARGIN) {
      const pct = (l.profit_per_scu / l.buy_price) * 100;
      parts.push(
        `marge fine (${fmtNum(pct, 1)}\u00a0% du prix d’achat${ctx.private ? "" : `, pour ${fmtNum(l.cost)}\u00a0aUEC immobilisés`}) : un petit écart de prix suffit à l’annuler`,
      );
    }
    if (parts.length > 0) {
      add(
        "sale_pressure",
        `${prefix(name)}${parts.join(" ; ")}.`,
        `UEX · inventaire et prix du terminal acheteur · ${ageWords(sell.age)}`,
      );
    }

    // 8. Nobody reported this commodity anywhere.
    const cr = l.market?.commodity_reports;
    if (cr && cr.reported === 0 && cr.terminals >= UNREPORTED_COMMODITY_MIN_TERMINALS) {
      add(
        "commodity_unreported",
        `${prefix(name)}aucun des ${fmtNum(cr.terminals)} terminaux qui commercent cette marchandise n’a de relevé joueur chez UEX.`,
        "UEX · relevés par marchandise",
      );
    }
  });

  // 4. Same orbit: a flight of 0 Gm is a local hop of a fixed duration, not a quantum flight.
  const gm = o.trip.flights_gm;
  const flightFor = (i: number): number | undefined => gm[Math.min(i, gm.length - 1)];
  const sameOrbitLegs = (o.mode === "two_leg" ? o.legs.map((_, i) => i) : [0]).filter(
    (i) => o.legs[i] && flightFor(i) === 0,
  );
  const allLocal = gm.length > 0 && gm.every((g) => g === 0);
  for (const i of sameOrbitLegs) {
    const l = o.legs[i];
    const apart = l.from.body !== null && l.to.body !== null && l.from.body !== l.to.body;
    add(
      "same_orbit",
      `${prefix(o.mode === "two_leg" ? legName(o, i) : "")}UEX place les deux terminaux dans la même orbite (0\u00a0Gm)${
        apart ? " alors qu’ils sont sur deux corps différents" : ""
      } : le vol est compté comme un saut local de ${minutes(ctx.localHopMinutes)}\u00a0min, sans vol quantique.${
        allLocal && o.trip.cycle_seconds !== null
          ? ` Le cycle estimé (${fmtNum(Math.round(o.trip.cycle_seconds / 60))}\u00a0min) n’est fait que d’arrêts de ${minutes(ctx.stopMinutes)}\u00a0min et de sauts locaux : c’est une hypothèse, pas un temps de vol.`
          : ""
      }`,
      "UEX · distances d’orbites · durées : hypothèse du tableau de bord",
    );
  }

  // 6. Old prices.
  const oldAges = ends.filter((e) => e.age !== null && e.age >= OLD_PRICE_DAYS);
  if (oldAges.length > 0) {
    add(
      "old_prices",
      `Prix anciens : ${oldAges
        .map(
          (e) =>
            `${e.side === "buy" ? "achat" : "vente"}${legName(o, e.leg) ? ` ${legName(o, e.leg).toLowerCase()}` : ""} mis à jour il y a ${fmtNum(e.age as number, 1)}\u00a0j`,
        )
        .join(", ")}. Un prix communautaire bouge en quelques heures.`,
      "UEX · date de relevé des prix",
    );
  }

  // 7. No quantum speed: flights longer than a hop have no duration.
  if (!ctx.speedKnown && gm.some((g) => g > 0)) {
    add(
      "no_quantum_speed",
      "La vitesse quantique du vaisseau est inconnue : la durée des vols longs n’est pas estimée.",
      "Fiche du vaisseau absente",
    );
  }

  // One reason per code: the legs of a reason are merged into its text (each sentence already says "Aller" or "Retour").
  const merged: ReliabilityReason[] = [];
  for (const code of ORDER) {
    const same = found.filter((r) => r.code === code);
    if (same.length === 0) continue;
    merged.push({
      code,
      text: same.map((r) => r.text).join(" "),
      source: [...new Set(same.map((r) => r.source))].join(" ; "),
    });
  }
  const reasons = merged.slice(0, MAX_REASONS);
  const others = merged.slice(MAX_REASONS).map((r) => WHY[r.code]);
  // Market facts that were not read (a failed read, the cap on extra reads): said, so that no silence reads as reassurance.
  if (o.legs.some((l) => !l.market)) others.push("marché non lu");
  // What sits under the big figure: the top reason, in a few words. "Aucun relevé" only when EVERY price is at 0.
  const top = reasons[0]?.code;
  const why =
    top === "no_reports"
      ? zero.length === ends.length
        ? WHY.no_reports
        : "relevés partiels"
      : top
        ? WHY[top]
        : LABEL[level].toLowerCase();
  const onlyOld = level === "partial" && ends.every((e) => (e.reports ?? 0) >= 1);
  return {
    level,
    label: onlyOld ? LABEL_OLD : LABEL[level],
    evidence_rank: RANK[level],
    why,
    reasons,
    others,
    limits: RELIABILITY_LIMITS_NOTE,
    trial: trialOf(o, ctx),
  };
}

/**
 * `assessReliability`, but a card never disappears because of it: an option the rules cannot read (a shape the planner does not
 * produce) gets the lowest level and no reason, which is what it is, "not checked".
 */
export function safeAssessReliability(o: TripOption, ctx: ReliabilityContext): Reliability {
  try {
    return assessReliability(o, ctx);
  } catch {
    return {
      level: "unchecked",
      label: LABEL.unchecked,
      evidence_rank: 0,
      why: LABEL.unchecked.toLowerCase(),
      reasons: [],
      others: [],
      limits: RELIABILITY_LIMITS_NOTE,
      trial: null,
    };
  }
}

/** Marks every option better evidenced than the first of the list. The list itself is never reordered. */
export function markBetterChecked(list: { reliability?: Reliability }[]): void {
  const first = list[0]?.reliability;
  if (!first) return;
  for (let i = 1; i < list.length; i++) {
    const r = list[i].reliability;
    // Never on a card labelled "Estimation non vérifiée" or "Relevés non vérifiés": only a card with player reports is "better".
    if (
      r &&
      r.evidence_rank > first.evidence_rank &&
      (r.level === "reported" || r.level === "partial")
    )
      r.better_than_first = true;
  }
}
