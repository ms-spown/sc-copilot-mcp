/**
 * TEST SUPPORT (also used by scripts/dashboard-preview.mjs): a made-up trading run, with the figures of a real one
 * rounded and copied by hand (the player's report): started at 320 000 aUEC, bought 640 SCU for 120 923 and 56 SCU
 * for 10 581 (131 504 in all), sold them for 292 480 and 25 592 (318 072; 457 per SCU), expected about 180 000 of
 * profit, finished at 463 000. Gross margin 186 568, net +143 000, so 43 568 of fees that the log does not show:
 * 19 468 on the purchases and 24 100 on the sales in this fixture (invented split; the real one is not known).
 *
 * The transactions are NOT hand-built records: invented Game.log lines (in the shapes the parser knows, with a made-up
 * commodity GUID and shop names) go through the REAL commerce parser and journal (providers/gamelog/trade.ts), so the
 * model is fed exactly what production feeds it. The balance history is what the telemetry would have measured. No real
 * log, no real balance, no Node-only module: the browser imports it.
 *
 * Timeline of one loop of the preview (seconds, 600 s long): 6 s balance 320 000; 20 s and 22 s purchases, the loading
 * fee is charged at 22.5 s; 200 s and 202 s sales, fee at 202.5 s; the run is settled 8 s after its last transaction.
 */
import {
  buildTradeJournal,
  parseCommerceText,
  type Transaction,
} from "../../providers/gamelog/trade.js";
import type { BalancePoint } from "../../providers/telemetry/service.js";
import { buildLedgerPayload, EMPTY_LEDGER, type LedgerPayload } from "../ledger.js";
import type { PlanForLedger } from "../ledger.js";

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

/** Invented commodity GUIDs: the journal's short id is their first 8 characters. */
export const LARANITE_GUID = "5c2e9a41-1111-4222-8333-444444444444";
export const AGRICIUM_GUID = "b81d3f07-1111-4222-8333-555555555555";
export const LARANITE_ID = "5c2e9a41";
export const AGRICIUM_ID = "b81d3f07";

const OWNER = "[Team_CoreGameplayFeatures][Shops][UI]";
const IDS = "playerId[1111111111] shopId[2222222]";
const stamp = (base: number, s: number) => `<${new Date(base + s * 1000).toISOString()}>`;

/** An invented cargo purchase line (quantity in cSCU, as the game writes it). */
export function cargoBuyLine(
  base: number,
  s: number,
  price: number,
  scu: number,
  guid = LARANITE_GUID,
  shop = "SCShop_Cargo_Tressler",
): string {
  return `${stamp(base, s)} [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> Sending SShopCommodityBuyRequest - ${IDS} shopName[${shop}] kioskId[3333333] price[${price}.000000] shopPricePerCentiSCU[1.889409] resourceGUID[${guid}] autoLoading[1] quantity[${scu * 100}.000000 cSCU] Cargo Box Data: boxSize[32.000000] | unitAmount[20] ${OWNER}`;
}

/** An invented cargo sale line (quantity in SCU). */
export function cargoSellLine(
  base: number,
  s: number,
  amount: number,
  scu: number,
  guid = LARANITE_GUID,
  shop = "SCShop_Cargo_Area18",
): string {
  return `${stamp(base, s)} [Notice] <CEntityComponentCommodityUIProvider::SendCommoditySellRequest> Sending SShopCommoditySellRequest - ${IDS} shopName[${shop}] kioskId[3333333] amount[${amount}.000000] resourceGUID[${guid}] autoLoading[1] quantity[${scu}] transactionMode[CargoGrid] Cargo Box Data:  [boxSize[32] | unitAmount[20]] ${OWNER}`;
}

/** An invented cargo error line (the game logs only failures). */
export function cargoErrorLine(base: number, s: number): string {
  return `${stamp(base, s)} [Error] <CEntityComponentCommodityUIProvider::RmToken_CommodityTransactionResponse> Commodity Transaction Response Error - playerId[1111111111] result[TransactionCostMismatch] type[Buy] [Team_NAPU][Shops]`;
}

