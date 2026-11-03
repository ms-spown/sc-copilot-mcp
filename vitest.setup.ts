// Tests never use the network (CLAUDE.md). This makes it a rule the suite enforces: any socket opened to a host that
// is not this machine fails at once, with a message that names the host, instead of reaching a real server (slow,
// flaky on a loaded CI, and a test that depends on a service we do not control).
//
// Loopback is allowed: the fake game of the telemetry tests and the preview servers listen on 127.0.0.1.
import net from "node:net";
import { afterEach } from "vitest";

const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", ""]);

type ConnectArgs = unknown[];

/** The host a net.Socket.connect call is aimed at, or null for a local pipe. */
function targetHost(args: ConnectArgs): string | null {
  // net.connect() hands socket.connect() ONE argument: the already normalised array [options, callback].
  const first = Array.isArray(args[0]) ? (args[0] as ConnectArgs)[0] : args[0];
  if (Array.isArray(args[0])) args = args[0] as ConnectArgs;
  if (typeof first === "object" && first !== null) {
    const o = first as { host?: string; path?: string };
    if (o.path) return null; // a named pipe or unix socket: local
    return o.host ?? "localhost";
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return typeof args[1] === "string" ? args[1] : "localhost";
  }
  return null; // a path
}

/** Hosts a test tried to reach. Checked after every test: an attempt fails the test even if the code swallowed it. */
const blocked: string[] = [];
(globalThis as { __blockedNetworkAttempts?: string[] }).__blockedNetworkAttempts = blocked;

afterEach(() => {
  if (blocked.length > 0) {
    const hosts = [...new Set(blocked)].join(", ");
    blocked.length = 0;
    throw new Error(
      `This test tried to reach the network (${hosts}). Tests use fake clients and temporary folders only.`,
    );
  }
});

const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patched(this: net.Socket, ...args: ConnectArgs) {
  const host = targetHost(args);
  if (host !== null && !LOCAL.has(host.toLowerCase())) {
    blocked.push(host);
    const error = new Error(
      `A test tried to reach the network (${host}). Tests use fake clients and temporary folders only.`,
    );
    queueMicrotask(() => this.destroy(error));
    return this;
  }
  return (original as (...a: ConnectArgs) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;
