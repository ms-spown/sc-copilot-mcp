import { z } from "zod";

/**
 * The session file's shapes. A session is the player's own summary of a play period: when it began and ended, the
 * balance at its start and at its last sighting, the trips made and what they earned. It is written to ONE local
 * file by this server (see store.ts) and read back by the tools and the dashboard. It holds NO frame, no raw log
 * line, no handle, no account or session identifier of the game and no address: only the numbers below.
 *
 * Every optional figure is `null` when unknown. A missing figure is never a zero.
 */

/**
 * 1: first format. 2: a trade trip may also hold what its plan said (planned quantity, the plan's two terminals) and how
 * its fees were obtained, for the route calibration (calibration.ts). Every new field is optional with a null default, so
 * a version 1 file reads as is (MIGRATIONS[1] only changes the number). The number moves anyway: SessionSchema drops
 * unknown keys, so a server that only knows version 1 must see a "newer" file and leave it alone rather than rewrite it
 * without the new fields.
 */
export const SESSIONS_VERSION = 2;
/** The file keeps this many sessions; the oldest go first (a very long history is not the purpose). */
export const MAX_SESSIONS = 200;
/** Trips kept per session. A session with more keeps the newest and counts the rest in `trips_dropped`. */
export const MAX_TRIPS = 500;
export const MAX_INTERRUPTIONS = 50;
/**
 * A file bigger than this is not ours: it is set aside, not parsed. It sits well ABOVE what this server writes
 * (WRITE_SOFT_BYTES), so a file this server wrote is always read back.
 */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
/**
 * What this server keeps the file under: when a write would pass it, the OLDEST sessions are dropped (the newest is never
 * dropped) and counted in `dropped_sessions`. 200 sessions of 500 trips could be tens of MB, so the bound is in bytes.
 */
export const WRITE_SOFT_BYTES = 3 * 1024 * 1024;
export const LABEL_MAX = 80;
export const PLACE_MAX = 60;
export const NOTE_MAX = 500;

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/** Text from the game or the player: control and direction-changing characters out, one line, capped. */
export const cleanText = (max: number) =>
  z
    .string()
    .transform((s) =>
      Array.from(s.replace(CONTROL, " ").replace(/\s+/g, " ").trim()).slice(0, max).join(""),
    );

const iso = z.string().refine((s) => Number.isFinite(Date.parse(s)), "not a date");
const money = z.number().finite().nullable();
const count = z.number().int().min(0);

export const TripSchema = z.object({
  /** A hash of what identifies the trip (never a game identifier): the same trip seen twice is stored once. */
  key: z.string().regex(/^[0-9a-f]{6,32}$/),
  /** hauling: a contract with pick-up/drop-off steps; trade: bought and sold goods; contract: any other contract. */
  kind: z.enum(["hauling", "trade", "contract"]),
  source: z.enum(["contract_ledger", "trade_journal", "manual"]),
  started_at: iso.nullable().default(null),
  ended_at: iso,
  label: cleanText(LABEL_MAX).nullable().default(null),
  commodity: cleanText(PLACE_MAX).nullable().default(null),
  buy_terminal: cleanText(PLACE_MAX).nullable().default(null),
  sell_terminal: cleanText(PLACE_MAX).nullable().default(null),
  scu: z.number().finite().min(0).nullable().default(null),
  cost_auec: money.default(null),
  revenue_auec: money.default(null),
  fees_auec: money.default(null),
  /**
   * revenue - cost of a cargo run from the trade journal: GROSS (the autoload fee, fuel and every other cost are not in
   * the log). The balance-based `net_auec` stays null for such a trip: only the telemetry knows the wallet.
   */
  gross_margin_auec: money.default(null),
  /** Result of the trip. `balance_delta` is a raw measure (purchases and fines in between are mixed in). */
  net_auec: money.default(null),
  net_kind: z.enum(["balance_delta", "transactions"]).nullable().default(null),
  planned_profit_auec: money.default(null),
  /**
   * What the plan in force said about THIS run (set with `planned_profit_auec`, only on the run the plan was matched to):
   * the planned quantity, and the plan's buy and sell terminals (UEX names, as the route cards name them). They are the
   * PLAN's places, not observed ones: the journal's shop identifiers are not UEX terminal names. The calibration
   * compares the realised result with a plan of the same quantity and groups routes by these two names.
   */
  planned_scu: z.number().finite().min(0).nullable().default(null),
  plan_buy_terminal: cleanText(PLACE_MAX).nullable().default(null),
  plan_sell_terminal: cleanText(PLACE_MAX).nullable().default(null),
  /**
   * How the plan was tied to this run: by name (the model could compare the goods' names) or by prices (the log names
   * goods by an id only, so the run's average prices resembled the plan's). null: no plan, or a trip from before this field.
   */
  plan_link: z.enum(["name", "prices"]).nullable().default(null),
  /**
   * What the margin and the fees do not explain of the balance change (gross margin - net - fees): a purchase made
   * elsewhere, a reward... `net_doubtful` is the commerce model's own verdict that the net holds such a movement. The
   * calibration leaves such a run's net out. Both come from the balance.
   */
  unexplained_auec: money.default(null),
  net_doubtful: z.boolean().nullable().default(null),
  /** How `fees_auec` was obtained: measured against the balance on both sides, or deduced (gross margin minus net). */
  fees_method: z.enum(["mesure", "estime"]).nullable().default(null),
  /**
   * True when the net, the fees and what the balance holds beyond the run are those MEASURED on an earlier version of the
   * run: it grew (a later line) after a restart had lost the balance history, so they do not cover its last lines. The net
   * is then also flagged doubtful. Additive and optional (absent or null: not the case, or a trip from before this field); it comes
   * from the balance, so it is withheld like `net_doubtful`. Unknown to a build that predates it, which drops it harmlessly.
   */
  figures_from_before: z.boolean().nullable().optional(),
});
export type Trip = z.infer<typeof TripSchema>;

