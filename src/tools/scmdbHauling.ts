import { z } from "zod";
import { fetchWithCache } from "../core/cache.js";
import type { HttpClient } from "../core/http.js";
import { setChannel } from "../core/provenance.js";
import { cleanLabel } from "../core/untrusted.js";
import { extractHauling, HaulingFormatError } from "../providers/scmdb/hauling.js";
import {
  rankHauling,
  RankQueryError,
  type RankResult,
  type ShipFacts,
} from "../providers/scmdb/haulingRank.js";
import type { Channel, Scmdb } from "../providers/scmdb/store.js";
import { fetchOrbitMatrix, orbitDistance, type OrbitMatrix } from "../providers/uex/distances.js";
import {
  analyzeOffers,
  type OfferInput,
  type OffersAnalysis,
} from "../providers/uex/haulingOffers.js";
import { buildPlaceIndex, resolvePlace, type PlaceMatch } from "../providers/uex/haulingPlaces.js";
import { unwrapData } from "../providers/uex/normalize.js";
import { fetchShipSheet, ShipLookupError, type ShipSheet } from "../providers/uex/shipSheet.js";
import {
  DEFAULT_SPOOL_SECONDS,
  DEFAULT_STOP_SECONDS,
  LOCAL_HOP_SECONDS,
  validQuantumSpeed,
  type TravelModel,
} from "../providers/uex/travel.js";
import { fitStepsOrMinimal } from "./haulingBounds.js";
import { halvings } from "./uexBounds.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * scmdb_rank_hauling: two honest views of hauling contracts.
 *
 *  - templates: the datamined contract families (SCMDB) ranked for a ship. No time, no reward per hour: a template
 *    has pools of possible pickups and drop-offs, never a concrete pair.
 *  - offers: concrete offers the player reads in the mobiGlas, placed with UEX orbits and priced in time.
 *
 * Every own sentence below is its own string and stays under the catalog's maxText, so the registry's cleaning
 * never cuts a caveat in half (a test checks it).
 *
 * Upstream requests of one call (each cached for 5 minutes, identical requests in flight are shared):
 *  - templates: SCMDB (commit SHA, manifest, merged file: on disk by SHA after the first read), and with a named ship
 *    2 more (UEX /vehicles, wiki ship sheet). No UEX place or distance is read.
 *  - offers: UEX /terminals (1), one UEX orbit matrix per star system met (at most 3), and with a named ship 2 more.
 *    Never terminals_distances. At most 6 requests; a repeat within 5 minutes costs none.
 */

const MAX_ROWS = 20;
const MAX_MATRICES = 3;

const channelSchema = z.enum(["live", "ptu"]).optional();

const OfferSchema = z.object({
  title: z.string().max(120).optional(),
  reward: z.number().min(1).max(1_000_000_000),
  scu: z.number().min(1).max(100_000),
  pickup: z.string().min(1).max(80),
  dropoffs: z.array(z.string().min(1).max(80)).min(1).max(6),
  max_container_size: z.number().min(1).max(128).optional(),
});

const ArgsSchema = z.object({
  mode: z.enum(["templates", "offers"]).optional(),
  ship_name: z.string().min(1).max(100).optional(),
  cargo_scu: z.number().min(1).max(100_000).optional(),
  max_container_size: z.number().min(1).max(128).optional(),
  quantum_speed_ms: z.number().optional(),
  stop_minutes: z.number().min(0).max(120).optional(),
  rank: z.string().min(1).max(40).optional(),
  system: z.string().min(1).max(30).optional(),
  include_illegal: z.boolean().optional(),
  include_unfit: z.boolean().optional(),
  sort: z.enum(["reward_per_scu", "reward"]).optional(),
  max_results: z.number().optional(),
  channel: channelSchema,
  offers: z.array(OfferSchema).min(1).max(10).optional(),
});

const NOT_LIVE_OFFERS =
  "SCMDB holds contract TEMPLATES (definitions), not the offers on your mobiGlas: nothing here says a contract is available now.";

