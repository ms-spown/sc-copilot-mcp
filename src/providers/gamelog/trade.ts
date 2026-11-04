/**
 * Trade journal, built only from what the player's own Game.log says about commerce.
 *
 * Pure: log text or one line in, typed records out; records in, journal out. No file, no network.
 *
 * Line shapes were checked on real logs from a LIVE install (builds 4.0 to 4.10, March 2025 to
 * November 2026). What the log does NOT contain, and this module therefore never invents: the
 * wallet balance, a success line for cargo trades (only failures are logged), the autoload fee,
 * a terminal id, a commodity name next to its GUID, a per-unit price for cargo SELLS (only the
 * line total). The player's id, the shop id, the kiosk id and the player's handle are not
 * captured by any pattern here.
 */

export type Side = "buy" | "sell";

/** What the game wrote, one record per line, in log order. Nothing personal is kept. */
export type TradeRecord =
  | {
      kind: "item_request";
      time: string;
      side: Side;
      /** "shop" = the shop UI (no currency field), "standard" = the small-kiosk flow (carries currencyType). */
      provider: "shop" | "standard";
      shop: string | null;
      item: string;
      quantity: number;
      /** The TOTAL of the line (client_price), not a unit price. */
      total: number;
      currency: string | null;
    }
  | {
      kind: "item_response";
      time: string;
      provider: "shop" | "standard";
      shop: string | null;
      state: string | null;
      result: string;
      type: string | null;
    }
  | {
      kind: "cargo_request";
      time: string;
      side: Side;
      shop: string | null;
      /** The commodity's resourceGUID, lower case. The log has no name next to it. */
      resource: string;
      /** Always in SCU (a cSCU quantity on a buy is converted here). */
      scu: number;
      /** price (buy) or amount (sell): the TOTAL of the line. */
      total: number;
      /** shopPricePerCentiSCU x 100, a buy only. */
      shop_unit_price_scu: number | null;
      auto_loading: boolean | null;
      transaction_mode: string | null;
    }
  | { kind: "cargo_error"; time: string; result: string; type: string | null }
  | { kind: "location"; time: string; token: string };

/** `name[value]`, with a boundary so `price` does not match inside `client_price`. */
export function bracketField(text: string, name: string): string | null {
  const m = text.match(new RegExp(`(?<![A-Za-z0-9_])${name}\\[([^\\]]*)\\]`));
  return m ? m[1] : null;
}

const TAG =
  /<(?:([A-Za-z]+)::)?(SendShopBuyRequest|SendStandardItemBuyRequest|SendShopSellRequest|SendCommodityBuyRequest|SendCommoditySellRequest|RmShopFlowResponse|RmToken_CommodityTransactionResponse|RequestLocationInventory)>/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A location token is a place name; a run of 5+ digits would be an entity id, so it is refused.
const TOKEN = /^(?!.*\d{5})[A-Za-z0-9_]{1,80}$/;
const WORD = /^[A-Za-z0-9_.-]{1,120}$/;

const num = (s: string | null): number | null => {
  if (s === null || s.trim() === "") return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
};
const word = (s: string | null): string | null => (s !== null && WORD.test(s) ? s : null);

/**
 * One log line (the part after the timestamp) to a record, or null. The `ts` is the line's
 * own UTC time: a line without one is not a record.
 */
