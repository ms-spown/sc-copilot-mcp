import type { Transaction } from "./trade.js";

/**
 * Ship losses: "a ship was destroyed with the player aboard", and what that probably cost a trade run.
 *
 * PURE and free of any Node module (the commerce model that imports it also runs in the preview): records in, losses out.
 * The records come from shipLossParse.ts, which reads the log lines. They carry NO name, no handle, no GUID and no raw entity
 * id: a time, a ship class (public vehicle model), a short hash of the ship's entity id, a place token and a cause code.
 *
 * WHAT IS CERTAIN AND WHAT IS NOT (checked on the player's own logs, see docs/CAPABILITIES.md):
 *  - CERTAIN: the player was aboard a ship that was destroyed. Build 4.10 writes `[ActorState] Dead ... ejected from zone
 *    'CLASS_ID' ... destroyed vehicle`; the 2025 builds wrote an `Actor Death` of the player inside that ship instance.
 *  - CAUSE: a collision when a `FatalCollision ... PlayerPilot: 1` precedes the 4.10 line by at most 1 s; the 2025 builds
 *    state it on the `Vehicle Destruction` line of the same ship. Otherwise "unknown": combat is never guessed.
 *  - CARGO: PRESUMED. The cargo kiosk names the ship each purchase is loaded into (`VehicleCargoDataRequest`). The cargo bought
 *    for THAT ship, without a successful sale of the same goods before the destruction, is presumed lost. It is the PURCHASE
 *    price paid, not what the cargo was worth, and the game does not say whether the boxes survived in the wreck.
 *    The end-to-end chain (purchase, ship, destruction) was verified on 2025-build logs only: no 4.10 session has both.
 *  - NOT LOGGED, ever: the value lost, whether the cargo was insured, the insurance cost, the identity of a killer.
 */

export type ShipCause = "collision" | "combat" | "self_destruct" | "unknown";
/**
 * self: the causer's id is the player's (only the 2025 `Vehicle Destruction` line gives one); other: a human-looking name;
 * npc: an AI-shaped name; unknown. The last two come from the SHAPE of a name: a heuristic. A 4.10 collision gives none.
 */
export type ShipCauser = "self" | "other" | "npc" | "unknown";
export type ShipLossVia = "actor_state_dead" | "actor_death";

export type ShipRecord =
  | { kind: "kiosk_ship"; time: string; ship: string }
  | { kind: "collision"; time: string; ship: string; cls: string | null; zone: string | null }
  | { kind: "dead"; time: string; ship: string; cls: string | null; zone: string | null }
  | {
      kind: "death";
      time: string;
      ship: string;
      cls: string | null;
      zone: string | null;
    }
  | {
      kind: "destroyed";
      time: string;
      ship: string;
      cls: string | null;
      cause: ShipCause;
      causer: ShipCauser;
    };

export interface ShipLossCargo {
  /** SCU of successful cargo buys for this ship that no successful sale of the same goods followed. */
  scu: number;
  /** aUEC PAID for those SCU (the purchase price, not the value). Derived from the balance's side: withheld without it. */
  paid_auec: number;
  /** Purchase lines that make up the SCU. */
  buys: number;
  /** Purchases for this ship the journal could not confirm (an error line followed several requests): NOT counted. */
  unconfirmed_buys: number;
  /**
   * Sales the journal could not confirm (of this ship's goods, or of no known ship): NOT counted as sales, so the cargo
   * presumed lost may be OVERESTIMATED by what they sold.
   */
  unconfirmed_sells: number;
  /** ISO time of the latest purchase counted: it ties the loss to the run it interrupted. */
  last_buy_at: string | null;
}

export interface ShipLoss {
  /** ISO time of the destruction line. */
  at: string;
  /**
   * A short hash of the ship's entity id (12 hex): the same ship twice is one loss, and it links a purchase to its ship. MEMORY
   * ONLY: it is never stored in the sessions file, sent to a View or put in an export.
   */
  ship_ref: string;
  /** The ship model ("DRAK_Dragonfly"), or null when the line did not give a clean one. */
  ship_class: string | null;
  cause: ShipCause;
  causer: ShipCauser;
  /** The place token the game logged with it ("OOC_Stanton_3a_Lyria"), or null. */
  zone: string | null;
  via: ShipLossVia;
  /** null: no trade journal to look at (the cargo is then unknown, not zero). */
  cargo: ShipLossCargo | null;
}

/** A buy counts for the loss when the cargo kiosk named this ship no more than this long before it. */
export const KIOSK_BINDING_MS = 30 * 60_000;
/** Purchases older than this before the destruction are not presumed to be aboard any more (a run lasts minutes to ~2 h). */
export const CARGO_LOOKBACK_MS = 3 * 3_600_000;
/** A fatal collision explains the destruction line only if it came at most this long before it. */
export const COLLISION_WINDOW_MS = 1000;
/** A `Vehicle Destruction` line of the same ship explains a death within this window (it may come just after it). */
export const DESTROYED_WINDOW_MS = 3000;
/**
 * Records kept by the service, per kind (the kiosk binding repeats at every cargo screen and must not push a destruction out),
 * and losses listed.
 */
