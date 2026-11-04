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
  // minRatioRuns: under this many runs the route card gives the number of runs and no ratio (the tile and the tools keep 2).
  return { maxGroups: 14, textMax: 60, maxN: 999, minRatioRuns: 3 };
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
  const p = Math.round(ratio * 100);
  return (p < 0 ? String.fromCharCode(0x2212) : "") + Math.abs(p) + "\u00a0%";
}

/**
 * A ratio that is not above zero, or above 500 %, is shown as "écart très élevé", never as a number, and nothing is applied
 * to it: it rests on a tiny plan, or the runs lost money (a link by prices keeps a ratio between about 50 % and 200 %, a
 * link by name has no bound).
 */
export function calibrationHuge(ratio: unknown): boolean {
  return typeof ratio === "number" && (ratio <= 0 || ratio > 5);
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
  // Mean amounts (whole aUEC) behind the ratios: finite, bounded, null when absent.
  const amount = (v: unknown) => {
    const a = L.ledgerNum(v);
    return a === null ? null : Math.max(-1e12, Math.min(1e12, Math.round(a)));
  };
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
    gross_avg_auec: amount(raw.gross_avg_auec),
    gross_planned_avg_auec: amount(raw.gross_planned_avg_auec),
    high_variance: raw.high_variance === true,
    net_ratio: calibrationRatio(L, raw.net_ratio),
    net_n: count(raw.net_n),
    net_avg_auec: amount(raw.net_avg_auec),
    net_planned_avg_auec: amount(raw.net_planned_avg_auec),
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
      // the usual fees on the planned turnover, as subtracted above (so a card can write the real decomposition)
      fees: Math.round(group.fee_rate * plannedTurnover),
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

/** Whose runs these are, in words: never "of this goods" when the plan was tied to the runs by their prices only. */
export function calibrationWho(scope: string, unverified: boolean): string {
  return unverified
    ? "similaires (marchandise non vérifiée)"
    : scope === "route"
      ? "sur cette route"
      : "de cette marchandise";
}

/** The end of the fold under a calibration line: the price link, the ceiling, the scope of a two-leg card. */
export function calibrationMoreTail(group: any, multi: boolean): string {
  let more = "";
  if (group.goods_unverified === true)
    more +=
      " Le journal du jeu ne nomme pas les marchandises : ton plan est rattaché à tes trajets par la ressemblance des prix (lien par prix), une ressemblance et non une preuve.";
  if (group.confidence_capped === true)
    more +=
      " Confiance plafonnée à « moyenne » : les trajets qui rendent moins de la moitié du prévu ne sont pas rattachés, donc absents de ce chiffre.";
  if (multi)
    more +=
      " Calculé pour le premier tronçon seulement : ce n’est pas un chiffre pour l’aller-retour.";
  return more;
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
  // RESEMBLE the plan, never that they are "of this goods". The line speaks of the first leg only when there are two.
  const multi = typeof legs === "number" && legs > 1;
  const who = calibrationWho(hit.scope, unverified);
  let text =
    (multi ? "Sur le 1er tronçon, d’après" : "D’après") + " tes " + g.n + " trajets " + who;
  text += calibrationHuge(g.gross_ratio)
    ? " : écart très élevé entre le réalisé et le prévu"
    : " : tu réalises ≈ " + calibrationPct(g.gross_ratio) + " du prévu";
  if (typeof g.fee_rate === "number") text += " (frais ≈ " + calibrationPct(g.fee_rate) + ")";
  text += ".";
  const caution = calibrationCaution(g);
  if (caution !== "") text += " " + caution[0]!.toUpperCase() + caution.slice(1) + ".";
  // The details behind the line, folded: what the figures are, how the plan is tied to the runs, the ceiling, the scope.
  const more =
    "Réalisé : la marge brute (ventes moins achats), comparée au prévu. Frais : en part du chiffre d’affaires." +
    calibrationMoreTail(g, multi);
  return {
    text,
    more,
    tag: calibrationTag(g.confidence, g.n),
    hint: calibrationHint(g, g.confidence),
    scope: hit.scope,
    confidence: g.confidence,
    goods_unverified: unverified,
  };
}

/** "estimé · 4 trajets · confiance moyenne": the number of runs, and the confidence in words (never colour alone). */
export function calibrationTag(confidence: string, n: number): string {
  return "estimé · " + n + " trajets · confiance " + calibrationWord(confidence);
}

/** The explanation behind the tag (its title): the confidence word, and why it is capped when the goods were not verified. */
export function calibrationHint(group: any, confidence: string): string {
  if (!group) return "";
  return (
    "Confiance " +
    calibrationWord(confidence) +
    "." +
    (group.goods_unverified === true
      ? " Confiance plafonnée à « moyenne » : le journal du jeu ne nomme pas les marchandises, le plan est rattaché aux trajets par la ressemblance des prix (une ressemblance, pas une preuve)."
      : "")
  );
}

/**
 * calibrationExpected with ONE minimum for everything the player sees (the tile and the route cards): under `minRatioRuns`
 * runs behind the very figure used (the net ratio's runs, the fee rate's runs, the gross ratio's runs) it gives nothing.
 * The profit given is that of ONE leg (the plan's, or the card's first leg), never a round-trip total.
 */
export function calibrationApply(group: any, profit: unknown, turnover?: unknown): any {
  if (!group) return null;
  const min = calibrationConfig().minRatioRuns;
  if (group.n < min) return null;
  const enough = (v: number) => (v >= min ? v : 0);
  return calibrationExpected(
    { ...group, net_n: enough(group.net_n), fee_n: enough(group.fee_n) },
    profit,
    turnover,
  );
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
  const e = calibrationApply(hit.group, money.planned_profit, turnover);
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
    tag: calibrationTag(e.confidence, e.n),
    sub: sub + (caution !== "" ? " · " + caution : ""),
    hint: calibrationHint(hit.group, e.confidence),
    confidence: e.confidence,
    basis: e.basis,
  };
}

