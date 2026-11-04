import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FIELDS_PER_FRAME, MAX_REPEATED, decodeFrame } from "./decode.js";
import { EventBuffer, MAX_EVENT_DATA_CHARS, makeEvent } from "./events.js";
import { FrameGate } from "./frameGate.js";
import { TelemetryHandler } from "./handler.js";
import { normalizeFrame } from "./normalize.js";
import { MAX_MESSAGE_BYTES, MessageFramer } from "./reader.js";
import { TelemetryService } from "./service.js";
import { actorField, cat, frame, grpcMessage, lf, vehicleField, vf } from "./testing/encode.js";
import { startFakeGame, type FakeGame } from "./testing/fakeServer.js";
import { WireError } from "./wire.js";
import { waitFor } from "../../testing/waitFor.js";

/**
 * Bounds against a local program that pretends to be the game on 127.0.0.1:2942. Everything here is built with the
 * test encoder: no real frame, no real game.
 */

const FAST = { retryMs: [20, 20, 40], connectTimeoutMs: 500 };

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.restoreAllMocks();
});

async function liveService(extra: ConstructorParameters<typeof TelemetryService>[0] = {}) {
  const game: FakeGame = await startFakeGame();
  cleanup.push(() => game.close());
  const s = new TelemetryService({
    endpointForTests: { host: "127.0.0.1", port: game.port },
    reader: FAST,
    ...extra,
  });
  cleanup.push(() => s.stop());
  s.ensureStarted();
  await waitFor(async () => (await s.status()).state === "connected", "connected");
  return { game, s };
}

const weaponEntry = (name: string) =>
  lf(4, cat(Buffer.from([0x0a, name.length]), Buffer.from(name)));
const speedFrame = (speed: number) => frame(vehicleField({ speed, altitude: 1000 }));

describe("Feature: repeated fields are capped", () => {
  it("Given 500 000 empty weapons in a 1 MiB frame (under the message limit), Then it is refused at the field budget with a WireError", () => {
    const entry = Buffer.from([0x22, 0x00]); // WeaponsFrame.weapons (4), empty
    const body = Buffer.alloc(entry.length * 500_000);
    for (let i = 0; i < 500_000; i++) entry.copy(body, i * 2);
    const message = lf(4, body);
    expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    // "Fast" is a property of the code, not of the clock: the decoder reads fields lazily and stops at the budget
    // (5000), it does not walk the 500 000 entries first. The message names the budget, so a decoder that read
    // them all and failed for another reason would not pass.
    expect(() => decodeFrame(message)).toThrow(WireError);
    expect(() => decodeFrame(message)).toThrow(/more than 5000 fields/);
  });

  it("Given 200 weapons, 40 countermeasures and 100 game events in one frame, Then 64, 16 and 32 are kept and the surplus is noted", () => {
    const guns = Array.from({ length: 200 }, (_, i) => weaponEntry(`GUN_${i}`));
    const cms = Array.from({ length: 40 }, () => lf(5, vf(1, 1), vf(2, 3)));
    const events = lf(5, ...Array.from({ length: 100 }, () => lf(1, vf(1, 1))));
    const { frame: f, report } = decodeFrame(cat(lf(4, ...guns, ...cms), events));
    const w = f["weapons"] as { weapons: unknown[]; countermeasures: unknown[] };
    expect(w.weapons).toHaveLength(64);
    expect(w.countermeasures).toHaveLength(16);
    expect((f["events"] as { events: unknown[] }).events).toHaveLength(32);
    expect(MAX_REPEATED).toEqual({
      "WeaponsFrame.weapons": 64,
      "WeaponsFrame.countermeasures": 16,
      "EventsFrame.events": 32,
    });
    expect(report.anomalies.sort()).toEqual([
      "EventsFrame.events: more than 32 entries, the rest ignored",
      "WeaponsFrame.countermeasures: more than 16 entries, the rest ignored",
      "WeaponsFrame.weapons: more than 64 entries, the rest ignored",
    ]);
  });

  it("Given exactly the cap, Then nothing is noted", () => {
    const weapons = lf(4, ...Array.from({ length: 64 }, (_, i) => weaponEntry(`GUN_${i}`)));
    const { frame: f, report } = decodeFrame(weapons);
    expect((f["weapons"] as { weapons: unknown[] }).weapons).toHaveLength(64);
    expect(report.anomalies).toEqual([]);
  });
});

