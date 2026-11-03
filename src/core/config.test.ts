import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("uses the documented defaults", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      uexToken: undefined,
      uexBaseUrl: "https://api.uexcorp.uk/2.0",
      scwBaseUrl: "https://api.star-citizen.wiki/api/v2",
      sctBaseUrl: "https://starcitizen.tools",
      enabledTools: null,
      profiles: null,
    });
  });

  it("reads the token without ever putting it in a URL", () => {
    const config = loadConfig({ UEXTOKEN: "abc" });
    expect(config.uexToken).toBe("abc");
    expect(config.uexBaseUrl).not.toContain("abc");
  });

  it("parses SCMCP_TOOLS, ignoring spaces and empty entries", () => {
    const config = loadConfig({ SCMCP_TOOLS: " uex_get_commodities, ,sct_search," });
    expect([...(config.enabledTools ?? [])]).toEqual(["uex_get_commodities", "sct_search"]);
  });

  it("parses SCMCP_PROFILES, lower-casing and ignoring empty entries", () => {
    expect(loadConfig({ SCMCP_PROFILES: " Core, ,TRADE" }).profiles).toEqual(["core", "trade"]);
  });

  it("accepts a base URL override on another allowed host", () => {
    expect(loadConfig({ SCMCP_UEX_BASE_URL: "https://api.uexcorp.space/2.0" }).uexBaseUrl).toBe(
      "https://api.uexcorp.space/2.0",
    );
  });

  it.each([
    ["SCMCP_UEX_BASE_URL", "https://evil.example/2.0"],
    ["SCMCP_UEX_BASE_URL", "http://api.uexcorp.uk/2.0"],
    ["SCMCP_SCW_BASE_URL", "https://api.uexcorp.uk/2.0"],
    ["SCMCP_SCT_BASE_URL", "https://starcitizen.tools.evil.example"],
  ])("refuses %s=%s at startup", (name, value) => {
    expect(() => loadConfig({ [name]: value })).toThrow(new RegExp(name));
  });
});
