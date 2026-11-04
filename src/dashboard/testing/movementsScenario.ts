/**
 * TEST SUPPORT (also used by scripts/dashboard-preview.mjs): made-up balance movements around the trading story of
 * tradeScenario.ts. Nothing is real: invented commodity GUIDs, shop names and item class names, invented amounts that
 * are distinctive on purpose (so a test can look for them on the wire), no Node-only module (the browser imports it).
 *
 * The "movements" story adds to the 600 s loop of the trade story (seconds from the loop's start):
 *    60 s   an item bought in a shop (2 400 aUEC; the log line is at 59.5 s)
 *   100 s   a contract ends "completed" (99.5 s) and the balance rises by 85 000 at 100.8 s: a probable reward
 *   140 s   the balance falls by 6 300 with nothing in the log near it: not explained (a refuel? a repair? nobody can say)
 *   152 s   the balance falls by 9 000 two seconds after an insurance claim request (150 s): a probable cost
 * The trading story itself (buys at 20 s and 22 s, sales at 200 s and 202 s, fees measured) is unchanged, so the net of
 * the run now holds all of the above, and the card can say so.
 */
import type { Transaction } from "../../providers/gamelog/trade.js";
import type { BalancePoint } from "../../providers/telemetry/service.js";
import type { MovementEvent } from "../balanceMovements.js";
import { buildLedgerPayload, EMPTY_LEDGER, type Contract, type LedgerPayload } from "../ledger.js";
import type { PlanForLedger } from "../ledger.js";
import {
  TRADE_FIGURES,
  TRADE_LOOP_SECONDS,
  journalTransactions,
  tradeLines,
} from "./tradeScenario.js";

export const MOVEMENT_FIGURES = {
  item: 2_400,
  reward: 85_000,
  unexplained: 6_300,
  insurance: 9_000,
} as const;

export const MOVEMENT_ITEM_CLASS = "ration_pack_test";
export const MOVEMENT_CONTRACT_TITLE = "Cargo Delivery | Test Route";

const OWNER = "[Team_CoreGameplayFeatures][Shops][UI]";
const IDS = "playerId[1111111111] shopId[2222222]";
const stamp = (base: number, s: number) => `<${new Date(base + s * 1000).toISOString()}>`;

/** An invented shop item purchase line (the shop UI flow). */
export function itemBuyLine(
  base: number,
  s: number,
  price: number,
  item = MOVEMENT_ITEM_CLASS,
  shop = "SCShop_Test_Items",
): string {
  return `${stamp(base, s)} [Notice] <CEntityComponentShopUIProvider::SendShopBuyRequest> Sending SShopBuyRequest - ${IDS} shopName[${shop}] kioskId[3333333] client_price[${price}.000000] itemClassGUID[cccccccc-1111-4222-8333-666666666666] itemName[${item}] quantity[1]  ${OWNER}`;
}

/** The shop's answer to it (the game says Success for an item). */
export function itemSuccessLine(base: number, s: number, shop = "SCShop_Test_Items"): string {
  return `${stamp(base, s)} [Notice] <CEntityComponentShopUIProvider::RmShopFlowResponse> Received ShopFlowResponse - ${IDS} shopName[${shop}] kioskId[3333333] kioskState[Idle] result[Success] type[Buying] ${OWNER}`;
}

/** A balance history from (second, balance from then on) steps. `until` of a point is just before the next change. */
export function historyFrom(
  base: number,
  steps: readonly (readonly [number, number])[],
  nowMs: number,
): BalancePoint[] {
  const out: BalancePoint[] = [];
  steps.forEach(([s, uec], i) => {
    const at = base + s * 1000;
    if (at > nowMs) return;
    const next = steps[i + 1];
    out.push({ at, uec, until: Math.min(nowMs, next ? base + next[0] * 1000 - 60 : nowMs) });
  });
  return out;
}

/** (second, balance from then on) of the movements story. */
export function movementSteps(): [number, number][] {
  const f = TRADE_FIGURES;
  const m = MOVEMENT_FIGURES;
  const afterBuys = f.start - f.buys[0] - f.buys[1] - f.buyFee;
  const a = afterBuys - m.item;
  const b = a + m.reward;
  const c = b - m.unexplained;
  const d = c - m.insurance;
  return [
    [6, f.start],
    [20.1, f.start - f.buys[0]],
    [22.1, f.start - f.buys[0] - f.buys[1]],
    [22.6, afterBuys],
    [60.4, a],
    [100.8, b],
    [140.2, c],
    [152, d],
    [200.1, d + f.sells[0]],
    [202.1, d + f.sells[0] + f.sells[1]],
    [202.6, d + f.sells[0] + f.sells[1] - f.sellFee],
  ];
}

/** The balance by second of the story (looped), for the made-up stream of scenario.ts to carry. */
export function movementBalanceAt(seconds: number): number {
  let uec: number = TRADE_FIGURES.start;
  for (const [s, v] of movementSteps()) if (seconds % TRADE_LOOP_SECONDS >= s) uec = v;
  return uec;
}

export interface MovementsStory {
  /** Mission completed at 99.5 s (the title is invented). */
  contract: Contract;
  events: MovementEvent[];
  transactions: Transaction[];
  history: BalancePoint[];
}

/** What the game log and the telemetry would hold at `nowMs` for the loop that contains it. */
export function movementsStory(
  nowMs: number,
  epoch: number,
  options: { insurance?: boolean } = {},
): MovementsStory {
  const loop = Math.max(0, Math.floor((nowMs - epoch) / (TRADE_LOOP_SECONDS * 1000)));
  const base = epoch + loop * TRADE_LOOP_SECONDS * 1000;
  const lines = [
    ...tradeLines(base),
    itemBuyLine(base, 59.5, MOVEMENT_FIGURES.item),
    itemSuccessLine(base, 59.8),
  ].filter((l) => Date.parse(l.slice(1, l.indexOf(">"))) <= nowMs);
  const withInsurance = options.insurance !== false;
  const endedMs = base + 99_500;
  const contract: Contract = {
    id: "ab12cd34",
    title: MOVEMENT_CONTRACT_TITLE,
    state: "completed",
    acceptedMs: base + 30_000,
    endedMs,
    steps: [],
    stepsTotal: 0,
    objectivesDone: 0,
  };
  const all: MovementEvent[] = [{ type: "login_completed", atMs: base - 60_000 }];
  if (withInsurance) all.push({ type: "insurance_claim_requested", atMs: base + 150_000 });
  const events = all.filter((e) => e.atMs <= nowMs);
  return {
    contract,
    events,
    transactions: journalTransactions(lines, nowMs),
    history: historyFrom(base, movementSteps(), nowMs),
  };
}

/** The ledger payload of the story at `nowMs`, with or without the balance. */
export function movementsLedger(
  nowMs: number,
  epoch: number,
  includeBalance: boolean,
  plan?: PlanForLedger,
): LedgerPayload {
  const s = movementsStory(nowMs, epoch);
  return buildLedgerPayload({
    base: {
      ...EMPTY_LEDGER,
      status: "ok",
      asOf: nowMs,
      contracts: s.contract.endedMs !== null && s.contract.endedMs <= nowMs ? [s.contract] : [],
    },
    history: s.history,
    includeBalance,
    plan,
    trades: s.transactions,
    movementEvents: s.events,
    nowMs,
  });
}
