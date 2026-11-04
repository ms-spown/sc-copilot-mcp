/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The "Mouvements du solde" block of the commerce card (inside its folded details) and the words of the card's
 * unexplained-part warning. Pure display logic and the DOM of one folded block. Shipped inside the page by page.ts with
 * the same rules as the other View modules (the functions are serialised with Function.prototype.toString):
 *   - only function declarations, no imports, no module-level values (a function may call another of this file);
 *   - everything else (formatters, the ledger's cleaners) arrives through the `L` argument, which holds every function
 *     of the page: a function of ANOTHER module is never called by its bare name;
 *   - text reaches the DOM only through textContent.
 *
 * The figures come from the server's explainer (balanceMovements.ts). Nothing is invented here: a movement keeps the
 * label and the confidence the server gave it, a "probable" one says so, and an unexplained one names no cause. Every
 * amount of this block is derived from the balance: the block is drawn only while the player chose to show it, and the
 * data never travels on the channel between Views (ledgerStripBalance / ledgerChannelClean drop them).
 */

export function movementsConfig() {
  return { listed: 40, named: 5, explanationLines: 8, lineMax: 600, labelMax: 60 };
}

/** The causes, in the order the block lists them (the same ids as balanceMovements.ts). */
export function movementsCategories(): string[] {
  return [
    "explained_by_transaction",
    "fee_on_transaction",
    "item_purchase",
    "probable_contract_reward",
    "probable_insurance_or_hangar_cost",
    "unexplained",
  ];
}

/** The categories the filter chips group. */
export function movementsFilters(): any[] {
  return [
    { id: "all", label: "Tout", categories: movementsCategories() },
    {
      id: "goods",
      label: "Marchandises et frais",
      categories: ["explained_by_transaction", "fee_on_transaction"],
    },
    { id: "items", label: "Objets", categories: ["item_purchase"] },
    {
      id: "probable",
      label: "Probables ou possibles",
      categories: ["probable_contract_reward", "probable_insurance_or_hangar_cost"],
    },
    { id: "unexplained", label: "Non expliqués", categories: ["unexplained"] },
  ];
}

function movementsCoverage(L: any, raw: any): any {
  const c = raw && typeof raw === "object" ? raw : {};
  return {
    changes: L.ledgerNum(c.changes) || 0,
    gap_changes: L.ledgerNum(c.gap_changes) || 0,
    starts_before_history: c.starts_before_history === true,
    history_full: c.history_full === true,
  };
}

function movementsEntry(L: any, raw: any): any {
  if (!raw || typeof raw !== "object") return null;
  const amount = L.ledgerNum(raw.amount);
  const at = L.ledgerIso(raw.at);
  if (amount === null || at === null) return null;
  const cats = movementsCategories();
  const category = L.ledgerOneOf(raw.category, cats, "unexplained");
  const hints = (Array.isArray(raw.hints) ? raw.hints : [])
    .slice(0, 4)
    .filter(
      (h: any) =>
        h === "contract_penalty" ||
        h === "session_boundary" ||
        h === "stream_gap" ||
        h === "unmatched_transaction",
    );
  return {
    at,
    amount,
    category,
    confidence: L.ledgerOneOf(
      raw.confidence,
      ["matched", "measured", "probable", "ambiguous", "none"],
      "none",
    ),
    side: L.ledgerOneOf(raw.side, ["buy", "sell"], ""),
    ref: L.ledgerText(raw.ref, 60),
    shop: L.ledgerText(raw.shop, 60),
    cause: L.ledgerOneOf(raw.cause, ["insurance", "hangar", "insurance_or_hangar"], ""),
    reason: L.ledgerOneOf(raw.reason, ["no_cause", "ambiguous", "stream_gap"], ""),
    candidates: (Array.isArray(raw.candidates) ? raw.candidates : [])
      .slice(0, 3)
      .filter((c: any) => cats.indexOf(c) >= 0),
    several: raw.several === true,
    hints,
    doubtful: raw.doubtful === true,
  };
}

/** The session section as the View keeps it, rebuilt field by field. null when absent or not a section. */
export function movementsNormalize(L: any, raw: any): any {
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  const cfg = movementsConfig();
  const totals: any = {};
  const rt = raw.totals && typeof raw.totals === "object" ? raw.totals : {};
  for (const c of movementsCategories()) {
    const t = rt[c] && typeof rt[c] === "object" ? rt[c] : {};
    totals[c] = { count: L.ledgerNum(t.count) || 0, auec: L.ledgerNum(t.auec) || 0 };
  }
  const sp =
    raw.unexplained_split && typeof raw.unexplained_split === "object" ? raw.unexplained_split : {};
  const w = raw.window && typeof raw.window === "object" ? raw.window : {};
  return {
    v: 1,
    window: {
      from: L.ledgerIso(w.from),
      to: L.ledgerIso(w.to),
      basis: L.ledgerOneOf(w.basis, ["session", "history"], "history"),
    },
    total_auec: L.ledgerNum(raw.total_auec) || 0,
    count: L.ledgerNum(raw.count) || 0,
    totals,
    unexplained_split: {
      no_cause: L.ledgerNum(sp.no_cause) || 0,
      ambiguous: L.ledgerNum(sp.ambiguous) || 0,
      stream_gap: L.ledgerNum(sp.stream_gap) || 0,
    },
    unmatched_transactions: L.ledgerNum(raw.unmatched_transactions) || 0,
    coverage: movementsCoverage(L, raw.coverage),
    listed: (Array.isArray(raw.listed) ? raw.listed : [])
      .slice(0, cfg.listed)
      .map((e: any) => movementsEntry(L, e))
      .filter((e: any) => e !== null),
    truncated: raw.truncated === true,
    explanation: L.ledgerTexts(raw.explanation, cfg.explanationLines, cfg.lineMax),
  };
}

/** The decomposition of a run's net as the View keeps it. null when absent. */
export function movementsDecompositionNormalize(L: any, raw: any): any {
  if (!raw || typeof raw !== "object") return null;
  const net = L.ledgerNum(raw.net);
  if (net === null) return null;
  const cfg = movementsConfig();
  const p = raw.parts && typeof raw.parts === "object" ? raw.parts : {};
  const w = raw.window && typeof raw.window === "object" ? raw.window : {};
  return {
    window: { from: L.ledgerIso(w.from), to: L.ledgerIso(w.to) },
    net,
    margin: L.ledgerNum(raw.margin),
    parts: {
      transactions: L.ledgerNum(p.transactions) || 0,
      fees: L.ledgerNum(p.fees) || 0,
      items: L.ledgerNum(p.items) || 0,
      probable_rewards: L.ledgerNum(p.probable_rewards) || 0,
      probable_costs: L.ledgerNum(p.probable_costs) || 0,
      unexplained: L.ledgerNum(p.unexplained) || 0,
      ambiguous: L.ledgerNum(p.ambiguous) || 0,
      stream_gap: L.ledgerNum(p.stream_gap) || 0,
    },
    residual: L.ledgerNum(raw.residual),
    closes: raw.closes === true,
    fees_doubtful: raw.fees_doubtful === true,
    unmatched_transactions: L.ledgerNum(raw.unmatched_transactions) || 0,
    named: (Array.isArray(raw.named) ? raw.named : [])
      .slice(0, cfg.named)
      .map((n: any) => ({
        at: L.ledgerIso(n && n.at),
        amount: L.ledgerNum(n && n.amount),
        reason: L.ledgerOneOf(n && n.reason, ["no_cause", "ambiguous", "stream_gap"], "no_cause"),
      }))
      .filter((n: any) => n.at !== null && n.amount !== null),
    coverage: movementsCoverage(L, raw.coverage),
    explanation: L.ledgerTexts(raw.explanation, cfg.explanationLines, cfg.lineMax),
  };
}

/** Both pieces from a raw ledger payload (the poll's): { section, decomposition }, each null when absent. */
export function movementsFromLedger(L: any, ledger: any): any {
  const empty = { section: null, decomposition: null };
  if (!ledger || typeof ledger !== "object") return empty;
  const runs = ledger.trade && Array.isArray(ledger.trade.runs) ? ledger.trade.runs : [];
  const money = runs.length > 0 && runs[0] && runs[0].money ? runs[0].money : null;
  return {
    section: movementsNormalize(L, ledger.movements),
    decomposition: money ? movementsDecompositionNormalize(L, money.decomposition) : null,
  };
}

/**
 * The card's warning when the net holds more than the margin and the fees explain: ONE sentence naming what else moved the
 * balance (the full account is in the "Mouvements du solde" block, which the warning points to).
 */
export function movementsWarningText(L: any, d: any): string {
  if (!d || !Array.isArray(d.explanation) || d.explanation.length === 0) return "";
  const p = d.parts || {};
  const named: string[] = [];
  const add = (amount: number, what: string) => {
    if (amount)
      named.push(L.fmtAuec(amount, true) + String.fromCharCode(160) + "aUEC (" + what + ")");
  };
  add(p.probable_rewards, "récompense probable");
  add(p.probable_costs, "coût possible");
  add(p.items, "objets achetés");
  add((p.unexplained || 0) + (p.ambiguous || 0) + (p.stream_gap || 0), "non expliqué");
  return (
    "Le solde a aussi bougé" +
    (named.length ? " de " + named.join(", ") : "") +
    " : ce n’est pas le bénéfice de ce trajet seul." +
    (d.fees_doubtful ? " Les frais mesurés peuvent inclure l’une de ces causes." : "")
  );
}

export function movementsCategoryLabel(m: any): string {
  const sell = m.side === "sell";
  if (m.category === "explained_by_transaction")
    return sell ? "Vente de marchandise" : "Achat de marchandise";
  if (m.category === "fee_on_transaction")
    return m.side === ""
      ? "Frais de chargement"
      : sell
        ? "Frais sur la vente"
        : "Frais sur l’achat";
  if (m.category === "item_purchase") return sell ? "Vente d’objet" : "Achat d’objet";
  if (m.category === "probable_contract_reward") return "Récompense probable de contrat";
  // Never a cause: the log has no line that says what an insurance claim or a hangar request cost.
  if (m.category === "probable_insurance_or_hangar_cost")
    return "Coût possible (hangar ou assurance)";
  if (m.reason === "stream_gap") return "Non expliqué, pendant une coupure du flux";
  if (m.reason === "ambiguous") return "Non expliqué, deux causes possibles";
  return "Non expliqué";
}

/** The confidence in one word, as the server labelled it. */
export function movementsConfidenceLabel(confidence: string): string {
  const names: any = {
    matched: "rapproché du journal",
    measured: "mesuré",
    probable: "probable",
    ambiguous: "ambigu",
    none: "sans cause connue",
  };
  return names[confidence] || "";
}

/** Is it weaker than a measure (hatched, dashed)? */
export function movementsIsWeak(confidence: string): boolean {
  return confidence === "probable" || confidence === "ambiguous" || confidence === "none";
}

export function movementsHintText(hint: string): string {
  const names: any = {
    contract_penalty:
      "un contrat a échoué ou a été abandonné juste avant : une pénalité est possible, rien ne la prouve",
    session_boundary: "juste après un chargement ou une fin de session",
    stream_gap: "pendant une coupure du flux : l’heure et le détail ne sont pas connus",
    unmatched_transaction: "à côté d’une ligne du journal qui n’a pas trouvé son mouvement",
  };
  return names[hint] || "";
}

/** The detail under a row: what the log names, and what is only possible. Never a cause for an unexplained change. */
export function movementsDetailText(m: any): string {
  const parts: string[] = [];
  if (m.ref) {
    const id = /^[0-9a-f]{8}$/.test(m.ref) ? "marchandise " + m.ref : m.ref;
    parts.push(id);
  }
  if (m.shop) parts.push(m.shop);
  if (m.category === "probable_contract_reward")
    parts.push(
      m.several
        ? "plusieurs contrats terminés à proximité : lequel n’est pas connu"
        : "montant lu sur le solde : le journal n’a pas de ligne de récompense",
    );
  if (m.category === "probable_insurance_or_hangar_cost") {
    const near: any = {
      insurance: "une demande d’assurance",
      hangar: "une demande de hangar terminée",
      insurance_or_hangar: "une demande d’assurance et un hangar",
    };
    parts.push(
      "baisse du solde juste après " +
        (near[m.cause] || "un événement") +
        (m.several ? " (plusieurs à proximité)" : "") +
        " : le journal ne donne aucun coût, ce peut être autre chose (carburant, achat…)",
    );
  }
  if (m.category === "fee_on_transaction" && m.doubtful)
    parts.push("fenêtre qui contient aussi une autre cause possible : ce frais peut l’inclure");
  if (m.category === "unexplained" && m.reason === "ambiguous" && m.candidates.length > 0)
    parts.push(
      "pourrait être : " +
        m.candidates.map((c: string) => movementsCategoryTotalLabel(c).toLowerCase()).join(" ou "),
    );
  if (m.category === "unexplained" && m.reason !== "ambiguous" && m.hints.length === 0)
    parts.push("carburant, réparation, amende, virement ou récompense ? le journal ne le dit pas");
  for (const h of m.hints) {
    const t = movementsHintText(h);
    if (t) parts.push(t);
  }
  return parts.join(" · ");
}

/** The entries to show for a filter; `window` (iso from/to) narrows to a run, null for the whole session. */
export function movementsSelect(section: any, filterId: string, window: any): any[] {
  if (!section) return [];
  const filters = movementsFilters();
  let cats: string[] = movementsCategories();
  for (const f of filters) if (f.id === filterId) cats = f.categories;
  const from = window && window.from ? Date.parse(window.from) : null;
  const to = window && window.to ? Date.parse(window.to) : null;
  return section.listed.filter((m: any) => {
    if (cats.indexOf(m.category) < 0) return false;
    const t = Date.parse(m.at);
    if (from !== null && t < from) return false;
    if (to !== null && t > to) return false;
    return true;
  });
}

export function movementsCategoryTotalLabel(category: string): string {
  const names: any = {
    explained_by_transaction: "Marchandises rapprochées du journal",
    fee_on_transaction: "Frais mesurés",
    item_purchase: "Objets",
    probable_contract_reward: "Récompenses de contrat (probables)",
    probable_insurance_or_hangar_cost: "Coûts possibles (hangar ou assurance)",
    unexplained: "Non expliqué",
  };
  return names[category] || category;
}

/**
 * Builds the folded block once; `render(ctx)` then only changes text and attributes.
 * ctx: { section, decomposition, showBalance, fullscreen }
 */
export function movementsPanel(doc: any, L: any): any {
  const cfg = movementsConfig();
  const { el, add, setText, setAttr, show } = L.domKit(doc);

  const root = el("details", "mv");
  root.setAttribute("id", "mv");
  root.setAttribute("data-hidden", "1");
  const sum = el("summary", "mv-sum", "Mouvements du solde");
  const body = el("div", "mv-body");
  const intro = el(
    "p",
    "note",
    "Chaque variation du solde vue par le tableau de bord, avec au plus une cause et son degré de certitude. Le journal du jeu n’a ni solde, ni ligne de frais, ni montant de récompense : ce qui n’y laisse pas de trace reste « non expliqué ».",
  );
  const explain = el("div", "mv-explain");
  const explainLines: any[] = [];
  for (let i = 0; i < cfg.explanationLines; i++) {
    const p = el("p", "mv-explain-line", "");
    explainLines.push(p);
    add(explain, p);
  }
  const totalsTitle = el("h3", "sub-title", "Par cause");
  const totalsList = el("div", "tr-lines mv-totals");
  const totalRows: any[] = [];
  for (let i = 0; i < movementsCategories().length; i++) {
    const r: any = { root: el("div", "tr-line-row") };
    r.label = el("span", "tr-line-label", "");
    r.value = el("span", "tr-line-value", "");
    r.sub = el("span", "tr-line-sub", "");
    add(r.root, r.label, r.value, r.sub);
    totalRows.push(r);
    add(totalsList, r.root);
  }
  const listTitle = el("h3", "sub-title", "Les variations");
  const filterBar = el("div", "mv-filters");
  filterBar.setAttribute("role", "group");
  filterBar.setAttribute("aria-label", "Filtrer les mouvements du solde");
  const state: any = { filter: "all", run: false, last: null };
  const chips: any[] = [];
  const filters = movementsFilters();
  for (const f of filters) {
    const b = el("button", "mv-chip", f.label);
    b.setAttribute("type", "button");
    b.setAttribute("data-filter", f.id);
    b.setAttribute("aria-pressed", f.id === "all" ? "true" : "false");
    b.addEventListener("click", () => {
      state.filter = f.id;
      if (state.last) render(state.last);
    });
    chips.push({ node: b, id: f.id });
    add(filterBar, b);
  }
  const runBtn = el("button", "mv-chip mv-chip-run", "Ce trajet seulement");
  runBtn.setAttribute("type", "button");
  runBtn.setAttribute("aria-pressed", "false");
  runBtn.addEventListener("click", () => {
    state.run = !state.run;
    if (state.last) render(state.last);
  });
  add(filterBar, runBtn);
  const list = el("ul", "mv-list");
  const rows: any[] = [];
  for (let i = 0; i < cfg.listed; i++) {
    const r: any = { root: el("li", "mv-row") };
    r.time = el("span", "mv-time", "");
    r.amount = el("span", "mv-amount", "");
    r.label = el("span", "mv-label", "");
    r.tag = el("span", "tr-tag", "");
    r.detail = el("span", "mv-detail", "");
    const top = el("div", "mv-top");
    add(top, r.time, r.label, r.tag, r.amount);
    add(r.root, top, r.detail);
    rows.push(r);
    add(list, r.root);
  }
  const empty = el("p", "note mv-empty", "");
  const foot = el("p", "note mv-foot", "");
  add(body, intro, explain, totalsTitle, totalsList, listTitle, filterBar, list, empty, foot);
  add(root, sum, body);

  function render(ctx: any) {
    state.last = ctx;
    const section = ctx && ctx.showBalance ? ctx.section : null;
    const on = !!(ctx && ctx.fullscreen) && !!section;
    show(root, on);
    if (!on) {
      // Hidden (the balance was hidden again, or the view is compact): nothing derived from the balance may stay in the
      // DOM text, only hidden.
      for (const p of explainLines) setText(p, "");
      for (const r of totalRows) {
        setText(r.label, "");
        setText(r.value, "");
        setText(r.sub, "");
      }
      for (const r of rows) {
        setText(r.time, "");
        setText(r.label, "");
        setText(r.tag, "");
        setText(r.amount, "");
        setText(r.detail, "");
      }
      setText(empty, "");
      setText(foot, "");
      return;
    }
    const d = ctx.decomposition;
    const lines: string[] = [];
    // The run's own account first (when its net was measured), then the session's.
    if (d) for (const s of d.explanation) lines.push(s);
    else for (const s of section.explanation) lines.push(s);
    for (let i = 0; i < explainLines.length; i++) {
      setText(explainLines[i], lines[i] || "");
      show(explainLines[i], !!lines[i]);
    }
    // totals per cause, over the whole session window
    for (let i = 0; i < movementsCategories().length; i++) {
      const c = movementsCategories()[i] as string;
      const t = section.totals[c];
      const r = totalRows[i];
      show(r.root, t.count > 0);
      setText(r.label, movementsCategoryTotalLabel(c));
      setText(r.value, L.fmtAuec(t.auec, true) + String.fromCharCode(160) + "aUEC");
      setText(r.sub, t.count + " variation(s)");
      setAttr(
        r.root,
        "data-estimate",
        c === "probable_contract_reward" ||
          c === "probable_insurance_or_hangar_cost" ||
          c === "unexplained"
          ? "1"
          : "0",
      );
    }
    for (const c of chips)
      setAttr(c.node, "aria-pressed", c.id === state.filter ? "true" : "false");
    const runWindow = d && d.window && d.window.from ? d.window : null;
    show(runBtn, !!runWindow);
    if (!runWindow) state.run = false;
    setAttr(runBtn, "aria-pressed", state.run ? "true" : "false");
    const shown = movementsSelect(section, state.filter, state.run ? runWindow : null);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const m = shown[i];
      show(r.root, !!m);
      if (!m) continue;
      setText(r.time, L.formatClock(m.at));
      setText(r.label, movementsCategoryLabel(m));
      setText(
        r.tag,
        m.category === "probable_insurance_or_hangar_cost"
          ? "possible"
          : movementsConfidenceLabel(m.confidence),
      );
      setAttr(r.tag, "data-estimate", movementsIsWeak(m.confidence) ? "1" : "0");
      setText(r.amount, L.fmtAuec(m.amount, true) + String.fromCharCode(160) + "aUEC");
      setAttr(r.amount, "data-tone", m.amount > 0 ? "ok" : m.amount < 0 ? "bad" : "");
      setAttr(r.root, "data-category", m.category);
      const detail = movementsDetailText(m);
      setText(r.detail, detail);
      show(r.detail, detail !== "");
    }
    // The filters only see the lines the server listed (the newest ones): say so when that is not all of them.
    const partial = section.listed.length < section.count;
    const msg =
      shown.length === 0
        ? partial
          ? "Aucune variation pour ce filtre parmi les " +
            section.listed.length +
            " dernières listées (les totaux ci-dessus couvrent les " +
            section.count +
            ")."
          : "Aucune variation pour ce filtre."
        : "";
    setText(empty, msg);
    show(empty, msg !== "");
    let footText = "";
    if (partial)
      footText =
        "Les " +
        section.listed.length +
        " variations les plus récentes sont listées ; les totaux couvrent les " +
        section.count +
        ". Les filtres et « Ce trajet seulement » ne portent que sur ces " +
        section.listed.length +
        " lignes.";
    if (section.coverage.starts_before_history)
      footText +=
        (footText ? " " : "") +
        "Le tableau de bord n’a pas vu le solde au début de la session : les variations d’avant manquent.";
    setText(foot, footText);
    show(foot, footText !== "");
  }

  /** The card's warning opens and closes the block; the card's folded details are opened by the caller. */
  const toggle = () => {
    root.open = !root.open;
    if (root.open && root.scrollIntoView) root.scrollIntoView({ block: "nearest" });
  };
  return { root, render, toggle, isOpen: () => root.open === true };
}

/** The functions of this file, in the order they are serialised (page.ts). */
export const MOVEMENTS_VIEW_FUNCTIONS = [
  movementsConfig,
  movementsCategories,
  movementsFilters,
  movementsCoverage,
  movementsEntry,
  movementsNormalize,
  movementsDecompositionNormalize,
  movementsFromLedger,
  movementsWarningText,
  movementsCategoryLabel,
  movementsConfidenceLabel,
  movementsIsWeak,
  movementsHintText,
  movementsDetailText,
  movementsSelect,
  movementsCategoryTotalLabel,
  movementsPanel,
];
