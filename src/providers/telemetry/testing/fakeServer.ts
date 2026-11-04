import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { SERVICE_PATH } from "../schema.js";
import { grpcMessage } from "./encode.js";

/**
 * TEST SUPPORT: a fake game. A gRPC server over HTTP/2 cleartext on 127.0.0.1 and an ephemeral port, in this
 * process. It is the only way the tests exercise the real reader; the production address is never changed.
 */

export interface FakeGame {
  port: number;
  /** Connections the server has accepted so far. */
  connections: () => number;
  /** When (Date.now) each connection was accepted, in order. Lower bounds on the gaps are safe on a loaded machine. */
  connectionTimes: number[];
  /** Connections that have closed so far (the client went away, or the server closed them). */
  closedConnections: () => number;
  /** Bodies of the requests received (should always be the 5-byte empty message). */
  requestBodies: Buffer[];
  /**
   * Send frames (already encoded TelemetryStreamResponse bytes) to every open stream. With no stream open yet, the
   * frames wait and go out, in order, to the first stream that opens: a client that says "connected" may be a moment
   * ahead of the server registering its call, and a frame sent in that moment must not be lost (it used to be, and
   * a loaded machine made the tests fail on it).
   */
  send(...frames: Buffer[]): void;
  /** Send raw bytes (already framed) to every open stream, for chunking tests. Same waiting rule as `send`. */
  sendRaw(...chunks: Buffer[]): void;
  /** Close every open stream normally. */
  endStreams(): void;
  close(): Promise<void>;
}

/**
 * - stream: answers the call at once, then sends frames.
 * - first_frame: like the real game in the menus (suspected): the call is accepted but `respond` is only sent
 *   together with the first frame, so before it the client sees an open session and nothing else.
 */
export type FakeMode = "stream" | "first_frame" | "unimplemented" | "not_grpc" | "unavailable";

/**
 * A loopback port where nothing listens, for the "game is not there" tests. Do NOT get one by starting a fake game
 * and closing it: the system hands a freed ephemeral port to the next listener, which can be another test file
 * running in parallel (a fake game of its own), and the reader then finds a server where the test says there is none.
 * Port 1 is outside every ephemeral range, so no test server ever gets it.
 */
export const UNUSED_PORT = 1;

export async function startFakeGame(mode: FakeMode = "stream", port = 0): Promise<FakeGame> {
  const server = http2.createServer();
  const streams = new Set<http2.ServerHttp2Stream>();
  /** first_frame mode: calls accepted but not answered yet. */
  const pending = new Set<http2.ServerHttp2Stream>();
  const sockets = new Set<import("node:net").Socket>();
  let connections = 0;
  let closed = 0;
  const connectionTimes: number[] = [];
  const requestBodies: Buffer[] = [];
  /** Framed bytes sent while no stream was open: delivered to the next stream that opens. */
  const backlog: Buffer[] = [];
  const flushBacklog = (stream: http2.ServerHttp2Stream) => {
    while (backlog.length > 0 && !stream.destroyed) stream.write(backlog.shift()!);
  };

  server.on("connection", (socket) => {
    connections++;
    connectionTimes.push(Date.now());
    sockets.add(socket);
    socket.on("close", () => {
      closed++;
      sockets.delete(socket);
    });
  });
  const onStream = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => requestBodies.push(Buffer.concat(chunks)));
    stream.on("error", () => undefined);
    if (headers[":path"] !== SERVICE_PATH || mode === "unimplemented") {
      // "Trailers-only" answer: the status is in the headers.
      stream.respond(
        { ":status": 200, "content-type": "application/grpc", "grpc-status": "12" },
        { endStream: true },
      );
      return;
    }
    if (mode === "not_grpc") {
      stream.respond({ ":status": 200, "content-type": "text/html" });
      stream.end("<html></html>");
      return;
    }
    if (mode === "unavailable") {
      stream.respond(
        { ":status": 200, "content-type": "application/grpc", "grpc-status": "14" },
        { endStream: true },
      );
      return;
    }
    if (mode === "first_frame") {
      pending.add(stream);
      stream.on("close", () => {
        pending.delete(stream);
        streams.delete(stream);
      });
      return;
    }
    stream.respond({ ":status": 200, "content-type": "application/grpc" });
    streams.add(stream);
    stream.on("close", () => streams.delete(stream));
    flushBacklog(stream);
  };
  /** first_frame mode: the answer goes out with the first thing sent. */
  const answerPending = () => {
    for (const s of pending) {
      if (!s.destroyed && !s.headersSent)
        s.respond({ ":status": 200, "content-type": "application/grpc" });
      streams.add(s);
      flushBacklog(s);
    }
    pending.clear();
  };
  const deliver = (chunks: Buffer[]) => {
    answerPending();
    if (streams.size === 0) {
      backlog.push(...chunks);
      return;
    }
    for (const s of streams) for (const c of chunks) s.write(c);
  };
  server.on("session", (session) => {
    session.on("error", () => undefined);
    session.on("stream", onStream);
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actualPort = (server.address() as AddressInfo).port;

  return {
    port: actualPort,
    connections: () => connections,
    connectionTimes,
    closedConnections: () => closed,
    requestBodies,
    send(...frames) {
      deliver(frames.map((f) => grpcMessage(f)));
    },
    sendRaw(...chunks) {
      deliver(chunks);
    },
    endStreams() {
      for (const s of streams) s.close();
      for (const s of pending) s.close();
    },
    close() {
      for (const s of streams) s.destroy();
      for (const s of pending) s.destroy();
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
