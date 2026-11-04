import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./core/config.js";
import { createGameVersionResolver, createProbes } from "./providers/probes.js";
import { FleetStore, fleetFilePath } from "./providers/fleet/store.js";
import { ConnectionTracker } from "./providers/gamelog/connection.js";
import { GameLog, gameLogConfigFromEnv } from "./providers/gamelog/reader.js";
import { createGameLogHint } from "./providers/telemetry/gamelogHint.js";
import { createTelemetry } from "./providers/telemetry/index.js";
import { createScmdb } from "./providers/scmdb/client.js";
import { sessionsConfig } from "./providers/sessions/config.js";
import { createGameInfo, createGameRunning, SessionManager } from "./providers/sessions/manager.js";
import { SessionStore } from "./providers/sessions/store.js";
import {
  CompositeTripSource,
  LedgerTripSource,
  TradeRunTripSource,
} from "./providers/sessions/trips.js";
import { ledgerLogFrom, LedgerService } from "./dashboard/ledgerService.js";
import { createSctClient } from "./providers/sctools/client.js";
import { createUexClient } from "./providers/uex/client.js";
import { createScwClient } from "./providers/wiki/client.js";
import { createMcpServer } from "./server.js";
import { allResources, allTools, createRegistry } from "./tools/registry.js";

// The .env next to the package, never the one in the working directory: Claude starts the
// server from whatever folder is open, which may belong to another project.
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

const config = loadConfig();

if (!config.uexToken) {
  console.error("UEXTOKEN is not set: UEX requests go out without credentials.");
}

const gameLog = new GameLog(gameLogConfigFromEnv());

const connection = new ConnectionTracker(gameLog);
// Off unless SC_TELEMETRY=on. When off this loads nothing and never connects.
const telemetry = createTelemetry({
  enabled: config.telemetry,
  options: { gameLogHint: createGameLogHint(gameLog) },
});

const scwClient = createScwClient(config.scwBaseUrl);

// Saved play sessions: only with SC_TELEMETRY=on and SC_SESSIONS not off. Otherwise nothing is created, read or watched.
const sessionSettings = sessionsConfig(process.env, config.telemetry);
let sessions: SessionManager | undefined;
if (sessionSettings.enabled) {
  const ledger = new LedgerService(ledgerLogFrom(gameLog));
  const history = async () => (await telemetry.balanceHistory?.()) ?? [];
  sessions = new SessionManager({
    telemetry,
    store: new SessionStore(sessionSettings.file),
    config: sessionSettings,
    ledger,
    // Trips: completed contracts of the transport ledger, and completed trade runs of the dashboard's commerce model
    // (one pairing, read incrementally by the same ledger service). No request to any host.
    trips: new CompositeTripSource([
      new LedgerTripSource(ledger, history),
      new TradeRunTripSource(
        () => ledger.trades(),
        history,
        () => sessions?.currentPlan,
      ),
    ]),
    gameHint: createGameRunning(gameLog),
    connection,
    gameInfo: createGameInfo(gameLog),
  });
  sessions.start();
  // The last trip is not lost when the host closes the server: one last look, saved, before the process ends.
  process.stdin.once("end", () => {
    void sessions?.close();
  });
}

const clients = {
  uexClient: createUexClient(config.uexBaseUrl, config.uexToken),
  scwClient,
  sctClient: createSctClient(config.sctBaseUrl),
  scmdb: createScmdb(),
  gameLog,
  // Lazy: nothing is read until a live tool or the dashboard asks.
  connection,
  fleet: new FleetStore(fleetFilePath()),
  telemetry,
  ...(sessions ? { sessions } : {}),
};

// A bad SCMCP_TOOLS or SCMCP_PROFILES throws here, at startup, rather than listing nothing.
const registry = createRegistry(
  allTools(clients, createProbes(clients)),
  { tools: config.enabledTools, profiles: config.profiles },
  { gameVersionFor: createGameVersionResolver(clients), resources: allResources(clients) },
);

const server = createMcpServer(registry);

/**
 * Start the server.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Star Citizen MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
