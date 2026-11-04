import type { Side, Transaction } from "./trade.js";

/**
 * "The price moved while I was buying": the game refuses a purchase or a sale whose displayed price is no longer the
 * kiosk's (`TransactionCostMismatch`). This module only READS what the trade journal (trade.ts) already concluded: it parses
 * no log line itself. A refused transaction is `status: "failed"` with that result as its `reason` (confirmed), or, when an
 * error line followed several same-side requests and could not be attributed to one, `status: "unconfirmed"` with a reason
 * that starts with `ambiguous: TransactionCostMismatch`.
 *
 * An ambiguous error is stamped on EVERY candidate request of its 3-second window, so counting transactions would count one
 * refusal several times: they are grouped, by kind and side, into ONE event marked `ambiguous` (one of those requests was
 * refused, the log does not say which).
 *
 * The events carry NO amount, no shop, no item and no identifier: a time, a side, a kind and how sure the journal is.
 * Nothing here depends on the balance, so they may travel to a View that does not show it.
 */

export const PRICE_REFUSAL_RESULT = "TransactionCostMismatch";
/** Events kept (the newest). */
export const PRICE_REFUSAL_MAX = 20;
/** Transactions examined (the journal keeps no more than this many for the dashboard either). */
const MAX_EXAMINED = 400;
/** The journal's own window for attributing an error to a request. */
const GROUP_WINDOW_MS = 3000;

export interface PriceRefusal {
  /** ISO time of the refused transaction (of the last one, for an ambiguous group). */
  at: string;
  side: Side;
  /** commodity: a cargo trade at a kiosk or a terminal. item: a shop purchase. */
  kind: "commodity" | "item";
  confidence: "confirmed" | "ambiguous";
}

/** The price refusals in a journal's transactions, oldest first, at most PRICE_REFUSAL_MAX. */
export function priceRefusalsOf(transactions: readonly Transaction[] | undefined): PriceRefusal[] {
  if (!Array.isArray(transactions)) return [];
  const out: PriceRefusal[] = [];
  const ambiguous: { at: number; side: Side; kind: "commodity" | "item" }[] = [];
  for (const t of transactions.slice(-MAX_EXAMINED)) {
    if (!t || typeof t !== "object") continue;
    if (t.side !== "buy" && t.side !== "sell") continue;
    if (t.kind !== "commodity" && t.kind !== "item") continue;
    const at = typeof t.time === "string" ? Date.parse(t.time) : NaN;
    if (!Number.isFinite(at)) continue;
    const reason = typeof t.reason === "string" ? t.reason : "";
    if (t.status === "failed" && reason === PRICE_REFUSAL_RESULT) {
      out.push({
        at: new Date(at).toISOString(),
        side: t.side,
        kind: t.kind,
        confidence: "confirmed",
      });
    } else if (
      t.status === "unconfirmed" &&
      reason.startsWith(`ambiguous: ${PRICE_REFUSAL_RESULT}`)
    ) {
      ambiguous.push({ at, side: t.side, kind: t.kind });
    }
  }
  // One event per group of ambiguous candidates (same kind and side, each within the window of the previous one).
  ambiguous.sort((a, b) => a.at - b.at);
  let group: { at: number; side: Side; kind: "commodity" | "item" } | null = null;
  for (const c of ambiguous) {
    if (
      group &&
      group.kind === c.kind &&
      group.side === c.side &&
      c.at - group.at <= GROUP_WINDOW_MS
    ) {
      group.at = c.at;
      continue;
    }
    if (group)
      out.push({
        at: new Date(group.at).toISOString(),
        side: group.side,
        kind: group.kind,
        confidence: "ambiguous",
      });
    group = { ...c };
  }
  if (group)
    out.push({
      at: new Date(group.at).toISOString(),
      side: group.side,
      kind: group.kind,
      confidence: "ambiguous",
    });
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return out.slice(-PRICE_REFUSAL_MAX);
}
