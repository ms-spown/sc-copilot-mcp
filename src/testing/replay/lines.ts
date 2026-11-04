/**
 * TEST SUPPORT (end-to-end replay): invented Game.log lines, in the shapes the real parser knows. Every identifier is
 * made up (commodity GUIDs, mission ids, shop names, the handle). Nothing here comes from a real log.
 *
 * Times are epoch milliseconds, written as the log writes them (`<2026-11-04T18:00:20.000Z>`).
 */
import {
  AGRICIUM_GUID,
  cargoBuyLine,
  cargoErrorLine,
  cargoSellLine,
  LARANITE_GUID,
} from "../../dashboard/testing/tradeScenario.js";
import { REGISTERED_LINE } from "../../providers/telemetry/gamelogHint.js";

export { AGRICIUM_GUID, LARANITE_GUID };

/** A made-up player handle, written by the game on a few lines. It must never come back out of the server. */
export const HANDLE = "FakePilotQrs";

const stamp = (ms: number) => `<${new Date(ms).toISOString()}>`;

/** The head of a Game.log of a LIVE session (version, channel, build, the telemetry registration line). */
export function headerLines(ms: number, opts: { registered?: boolean } = {}): string[] {
  return [
    `${stamp(ms)} Log started on Wed Nov  4 19:00:00 2026`,
    `${stamp(ms)} FileVersion: 4.10.197.2878`,
    `${stamp(ms)} [Trace] Environment: pub`,
    `${stamp(ms)} [Trace] @env_session: 'pub-sc-alpha-4101-12913470'`,
    ...(opts.registered === false
      ? []
      : [`${stamp(ms)} [Notice] <ServiceRegistry> ${REGISTERED_LINE} [Team_Core]`]),
    `${stamp(ms)} [Notice] <LoginCompleted> Login complete [Team_X]`,
  ];
}

/** What the game writes all the time: a line with a time, so the log's last time keeps moving. */
export const fillerLine = (ms: number) => `${stamp(ms)} [Trace] <FrameTick> Tick [Team_Core]`;

// --- commerce -------------------------------------------------------------------------------------------------

/** A cargo purchase (quantity in SCU here; the game writes cSCU, the builder converts). */
export const buyLine = (ms: number, price: number, scu: number, guid = LARANITE_GUID) =>
  cargoBuyLine(ms, 0, price, scu, guid);
export const sellLine = (ms: number, amount: number, scu: number, guid = LARANITE_GUID) =>
  cargoSellLine(ms, 0, amount, scu, guid);
/** The line the game logs when a cargo transaction fails (it logs only failures). */
export const errorLine = (ms: number) => cargoErrorLine(ms, 0);

// --- connection ------------------------------------------------------------------------------------------------

/** Joining a universe server (a hand-made address in a documentation range). */
export function joinLines(ms: number): string[] {
  return [
    `${stamp(ms)} [Notice] <Join PU> address[203.0.113.9] port[64315] shard[pub_test_1] locationId[1] [Team_GameServices]`,
    `${stamp(ms + 80)} [Notice] <CDisciplineServiceExternal::BeginSession> Beginning session [Team_GameSec][AntiCheat][EAC]`,
  ];
}

/** The server cut the player for inactivity (cause 30028) and ended the session. The handle appears, as in a real log. */
export function kickLines(ms: number): string[] {
  return [
    `${stamp(ms)} [Notice] <Channel Disconnected> cause=30028 reason="Remote Disconnect - player inactive" frame=403825 isRemote=1 viewState=eCVS_InGame map="megamap" gamerules="SC_Default" hostType="Replicant" remoteAddr=203.0.113.9:64385`,
    `${stamp(ms + 13)} [Notice] <Error Popup Opened> errorCode=30028 [Team_UI][Disconnection]`,
    `${stamp(ms + 29)} [Notice] <CDisciplineServiceExternal::EndSession> Ending session [Team_GameSec][AntiCheat][EAC]`,
    `${stamp(ms + 37)} [Notice] <Expect Incoming Connection> session=abc nickname="${HANDLE}" playerGEID=1 [Team_Network]`,
  ];
}

/** The game writes its quit line (a clean exit). */
export const quitLine = (ms: number) => `${stamp(ms)} [Notice] <SystemQuit> CSystem::Quit invoked exitCode=0 [Team_Core]`;

/** Lines that carry the handle, as real logs do (location request, lobby, ship channel). */
export function handleLines(ms: number): string[] {
  return [
    `${stamp(ms)} [Notice] <RequestLocationInventory> Player[${HANDLE}] Location[Stanton1_Lorville] [Team_Core]`,
    `${stamp(ms + 1)} [Notice] <[EALobby] EALobbyQuit> [EALobby][CEALobby::RequestQuitLobby] ${HANDLE} Requesting QuitLobby [Team_CGP5]`,
    `${stamp(ms + 2)}    "You have joined channel 'DRAK Cutter : ${HANDLE}'" [9]`,
  ];
}

// --- contracts ---------------------------------------------------------------------------------------------------

const quoted = (ms: number, text: string) => `${stamp(ms)}    "${text}" [9]`;
const added = (ms: number, text: string, mission: string) =>
  `${stamp(ms)} [Notice] <SHUDEvent_OnNotification> Added notification "${text}" [9] to queue. New queue size: 1, MissionId: [${mission}], ObjectiveId: [] [Team_X]`;

export const contractAccepted = (ms: number, title: string, mission: string): string[] => [
  quoted(ms, `Contract Accepted:  ${title}: `),
  added(ms + 1, `Contract Accepted:  ${title}: `, mission),
];

/** One pick-up and one drop-off of a hauling contract (the handler repeats them in a real log; once is enough here). */
export const haulingSteps = (ms: number, mission: string, pick: string, drop: string): string[] => [
  `${stamp(ms)} [Notice] <CreateHaulingObjectiveHandler> Pick created - [Cient] sourcename: HaulCargo_Test_Waste_Stanton, missionId: ${mission}, locationName: Unknown [${pick}], locationHash: 1`,
  `${stamp(ms + 1)} [Notice] <CreateHaulingObjectiveHandler> Dropoff created - [Cient] sourcename: HaulCargo_Test_Waste_Stanton, missionId: ${mission}, locationName: Unknown [${drop}], locationHash: 1`,
];

/** The completion notice and the engine's own end line (they arrive up to a few seconds apart in a real log). */
export const contractCompleted = (ms: number, title: string, mission: string): string[] => [
  quoted(ms, `Contract Complete: ${title}: `),
  added(ms + 1, `Contract Complete: ${title}: `, mission),
  `${stamp(ms + 500)} [Notice] <MissionEnded> Received MissionEnded push message for: mission_id ${mission} - mission_ MISSION_STATE_COMPLETED [Team_X]`,
];

/** A hand-made mission id (36 characters, as the game writes them). */
export const missionId = (n: number) => `${n.toString(16).padStart(8, "a")}-1111-2222-3333-444444444444`;
