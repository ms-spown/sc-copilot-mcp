import http2 from "node:http2";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelemetry } from "./index.js";
import { GrpcStreamReader, MessageFramer, type ReaderState } from "./reader.js";
import { TelemetryService } from "./service.js";
import {
  actorField,
  frame,
  grpcMessage,
  lf,
  sf,
  vehicleField,
  vf,
  weaponsField,
} from "./testing/encode.js";
import { startFakeGame, type FakeGame, type FakeMode } from "./testing/fakeServer.js";

const FAST = { retryMs: [20, 20, 40], connectTimeoutMs: 500 };

async function waitFor(check: () => boolean | Promise<boolean>, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.restoreAllMocks();
});

async function game(mode: FakeMode = "stream", port = 0): Promise<FakeGame> {
  const g = await startFakeGame(mode, port);
  cleanup.push(() => g.close());
  return g;
}

function service(
  g: FakeGame,
  extra: Partial<ConstructorParameters<typeof TelemetryService>[0]> = {},
) {
  const s = new TelemetryService({
    endpointForTests: { host: "127.0.0.1", port: g.port },
    reader: FAST,
    // These tests send frames back to back and count each one; the frame rate limit has its own tests
    // (bounds.behaviour.test.ts), which run with the production default.
    frameIntervalMs: 0,
    ...extra,
  });
  cleanup.push(() => s.stop());
  return s;
}

const aFrame = (speed = 0) =>
  frame(
    vehicleField({ speed, altitude: 1000, lights: { shld: "nominal" } }),
    actorField({ health: 100, uec: 5000 }),
  );

describe("Feature: the gRPC framing", () => {
  it("Given two messages and half of a third in one chunk, Then two come out now and the third when it completes", () => {
    const framer = new MessageFramer();
    const a = grpcMessage(Buffer.from([1, 2, 3]));
    const b = grpcMessage(Buffer.from([4]));
    const c = grpcMessage(Buffer.from([5, 6, 7, 8]));
    const out = framer.push(Buffer.concat([a, b, c.subarray(0, 6)]));
    expect(out.map((m) => [...m])).toEqual([[1, 2, 3], [4]]);
    expect(framer.push(c.subarray(6)).map((m) => [...m])).toEqual([[5, 6, 7, 8]]);
  });

  it("Given a message split in the middle of its 5-byte header, Then it still reassembles", () => {
    const framer = new MessageFramer();
    const a = grpcMessage(Buffer.from([9, 9]));
    expect(framer.push(a.subarray(0, 2))).toEqual([]);
    expect(framer.push(a.subarray(2)).map((m) => [...m])).toEqual([[9, 9]]);
  });

  it("Given a compressed message, Then it is refused", () => {
    const bad = Buffer.from([1, 0, 0, 0, 1, 0]);
    expect(() => new MessageFramer().push(bad)).toThrow(/compressed/);
  });

  it("Given a declared length beyond the limit, Then it is refused before anything is allocated", () => {
    const huge = Buffer.from([0, 0xff, 0xff, 0xff, 0xff]);
    expect(() => new MessageFramer().push(huge)).toThrow(/beyond the limit/);
  });
});

