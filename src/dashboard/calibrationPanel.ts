/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The route calibration as the View reads it: the poll's `ledger.calibration` section rebuilt field by field, the group a
 * route or a commodity belongs to, the quiet line under a suggestion card, the calibrated tile "Si tu refais ce trajet" and
 * the expectation "net attendu ≈ prévu × ratio typique". Pure display logic, shipped inside the page by page.ts with the
 * same rules as the other View modules (the functions are serialised with Function.prototype.toString):
 *   - only function declarations, no imports, no module-level values (a function may call another of this file);
 *   - the ledger's cleaners (ledgerNum, ledgerText, ledgerOneOf) arrive through the `L` argument;
 *   - text reaches the DOM only through textContent (the callers set it).
 *
 * WHAT THE FIGURES ARE (rules and thresholds: providers/sessions/calibration.ts): ratios of the player's own saved runs,
 * realised against planned. They are ESTIMATES drawn from a handful of runs, always with their number of runs, and they
 * claim no cause. Every ratio here is derived from the balance: the section exists in the poll only while the player chose
 * to show the balance, the channel between Views never carries it (ledgerStripBalance / ledgerChannelClean), and nothing
 * built here goes into a message to the agent or into ui/update-model-context.
 */

export function calibrationConfig() {
  return { maxGroups: 14, textMax: 60, maxN: 999 };
}

/**
 * The comparison key of a name: accents folded (NFKD, combining marks out), lower case, letters and digits of any script
 * only. Equal keys are the same commodity or terminal. A name with no letter or digit at all gets a stable hash of its
 * folded text, so it is never an empty key (which would make its group invisible).
 */
export function calibrationKey(value: unknown): string {
  if (typeof value !== "string") return "";
  const folded = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const plain = folded.replace(/[^\p{L}\p{N}]/gu, "");
  if (plain !== "") return plain;
  const text = folded.trim();
  if (text === "") return "";
  let h = 5381;
  for (const ch of text) h = ((h * 33) ^ (ch.codePointAt(0) as number)) >>> 0;
  return "h" + h.toString(16);
}

/** "78 %" (a no-break space before the sign). */
export function calibrationPct(ratio: number): string {
  return Math.round(ratio * 100) + "\u00a0%";
}

/** A ratio this far from 1 (500 %) is shown as "écart très élevé", never as a number: it rests on a tiny plan. */
export function calibrationHuge(ratio: unknown): boolean {
  return typeof ratio === "number" && Math.abs(ratio) > 5;
}

export function calibrationWord(confidence: string): string {
  const words: any = { low: "faible", medium: "moyenne", high: "élevée" };
  return words[confidence] || "faible";
}

function calibrationRatio(L: any, value: unknown): number | null {
  const n = L.ledgerNum(value);
  return n === null ? null : Math.max(-100, Math.min(100, n));
}

/** One group, rebuilt. null when it is not a usable one (fewer than two runs, no commodity, no gross ratio). */
export function calibrationGroupNormalize(L: any, raw: any): any {
  if (!raw || typeof raw !== "object") return null;
  const cfg = calibrationConfig();
  const confs = ["none", "low", "medium", "high"];
  const commodity = L.ledgerText(raw.commodity, cfg.textMax);
  const n = Math.min(cfg.maxN, Math.max(0, Math.floor(L.ledgerNum(raw.n) || 0)));
  const gross = calibrationRatio(L, raw.gross_ratio);
  if (commodity === "" || n < 2 || gross === null) return null;
  const kind = raw.kind === "route" ? "route" : "commodity";
  const count = (v: unknown) => Math.min(cfg.maxN, Math.max(0, Math.floor(L.ledgerNum(v) || 0)));
  return {
    kind,
    commodity,
    buy_terminal: kind === "route" ? L.ledgerText(raw.buy_terminal, cfg.textMax) || null : null,
    sell_terminal: kind === "route" ? L.ledgerText(raw.sell_terminal, cfg.textMax) || null : null,
    n,
    confidence: L.ledgerOneOf(raw.confidence, confs, "low"),
    gross_ratio: gross,
    gross_min: calibrationRatio(L, raw.gross_min),
    gross_max: calibrationRatio(L, raw.gross_max),
    high_variance: raw.high_variance === true,
    net_ratio: calibrationRatio(L, raw.net_ratio),
    net_n: count(raw.net_n),
    net_excluded: count(raw.net_excluded),
    goods_unverified: raw.goods_unverified === true,
    confidence_capped: raw.confidence_capped === true,
    net_confidence: L.ledgerOneOf(raw.net_confidence, confs, "low"),
    fee_rate: calibrationRatio(L, raw.fee_rate),
    fee_n: count(raw.fee_n),
    last_run_age_days: L.ledgerNum(raw.last_run_age_days),
    quantity_adjusted: count(raw.quantity_adjusted),
    quantity_unknown: count(raw.quantity_unknown),
  };
}