/**
 * The three values of a route card side by side: ESTIMATED (the planner's figure from UEX prices, per trip and per hour),
 * MEASURED (what the player's own saved runs of this route or goods averaged, and how many) and the RATIO realised / planned
 * with what it gives applied. Every string is ready to be written with textContent. null when there is nothing to say (no
 * group for the first leg's goods, no leg). The caller passes it only while the balance is shown: everything here is derived
 * from the balance.
 *
 * Honesty rules, each one tested:
 *   - under `minRatioRuns` (3) runs behind the figure in use, only the NUMBER of runs is given: no ratio, no applied figure;
 *   - the ratio is the one the tile "Si tu refais ce trajet" uses (calibrationExpected: the net ratio, else the gross ratio
 *     less the usual fees), and it is applied to the profit of the FIRST LEG only (what "apply as plan" stores as the plan's
 *     profit, so what the runs were compared with), never to the card's round-trip total, never to another goods;
 *   - a per-hour figure is applied only to a one-leg card, as the applied trip over the estimated cycle;
 *   - a huge gap is worded, not printed as a percentage, and nothing is applied to it;
 *   - the ratio is censored by construction (about 50 % to 200 %): the fold says so.
 * `calibrationLine` above is the same figures as one plain sentence (the form the tools and the tests pin); the card uses this.
 */
