/**
 * The player's choice about the aUEC balance and every figure derived from it.
 *
 * Since 2.6 the amounts are SHOWN by default (the owner's decision: masking stays, as an opt-in for players who do not
 * want to share their amounts). Two things hide them:
 *   - `include_balance: false` on a tool call, or the dashboard's "Masquer le solde" toggle (a choice made now);
 *   - `SC_BALANCE=hidden` in the server's entry (a choice made once): the dashboard starts hidden and a tool call that
 *     does not say otherwise is answered without amounts. An explicit `include_balance: true` still shows them: it is
 *     the old consent path (a prompt written for 2.5 keeps working) and the dashboard's own "Afficher le solde".
 *
 * When the amounts are shown they reach the model and the conversation: that is the player's choice. The server itself
 * sends nothing over a network either way.
 */

/**
 * Reads SC_BALANCE. Only an explicit "shown" value (or nothing) shows the amounts by default; "hidden" hides them.
 * Anything else is a typo, and a typo must fail toward privacy: hidden, with `unrecognised` set so the caller can say it.
 */
export function parseBalanceEnv(raw: string | undefined): {
  hiddenByDefault: boolean;
  unrecognised: boolean;
} {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || /^(shown|show|visible|on|1|true|yes)$/.test(v)) {
    return { hiddenByDefault: false, unrecognised: false };
  }
  if (/^(hidden|hide|masked|mask|off|0|false|no)$/.test(v)) {
    return { hiddenByDefault: true, unrecognised: false };
  }
  return { hiddenByDefault: true, unrecognised: true };
}

/** What a tool hands the resolver: the server's start choice. Absent means the shipped default (shown). */
export interface BalancePolicy {
  hiddenByDefault: boolean;
}

/** The shipped default. */
export const BALANCE_SHOWN: BalancePolicy = { hiddenByDefault: false };

/**
 * Does this call show amounts? `requested` is the tool's `include_balance`: true and false are the caller's explicit
 * choice; absent follows the server's start choice. Every handler resolves it ONCE and passes the boolean on.
 */
export function wantsBalance(requested: boolean | undefined, policy?: BalancePolicy): boolean {
  if (requested !== undefined) return requested;
  return !(policy?.hiddenByDefault === true);
}
