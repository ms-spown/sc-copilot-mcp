import type { BalancePolicy } from "../core/balance.js";

/**
 * The ways a caller can ask for the aUEC amounts, for tests that must run in every mode (the masking guards are kept,
 * and run in each mode that hides; the default is shown).
 *
 * `policy` is the server's start choice (SC_BALANCE), `args` what the caller passes on the tool call.
 */
export interface BalanceMode {
  label: string;
  policy: BalancePolicy | undefined;
  args: { include_balance?: boolean };
}

const HIDDEN_BY_ENV: BalancePolicy = { hiddenByDefault: true };

/** Every way the amounts end up hidden. Nothing derived from the balance may come out in any of them. */
export const HIDDEN_MODES: BalanceMode[] = [
  {
    label: "include_balance=false (shown by default)",
    policy: undefined,
    args: { include_balance: false },
  },
  { label: "SC_BALANCE=hidden, no argument", policy: HIDDEN_BY_ENV, args: {} },
  {
    label: "SC_BALANCE=hidden and include_balance=false",
    policy: HIDDEN_BY_ENV,
    args: { include_balance: false },
  },
];

/** Every way the amounts are shown. */
export const SHOWN_MODES: BalanceMode[] = [
  { label: "the default (no argument)", policy: undefined, args: {} },
  { label: "include_balance=true", policy: undefined, args: { include_balance: true } },
  {
    label: "include_balance=true under SC_BALANCE=hidden (explicit choice)",
    policy: HIDDEN_BY_ENV,
    args: { include_balance: true },
  },
];
