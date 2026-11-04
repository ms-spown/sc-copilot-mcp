import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { dashboardHtml } from "./page.js";
import { extractElement } from "./testing/pageHarness.js";

describe("Feature: the page carries the server's balance choice and token as attributes of its root", () => {
  const root = (html: string) => /<div id="app"[^>]*>/.exec(html)![0];

  it("Given no option, Then the page starts shown and carries no token", () => {
    const tag = root(dashboardHtml());
    expect(tag).toContain('data-balance="shown"');
    expect(tag).not.toContain("data-token");
  });

  it("Given SC_BALANCE=hidden and a token, Then the root says hidden and carries exactly that token, and the script does not contain it", () => {
    const token = randomBytes(16).toString("hex");
    const html = dashboardHtml({ balanceHidden: true, token });
    expect(root(html)).toContain('data-balance="hidden"');
    expect(root(html)).toContain(`data-token="${token}"`);
    expect(extractElement(html, "script")).not.toContain(token);
  });
});
