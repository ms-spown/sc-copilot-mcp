/**
 * TEST SUPPORT (also used by scripts/dashboard-preview.mjs): a made-up transport session for the ledger panel. The
 * log lines are invented (in the shapes the parser knows, with made-up mission ids and place names), they go through
 * the REAL parser and the REAL ledger code, so the payload has exactly the shape and the rules of production. No
 * real log, no real balance, no Node-only module: the browser imports it.
 *
 * It follows the story of scenario.ts (a loop of 120 s; the balance jumps from 250 000 to 434 500 at 90 s):
 *   2 s   "Urgent Parcel" accepted, abandoned at 12 s
 *  14 s   "Waste Disposal" accepted: a pickup and a drop-off; one objective done at 50 s, two at 88 s; completed at 90 s
 *  95 s   "Ore Delivery" accepted: two pickups and a drop-off; one objective done at 110 s (still running at 120 s)
 */
import { parseLog } from "../../providers/gamelog/parser.js";
import type { BalancePoint } from "../../providers/telemetry/service.js";
import {
  buildContracts,
  buildLedgerPayload,
  EMPTY_LEDGER,
  type LedgerBase,
  type LedgerPayload,
  type PlanForLedger,
} from "../ledger.js";

export const LEDGER_LOOP_SECONDS = 120;
const M_ABANDONED = "cccccccc-1111-2222-3333-444444444444";
const M_WASTE = "aaaaaaaa-1111-2222-3333-444444444444";
const M_ORE = "bbbbbbbb-1111-2222-3333-444444444444";

/** The invented Game.log lines of one loop that begins at `base` (epoch ms), as text. */
export function transportLogText(base: number): string {
  const at = (s: number) => `<${new Date(base + s * 1000).toISOString()}>`;
  const quoted = (s: number, text: string) => `${at(s)}    "${text}" [9]`;
  const added = (s: number, text: string, mission: string) =>
    `${at(s)} [Notice] <SHUDEvent_OnNotification> Added notification "${text}" [9] to queue. New queue size: 1, MissionId: [${mission}], ObjectiveId: [] [Team_X]`;
  const hauling = (s: number, kind: "Pick" | "Dropoff", mission: string, place: string) =>
    `${at(s)} [Notice] <CreateHaulingObjectiveHandler> ${kind} created - [Cient] sourcename: HaulCargo_Test_Waste_Stanton, missionId: ${mission}, locationName: Unknown [${place}], locationHash: 1`;
  const ended = (s: number, mission: string, state: string) =>
    `${at(s)} [Notice] <MissionEnded> Received MissionEnded push message for: mission_id ${mission} - mission_ MISSION_STATE_${state} [Team_X]`;
  const accepted = (s: number, title: string, mission: string) => [
    quoted(s, `Contract Accepted:  ${title}: `),
    added(s + 0.001, `Contract Accepted:  ${title}: `, mission),
  ];
  const objective = (s: number, text: string, mission: string) => [
    quoted(s, `New Objective: ${text}: `),
    added(s + 0.001, `New Objective: ${text}: `, mission),
  ];
  const done = (s: number, text: string, mission: string) => [
    quoted(s, `Objective Complete: ${text}: `),
    added(s + 0.001, `Objective Complete: ${text}: `, mission),
  ];
  return [
    ...accepted(2, "Urgent Parcel | Medium", M_ABANDONED),
    ended(12, M_ABANDONED, "ABANDONED"),
    ...accepted(14, "Waste Disposal | Easy", M_WASTE),
    ...objective(15, "Collect the cargo", M_WASTE),
    hauling(15.1, "Pick", M_WASTE, "Outpost_Test_One"),
    hauling(15.2, "Dropoff", M_WASTE, "Station_Test_Two"),
    ...done(50, "Collect the cargo", M_WASTE),
    ...done(88, "Deliver the cargo", M_WASTE),
    ...[
      quoted(90, "Contract Complete: Waste Disposal | Easy: "),
      added(90.001, "Contract Complete: Waste Disposal | Easy: ", M_WASTE),
    ],
    ended(90.5, M_WASTE, "COMPLETED"),
    ...accepted(95, "Ore Delivery | Hard", M_ORE),
    ...objective(96, "Collect the cargo", M_ORE),
    hauling(96.1, "Pick", M_ORE, "Outpost_Test_One"),
    hauling(96.2, "Pick", M_ORE, "Outpost_Test_Three"),
    hauling(96.3, "Dropoff", M_ORE, "Station_Test_Two"),
    ...done(110, "Collect the cargo", M_ORE),
  ].join("\n");
}

export type TransportVariant = "story" | "off" | "loading" | "unreadable" | "empty";

/**
 * What the ledger of `sc_live_poll` would hold at `nowMs` in the story that began at `epoch`. The balance history
 * is the one of scenario.ts (250 000 from 6 s, 434 500 from 90.25 s of the loop).
 */
export function transportLedger(
  nowMs: number,
  epoch: number,
  includeBalance: boolean,
  variant: TransportVariant = "story",
  plan?: PlanForLedger,
): LedgerPayload {
  const loop = Math.max(0, Math.floor((nowMs - epoch) / (LEDGER_LOOP_SECONDS * 1000)));
  const base = epoch + loop * LEDGER_LOOP_SECONDS * 1000;
  let ledgerBase: LedgerBase;
  if (variant === "off") ledgerBase = EMPTY_LEDGER;
  else if (variant === "loading") ledgerBase = { ...EMPTY_LEDGER, status: "loading" };
  else if (variant === "unreadable") ledgerBase = { ...EMPTY_LEDGER, status: "unreadable" };
  else if (variant === "empty") ledgerBase = { ...EMPTY_LEDGER, status: "ok", asOf: nowMs };
  else {
    const events = parseLog(transportLogText(base)).events.filter(
      (e) => e.time !== null && Date.parse(e.time) <= nowMs,
    );
    ledgerBase = { status: "ok", asOf: nowMs, partial: false, contracts: buildContracts(events) };
  }
  const history: BalancePoint[] = [];
  if (nowMs >= base + 6000) {
    history.push({ at: base + 6000, uec: 250_000, until: Math.min(nowMs, base + 90_000) });
  }
  if (nowMs >= base + 90_250) {
    history.push({ at: base + 90_250, uec: 434_500, until: nowMs });
  }
  return buildLedgerPayload({ base: ledgerBase, history, includeBalance, plan, nowMs });
}
