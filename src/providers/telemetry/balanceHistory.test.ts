import { afterEach, describe, expect, it } from "vitest";
import { createTelemetry } from "./index.js";
import { MAX_BALANCE_POINTS, TelemetryService } from "./service.js";
import { actorField, frame, vehicleField } from "./testing/encode.js";
import { startFakeGame, type FakeGame } from "./testing/fakeServer.js";

/**
 * The balance history that the transport ledger reads: one point per change, the last confirmation moved by frames
 * that repeat the value, bounded, and never part of what a tool says.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup() {
  const game: FakeGame = await startFakeGame();
  cleanup.push(() => game.close());
  const clock = { now: 1_000_000 };
  const service = new TelemetryService({
    endpointForTests: { host: "127.0.0.1", port: game.port },
    reader: { retryMs: [20, 20], connectTimeoutMs: 500 },
    frameIntervalMs: 0,
    now: () => clock.now,
  });
  cleanup.push(() => service.stop());
  service.ensureStarted();
  const waitFor = async (check: () => boolean, what: string) => {
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out: ${what}`);
  };
  await waitFor(() => game.connections() > 0, "connection");
  await new Promise((r) => setTimeout(r, 50));
  const send = async (uec: number | bigint, at: number) => {
    clock.now = at;
    const before = service.snapshot()?.received_at;
    game.send(frame(vehicleField({ name: "DRAK_Cutter_1" }), actorField({ health: 90, uec })));
    await waitFor(() => service.snapshot()?.received_at !== before, `frame at ${at}`);
  };
  return { service, send };
}

describe("Feature: the service remembers the balance changes, in memory", () => {
  it("Given the same balance in several frames then a purchase, Then there is a point per value and the first one remembers its last frame", async () => {
    const { service, send } = await setup();
    await send(5000, 1_000_100);
    await send(5000, 1_005_000);
    await send(5000, 1_009_000);
    await send(4200, 1_010_000);
    expect(service.balanceHistory()).toEqual([
      { at: 1_000_100, uec: 5000, until: 1_009_000 },
      { at: 1_010_000, uec: 4200, until: 1_010_000 },
    ]);
  });

  it("Given a balance too large for a number, Then it is not recorded (a gain stays unknown rather than wrong)", async () => {
    const { service, send } = await setup();
    await send(1n << 60n, 1_000_100);
    expect(service.balanceHistory()).toEqual([]);
  });

  it("Given more changes than it may keep, Then the oldest go first", () => {
    const service = new TelemetryService({ now: () => 0 });
    for (let i = 0; i < MAX_BALANCE_POINTS + 25; i++) {
      (service as unknown as { recordBalance(u: number, t: number): void }).recordBalance(i, i);
    }
    const history = service.balanceHistory();
    expect(history).toHaveLength(MAX_BALANCE_POINTS);
    expect(history[0]!.uec).toBe(25);
    expect(history.at(-1)!.uec).toBe(MAX_BALANCE_POINTS + 24);
  });

  it("Given the history handed out, Then changing it does not change the service's own", () => {
    const service = new TelemetryService({ now: () => 0 });
    (service as unknown as { recordBalance(u: number, t: number): void }).recordBalance(10, 5);
    service.balanceHistory()[0]!.uec = 999;
    expect(service.balanceHistory()[0]!.uec).toBe(10);
  });

  it("Given telemetry switched off, Then the history is empty and nothing was loaded", async () => {
    expect(await createTelemetry({ enabled: false }).balanceHistory!()).toEqual([]);
  });
});