export function parseCommerceLine(body: string, ts: string | null): TradeRecord | null {
  // Cheap guard: the dashboard re-reads the log every few seconds.
  if (
    ts === null ||
    (!body.includes("Shop") &&
      !body.includes("Commodity") &&
      !body.includes("RequestLocationInventory"))
  ) {
    return null;
  }
  const m = body.match(TAG);
  if (!m) return null;
  const owner = m[1] ?? "";
  const name = m[2];
  const provider: "shop" | "standard" = owner.includes("ShoppingProvider") ? "standard" : "shop";

  switch (name) {
    case "SendShopBuyRequest":
    case "SendStandardItemBuyRequest":
    case "SendShopSellRequest": {
      const item = word(bracketField(body, "itemName"));
      const total = num(bracketField(body, "client_price"));
      const quantity = num(bracketField(body, "quantity"));
      if (!item || total === null || total < 0 || quantity === null || quantity <= 0) return null;
      return {
        kind: "item_request",
        time: ts,
        side: name === "SendShopSellRequest" ? "sell" : "buy",
        provider: name === "SendStandardItemBuyRequest" ? "standard" : "shop",
        shop: word(bracketField(body, "shopName")),
        item,
        quantity,
        total,
        currency: word(bracketField(body, "currencyType")),
      };
    }
    case "RmShopFlowResponse": {
      const result = word(bracketField(body, "result"));
      if (!result) return null;
      return {
        kind: "item_response",
        time: ts,
        provider,
        shop: word(bracketField(body, "shopName")),
        state: word(bracketField(body, "kioskState")),
        result,
        type: word(bracketField(body, "type")),
      };
    }
    case "SendCommodityBuyRequest":
    case "SendCommoditySellRequest": {
      const buy = name === "SendCommodityBuyRequest";
      const resource = bracketField(body, "resourceGUID");
      const total = num(bracketField(body, buy ? "price" : "amount"));
      const q = (bracketField(body, "quantity") ?? "").match(/^\s*([\d.]+)\s*(cSCU|SCU)?\s*$/);
      if (!resource || !GUID.test(resource) || total === null || total < 0 || !q) return null;
      const raw = Number(q[1]);
      // A buy states its unit (cSCU, 1/100 SCU). A sell is a plain number of SCU (checked against
      // the box lists). A buy with no unit is refused rather than guessed.
      let scu: number;
      if (q[2] === "cSCU") scu = raw / 100;
      else if (q[2] === "SCU" || (!q[2] && !buy)) scu = raw;
      else return null;
      if (!Number.isFinite(scu) || scu <= 0) return null;
      const perCenti = num(bracketField(body, "shopPricePerCentiSCU"));
      const auto = bracketField(body, "autoLoading");
      return {
        kind: "cargo_request",
        time: ts,
        side: buy ? "buy" : "sell",
        shop: word(bracketField(body, "shopName")),
        resource: resource.toLowerCase(),
        scu,
        total,
        shop_unit_price_scu:
          buy && perCenti !== null ? Math.round(perCenti * 100 * 100) / 100 : null,
        auto_loading: auto === "1" ? true : auto === "0" ? false : null,
        transaction_mode: word(bracketField(body, "transactionMode")),
      };
    }
    case "RmToken_CommodityTransactionResponse": {
      const result = word(bracketField(body, "result"));
      if (!result) return null;
      return { kind: "cargo_error", time: ts, result, type: word(bracketField(body, "type")) };
    }
    case "RequestLocationInventory": {
      // The line also carries the player's handle (Player[...]): only the location is read.
      const token = bracketField(body, "Location");
      return token && TOKEN.test(token) ? { kind: "location", time: ts, token } : null;
    }
    default:
      return null;
  }
}

