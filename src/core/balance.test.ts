import { describe, expect, it } from "vitest";
import { parseBalanceEnv, wantsBalance } from "./balance.js";

describe("Feature: who decides whether the aUEC amounts are shown", () => {
  it("Given nothing is said, Then the amounts are shown (the default)", () => {
    expect(wantsBalance(undefined)).toBe(true);
    expect(wantsBalance(undefined, { hiddenByDefault: false })).toBe(true);
  });

  it("Given the server starts hidden, Then a call that says nothing is hidden, and an explicit choice wins", () => {
    const hidden = { hiddenByDefault: true };
    expect(wantsBalance(undefined, hidden)).toBe(false);
    expect(wantsBalance(false, hidden)).toBe(false);
    expect(wantsBalance(true, hidden)).toBe(true);
  });

  it("Given include_balance false, Then the amounts are hidden whatever the server's start choice", () => {
    expect(wantsBalance(false)).toBe(false);
    expect(wantsBalance(false, { hiddenByDefault: false })).toBe(false);
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
});
