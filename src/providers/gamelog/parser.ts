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
 * them: quantum travel, combat and kills, wallet balance, the player's position, a death (only
 * corpse/hospital bookkeeping lines exist).
 */

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
  | "hangar_request_completed";

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
}

const TS = /^<(\d{4}-\d{2}-\d{2}T[\d:.]+Z)>/;

/** Leading words of a HUD notification, mapped to what they announce. */
const ZONES: [RegExp, string, string][] = [
  [/^Entering Armistice Zone/, "armistice", "enter"],
  [/^Leaving Armistice Zone/, "armistice", "leave"],
  [/^Entered Monitored Space/, "monitored_space", "enter"],
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

function field(line: string, name: string): string | null {
  const m = line.match(new RegExp(`${name}\\[([^\\]]*)\\]`));
  return m ? m[1] : null;
}

export function parseLog(text: string): ParsedLog {
  const lines = text.split(/\r?\n/);
  const events: LogEvent[] = [];
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

  for (const line of lines) {
    if (!line.trim()) continue;
    counted += 1;
    const ts = line.match(TS)?.[1] ?? null;
    if (ts && !firstTime) firstTime = ts;
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
    if ((m = body.match(/<MissionEnded>.*(MISSION_STATE_[A-Z_]+)/))) {
      push("mission_ended", { state: m[1].replace("MISSION_STATE_", "").toLowerCase() });
      continue;
    }
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

    // --- HUD notifications, read from their own quoted line (the same text is logged twice more)
    if ((m = line.match(/^<[^>]+>\s+"([^"]*)(?:"\s*\[\d+\])?\s*$/))) {
      const [title, detail] = splitNotification(m[1]);
      if (title === "Contract Accepted") push("mission_accepted", { title: detail });
      else if (title === "Contract Complete") push("mission_completed", { title: detail });
      else if (title === "New Objective") push("objective_new", { objective: detail });
      else if (title === "Objective Complete") push("objective_completed", { objective: detail });
      else if (title === "Hangar Request Completed") push("hangar_request_completed");
      else if ((m = m[1].match(/^Entered (.+?) Jurisdiction/))) {
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
