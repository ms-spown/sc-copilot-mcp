import type { TradeSource, TradeTransaction } from "./tradeTypes.js";

/**
 * THE SWAPPABLE ADAPTER between the trade journal and the commerce model. Pure, browser-safe, no import of the parser.
 *
 * The Game.log trade parser lives in pull request 45 (branch `feat/trade-journal`, `src/providers/gamelog/trade.ts`)
 * and is not on `main` yet, so this file describes the part of its `Transaction` it needs as a STRUCTURAL type (same
 * field names and values as that module) instead of importing it. When that pull request is merged:
 *   1. replace `JournalTransaction` below by `import type { Transaction } from "../providers/gamelog/trade.js"`;
 *   2. wire `tradeSourceFrom(() => journal.transactions)` as the sixth argument of `DashboardService` in
 *      `tools/dashboard.ts` (the journal being the one built from the log by that module, refreshed like the ledger);
 *   3. delete this paragraph. Nothing in the model (tradeRun.ts) or the View changes.
 * No second Game.log parser exists in this repository's dashboard code.
 *
 * Mapping decisions, all conservative:
 *   - `status` completed -> success, failed -> failed, unconfirmed -> unknown (counted, flagged). `confidence`
 *     ambiguous or unknown makes the transaction `inferred`; only `confirmed` is `logged`.
 *   - Only SCU quantities are kept as a quantity; an item line keeps none.
 *   - A commodity with an amount in a currency other than aUEC is dropped (an amount in another currency must never
 *     be added to aUEC).
 *   - The commodity is the journal's short id (the first characters of the game's GUID): the log has no name next to
 *     it, so the card shows that id until a name lookup is added, and a plan for "Laranite" is then "not verified".
 */
export interface JournalTransaction {
  time: string;
  kind: "item" | "commodity";
  side: "buy" | "sell";
  status: "completed" | "failed" | "unconfirmed";
  confidence: "confirmed" | "inferred" | "unknown" | "ambiguous";
  shop: string | null;
  total_auec: number;
  currency: string;
  quantity: number;
  unit: "item" | "SCU";
  commodity_id?: string;
  auto_loading?: boolean | null;
}

export function fromJournalTransaction(t: JournalTransaction): TradeTransaction | null {
  if (t.kind === "commodity" && t.currency !== "aUEC") return null;
  return {
    at: t.time,
    side: t.side,
    kind: t.kind,
    total_auec: t.total_auec,
    quantity: t.unit === "SCU" ? t.quantity : null,
    unit: t.unit === "SCU" ? "SCU" : null,
    commodity: t.commodity_id ?? null,
    shop: t.shop,
    auto_loading: t.auto_loading === true,
    outcome: t.status === "completed" ? "success" : t.status === "failed" ? "failed" : "unknown",
    confidence: t.confidence === "confirmed" ? "logged" : "inferred",
  };
}

/** A `TradeSource` over the journal's transactions (read at every poll: the journal is already in memory). */
export function tradeSourceFrom(read: () => readonly JournalTransaction[]): TradeSource {
  return () => {
    const out: TradeTransaction[] = [];
    for (const t of read()) {
      const mapped = fromJournalTransaction(t);
      if (mapped) out.push(mapped);
    }
    return out;
  };
}