describe("Feature: the number of fields in one frame is capped", () => {
  it(`Given exactly ${MAX_FIELDS_PER_FRAME} fields, Then the frame decodes; one more and it is refused`, () => {
    const some = (n: number) => cat(...Array.from({ length: n }, () => vf(12, 1))); // unknown field: skipped, counted
    expect(() => decodeFrame(some(MAX_FIELDS_PER_FRAME))).not.toThrow();
    expect(() => decodeFrame(some(MAX_FIELDS_PER_FRAME + 1))).toThrow(WireError);
  });

  it("Given the fields spread over nested messages, Then they all count against the same budget", () => {
    const inner = (n: number) => lf(4, ...Array.from({ length: n }, () => vf(9, 1))); // WeaponsFrame unknown 9
    expect(() => decodeFrame(cat(inner(2400), inner(2400)))).not.toThrow();
    expect(() => decodeFrame(cat(inner(2600), inner(2600)))).toThrow(WireError);
  });

  it("Given a frame that exceeds it, Then the service counts it rejected and the stream carries on", async () => {
    const { game, s } = await liveService({ frameIntervalMs: 0 });
    const entry = Buffer.from([0x22, 0x00]);
    const body = Buffer.alloc(2 * 500_000);
    for (let i = 0; i < 500_000; i++) entry.copy(body, i * 2);
    game.send(lf(4, body), speedFrame(321));
    await waitFor(() => s.snapshot() !== null, "the good frame");
    expect(s.snapshot()!.state.ship?.instruments?.speed_ms).toBeCloseTo(321);
    expect((await s.status()).frames_rejected).toBe(1);
  });
});

describe("Feature: a hostile frame cannot make the answer huge", () => {
  it("Given 60 weapons from the game, Then they all come through, 64 at most", async () => {
    const { game, s } = await liveService({ frameIntervalMs: 0 });
    game.send(lf(4, ...Array.from({ length: 60 }, (_, i) => weaponEntry(`GUN_${i}`))));
    await waitFor(() => s.snapshot() !== null, "frame");
    expect(s.snapshot()!.state.weapons?.weapons).toHaveLength(60);
  });

  it("Given 5 000 weapons in one frame, Then the state holds 64 and the diagnostics hold one bounded note", async () => {
    const { game, s } = await liveService({ frameIntervalMs: 0 });
    // 5 000 entries is under the field budget, over the weapon cap
    game.send(lf(4, ...Array.from({ length: 4000 }, (_, i) => weaponEntry(`GUN_${i}`))));
    await waitFor(() => s.snapshot() !== null, "frame");
    expect(s.snapshot()!.state.weapons?.weapons).toHaveLength(64);
    const status = await s.status();
    expect(status.anomalies).toEqual([
      "WeaponsFrame.weapons: more than 64 entries, the rest ignored",
    ]);
    expect(JSON.stringify(s.snapshot()).length).toBeLessThan(20_000);
  });
});

describe("Feature: the message size limit stays", () => {
  it("Given a message of exactly 1 MiB, Then it is accepted; one byte more is refused before it is buffered", () => {
    expect(MAX_MESSAGE_BYTES).toBe(1024 * 1024);
    const body = Buffer.alloc(MAX_MESSAGE_BYTES, 1);
    const out = new MessageFramer().push(grpcMessage(body));
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBe(MAX_MESSAGE_BYTES);
    const header = Buffer.alloc(5);
    header.writeUInt32BE(MAX_MESSAGE_BYTES + 1, 1);
    expect(() => new MessageFramer().push(header)).toThrow(/beyond the limit/);
  });
});

/**
 * Counts the bytes Buffer.concat produces from now on (restored by afterEach through vi.restoreAllMocks). This is the
 * deterministic form of "the framer is not quadratic": a number of bytes copied, which a loaded CPU cannot change.
 */
function copiedBytes(): () => number {
  let total = 0;
  const real = Buffer.concat.bind(Buffer);
  vi.spyOn(Buffer, "concat").mockImplementation(((...args: Parameters<typeof Buffer.concat>) => {
    const out = real(...args);
    total += out.length;
    return out;
  }) as typeof Buffer.concat);
  return () => total;
}