describe("Feature: reading the stream from the game", () => {
  describe("Scenario: the game is running with telemetry", () => {
    it("Given frames from the game, Then the state goes connected -> live and the values arrive", async () => {
      const g = await game();
      const s = service(g);
      expect((await s.status()).state).not.toBe("live");
      await waitFor(() => g.requestBodies.length === 1 || g.connections() > 0, "connection");
      await waitFor(async () => (await s.status()).state === "connected", "connected");
      g.send(aFrame(250));
      await waitFor(async () => (await s.status()).state === "live", "live");
      const snap = s.snapshot()!;
      expect(snap.state.ship?.instruments?.speed_ms).toBeCloseTo(250);
      expect(snap.state.pilot?.uec_balance).toBe(5000);
      expect(snap.frame_age_ms).toBeLessThan(2000);
    });

    it("Given the request the reader sent, Then it was the empty message and nothing more", async () => {
      const g = await game();
      const s = service(g);
      s.ensureStarted();
      await waitFor(() => g.requestBodies.length === 1, "request");
      expect([...g.requestBodies[0]!]).toEqual([0, 0, 0, 0, 0]);
    });

    it("Given a frame cut across two network chunks, Then it is decoded once complete", async () => {
      const g = await game();
      const s = service(g);
      s.ensureStarted();
      await waitFor(async () => (await s.status()).state === "connected", "connected");
      const wire = grpcMessage(aFrame(77));
      g.sendRaw(wire.subarray(0, 9));
      await new Promise((r) => setTimeout(r, 40));
      expect(s.snapshot()).toBeNull();
      g.sendRaw(wire.subarray(9));
      await waitFor(() => s.snapshot() !== null, "snapshot");
      expect(s.snapshot()!.state.ship?.instruments?.speed_ms).toBeCloseTo(77);
    });

    it("Given the stream silent for longer than the live window, Then the state is 'connected' again and the age grows", async () => {
      const g = await game();
      const s = service(g, { liveWindowMs: 60 });
      s.ensureStarted();
      await waitFor(async () => (await s.status()).state === "connected", "connected");
      g.send(aFrame());
      await waitFor(async () => (await s.status()).state === "live", "live");
      await new Promise((r) => setTimeout(r, 120));
      const status = await s.status();
      expect(status.state).toBe("connected");
      expect(status.last_frame_age_ms).toBeGreaterThanOrEqual(60);
    });

    it("Given many frames, Then events accumulate in memory and can be read from a cursor", async () => {
      const g = await game();
      const s = service(g);
      s.ensureStarted();
      await waitFor(async () => (await s.status()).state === "connected", "connected");
      g.send(frame(vehicleField({ landed: true, altitude: 5 })));
      await new Promise((r) => setTimeout(r, 30));
      g.send(frame(vehicleField({ landed: true, altitude: 5 })));
      await waitFor(() => s.snapshot() !== null, "first frames");
      // took off: landed flag dropped for more than the 1 s hold
      const t0 = Date.now();
      g.send(frame(vehicleField({ altitude: 5 })));
      await waitFor(() => Date.now() - t0 > 1100, "hold time", 2000).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 1100));
      g.send(frame(vehicleField({ altitude: 5 })));
      await waitFor(() => s.recentEvents().events.some((e) => e.type === "took_off"), "took_off");
      const first = s.recentEvents();
      expect(s.recentEvents(first.last_seq).events).toEqual([]);
    });

    it("Given the game closing the stream and coming back, Then the reader reconnects and goes live again", async () => {
      const g = await game();
      const s = service(g);
      s.ensureStarted();
      await waitFor(async () => (await s.status()).state === "connected", "connected");
      g.send(aFrame());
      await waitFor(async () => (await s.status()).state === "live", "live");
      g.endStreams();
      await waitFor(
        async () => (await s.status()).reconnects >= 0 && g.connections() >= 2,
        "reconnect",
      );
      // The new connection exists before the fake game has registered its stream: a frame sent right now would
      // go nowhere. The real game sends 17 a second, so keep sending until the reader reports live.
      await waitFor(async () => {
        g.send(aFrame(1));
        return (await s.status()).state === "live";
      }, "live again");
      expect((await s.status()).reconnects).toBe(1);
    });
  });

  describe("Scenario: nobody is listening", () => {
    it("Given nothing on the port, Then the state is 'waiting' and the process is not kept alive by it", async () => {
      const g = await game();
      const port = g.port;
      await g.close();
      const s = new TelemetryService({
        endpointForTests: { host: "127.0.0.1", port },
        reader: FAST,
      });
      cleanup.push(() => s.stop());
      const status = await s.status();
      expect(status.state).toBe("waiting");
      expect(status.frames_received).toBe(0);
      expect(s.snapshot()).toBeNull();
    });

    it("Given a game that runs without the telemetry line in its log, Then the state is 'game_without_telemetry'", async () => {
      const g = await game();
      const port = g.port;
      await g.close();
      const s = new TelemetryService({
        endpointForTests: { host: "127.0.0.1", port },
        reader: FAST,
        gameLogHint: async () => ({ running: true, telemetryRegistered: false }),
      });
      cleanup.push(() => s.stop());
      expect((await s.status()).state).toBe("game_without_telemetry");
    });

    it("Given a running game whose log has the telemetry line but no port answers yet, Then it is simply 'waiting'", async () => {
      const g = await game();
      const port = g.port;
      await g.close();
      const s = new TelemetryService({
        endpointForTests: { host: "127.0.0.1", port },
        reader: FAST,
        gameLogHint: async () => ({ running: true, telemetryRegistered: true }),
      });
      cleanup.push(() => s.stop());
      expect((await s.status()).state).toBe("waiting");
    });
  });

  describe("Scenario: a game patch changes the interface", () => {
    it("Given the service answering UNIMPLEMENTED in the headers (trailers-only), Then the state is 'incompatible'", async () => {
      const g = await game("unimplemented");
      const s = service(g);
      s.ensureStarted();
      await waitFor(async () => (await s.status()).state === "incompatible", "incompatible");
      expect((await s.status()).cause).toMatch(/UNIMPLEMENTED/);
    });

    it("Given something that answers HTTP but not gRPC, Then the state is 'incompatible'", async () => {
      const g = await game("not_grpc");
      const s = service(g);
      s.ensureStarted();
      await waitFor(async () => (await s.status()).state === "incompatible", "incompatible");
    });

    it("Given UNAVAILABLE (14), Then it is just 'waiting', not incompatible", async () => {
      const g = await game("unavailable");
      const s = service(g);
      s.ensureStarted();
      await new Promise((r) => setTimeout(r, 100));
      expect((await s.status()).state).toBe("waiting");
    });

    it("Given frames whose known fields arrive in the wrong wire type five times in a row, Then the state is 'incompatible'", async () => {
      const g = await game();
      const s = service(g);
      s.ensureStarted();
      await waitFor(async () => (await s.status()).state === "connected", "connected");
      // actor (6) -> ActorFrame.state (2) -> uec_balance (4) sent as a length-delimited field instead of a varint
      const wrong = frame(lf(6, lf(2, sf(4, "x"))));
      g.send(wrong, wrong, wrong, wrong, wrong);
      await waitFor(async () => (await s.status()).state === "incompatible", "incompatible");
      const status = await s.status();
      expect(status.anomalies).toEqual(["ActorState.uec_balance: wire type 2"]);
      expect(status.cause).toMatch(/patch/);
    });

    it("Given frames with only fields we do not know, Then it becomes incompatible, listing field NUMBERS only", async () => {
      const g = await game();
      const s = service(g);
      s.ensureStarted();
      await waitFor(async () => (await s.status()).state === "connected", "connected");
      const unknown = frame(vf(12, 1));
      g.send(unknown, unknown, unknown, unknown, unknown);
      await waitFor(async () => (await s.status()).state === "incompatible", "incompatible");
      expect((await s.status()).unknown_fields).toEqual(["TelemetryStreamResponse.12"]);
    });

    it("Given one good frame after a few bad ones, Then the streak resets and the stream is not incompatible", async () => {
      const g = await game();
      const s = service(g);
      s.ensureStarted();
      await waitFor(async () => (await s.status()).state === "connected", "connected");
      const unknown = frame(vf(12, 1));
      g.send(unknown, unknown, unknown, unknown, aFrame(), unknown, unknown);
      await waitFor(async () => (await s.status()).frames_received >= 6, "frames");
      expect((await s.status()).state).toBe("live");
    });

    it("Given a garbled message, Then it is counted as rejected and the stream carries on", async () => {
      const g = await game();
      const s = service(g);
      s.ensureStarted();
      await waitFor(async () => (await s.status()).state === "connected", "connected");
      g.send(Buffer.from([0x0b]), aFrame(5));
      await waitFor(async () => (await s.status()).state === "live", "live");
      expect((await s.status()).frames_rejected).toBe(1);
    });
  });

  describe("Scenario: privacy of the diagnostics", () => {
    it("Given a pilot with a balance and a seat name, Then neither appears anywhere in the status report", async () => {
      const g = await game();
      const s = service(g);
      s.ensureStarted();
      await waitFor(async () => (await s.status()).state === "connected", "connected");
      g.send(frame(actorField({ uec: 123456789, seat: "SECRET_SEAT_NAME" }), vf(12, 1)));
      await waitFor(async () => (await s.status()).frames_received >= 1, "frame");
      const text = JSON.stringify(await s.status());
      expect(text).not.toContain("123456789");
      expect(text).not.toContain("SECRET_SEAT_NAME");
    });
  });

  describe("Scenario: the balance since the reader started", () => {
    it("Given a balance of 5000 that becomes 4200, Then the session delta is -800, and it can be reset", async () => {
      const g = await game();
      const s = service(g);
      s.ensureStarted();
      await waitFor(async () => (await s.status()).state === "connected", "connected");
      g.send(frame(actorField({ uec: 5000 })));
      await waitFor(() => s.snapshot() !== null, "first frame");
      g.send(frame(actorField({ uec: 4200 })));
      await waitFor(() => s.snapshot()?.uec_session?.current === 4200, "second frame");
      expect(s.snapshot()?.uec_session).toMatchObject({ start: 5000, current: 4200, delta: -800 });
      s.resetUecDelta();
      expect(s.snapshot()?.uec_session).toMatchObject({ start: 4200, delta: 0 });
    });
  });

  describe("Scenario: stopping", () => {
    it("Given no request for the idle period, Then the reader stops by itself and the next request restarts it", async () => {
      const g = await game();
      const s = service(g, { idleMs: 80 });
      s.ensureStarted();
      await waitFor(() => g.connections() === 1, "first connection");
      await new Promise((r) => setTimeout(r, 300));
      const before = g.connections();
      await new Promise((r) => setTimeout(r, 120));
      expect(g.connections()).toBe(before); // stopped: no more attempts
      s.ensureStarted();
      await waitFor(() => g.connections() > before, "restart");
    });

    it("Given stop() while connected and silent (menus), Then it returns promptly", async () => {
      const g = await game();
      const reader = new GrpcStreamReader(
        { onMessage: () => undefined, onState: () => undefined },
        { host: "127.0.0.1", port: g.port },
        FAST,
      );
      reader.start();
      await waitFor(() => g.requestBodies.length === 1, "request");
      const started = Date.now();
      await reader.stop();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(reader.running).toBe(false);
    });

    it("Given reader states, Then they come in the order stopped -> connected -> live -> stopped", async () => {
      const g = await game();
      const seen: ReaderState[] = [];
      const reader = new GrpcStreamReader(
        { onMessage: () => undefined, onState: (st) => seen.push(st) },
        { host: "127.0.0.1", port: g.port },
        FAST,
      );
      reader.start();
      await waitFor(() => seen.includes("connected"), "connected");
      g.send(aFrame());
      await waitFor(() => seen.includes("live"), "live");
      await reader.stop();
      expect(seen).toEqual(["connected", "live", "stopped"]);
    });
  });

  describe("Scenario: loopback only", () => {
    it("Given any host other than 127.0.0.1, Then the reader refuses to be built", () => {
      expect(
        () =>
          new GrpcStreamReader({ onMessage: () => undefined, onState: () => undefined }, {
            host: "192.168.1.5",
            port: 2942,
          } as never),
      ).toThrow(/loopback only/);
    });
  });
});

