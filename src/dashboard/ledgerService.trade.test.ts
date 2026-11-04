import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GameLog } from "../providers/gamelog/reader.js";
import { LedgerService, ledgerLogFrom } from "./ledgerService.js";
import {
  cargoBuyLine,
  cargoErrorLine,
  cargoSellLine,
  LARANITE_ID,
  TRADE_FIGURES as F,
} from "./testing/tradeScenario.js";

/**
 * The ledger's own reads (full, then incremental) also feed the commerce model: the Game.log commerce lines are parsed
 * by providers/gamelog/trade.ts, the journal pairs them, and `trades()` hands the transactions over. Made-up lines in a
 * temporary folder, no real log.
 */

const BASE = Date.UTC(2026, 10, 3, 18, 0, 0);
const HEADER = `<${new Date(BASE).toISOString()}> Log started on Tue Nov  3 18:00:00 2026\n<${new Date(BASE).toISOString()}> FileVersion: 9.9.1.2222\n`;
const junk = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `<${new Date(BASE + 900_000).toISOString()}> [Info] filler ${i} ${"x".repeat(80)}\n`,
  ).join("");

let dir: string;
let file: string;
let tick = 0;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-trade-"));
  file = path.join(dir, "Game.log");
  tick = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function write(text: string, mode: "set" | "append" = "append") {
  if (mode === "set") fs.writeFileSync(file, text);
  else fs.appendFileSync(file, text);
  tick += 1;
  const d = new Date(Date.UTC(2026, 10, 3, 19, 0, 0) + tick * 1000);
  fs.utimesSync(file, d, d);
}

function setup() {
  const clock = { now: 0 };
  const service = new LedgerService(ledgerLogFrom(new GameLog({ logPath: file })), () => clock.now);
  const refresh = async () => {
    clock.now += 5000;
    service.state();
    await service.settled();
    return service;
  };
  return { service, refresh };
}

describe("Feature: the commerce lines of the log feed the trade model", () => {
  it("Given a log with a run and lines after it, Then the first read gives the journal's transactions", async () => {
    write(
      HEADER +
        cargoBuyLine(BASE, 20, F.buys[0], 640) +
        "\n" +
        cargoBuyLine(BASE, 22, F.buys[1], 56) +
        "\n" +
        cargoSellLine(BASE, 200, F.sells[0], 640) +
        "\n" +
        junk(5),
      "set",
    );
    const { service, refresh } = setup();
    expect(service.trades()).toBeUndefined(); // not read yet: no journal is not an empty journal
    await refresh();
    const t = service.trades()!;
    expect(t.map((x) => [x.side, x.total_auec, x.quantity, x.commodity_id, x.status])).toEqual([
      ["buy", 120_923, 640, LARANITE_ID, "completed"],
      ["buy", 10_581, 56, LARANITE_ID, "completed"],
      ["sell", 292_480, 640, LARANITE_ID, "completed"],
    ]);
    expect(t.every((x) => x.currency === "aUEC" && x.auto_loading === true)).toBe(true);
  });

  it("Given new commerce lines added later, Then only the added bytes are parsed and the journal grows, without duplicates", async () => {
    write(HEADER + junk(4000) + cargoBuyLine(BASE, 20, F.buys[0], 640) + "\n", "set");
    const { service, refresh } = setup();
    await refresh();
    expect(service.trades()).toHaveLength(1);
    expect([service.fullReads, service.incrementalReads]).toEqual([1, 0]);
    write(cargoSellLine(BASE, 200, F.sells[0], 640) + "\n" + junk(3));
    await refresh();
    expect([service.fullReads, service.incrementalReads]).toEqual([1, 1]);
    expect(service.bytesParsed).toBeLessThan(fs.statSync(file).size / 4);
    expect(service.trades()!.map((x) => x.side)).toEqual(["buy", "sell"]);
    // The same lines seen again by the look-behind are not counted twice.
    write(junk(2));
    await refresh();
    expect(service.trades()).toHaveLength(2);
  });

  it("Given a cargo error line, Then the failed request is listed as failed, exactly as the journal says", async () => {
    write(
      HEADER +
        cargoBuyLine(BASE, 20, 50_000, 100) +
        "\n" +
        cargoErrorLine(BASE, 21) +
        "\n" +
        cargoBuyLine(BASE, 60, F.buys[0], 640) +
        "\n" +
        junk(3),
      "set",
    );
    const { service, refresh } = setup();
    await refresh();
    expect(service.trades()!.map((x) => x.status)).toEqual(["failed", "completed"]);
  });

  it("Given no game log configured, Then there is no journal at all", () => {
    const service = new LedgerService(undefined);
    expect(service.trades()).toBeUndefined();
  });
});
