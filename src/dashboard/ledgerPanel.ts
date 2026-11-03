/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The transport ledger panel of the live dashboard View ("Carnet de transport"): pure display logic and the DOM of
 * one full-screen card plus one compact line. Shipped inside the page by page.ts, next to the functions of
 * viewLogic.ts, with the same rules (they are serialised with Function.prototype.toString):
 *   - only function declarations, no imports, no module-level values (a function may call another one of this file);
 *   - the formatters of viewLogic.ts (fmtAuec, formatDuration, formatClock) arrive through the `L` argument;
 *   - text reaches the DOM only through textContent.
 *
 * The data are written by the game (contract titles, places, goods) and by the server's balance measure. Nothing
 * here invents a figure: a step without a quantity shows none, an absent gain is not zero, and a gain is drawn only
 * while the player has chosen to show the balance.
 */

export function ledgerConfig() {
  return { maxContracts: 10, maxSteps: 8, titleMax: 80, labelMax: 60, slotsSteps: 8 };
}

/** One text from the payload: invisible characters out, one line, capped. The server did it already; so does the View. */
export function ledgerText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const clean = value
    .replace(/[\p{Cf}\p{Cc}\p{Co}\p{Cn}\p{Cs}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(clean).slice(0, max).join("");
}

export function ledgerNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function ledgerIso(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function ledgerOneOf(value: unknown, list: string[], fallback: string): string {
  return typeof value === "string" && list.indexOf(value) >= 0 ? value : fallback;
}

export function ledgerTexts(value: unknown, count: number, max: number): string[] {
  return (Array.isArray(value) ? value : [])
    .slice(0, count)
    .map((v: any) => ledgerText(v, max))
    .filter((v: string) => v !== "");
}

export function ledgerTradeFee(raw: any): any {
  if (!raw || typeof raw !== "object") return null;
  const auec = ledgerNum(raw.auec);
  if (auec === null) return null;
  return { auec, method: ledgerOneOf(raw.method, ["exact", "groupe", "estime"], "estime") };
}

/** The money of one run, rebuilt field by field. Every number here is an amount (or derived from one). */
export function ledgerTradeMoney(raw: any): any {
  if (!raw || typeof raw !== "object") return null;
  const f = raw.fees && typeof raw.fees === "object" ? raw.fees : {};
  const n = raw.net && typeof raw.net === "object" ? raw.net : {};
  const pn = raw.planned_net && typeof raw.planned_net === "object" ? raw.planned_net : null;
  const pj = raw.projection && typeof raw.projection === "object" ? raw.projection : null;
  return {
    planned_profit: ledgerNum(raw.planned_profit),
    plan_match: ledgerOneOf(raw.plan_match, ["ok", "non_verifie"], ""),
    turnover: ledgerNum(raw.turnover),
    cost: ledgerNum(raw.cost),
    cost_prorata: raw.cost_prorata === true,
    gross_margin: ledgerNum(raw.gross_margin),
    price_gap: ledgerNum(raw.price_gap),
    gap_includes_quantity: raw.gap_includes_quantity === true,
    fees: {
      total: ledgerNum(f.total),
      method: ledgerOneOf(f.method, ["mesure", "estime"], ""),
      buy: ledgerTradeFee(f.buy),
      sell: ledgerTradeFee(f.sell),
      rate: ledgerNum(f.rate),
      rate_from: ledgerOneOf(f.rate_from, ["ce_trajet", "trajet_precedent"], ""),
      unexplained: ledgerNum(f.unexplained),
    },
    net: {
      auec: ledgerNum(n.auec),
      method: ledgerOneOf(n.method, ["mesure", "calcule", "estime"], ""),
      reason: ledgerOneOf(
        n.reason,
        [
          "en_cours",
          "en_attente",
          "solde_avant_inconnu",
          "solde_apres_inconnu",
          "cout_inconnu",
          "pas_de_solde",
        ],
        "",
      ),
      start_balance: ledgerNum(n.start_balance),
      end_balance: ledgerNum(n.end_balance),
    },
    avg_buy_per_scu: ledgerNum(raw.avg_buy_per_scu),
    avg_sell_per_scu: ledgerNum(raw.avg_sell_per_scu),
    planned_net:
      pn && ledgerNum(pn.auec) !== null
        ? {
            auec: ledgerNum(pn.auec),
            basis: ledgerOneOf(pn.basis, ["prix_du_plan", "chiffre_affaires_observe"], ""),
            fee_rate: ledgerNum(pn.fee_rate),
            fee: ledgerNum(pn.fee),
          }
        : null,
    projection:
      pj && ledgerNum(pj.run_ms) !== null
        ? {
            run_ms: ledgerNum(pj.run_ms),
            runs_per_hour: ledgerNum(pj.runs_per_hour),
            net_per_hour: ledgerNum(pj.net_per_hour),
            day_hours: ledgerNum(pj.day_hours),
            runs_per_day: ledgerNum(pj.runs_per_day),
            net_per_day: ledgerNum(pj.net_per_day),
            next_run_net: ledgerNum(pj.next_run_net),
            assumptions: ledgerTexts(pj.assumptions, 6, 160),
          }
        : null,
  };
}

/** The commerce section as the View keeps it (see tradeRun.ts): runs with or without their money. null when absent. */
export function ledgerTradeNormalize(raw: any): any {
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  const stages = ["open", "partial", "complete", "sold_only"];
  const runs = (Array.isArray(raw.runs) ? raw.runs : [])
    .slice(0, 4)
    .filter((r: any) => r && typeof r === "object")
    .map((r: any) => ({
      id: ledgerText(r.id, 40),
      commodity: r.commodity === null ? null : ledgerText(r.commodity, 60) || null,
      more_commodities: ledgerTexts(r.more_commodities, 3, 60),
      buy_shops: ledgerTexts(r.buy_shops, 3, 60),
      sell_shops: ledgerTexts(r.sell_shops, 3, 60),
      stage: ledgerOneOf(r.stage, stages, "open"),
      started_at: ledgerIso(r.started_at),
      ended_at: ledgerIso(r.ended_at),
      duration_ms: ledgerNum(r.duration_ms) || 0,
      scu_bought: ledgerNum(r.scu_bought),
      scu_sold: ledgerNum(r.scu_sold),
      buys: ledgerNum(r.buys) || 0,
      sells: ledgerNum(r.sells) || 0,
      failed: ledgerNum(r.failed) || 0,
      uncertain: ledgerNum(r.uncertain) || 0,
      ignored: ledgerNum(r.ignored) || 0,
      money: ledgerTradeMoney(r.money),
    }));
  return {
    v: 1,
    source: raw.source === "journal" ? "journal" : "none",
    runs_total: Math.max(runs.length, ledgerNum(raw.runs_total) || 0),
    runs,
  };
}

/** The payload as the View keeps it: well-formed, bounded, or null. Unknown fields are dropped. */
export function ledgerNormalize(raw: any): any {
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  const cfg = ledgerConfig();
  const statuses = ["ok", "off", "loading", "unreadable"];
  const states = ["accepted", "in_progress", "completed", "abandoned", "failed", "ended"];
  const reasons = ["pending", "balance_unknown", "no_times"];
  const status = statuses.indexOf(raw.status) >= 0 ? raw.status : "off";
  const contracts = (Array.isArray(raw.contracts) ? raw.contracts : [])
    .slice(0, cfg.maxContracts)
    .filter((c: any) => c && typeof c === "object")
    .map((c: any) => {
      const steps = (Array.isArray(c.steps) ? c.steps : [])
        .slice(0, cfg.maxSteps)
        .filter((s: any) => s && (s.kind === "pickup" || s.kind === "dropoff"))
        .map((s: any) => ({
          kind: s.kind,
          location: ledgerText(s.location, cfg.labelMax),
          cargo: ledgerText(s.cargo, cfg.labelMax),
        }));
      const total = ledgerNum(c.steps_total);
      const stepsTotal =
        total === null ? steps.length : Math.max(steps.length, Math.min(9999, Math.floor(total)));
      const done = ledgerNum(c.steps_done);
      let gain: any = null;
      if (c.gain && typeof c.gain === "object") {
        gain = {
          auec: ledgerNum(c.gain.auec),
          reason: reasons.indexOf(c.gain.reason) >= 0 ? c.gain.reason : "",
          overlapping: c.gain.overlapping === true,
        };
      }
      return {
        id: typeof c.id === "string" ? ledgerText(c.id, 16) : "",
        title: ledgerText(c.title, cfg.titleMax),
        state: states.indexOf(c.state) >= 0 ? c.state : "ended",
        accepted_at: ledgerIso(c.accepted_at),
        ended_at: ledgerIso(c.ended_at),
        duration_ms: ledgerNum(c.duration_ms),
        steps,
        steps_total: stepsTotal,
        steps_done: done === null ? 0 : Math.max(0, Math.min(Math.floor(done), stepsTotal)),
        gain,
      };
    });
  const t = raw.totals && typeof raw.totals === "object" ? raw.totals : {};
  const b = raw.balance && typeof raw.balance === "object" ? raw.balance : null;
  const p = raw.plan_compare && typeof raw.plan_compare === "object" ? raw.plan_compare : null;
  return {
    v: 1,
    status,
    partial: raw.partial === true,
    contracts_total: Math.max(contracts.length, ledgerNum(raw.contracts_total) || 0),
    contracts,
    totals: {
      completed: ledgerNum(t.completed) || 0,
      abandoned: ledgerNum(t.abandoned) || 0,
      failed: ledgerNum(t.failed) || 0,
      duration_ms: ledgerNum(t.duration_ms) || 0,
    },
    balance: b
      ? {
          gain_auec: ledgerNum(b.gain_auec),
          measured_contracts: ledgerNum(b.measured_contracts) || 0,
          rate_auec_per_hour: ledgerNum(b.rate_auec_per_hour),
        }
      : null,
    plan_compare: p
      ? {
          expected_auec: ledgerNum(p.expected_auec),
          measured_auec: ledgerNum(p.measured_auec),
          ratio: ledgerNum(p.ratio),
        }
      : null,
    trade: ledgerTradeNormalize(raw.trade),
  };
}

/**
 * What the channel between Views may carry and accept: the payload rebuilt field by field and stripped of every
 * figure derived from the balance, whatever the sender put in it. null when it is not a ledger at all.
 */
export function ledgerChannelClean(raw: any): any {
  const n = ledgerNormalize(raw);
  if (!n) return null;
  delete n.balance;
  delete n.plan_compare;
  for (const c of n.contracts) delete c.gain;
  // The commerce runs keep their goods, places, quantities and times, never their money.
  if (n.trade) for (const r of n.trade.runs) r.money = null;
  return n;
}

/** The raw payload without anything derived from the balance (used when the player hides the balance again). */
export function ledgerStripBalance(raw: any): any {
  if (!raw || typeof raw !== "object") return raw;
  const out: any = Object.assign({}, raw);
  delete out.balance;
  delete out.plan_compare;
  if (Array.isArray(raw.contracts)) {
    out.contracts = raw.contracts.map((c: any) => {
      const copy: any = Object.assign({}, c);
      delete copy.gain;
      return copy;
    });
  }
  if (raw.trade && typeof raw.trade === "object") {
    out.trade = Object.assign({}, raw.trade, {
      runs: (Array.isArray(raw.trade.runs) ? raw.trade.runs : []).map((r: any) => {
        const copy: any = Object.assign({}, r);
        delete copy.money;
        return copy;
      }),
    });
  }
  return out;
}

/** The contract being worked on: the newest one that is accepted or in progress. */
export function ledgerCurrent(ledger: any): any {
  if (!ledger || ledger.status !== "ok") return null;
  for (const c of ledger.contracts)
    if (c.state === "accepted" || c.state === "in_progress") return c;
  return null;
}

/** "Étape 2/3": the step after the ones whose notices were counted. 0 when the log gave no step. */
export function ledgerStepNumber(contract: any): number {
  if (!contract || !(contract.steps_total > 0)) return 0;
  return Math.min(contract.steps_done + 1, contract.steps_total);
}

/** The compact line shown in the small view while a contract is running; "" when there is none. */
export function ledgerInlineText(ledger: any): string {
  const c = ledgerCurrent(ledger);
  if (!c) return "";
  const n = ledgerStepNumber(c);
  return (
    "Contrat en cours : " +
    (c.title || "sans titre") +
    (n > 0 ? " · étape " + n + "/" + c.steps_total : "")
  );
}

export function ledgerStateLabel(state: string): string {
  const names: any = {
    accepted: "accepté",
    in_progress: "en cours",
    completed: "terminé",
    abandoned: "abandonné",
    failed: "échoué",
    ended: "clos",
  };
  return names[state] || "clos";
}

/** Game identifiers read as words: "HaulCargo_Waste_Stanton" becomes "Waste Stanton". Cosmetic only. */
export function ledgerPretty(name: string): string {
  return String(name || "")
    .replace(/^HaulCargo_/, "")
    .replace(/_+/g, " ")
    .trim();
}

export function ledgerStepText(step: any): string {
  const parts = [step.kind === "pickup" ? "Chargement" : "Livraison"];
  const place = ledgerPretty(step.location);
  const goods = ledgerPretty(step.cargo);
  if (place) parts.push(place);
  if (goods) parts.push(goods);
  return parts.join(" · ");
}

/** The gain line of one completed contract. `tone` is "ok", "warn" or "" (no colour). */
export function ledgerGainText(L: any, gain: any): any {
  if (!gain) return { text: "", tone: "" };
  if (typeof gain.auec === "number") {
    return {
      text:
        "Gain mesuré : " +
        L.fmtAuec(gain.auec, true) +
        "\u00a0aUEC (brut)" +
        (gain.overlapping ? " · chevauche un autre contrat" : ""),
      tone: gain.auec < 0 ? "warn" : "ok",
    };
  }
  const why: any = {
    pending: "Gain en attente : le solde final est lu quelques secondes après la fin.",
    balance_unknown: "Gain indisponible : le solde n’était pas suivi à ce moment.",
    no_times: "Gain indisponible : horodatage manquant dans le journal.",
  };
  return { text: why[gain.reason] || "Gain indisponible.", tone: "" };
}

/**
 * Builds the card and the compact line once; `render(raw, ctx)` then only changes text and attributes.
 * ctx: { showBalance, fullscreen, now }.
 */
export function ledgerPanel(doc: any, L: any): any {
  const cfg = ledgerConfig();
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
  const row = (label: string): any => {
    const r: any = { root: el("div", "fact") };
    r.value = el("span", "fact-value", "—");
    add(r.root, el("span", "fact-label", label), r.value);
    return r;
  };

  // The compact line of the small view
  const line = el("p", "lg-line", "");
  line.setAttribute("data-hidden", "1");

  // The full-screen card
  const root = el("section", "card ledger");
  root.setAttribute("data-hidden", "1");
  const head = add(el("div", "card-head"), el("h2", "card-title", "Carnet de transport"));
  const body = el("div", "card-body");
  const message = el("p", "note lg-message", "");
  const list = el("div", "lg-list");
  const slots: any[] = [];
  for (let i = 0; i < cfg.maxContracts; i++) {
    const s: any = { root: el("div", "lg-contract") };
    s.head = el("div", "lg-head");
    s.title = el("span", "lg-title", "");
    s.chip = el("span", "lg-chip", "");
    add(s.head, s.title, s.chip);
    s.meta = el("div", "lg-meta", "");
    // Steps done out of steps announced: the same gauge as the other bars of the cockpit
    s.gauge = el("div", "gauge");
    s.gaugeFill = el("div", "gauge-fill");
    add(s.gauge, s.gaugeFill);
    s.steps = el("ol", "lg-steps");
    s.stepRows = [];
    for (let k = 0; k < cfg.slotsSteps; k++) {
      const li = el("li", "lg-step");
      li.tick = el("span", "lg-tick", "");
      li.text = el("span", "lg-step-text", "");
      add(li, li.tick, li.text);
      s.stepRows.push(li);
      add(s.steps, li);
    }
    s.more = el("div", "lg-more", "");
    s.gain = el("div", "lg-gain", "");
    add(s.root, s.head, s.meta, s.gauge, s.steps, s.more, s.gain);
    slots.push(s);
    add(list, s.root);
  }
  const sum = el("div", "facts lg-sum");
  const rDone = row("Contrats terminés");
  const rOther = row("Abandonnés ou échoués");
  const rTime = row("Durée cumulée des terminés");
  const rGain = row("Gain total mesuré");
  const rRate = row("Rythme");
  const rPlan = row("Profit prévu (plan, avant frais)");
  const rReal = row("Récompense mesurée, dernier contrat");
  add(sum, rDone.root, rOther.root, rTime.root, rGain.root, rRate.root, rPlan.root, rReal.root);
  const note = el(
    "p",
    "note",
    "Le journal de jeu donne le titre, les lieux et les marchandises, mais ni la quantité (SCU) ni la récompense. Les étapes cochées sont estimées d’après le nombre d’objectifs terminés. Le gain est le solde à la fin moins le solde à l’acceptation : il mêle achats, récompenses et amendes survenus entre-temps.",
  );
  add(body, message, list, sum, note);
  add(root, head, body);

  function render(raw: any, ctx: any) {
    const ledger = ledgerNormalize(raw);
    const showBalance = !!(ctx && ctx.showBalance);
    const full = !!(ctx && ctx.fullscreen);
    const now = ctx && typeof ctx.now === "number" ? ctx.now : Date.now();

    const inline = full ? "" : ledgerInlineText(ledger);
    setText(line, inline);
    show(line, inline !== "");

    show(root, full && !!ledger);
    if (!full || !ledger) return;

    const ok = ledger.status === "ok";
    let msg = "";
    if (ledger.status === "off") {
      msg =
        "Le carnet a besoin du journal de jeu, désactivé pour l’instant. Demande à Claude d’appeler sc_log_status : il explique comment l’activer (SC_INSTALL_DIR ou SC_GAME_LOG_PATH).";
    } else if (ledger.status === "loading") {
      msg = "Lecture du journal de jeu…";
    } else if (ledger.status === "unreadable") {
      msg =
        "Le journal de jeu est configuré mais illisible pour l’instant (le jeu n’a peut-être pas encore été lancé). Demande à Claude d’appeler sc_log_status.";
    } else if (ledger.contracts.length === 0) {
      msg = "Aucun contrat dans la session de jeu en cours.";
    } else if (ledger.partial) {
      msg =
        "Journal très long : seule la fin a été lue, les contrats plus anciens peuvent manquer.";
    }
    setText(message, msg);
    show(message, msg !== "");

    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const c = ok ? ledger.contracts[i] : undefined;
      show(s.root, !!c);
      if (!c) continue;
      setAttr(s.root, "data-state", c.state);
      setText(s.title, c.title || "Contrat sans titre");
      setText(s.chip, ledgerStateLabel(c.state));
      setAttr(s.chip, "data-state", c.state);
      const accepted = c.accepted_at ? "accepté à " + L.formatClock(c.accepted_at) : "";
      const active = c.state === "accepted" || c.state === "in_progress";
      const span = active
        ? c.accepted_at
          ? "en cours depuis " + L.formatDuration(now - Date.parse(c.accepted_at))
          : ""
        : c.duration_ms !== null
          ? "durée " + L.formatDuration(c.duration_ms)
          : "";
      setText(s.meta, [accepted, span].filter(Boolean).join(" · "));
      const bar = c.steps_total > 0;
      show(s.gauge, bar);
      setAttr(s.gauge, "data-level", c.state === "completed" ? "ok" : "info");
      setVar(
        s.gaugeFill,
        "--p",
        bar ? String(Math.round((c.steps_done / c.steps_total) * 1000) / 10) : "0",
      );
      for (let k = 0; k < s.stepRows.length; k++) {
        const step = c.steps[k];
        const li = s.stepRows[k];
        show(li, !!step);
        if (!step) continue;
        const done = k < c.steps_done;
        setAttr(li, "data-done", done ? "1" : "0");
        setText(li.tick, done ? "✓" : "○");
        setText(li.text, ledgerStepText(step));
      }
      const hidden = c.steps_total - c.steps.length;
      setText(
        s.more,
        hidden > 0
          ? "+ " + hidden + " autre" + (hidden > 1 ? "s" : "") + " étape" + (hidden > 1 ? "s" : "")
          : "",
      );
      show(s.more, hidden > 0);
      const g =
        showBalance && c.state === "completed" ? ledgerGainText(L, c.gain) : { text: "", tone: "" };
      setText(s.gain, g.text);
      setAttr(s.gain, "data-tone", g.tone);
      show(s.gain, g.text !== "");
    }

    const t = ledger.totals;
    show(sum, ok && ledger.contracts_total > 0);
    setText(rDone.value, String(t.completed));
    setText(rOther.value, String(t.abandoned + t.failed));
    setText(rTime.value, t.completed > 0 ? L.formatDuration(t.duration_ms) : "—");
    const b = showBalance ? ledger.balance : null;
    show(rGain.root, showBalance);
    show(rRate.root, showBalance);
    setText(
      rGain.value,
      b && typeof b.gain_auec === "number" ? L.fmtAuec(b.gain_auec, true) + "\u00a0aUEC" : "—",
    );
    setText(
      rRate.value,
      b && typeof b.rate_auec_per_hour === "number"
        ? L.fmtAuec(b.rate_auec_per_hour, true) + "\u00a0aUEC/h"
        : b
          ? "disponible après 2 min de contrats"
          : "—",
    );
    const pc = showBalance ? ledger.plan_compare : null;
    show(rPlan.root, !!pc && typeof pc.expected_auec === "number");
    show(rReal.root, !!pc && typeof pc.expected_auec === "number");
    setText(
      rPlan.value,
      pc && typeof pc.expected_auec === "number"
        ? L.fmtAuec(pc.expected_auec, true) + "\u00a0aUEC"
        : "—",
    );
    setText(
      rReal.value,
      pc && typeof pc.measured_auec === "number"
        ? L.fmtAuec(pc.measured_auec, true) + "\u00a0aUEC"
        : "—",
    );
  }

  return { line, card: root, render };
}

/** The functions of this file, in the order they are serialised (page.ts). */
export const LEDGER_VIEW_FUNCTIONS = [
  ledgerConfig,
  ledgerText,
  ledgerNum,
  ledgerIso,
  ledgerOneOf,
  ledgerTexts,
  ledgerTradeFee,
  ledgerTradeMoney,
  ledgerTradeNormalize,
  ledgerNormalize,
  ledgerStripBalance,
  ledgerChannelClean,
  ledgerCurrent,
  ledgerStepNumber,
  ledgerInlineText,
  ledgerStateLabel,
  ledgerPretty,
  ledgerStepText,
  ledgerGainText,
  ledgerPanel,
];