describe("Feature: switched off, nothing is loaded and nothing connects", () => {
  it("Given SC_TELEMETRY is not on, Then every call answers 'off' and no HTTP/2 connection is ever opened", async () => {
    const connect = vi.spyOn(http2, "connect");
    const telemetry = createTelemetry({ enabled: false });
    expect(telemetry.enabled).toBe(false);
    expect((await telemetry.status(true)).state).toBe("off");
    expect(await telemetry.snapshot()).toBeNull();
    expect(await telemetry.events()).toEqual({ events: [], last_seq: 0 });
    await telemetry.resetUecDelta();
    await telemetry.stop();
    expect(connect).not.toHaveBeenCalled();
  });

  it("Given it is switched on but nobody asked for anything, Then there is still no connection (lazy start)", async () => {
    const connect = vi.spyOn(http2, "connect");
    const telemetry = createTelemetry({ enabled: true });
    await telemetry.stop();
    expect(connect).not.toHaveBeenCalled();
  });

  it("Given it is switched on and a status is requested, Then exactly one connection attempt goes to 127.0.0.1:2942 or the test port", async () => {
    const g = await game();
    const telemetry = createTelemetry({
      enabled: true,
      options: { endpointForTests: { host: "127.0.0.1", port: g.port }, reader: FAST },
    });
    cleanup.push(() => telemetry.stop());
    await telemetry.status(true);
    await waitFor(() => g.connections() === 1, "one connection");
    await telemetry.status(true);
    await telemetry.snapshot();
    expect(g.connections()).toBe(1);
  });
});

