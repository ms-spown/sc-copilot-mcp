/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * PLACEHOLDER of the commerce action bar: the buttons ("Routes les plus rentables", "Routes les plus rapides",
 * "Route sûre"), the options (checkboxes, budget, cargo) and "Demander à l'agent" that another piece of work will
 * build on top of the commerce card. It is a SEPARATE component on purpose: the card (tradePanel.ts) only offers it a
 * slot (`card.slot`, the first thing under the header), and this module owns everything inside the slot.
 *
 * Today it does nothing and stays hidden. What is ready for the follow-up:
 *   - the slot, hidden by default (`data-hidden="1"`), filled by `render({ enabled: true, ... })`;
 *   - `tradeApplySuggestion`: a suggested route has the very shape of a plan (commodity, buy and sell terminals, scu,
 *     unit prices, expected profit, estimated trip time, safety note, price points), so applying it as the active plan
 *     is passing it through the plan cleaner again, nothing else to convert;
 *   - `tradeSuggestionText`: the one-line label of a suggestion, for the buttons that will apply it.
 * Same rules as the other View modules: function declarations only, no import, no module-level value, textContent
 * only. Whatever this bar will post into the conversation (ui/message) must be a fixed text built in viewLogic.ts, never
 * the balance (see actionMessage there).
 */

export function tradeActionsConfig() {
  return { slot: "trade-actions", maxSuggestions: 5 };
}

/** A suggestion as the plan the dashboard would run with; null when it is not a usable plan. */
export function tradeApplySuggestion(L: any, suggestion: any): any {
  return L.cleanPlan(suggestion);
}

/** "Laranite · Port Tressler → Area18 · ≈ +136 432 aUEC · 25 min" for a suggestion; never throws. */
export function tradeSuggestionText(L: any, suggestion: any): string {
  const plan = L.cleanPlan(suggestion);
  if (!plan) return "";
  const parts: string[] = [];
  if (plan.commodity) parts.push(plan.commodity);
  if (plan.buy_terminal && plan.sell_terminal)
    parts.push(plan.buy_terminal + " → " + plan.sell_terminal);
  if (typeof plan.expected_profit_auec === "number")
    parts.push("≈ " + L.fmtAuec(plan.expected_profit_auec, true) + "\u00a0aUEC");
  if (plan.est_trip_minutes) parts.push(plan.est_trip_minutes + " min");
  return parts.join(" · ");
}

/**
 * The component. `render(ctx)` shows it only when ctx.enabled is true; the follow-up replaces the body.
 * ctx (planned): { enabled, suggestions: Plan[], busy }.
 */
export function tradeActionsPanel(doc: any, L: any): any {
  const root = doc.createElement("div");
  root.className = "tr-actions";
  root.setAttribute("data-hidden", "1");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Actions de commerce");
  function render(ctx: any) {
    const on = !!(ctx && ctx.enabled === true);
    const state = on ? "0" : "1";
    if (root.getAttribute("data-hidden") !== state) root.setAttribute("data-hidden", state);
  }
  void L;
  return { root, render };
}

export const TRADE_ACTIONS_VIEW_FUNCTIONS = [
  tradeActionsConfig,
  tradeApplySuggestion,
  tradeSuggestionText,
  tradeActionsPanel,
];
