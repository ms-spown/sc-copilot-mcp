import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  balanceHidden,
  createBalancePolicy,
  HIDDEN_NOTE,
  parseBalanceEnv,
  wantsBalance,
  type BalancePolicy,
} from "./balance.js";
import { loadConfig } from "./config.js";

describe("Feature: who decides whether the aUEC amounts are shown", () => {
  it("Given nothing is said, Then the amounts are shown (the default)", () => {
    expect(wantsBalance(undefined)).toBe(true);
    expect(wantsBalance(undefined, { hiddenByDefault: false })).toBe(true);
    expect(wantsBalance(true, { hiddenByDefault: false, playerChoice: null })).toBe(true);
  });

  it("Given include_balance false, Then that call is hidden whatever the start choice", () => {
    expect(wantsBalance(false)).toBe(false);
    expect(wantsBalance(false, { hiddenByDefault: false })).toBe(false);
  });

  it("Given the server starts hidden, Then a call that says nothing is hidden AND include_balance true is ignored", () => {
    const hidden: BalancePolicy = { hiddenByDefault: true, playerChoice: null };
    expect(balanceHidden(hidden)).toBe(true);
    expect(wantsBalance(undefined, hidden)).toBe(false);
    expect(wantsBalance(false, hidden)).toBe(false);
    expect(wantsBalance(true, hidden)).toBe(false);
  });

  it("Given the player clicked Masquer, Then it is hidden the same way, until a click on Afficher", () => {
    const policy: BalancePolicy = { hiddenByDefault: false, playerChoice: "hidden" };
    expect(wantsBalance(undefined, policy)).toBe(false);
    expect(wantsBalance(true, policy)).toBe(false);
    policy.playerChoice = "shown";
    expect(wantsBalance(undefined, policy)).toBe(true);
    expect(wantsBalance(true, policy)).toBe(true);
    expect(wantsBalance(false, policy)).toBe(false);
  });

  it("Given SC_BALANCE=hidden and a click on Afficher, Then the click lifts the mask for the running process", () => {
    const policy: BalancePolicy = { hiddenByDefault: true, playerChoice: "shown" };
    expect(balanceHidden(policy)).toBe(false);
    expect(wantsBalance(undefined, policy)).toBe(true);
  });

  it("Given SC_BALANCE, Then unset or 'shown' shows, 'hidden' hides, and a typo hides and is reported", () => {
    expect(parseBalanceEnv(undefined)).toEqual({ hiddenByDefault: false, unrecognised: false });
    expect(parseBalanceEnv("")).toEqual({ hiddenByDefault: false, unrecognised: false });
    expect(parseBalanceEnv("shown")).toEqual({ hiddenByDefault: false, unrecognised: false });
    expect(parseBalanceEnv("hidden")).toEqual({ hiddenByDefault: true, unrecognised: false });
    expect(parseBalanceEnv(" HIDDEN ")).toEqual({ hiddenByDefault: true, unrecognised: false });
    expect(parseBalanceEnv("hiden")).toEqual({ hiddenByDefault: true, unrecognised: true });
    expect(parseBalanceEnv("maybe")).toEqual({ hiddenByDefault: true, unrecognised: true });
  });

  it("Given the note said with every hidden answer, Then it tells the model not to work around it and where the player lifts it", () => {
    expect(HIDDEN_NOTE).toContain("Montants masqués par le joueur");
    expect(HIDDEN_NOTE).toContain("Afficher le solde");
    expect(HIDDEN_NOTE).toContain("SC_BALANCE=hidden");
    // The registry cuts every string of an untrusted answer at 200 characters: the note must survive whole.
    expect(HIDDEN_NOTE.length).toBeLessThanOrEqual(190);
    expect(HIDDEN_NOTE).toContain("include_balance=true est ignoré");
  });
});

describe("Feature: SC_BALANCE reaches the server (src/index.ts is the wiring; a lost line must fail here)", () => {
  it("Given the environment, Then the policy is made from the configuration the entry point loads", () => {
    expect(createBalancePolicy(loadConfig({ SC_BALANCE: "hidden" }))).toEqual({
      hiddenByDefault: true,
      playerChoice: null,
    });
    expect(createBalancePolicy(loadConfig({}))).toEqual({
      hiddenByDefault: false,
      playerChoice: null,
    });
    // a typo fails toward privacy, all the way to the policy
    expect(createBalancePolicy(loadConfig({ SC_BALANCE: "hiden" })).hiddenByDefault).toBe(true);
  });

  it("Given src/index.ts, Then it loads the config, builds the policy from it, hands it to the tools and the dashboard, and says an unknown value", () => {
    const entry = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(entry).toMatch(/import \{ createBalancePolicy \} from "\.\/core\/balance\.js"/);
    expect(entry).toMatch(/const config = loadConfig\(\)/);
    // the same object, in the clients every tool factory and the dashboard resource receive
    expect(entry).toMatch(
      /const clients = \{[\s\S]*?balance: createBalancePolicy\(config\),[\s\S]*?\};/,
    );
    expect(entry).toMatch(/allTools\(clients,/);
    expect(entry).toMatch(/allResources\(clients\)/);
    expect(entry).toMatch(/config\.balanceEnvUnrecognised/);
  });
});
