import http2 from "node:http2";
import { SERVICE_PATH } from "./schema.js";

/**
 * The connection to the game: ONE server-streaming gRPC call, over HTTP/2 without TLS (as the game serves it),
 * reconnecting with a growing delay until stopped. No dependency: gRPC framing is five bytes.
 *
 * Read-only and loopback only. The address is fixed here in code and never comes from the environment. The only
 * thing ever sent to the game is the empty `TelemetryStreamRequest`.
 */

export const GAME_ENDPOINT = { host: "127.0.0.1", port: 2942 } as const;
export type Endpoint = { host: "127.0.0.1"; port: number };

/** Longest single message accepted. Frames are a few hundred bytes; anything near this is not our protocol. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const RETRY_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];
const CONNECT_TIMEOUT_MS = 2000;

export type ReaderState = "waiting" | "connected" | "live" | "incompatible" | "stopped";

export interface ReaderHandlers {
  onMessage(bytes: Uint8Array): void;
  /** `detail` never contains payload bytes. */
  onState(state: ReaderState, detail?: string): void;
}

export interface ReaderOptions {
  /** Delays between attempts; tests shorten them. */
  retryMs?: number[];
  connectTimeoutMs?: number;
}

// gRPC status codes that mean "the game answered, but not with the call we know".
const INCOMPATIBLE_STATUS = new Map<number, string>([
  [2, "UNKNOWN"],
  [3, "INVALID_ARGUMENT"],
  [9, "FAILED_PRECONDITION"],
  [12, "UNIMPLEMENTED"],
  [13, "INTERNAL"],
  [15, "DATA_LOSS"],
]);

/** Splits a byte stream into gRPC messages. Throws on a compressed or oversized message. */
export class MessageFramer {
  private buf: Buffer = Buffer.alloc(0);

  /** Feed a chunk, get the complete messages it finishes (a chunk may hold several, or part of one). */
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    while (this.buf.length >= 5) {
      const flag = this.buf[0]!;
      const len = this.buf.readUInt32BE(1);
      if (flag !== 0) throw new Error("compressed message (flag " + flag + ")");
      if (len > MAX_MESSAGE_BYTES) throw new Error(`message of ${len} bytes is beyond the limit`);
      if (this.buf.length < 5 + len) break;
      out.push(this.buf.subarray(5, 5 + len));
      this.buf = this.buf.subarray(5 + len);
    }
    return out;
  }
}

