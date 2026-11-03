import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

// These tests attempt a connection on purpose: forget the attempts so that the suite-wide check does not fail them.
afterEach(() => {
  (globalThis as { __blockedNetworkAttempts?: string[] }).__blockedNetworkAttempts!.length = 0;
});

describe("Feature: the test suite refuses to reach the network", () => {
  it("Given a connection to a host that is not this machine, Then it fails at once and names the host", async () => {
    const error = await new Promise<Error>((resolve) => {
      const socket = net.connect(80, "example.com");
      socket.on("error", resolve);
      socket.on("connect", () => resolve(new Error("connected: the guard is not active")));
    });
    expect(error.message).toMatch(/tried to reach the network \(example\.com\)/);
  });

  it("Given an address that is not loopback, Then it is refused too", async () => {
    const error = await new Promise<Error>((resolve) => {
      const socket = net.connect({ host: "192.0.2.1", port: 9 });
      socket.on("error", resolve);
      socket.on("connect", () => resolve(new Error("connected: the guard is not active")));
    });
    expect(error.message).toMatch(/192\.0\.2\.1/);
  });

  it("Given a server on 127.0.0.1, Then a connection to it still works (the fake game relies on it)", async () => {
    const server = net.createServer((socket) => socket.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    const data = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      let received = "";
      socket.on("data", (d) => (received += d.toString()));
      socket.on("end", () => resolve(received));
      socket.on("error", reject);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(data).toBe("ok");
  });
});
