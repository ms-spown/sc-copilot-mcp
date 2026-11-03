import net from "node:net";
import { describe, expect, it } from "vitest";
import { WindowsUserEnvStore } from "./envStore.js";
import { probeLoopbackPort } from "./portProbe.js";

/** The real store is exercised through a fake PowerShell runner: no process is started, nothing is set. */
describe("WindowsUserEnvStore", () => {
  function fake(output = "") {
    const runs: { script: string; env: Record<string, string> }[] = [];
    const store = new WindowsUserEnvStore(async (script, env) => {
      runs.push({ script, env });
      return output;
    });
    return { store, runs };
  }

  it("sets the User-scope variable with SetEnvironmentVariable, passing name and value outside the script", async () => {
    const { store, runs } = fake();
    await store.set("GRPC_CLIENT_SERVER_ENABLED", "true");
    expect(runs).toHaveLength(1);
    expect(runs[0].script).toContain("[Environment]::SetEnvironmentVariable");
    expect(runs[0].script).toContain("'User'");
    expect(runs[0].script).not.toMatch(/setx|reg\s|HKCU/i);
    expect(runs[0].script).not.toContain("GRPC_CLIENT_SERVER_ENABLED");
    expect(runs[0].env).toEqual({ SCT_NAME: "GRPC_CLIENT_SERVER_ENABLED", SCT_VALUE: "true" });
  });

  it("removes by setting null in User scope", async () => {
    const { store, runs } = fake();
    await store.remove("GRPC_CLIENT_SERVER_ENABLED");
    expect(runs[0].script).toContain("$null, 'User'");
  });

  it("reads the persistent User value and tells absent from set", async () => {
    expect(await fake("<ABSENT>").store.get("X")).toBeNull();
    expect(await fake("SET:true\r\n").store.get("X")).toBe("true");
    expect(await fake("SET:").store.get("X")).toBe("");
    await expect(fake("garbage").store.get("X")).rejects.toThrow(/unexpected/);
  });

  it("refuses names and values that are not plain", async () => {
    const { store, runs } = fake();
    await expect(store.set("A; rm -rf", "true")).rejects.toThrow();
    await expect(store.set("A", "x'; Remove-Item *")).rejects.toThrow();
    await expect(store.get("a b")).rejects.toThrow();
    expect(runs).toEqual([]);
  });
});

describe("probeLoopbackPort", () => {
  it("says open for a listening loopback port and closed after it is shut", async () => {
    const server = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    expect(await probeLoopbackPort(port)).toBe("open");
    await new Promise((r) => server.close(r));
    expect(await probeLoopbackPort(port)).toBe("closed");
  });
});
