import { createHash } from "node:crypto";
import type { ShipCause, ShipCauser, ShipRecord } from "./shipLoss.js";

/**
 * The log lines behind the ship-loss tracker (shipLoss.ts holds what is made of them). One line in, one record out, or null.
 *
 * PRIVACY. Some of these lines carry the player's name, his entity id, another player's name or a killer's name. None of
 * that is captured into a record: the patterns read the id of the victim/actor only to COMPARE it, in memory, with the
 * player's own (the `Character` login line), and keep a short hash of the SHIP's entity id plus public things (the model of
 * the vehicle, a place token, a cause code, the kind of causer: self, another player, an AI, unknown). The player's own
 * reference is a hash too and leaves this module only as a hash.
 *
 * TWO LOG ERAS, one record shape:
 *  - build 4.10 (checked on logs of November 2026): `[ActorState] Dead` ("ejected from zone 'SHIP' ... destroyed vehicle"),
 *    `FatalCollision ... PlayerPilot: 1`, `VehicleCargoDataRequest` (the ship the cargo kiosk is bound to).
 *  - the 2025 builds (4.0/4.1, March-April 2025): `Actor Death` of the player inside the ship, `Vehicle Destruction` lines
 *    with the cause and the causer. NOT seen in any 4.10 log: that path is legacy, kept because a build may bring them back.
 * Unknown lines are ignored, never guessed at.
 *
 * Cheap on purpose: every pattern is behind a plain substring test, the dashboard re-reads the log every few seconds.
 */

/** A short, stable pseudonym of an entity id (12 hex). Not a secret: the id is a game-internal number, not an account. */
export function entityRef(id: string): string {
  return createHash("sha256").update(`sc-copilot|ship|${id}`).digest("hex").slice(0, 12);
}

const CLASS = /^[A-Za-z][A-Za-z0-9_]{1,59}$/;
/** A place token: letters, digits, underscore, dot, dash; never a run of 5+ digits (that would be an entity id). */
const PLACE = /^(?!.*\d{5})[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+){0,9}$/;
/** The game's own lines are short (a few hundred characters); a longer one is not read at all (bounded work per line). */
export const SHIP_LINE_MAX_CHARS = 4096;
const SUFFIX = /^(.*?)_(\d{6,20})$/;
/** Vehicles and entities the game flies for itself: their destruction is never the player's. */
const AI_VEHICLE = /(^|_)(PU_AI|Unmanned|AIModule)(_|$)/i;
/** The causer is shaped like an AI entity, not like a handle. A heuristic (a handle could look like one; never seen). */
const NPC_NAME = /^(PU_|AIModule_|NPC_|Unmanned_)|_\d{8,}$/i;

const place = (s: string | undefined): string | null => (s && PLACE.test(s) ? s : null);

/** "DRAK_Dragonfly_123456789012" -> { cls: "DRAK_Dragonfly", id: "123456789012" } (null parts when it is not that shape). */
function splitInstance(token: string): { cls: string | null; id: string | null } {
  const m = token.match(SUFFIX);
  if (!m) return { cls: CLASS.test(token) ? token : null, id: null };
  return { cls: CLASS.test(m[1]!) ? m[1]! : null, id: m[2]! };
}

export interface ShipParseState {
  /** The hash of the player's own entity id (from the `Character` login line), once seen. */
  playerRef: string | null;
}

/** Does this line belong to this module at all? One cheap test per line. */
export function mayBeShipLine(body: string): boolean {
  return (
    body.length <= SHIP_LINE_MAX_CHARS &&
    (body.includes("Dead>") ||
      body.includes("<FatalCollision>") ||
      body.includes("VehicleCargoDataRequest") ||
      body.includes("<Actor Death>") ||
      body.includes("<Vehicle Destruction>") ||
      body.includes("AccountLoginCharacterStatus_Character"))
  );
}

const CHARACTER =
  /<AccountLoginCharacterStatus_Character> Character: .*? geid (\d+) .*state STATE_CURRENT/;
const DEAD =
  /\[ActorState\] Dead>.*?Actor '[^']*' \[(\d+)\] ejected from zone '([^']*)' \[(\d+)\](?: to zone '([^']*)')?.*destroyed vehicle/;
const COLLISION =
  /<FatalCollision> Fatal Collision occured for vehicle (\S+) \[.*?Zone: ([^,\]]*), PlayerPilot: (\d)\]/;
