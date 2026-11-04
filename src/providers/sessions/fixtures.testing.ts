import type { Session } from "./types.js";

/** A valid session for tests (shared by the store tests). */
export const NOW = Date.UTC(2026, 10, 4, 20, 0, 0);
export const stamp = (n = 0) => new Date(NOW + n * 1000).toISOString();

export function session(n: number, over: Partial<Session> = {}): Session {
  return {
    id: `s_test_${n}`,
    number: n,
    started_at: stamp(n),
    ended_at: null,
    end_reason: null,
    last_activity_at: stamp(n),
    quit_at: null,
    start_balance: 1000 * n,
    start_balance_at: stamp(n),
    start_balance_quality: "game_start",
    last_balance: 1000 * n,
    last_balance_at: stamp(n),
    game_version: null,
    game_channel: null,
    active_ms: 0,
    interruptions: [],
    trips: [],
    trips_dropped: 0,
    last_location: null,
    last_commodity: null,
    last_context_at: null,
    note: "",
    started_by: null,
    archived: false,
    price_refusals: 0,
    price_refusal_last_at: null,
    ship_losses: [],
    updated_at: stamp(n),
    ...over,
  };
}
