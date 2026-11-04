/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TEST SUPPORT (end-to-end replay): what a scenario checks at every step, and how.
 *
 * PRIVACY. A figure that comes from the aUEC balance (a balance, a net, a fee, what the margin leaves unexplained, a
 * ratio of the calibration) reaches the model only when the player agreed (`include_balance`). The sweeps below call every
 * output the model or the other Views can read, WITHOUT the balance, and return what they said as text, so a scenario
 * asserts that none of its figures is there. A check that finds nothing proves nothing unless the same figure IS in
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

/** The tools the model can call that read the live game or the saved sessions, with no `include_balance`. */
const MODEL_TOOLS: [string, Record<string, unknown>][] = [
  ["sc_session_current", {}],
  ["sc_session_list", {}],
  ["sc_session_stats", {}],
  ["sc_live_state", {}],
  ["sc_live_events", {}],
  ["sc_live_status", {}],
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

/** Calls everything that may be read without the balance and returns it as text. */
export async function sweepWithoutBalance(world: ReplayWorld): Promise<Sweep> {
  const poll = JSON.stringify(await world.poll(false));
  const parts: string[] = [];
  for (const [name, args] of MODEL_TOOLS) {
    const r = await world.call(name, args);
    parts.push(r.text, JSON.stringify(r.structured ?? null));
  }
  // The View that shows the balance still shares nothing derived from it.
  const channel = JSON.stringify(channelOf(await world.poll(true)));
  const tools = parts.join("\n");
  expectNoBalanceLabels(poll, "the poll without the balance");
  expectNoBalanceLabels(tools, "the tools without the balance");
  expectNoBalanceLabels(channel, "the channel between Views");
  return { poll, tools, channel, all: [poll, tools, channel].join("\n") };
}

/** The same tools, with the balance: the positive control. */
export async function sweepWithBalance(world: ReplayWorld): Promise<string> {
  const parts: string[] = [JSON.stringify(await world.poll(true))];
  for (const [name, args] of MODEL_TOOLS) {
    const r = await world.call(name, { ...args, include_balance: true });
    parts.push(r.text, JSON.stringify(r.structured ?? null));
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