export function calibrationCompare(L: any, calib: any, o: any): any {
  const leg = o && Array.isArray(o.legs) ? o.legs[0] : null;
  if (!leg) return null;
  const hit = calibrationPick(calib, leg.commodity, leg.from, leg.to);
  if (!hit) return null;
  const cfg = calibrationConfig();
  const g = hit.group;
  const multi = o.legs.length > 1;
  const who = calibrationWho(hit.scope, g.goods_unverified === true);
  const money = (v: number) => "≈ " + L.fmtAuec(v, true);
  const unit = "\xa0aUEC";
  // The measured side and the ratio are those of the FIRST leg: a card of two legs says so beside the total it shows.
  const scopeWord = multi ? "1er tronçon (" + leg.commodity + ") · " : "";
  const out: any = {
    mode: "count",
    scope: hit.scope,
    estValue: money(o.profit_per_trip),
    estUnit: multi ? "aUEC pour les " + o.legs.length + " tronçons" : "aUEC par trajet",
    estSub:
      o.profit_per_hour === null
        ? "durée inconnue : pas de gain par heure"
        : money(o.profit_per_hour) + unit + " par heure",
    measLabel: "Mesuré",
    measValue: g.n + " trajets",
    measUnit: "",
    measSub:
      scopeWord + who + " · pas assez pour un ratio (" + cfg.minRatioRuns + " trajets minimum)",
    ratioValue: "",
    ratioSub: "",
    fill: -1,
    apply: "",
    caution: "",
    tag: "",
    hint: "",
    reading:
      "Estimé : le calcul du planificateur sur les prix UEX (relevés de la communauté), jamais une promesse. Mesuré : la moyenne de tes trajets enregistrés, chacun avec son plan. Le ratio compare chaque trajet au prévu de CE trajet-là, ramené à la quantité transportée : ce n’est pas le mesuré divisé par l’estimation d’aujourd’hui. Un trajet rattaché à son plan par la ressemblance des prix ne l’est que si sa marge unitaire est entre la moitié et le double de celle du plan : ceux qui rendent moins ou plus sont absents, donc le ratio de ces trajets reste entre ≈ 50 % et ≈ 200 % (un lien par le nom n’a pas cette borne). Un ratio négatif, nul ou au-dessus de 500 % se lit « écart très élevé » et n’est appliqué à rien." +
      calibrationMoreTail(g, multi),
  };
  if (g.n < cfg.minRatioRuns) return out;

  // The ratio and what it gives: only with enough runs behind the very figure used (the net, or the fees), else the gross one.
  const legProfit = Math.round(leg.profit_per_scu * leg.scu);
  const e = legProfit > 0 ? calibrationApply(g, legProfit, leg.sell_price * leg.scu) : null;
  const net = !!e && e.basis === "net_ratio";
  const ratio = e ? e.ratio : g.gross_ratio;
  // The runs the shown mean is over (the net's runs, else all of them): the confidence tag keeps the runs behind the ratio used.
  const runs = net ? g.net_n : g.n;
  const confidence = e ? e.confidence : g.confidence;
  const mean = net ? g.net_avg_auec : g.gross_avg_auec;
  const planned = net ? g.net_planned_avg_auec : g.gross_planned_avg_auec;
  out.mode = "ratio";
  out.measLabel = "Mesuré · " + runs + " trajets";
  if (typeof mean === "number") {
    out.measValue = money(mean);
    out.measUnit = "aUEC par trajet, en moyenne";
  } else {
    out.measValue = runs + " trajets";
    out.measUnit = "";
  }
  out.measSub =
    scopeWord +
    who +
    " · " +
    (net ? "résultat net" : "marge brute, avant frais") +
    (typeof planned === "number" ? " · prévu alors " + money(planned) + unit : "");
  out.tag = calibrationTag(confidence, e ? e.n : g.n);
  out.hint = calibrationHint(g, confidence);
  out.caution = calibrationCaution(g);
  const huge = calibrationHuge(ratio);
  out.ratioValue = huge ? "écart très élevé" : calibrationPct(ratio);
  out.ratioSub = scopeWord + (net ? "sur le net" : "sur la marge brute") + " · réalisé ÷ prévu";
  out.fill = huge ? -1 : Math.round(Math.min(2, Math.max(0, ratio)) * 50);
  if (e && !huge) {
    // On the gross basis the figure is planned × ratio LESS the usual fees: the sentence says so, with the amount taken off.
    const sum =
      money(e.auec) +
      unit +
      " (prévu " +
      money(legProfit) +
      " × " +
      calibrationPct(e.ratio) +
      (net
        ? ""
        : ", moins les frais habituels ≈ " +
          L.fmtAuec(e.fees) +
          unit +
          ", à " +
          calibrationPct(g.fee_rate) +
          " du chiffre d’affaires prévu") +
      ")";
    if (multi) {
      out.apply =
        "Si tu refais le 1er tronçon (" +
        leg.commodity +
        ") " +
        sum +
        ". Pas de chiffre pour l’aller-retour entier.";
    } else {
      const hour =
        typeof o.cycle_minutes === "number" && o.cycle_minutes > 0
          ? Math.round((e.auec / o.cycle_minutes) * 60)
          : null;
      out.apply =
        "Si tu refais ce trajet " +
        sum +
        (hour === null ? "" : ", soit " + money(hour) + unit + " par heure") +
        ".";
    }
  } else if (!e && !huge && legProfit > 0) {
    // Nothing is applied: say the one reason that is true.
    const turnover = leg.sell_price * leg.scu;
    const netRuns = g.net_n >= cfg.minRatioRuns && typeof g.net_ratio === "number";
    const feeRuns = g.fee_n >= cfg.minRatioRuns && typeof g.fee_rate === "number";
    out.apply =
      netRuns && calibrationHuge(g.net_ratio) && !(feeRuns && turnover > 0)
        ? "Le net de tes trajets s’écarte trop du prévu (écart très élevé) : aucun chiffre appliqué."
        : feeRuns && !(turnover > 0)
          ? "Chiffre d’affaires prévu inconnu : les frais habituels ne peuvent pas être déduits, aucun chiffre appliqué."
          : "Pas assez de trajets avec frais connus pour chiffrer le net (" +
            cfg.minRatioRuns +
            " minimum) : aucun chiffre appliqué.";
  }
  return out;
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
  calibrationWho,
  calibrationMoreTail,
  calibrationTag,
  calibrationHint,
  calibrationApply,
  calibrationNextTile,
  calibrationCompare,
];