/** The four lines of the run, `base` being epoch ms of the loop's start. */
export function tradeLines(base: number): string[] {
  const f = TRADE_FIGURES;
  return [
    cargoBuyLine(base, 20, f.buys[0], 640),
    cargoBuyLine(base, 22, f.buys[1], 56),
    cargoSellLine(base, 200, f.sells[0], 640),
    cargoSellLine(base, 202, f.sells[1], 56),
  ];
}

/**
 * The journal's transactions for some invented log lines, through the real parser and journal. `lastMs` is the log's
 * last timestamp (a cargo line within 3 s of it has not had time to fail: the journal leaves it unconfirmed).
 */
export function journalTransactions(lines: readonly string[], lastMs: number): Transaction[] {
  const records = parseCommerceText(lines.join("\n"));
  return buildTradeJournal(records, new Date(lastMs).toISOString()).transactions;
}

/** The four transactions of the run, long after the last of them (all inferred completed). */
export function tradeTransactions(base: number): Transaction[] {
  return journalTransactions(tradeLines(base), base + 3_600_000);
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

export type TradeVariant =
  "story" | "unknown" | "partial" | "none" | "second" | "estimated" | "reward" | "rewardcut";

/**
 * The ledger payload (with its trade section) at `nowMs` for a variant:
 *   story   the run above, complete.
 *   unknown the dashboard was opened after the purchases: the balance before the first purchase was not seen.
 *   estimated the stream was cut while the sales were settled: the fees cannot be measured per side, only deduced (hatched).
 *   partial only the first sale happened (the second lot is still on board).
 *   reward  a 400 000 reward is paid between the purchases and the sales: fees are measured, the net holds the reward.
 *   rewardcut the same with the stream cut around the sales: the deduced fees would be negative, so they are refused.
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
  const lines = tradeLines(base);
  if (variant === "second") {
    lines.push(
      cargoBuyLine(base, 300, 60_000, 300, AGRICIUM_GUID),
      cargoSellLine(base, 330, 71_000, 300, AGRICIUM_GUID),
    );
  }
  // Only what the game had written by `nowMs`; "partial" never writes the second sale.
  const written = lines
    .filter((l) => Date.parse(l.slice(1, l.indexOf(">"))) <= nowMs)
    .filter((l) => variant !== "partial" || !l.includes("amount[25592"));
  let transactions: Transaction[] | undefined = journalTransactions(written, nowMs);
  let history = tradeHistory(base, nowMs);
  if (variant === "none") transactions = undefined;
  // The telemetry was not watching during the second run: its balance is not seen, so its net is unknown.
  if (variant === "second") history = tradeHistory(base, Math.min(nowMs, base + 210_000));
  if (variant === "estimated") {
    // The balance is known before the purchases and at the end, with the stream cut around the sales.
    history = history.filter((p) => p.at < base + 20_000 || p.at > base + 202_000);
    history = history.map((p) => (p.at < base + 20_000 ? { ...p, until: base + 19_900 } : p));
  }
  if (variant === "reward" || variant === "rewardcut") {
    const paid = base + 100_000;
    const before = history.filter((p) => p.at < paid);
    const lastBefore = before[before.length - 1]!;
    history = [
      ...before.map((p) => (p === lastBefore ? { ...p, until: paid - 60 } : p)),
      { at: paid, uec: lastBefore.uec + 400_000, until: base + 200_040 },
      ...history.filter((p) => p.at >= paid).map((p) => ({ ...p, uec: p.uec + 400_000 })),
    ];
    if (variant === "rewardcut") {
      history = history.filter((p) => p.at < base + 20_000 || p.at > base + 202_000);
      history = history.map((p) => (p.at < base + 20_000 ? { ...p, until: base + 19_900 } : p));
    }
  }
  if (variant === "unknown") history = history.filter((p) => p.at > base + 30_000);
  if (variant === "partial") history = history.filter((p) => p.at < base + 202_000);
  return buildLedgerPayload({
    base: { ...EMPTY_LEDGER, status: "ok", asOf: nowMs },
    history,
    includeBalance,
    plan,
    nowMs,
    ...(transactions ? { trades: transactions } : {}),
  });
}
