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
  /** Bodies of the requests received (should always be the 5-byte empty message). */
  requestBodies: Buffer[];
  /** Send frames (already encoded TelemetryStreamResponse bytes) to every open stream. */
  send(...frames: Buffer[]): void;
  /** Send raw bytes (already framed) to every open stream, for chunking tests. */
  sendRaw(...chunks: Buffer[]): void;
  /** Close every open stream normally. */
  endStreams(): void;
  close(): Promise<void>;
}

export type FakeMode = "stream" | "unimplemented" | "not_grpc" | "unavailable";

export async function startFakeGame(mode: FakeMode = "stream", port = 0): Promise<FakeGame> {
  const server = http2.createServer();
  const streams = new Set<http2.ServerHttp2Stream>();
  const sockets = new Set<import("node:net").Socket>();
  let connections = 0;
  const requestBodies: Buffer[] = [];

  server.on("connection", (socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
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
    stream.respond({ ":status": 200, "content-type": "application/grpc" });
    streams.add(stream);
    stream.on("close", () => streams.delete(stream));
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
    requestBodies,
    send(...frames) {
      for (const s of streams) for (const f of frames) s.write(grpcMessage(f));
    },
    sendRaw(...chunks) {
      for (const s of streams) for (const c of chunks) s.write(c);
    },
    endStreams() {
      for (const s of streams) s.close();
    },
    close() {
      for (const s of streams) s.destroy();
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
