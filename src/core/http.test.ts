import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ALLOWED_HOSTS, assertAllowedUrl, createGuardedClient, resolveBaseUrl } from "./http.js";

/**
 * No external network: two loopback servers stand in for "the upstream" (reached as
 * 127.0.0.1) and "some other host" (reached as localhost, a different hostname).
 * `seen` records what each one actually received, which is the only thing that matters
 * for a credential leak.
 */
interface Seen {
  path: string;
  authorization: string | undefined;
}

function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

let upstream: { server: http.Server; port: number };
let other: { server: http.Server; port: number };
let upstreamSeen: Seen[] = [];
let otherSeen: Seen[] = [];

beforeAll(async () => {
  other = await listen((req, res) => {
    otherSeen.push({ path: req.url ?? "", authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: "other" }));
  });
  upstream = await listen((req, res) => {
    upstreamSeen.push({ path: req.url ?? "", authorization: req.headers.authorization });
    if (req.url === "/to-other-host") {
      res.writeHead(302, { location: `http://localhost:${other.port}/stolen` });
      res.end();
    } else if (req.url === "/to-same-host") {
      res.writeHead(302, { location: `http://127.0.0.1:${upstream.port}/landed` });
      res.end();
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: "upstream" }));
    }
  });
});

afterAll(() => {
  upstream.server.close();
  other.server.close();
});

beforeEach(() => {
  upstreamSeen = [];
  otherSeen = [];
});

function client(token?: string) {
  return createGuardedClient({
    baseURL: `http://127.0.0.1:${upstream.port}`,
    allowedHosts: ["127.0.0.1"],
    allowInsecureHttp: true,
    userAgent: "test",
    token,
  });
}

describe("createGuardedClient: credential handling", () => {
  it("sends the bearer token to the allowed host", async () => {
    await client("SECRET").get("/ok");
    expect(upstreamSeen).toEqual([{ path: "/ok", authorization: "Bearer SECRET" }]);
  });

  it("sends no Authorization header at all when there is no token", async () => {
    await client(undefined).get("/ok");
    await client("").get("/ok");
    expect(upstreamSeen.map((s) => s.authorization)).toEqual([undefined, undefined]);
  });

  it("does not follow a redirect to another host, so the token never reaches it", async () => {
    await expect(client("SECRET").get("/to-other-host")).rejects.toThrow(/not in the allowlist/);
    expect(otherSeen).toEqual([]);
  });

  it("refuses an absolute URL on another host before sending anything", async () => {
    await expect(client("SECRET").get(`http://localhost:${other.port}/direct`)).rejects.toThrow(
      /not in the allowlist/,
    );
    expect(otherSeen).toEqual([]);
  });

  it("follows a redirect that stays on the allowed host", async () => {
    const response = await client("SECRET").get("/to-same-host");
    expect(response.data).toEqual({ data: "upstream" });
    expect(upstreamSeen.map((s) => s.path)).toEqual(["/to-same-host", "/landed"]);
  });

  it("does not keep the token in the client's default headers", () => {
    const headers = JSON.stringify(client("SECRET").defaults.headers);
    expect(headers).not.toContain("SECRET");
  });
});

describe("assertAllowedUrl", () => {
  const policy = { allowedHosts: ["api.uexcorp.uk"] };

  it("accepts https on an allowed host, case-insensitively", () => {
    expect(() => assertAllowedUrl(new URL("https://API.UEXCORP.UK/2.0/x"), policy)).not.toThrow();
  });

  it.each([
    ["plain http", "http://api.uexcorp.uk/"],
    ["a lookalike suffix", "https://api.uexcorp.uk.evil.example/"],
    ["a lookalike prefix", "https://evil-api.uexcorp.uk/"],
    ["credentials that make evil.example the real host", "https://api.uexcorp.uk@evil.example/"],
    ["credentials on the real host", "https://user:pw@api.uexcorp.uk/"],
    ["another scheme", "ftp://api.uexcorp.uk/"],
  ])("rejects %s", (_label, url) => {
    expect(() => assertAllowedUrl(new URL(url), policy)).toThrow();
  });
});

describe("resolveBaseUrl", () => {
  const policy = { allowedHosts: ALLOWED_HOSTS.uex };

  it("uses the fallback when there is no override", () => {
    expect(resolveBaseUrl(undefined, "https://api.uexcorp.uk/2.0", policy)).toBe(
      "https://api.uexcorp.uk/2.0",
    );
    expect(resolveBaseUrl("  ", "https://api.uexcorp.uk/2.0/", policy)).toBe(
      "https://api.uexcorp.uk/2.0",
    );
  });

  it("accepts an override on another allowed host", () => {
    expect(
      resolveBaseUrl("https://api.uexcorp.space/2.0", "https://api.uexcorp.uk/2.0", policy),
    ).toBe("https://api.uexcorp.space/2.0");
  });

  it("rejects an override on a host outside the allowlist, naming the variable", () => {
    expect(() =>
      resolveBaseUrl(
        "https://evil.example/2.0",
        "https://api.uexcorp.uk/2.0",
        policy,
        "SCMCP_UEX_BASE_URL",
      ),
    ).toThrow(/SCMCP_UEX_BASE_URL.*not in the allowlist/);
  });

  it("rejects text that is not a URL", () => {
    expect(() => resolveBaseUrl("not a url", "https://api.uexcorp.uk/2.0", policy, "X")).toThrow(
      /not a valid URL/,
    );
  });
});
