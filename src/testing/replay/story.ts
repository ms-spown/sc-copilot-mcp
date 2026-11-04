/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TEST SUPPORT (end-to-end replay): what the scenario files share. Call `useWorld()` at the top of a test file: it closes
 * the world after every test.
 */
import { afterEach } from "vitest";
import { PLAYER_RUN, RUN_FIGURES } from "./scripts.js";
import { ReplayWorld, type ReplayOptions } from "./world.js";

export function useWorld() {
  let world: ReplayWorld | undefined;
  afterEach(async () => {
    await world?.close();
    world = undefined;
  });
  return {
    /**
     * A world whose server was watching when the game began: a first look sees no balance yet (so the first balance is a
     * real start), then the stream starts.
     */
    async start(opts: ReplayOptions = {}): Promise<ReplayWorld> {
      world = await ReplayWorld.create({ startBalance: PLAYER_RUN.start, ...opts });
      await world.manager.tick();
      world.startStream();
      return world;
    },
  };
}

export const F = RUN_FIGURES;

/**
 * Every figure of the player's run that comes from the balance, or from the log's amounts (which sit under `money`): none
 * may be seen in an answer given without the balance.
 */
export const MONEY: number[] = [
  PLAYER_RUN.start,
  PLAYER_RUN.end,
  F.net,
  F.fees,
  F.buyFee,
  F.sellFee,
  F.gross,
  F.cost,
  F.turnover,
  PLAYER_RUN.planned,
  F.priceGap,
  PLAYER_RUN.buys[0].price,
  PLAYER_RUN.buys[1].price,
  PLAYER_RUN.sells[0].amount,
  PLAYER_RUN.sells[1].amount,
  // The balance after each of the first changes of the story.
  PLAYER_RUN.start - PLAYER_RUN.buys[0].price - PLAYER_RUN.buys[0].fee,
  PLAYER_RUN.start -
    PLAYER_RUN.buys[0].price -
    PLAYER_RUN.buys[0].fee -
    PLAYER_RUN.buys[1].price -
    PLAYER_RUN.buys[1].fee,
];

/** The newest run of a poll's commerce section. */
export const newestRun = (poll: any): any => poll.ledger.trade.runs[0];