describe("Feature: the framer does not copy everything buffered for each chunk", () => {
  it("Given one 100 000-byte message arriving one byte at a time, Then it comes out intact, each byte copied a bounded number of times", () => {
    const body = Buffer.alloc(99_995);
    for (let i = 0; i < body.length; i++) body[i] = i % 251;
    const wire = grpcMessage(body);
    expect(wire.length).toBe(100_000);
    const framer = new MessageFramer();
    const copied = copiedBytes();
    const out: Buffer[] = [];
    for (let i = 0; i < wire.length; i++) out.push(...framer.push(wire.subarray(i, i + 1)));
    // No clock: "cheap" means every byte is copied a bounded number of times, not once per later chunk.
    expect(copied()).toBeLessThanOrEqual(2 * wire.length);
    expect(out).toHaveLength(1);
    expect(out[0]!.equals(body)).toBe(true);
  });

  it("Given 300 000 one-byte chunks of a header that never completes its body, Then it stays cheap and nothing comes out", () => {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(900_000, 1); // allowed, never completed
    const framer = new MessageFramer();
    const copied = copiedBytes();
    expect(framer.push(header)).toEqual([]);
    let emitted = 0;
    for (let i = 0; i < 300_000; i++) emitted += framer.push(Buffer.from([7])).length;
    expect(emitted).toBe(0);
    // Quadratic copying would move billions of bytes here (every chunk re-copying what is buffered).
    expect(copied()).toBeLessThanOrEqual(2 * 300_005);
  });

  it("Given 60 messages of random sizes cut into random chunks, Then the same messages come out in order", () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    const messages = Array.from({ length: 60 }, () => {
      const m = Buffer.alloc(rnd(3) === 0 ? 0 : rnd(900));
      for (let i = 0; i < m.length; i++) m[i] = rnd(256);
      return m;
    });
    const wire = Buffer.concat(messages.map((m) => grpcMessage(m)));
    const framer = new MessageFramer();
    const out: Buffer[] = [];
    for (let at = 0; at < wire.length;) {
      const n = 1 + rnd(rnd(4) === 0 ? 1200 : 30);
      out.push(...framer.push(wire.subarray(at, at + n)));
      at += n;
    }
    expect(out).toHaveLength(messages.length);
    out.forEach((m, i) => expect(m.equals(messages[i]!)).toBe(true));
  });

  it("Given a bad flag in the middle of the stream, Then it still throws", () => {
    const framer = new MessageFramer();
    framer.push(grpcMessage(Buffer.from([1])));
    expect(() => framer.push(Buffer.from([1, 0, 0, 0, 1, 0]))).toThrow(/compressed/);
  });
});

