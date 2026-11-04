/**
 * TEST SUPPORT (end-to-end replay): ready-made pieces of timeline, so a scenario reads as a story.
 *
 * `PLAYER_RUN` is a synthetic copy of the numbers of a real run (the player's report): started at 320 000 aUEC, bought
 * 640 SCU for 120 923 and 56 SCU for 10 581 (131 504 in all), sold them for 292 480 and 25 592 (318 072), expected
 * about 180 000 of profit, ended at 463 000. Gross margin 186 568, net +143 000, so 43 568 of fees that the log does not
 * show. The split of the fees between the lines is INVENTED (the real one is not known): the sum per side is what the
 * scenarios assert (19 468 on the purchases, 24 100 on the sales).
 */
import { buyLine, errorLine, sellLine } from "./lines.js";
import type { ReplayWorld } from "./world.js";

export const PLAYER_RUN = {
  start: 320_000,
  end: 463_000,
  planned: 180_000,
  buys: [
    { price: 120_923, scu: 640, fee: 17_900 },
    { price: 10_581, scu: 56, fee: 1_568 },
  ],
  sells: [
    { amount: 292_480, scu: 640, fee: 21_800 },
    { amount: 25_592, scu: 56, fee: 2_300 },
  ],
} as const;

/** The figures a run is expected to come out with, worked out from the story above (not from the code under test). */
export const RUN_FIGURES = (() => {
  const cost = PLAYER_RUN.buys.reduce((s, b) => s + b.price, 0);
  const turnover = PLAYER_RUN.sells.reduce((s, x) => s + x.amount, 0);
  const buyFee = PLAYER_RUN.buys.reduce((s, b) => s + b.fee, 0);
  const sellFee = PLAYER_RUN.sells.reduce((s, x) => s + x.fee, 0);
  return {
    cost,
    turnover,
    gross: turnover - cost,
    buyFee,
    sellFee,
    fees: buyFee + sellFee,
    net: turnover - cost - buyFee - sellFee,
    scu: PLAYER_RUN.buys.reduce((s, b) => s + b.scu, 0),
    /** Price deviation: the gross margin minus the planned profit. */
    priceGap: turnover - cost - PLAYER_RUN.planned,
  };
})();

/**
 * Where the lines and the balance changes of one run fall, in seconds after its start. The delays between a line and
 * the balance change it causes are ASSUMPTIONS (a few hundred milliseconds to a second), chosen inside the model's
 * windows (2 s before the first line, 8 s after the last of a cluster).
 */
export const RUN_TIMES = {
  buy: [0, 2],
  buyChange: [0.7, 2.9],
  sell: [80, 82],
  sellChange: [81.1, 82.4],
  /** The model reads the final balance 8 s after the last line. */
  settled: 90,
} as const;

export interface RunOptions {
  guid?: string;
  /** Added to the amounts of the sales, to make a run that differs from the player's. */
  sellBonus?: number;
}

/**
 * Schedules one run starting at second `t0`: the four log lines and the balance changes (price plus fee on a purchase,
 * amount minus fee on a sale). Returns the second at which the run is settled.
 */
export function scheduleRun(world: ReplayWorld, t0: number, opts: RunOptions = {}): number {
  const run = PLAYER_RUN;
  run.buys.forEach((b, i) => {
    world
      .at(t0 + RUN_TIMES.buy[i]!)
      .log(buyLine(world.ms(t0 + RUN_TIMES.buy[i]!), b.price, b.scu, opts.guid));
    world.at(t0 + RUN_TIMES.buyChange[i]!).change(-(b.price + b.fee));
  });
  run.sells.forEach((x, i) => {
    world
      .at(t0 + RUN_TIMES.sell[i]!)
      .log(sellLine(world.ms(t0 + RUN_TIMES.sell[i]!), x.amount, x.scu, opts.guid));
    world.at(t0 + RUN_TIMES.sellChange[i]!).change(x.amount - x.fee);
  });
  return t0 + RUN_TIMES.settled;
}

/** A cargo line the game rejects: the request, then the error line a second later (balance untouched). */
export function scheduleFailedBuy(
  world: ReplayWorld,
  at: number,
  price: number,
  scu: number,
): void {
  world.at(at).log(buyLine(world.ms(at), price, scu));
  world.at(at + 1).log(errorLine(world.ms(at + 1)));
}
