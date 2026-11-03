/**
 * The INPUT CONTRACT of the commerce model (tradeRun.ts): one buy or sell transaction of the player, as the trade
 * journal (the log parser) will deliver it. Browser-safe: types only, no import of any kind.
 *
 * This file is the seam. The real Game.log parser lives on another branch (`feat/trade-journal`); until it lands,
 * the dashboard is fed through a `TradeSource` (an injected function) that returns nothing in production and
 * synthetic transactions in tests and in the preview. When the parser exists its event type is mapped to this one
 * by a small adapter and nothing else changes.
 */

export type TradeSide = "buy" | "sell";
/** `commodity`: goods bought or sold by the SCU at a trading terminal. `item`: anything else (ignored by a run). */
export type TradeKind = "commodity" | "item";
/** What the game said happened. `unknown`: no result line was found; the transaction is counted but flagged. */
export type TradeOutcome = "success" | "failed" | "unknown";
/** `logged`: read from a log line. `inferred`: reconstructed from other lines (never an invented amount). */
export type TradeConfidence = "logged" | "inferred";

export interface TradeTransaction {
  /** UTC time of the log line, ISO 8601. */
  at: string;
  side: TradeSide;
  kind: TradeKind;
  /**
   * The amount of the transaction in aUEC, as the log states it, positive for a buy and for a sell. It is the
   * price of the goods: fees charged on top (the loading service) are NOT in it, the log has no fee line.
   */
  total_auec: number;
  /** Quantity in `unit`; null when the log did not say. */
  quantity: number | null;
  unit: "SCU" | null;
  /** Short commodity identifier or name as the log writes it (cleaned and capped on the way in). */
  commodity: string | null;
  /** Shop or terminal label (cleaned and capped on the way in). */
  shop: string | null;
  /** The autoLoading flag of the log line: the loading service was used (and charged). */
  auto_loading: boolean;
  outcome: TradeOutcome;
  confidence: TradeConfidence;
}

/** Where the transactions come from. Injected into the dashboard service; absent or empty in production for now. */
export type TradeSource = () => readonly TradeTransaction[];