describe("Feature: the frame rate is limited, the newest frame is never lost", () => {
  it("Given a burst of 1 000 offers in the same instant, Then one is handled now and the LAST one when the interval is over", () => {
    vi.useFakeTimers();
    try {
      let clock = 1_000;
      const handled: [number, boolean][] = [];
      const gate = new FrameGate<number>(
        30,
        () => clock,
        (item, _t, deferred) => handled.push([item, deferred]),
      );
      for (let i = 0; i < 1000; i++) gate.offer(i, clock);
      expect(handled).toEqual([[0, false]]);
      clock += 30;
      vi.advanceTimersByTime(30);
      expect(handled).toEqual([
        [0, false],
        [999, true],
      ]);
      vi.advanceTimersByTime(1000);
      expect(handled).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Given a flood over one second, Then at most about 34 are handled, whatever the number offered", () => {
    vi.useFakeTimers();
    try {
      let clock = 0;
      let handled = 0;
      const gate = new FrameGate<number>(
        30,
        () => clock,
        () => handled++,
      );
      for (let ms = 0; ms <= 1000; ms++) {
        clock = ms;
        for (let k = 0; k < 50; k++) gate.offer(ms * 50 + k, clock);
        vi.advanceTimersByTime(1);
      }
      expect(handled).toBeLessThanOrEqual(35);
      expect(handled).toBeGreaterThanOrEqual(25);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Given frames at 17 Hz (every 59 ms), Then every one is handled at once", () => {
    let clock = 0;
    const handled: boolean[] = [];
    const gate = new FrameGate<number>(
      30,
      () => clock,
      (_item, _t, deferred) => handled.push(deferred),
    );
    for (let i = 0; i < 100; i++) {
      clock += 59;
      expect(gate.offer(i, clock)).toBe(true);
    }
    expect(handled).toHaveLength(100);
    expect(handled.every((deferred) => !deferred)).toBe(true);
  });

  it("Given clear(), Then the waiting item is dropped", () => {
    vi.useFakeTimers();
    try {
      const handled: number[] = [];
      const gate = new FrameGate<number>(
        30,
        () => 0,
        (item) => handled.push(item),
      );
      gate.offer(1, 0);
      gate.offer(2, 0);
      gate.clear();
      vi.advanceTimersByTime(1000);
      expect(handled).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Given a clock that jumps back by an hour, Then the wait is still at most the interval", () => {
    vi.useFakeTimers();
    try {
      let clock = 10_000_000;
      const handled: number[] = [];
      const gate = new FrameGate<number>(
        30,
        () => clock,
        (item) => handled.push(item),
      );
      gate.offer(1, clock);
      clock -= 3_600_000;
      gate.offer(2, clock);
      vi.advanceTimersByTime(30);
      expect(handled).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Given 3 000 frames sent in a burst by the fake game, Then the handler runs a handful of times, every frame is counted and the last one wins", async () => {
    const update = vi.spyOn(TelemetryHandler.prototype, "update");
    const { game, s } = await liveService({ now: () => 5_000 }); // frozen clock: the whole burst is "at once"
    const started = Date.now();
    game.send(...Array.from({ length: 3000 }, (_, i) => speedFrame(i + 1)));
    await waitFor(() => s.snapshot()?.state.ship?.instruments?.speed_ms === 3000, "the last frame");
    const elapsed = Date.now() - started;
    expect((await s.status()).frames_received).toBe(3000);
    expect(update.mock.calls.length).toBeGreaterThanOrEqual(2);
    // One slot per 30 ms of real time at most (plus the first and the last), however slowly the burst arrives.
    expect(update.mock.calls.length).toBeLessThanOrEqual(3 + Math.ceil(elapsed / 30));
    expect(update.mock.calls.length).toBeLessThan(300);
  });

  it("Given 20 000 empty messages in a burst, Then they are all counted and almost none is decoded", async () => {
    const update = vi.spyOn(TelemetryHandler.prototype, "update");
    const { game, s } = await liveService({ now: () => 5_000 });
    const started = Date.now();
    game.send(...Array.from({ length: 20_000 }, () => Buffer.alloc(0)));
    await waitFor(async () => (await s.status()).frames_received === 20_000, "all counted");
    await new Promise((r) => setTimeout(r, 80));
    const elapsed = Date.now() - started;
    expect(update.mock.calls.length).toBeLessThanOrEqual(3 + Math.ceil(elapsed / 30));
    expect(update.mock.calls.length).toBeLessThan(300);
  });

  it("Given the real game's pace (17 frames a second, here on a controlled clock), Then no frame is skipped", async () => {
    const update = vi.spyOn(TelemetryHandler.prototype, "update");
    let clock = 1_000_000;
    const { game, s } = await liveService({ now: () => clock });
    for (let i = 1; i <= 17; i++) {
      clock += 59;
      game.send(speedFrame(i * 10));
      await waitFor(
        () => s.snapshot()?.state.ship?.instruments?.speed_ms === i * 10,
        `frame ${i} applied`,
      );
    }
    expect(update).toHaveBeenCalledTimes(17);
    expect((await s.status()).frames_received).toBe(17);
  });

  it("Given stop() while a frame is waiting for its slot, Then that frame is dropped, not applied later", async () => {
    const update = vi.spyOn(TelemetryHandler.prototype, "update");
    const { game, s } = await liveService({ now: () => 5_000 });
    game.send(speedFrame(1), speedFrame(2)); // 1 is handled, 2 waits
    await waitFor(() => update.mock.calls.length >= 1, "first");
    await s.stop();
    await new Promise((r) => setTimeout(r, 80));
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("Feature: what the event ring can hold is bounded", () => {
  it("Given a data string of 10 000 characters, Then the event keeps 80", () => {
    const e = makeEvent(1, "vehicle_changed", 0, { vehicle: "V".repeat(10_000) });
    expect((e.data["vehicle"] as string).length).toBe(MAX_EVENT_DATA_CHARS);
    expect(e.text.length).toBeLessThan(200);
  });

  it("Given a program that swaps between 400 ships with 64-character names and one with a 100 000-character name, Then the ring holds 200 small events", () => {
    const events = new EventBuffer();
    const handler = new TelemetryHandler(undefined, events);
    let t = 0;
    const feed = (name: string, seat?: string) => {
      t += 100;
      const { frame: f } = decodeFrame(
        cat(vehicleField({ name }), seat ? actorField({ seat, locomotion: 3 }) : Buffer.alloc(0)),
      );
      handler.update(normalizeFrame(f), t);
    };
    for (let i = 0; i < 400; i++) {
      feed("S".repeat(58) + String(1000 + i).padStart(6, "0"));
      if (i % 50 === 0) feed("HUGE_" + "X".repeat(100_000), "SEAT_" + "Y".repeat(100_000));
    }
    const kept = events.since(0, 1000);
    expect(kept).toHaveLength(200);
    const text = JSON.stringify(kept);
    expect(text).not.toContain("XXXXXXXX");
    expect(text).not.toContain("YYYYYYYY");
    expect(text.length).toBeLessThan(200 * 400);
    for (const e of kept) {
      for (const v of Object.values(e.data)) {
        if (typeof v === "string") expect(v.length).toBeLessThanOrEqual(MAX_EVENT_DATA_CHARS);
      }
    }
  });
});

describe("Feature: the countermeasure bookkeeping is bounded", () => {
  it("Given a program that invents a new countermeasure type in every frame, Then the handler tracks 8 kinds at most", () => {
    const handler = new TelemetryHandler(undefined, new EventBuffer());
    for (let i = 0; i < 200; i++) {
      // type = an enum number the schema does not know: decoded as unknown_<n>
      const { frame: f } = decodeFrame(lf(4, lf(5, vf(1, 100 + i), vf(2, 5))));
      handler.update(normalizeFrame(f), 100 * i);
    }
    expect(Object.keys(handler.latest!.countermeasure_burst).length).toBeLessThanOrEqual(8);
  });
});
