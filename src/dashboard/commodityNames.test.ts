/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpClient } from "../core/http.js";
import { clearCache, configureDiskCache } from "../core/cache.js";
import {
  COMMODITY_MAX_WANTED,
  COMMODITY_RETRY_MS,
  CommodityNameResolver,
} from "./commodityNames.js";
import { buildTradeSection } from "./tradeRun.js";
import {
  LARANITE_GUID,
  LARANITE_ID,
  journalTransactions,
  tradeLines,
} from "./testing/tradeScenario.js";
import { ledgerTradeNormalize } from "./ledgerPanel.js";

/**
 * The names of the goods for the dashboard: a background lookup in the wiki's public list, never awaited by the poll,
 * never repeated within five minutes, bounded. The journal itself names only a GUID.
 */

const OTHER = "b81d3f07-1111-4222-8333-555555555555";
let base = 0;

function wiki(rows: { uuid: string; name: string }[] | Error) {
  const get = vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return { data: { data: rows, meta: { last_page: 1 } } };
  });
  // A fresh base URL per test: the shared cache of core/cache.ts is keyed by it.
  const client = {
    defaults: { baseURL: `https://wiki${++base}.test` },
    get,
  } as unknown as HttpClient;
  return { client, get };
}

beforeEach(() => {
  clearCache();
  configureDiskCache(null);
});

describe("Feature: the names of goods, looked up in the background", () => {
  it("Given an unknown GUID, Then the first answer is empty, one lookup runs, and the next answer has the name", async () => {
    const { client, get } = wiki([{ uuid: LARANITE_GUID.toUpperCase(), name: "Laranite" }]);
    const r = new CommodityNameResolver(client);
    expect(r.current([LARANITE_GUID]).size).toBe(0);
    expect(get).toHaveBeenCalledTimes(1);
    await r.idle();
    expect(r.current([LARANITE_GUID]).get(LARANITE_GUID)).toBe("Laranite");
    // known: no further request
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("Given a GUID the wiki does not know or an outage, Then it is not asked again within five minutes, then it is", async () => {
    let t = 1_000;
    const { client, get } = wiki(new Error("boom"));
    const r = new CommodityNameResolver(client, () => t);
    r.current([LARANITE_GUID]);
    await r.idle();
    expect(r.current([LARANITE_GUID]).size).toBe(0);
    t += COMMODITY_RETRY_MS - 1;
    r.current([LARANITE_GUID]);
    await r.idle();
    expect(get).toHaveBeenCalledTimes(1);
    t += 2;
    r.current([LARANITE_GUID]);
    await r.idle();
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("Given many GUIDs at once, Then one lookup at a time and at most 16 GUIDs are asked for", async () => {
    const guid = (i: number) =>
      `${"0".repeat(8 - String(i).length)}${i}-1111-4222-8333-444444444444`;
    const many = Array.from({ length: 40 }, (_, i) => guid(i));
    // the wiki knows GUID 3 (first batch) and GUID 20 (second batch)
    const { client, get } = wiki([
      { uuid: guid(3), name: "Three" },
      { uuid: guid(20), name: "Twenty" },
    ]);
    const r = new CommodityNameResolver(client);
    r.current(many);
    r.current(many); // a second call while the first is in flight starts nothing
    expect(get).toHaveBeenCalledTimes(1);
    await r.idle();
    // only the first 16 were asked for
    expect(r.current([]).get(guid(3))).toBe("Three");
    expect(r.current([]).has(guid(20))).toBe(false);
    // the 16 asked are not asked again; the next 16 are
    r.current(many);
    await r.idle();
    expect(r.current([]).get(guid(20))).toBe("Twenty");
    expect(COMMODITY_MAX_WANTED).toBe(16);
  });

  it("Given a name from the wiki, Then the run carries it as commodity_name, the id stays and is never the name", async () => {
    const { client } = wiki([{ uuid: LARANITE_GUID, name: "Laranite" }]);
    const r = new CommodityNameResolver(client);
    const base0 = Date.UTC(2026, 10, 3, 18, 0, 0);
    const tx = journalTransactions(tradeLines(base0).slice(0, 2), base0 + 3_600_000);
    r.current(tx.map((x) => x.resource!));
    await r.idle();
    const section = (names?: ReadonlyMap<string, string>) =>
      ledgerTradeNormalize(
        JSON.parse(
          JSON.stringify(
            buildTradeSection({
              transactions: tx,
              history: [],
              includeBalance: false,
              nowMs: base0 + 400_000,
              ...(names ? { commodityNames: names } : {}),
            }),
          ),
        ),
      );
    const named = section(r.current([]));
    expect(named.runs[0].commodity_name).toBe("Laranite");
    expect(named.runs[0].commodity).toBe(LARANITE_ID);
    // without names: no field, nothing else changes
    expect(section().runs[0].commodity_name).toBe("");
    expect(section().runs[0].commodity).toBe(LARANITE_ID);
  });
});
