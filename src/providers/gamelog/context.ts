import type { LogEvent, ParsedLog } from "./parser.js";

/**
 * "What is the player doing right now?", derived from the events of the current session.
 *
 * Everything here is "the last time the game logged it", not a live reading: the log has no
 * position and no ship telemetry. Each field says when it was last seen so a stale answer
 * can be told from a fresh one. Contract tracking is best effort: it links a contract to its
 * end through the mission id when the log gave one, and by title otherwise.
 */

export interface ContractView {
  title: string;
  mission_id?: string;
  accepted_at: string | null;
  /** Latest objective the game announced for it. */
  objective?: string;
  hauling?: { kind: string; location: string; cargo: string }[];
}

export interface FinishedContract {
  title: string;
  outcome: "completed" | "failed" | "abandoned" | "ended";
  at: string | null;
}

export interface SessionContext {
  as_of: string | null;
  jurisdiction: { name: string; since: string | null } | null;
  /** true = inside, false = left, null = never seen this session. */
  zones: Record<
    "armistice" | "monitored_space" | "private_property" | "restricted_area",
    boolean | null
  >;
  ship_aboard: { ship: string; since: string | null } | null;
  last_jump_point_transit: { phase: string; system: string; at: string | null } | null;
  contracts: { active: ContractView[]; finished: FinishedContract[] };
  blueprints_received: { blueprint: string; at: string | null }[];
  purchases: {
    count: number;
    last: {
      shop: unknown;
      item: unknown;
      quantity: unknown;
      price: unknown;
      at: string | null;
    } | null;
  };
  insurance_claims: number;
  hangar_requests: number;
  caveats: string[];
}

const outcomeOf = (state: unknown): FinishedContract["outcome"] =>
  state === "completed" || state === "failed" || state === "abandoned" ? state : "ended";

/**
 * The game announces a contract twice a few seconds apart (the second time without its mission
 * id). Repeats of the same notice within a minute are one event; the copy that carries the id wins.
 */
export function collapseRepeats(events: LogEvent[]): LogEvent[] {
  const out: LogEvent[] = [];
  for (const e of events) {
    if (e.type === "mission_accepted" || e.type === "mission_completed") {
      const at = e.time ? Date.parse(e.time) : Number.NaN;
      let dup = -1;
      for (let i = out.length - 1; i >= 0 && dup < 0; i--) {
        const o = out[i];
        const gap = Math.abs(Date.parse(o.time ?? "") - at);
        if (gap > 60_000) break;
        if (o.type === e.type && o.title === e.title) dup = i;
      }
      if (dup >= 0) {
        if (!out[dup].mission_id && e.mission_id) out[dup] = e;
        continue;
      }
    }
    out.push(e);
  }
  return out;
}

