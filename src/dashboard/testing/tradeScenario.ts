/**
 * TEST SUPPORT (also used by scripts/dashboard-preview.mjs): a made-up trading run, with the figures of a real one
 * rounded and copied by hand (the player's report): started at 320 000 aUEC, bought 640 SCU for 120 923 and 56 SCU
 * for 10 581 (131 504 in all), sold them for 292 480 and 25 592 (318 072; 457 per SCU), expected about 180 000 of
 * profit, finished at 463 000. Gross margin 186 568, net +143 000, so 43 568 of fees that the log does not show:
 * 19 468 on the purchases and 24 100 on the sales in this fixture (invented split; the real one is not known).
 *
 * The transactions are what the trade journal will deliver (tradeTypes.ts); the balance history is what the
 * telemetry would have measured. No real log, no real balance, no Node-only module: the browser imports it.
 *
 * Timeline of one loop of the preview (seconds, 600 s long): 6 s balance 320 000; 20 s and 22 s purchases, the loading
 * fee is charged at 22.5 s; 200 s and 202 s sales, fee at 202.5 s; the run is settled 8 s after its last transaction.
 */
import type { BalancePoint } from "../../providers/telemetry/service.js";
import { buildLedgerPayload, EMPTY_LEDGER, type LedgerPayload } from "../ledger.js";
import type { PlanForLedger } from "../ledger.js";
import type { TradeTransaction } from "../tradeTypes.js";

export const TRADE_LOOP_SECONDS = 600;

export const TRADE_FIGURES = {
  start: 320_000,
  end: 463_000,
  buys: [120_923, 10_581],
  sells: [292_480, 25_592],
  buyFee: 19_468,
  sellFee: 24_100,
  planned: 180_000,
} as const;

const tx = (
  base: number,
  s: number,
  side: "buy" | "sell",
  total: number,
  quantity: number,
  over: Partial<TradeTransaction> = {},
): TradeTransaction => ({
  at: new Date(base + s * 1000).toISOString(),
  side,
  kind: "commodity",
  total_auec: total,
  quantity,
  unit: "SCU",
  commodity: "LARA",
  shop: side === "buy" ? "Port Tressler" : "Area18 TDD",
  auto_loading: true,
  outcome: "success",
  confidence: "logged",
  ...over,
});

/** The four transactions of the run, `base` being epoch ms of the loop's start. */
export function tradeTransactions(base: number): TradeTransaction[] {
  const f = TRADE_FIGURES;
  return [
    tx(base, 20, "buy", f.buys[0], 640),
    tx(base, 22, "buy", f.buys[1], 56),
    tx(base, 200, "sell", f.sells[0], 640),
    tx(base, 202, "sell", f.sells[1], 56),
  ];
}

/** (second of the loop, balance from then on) of the made-up run. */
function tradeSteps(): [number, number][] {
  const f = TRADE_FIGURES;
  return [
    [6, f.start],
    [20.1, f.start - f.buys[0]],
    [22.1, f.start - f.buys[0] - f.buys[1]],
    [22.6, f.start - f.buys[0] - f.buys[1] - f.buyFee],
    [200.1, f.start - f.buys[0] - f.buys[1] - f.buyFee + f.sells[0]],
    [202.1, f.start - f.buys[0] - f.buys[1] - f.buyFee + f.sells[0] + f.sells[1]],
    [202.6, f.end],
  ];
}

/** The balance by second of the story (looped), for the made-up stream of scenario.ts to carry. */
export function tradeBalanceAt(seconds: number): number {
  let uec: number = TRADE_FIGURES.start;
  for (const [s, v] of tradeSteps()) if (seconds % TRADE_LOOP_SECONDS >= s) uec = v;
  return uec;
}

/** The balance the telemetry would have seen, up to `nowMs`. Fees are changes of their own, as the model assumes. */
export function tradeHistory(base: number, nowMs: number): BalancePoint[] {
  const steps = tradeSteps();
  const out: BalancePoint[] = [];
  steps.forEach(([s, uec], i) => {
    const at = base + s * 1000;
    if (at > nowMs) return;
    const next = steps[i + 1];
    out.push({ at, uec, until: Math.min(nowMs, next ? base + next[0] * 1000 - 60 : nowMs) });
  });
  return out;
}

export type TradeVariant = "story" | "unknown" | "partial" | "none" | "second" | "estimated";

/**
 * The ledger payload (with its trade section) at `nowMs` for a variant:
 *   story   the run above, complete.
 *   unknown the dashboard was opened after the purchases: the balance before the first purchase was not seen.
 *   partial only the first sale happened (the second lot is still on board).
 *   estimated the stream was cut while the sales were settled: the fees cannot be measured per side, only deduced (hatched).
 *   none    no trade journal feeds the dashboard.
 *   second  the run above followed by a second, smaller one (a new purchase after the sales).
 */
export function tradeLedger(
  nowMs: number,
  epoch: number,
  includeBalance: boolean,
  variant: TradeVariant = "story",
  plan?: PlanForLedger,
): LedgerPayload {
  const loop = Math.max(0, Math.floor((nowMs - epoch) / (TRADE_LOOP_SECONDS * 1000)));
  const base = epoch + loop * TRADE_LOOP_SECONDS * 1000;
  let transactions: TradeTransaction[] | undefined = tradeTransactions(base).filter(
    (t) => Date.parse(t.at) <= nowMs,
  );
  let history = tradeHistory(base, nowMs);
  if (variant === "none") transactions = undefined;
  if (variant === "estimated") {
    // The balance is known before the purchases and at the end, with the stream cut around the sales.
    history = history.filter((p) => p.at < base + 20_000 || p.at > base + 202_000);
    history = history.map((p) => (p.at < base + 20_000 ? { ...p, until: base + 19_900 } : p));
  }
  if (variant === "unknown") history = history.filter((p) => p.at > base + 30_000);
  if (variant === "partial") {
    transactions = transactions?.filter((t) => t.at !== tradeTransactions(base)[3]!.at);
    history = history.filter((p) => p.at < base + 202_000);
  }
  if (variant === "second") {
    const more = [
      tx(base, 300, "buy", 60_000, 300, { commodity: "AGRI", shop: "Port Tressler" }),
      tx(base, 330, "sell", 71_000, 300, { commodity: "AGRI", shop: "Area18 TDD" }),
    ].filter((t) => Date.parse(t.at) <= nowMs);
    transactions = [...(transactions ?? []), ...more];
  }
  return buildLedgerPayload({
    base: { ...EMPTY_LEDGER, status: "ok", asOf: nowMs },
    history,
    includeBalance,
    plan,
    nowMs,
    ...(transactions ? { trades: transactions } : {}),
  });
}