export const SHIP_RECORDS_MAX: Record<ShipRecord["kind"], number> = {
  kiosk_ship: 300,
  collision: 60,
  dead: 40,
  death: 40,
  destroyed: 120,
};
export const SHIP_LOSSES_MAX = 20;

const EPS = 1e-6;
const r2 = (n: number) => Math.round(n * 100) / 100;
const ms = (t: string) => Date.parse(t);

/**
 * The records of ONE parse, bounded while it runs (not only after the sort): a log with hundreds of thousands of kiosk lines
 * holds at most about twice the bound of each kind at any time. A kiosk line that names the ship the previous one named less
 * than 5 minutes earlier adds nothing (the binding is the same), so it is not kept.
 */
export class ShipRecordBuffer {
  readonly records: ShipRecord[] = [];
  private readonly counts = new Map<ShipRecord["kind"], number>();
  private lastKiosk: { ship: string; at: number } | null = null;
  private readonly lastCollision = new Map<string, number>();

  add(r: ShipRecord): void {
    if (r.kind === "kiosk_ship") {
      const at = ms(r.time);
      const last = this.lastKiosk;
      if (last && last.ship === r.ship && at - last.at >= 0 && at - last.at < 5 * 60_000) return;
      this.lastKiosk = { ship: r.ship, at };
    }
    if (r.kind === "collision") {
      // The log repeats a fatal collision once per hull part within a few ms: one per ship and second, BEFORE counting, so
      // that the repeats of a crash cannot push the collisions of an earlier loss out of the bound.
      const at = ms(r.time);
      const last = this.lastCollision.get(r.ship);
      if (last !== undefined && at - last >= 0 && at - last < 1000) return;
      this.lastCollision.set(r.ship, at);
      if (this.lastCollision.size > 200) this.lastCollision.clear();
    }
    this.records.push(r);
    const n = (this.counts.get(r.kind) ?? 0) + 1;
    this.counts.set(r.kind, n);
    const cap = SHIP_RECORDS_MAX[r.kind];
    if (n >= cap * 2) {
      // Keep the newest `cap` of this kind, in place.
      let keep = cap;
      let w = this.records.length;
      for (let i = this.records.length - 1; i >= 0; i--) {
        const x = this.records[i]!;
        if (x.kind === r.kind) {
          if (keep === 0) continue;
          keep -= 1;
        }
        this.records[--w] = x;
      }
      this.records.splice(0, w);
      this.counts.set(r.kind, cap);
    }
  }
}

/** What makes two records the same one (the log repeats a collision once per hull part, and a read re-parses a look-behind). */
export const shipRecordKey = (r: ShipRecord): string => JSON.stringify(r);

