import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The player's choice about the aUEC balance and every figure derived from it.
 *
 * Amounts are SHOWN by default (the owner's decision: masking stays, as an opt-in for players who do not want to share
 * their amounts). Hiding is STICKY and protects the tools too:
 *   - `SC_BALANCE=hidden` in the server's entry (a choice made once, permanent): the dashboard starts hidden and the
 *     tools answer without amounts;
 *   - the dashboard's "Masquer le solde" click (a choice made now): the same, until the player clicks "Afficher le solde".
 *     It lives in the memory of THIS server process only (never a file): a restart forgets it, another client or another
 *     process has its own memory, and a click protects only the tools of the same process. Only `SC_BALANCE=hidden` covers
 *     every client durably. The last click wins between dashboards. A click on "Afficher le solde" lifts the mask for the
 *     running process, even over `SC_BALANCE=hidden`;
 *   - `include_balance: false` on one call hides that call's answer.
 * While the amounts are hidden, an explicit `include_balance: true` from the model is IGNORED (an instruction hidden in
 * a UEX name or a journal note must not be able to reveal them). While they are shown it is harmless, so a prompt
 * written for 2.5 keeps working.
 *
 * When the amounts are shown they reach the model and the conversation: that is the player's choice. The server itself
 * sends nothing over a network either way.
 */

/** What the player last clicked in the dashboard, or null when they have not (then the start choice applies). */
export type PlayerChoice = "hidden" | "shown";

/** The server's runtime choice. One object per process, shared by the tools and the dashboard resource. */
export interface BalancePolicy {
  /** SC_BALANCE=hidden: the start choice. */
  hiddenByDefault: boolean;
  /** The last explicit click of the player in a dashboard (memory only), or null/absent. */
  playerChoice?: PlayerChoice | null;
}

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

/** The one place the server's policy is made from its configuration (src/index.ts calls it; a test pins that). */
export function createBalancePolicy(config: { balanceHiddenByDefault: boolean }): BalancePolicy {
  return { hiddenByDefault: config.balanceHiddenByDefault, playerChoice: null };
}

/** Are the amounts hidden right now? The player's click wins over the start choice; absent policy means shown. */
export function balanceHidden(policy?: BalancePolicy): boolean {
  const choice = policy?.playerChoice ?? null;
  if (choice === "hidden") return true;
  if (choice === "shown") return false;
  return policy?.hiddenByDefault === true;
}

/**
 * Does this call show amounts? Hidden wins over everything the model says (`include_balance: true` is ignored);
 * otherwise `include_balance: false` hides this call and anything else shows. Every handler resolves it ONCE.
 */
export function wantsBalance(requested: boolean | undefined, policy?: BalancePolicy): boolean {
  if (balanceHidden(policy)) return false;
  return requested !== false;
}

/**
 * Said with every answer that left amounts out because the player's choice is HIDDEN (a click, or SC_BALANCE=hidden), so
 * the model neither guesses nor insists. The registry cuts every string of an untrusted answer at 200 characters: it
 * must stay under 190 (a test pins it, and that no hidden answer of any model tool contains "[truncated").
 */
export const HIDDEN_NOTE =
  "Montants masqués par le joueur : « Afficher le solde » dans le tableau de bord (ou retirer SC_BALANCE=hidden). Ne pas contourner ni redemander ; include_balance=true est ignoré.";

/** Said when only THIS call hid the amounts (the model passed include_balance false): nothing is ignored then. */
export const CALL_HIDDEN_NOTE = "Montants masqués pour cet appel (include_balance=false).";

/** The note for an answer without amounts: the player's choice when it is active, else this call's own. */
export function hiddenNote(policy?: BalancePolicy): string {
  return balanceHidden(policy) ? HIDDEN_NOTE : CALL_HIDDEN_NOTE;
}

/** Where the server's state comes from: a click of the player (memory) or the configuration (SC_BALANCE, or nothing). */
export function balanceSource(policy?: BalancePolicy): "click" | "config" {
  return (policy?.playerChoice ?? null) !== null ? "click" : "config";
}

let processToken: string | null = null;

/**
 * A random 128-bit token made when first asked (once per process), never logged and never written. The dashboard page
 * carries it in a `data-` attribute of the resource served by `resources/read`, and the View sends it back to lift the
 * mask ("shown") or to ask for the balance once: a caller that did not read the page cannot. This hardens the app-only
 * rule (a host that exposes `sc_live_poll` to the model would otherwise let it say `balance_choice: "shown"`); it does
 * not defeat a host that also lets the model read the HTML resource, which SECURITY.md states.
 */
export function balanceToken(): string {
  processToken ??= randomBytes(16).toString("hex");
  return processToken;
}

/** Is `given` the process token? Compared in constant time; anything but a string of the right length is refused. */
export function balanceTokenMatches(given: unknown): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(balanceToken());
  return a.length === b.length && timingSafeEqual(a, b);
}