describe("Feature: weapons through the stream", () => {
  it("Given a weapons frame, Then guns and countermeasures reach the state", async () => {
    const g = await game();
    const s = service(g);
    s.ensureStarted();
    await waitFor(async () => (await s.status()).state === "connected", "connected");
    g.send(frame(weaponsField({ guns: ["KLWE_LaserRepeater_S3_123"], decoy: 8 })));
    await waitFor(() => s.snapshot() !== null, "frame");
    expect(s.snapshot()!.state.weapons).toMatchObject({
      weapons: [{ name: "KLWE_LaserRepeater_S3", instance_id: "123", powered: true, ready: true }],
      countermeasures: { decoy: 8 },
    });
  });
});

describe("Feature: robustness of the connection", () => {
  it("Given start() immediately followed by stop(), 300 times, Then nothing is thrown outside the promise chain", async () => {
    // A destroyed session asked for a stream used to throw ERR_HTTP2_INVALID_SESSION from an event handler.
    const g = await game();
    const errors: unknown[] = [];
    const onError = (e: unknown) => errors.push(e);
    process.on("uncaughtException", onError);
    process.on("unhandledRejection", onError);
    try {
      for (let i = 0; i < 300; i++) {
        const reader = new GrpcStreamReader(
          { onMessage: () => undefined, onState: () => undefined },
          { host: "127.0.0.1", port: g.port },
          FAST,
        );
        reader.start();
        if (i % 3 === 0) await new Promise((r) => setImmediate(r));
        await reader.stop();
      }
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("uncaughtException", onError);
      process.off("unhandledRejection", onError);
    }
    expect(errors).toEqual([]);
  });

  it("Given an HTTP/1 server on the port, Then the state is 'incompatible', not 'waiting'", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.end("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanup.push(
      () =>
        new Promise<void>((r) => {
          for (const socket of sockets) socket.destroy(); // an open client connection would keep close() waiting
          server.close(() => r());
        }),
    );
    const port = (server.address() as net.AddressInfo).port;
    const s = new TelemetryService({ endpointForTests: { host: "127.0.0.1", port }, reader: FAST });
    cleanup.push(() => s.stop());
    s.ensureStarted();
    await waitFor(async () => (await s.status(true)).state === "incompatible", "incompatible");
  });

  it("Given the first failure, Then the next attempt comes after the FIRST retry delay, not the second", async () => {
    const attempts: number[] = [];
    const server = net.createServer((socket) => {
      attempts.push(Date.now());
      socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as net.AddressInfo).port;
    const reader = new GrpcStreamReader(
      { onMessage: () => undefined, onState: () => undefined },
      { host: "127.0.0.1", port },
      { retryMs: [80, 5000], connectTimeoutMs: 500 },
    );
    reader.start();
    await waitFor(() => attempts.length >= 2, "second attempt", 2500);
    await reader.stop();
    expect(attempts[1]! - attempts[0]!).toBeLessThan(2000);
  });

  it("Given a restart right after stop(), Then the old reader's late 'stopped' does not overwrite the new state", async () => {
    const g = await game();
    const s = service(g);
    s.ensureStarted();
    await waitFor(async () => (await s.status(false)).state === "connected", "connected");
    const stopping = s.stop();
    s.ensureStarted(); // a new request while the old reader is still shutting down
    await stopping;
    await waitFor(async () => (await s.status(false)).state === "connected", "connected again");
    g.send(aFrame(9));
    await waitFor(async () => (await s.status(false)).state === "live", "live again");
  });

  it("Given endless distinct unknown fields from a local program, Then the diagnostics stay bounded", async () => {
    const g = await game();
    const s = service(g);
    s.ensureStarted();
    await waitFor(async () => (await s.status(true)).state === "connected", "connected");
    for (let i = 0; i < 40; i++) {
      const many = Buffer.concat(Array.from({ length: 40 }, (_, k) => vf(100 + i * 40 + k, 1)));
      g.send(many);
    }
    await waitFor(async () => (await s.status(true)).frames_rejected >= 40, "rejected frames");
    expect((await s.status(true)).unknown_fields.length).toBeLessThanOrEqual(20);
  });
});