/** Every commerce record of a log text, in order. */
export function parseCommerceText(text: string): TradeRecord[] {
  const out: TradeRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const ts = line.match(/^<(\d{4}-\d{2}-\d{2}T[\d:.]+Z)>/)?.[1] ?? null;
    if (!ts) continue;
    const r = parseCommerceLine(line.slice(line.indexOf(">") + 1), ts);
    if (r) out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Journal

export type Category = "food" | "weapon" | "armor" | "ship_component" | "other";

/**
 * INFERRED from the item's class name; the log has no category field. Documented in
 * docs/CAPABILITIES.md. A class name that fits no rule is "other" (tools, medical items,
 * cargo containers, hacking chips...).
 */
export function categorize(itemClass: string): Category {
  const c = itemClass;
  const l = c.toLowerCase();
  if (/^(food|drink)_/.test(l)) return "food";
  // Ship components: a four-capital-letter maker code, then the product ("HRST_LaserRepeater_S2").
  if (/^[A-Z]{4}_[A-Za-z]/.test(c)) return "ship_component";
  if (/(^|_)(armor|undersuit|backpack|helmet)(_|$)/.test(l)) return "armor";
  if (
    /(^|_)(rifle|smg|pistol|shotgun|sniper|lmg|gren|melee|optics|barrel|magazine|mag)(_|$)/.test(l)
  ) {
    return "weapon";
  }
  return "other";
}

/**
 * confirmed = the game said so; inferred = deduced from the absence of an error; unknown = no
 * outcome yet; ambiguous = an error line followed several same-side requests and cannot be
 * attributed to one of them.
 */
export type Confidence = "confirmed" | "inferred" | "unknown" | "ambiguous";
export type Status = "completed" | "failed" | "unconfirmed";

export interface Transaction {
  time: string;
  kind: "item" | "commodity";
  side: Side;
  status: Status;
  /** Why it failed or is excluded (a game result such as TransactionCostMismatch, or zero_amount). */
  reason?: string;
  confidence: Confidence;
  /** How the outcome was established. */
  basis:
    | "game_response"
    | "error_line"
    | "error_line_ambiguous"
    | "no_error_within_3s"
    | "zero_amount"
    | "no_response"
    | "log_ended_too_soon";
  shop: string | null;
  /** The TOTAL of the line, aUEC unless `currency` says otherwise. */
  total_auec: number;
  currency: string;
  quantity: number;
  unit: "item" | "SCU";
  /** total / quantity, when quantity is positive. For a cargo buy the shop's own per-SCU price is `shop_unit_price_scu`. */
  unit_price_auec: number | null;
  item?: string;
  category?: Category;
  /** Short stable id (first 8 characters of the resourceGUID); never a name guess. */
  commodity_id?: string;
  /** Full GUID, for name lookups by the caller; not meant for display. */
  resource?: string;
  shop_unit_price_scu?: number | null;
  /** autoLoading[1]: loaded by the autoload service. The log has no fee line. */
  auto_loading?: boolean | null;
  /** The last location token the game logged before the line: a hint, possibly stale, never a terminal. */
  location_hint?: { token: string; seconds_before: number } | null;
}

export interface CargoRun {
  commodity_id: string;
  resource: string;
  /** closed = every purchased SCU was sold in this session; open = some is still unsold. */
  state: "closed" | "open";
  from: string;
  to: string;
  buy_lines: number;
  sell_lines: number;
  bought_scu: number;
  sold_scu: number;
  /** min(bought, sold) matched first-in first-out: the only quantity the figures below cover. */
  paired_scu: number;
  unsold_scu: number;
  /** Sold SCU with no purchase in this session (bought earlier, or from a mission). Not valued. */
  sold_without_purchase_scu: number;
  cost_auec: number;
  revenue_auec: number;
  /** revenue - cost: GROSS. The autoload fee, fuel and every other cost are not in the log. */
  gross_margin_auec: number;
  gross_margin_per_scu_auec: number | null;
  estimated: true;
  confidence: Confidence;
}

type RunState = CargoRun & { lots: { scu: number; unit: number }[] };

export interface SessionJournal {
  transactions: Transaction[];
  spending_by_category: {
    category: Category;
    auec: number;
    lines: number;
    quantity: number;
    inferred: true;
  }[];
  cargo_runs: CargoRun[];
  totals: {
    items: { bought_auec: number; sold_auec: number; buy_lines: number; sell_lines: number };
    cargo: {
      bought_auec: number;
      bought_scu: number;
      sold_auec: number;
      sold_scu: number;
      buy_lines: number;
      sell_lines: number;
      autoload_lines: number;
    };
    /** `unconfirmed` includes the `ambiguous` ones. */
    excluded: { failed: number; unconfirmed: number; ambiguous: number; other_currency: number };
  };
}

const CARGO_ERROR_WINDOW_MS = 3000;
const ITEM_RESPONSE_WINDOW_MS = 15_000;
const EPS = 1e-6;
const r2 = (n: number) => Math.round(n * 100) / 100;
const ms = (t: string) => Date.parse(t);

/**
 * Records (in log order) to a session journal. Quadratic in the cargo lines of one commodity
 * (measured: 0.06 s for 10 000, 0.7 s for 20 000, 3.3 s for 40 000; the whole real corpus holds 79).
 */
export function buildTradeJournal(
  records: TradeRecord[],
  /** The last timestamp of the text: a cargo request within 3 s of it has not had time to fail. */
  lastTime: string | null,
): SessionJournal {
  const tx: Transaction[] = [];
  const pendingItems: { tx: Transaction; rec: Extract<TradeRecord, { kind: "item_request" }> }[] =
    [];
  const pendingCargo: { tx: Transaction; side: Side }[] = [];
  let location: { token: string; at: number } | null = null;

  const hint = (t: string) =>
    location
      ? {
          token: location.token,
          seconds_before: Math.max(0, Math.round((ms(t) - location.at) / 1000)),
        }
      : null;

  for (const r of records) {
    const at = ms(r.time);
    // Anything that waited too long is left as it is: unconfirmed.
    for (let i = pendingItems.length - 1; i >= 0; i--) {
      if (at - ms(pendingItems[i].rec.time) > ITEM_RESPONSE_WINDOW_MS) pendingItems.splice(i, 1);
    }
    for (let i = pendingCargo.length - 1; i >= 0; i--) {
      if (at - ms(pendingCargo[i].tx.time) > CARGO_ERROR_WINDOW_MS) pendingCargo.splice(i, 1);
    }

    switch (r.kind) {
      case "location":
        location = { token: r.token, at };
        break;
      case "item_request": {
        const aUec = r.currency === null || r.currency.toUpperCase() === "UEC";
        const t: Transaction = {
          time: r.time,
          kind: "item",
          side: r.side,
          status: "unconfirmed",
          confidence: "unknown",
          basis: "no_response",
          shop: r.shop,
          total_auec: r.total,
          currency: r.currency === null ? "not stated (assumed aUEC)" : aUec ? "aUEC" : r.currency,
          quantity: r.quantity,
          unit: "item",
          unit_price_auec: r2(r.total / r.quantity),
          item: r.item,
          category: categorize(r.item),
          location_hint: hint(r.time),
        };
        tx.push(t);
        pendingItems.push({ tx: t, rec: r });
        break;
      }
      case "item_response": {
        const type = r.type === "Selling" ? "sell" : r.type === "Buying" ? "buy" : null;
        const idx = pendingItems.findIndex(
          (p) =>
            p.rec.provider === r.provider &&
            (type === null || p.rec.side === type) &&
            (r.shop === null || p.rec.shop === r.shop),
        );
        if (idx < 0) break;
        const [p] = pendingItems.splice(idx, 1);
        p.tx.basis = "game_response";
        p.tx.confidence = "confirmed";
        if (r.result === "Success") p.tx.status = "completed";
        else {
          p.tx.status = "failed";
          p.tx.reason = r.result;
        }
        break;
      }
      case "cargo_request": {
        const zero = r.total <= 0;
        const t: Transaction = {
          time: r.time,
          kind: "commodity",
          side: r.side,
          status: "completed",
          confidence: "inferred",
          basis: "no_error_within_3s",
          shop: r.shop,
          total_auec: r.total,
          currency: "aUEC",
          quantity: r.scu,
          unit: "SCU",
          unit_price_auec: r2(r.total / r.scu),
          commodity_id: r.resource.slice(0, 8),
          resource: r.resource,
          shop_unit_price_scu: r.shop_unit_price_scu,
          auto_loading: r.auto_loading,
          location_hint: hint(r.time),
        };
        if (zero) {
          // Every sale seen with amount 0 was answered by InvalidQuantityError: it failed.
          t.status = "failed";
          t.reason = "zero_amount";
          t.basis = "zero_amount";
        } else if (lastTime && ms(lastTime) - at < CARGO_ERROR_WINDOW_MS) {
          t.status = "unconfirmed";
          t.confidence = "unknown";
          t.basis = "log_ended_too_soon";
        }
        tx.push(t);
        pendingCargo.push({ tx: t, side: r.side });
        break;
      }
      case "cargo_error": {
        const side = r.type === "Selling" ? "sell" : r.type === "Buying" ? "buy" : null;
        // Every same-side request still inside the 3 s window could be the one that failed.
        const candidates = pendingCargo.filter((p) => side === null || p.side === side);
        if (!candidates.length) break;
        // A zero-amount sale always fails: when exactly one candidate is one, the error is its.
        const zero = candidates.filter((p) => p.tx.reason === "zero_amount");
        const sole = zero.length === 1 ? zero[0] : candidates.length === 1 ? candidates[0] : null;
        if (sole) {
          sole.tx.status = "failed";
          sole.tx.reason = r.result;
          sole.tx.confidence = "confirmed";
          sole.tx.basis = "error_line";
        } else {
          // Several candidates: the error cannot be attributed with certainty, so none of them is
          // counted (a real failure and a success may both be among them).
          for (const p of candidates) {
            if (p.tx.status === "failed") continue;
            p.tx.status = "unconfirmed";
            p.tx.reason = `ambiguous: ${r.result} followed ${candidates.length} requests`;
            p.tx.confidence = "ambiguous";
            p.tx.basis = "error_line_ambiguous";
          }
        }
        for (const p of sole ? [sole] : candidates) pendingCargo.splice(pendingCargo.indexOf(p), 1);
        break;
      }
    }
  }

  return summarize(tx);
}

function summarize(tx: Transaction[]): SessionJournal {
  const totals: SessionJournal["totals"] = {
    items: { bought_auec: 0, sold_auec: 0, buy_lines: 0, sell_lines: 0 },
    cargo: {
      bought_auec: 0,
      bought_scu: 0,
      sold_auec: 0,
      sold_scu: 0,
      buy_lines: 0,
      sell_lines: 0,
      autoload_lines: 0,
    },
    excluded: { failed: 0, unconfirmed: 0, ambiguous: 0, other_currency: 0 },
  };
  const cats = new Map<Category, { auec: number; lines: number; quantity: number }>();

  for (const t of tx) {
    if (t.status === "failed") {
      totals.excluded.failed += 1;
      continue;
    }
    if (t.status === "unconfirmed") {
      totals.excluded.unconfirmed += 1;
      if (t.confidence === "ambiguous") totals.excluded.ambiguous += 1;
      continue;
    }
    if (t.kind === "item") {
      if (t.currency !== "aUEC" && !t.currency.startsWith("not stated")) {
        totals.excluded.other_currency += 1;
        continue;
      }
      if (t.side === "buy") {
        totals.items.bought_auec += t.total_auec;
        totals.items.buy_lines += 1;
        const c = cats.get(t.category ?? "other") ?? { auec: 0, lines: 0, quantity: 0 };
        c.auec += t.total_auec;
        c.lines += 1;
        c.quantity += t.quantity;
        cats.set(t.category ?? "other", c);
      } else {
        totals.items.sold_auec += t.total_auec;
        totals.items.sell_lines += 1;
      }
    } else if (t.side === "buy") {
      totals.cargo.bought_auec += t.total_auec;
      totals.cargo.bought_scu += t.quantity;
      totals.cargo.buy_lines += 1;
      if (t.auto_loading) totals.cargo.autoload_lines += 1;
    } else {
      totals.cargo.sold_auec += t.total_auec;
      totals.cargo.sold_scu += t.quantity;
      totals.cargo.sell_lines += 1;
      if (t.auto_loading) totals.cargo.autoload_lines += 1;
    }
  }
  totals.items.bought_auec = r2(totals.items.bought_auec);
  totals.items.sold_auec = r2(totals.items.sold_auec);
  totals.cargo.bought_auec = r2(totals.cargo.bought_auec);
  totals.cargo.sold_auec = r2(totals.cargo.sold_auec);
  totals.cargo.bought_scu = r2(totals.cargo.bought_scu);
  totals.cargo.sold_scu = r2(totals.cargo.sold_scu);

  return {
    transactions: tx,
    spending_by_category: [...cats]
      .map(([category, c]) => ({
        category,
        auec: r2(c.auec),
        lines: c.lines,
        quantity: c.quantity,
        inferred: true as const,
      }))
      .sort((a, b) => b.auec - a.auec),
    cargo_runs: pairCargoRuns(tx),
    totals,
  };
}

/**
 * Round trips: per commodity, purchases are matched first-in first-out with later sales. A run
 * opens with a purchase and closes when every purchased SCU has been sold. Only the paired
 * quantity is valued, so the margin is an estimate and always GROSS (the wallet is not in the log).
 */
export function pairCargoRuns(all: Transaction[]): CargoRun[] {
  const runs: CargoRun[] = [];
  const byCommodity = new Map<string, Transaction[]>();
  for (const t of all) {
    if (t.kind !== "commodity" || t.status !== "completed" || !t.resource) continue;
    byCommodity.set(t.resource, [...(byCommodity.get(t.resource) ?? []), t]);
  }

  for (const [resource, lines] of byCommodity) {
    let run = null as RunState | null;
    const close = () => {
      if (!run) return;
      const { lots, ...rest } = run;
      const unsold = lots.reduce((s, l) => s + l.scu, 0);
      rest.unsold_scu = r2(unsold);
      rest.state = unsold > EPS ? "open" : "closed";
      rest.bought_scu = r2(rest.bought_scu);
      rest.sold_scu = r2(rest.sold_scu);
      rest.paired_scu = r2(rest.paired_scu);
      rest.sold_without_purchase_scu = r2(rest.sold_without_purchase_scu);
      rest.cost_auec = r2(rest.cost_auec);
      rest.revenue_auec = r2(rest.revenue_auec);
      rest.gross_margin_auec = r2(rest.revenue_auec - rest.cost_auec);
      rest.gross_margin_per_scu_auec =
        rest.paired_scu > EPS ? r2(rest.gross_margin_auec / rest.paired_scu) : null;
      runs.push(rest);
      run = null;
    };
    const open = (t: Transaction): RunState => ({
      commodity_id: resource.slice(0, 8),
      resource,
      state: "open",
      from: t.time,
      to: t.time,
      buy_lines: 0,
      sell_lines: 0,
      bought_scu: 0,
      sold_scu: 0,
      paired_scu: 0,
      unsold_scu: 0,
      sold_without_purchase_scu: 0,
      cost_auec: 0,
      revenue_auec: 0,
      gross_margin_auec: 0,
      gross_margin_per_scu_auec: null,
      estimated: true,
      confidence: "inferred",
      lots: [],
    });

    for (const t of lines) {
      const cur: RunState = run ?? (run = open(t));
      cur.to = t.time;
      if (t.side === "buy") {
        cur.buy_lines += 1;
        cur.bought_scu += t.quantity;
        cur.lots.push({ scu: t.quantity, unit: t.total_auec / t.quantity });
      } else {
        cur.sell_lines += 1;
        cur.sold_scu += t.quantity;
        let remaining = t.quantity;
        while (remaining > EPS && cur.lots.length) {
          const lot = cur.lots[0];
          const take = Math.min(lot.scu, remaining);
          cur.cost_auec += take * lot.unit;
          cur.revenue_auec += t.total_auec * (take / t.quantity);
          cur.paired_scu += take;
          lot.scu -= take;
          remaining -= take;
          if (lot.scu <= EPS) cur.lots.shift();
        }
        if (remaining > EPS) cur.sold_without_purchase_scu += remaining;
        if (!cur.lots.length) close();
      }
    }
    close();
  }
  return runs.sort((a, b) => a.from.localeCompare(b.from));
}
