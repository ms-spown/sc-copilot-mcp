/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TEST SUPPORT (end-to-end replay): what a scenario checks at every step, and how.
 *
 * PRIVACY. A figure that comes from the aUEC balance (a balance, a net, a fee, what the margin leaves unexplained, a
 * ratio of the calibration) is shown by default, and reaches nobody when the player hid it: `include_balance: false`, or
 * the server started with SC_BALANCE=hidden and the caller said nothing. The sweeps below call every output the model or
 * the other Views can read, in BOTH hiding modes, and return what they said as text, so a scenario asserts that none of
 * its figures is there. A check that finds nothing proves nothing unless the same figure IS in
 * the output that has the balance: `expectPresent` is the positive control and every scenario uses it.
 *
 * Figures are matched as whole numbers (`(?<![0-9])N(?![0-9])`): the digits of an epoch time are not a balance.
 */
import { expect } from "vitest";
import { ledgerStripBalance } from "../../dashboard/ledgerPanel.js";
import { sessionBarStripBalance } from "../../dashboard/sessionPanel.js";
import { sharablePoll } from "../../dashboard/viewLogic.js";
import type { ReplayWorld } from "./world.js";

export const figure = (n: number): RegExp => new RegExp(`(?<![0-9])${Math.abs(n)}(?![0-9])`);

/** The tools the model can call that read the live game or the saved sessions (the arguments carry no `include_balance`). */
const MODEL_TOOLS: [string, Record<string, unknown>][] = [
  ["sc_session_current", {}],
  ["sc_session_list", {}],
  ["sc_session_stats", {}],
  // The shareable report, in both formats: without the balance it must carry none of what comes from it.
  ["sc_session_debrief", {}],
  ["sc_session_debrief", { format: "csv" }],
  ["sc_live_state", {}],
  ["sc_live_events", {}],
  ["sc_live_status", {}],
  // The journal reads the game log (its amounts follow the same choice).
  ["sc_trade_journal", { resolve_names: false }],
];

export interface Sweep {
  /** The dashboard View's poll, asked without the balance (the structured content). */
  poll: string;
  /** Every model tool above, text and structured copy. */
  tools: string;
  /** The poll as the other Views would receive it from this one (a View that shows the balance strips it first). */
  channel: string;
  /** Everything, joined. */
  all: string;
}

/** The poll of a View that DID ask for the balance, as it may travel on the channel between Views. */
export function channelOf(poll: any): any {
  return {
    ...sharablePoll(poll),
    ledger: ledgerStripBalance(poll.ledger),
    sessions: sessionBarStripBalance(poll.sessions),
  };
}

/**
 * Calls everything that may be read with the amounts hidden and returns it as text. Two ways of hiding, both swept:
 * `include_balance: false` on a server that shows by default, then a server that starts hidden (SC_BALANCE=hidden)
 * with no argument at all. The policy is put back whatever happens.
 */
export async function sweepWithoutBalance(world: ReplayWorld): Promise<Sweep> {
  const poll = JSON.stringify(await world.poll(false));
  const parts: string[] = [];
  for (const [name, args] of MODEL_TOOLS) {
    const r = await world.call(name, { ...args, include_balance: false });
    parts.push(r.text, JSON.stringify(r.structured ?? null));
  }
  const policy = world.balancePolicy;
  const was = { ...policy };
  // Two more ways to hide, each swept with no argument AND with an explicit include_balance true (which is IGNORED
  // while the amounts are hidden: an instruction hidden in a UEX name must not be able to reveal them):
  //   - a server that starts hidden (SC_BALANCE=hidden);
  //   - the player's click on "Masquer le solde" (memory only), on a server that shows by default.
  const hiddenStates: [boolean, "hidden" | null][] = [
    [true, null],
    [false, "hidden"],
  ];
  try {
    for (const [hiddenByDefault, playerChoice] of hiddenStates) {
      policy.hiddenByDefault = hiddenByDefault;
      policy.playerChoice = playerChoice;
      // A View says nothing, or asks for the balance: the answer is the same.
      for (const pollArgs of [{}, { include_balance: true }]) {
        const poll = await world.call("sc_live_poll", pollArgs);
        parts.push(JSON.stringify(poll.structured ?? null));
      }
      for (const [name, args] of MODEL_TOOLS) {
        for (const extra of [{}, { include_balance: true }]) {
          const r = await world.call(name, { ...args, ...extra });
          parts.push(r.text, JSON.stringify(r.structured ?? null));
        }
      }
    }
  } finally {
    policy.hiddenByDefault = was.hiddenByDefault;
    policy.playerChoice = was.playerChoice;
  }
  // The View that shows the balance still shares nothing derived from it.
  const channel = JSON.stringify(channelOf(await world.poll(true)));
  const tools = parts.join("\n");
  expectNoBalanceLabels(poll, "the poll without the balance");
  expectNoBalanceLabels(tools, "the tools without the balance");
  // The registry cuts every string of an untrusted answer at 200 characters: a hidden answer must say its whole note.
  expect(tools, "a hidden answer was truncated by the registry").not.toContain("[truncated");
  expectNoBalanceLabels(channel, "the channel between Views");
  return { poll, tools, channel, all: [poll, tools, channel].join("\n") };
}