export function deriveContext(parsed: ParsedLog): SessionContext {
  const events = collapseRepeats(parsed.events);
  const ctx: SessionContext = {
    as_of:
      events
        .map((e) => e.time)
        .filter(Boolean)
        .at(-1) ?? null,
    jurisdiction: null,
    zones: {
      armistice: null,
      monitored_space: null,
      private_property: null,
      restricted_area: null,
    },
    ship_aboard: null,
    last_jump_point_transit: null,
    contracts: { active: [], finished: [] },
    blueprints_received: [],
    purchases: { count: 0, last: null },
    insurance_claims: 0,
    hangar_requests: 0,
    caveats: [
      "Each field is the last time the game logged it, not a live reading. The log has no position and no ship telemetry.",
    ],
  };

  const open = new Map<string, ContractView>(); // by mission id, or "title:<title>"
  const keyOf = (e: LogEvent, title?: string) =>
    typeof e.mission_id === "string" ? e.mission_id : `title:${title ?? ""}`;
  const idToKey = new Map<string, string>();
  const hauling = new Map<string, NonNullable<ContractView["hauling"]>>();

  for (const e of events) {
    switch (e.type) {
      case "jurisdiction_entered":
        ctx.jurisdiction = { name: String(e.jurisdiction), since: e.time };
        break;
      case "zone_change": {
        const zone = e.zone as keyof SessionContext["zones"];
        if (zone in ctx.zones) ctx.zones[zone] = e.action === "leave" ? false : true;
        break;
      }
      case "ship_channel_joined":
        ctx.ship_aboard = { ship: String(e.ship), since: e.time };
        break;
      case "ship_channel_left":
        if (ctx.ship_aboard?.ship === e.ship) ctx.ship_aboard = null;
        break;
      case "jump_point_transit":
        ctx.last_jump_point_transit = {
          phase: String(e.phase),
          system: String(e.system),
          at: e.time,
        };
        break;
      case "mission_accepted": {
        const view: ContractView = {
          title: String(e.title),
          ...(typeof e.mission_id === "string" ? { mission_id: e.mission_id } : {}),
          accepted_at: e.time,
        };
        const key = keyOf(e, view.title);
        open.set(key, view);
        if (view.mission_id) idToKey.set(view.mission_id, key);
        break;
      }
      case "objective_new": {
        const key = typeof e.mission_id === "string" ? idToKey.get(e.mission_id) : undefined;
        if (key && open.has(key)) open.get(key)!.objective = String(e.objective);
        break;
      }
      case "hauling_objective": {
        const id = String(e.mission_id);
        const list = hauling.get(id) ?? [];
        if (list.length < 6)
          list.push({ kind: String(e.kind), location: String(e.location), cargo: String(e.cargo) });
        hauling.set(id, list);
        break;
      }
      case "mission_completed": {
        const key = keyOf(e, String(e.title));
        const view = open.get(key) ?? open.get(`title:${e.title}`);
        const k = open.has(key) ? key : `title:${e.title}`;
        if (view) open.delete(k);
        ctx.contracts.finished.push({ title: String(e.title), outcome: "completed", at: e.time });
        break;
      }
      case "mission_ended": {
        const key = typeof e.mission_id === "string" ? idToKey.get(e.mission_id) : undefined;
        const view = key ? open.get(key) : undefined;
        if (key && view) {
          open.delete(key);
          // A completion notice may already have closed it: do not list it twice.
          if (
            !ctx.contracts.finished.some((f) => f.title === view.title && f.outcome === "completed")
          ) {
            ctx.contracts.finished.push({
              title: view.title,
              outcome: outcomeOf(e.state),
              at: e.time,
            });
          } else if (outcomeOf(e.state) !== "completed") {
            ctx.contracts.finished.push({
              title: view.title,
              outcome: outcomeOf(e.state),
              at: e.time,
            });
          }
        }
        break;
      }
      case "blueprint_received":
        ctx.blueprints_received.push({ blueprint: String(e.blueprint), at: e.time });
        break;
      case "shop_purchase_requested":
        ctx.purchases.count += 1;
        ctx.purchases.last = {
          shop: e.shop,
          item: e.item,
          quantity: e.quantity,
          price: e.price,
          at: e.time,
        };
        break;
      case "insurance_claim_requested":
        ctx.insurance_claims += 1;
        break;
      case "hangar_request_completed":
        ctx.hangar_requests += 1;
        break;
      default:
        break;
    }
  }

  ctx.contracts.active = [...open.values()].map((c) => ({
    ...c,
    ...(c.mission_id && hauling.has(c.mission_id) ? { hauling: hauling.get(c.mission_id) } : {}),
  }));
  ctx.contracts.finished = ctx.contracts.finished.slice(-15);
  if (!parsed.session.clean_exit && ctx.contracts.active.length) {
    ctx.caveats.push(
      "Contracts accepted in earlier sessions are not visible here, and a contract abandoned without a log line stays 'active'.",
    );
  }
  return ctx;
}

export interface SessionSummary {
  started_local: string | null;
  game_version: string | null;
  build: string | null;
  channel: string;
  duration_minutes: number | null;
  clean_exit: boolean;
  contracts_accepted: number;
  contracts_completed: number;
  purchases: number;
  blueprints_received: number;
  jump_point_transits: number;
  jurisdictions_visited: string[];
}

export function summarizeSession(parsed: ParsedLog): SessionSummary {
  const events = collapseRepeats(parsed.events);
  const count = (type: string) => events.filter((e) => e.type === type).length;
  const { first, last } = parsed.span;
  const minutes = first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 60000) : null;
  return {
    started_local: parsed.session.started_local,
    game_version: parsed.session.game_version,
    build: parsed.session.build,
    channel: parsed.session.channel,
    duration_minutes: minutes,
    clean_exit: parsed.session.clean_exit,
    contracts_accepted: count("mission_accepted"),
    contracts_completed: count("mission_completed"),
    purchases: count("shop_purchase_requested"),
    blueprints_received: count("blueprint_received"),
    jump_point_transits: events.filter(
      (e) => e.type === "jump_point_transit" && e.phase === "entering",
    ).length,
    jurisdictions_visited: [
      ...new Set(
        events.filter((e) => e.type === "jurisdiction_entered").map((e) => String(e.jurisdiction)),
      ),
    ],
  };
}