/** The section as the View keeps it: { groups } or null. Unknown fields are dropped. */
export function calibrationNormalize(L: any, raw: any): any {
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  const cfg = calibrationConfig();
  const groups = (Array.isArray(raw.groups) ? raw.groups : [])
    .slice(0, cfg.maxGroups)
    .map((g: any) => calibrationGroupNormalize(L, g))
    .filter((g: any) => g !== null);
  return { patch_line: L.ledgerText(raw.patch_line, 12) || null, groups };
}

/** From a raw ledger payload (the poll's). null when the payload holds none (the balance is hidden). */
export function calibrationFromLedger(L: any, ledger: any): any {
  if (!ledger || typeof ledger !== "object") return null;
  return calibrationNormalize(L, ledger.calibration);
}

/**
 * The group to lean on: the route's when both terminals are given and it has two runs or more, else the commodity's.
 * Never another commodity's: the comparison is the exact key of the name, not a prefix.
 */
export function calibrationPick(calib: any, commodity: unknown, buy: unknown, sell: unknown): any {
  if (!calib || !Array.isArray(calib.groups)) return null;
  const c = calibrationKey(commodity);
  if (c === "") return null;
  const b = calibrationKey(buy);
  const s = calibrationKey(sell);
  const usable = (g: any) => g.n >= 2 && typeof g.gross_ratio === "number";
  if (b !== "" && s !== "") {
    for (const g of calib.groups) {
      if (
        g.kind === "route" &&
        usable(g) &&
        calibrationKey(g.commodity) === c &&
        calibrationKey(g.buy_terminal) === b &&
        calibrationKey(g.sell_terminal) === s
      )
        return { group: g, scope: "route" };
    }
  }
  for (const g of calib.groups) {
    if (g.kind === "commodity" && usable(g) && calibrationKey(g.commodity) === c)
      return { group: g, scope: "commodity" };
  }
  return null;
}

/**
 * "Net attendu ≈ prévu × ratio typique (n trajets)": an ESTIMATE. With at least two runs whose net and fees are known,
 * the planned profit times the typical net ratio. Otherwise the planned profit times the typical gross ratio, minus the
 * typical fee rate on the planned turnover (needs it). null when neither can be worked out.
 */
export function calibrationExpected(
  group: any,
  plannedProfit: unknown,
  plannedTurnover?: unknown,
): any {
  if (!group || typeof plannedProfit !== "number" || !Number.isFinite(plannedProfit)) return null;
  const unverified = group.goods_unverified === true;
  if (
    typeof group.net_ratio === "number" &&
    group.net_n >= 2 &&
    !calibrationHuge(group.net_ratio)
  ) {
    return {
      auec: Math.round(plannedProfit * group.net_ratio),
      basis: "net_ratio",
      ratio: group.net_ratio,
      n: group.net_n,
      confidence: group.net_confidence,
      goods_unverified: unverified,
    };
  }
  if (
    typeof group.gross_ratio === "number" &&
    !calibrationHuge(group.gross_ratio) &&
    typeof group.fee_rate === "number" &&
    group.fee_n >= 2 &&
    typeof plannedTurnover === "number" &&
    plannedTurnover > 0
  ) {
    const order = ["none", "low", "medium", "high"];
    // Two estimates stacked: never more confident than the gross ratio, and low when the fee rate rests on few runs.
    const cap = group.fee_n < 4 ? "low" : "high";
    const conf = order.indexOf(group.confidence) <= order.indexOf(cap) ? group.confidence : cap;
    return {
      auec: Math.round(plannedProfit * group.gross_ratio - group.fee_rate * plannedTurnover),
      basis: "gross_ratio_minus_fees",
      ratio: group.gross_ratio,
      n: Math.min(group.n, group.fee_n),
      confidence: conf,
      goods_unverified: unverified,
    };
  }
  return null;
}

/** The sentence about spread and sample size that must travel with every figure. */
export function calibrationCaution(group: any): string {
  const parts: string[] = [];
  if (group.n < 4) parts.push("peu de trajets : indicatif seulement");
  if (
    group.high_variance &&
    typeof group.gross_min === "number" &&
    typeof group.gross_max === "number"
  )
    parts.push(
      "résultats très variables (de " +
        calibrationPct(group.gross_min) +
        " à " +
        calibrationPct(group.gross_max) +
        ")",
    );
  if (typeof group.last_run_age_days === "number" && group.last_run_age_days > 21)
    parts.push("dernier trajet il y a " + group.last_run_age_days + "\u00a0jours");
  return parts.join(" · ");
}

/**
 * The quiet line under a suggestion card, for the commodity of the card's first leg (and its two terminals): null when
 * there is nothing to say (the balance is hidden, no group, fewer than two runs). `tag` always carries the confidence and
 * the word "estimé".
 */
