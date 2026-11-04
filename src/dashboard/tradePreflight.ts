/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * "Avant de partir": the pre-flight check of the plan on the commerce card, and the alert that comes with a price
 * refusal at the kiosk. A SEPARATE component on purpose, like tradeActions.ts: the card only offers it a slot.
 *
 *   1. THE ALERT. The game refused a transaction because the price moved (TransactionCostMismatch, listed by the trade
 *      journal): a sentence with the time and the side, for a few minutes, and a nudge to check the plan again. It carries
 *      no amount (only a time, a side and a kind) and also exists as one line for the compact view.
 *   2. THE CHECK. A button asks the server (`sc_trade_suggest`, action preflight, app-only, no argument: the server checks
 *      the plan IT holds) whether the plan still holds at UEX. The answer is a verdict per leg and overall; its sentences
 *      are written by the server from codes and numbers (dashboard/preflightText.ts: the page has a size budget) and are
 *      cleaned and capped again here.
 *
 * Same rules as the other View modules (serialised into the page with Function.prototype.toString): function
 * declarations only, no import, no module-level value; text reaches the DOM only through textContent; the answer is
 * re-validated here, and a green verdict is refused unless every leg backs it. The aUEC balance is never used: the answer
 * holds unit prices and per-SCU margins only (no quantity, no total), and the message to the agent says the same.
 */

export function tradePreflightConfig() {
  return {
    /** What the View waits for one check (the server stops its UEX read at 15 s). */
    timeoutMs: 32000,
    /** A refusal is shown as an alert for this long: it is about the kiosk the player is standing at. */
    refusalFreshMs: 10 * 60 * 1000,
  };
}

/** The chip of a verdict: a symbol and words (never colour alone), and its tone. */
export function tradeVerdictInfo(verdict: string): any {
  if (verdict === "valid") return { label: "✓ Toujours valable", tone: "ok" };
  if (verdict === "valid_estimate") return { label: "≈ Inchangé · estimation UEX", tone: "info" };
  if (verdict === "watch") return { label: "⚠ À surveiller", tone: "warn" };
  if (verdict === "drifted") return { label: "✕ Dérivé", tone: "bad" };
  return { label: "? Impossible de vérifier", tone: "off" };
}

/**
 * The newest price refusal that is still fresh, or null (trade: the normalised commerce section). Its sentence and its
 * time: "Le prix a changé pendant l'achat : transaction refusée, le prix affiché n'est plus valable." / "à 14:32:07 · il y
 * a 2 min 04". A refusal is a time, a side and a kind: there is no amount to hide.
 */
export function tradeRefusalInfo(L: any, trade: any, now: number): any {
  const list = trade && Array.isArray(trade.price_refusals) ? trade.price_refusals : [];
  let best: any = null;
  for (const r of list) {
    // A refusal followed by a transaction that went through, on the same side, is over: the player has moved on.
    const at = r && r.superseded !== true && typeof r.at === "string" ? Date.parse(r.at) : NaN;
    // A time in the future is a clock problem: it is not shown.
    if (
      !Number.isFinite(at) ||
      now - at < -5000 ||
      now - at > tradePreflightConfig().refusalFreshMs
    )
      continue;
    if (best && at <= best.atMs) continue;
    const sell = r.side === "sell";
    const item = r.kind === "item";
    const during = sell ? "la vente" : "l’achat";
    best = {
      atMs: at,
      item,
      text:
        (r.confidence === "ambiguous"
          ? "Une des transactions envoyées à ce moment a été refusée : le prix a changé pendant "
          : "Le prix a changé pendant ") +
        during +
        (item ? " d’un objet de boutique" : "") +
        " : transaction refusée, le prix affiché n’est plus valable.",
      // The absolute time never changes while the alert stands (a screen reader must not re-announce it every second);
      // the age does, and sits outside the live text.
      at: "à " + L.formatClock(new Date(at).toISOString()),
      when: "à " + L.formatClock(new Date(at).toISOString()) + " · il y a " + L.formatAge(now - at),
    };
  }
  return best;
}