describe("Feature: nothing is loaded while telemetry is off", () => {
  it("Given a fresh module graph where node:http2, the service and the reader throw on import, When telemetry is off, Then everything still answers", async () => {
    vi.resetModules();
    const boom = (what: string) => () => {
      throw new Error(what + " must not be loaded while telemetry is off");
    };
    vi.doMock("node:http2", boom("node:http2"));
    vi.doMock("./service.js", boom("service"));
    vi.doMock("./reader.js", boom("reader"));
    try {
      const { createTelemetry: fresh } = await import("./index.js");
      const t = fresh({ enabled: false });
      expect((await t.status(true)).state).toBe("off");
      expect(await t.snapshot()).toBeNull();
      expect((await t.events()).events).toEqual([]);
      await t.stop();
      // Switched on but never asked: still nothing is loaded (the import happens at the first request).
      const lazy = fresh({ enabled: true });
      await lazy.stop();
    } finally {
      vi.doUnmock("node:http2");
      vi.doUnmock("./service.js");
      vi.doUnmock("./reader.js");
      vi.resetModules();
    }
  });
});

describe("Feature: what the diagnostics may contain", () => {
  it("Given a balance and a seat name in the frames, Then neither appears in the events or the status", async () => {
    const g = await game();
    const s = service(g);
    s.ensureStarted();
    await waitFor(async () => (await s.status(true)).state === "connected", "connected");
    g.send(
      frame(actorField({ uec: 111111111, seat: "SECRET_SEAT", health: 100, intoxication: 0 })),
    );
    await new Promise((r) => setTimeout(r, 30));
    g.send(
      frame(actorField({ uec: 222222222, seat: "SECRET_SEAT", health: 100, intoxication: 3 })),
    );
    await waitFor(() => s.recentEvents().events.length > 0, "an event");
    const text = JSON.stringify([
      await s.status(false),
      // Balance-change events carry the balance by design: the tools withhold them unless asked.
      s.recentEvents(0, 100).events.filter((e) => e.type !== "uec_changed"),
    ]);
    expect(text).not.toContain("111111111");
    expect(text).not.toContain("222222222");
    expect(text).not.toContain("SECRET_SEAT");
  });
});