const LABELS_TEMPLATES = {
  datamined:
    "reward_auec, scu, container_size_max, rank, illegal, pickups and destinations are fields of the SCMDB data.",
  deduced:
    "scu.deduced_fixed_quantity: an order with maxSCU 0 and a minSCU is read as a fixed quantity. Not documented by the source.",
  estimated:
    "reward_per_scu is reward divided by the SCU range [low = reward / max SCU, high = reward / min SCU]. Whether the paid reward follows the SCU actually rolled is unknown.",
  unknown:
    "Reward per hour and time are null: a template has pools of possible places, never a concrete pickup and drop-off. Availability and frequency are not in the data.",
  measured: "Never used here: no game log or telemetry is read by this tool.",
};

const TEMPLATE_CAVEATS = [
  "Container fit is a rule of thumb: the ship's largest container size must be at least the contract's. Not verified in the game.",
  "Hold fit counts trips as ceil(SCU / hold). Whether a reward is paid for several trips is not in the data.",
  "time_to_complete is not shown and not used: the source gives no unit. No rate is derived from it.",
  "Rank is judged only on the Hauling scale and only when rank is given; other gates (FactionReputation, intro contracts, crime stat) are shown, not checked.",
  "SCMDB can be ahead of or behind the build you play: compare scmdb.build with sc_data_status.",
];

const OFFER_ASSUMPTIONS = [
  "Reward, SCU, container size and place names are what you gave. The server does not verify that an offer exists.",
  "TIME IS AN ESTIMATE: a fixed time per stop (landing, terminal, loading, take off) and a fixed hop inside one orbit. Both are assumptions, not measurements.",
  "Flights are straight quantum jumps between UEX orbit centres at the ship's quantum speed (UEX distances, wiki speed). A place is only known to its orbit.",
  "Not counted: the flight to the first pickup, anything after the last drop-off, loading time of a big hold, quantum fuel, interdiction.",
  "A route between two star systems has no time (UEX has no jump transit time): its hourly figure is null.",
  "A bundle is a set of offers with the same pickup orbit whose SCU fit in the hold in one trip. Whether the game lets you hold them together is not checked.",
  "An offer larger than the hold is timed as repeated trips (route, then back to the pickup). Whether the reward is paid per trip is not known.",
];

const LABELS_OFFERS = {
  given_by_player: "reward_auec, scu, container_size and the place names, as typed.",
  estimated: "minutes, reward_per_hour and the bundle comparison, under the assumptions listed.",
  unknown: "A null time or hourly figure always comes with its reason.",
  measured:
    "Never used here: nothing is measured (no game log or telemetry is read), so no figure carries that label.",
};

class UserError extends Error {}

function shipFacts(
  sheet: ShipSheet | null,
  cargoScu: number | undefined,
  maxContainer: number | undefined,
): { facts: ShipFacts | null; description: Record<string, unknown> | null } {
  if (!sheet && cargoScu === undefined && maxContainer === undefined) {
    return { facts: null, description: null };
  }
  const hold = cargoScu ?? sheet?.cargo_scu ?? null;
  const sizes = sheet?.container_sizes ?? null;
  const biggest = maxContainer ?? (sizes && sizes.length ? Math.max(...sizes) : null);
  const facts: ShipFacts = {
    name: sheet?.name ?? null,
    hold_scu: hold === null ? null : Math.floor(hold),
    max_container_size: biggest,
  };
  const missing = [...(sheet?.missing ?? [])];
  if (biggest === null) {
    missing.push("no container sizes known for the ship: the container check is unknown");
  }
  if (facts.hold_scu === null || facts.hold_scu < 1) {
    missing.push("no hold size known: the hold check is unknown");
  }
  return {
    facts,
    description: {
      name: facts.name,
      hold_scu: facts.hold_scu,
      hold_scu_from: cargoScu !== undefined ? "cargo_scu argument" : sheet ? "UEX" : null,
      max_container_size: facts.max_container_size,
      container_sizes: sizes,
      max_container_size_from:
        maxContainer !== undefined
          ? "max_container_size argument"
          : sizes
            ? "UEX container_sizes"
            : null,
      ...(missing.length ? { missing } : {}),
    },
  };
}

