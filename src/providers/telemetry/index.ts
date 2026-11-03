import type { TelemetryEvent } from "./events.js";
import type {
  TelemetryServiceOptions,
  TelemetrySnapshot,
  TelemetryStatusReport,
} from "./service.js";

/**
 * The only door to the telemetry provider. With `enabled: false` (the default: SC_TELEMETRY is not "on") this
 * file loads nothing else: no gRPC code, no HTTP/2 module, no connection attempt, ever. The reader module is
 * imported on the first request that needs it.
 *
 * Switch 1 of 2 is SC_TELEMETRY=on here, in the server's environment. Switch 2 is the variable in the game's
 * environment (GRPC_CLIENT_SERVER_ENABLED), which this process never touches.
 */

export interface Telemetry {
  readonly enabled: boolean;
  status(start?: boolean): Promise<TelemetryStatusReport>;
  snapshot(): Promise<TelemetrySnapshot | null>;
  events(
    afterSeq?: number,
    limit?: number,
  ): Promise<{ events: TelemetryEvent[]; last_seq: number }>;
  resetUecDelta(): Promise<void>;
  stop(): Promise<void>;
}

export interface TelemetryConfig {
  enabled: boolean;
  options?: TelemetryServiceOptions;
}

const OFF_REPORT: TelemetryStatusReport = {
  state: "off",
  cause:
    "Telemetry is switched off on the server side (SC_TELEMETRY is not 'on'). No connection is attempted.",
  frames_received: 0,
  frames_rejected: 0,
  reconnects: 0,
  unknown_fields: [],
  anomalies: [],
  not_in_stream: [],
  idle_stop_ms: 0,
};

export function createTelemetry(config: TelemetryConfig): Telemetry {
  if (!config.enabled) {
    return {
      enabled: false,
      status: async () => ({ ...OFF_REPORT }),
      snapshot: async () => null,
      events: async () => ({ events: [], last_seq: 0 }),
      resetUecDelta: async () => undefined,
      stop: async () => undefined,
    };
  }
  let service: Promise<InstanceType<typeof import("./service.js").TelemetryService>> | null = null;
  const load = () => {
    service ??= import("./service.js").then((m) => new m.TelemetryService(config.options));
    return service;
  };
  return {
    enabled: true,
    status: async (start = true) => (await load()).status(start),
    snapshot: async () => (await load()).snapshot(),
    events: async (afterSeq, limit) => (await load()).recentEvents(afterSeq, limit),
    resetUecDelta: async () => (await load()).resetUecDelta(),
    // Nothing was loaded, nothing to stop: do not import the reader just to close it.
    stop: async () => {
      if (service) await (await service).stop();
    },
  };
}