function tradePfText(value: any, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(
      // eslint-disable-next-line no-misleading-character-class
      /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\p{Variation_Selector}]|\u{34f}|[\u{115f}\u{1160}\u{17b4}\u{17b5}\u{2800}\u{3164}\u{ffa0}]/gu,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function tradePfNum(value: any, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max
    ? value
    : null;
}

/**
 * The answer of the tool, rebuilt field by field: known fields, right types, bounded. null when unusable. A green verdict
 * survives only when the plan is echoed and BOTH legs are green with a current price (a server that says "valid" over a
 * leg it could not judge is not believed).
 */
export function tradePreflightClean(raw: any): any {
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  if (raw.state === "throttled")
    return { state: "throttled", wait: Math.ceil(tradePfNum(raw.retry_after_s, 3600) || 8) };
  if (raw.state === "error") return { state: "error", code: raw.code === "off" ? "off" : "other" };
  if (raw.state !== "preflight") return null;
  const e = raw.plan && typeof raw.plan === "object" ? raw.plan : null;
  const plan = e
    ? {
        commodity: tradePfText(e.commodity, 60),
        buy_terminal: tradePfText(e.buy_terminal, 60),
        sell_terminal: tradePfText(e.sell_terminal, 60),
        buy_price: tradePfNum(e.buy_price, 1e9),
        sell_price: tradePfNum(e.sell_price, 1e9),
      }
    : null;
  const known = ["valid", "valid_estimate", "watch", "drifted", "unknown"];
  const legs = (Array.isArray(raw.legs) ? raw.legs : [])
    .slice(0, 2)
    .filter((l: any) => l && (l.side === "buy" || l.side === "sell"))
    .map((l: any) => ({
      side: l.side,
      terminal: tradePfText(l.terminal, 60),
      verdict: known.indexOf(l.verdict) >= 0 ? l.verdict : "unknown",
      priced: tradePfNum(l.now_price, 1e9) !== null && !l.problem,
      // Green needs a player behind the price and a row that is not stale: UEX's own estimate is never a confirmation.
      backed: l.estimate === false && (tradePfNum(l.reports, 1e6) || 0) >= 1 && l.stale !== true,
      lines: (Array.isArray(l.lines) ? l.lines : [])
        .slice(0, 6)
        .map((s: any) => tradePfText(s, 160))
        .filter((s: string) => s !== ""),
    }));
  const t = raw.text && typeof raw.text === "object" ? raw.text : {};
  let verdict = known.indexOf(raw.verdict) >= 0 ? raw.verdict : "unknown";
  // A verdict that the legs do not back is not believed, and neither are the words that came with it: green needs BOTH
  // legs green, fresh and backed by a player report; "inchangé · estimation" needs both legs priced and neither red.
  const sound = !!plan && legs.length === 2 && legs.every((l: any) => l.priced);
  const bad =
    (verdict === "valid" &&
      !(sound && legs.every((l: any) => l.verdict === "valid" && l.backed))) ||
    (verdict === "valid_estimate" &&
      !(sound && legs.every((l: any) => l.verdict === "valid" || l.verdict === "valid_estimate")));
  if (bad) verdict = "unknown";
  return {
    state: "preflight",
    verdict,
    plan,
    legs,
    headline: bad
      ? "La réponse du serveur n’est pas cohérente : impossible de vérifier."
      : tradePfText(t.headline, 200),
    margin: bad ? "" : tradePfText(t.margin, 120),
    agent: bad ? "" : tradePfText(t.agent, 1500),
    action: bad ? "Vérifie au terminal avant d’acheter." : tradePfText(t.action, 200),
    notes: (Array.isArray(t.notes) ? t.notes : [])
      .slice(0, 3)
      .map((s: any) => tradePfText(s, 320))
      .filter((s: string) => s !== ""),
    readAge:
      tradePfNum(raw.read_age_s, 1e9) === null
        ? null
        : raw.read_age_s + (tradePfNum(raw.age_s, 1e9) ?? 0),
    requests: tradePfNum(raw.requests, 100) || 0,
  };
}

/** A plan the check can be asked about: goods, both terminals, both unit prices. */
export function tradePreflightPlanOk(plan: any): boolean {
  return (
    !!plan &&
    !!plan.commodity &&
    !!plan.buy_terminal &&
    !!plan.sell_terminal &&
    typeof plan.buy_unit_price === "number" &&
    typeof plan.sell_unit_price === "number"
  );
}

/** Is the answer about the plan on the card? Names (case aside) and unit prices must agree. */
export function tradePreflightMatches(plan: any, r: any): boolean {
  const p = r && r.plan;
  if (!p || !tradePreflightPlanOk(plan)) return false;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return (
    same(plan.commodity, p.commodity) &&
    same(plan.buy_terminal, p.buy_terminal) &&
    same(plan.sell_terminal, p.sell_terminal) &&
    plan.buy_unit_price === p.buy_price &&
    plan.sell_unit_price === p.sell_price
  );
}

/**
 * `render(ctx)` is called by the View on each render; the component keeps its own state.
 * ctx: { enabled, fullscreen, follower, now, clock, plan (cleaned plan or null), trade (normalised commerce section),
 *        call(name, args, timeoutMs), say(text), feedback(text), takeLead(), later(fn, ms), cancel(id), changed() }
 */
export function tradePreflightPanel(doc: any, L: any): any {
  const cfg = tradePreflightConfig();
  const el = (tag: string, cls: string, text?: string): any => {
    const n = doc.createElement(tag);
    n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const add = (parent: any, ...kids: any[]): any => {
    for (const k of kids) parent.appendChild(k);
    return parent;
  };
  const setText = (n: any, text: string) => {
    if (n._t !== text) {
      n._t = text;
      n.textContent = text;
    }
  };
  const setAttr = (n: any, name: string, value: string) => {
    if (n["_a_" + name] !== value) {
      n["_a_" + name] = value;
      n.setAttribute(name, value);
    }
  };
  const show = (n: any, on: boolean) => setAttr(n, "data-hidden", on ? "0" : "1");

  const S: any = { phase: "idle", result: null, at: 0, wait: 0, busy: false, disposed: false };
  let H: any = {};

  const root = el("section", "tr-preflight");
  root.setAttribute("aria-label", "Avant de partir : vérifier le plan");
  root.setAttribute("data-hidden", "1");
  const alertBox = el("div", "pf-alert");
  const alertText = el("p", "pf-alert-text");
  alertText.setAttribute("role", "status");
  const alertWhen = el("p", "pf-alert-when");
  add(alertBox, alertText, alertWhen);
  const head = el("div", "pf-head");
  const chip = el("span", "pf-chip");
  add(head, el("h3", "pf-title", "Avant de partir"), chip);
  const run = el("button", "btn pf-run");
  run.setAttribute("type", "button");
  run.addEventListener("click", () => {
    void check();
  });
  const ask = el("button", "btn pf-ask", "Demander à l’agent");
  ask.setAttribute("type", "button");
  ask.addEventListener("click", () => {
    void askAgent();
  });
  const actions = el("div", "pf-actions");
  add(actions, run, ask);
  const status = el("p", "pf-status");
  const result = el("div", "pf-result");
  const headline = el("p", "pf-headline");
  const margin = el("p", "pf-margin");
  const legBoxes = [el("p", "pf-leg"), el("p", "pf-leg")];
  const legs = el("div", "pf-legs");
  add(legs, legBoxes[0], legBoxes[1]);
  const action = el("p", "pf-action");
  const notes = el("p", "pf-note");
  const more = el("details", "pf-more");
  add(more, el("summary", "pf-more-sum", "Limites et seuils"), notes);
  add(result, headline, margin, legs, action, more);
  add(root, alertBox, head, actions, status, result);
  // The compact view's line: the alert alone.
  const line = el("p", "lg-line pf-line");
  line.setAttribute("role", "status");
  line.setAttribute("data-hidden", "1");

  const refresh = () => (H.changed ? H.changed() : paint());
  const dispose = () => {
    S.disposed = true;
  };

  async function check() {
    if (!H.call || S.busy || S.disposed || !H.enabled) return;
    if (H.follower && H.takeLead) H.takeLead();
    S.busy = true;
    S.phase = "loading";
    refresh();
    try {
      const r = await H.call("sc_trade_suggest", { action: "preflight" }, cfg.timeoutMs);
      const a = r && !r.isError ? tradePreflightClean(r.structuredContent) : null;
      S.phase = !a ? "error" : a.state === "preflight" ? "ok" : a.state;
      if (a && a.state === "preflight") {
        S.result = a;
        S.at = H.clock ? H.clock() : H.now;
      }
      if (a && a.state === "throttled") S.wait = (H.clock ? H.clock() : H.now) + a.wait * 1000;
      S.problem = a && a.state === "error" && a.code === "off" ? "off" : "";
    } catch {
      S.phase = "error";
      S.problem = "";
    }
    S.busy = false;
    refresh();
  }

  async function askAgent() {
    if (!H.say || !S.result || !S.result.agent) return;
    try {
      await H.say(S.result.agent);
      if (H.feedback) H.feedback("Message envoyé à Claude. Réduis la vue pour lire sa réponse.");
    } catch {
      if (H.feedback) H.feedback("Envoi impossible.");
    }
  }

  function paint() {
    const full = !!H.fullscreen;
    const now = H.now;
    const refusal = H.enabled ? tradeRefusalInfo(L, H.trade, now) : null;
    const planOk = tradePreflightPlanOk(H.plan);
    // The compact line: the alert alone.
    setText(line, refusal ? refusal.text + " " + refusal.at : "");
    show(line, !full && !!refusal);
    show(root, !!H.enabled && full && (planOk || !!refusal));
    if (!H.enabled || !full) return;

    show(alertBox, !!refusal);
    if (refusal) {
      setText(alertText, refusal.text);
      setText(
        alertWhen,
        refusal.when +
          (refusal.item
            ? ""
            : planOk
              ? " · vérifie ton plan à nouveau : UEX a peut-être des prix plus récents."
              : " · cherche une route à jour avant de racheter."),
      );
    }
    show(head, planOk);
    show(actions, planOk);
    setAttr(run, "data-attention", refusal && !refusal.item ? "1" : "0");
    setText(
      run,
      S.phase === "loading"
        ? "Vérification…"
        : S.result
          ? "Vérifier à nouveau"
          : "Vérifier avant de partir",
    );
    run.disabled = S.phase === "loading";

    // The stored answer counts only for the plan on the card.
    let r = planOk ? S.result : null;
    const stale = !!r && !!r.plan && !tradePreflightMatches(H.plan, r);
    if (stale) r = null;
    let text = "";
    if (S.phase === "loading") text = "Lecture des prix chez UEX… (jusqu’à 15\u00a0s)";
    else if (S.phase === "error")
      text = S.problem
        ? "La télémétrie est coupée sur le serveur."
        : "Le serveur n’a pas répondu. Réessaie.";
    else if (S.phase === "throttled") {
      const left = Math.max(0, Math.ceil((S.wait - now) / 1000));
      text =
        left > 0
          ? "Attends " +
            left +
            "\u00a0s : UEX est un service partagé, le serveur espace ses appels."
          : "Tu peux relancer la vérification.";
    } else if (stale) text = "Le plan a changé depuis cette vérification : relance-la.";
    setText(status, text);
    show(status, text !== "" && planOk);
    show(result, !!r && planOk);
    show(ask, !!r && planOk);
    show(chip, !!r && planOk);
    if (!r) return;

    const v = tradeVerdictInfo(r.verdict);
    setText(chip, v.label);
    setAttr(chip, "data-tone", v.tone);
    setText(headline, r.headline);
    setText(margin, r.margin);
    show(margin, r.margin !== "");
    for (let i = 0; i < 2; i++) {
      const l = r.legs[i];
      show(legBoxes[i], !!l);
      if (!l) continue;
      const lv = tradeVerdictInfo(l.verdict);
      setAttr(legBoxes[i], "data-tone", lv.tone);
      setText(
        legBoxes[i],
        (l.side === "buy" ? "Achat · " : "Vente · ") +
          l.terminal +
          " — " +
          lv.label +
          "\n" +
          l.lines.join("\n"),
      );
    }
    // After a refusal at the kiosk, the kiosk's price prevails over a UEX read made before it.
    const readAt = r.readAge === null ? null : S.at - r.readAge * 1000;
    const after = !!refusal && !refusal.item && readAt !== null && refusal.atMs > readAt;
    setText(
      action,
      after && r.verdict === "valid"
        ? "Un achat vient d’être refusé au terminal : vérifie le prix sur place avant de partir."
        : r.action,
    );
    setAttr(action, "data-tone", v.tone);
    setText(
      notes,
      (after
        ? "Le prix du terminal prévaut sur UEX : UEX n’a peut-être pas encore reçu le nouveau prix, relance la vérification dans quelques minutes.\n"
        : "") +
        (r.readAge !== null
          ? "Prix lus chez UEX il y a " +
            L.formatAge(r.readAge * 1000) +
            " (mémoire de 5\u00a0min au plus), " +
            r.requests +
            " requête(s).\n"
          : "") +
        r.notes.join("\n"),
    );
  }

  function render(ctx: any) {
    H = ctx || {};
    paint();
  }

  return { root, line, render, dispose, state: () => S };
}

/** The functions of this file, in the order they are serialised (page.ts). */
export const TRADE_PREFLIGHT_VIEW_FUNCTIONS = [
  tradePreflightConfig,
  tradeVerdictInfo,
  tradeRefusalInfo,
  tradePfText,
  tradePfNum,
  tradePreflightClean,
  tradePreflightPlanOk,
  tradePreflightMatches,
  tradePreflightPanel,
];