export function calibrationLine(
  calib: any,
  commodity: unknown,
  buy: unknown,
  sell: unknown,
  legs?: unknown,
): any {
  const hit = calibrationPick(calib, commodity, buy, sell);
  if (!hit) return null;
  const g = hit.group;
  const unverified = g.goods_unverified === true;
  // The game log never names goods: when the plan was tied to the runs by their prices, the line says they only
  // RESEMBLE the plan, never that they are "of this goods".
  const where = unverified
    ? hit.scope === "route"
      ? "qui ressemblent au plan sur cette route (marchandise non vérifiée, lien par prix)"
      : "qui ressemblent au plan (marchandise non vérifiée, lien par prix)"
    : hit.scope === "route"
      ? "sur cette route"
      : "de cette marchandise";
  let text = "Tes " + g.n + " derniers trajets " + where;
  text += calibrationHuge(g.gross_ratio)
    ? " : écart très élevé entre le réalisé (marge brute) et le prévu"
    : " : réalisé (marge brute) ≈ " + calibrationPct(g.gross_ratio) + " du prévu";
  if (typeof g.fee_rate === "number")
    text += ", frais ≈ " + calibrationPct(g.fee_rate) + " du chiffre d’affaires";
  text += ".";
  const caution = calibrationCaution(g);
  if (caution !== "") text += " " + caution[0]!.toUpperCase() + caution.slice(1) + ".";
  // The ceiling, said in the visible text (not only in the tag's title): the cap and what the link leaves out.
  if (g.confidence_capped === true)
    text +=
      " Confiance plafonnée à « moyenne » : plan rattaché par les prix, et les trajets qui rendent moins de la moitié du prévu ne sont pas rattachés, donc absents de ce chiffre.";
  if (typeof legs === "number" && legs > 1)
    text += " Ligne calculée pour le premier tronçon seulement.";
  return {
    text,
    tag: "estimé · confiance " + calibrationWord(g.confidence),
    hint: calibrationHint(g),
    scope: hit.scope,
    confidence: g.confidence,
    goods_unverified: unverified,
  };
}

/** The explanation behind the confidence tag (its title): why it is capped when the goods were not verified. */
export function calibrationHint(group: any): string {
  if (!group || group.goods_unverified !== true) return "";
  return "Confiance plafonnée à « moyenne » : le journal du jeu ne nomme pas les marchandises, le plan est rattaché aux trajets par la ressemblance des prix (une ressemblance, pas une preuve).";
}

/**
 * The calibrated "Si tu refais ce trajet": the expectation for the plan in force (the same plan the card's own figure is
 * built on, whether or not the journal could confirm the goods), when the group has what it needs. null otherwise (the card
 * keeps its own figure).
 */
export function calibrationNextTile(calib: any, plan: any, money: any): any {
  if (!calib || !plan || !money) return null;
  if (typeof money.planned_profit !== "number") return null;
  const hit = calibrationPick(calib, plan.commodity, plan.buy_terminal, plan.sell_terminal);
  if (!hit) return null;
  const turnover =
    typeof plan.sell_unit_price === "number" && typeof plan.scu === "number"
      ? plan.sell_unit_price * plan.scu
      : null;
  const e = calibrationExpected(hit.group, money.planned_profit, turnover);
  if (!e) return null;
  const unverified = e.goods_unverified === true;
  const where = unverified
    ? hit.scope === "route"
      ? "qui ressemblent au plan sur cette route, marchandise non vérifiée"
      : "qui ressemblent au plan, marchandise non vérifiée"
    : hit.scope === "route"
      ? "sur cette route"
      : "sur cette marchandise";
  const caution = calibrationCaution(hit.group);
  const sub =
    e.basis === "net_ratio"
      ? "prévu × " +
        calibrationPct(e.ratio) +
        " (net typique de tes " +
        e.n +
        " trajets " +
        where +
        ")"
      : "prévu × " +
        calibrationPct(e.ratio) +
        " (marge brute typique de tes " +
        e.n +
        " trajets " +
        where +
        "), moins les frais habituels (" +
        calibrationPct(hit.group.fee_rate) +
        " du chiffre d’affaires du plan)";
  return {
    auec: e.auec,
    tag: "estimé · confiance " + calibrationWord(e.confidence),
    sub: sub + (caution !== "" ? " · " + caution : ""),
    hint: calibrationHint(hit.group),
    confidence: e.confidence,
    basis: e.basis,
  };
}

/** The functions of this file, in the order they are serialised (page.ts). */
export const CALIBRATION_VIEW_FUNCTIONS = [
  calibrationConfig,
  calibrationKey,
  calibrationPct,
  calibrationHuge,
  calibrationWord,
  calibrationRatio,
  calibrationGroupNormalize,
  calibrationNormalize,
  calibrationFromLedger,
  calibrationPick,
  calibrationExpected,
  calibrationCaution,
  calibrationLine,
  calibrationHint,
  calibrationNextTile,
];