async function loadShip(
  clients: { uexClient: HttpClient; scwClient: HttpClient },
  name: string | undefined,
): Promise<ShipSheet | null> {
  if (!name) return null;
  try {
    return await fetchShipSheet(clients.uexClient, clients.scwClient, name);
  } catch (error) {
    if (error instanceof ShipLookupError) throw new UserError(error.message);
    throw error;
  }
}

const out = (value: unknown): string => JSON.stringify(value, null, 2);

// ---------------------------------------------------------------------------------------------- templates

async function templatesMode(
  clients: { scmdb: Scmdb; uexClient: HttpClient; scwClient: HttpClient },
  a: z.infer<typeof ArgsSchema>,
): Promise<ToolResult> {
  const channel = (a.channel ?? "live") as Channel;
  const loaded = await clients.scmdb.file(channel, "merged");
  setChannel(channel);
  let dataset;
  try {
    dataset = extractHauling(loaded.data);
  } catch (error) {
    if (error instanceof HaulingFormatError) throw new UserError(error.message);
    throw error;
  }
  const sheet = await loadShip(clients, a.ship_name);
  const { facts, description } = shipFacts(sheet, a.cargo_scu, a.max_container_size);
  const limit = Math.min(Math.max(Math.floor(a.max_results ?? 10), 1), MAX_ROWS);

  let result: RankResult;
  try {
    result = rankHauling(dataset, {
      ship: facts,
      rank: a.rank ?? null,
      system: a.system ?? null,
      includeIllegal: a.include_illegal === true,
      includeUnfit: a.include_unfit === true,
      sort: a.sort ?? "reward_per_scu",
      limit,
    });
  } catch (error) {
    if (error instanceof RankQueryError) throw new UserError(error.message);
    throw error;
  }

  const notes: string[] = [];
  if (loaded.stale)
    notes.push(
      `SCMDB could not be reached; the last copy kept on disk was used (${cleanLabel(loaded.stale, 120)}).`,
    );
  if (!facts) {
    notes.push(
      "No ship given (ship_name or cargo_scu): the fit of each contract to your hold and containers is unknown.",
    );
  }
  if (!a.rank) {
    notes.push(
      "No rank given: contracts above your Hauling rank are not filtered out (see rank.required).",
    );
  }
  if (result.matching_families === 0) {
    notes.push(
      "Nothing matches. Loosen the filters (include_unfit, include_illegal, system, rank).",
    );
  }

  const header = () => ({
    mode: "templates",
    what_this_is: NOT_LIVE_OFFERS,
    scmdb: {
      channel,
      build: loaded.version,
      file_version: dataset.data_version,
      note: "The build of the data file, which can differ from the build you play.",
    },
    ship: description,
    filters: {
      rank: result.rank_applied,
      system: a.system ?? "all",
      include_illegal: a.include_illegal === true,
      include_unfit: a.include_unfit === true,
    },
    sorted_by:
      (a.sort ?? "reward_per_scu") === "reward"
        ? "reward_auec, highest first"
        : "reward_per_scu.low (reward over the largest SCU), highest first, then .high",
    templates_in_file: result.total_templates,
    families: result.total_families,
    matching_families: result.matching_families,
    excluded: result.excluded,
    reward_per_hour: null,
    reward_per_hour_why:
      "A template has no concrete pickup and drop-off. Use mode offers with the offers you see in the mobiGlas.",
  });

  const tail = () => ({
    availability: dataset.availability_known
      ? "see the data"
      : "unknown: SCMDB says nothing about how often or where a template is offered",
    labels: LABELS_TEMPLATES,
    caveats: TEMPLATE_CAVEATS,
    ...(notes.length ? { notes } : {}),
  });

  const compact = (r: RankResult["rows"][number]) => ({
    id: r.id,
    title: r.title,
    contractor: r.contractor,
    reward_auec: r.reward_auec,
    scu: r.scu,
    reward_per_scu: r.reward_per_scu,
    fit: r.fit,
    rank: r.rank,
  });

  type Step = { n: number; lean: boolean };
  const steps: Step[] = [
    ...halvings(result.rows.length).map((n) => ({ n, lean: false })),
    ...(result.rows.length ? [{ n: Math.min(result.rows.length, 3), lean: true }] : []),
  ];
  return fitStepsOrMinimal(
    steps,
    (s, i) => {
      const rows = result.rows.slice(0, s.n);
      const used = new Set(rows.map((r) => r.partial_payout_index).filter((x) => x !== null));
      const tables = Object.fromEntries(
        Object.entries(result.payout_tables).filter(([k]) => used.has(Number(k))),
      );
      return {
        ...header(),
        ...(i > 0
          ? {
              truncated: `Cut to fit the output size: ${rows.length} of the ${result.rows.length} rows asked for.`,
            }
          : {}),
        shown: rows.length,
        rows: s.lean ? rows.map(compact) : rows,
        partial_payout_tables: s.lean ? {} : tables,
        partial_payout_tables_note:
          "Share of the reward paid when a contract ends with that percentage done; rows point to a table by partial_payout_index.",
        ...tail(),
      };
    },
    () =>
      out({
        mode: "templates",
        what_this_is: NOT_LIVE_OFFERS,
        truncated: "The answer was too large even with one row: narrow the filters.",
        matching_families: result.matching_families,
        reward_per_hour: null,
      }),
  );
}

