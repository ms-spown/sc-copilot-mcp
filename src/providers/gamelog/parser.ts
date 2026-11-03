/**
 * Game.log parser. Pure: text in, events out.
 *
 * Every pattern below was seen in real logs from a LIVE install (build 4.10, November 2026),
 * not taken from documentation. The format is not guaranteed by CIG and changes between
 * patches, so unknown lines are ignored and counted, never guessed at.
 *
 * Personal data never leaves this file: no handle, account id, character name or path is read
 * into an event. The log contains them (login, channel, comms lines); the patterns simply do
 * not capture them.
 *
 * Seen in real logs but deliberately NOT turned into events, because the log does not state
 * them: ordinary quantum travel, combat and kills, wallet balance, the player's position, a
 * death (only corpse/hospital bookkeeping lines exist). Jump-point transits between systems
 * (Stanton <-> Pyro) ARE logged, by the jump drive's state machine, and are reported.
 */

import { parseCommerceLine, type TradeRecord } from "./trade.js";

export type EventType =
  | "session_start"
  | "login_completed"
  | "spawned"
  | "session_end"
  | "jurisdiction_entered"
  | "zone_change"
  | "mission_accepted"
  | "mission_completed"
  | "mission_ended"
  | "objective_new"
  | "objective_completed"
  | "shop_purchase_requested"
  | "shop_purchase_result"
  | "insurance_claim_requested"
  | "hangar_request_completed"
  | "hangar_queue_joined"
  | "blueprint_received"
  | "ship_channel_joined"
  | "ship_channel_left"
  | "jump_point_transit"
  | "hauling_objective";

export const EVENT_TYPES: EventType[] = [
  "session_start",
  "login_completed",
  "spawned",
  "session_end",
  "jurisdiction_entered",
  "zone_change",
  "mission_accepted",
  "mission_completed",
  "mission_ended",
  "objective_new",
  "objective_completed",
  "shop_purchase_requested",
  "shop_purchase_result",
  "insurance_claim_requested",
  "hangar_request_completed",
  "hangar_queue_joined",
  "blueprint_received",
  "ship_channel_joined",
  "ship_channel_left",
  "jump_point_transit",
  "hauling_objective",
];

export interface LogEvent {
  /** UTC time from the log line. */
  time: string | null;
  type: EventType;
  [detail: string]: unknown;
}

export interface SessionInfo {
  /** Local time the game wrote in its header ("Mon Nov 2 21:06:15 2026"), as is. */
  started_local: string | null;
  game_version: string | null;
  /** "PUB" in the header of a LIVE client. */
  environment: string | null;
  /** The build number found in the header's session id. */
  build: string | null;
  built_on: string | null;
  /** live when the header says PUB, ptu when it says PTU, otherwise unknown: never guessed. */
  channel: "live" | "ptu" | "unknown";
  /** True when a clean-quit line was seen; false means still running, crashed, or killed. */
  clean_exit: boolean;
}

export interface ParsedLog {
  session: SessionInfo;
  events: LogEvent[];
  stats: { lines: number; recognized: number; ignored: number };
  /** First and last timestamps in the text: the session's span, by the log's own clock (UTC). */
  span: { first: string | null; last: string | null };
  /**
   * Commerce lines (shop and cargo requests, their outcomes, location hints), kept apart from
   * `events` so the frozen event list of the log tools does not change. See trade.ts.
   */
  commerce: TradeRecord[];
}

const TS = /^<(\d{4}-\d{2}-\d{2}T[\d:.]+Z)>/;

/** Leading words of a HUD notification, mapped to what they announce. */
const ZONES: [RegExp, string, string][] = [
  [/^Entering Armistice Zone/, "armistice", "enter"],
  [/^Leaving Armistice Zone/, "armistice", "leave"],
  [/^Entered Monitored Space/, "monitored_space", "enter"],
  [/^Exited Monitored Space/, "monitored_space", "leave"],
  [/^Entering Private Property/, "private_property", "enter"],
  [/^Leaving Private Property/, "private_property", "leave"],
  [/^Restricted Area/, "restricted_area", "warning"],
  [/^Leaving Restricted Area/, "restricted_area", "leave"],
];