/** The ship records worth keeping, oldest first, de-duplicated, at most SHIP_RECORDS_MAX (the newest). */
export function tidyShipRecords(list: readonly ShipRecord[]): ShipRecord[] {
  const seen = new Set<string>();
  const out: ShipRecord[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object" || !Number.isFinite(ms(r.time))) continue;
    const key = shipRecordKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  out.sort((a, b) => ms(a.time) - ms(b.time));
  // Each kind has its own bound (the newest are kept).
  const count = new Map<ShipRecord["kind"], number>();
  for (const r of out) count.set(r.kind, (count.get(r.kind) ?? 0) + 1);
  const skip = new Map<ShipRecord["kind"], number>();
  for (const [kind, n] of count) skip.set(kind, Math.max(0, n - SHIP_RECORDS_MAX[kind]));
  return out.filter((r) => {
    const left = skip.get(r.kind) ?? 0;
    if (left > 0) {
      skip.set(r.kind, left - 1);
      return false;
    }
    return true;
  });
}

interface Lot {
  scu: number;
  unit: number;
  at: number;
}

/**
 * The cargo presumed lost with `ship` at `lossMs`, from the journal's completed lines. Matching is by the kiosk binding:
 * a purchase is the ship's only if the latest `kiosk_ship` record before it (within KIOSK_BINDING_MS) names that ship. A sale
 * of the same goods bound to this ship, or bound to no known ship, uses up its lots first in, first out; a sale bound to
 * ANOTHER ship does not touch them.
 */
function cargoAt(
  ship: string,
  lossMs: number,
  tx: readonly Transaction[],
  kiosks: readonly { t: number; ship: string }[],
): ShipLossCargo {
  const boundTo = (t: number): string | null => {
    let found: string | null = null;
    for (const k of kiosks) {
      if (k.t > t) break;
      found = t - k.t <= KIOSK_BINDING_MS ? k.ship : null;
    }
    return found;
  };
  const lots = new Map<string, Lot[]>();
  let unconfirmed = 0;
  let unconfirmedSells = 0;
  const lines = tx
    .filter(
      (t) =>
        t &&
        t.kind === "commodity" &&
        (t.side === "buy" || t.side === "sell") &&
        typeof t.resource === "string" &&
        typeof t.time === "string" &&
        Number.isFinite(ms(t.time)) &&
        ms(t.time) < lossMs &&
        lossMs - ms(t.time) <= CARGO_LOOKBACK_MS,
    )
    .sort((a, b) => ms(a.time) - ms(b.time));
  for (const t of lines) {
    const at = ms(t.time);
    const bound = boundTo(at);
    const resource = t.resource as string;
    if (t.status === "unconfirmed") {
      if (t.side === "buy" && bound === ship) unconfirmed += 1;
      if (t.side === "sell" && (bound === ship || bound === null)) unconfirmedSells += 1;
      continue;
    }
    // A failed line (an error followed it, or a sale for nothing) moved no cargo.
    if (t.status !== "completed") continue;
    const scu = typeof t.quantity === "number" && t.quantity > 0 ? t.quantity : 0;
    const total = typeof t.total_auec === "number" && t.total_auec >= 0 ? t.total_auec : 0;
    if (scu <= 0 || t.currency !== "aUEC") continue;
    if (t.side === "buy") {
      if (bound !== ship) continue;
      const list = lots.get(resource) ?? [];
      list.push({ scu, unit: total / scu, at });
      lots.set(resource, list);
    } else if (bound === ship || bound === null) {
      const list = lots.get(resource);
      let left = scu;
      while (list && left > EPS && list.length) {
        const lot = list[0]!;
        const take = Math.min(lot.scu, left);
        lot.scu -= take;
        left -= take;
        if (lot.scu <= EPS) list.shift();
      }
    }
  }
  let scu = 0;
  let paid = 0;
  let buys = 0;
  let last = -Infinity;
  for (const list of lots.values()) {
    for (const lot of list) {
      scu += lot.scu;
      paid += lot.scu * lot.unit;
      buys += 1;
      last = Math.max(last, lot.at);
    }
  }
  return {
    scu: r2(scu),
    paid_auec: Math.round(paid),
    buys,
    unconfirmed_buys: unconfirmed,
    unconfirmed_sells: unconfirmedSells,
    last_buy_at: buys > 0 ? new Date(last).toISOString() : null,
  };
}

/**
 * The losses in the ship records, oldest first. One loss per ship (the first destruction line). `transactions` is the trade
 * journal (undefined: there is none, the cargo of each loss is then null).
 */
export function buildShipLosses(
  records: readonly ShipRecord[],
  transactions: readonly Transaction[] | undefined,
): ShipLoss[] {
  const list = tidyShipRecords(records);
  const kiosks = list
    .filter((r): r is Extract<ShipRecord, { kind: "kiosk_ship" }> => r.kind === "kiosk_ship")
    .map((r) => ({ t: ms(r.time), ship: r.ship }));
  const out: ShipLoss[] = [];
  const done = new Set<string>();
  for (const r of list) {
    if (r.kind !== "dead" && r.kind !== "death") continue;
    if (done.has(r.ship)) continue;
    done.add(r.ship);
    const at = ms(r.time);
    // The game's own statement of the cause wins (2025: the Vehicle Destruction line of this ship, which may come just after).
    const vd = list.find(
      (x): x is Extract<ShipRecord, { kind: "destroyed" }> =>
        x.kind === "destroyed" &&
        x.ship === r.ship &&
        Math.abs(ms(x.time) - at) <= DESTROYED_WINDOW_MS,
    );
    const crash = list.some(
      (x) =>
        x.kind === "collision" &&
        x.ship === r.ship &&
        at - ms(x.time) >= 0 &&
        at - ms(x.time) <= COLLISION_WINDOW_MS,
    );
    let cause: ShipCause = "unknown";
    let causer: ShipCauser = "unknown";
    if (vd && vd.cause !== "unknown") {
      cause = vd.cause;
      causer = vd.causer;
    } else if (crash) {
      // `PlayerPilot: 1` says a player piloted the ship that hit something; it does not prove who, nor whose ship it was:
      // the cause is a collision, the causer stays unknown.
      cause = "collision";
    } else if (vd) {
      causer = vd.causer;
    }
    out.push({
      at: new Date(at).toISOString(),
      ship_ref: r.ship,
      ship_class: r.cls ?? (vd ? vd.cls : null),
      cause,
      causer,
      zone: r.zone,
      via: r.kind === "dead" ? "actor_state_dead" : "actor_death",
      cargo: transactions === undefined ? null : cargoAt(r.ship, at, transactions, kiosks),
    });
  }
  return out.sort((a, b) => ms(a.at) - ms(b.at)).slice(-SHIP_LOSSES_MAX);
}

/** The instants at which a run with presumed-lost cargo is cut: the cargo is gone, later lines are another run. */
export function lossCuts(losses: readonly ShipLoss[]): number[] {
  return losses
    .filter((l) => l.cargo !== null && l.cargo.scu > EPS)
    .map((l) => ms(l.at))
    .filter((t) => Number.isFinite(t));
}