// ---------------------------------------------------------------------------------------------- offers

async function offersMode(
  clients: { uexClient: HttpClient; scwClient: HttpClient },
  a: z.infer<typeof ArgsSchema>,
): Promise<ToolResult> {
  const offers: OfferInput[] = (a.offers ?? []).map((o) => ({
    title: o.title ? cleanLabel(o.title, 80) : null,
    reward: Math.round(o.reward),
    scu: o.scu,
    pickup: o.pickup,
    dropoffs: o.dropoffs,
    maxContainerSize: o.max_container_size ?? null,
  }));
  const sheet = await loadShip(clients, a.ship_name);
  const { facts, description } = shipFacts(sheet, a.cargo_scu, a.max_container_size);

  const terminalRows = unwrapData((await fetchWithCache(clients.uexClient, "/terminals")).data);
  const index = buildPlaceIndex(terminalRows.kind === "rows" ? terminalRows.rows : []);
  const notes: string[] = [];
  if (index.entries.length === 0) {
    notes.push("UEX returned no terminals, so no place could be resolved.");
  }

  // Resolve once (memoised), then read one orbit matrix per star system that was met.
  const memo = new Map<string, PlaceMatch>();
  const resolve = (q: string): PlaceMatch => {
    let m = memo.get(q);
    if (!m) {
      m = resolvePlace(index, q);
      memo.set(q, m);
    }
    return m;
  };
  const systemsMet = new Map<number, number>();
  for (const o of offers) {
    for (const q of [o.pickup, ...o.dropoffs]) {
      const m = resolve(q);
      if (m.status === "resolved" && m.system !== undefined) {
        systemsMet.set(m.system, (systemsMet.get(m.system) ?? 0) + 1);
      }
    }
  }
  const matrices = new Map<number, OrbitMatrix>();
  let matrixRequests = 0;
  for (const [system] of [...systemsMet]
    .sort((x, y) => y[1] - x[1] || x[0] - y[0])
    .slice(0, MAX_MATRICES)) {
    matrixRequests++;
    try {
      matrices.set(system, await fetchOrbitMatrix(clients.uexClient, system, system));
    } catch {
      notes.push(
        "An orbit distance matrix could not be read from UEX: places in that system have no distance and no time.",
      );
      break;
    }
  }

  const speed =
    a.quantum_speed_ms !== undefined
      ? validQuantumSpeed(a.quantum_speed_ms)
      : (sheet?.quantum_speed_ms ?? null);
  if (a.quantum_speed_ms !== undefined && speed === null) {
    throw new UserError(
      "quantum_speed_ms must be between 1,000,000 and 299,792,458 m/s (a quantum drive, in metres per second).",
    );
  }
  const model: TravelModel = {
    quantumSpeedMs: speed,
    spoolSeconds: sheet?.spool_seconds ?? DEFAULT_SPOOL_SECONDS,
    stopSeconds: Math.round(a.stop_minutes ?? DEFAULT_STOP_SECONDS / 60) * 60,
    localHopSeconds: LOCAL_HOP_SECONDS,
  };
  if (speed === null) {
    notes.push(
      "No quantum speed known (give ship_name with a wiki sheet, or quantum_speed_ms): only trips inside one orbit get a time.",
    );
  }
  if (!facts) {
    notes.push(
      "No ship given (ship_name or cargo_scu): offers are not combined and the fit to your hold is unknown.",
    );
  }

  const analysis = analyzeOffers(offers, {
    resolve,
    distance: (x, y) => orbitDistance(x, y, matrices),
    model,
    ship: facts,
  });

  const upstream = 1 + matrixRequests + (a.ship_name ? 2 : 0);
  const header = () => ({
    mode: "offers",
    what_this_is:
      "Offers are what you typed from the mobiGlas. The server cannot see or verify the offers on offer; SCMDB holds templates, not live offers.",
    ship: description,
    time_model: {
      estimate: true,
      stop_minutes: Math.round(model.stopSeconds / 60),
      local_hop_minutes: Math.round(model.localHopSeconds / 60),
      quantum_speed_ms: model.quantumSpeedMs,
      spool_seconds: model.spoolSeconds,
    },
    upstream_requests_at_most: upstream,
  });
  const tail = () => ({
    assumptions: OFFER_ASSUMPTIONS,
    labels: LABELS_OFFERS,
    ...(notes.length ? { notes } : {}),
  });

  const lean = (o: OffersAnalysis["offers"][number]) => ({
    n: o.n,
    title: o.title,
    reward_auec: o.reward_auec,
    scu: o.scu,
    pickup: o.pickup.label ?? o.pickup.asked,
    pickup_status: o.pickup.status,
    dropoffs: o.dropoffs.map((d) => d.label ?? d.asked),
    fit: o.fit,
    minutes: o.alone.minutes,
    reward_per_hour: o.alone.reward_per_hour,
    ...(o.alone.reason ? { reason: o.alone.reason } : {}),
  });

  type Step = { bundles: number; lean: boolean };
  const steps: Step[] = [
    ...halvings(Math.max(analysis.bundles.length, 1)).map((n) => ({ bundles: n, lean: false })),
    { bundles: 0, lean: false },
    { bundles: 0, lean: true },
  ];
  return fitStepsOrMinimal(
    steps,
    (s, i) => ({
      ...header(),
      ...(i > 0
        ? { truncated: "Cut to fit the output size: some bundles or details were left out." }
        : {}),
      offers: s.lean ? analysis.offers.map(lean) : analysis.offers,
      best_single_offer: analysis.best_single,
      bundles: analysis.bundles.slice(0, s.bundles),
      bundles_shown: Math.min(s.bundles, analysis.bundles.length),
      bundles_evaluated: analysis.bundles_evaluated,
      bundles_note: analysis.bundles_note,
      ...tail(),
    }),
    () =>
      out({
        mode: "offers",
        truncated: "The answer was too large: give fewer offers or fewer drop-offs.",
        what_this_is: NOT_LIVE_OFFERS,
      }),
  );
}

