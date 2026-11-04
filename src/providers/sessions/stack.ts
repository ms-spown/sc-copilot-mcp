import { ledgerLogFrom, LedgerService } from "../../dashboard/ledgerService.js";
import type { ConnectionInfo } from "../gamelog/connectionState.js";
import type { GameLog } from "../gamelog/reader.js";
import type { Telemetry } from "../telemetry/index.js";
import type { SessionsConfig } from "./config.js";
import { createGameInfo, createGameRunning, SessionManager } from "./manager.js";
import { SessionStore } from "./store.js";
import { CompositeTripSource, LedgerTripSource, TradeRunTripSource } from "./trips.js";

/**
 * The saved-sessions stack as the server wires it (index.ts): ONE ledger reader of Game.log, the session file, and the
 * session manager that follows the game with two trip sources (the contracts of the ledger and the trade runs of the
 * commerce model, one pairing, read incrementally by the same ledger service). It lives here so that the server and the
 * end-to-end replay harness (src/testing/replay) build exactly the same objects; only the clock is injectable.
 *
 * Nothing is started: the caller decides when to call `manager.start()`.
 */

export interface SessionStackDeps {
  telemetry: Telemetry;
  gameLog: GameLog;
  /** Where the player stands towards the servers (the connection tracker). */
  connection?: { current(): Promise<ConnectionInfo | null> };
  config: SessionsConfig;
  /** Absent: the file named by `config.file`. */
  store?: SessionStore;
  now?: () => number;
  newId?: () => string;
}

export interface SessionStack {
  ledger: LedgerService;
  manager: SessionManager;
}

export function createSessionStack(deps: SessionStackDeps): SessionStack {
  const { telemetry, gameLog, connection, config } = deps;
  const now = deps.now ?? Date.now;
  const ledger = new LedgerService(ledgerLogFrom(gameLog), now);
  const history = async () => (await telemetry.balanceHistory?.()) ?? [];
  const manager: SessionManager = new SessionManager({
    telemetry,
    store: deps.store ?? new SessionStore(config.file, { now }),
    config,
    ledger,
    // Trips: completed contracts of the transport ledger, and completed trade runs of the dashboard's commerce model
    // (one pairing, read incrementally by the same ledger service). No request to any host.
    trips: new CompositeTripSource([
      new LedgerTripSource(ledger, history),
      new TradeRunTripSource(
        () => ledger.trades(),
        history,
        () => manager.currentPlan,
        () => ledger.shipLosses(),
      ),
    ]),
    gameHint: createGameRunning(gameLog, now),
    ...(connection ? { connection } : {}),
    gameInfo: createGameInfo(gameLog, now),
    now,
    ...(deps.newId ? { newId: deps.newId } : {}),
  });
  return { ledger, manager };
}