/** The same tools, with the balance: the positive control (asked explicitly, then by default, which shows it too). */
export async function sweepWithBalance(world: ReplayWorld): Promise<string> {
  const parts: string[] = [JSON.stringify(await world.poll(true))];
  // The positive control must stay positive after a click on "Afficher le solde", even on a server that starts hidden.
  const policy = world.balancePolicy;
  const was = { ...policy };
  policy.hiddenByDefault = true;
  policy.playerChoice = "shown";
  try {
    for (const [name, args] of MODEL_TOOLS) {
      const r = await world.call(name, args);
      parts.push(r.text, JSON.stringify(r.structured ?? null));
    }
  } finally {
    policy.hiddenByDefault = was.hiddenByDefault;
    policy.playerChoice = was.playerChoice;
  }
  for (const [name, args] of MODEL_TOOLS) {
    const r = await world.call(name, { ...args, include_balance: true });
    parts.push(r.text, JSON.stringify(r.structured ?? null));
    const d = await world.call(name, args);
    parts.push(d.text, JSON.stringify(d.structured ?? null));
  }
  return parts.join("\n");
}

/**
 * What the balance did, said in words and not in numbers: how the fees were obtained, why a net is doubtful, a
 * contract's gain, the movements, the calibration. A figure scan cannot see these (a label such as "estime" says the stream
 * was cut around the sales, "solde_autre_raison" that the balance moved for another reason), so they are looked for by name.
 * Every sweep without the balance checks them.
 */
export const BALANCE_LABELS = new RegExp(
  [
    '"fees_method"\\s*:\\s*"(?:mesure|estime)"',
    '"net_doubtful"\\s*:\\s*(?:true|false)',
    '"net_kind"\\s*:\\s*"',
    '"figures_from_before"\\s*:\\s*true',
    '"unexplained_auec"\\s*:\\s*-?\\d',
    "solde_autre_raison|lignes_non_confirmees|stock_anterieur|solde_avant_inconnu|solde_apres_inconnu",
    '"(?:plan_compare|movements|decomposition|calibration|gain|uec_session)"',
    '"money"\\s*:\\s*\\{',
    '"balance"\\s*:\\s*\\{',
    '"uec_balance"\\s*:\\s*\\d',
    "probable_contract_reward|fee_on_transaction|mesure_brute",
  ].join("|"),
);

export function expectNoBalanceLabels(text: string, where: string): void {
  const hit = BALANCE_LABELS.exec(text);
  const around = hit ? text.slice(Math.max(0, hit.index - 60), hit.index + 60) : "";
  expect(hit, `a label that comes from the balance is in ${where}: ...${around}...`).toBeNull();
}

export function expectAbsent(text: string, figures: readonly number[], where: string): void {
  for (const n of figures) {
    const hit = figure(n).exec(text);
    const around = hit ? text.slice(Math.max(0, hit.index - 80), hit.index + 40) : "";
    expect(hit, `${n} must not appear in ${where}: ...${around}...`).toBeNull();
  }
}

export function expectPresent(text: string, figures: readonly number[], where: string): void {
  for (const n of figures) {
    expect(figure(n).test(text), `${n} must appear in ${where} (positive control)`).toBe(true);
  }
}

/**
 * Characters that must never come out of the server: control characters, the zero-width and direction-changing ones.
 * `JSON.stringify` writes them as `\u00XX` escapes, so the escapes are looked for as well as the characters.
 */
// The pattern is written with escapes only (the repository refuses invisible characters in its own files).
export const INVISIBLE = new RegExp(
  [
    "[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\ufeff]",
    // the same characters as JSON.stringify writes them
    "\\\\u00(?:[01][0-9a-f]|7f|[89][0-9a-f])",
    "\\\\u(?:200[b-f]|202[a-e]|206[0-4]|feff)",
  ].join("|"),
  "i",
);