export function scmdbHaulingTools(clients: {
  scmdb: Scmdb;
  uexClient: HttpClient;
  scwClient: HttpClient;
}): ToolDefinition[] {
  return [
    {
      name: "scmdb_rank_hauling",
      description:
        "Rank hauling contracts for a ship from SCMDB's datamined list, or price concrete offers you read in the mobiGlas. SCMDB holds contract TEMPLATES, not what is offered now: never tell the player a contract is available. mode templates: families with the fixed reward, the SCU range, reward per SCU as a RANGE, rank, container fit and trips for the ship (ship_name or cargo_scu); illegal ones excluded by default; no time (no pickup or drop-off is known). mode offers: give 1 to 10 offers (reward, scu, pickup, dropoffs); UEX places give estimated minutes and reward per hour, bundles that share a pickup orbit, and the comparison with the best single offer. Times are estimates (8 min a stop, unmeasured); no crossing between systems. Titles are third-party text.",
      inputSchema: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["templates", "offers"],
            description:
              "templates (default): datamined contract families. offers: price the offers given in `offers` (used by default when `offers` is present).",
          },
          ship_name: {
            type: "string",
            description:
              "Ship (e.g. 'Cutlass Black'): hold and container sizes from UEX, quantum speed from the wiki. Use sc_fleet_get for the player's ships.",
          },
          cargo_scu: {
            type: "number",
            description:
              "Hold size in SCU (wins over the ship's), e.g. when only part of it is free.",
          },
          max_container_size: {
            type: "number",
            description: "Largest container size in SCU the ship takes (wins over UEX's list).",
          },
          quantum_speed_ms: {
            type: "number",
            description: "offers: quantum speed in m/s when there is no ship_name.",
          },
          stop_minutes: {
            type: "number",
            description: "offers: assumed minutes per stop (default 8, an unmeasured assumption).",
          },
          rank: {
            type: "string",
            description:
              "templates: the player's Hauling rank (Trainee, Rookie, Junior, Member, Experienced, Senior or Master): contracts outside it are left out. Omit to keep all.",
          },
          system: {
            type: "string",
            description:
              "templates: keep contracts that run in this system ('Stanton', 'Pyro', 'Nyx').",
          },
          include_illegal: {
            type: "boolean",
            description: "templates: also show illegal contracts (default false).",
          },
          include_unfit: {
            type: "boolean",
            description:
              "templates: also show contracts whose containers are too big for the ship, flagged (default false).",
          },
          sort: {
            type: "string",
            enum: ["reward_per_scu", "reward"],
            description:
              "templates: reward_per_scu (default; by the low end of the range) or reward.",
          },
          max_results: {
            type: "number",
            description: "templates: families to return (default 10, max 20).",
          },
          channel: {
            type: "string",
            enum: ["live", "ptu"],
            description: "templates: game channel, 'live' (default) or 'ptu'.",
          },
          offers: {
            type: "array",
            description:
              "offers: 1 to 10 offers as seen in the mobiGlas (2 or more to compare and bundle).",
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Optional title, for your own reference." },
                reward: { type: "number", description: "Reward in aUEC." },
                scu: { type: "number", description: "Cargo quantity in SCU." },
                pickup: {
                  type: "string",
                  description: "Pickup place name (e.g. 'Port Tressler').",
                },
                dropoffs: {
                  type: "array",
                  items: { type: "string" },
                  description: "1 to 6 drop-off place names.",
                },
                max_container_size: {
                  type: "number",
                  description: "Optional: the largest container size in SCU the offer uses.",
                },
              },
              required: ["reward", "scu", "pickup", "dropoffs"],
            },
          },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const a = ArgsSchema.parse(args || {});
        const mode = a.mode ?? (a.offers ? "offers" : "templates");
        try {
          if (mode === "offers") {
            if (!a.offers)
              throw new UserError("mode offers needs `offers`: 1 to 10 offers from the mobiGlas.");
            return await offersMode(clients, a);
          }
          if (a.offers) throw new UserError("`offers` is only used by mode offers.");
          return await templatesMode(clients, a);
        } catch (error) {
          if (error instanceof UserError) throw new Error(error.message, { cause: error });
          throw error;
        }
      },
    },
  ];
}
