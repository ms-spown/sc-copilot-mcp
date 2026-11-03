/**
 * TEST SUPPORT: the poll answer and the telemetry state built from a frame in which every field of the schema is
 * filled (testing/fullFrame.ts), with the balance included. Used by the coverage test and the sanitiser round trip.
 */
import { TelemetryHandler } from "../../providers/telemetry/handler.js";
import { normalizeFrame } from "../../providers/telemetry/normalize.js";
import { fullFrame } from "../../providers/telemetry/testing/fullFrame.js";
import { buildPoll, type PollResult } from "../poll.js";

export function fullAnswers(): { poll: PollResult; state: unknown } {
  const handler = new TelemetryHandler();
  handler.update(normalizeFrame(fullFrame()), 1000);
  const state = handler.latest!;
  const poll = buildPoll({
    status: {
      state: "live",
      cause: "Frames are arriving.",
      frames_received: 1,
      frames_rejected: 0,
      reconnects: 0,
      unknown_fields: [],
      anomalies: [],
      not_in_stream: ["position", "heat"],
      idle_stop_ms: 1,
    },
    snapshot: {
      state,
      frame_age_ms: 10,
      received_at: new Date(1000).toISOString(),
      uec_session: { start: 1, current: 2, delta: 1, since: new Date(0).toISOString() },
    },
    events: [],
    lastSeq: 0,
    sessionEvents: [],
    session: { startedAt: null, endedAt: null, startSeq: 0, endSeq: null, markers: [] },
    includeBalance: true,
    nowMs: 1010,
  });
  return { poll, state };
}