const KIOSK =
  /LoadSelectedShipBindings> Sending VehicleCargoDataRequest for vehicleEntityId\[(\d+)\]/;
const DEATH =
  /<Actor Death> CActor::Kill: '[^']*' \[(\d+)\] in zone '([^']*)' killed by .*? with damage type '([A-Za-z]+)'/;
const DESTROY =
  /<Vehicle Destruction> CVehicle::OnAdvanceDestroyLevel: Vehicle '([^']*)' \[(\d+)\] in zone '[^']*' .*? advanced from destroy level (\d+) to (\d+) caused by '([^']*)' \[(\d+)\] with '([A-Za-z]+)'/;

/** Deaths of the player aboard a ship that count as the ship's destruction. A suicide (a reset) or a bleed-out never does. */
const SHIP_DEATHS = new Set(["Crash", "Collision", "VehicleDestruction"]);

function causeOf(type: string): ShipCause {
  if (type === "Combat") return "combat";
  if (type === "Collision") return "collision";
  if (type === "SelfDestruct") return "self_destruct";
  return "unknown";
}

function causerOf(name: string, id: string, state: ShipParseState): ShipCauser {
  if (state.playerRef !== null && id !== "0" && entityRef(id) === state.playerRef) return "self";
  if (name === "unknown" || id === "0") return "unknown";
  return NPC_NAME.test(name) ? "npc" : "other";
}

/**
 * One log line (the part after the timestamp) to a ship record, or null. `state.playerRef` is read from a `Character` line
 * and kept for the lines that follow (and for the next parse, when the caller carries it over).
 */
export function parseShipLine(
  body: string,
  ts: string | null,
  state: ShipParseState,
): ShipRecord | null {
  if (ts === null || !mayBeShipLine(body)) return null;
  let m: RegExpMatchArray | null;

  if (body.includes("AccountLoginCharacterStatus_Character")) {
    if ((m = body.match(CHARACTER))) state.playerRef = entityRef(m[1]!);
    return null;
  }
  if (body.includes("VehicleCargoDataRequest")) {
    if (!(m = body.match(KIOSK))) return null;
    return { kind: "kiosk_ship", time: ts, ship: entityRef(m[1]!) };
  }
  if (body.includes("<FatalCollision>")) {
    // Only a collision of the ship the LOCAL player was piloting says anything about him.
    if (!(m = body.match(COLLISION)) || m[3] !== "1") return null;
    const { cls, id } = splitInstance(m[1]!);
    if (id === null) return null;
    return { kind: "collision", time: ts, ship: entityRef(id), cls, zone: place(m[2]) };
  }
  if (body.includes("Dead>")) {
    if (!(m = body.match(DEAD))) return null;
    // The actor is read to be COMPARED with the player; another actor's line says nothing about him. Without the player's
    // own reference (his login line is not in the text: a long log read from its end) nothing can be told: refused.
    if (state.playerRef === null || entityRef(m[1]!) !== state.playerRef) return null;
    const { cls } = splitInstance(m[2]!);
    return { kind: "dead", time: ts, ship: entityRef(m[3]!), cls, zone: place(m[4]) };
  }
  if (body.includes("<Actor Death>")) {
    // Needs the player's own reference: 300 of 350 deaths in a 2025 log were other actors in range.
    if (state.playerRef === null || !(m = body.match(DEATH))) return null;
    if (entityRef(m[1]!) !== state.playerRef || !SHIP_DEATHS.has(m[3]!)) return null;
    // The zone of a death aboard is the ship instance ("CLASS_123456789"); a place token is a death elsewhere.
    const { cls, id } = splitInstance(m[2]!);
    if (id === null) return null;
    return { kind: "death", time: ts, ship: entityRef(id), cls, zone: null };
  }
  if (body.includes("<Vehicle Destruction>")) {
    if (!(m = body.match(DESTROY)) || m[4] !== "2") return null;
    // An AI vehicle (a mission target, a security drone) is never the player's, whoever destroyed it.
    if (AI_VEHICLE.test(m[1]!)) return null;
    const { cls } = splitInstance(m[1]!);
    return {
      kind: "destroyed",
      time: ts,
      ship: entityRef(m[2]!),
      cls,
      cause: causeOf(m[7]!),
      causer: causerOf(m[5]!, m[6]!, state),
    };
  }
  return null;
}