/** "Title: detail: " from a HUD notification line -> [title, detail]. */
function splitNotification(text: string): [string, string] {
  const clean = text.replace(/\s+/g, " ").trim().replace(/:\s*$/, "");
  const i = clean.indexOf(":");
  if (i < 0) return [clean, ""];
  return [clean.slice(0, i).trim(), clean.slice(i + 1).trim()];
}

/** First 8 characters of a mission id: enough to link events of one mission, short to read. */
const shortId = (guid: string) => guid.slice(0, 8);

const notifKey = (ts: string | null, text: string) =>
  `${(ts ?? "").slice(0, 19)}|${text.replace(/\s+/g, " ").trim()}`;

function field(line: string, name: string): string | null {
  const m = line.match(new RegExp(`${name}\\[([^\\]]*)\\]`));
  return m ? m[1] : null;
}

export function parseLog(text: string): ParsedLog {
  const lines = text.split(/\r?\n/);
  const events: LogEvent[] = [];
  const commerce: TradeRecord[] = [];
  const session: SessionInfo = {
    started_local: null,
    game_version: null,
    environment: null,
    build: null,
    built_on: null,
    channel: "unknown",
    clean_exit: false,
  };
  let recognized = 0;
  let counted = 0;
  let firstTime: string | null = null;
  let lastTime: string | null = null;

  // A notification is logged on three lines; only the "Added notification" one carries the
  // mission it belongs to. Collect those first so the notification's own line can be linked.
  const missionOfNotification = new Map<string, string>();
  for (const line of lines) {
    const added = line.match(
      /<SHUDEvent_OnNotification> Added notification "([^"]*)"\s*\[\d+\].*MissionId: \[([0-9a-f-]{36})\]/,
    );
    if (added) missionOfNotification.set(notifKey(line.match(TS)?.[1] ?? null, added[1]), added[2]);
  }
  const seenHauling = new Set<string>();

  for (const line of lines) {
    if (!line.trim()) continue;
    counted += 1;
    const ts = line.match(TS)?.[1] ?? null;
    if (ts && !firstTime) firstTime = ts;
    if (ts) lastTime = ts;
    const body = ts ? line.slice(line.indexOf(">") + 1) : line;
    const push = (type: EventType, detail: Record<string, unknown> = {}) => {
      recognized += 1;
      events.push({ time: ts, type, ...detail });
    };

    // --- header
    let m: RegExpMatchArray | null;
    if ((m = body.match(/^\s*Log started on (.+)$/))) {
      session.started_local = m[1].trim();
      recognized += 1;
      continue;
    }
    if ((m = body.match(/^\s*FileVersion:\s*(\S+)/))) {
      session.game_version = m[1];
      recognized += 1;
      continue;
    }
    if ((m = body.match(/^\s*Built on (.+)$/))) {
      session.built_on = m[1].trim();
      recognized += 1;
      continue;
    }
    if ((m = body.match(/\[Trace\]\s+Environment:\s+(\S+)/))) {
      session.environment = m[1];
      session.channel = /^PUB$/i.test(m[1]) ? "live" : /PTU/i.test(m[1]) ? "ptu" : "unknown";
      recognized += 1;
      continue;
    }
    if ((m = body.match(/\[Trace\]\s+@env_session:\s+'[^']*?-(\d{5,})'/))) {
      session.build = m[1];
      recognized += 1;
      continue;
    }

    // --- engine events
    if (/<LoginCompleted>/.test(body)) {
      push("login_completed");
      continue;
    }
    if (/\[CSessionManager::OnClientSpawned\] Spawned!/.test(body)) {
      push("spawned");
      continue;
    }
    if ((m = body.match(/<SystemQuit>.*exitCode=(-?\d+)/))) {
      session.clean_exit = true;
      push("session_end", { exit_code: Number(m[1]) });
      continue;
    }
    if ((m = body.match(/<MissionEnded>.*?mission_id ([0-9a-f-]{36}).*(MISSION_STATE_[A-Z_]+)/))) {
      push("mission_ended", {
        mission_id: shortId(m[1]),
        state: m[2].replace("MISSION_STATE_", "").toLowerCase(),
      });
      continue;
    }
    if (
      (m = body.match(
        /<Jump Drive State Changed> Now (Entering|Transiting|Exiting)\b[^|]*\|[^|]*\|\s*(NOT AUTH|AUTH)\s*\|\s*([A-Za-z0-9_]+)\s*\|/,
      ))
    ) {
      push("jump_point_transit", {
        phase: m[1].toLowerCase(),
        system: m[3],
        authoritative: m[2] === "AUTH",
      });
      continue;
    }
    if (
      (m = body.match(
        /<CreateHaulingObjectiveHandler> (Pick|Dropoff) created.*?sourcename: (\S+?),\s*missionId: ([0-9a-f-]{36}).*?\[([A-Za-z0-9_]+)\]/,
      ))
    ) {
      // The log repeats these hundreds of times per mission: keep each objective once.
      const key = `${m[3]}|${m[1]}|${m[4]}`;
      if (!seenHauling.has(key)) {
        seenHauling.add(key);
        push("hauling_objective", {
          kind: m[1] === "Pick" ? "pickup" : "dropoff",
          location: m[4],
          cargo: m[2].replace(/,$/, ""),
          mission_id: shortId(m[3]),
        });
      }
      continue;
    }
    const trade = parseCommerceLine(body, ts);
    if (trade) commerce.push(trade);
    if (/<CWallet::ProcessClaimToNextStep> New Insurance Claim Request/.test(body)) {
      push("insurance_claim_requested");
      continue;
    }
    if (/<[A-Za-z:]*SendShopBuyRequest>|<[A-Za-z:]*SendStandardItemBuyRequest>/.test(body)) {
      push("shop_purchase_requested", {
        shop: field(body, "shopName"),
        item: field(body, "itemName"),
        quantity: Number(field(body, "quantity") ?? 1),
        price: Number(field(body, "client_price")),
      });
      continue;
    }
    if (/<[A-Za-z:]*RmShopFlowResponse>.*result\[/.test(body)) {
      push("shop_purchase_result", {
        shop: field(body, "shopName"),
        result: field(body, "result"),
      });
      continue;
    }
    if (trade) {
      // Cargo requests, sells, location hints: read into `commerce` only.
      recognized += 1;
      continue;
    }

    // --- HUD notifications, read from their own quoted line (the same text is logged twice more)
    if ((m = line.match(/^<[^>]+>\s+"([^"]*)(?:"\s*\[\d+\])?\s*$/))) {
      const text = m[1];
      const missionGuid = missionOfNotification.get(notifKey(ts, text));
      const mission = missionGuid ? { mission_id: shortId(missionGuid) } : {};
      const [title, detail] = splitNotification(text);
      let channel: RegExpMatchArray | null;
      if (title === "Contract Accepted") push("mission_accepted", { title: detail, ...mission });
      else if (title === "Contract Complete")
        push("mission_completed", { title: detail, ...mission });
      else if (title === "New Objective") push("objective_new", { objective: detail, ...mission });
      else if (title === "Objective Complete")
        push("objective_completed", { objective: detail, ...mission });
      else if (title === "Received Blueprint")
        push("blueprint_received", { blueprint: detail, ...mission });
      else if (title === "Hangar Request Completed") push("hangar_request_completed");
      else if (/^Joined hangar queue/.test(title)) push("hangar_queue_joined");
      else if (
        (channel = text.match(/^You have (joined|left)(?: the)? channel '([^']*?) : [^']*'/))
      ) {
        // "<ship> : <player>": only the ship is kept, the player's name after the colon is dropped.
        push(channel[1] === "joined" ? "ship_channel_joined" : "ship_channel_left", {
          ship: channel[2],
        });
      } else if ((m = text.match(/^Entered (.+?) Jurisdiction/))) {
        push("jurisdiction_entered", { jurisdiction: m[1] });
      } else {
        const zone = ZONES.find(([re]) => re.test(title));
        if (zone) push("zone_change", { zone: zone[1], action: zone[2] });
      }
    }
  }

  return {
    session,
    events,
    stats: { lines: counted, recognized, ignored: counted - recognized },
    span: { first: firstTime, last: lastTime },
    commerce,
  };
}

/** Decode a log buffer: UTF-8 (with or without BOM) or UTF-16 LE with BOM. */
export function decodeLog(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  const text = buffer.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
