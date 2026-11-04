import type { BalancePolicy } from "../core/balance.js";

/**
 * The ways a caller can ask for the aUEC amounts, for tests that must run in every mode (the masking guards are kept,
 * and run in each mode that hides; the default is shown).
 *
 * `policy` is the server's runtime choice (SC_BALANCE, and the player's click in the dashboard, held in memory), `args`
 * what the caller passes on the tool call. `policy` is a getter: every use gets a FRESH object, because a click in a test
 * mutates it.
 */
export interface BalanceMode {
  label: string;
  readonly policy: BalancePolicy | undefined;
  args: { include_balance?: boolean };
}

/** Every way the amounts end up hidden. Nothing derived from the balance may come out in any of them. */
export const HIDDEN_MODES: BalanceMode[] = [
  {
    label: "include_balance=false (shown by default)",
    policy: undefined,
    args: { include_balance: false },
  },
  {
    label: "SC_BALANCE=hidden, no argument",
    get policy() {
      return { hiddenByDefault: true, playerChoice: null };
    },
    args: {},
  },
  {
    label: "SC_BALANCE=hidden and include_balance=false",
    get policy() {
      return { hiddenByDefault: true, playerChoice: null };
    },
    args: { include_balance: false },
  },
  {
    label: "SC_BALANCE=hidden and include_balance=true (ignored)",
    get policy() {
      return { hiddenByDefault: true, playerChoice: null };
    },
    args: { include_balance: true },
  },
  {
    label: "the player clicked Masquer, no argument",
    get policy() {
      return { hiddenByDefault: false, playerChoice: "hidden" as const };
    },
    args: {},
  },
  {
    label: "the player clicked Masquer and include_balance=true (ignored)",
    get policy() {
      return { hiddenByDefault: false, playerChoice: "hidden" as const };
    },
    args: { include_balance: true },
  },
];

/** Every way the amounts are shown. */
export const SHOWN_MODES: BalanceMode[] = [
  { label: "the default (no argument)", policy: undefined, args: {} },
  { label: "include_balance=true", policy: undefined, args: { include_balance: true } },
  {
    label: "the player clicked Afficher under SC_BALANCE=hidden, no argument",
    get policy() {
      return { hiddenByDefault: true, playerChoice: "shown" as const };
    },
    args: {},
  },
  {
    label: "the player clicked Afficher under SC_BALANCE=hidden and include_balance=true",
    get policy() {
      return { hiddenByDefault: true, playerChoice: "shown" as const };
    },
    args: { include_balance: true },
  },
];