export const InterruptionSchema = z.object({
  from: iso,
  to: iso,
  /** game_closed: the game wrote its quit line; unclean: no end marker (crash, reboot, or this server was not running). */
  kind: z.enum(["game_closed", "unclean"]),
});
export type Interruption = z.infer<typeof InterruptionSchema>;

/** Ship losses kept per session (a handful in a long evening; the newest are kept). */
export const MAX_SHIP_LOSSES = 20;

/**
 * A ship destroyed with the player aboard (providers/gamelog/shipLoss.ts), as the session keeps it. ONLY: the time,
 * the ship MODEL, a cause code, the kind of causer (never a name), a place token, and the cargo PRESUMED lost with it: SCU,
 * and the aUEC PAID for it (the purchase price, not the value: balance-derived, so withheld like any other money figure).
 * NOTHING derived from a ship's identifier is stored (the hash that links a purchase to its ship lives in memory only), nor
 * a count of purchase lines, nor a key of the run. The value lost, the insurance and the killer are not in the log.
 * Additive and optional: a file written before it reads as an empty list, and the format stays version 2.
 */
export const ShipLossSchema = z.object({
  at: iso,
  ship_class: cleanText(60).nullable().default(null),
  cause: z.enum(["collision", "combat", "self_destruct", "unknown"]).default("unknown"),
  causer: z.enum(["self", "other", "npc", "unknown"]).default("unknown"),
  zone: cleanText(60).nullable().default(null),
  /** null: no trade journal was available (unknown, never zero). */
  cargo_scu: z.number().finite().min(0).nullable().default(null),
  /** aUEC PAID for the SCU above. From the balance's side: never shown without it. */
  cargo_paid_auec: money.default(null),
});
export type ShipLossRecord = z.infer<typeof ShipLossSchema>;
export type ShipLossInput = z.input<typeof ShipLossSchema>;

export const BALANCE_QUALITIES = ["game_start", "first_seen", "new_session", "late"] as const;
export type BalanceQuality = (typeof BALANCE_QUALITIES)[number];

export const SessionSchema = z.object({
  id: z.string().regex(/^s_[0-9a-z_]{4,40}$/),
  /** 1, 2, 3...: how the player names it. Never reused except by an empty session that was dropped. */
  number: z.number().int().min(1),
  started_at: iso,
  ended_at: iso.nullable().default(null),
  end_reason: z.enum(["manual", "new_session", "gap"]).nullable().default(null),
  last_activity_at: iso,
  /** The game's own quit line was seen at this time: the next resume is then a clean one. */
  quit_at: iso.nullable().default(null),
  start_balance: money.default(null),
  start_balance_at: iso.nullable().default(null),
  /**
   * How far the start balance can be trusted as "the balance when the play period began": game_start (the server
   * saw the stream begin), first_seen (the server started watching later), new_session (balance at the click),
   * late (adopted long after the session began).
   */
  start_balance_quality: z.enum(BALANCE_QUALITIES).nullable().default(null),
  last_balance: money.default(null),
  last_balance_at: iso.nullable().default(null),
  game_version: cleanText(40).nullable().default(null),
  game_channel: z.enum(["live", "ptu", "unknown"]).nullable().default(null),
  /** Time the game was seen running, in ms. Gaps between sightings are not counted. */
  active_ms: z.number().int().min(0).default(0),
  interruptions: z.array(InterruptionSchema).max(MAX_INTERRUPTIONS).default([]),
  trips: z.array(TripSchema).max(MAX_TRIPS).default([]),
  trips_dropped: count.default(0),
  /** The last place and goods the log named, with when. */
  last_location: cleanText(PLACE_MAX).nullable().default(null),
  last_commodity: cleanText(PLACE_MAX).nullable().default(null),
  last_context_at: iso.nullable().default(null),
  note: cleanText(NOTE_MAX).default(""),
  /**
   * Transactions the game refused during this session because the price moved (TransactionCostMismatch): a count of
   * events, no amount. Additive and optional (a file written before it reads as 0; the format stays version 2).
   * `price_refusal_last_at` is the watermark that keeps the count idempotent: only a refusal NEWER than it is added, so
   * seeing the same log twice, or by two server processes, counts it once.
   */
  price_refusals: count.default(0),
  price_refusal_last_at: iso.nullable().default(null),
  /** Ships destroyed with the player aboard (see ShipLossSchema), oldest first, one per ship. */
  ship_losses: z.array(ShipLossSchema).max(MAX_SHIP_LOSSES).default([]),
  updated_at: iso,
});
export type Session = z.infer<typeof SessionSchema>;

export interface StoreState {
  version: number;
  /** Increases at every write: lets two processes see that the other wrote. */
  revision: number;
  saved_at: string | null;
  next_number: number;
  /** Oldest sessions dropped to keep the file under WRITE_SOFT_BYTES (or MAX_SESSIONS), over the life of the file. */
  dropped_sessions: number;
  sessions: Session[];
}

export const emptyState = (): StoreState => ({
  version: SESSIONS_VERSION,
  revision: 0,
  saved_at: null,
  next_number: 1,
  dropped_sessions: 0,
  sessions: [],
});

/** What a trip source hands over (a trip not yet stored). */
export type TripInput = z.input<typeof TripSchema>;