function grpcStatus(headers: http2.IncomingHttpHeaders): number | undefined {
  const raw = headers["grpc-status"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isNaN(n) ? undefined : n;
}

export class GrpcStreamReader {
  private stopped = true;
  private session: http2.ClientHttp2Session | null = null;
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;
  private state: ReaderState = "stopped";
  private readonly retry: number[];
  private readonly connectTimeout: number;

  constructor(
    private handlers: ReaderHandlers,
    private endpoint: Endpoint = GAME_ENDPOINT,
    options: ReaderOptions = {},
  ) {
    if (endpoint.host !== "127.0.0.1") throw new Error("telemetry is read from loopback only");
    this.retry = options.retryMs?.length ? options.retryMs : RETRY_MS;
    this.connectTimeout = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  }

  get running(): boolean {
    return !this.stopped;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  /** Ends the open call at once, also while the game sends nothing (menus). Resolves when the loop has ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.session?.destroy();
    this.wake?.();
    await this.loop;
    this.loop = null;
    this.setState("stopped");
  }

  private setState(state: ReaderState, detail?: string): void {
    if (state === this.state && state !== "incompatible") return;
    this.state = state;
    this.handlers.onState(state, detail);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref();
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      let reached = false;
      try {
        reached = await this.once();
      } catch {
        // `once` reports through setState; nothing else can reach here.
      }
      if (this.stopped) break;
      attempt = reached ? 0 : attempt + 1;
      // First failure waits retry[0]; the delay grows with consecutive failures. A stream that was open and
      // dropped (the game went back to the menu) starts again from the shortest delay.
      await this.sleep(this.retry[Math.min(Math.max(attempt - 1, 0), this.retry.length - 1)]!);
    }
  }

  /** One connection. Resolves true when a stream was opened. */
  private once(): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let opened = false;
      let sawResponse = false;
      const framer = new MessageFramer();
      const session = http2.connect(`http://${this.endpoint.host}:${this.endpoint.port}`);
      this.session = session;
      session.unref(); // an idle connection must never keep the MCP process alive

      const finish = (state: ReaderState, detail?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        if (!this.stopped) this.setState(state, detail);
        if (!session.destroyed) session.destroy();
        resolve(opened);
      };
      const connectTimer = setTimeout(
        () => finish("waiting", "connection timed out"),
        this.connectTimeout,
      );
      connectTimer.unref();

      // Something answered on the port but does not speak HTTP/2 (an HTTP/1 server, noise): not "nobody there".
      // The stream error and the session error can arrive in either order, so both go through here.
      const fail = (error: NodeJS.ErrnoException, what: string) => {
        if (error.code === "ERR_HTTP2_ERROR" && !sawResponse) {
          finish(
            "incompatible",
            `port ${this.endpoint.port} did not speak HTTP/2 gRPC (${error.code})`,
          );
        } else {
          finish("waiting", error.code ?? what);
        }
      };
      session.on("error", (error: NodeJS.ErrnoException) => fail(error, "connection error"));
      session.on("close", () => finish("waiting", "connection closed"));
      session.on("goaway", () => finish("waiting", "the game closed the connection"));

      session.on("connect", () => {
        clearTimeout(connectTimer);
        // stop() may have destroyed the session between the connection and this event: asking a destroyed
        // session for a stream throws ERR_HTTP2_INVALID_SESSION, from an event handler, which nothing catches.
        if (settled || this.stopped || session.destroyed) return;
        let request: http2.ClientHttp2Stream;
        try {
          request = session.request(
            {
              ":method": "POST",
              ":path": SERVICE_PATH,
              "content-type": "application/grpc",
              te: "trailers",
            },
            { endStream: false },
          );
        } catch {
          finish("waiting", "the connection closed before the call");
          return;
        }
        // The empty TelemetryStreamRequest: no compression, zero length. The only bytes we ever send.
        request.end(Buffer.from([0, 0, 0, 0, 0]));

        request.on("response", (headers) => {
          sawResponse = true;
          const status = headers[":status"];
          const type = String(headers["content-type"] ?? "");
          if (status !== 200 || !type.startsWith("application/grpc")) {
            finish("incompatible", `unexpected HTTP answer (status ${String(status)})`);
            return;
          }
          const code = grpcStatus(headers); // "trailers-only": the call ended in the headers
          if (code !== undefined && code !== 0) {
            const name = INCOMPATIBLE_STATUS.get(code);
            finish(name ? "incompatible" : "waiting", `gRPC status ${name ?? code}`);
            return;
          }
          opened = true;
          this.setState("connected");
        });
        request.on("data", (chunk: Buffer) => {
          let messages: Buffer[];
          try {
            messages = framer.push(chunk);
          } catch (error) {
            finish("incompatible", error instanceof Error ? error.message : "bad framing");
            return;
          }
          for (const message of messages) {
            this.setState("live");
            try {
              this.handlers.onMessage(message);
            } catch {
              // one bad frame is not a lost stream; the service counts decode failures itself
            }
          }
        });
        request.on("trailers", (trailers) => {
          const code = grpcStatus(trailers);
          if (code !== undefined && code !== 0) {
            const name = INCOMPATIBLE_STATUS.get(code);
            finish(name ? "incompatible" : "waiting", `gRPC status ${name ?? code}`);
          }
        });
        request.on("error", (error: NodeJS.ErrnoException) => fail(error, "stream error"));
        request.on("close", () => finish("waiting", "the game closed the stream"));
      });
    });
  }
}
