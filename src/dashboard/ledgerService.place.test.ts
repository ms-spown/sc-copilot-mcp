/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GameLog } from "../providers/gamelog/reader.js";
import { createTelemetry } from "../providers/telemetry/index.js";
import { dashboardTools } from "../tools/dashboard.js";
import { LedgerService, ledgerLogFrom } from "./ledgerService.js";
import { buildLedgerPayload, EMPTY_LEDGER } from "./ledger.js";

/**
 * The newest place the game log named, for "Partir de ma position": only a PUBLIC place family (never a hangar, apartment or
 * home, which can be named after a player), with its own time; the newest record decides. Made-up lines, a temporary folder.
 */

const BASE = Date.UTC(2026, 10, 3, 18, 0, 0);
const iso = (s: number) => new Date(BASE + s * 1000).toISOString();
const HEADER = `<${iso(0)}> Log started on Tue Nov  3 18:00:00 2026\n<${iso(0)}> FileVersion: 9.9.1.2222\n`;
const where = (s: number, token: string) =>
  `<${iso(s)}> [Notice] <RequestLocationInventory> Player[testplayer] requested inventory for Location[${token}] [Team_X][Inventory]\n`;

let dir: string;
let file: string;
let tick = 0;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-place-"));
  file = path.join(dir, "Game.log");
  tick = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function read(text: string) {
  fs.writeFileSync(file, text);
  tick += 1;
  const d = new Date(Date.UTC(2026, 10, 3, 19, 0, 0) + tick * 1000);
  fs.utimesSync(file, d, d);
  const clock = { now: 5000 };
  const service = new LedgerService(ledgerLogFrom(new GameLog({ logPath: file })), () => clock.now);
  service.state();
  await service.settled();
  return service;
}

describe("Feature: the last place the game log named", () => {
  it("Given an inventory request for a public place, Then the server has its token, words and the log's own time", async () => {
    const service = await read(HEADER + where(60, "Stanton1_Lorville"));
    expect(service.lastPlace()).toEqual({
      token: "Stanton1_Lorville",
      words: "Stanton1 Lorville",
      at: iso(60),
    });
  });

  it("Given several places, Then the newest is the one given", async () => {
    const service = await read(
      HEADER +
        where(60, "Stanton1_Lorville") +
        where(300, "OOC_Stanton_3a_Lyria") +
        where(200, "Stanton2_Area18"),
    );
    // The log is written in time order; the newest RECORD (last in the file) is the one that counts.
    expect(service.lastPlace()).toMatchObject({ token: "Stanton2_Area18" });
  });

  it("Given the newest place is private (a hangar named after a player), Then only its TIME is given: no token, no words, and an older public place is not used", async () => {
    const service = await read(
      HEADER + where(60, "Stanton1_Lorville") + where(300, "Hangar_SomePlayerName_Home"),
    );
    expect(service.lastPlace()).toEqual({ private: true, at: iso(300) });
    expect(JSON.stringify(service.lastPlace())).not.toMatch(/Hangar|SomePlayer|Lorville/);
  });

  it("Given an apartment, a home or a token that is no place family, Then it is never a place (only its time)", async () => {
    for (const token of [
      "Apartment_SomePlayer_Home",
      "Orison_Hangar_SomePlayer",
      "Whatever_Thing",
      "Stanton1_Lorville_Room",
    ]) {
      const service = await read(HEADER + where(60, token));
      expect(service.lastPlace(), token).toEqual({ private: true, at: iso(60) });
    }
  });

  it("Given a private word inside a segment (PlayerHangar, JohnsHome), Then it is private too: only its time", async () => {
    for (const token of [
      "Orison_PlayerHangar",
      "Stanton1_Lorville_JohnsHome",
      "Stanton1_Lorville_CrewQuarters",
    ]) {
      const service = await read(HEADER + where(60, token));
      expect(service.lastPlace(), token).toEqual({ private: true, at: iso(60) });
    }
  });

  it("Given a deep token, Then the words keep the family and at most two more segments (a name further in never reaches a View)", async () => {
    const service = await read(
      HEADER + where(60, "Stanton1_Lorville_Tressler_Counter_Spown_Extra"),
    );
    const p = service.lastPlace() as { token: string; words: string };
    expect(p.words).toBe("Stanton1 Lorville Tressler");
    expect(p.words).not.toMatch(/Counter|Spown|Extra/);
    // The server keeps the whole token for the resolver; only the words are cut.
    expect(p.token).toBe("Stanton1_Lorville_Tressler_Counter_Spown_Extra");
    const ooc = await read(HEADER + where(60, "OOC_Stanton_3a_Lyria_Spown"));
    expect((ooc.lastPlace() as { words: string }).words).toBe("Stanton 3a Lyria");
  });

  it("Given a log with no inventory request, Then there is none", async () => {
    const service = await read(HEADER);
    expect(service.lastPlace()).toBeUndefined();
  });
});

describe("Feature: the wiring from the log to the poll and to the search", () => {
  const telemetry = { ...createTelemetry({ enabled: false }), enabled: true };
  const logWith = (text: string) => {
    fs.writeFileSync(file, text);
    return new GameLog({ logPath: file });
  };
  const waitForLedger = async (poll: () => Promise<any>) => {
    for (let i = 0; i < 40; i++) {
      const p = await poll();
      if (p.structuredContent?.ledger?.status === "ok") return p;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("the ledger never became ok");
  };

  it("Given a public place in the log, Then sc_live_poll carries trade.last_place with words and time only (never the token)", async () => {
    const tools = dashboardTools({
      telemetry,
      gameLog: logWith(HEADER + where(60, "Stanton1_Lorville")),
    });
    const poll = tools.find((t) => t.name === "sc_live_poll")!;
    const out = await waitForLedger(() => poll.handler({}) as any);
    expect(out.structuredContent.ledger.trade.last_place).toEqual({
      words: "Stanton1 Lorville",
      at: iso(60),
    });
    expect(JSON.stringify(out.structuredContent)).not.toContain("Stanton1_Lorville");
  });

  it("Given a private newest place, Then the poll carries its time only, with no words", async () => {
    const tools = dashboardTools({
      telemetry,
      gameLog: logWith(
        HEADER + where(60, "Stanton1_Lorville") + where(120, "Hangar_Somebody_Home"),
      ),
    });
    const poll = tools.find((t) => t.name === "sc_live_poll")!;
    const out = await waitForLedger(() => poll.handler({}) as any);
    expect(out.structuredContent.ledger.trade.last_place).toEqual({
      words: "",
      at: iso(120),
      private: true,
    });
    expect(JSON.stringify(out.structuredContent)).not.toMatch(/Somebody|Hangar_/);
  });

  it("Given a search from the journal, Then the server's own ledger gives the planner the token", async () => {
    const seen: unknown[] = [];
    let clockTick = 0;
    const log = logWith(HEADER + where(60, "Stanton1_Lorville"));
    const tools = dashboardTools(
      { telemetry, gameLog: log },
      {
        // A clock that moves on (the poll's own cache is keyed by it); ten minutes after the place was named.
        now: () => BASE + 600_000 + 1000 * clockTick++,
        plan: async (req) => {
          seen.push(req.position);
          throw new Error("stop here");
        },
      },
    );
    // Let the ledger read the file first (the poll starts it).
    const poll = tools.find((t) => t.name === "sc_live_poll")!;
    await waitForLedger(() => poll.handler({}) as any);
    const suggest = tools.find((t) => t.name === "sc_trade_suggest")!;
    await suggest.handler({ action: "search", position: "journal", cargo_scu: 100 });
    expect(seen).toEqual([{ token: "Stanton1_Lorville" }]);
  });
});

describe("Feature: the page receives words and a time, never the token", () => {
  it("Given a place, Then the trade section carries last_place with words and time, and nothing else of it", () => {
    const payload = buildLedgerPayload({
      base: { ...EMPTY_LEDGER, status: "ok", asOf: BASE },
      history: [],
      includeBalance: false,
      nowMs: BASE,
      trades: [],
      lastPlace: { words: "Stanton1 Lorville", at: iso(60) },
    });
    expect(payload.trade?.last_place).toEqual({ words: "Stanton1 Lorville", at: iso(60) });
    expect(JSON.stringify(payload)).not.toContain("Stanton1_Lorville");
  });

  it("Given no place, Then the section has no last_place", () => {
    const payload = buildLedgerPayload({
      base: { ...EMPTY_LEDGER, status: "ok", asOf: BASE },
      history: [],
      includeBalance: false,
      nowMs: BASE,
      trades: [],
    });
    expect(payload.trade?.last_place).toBeUndefined();
  });
});
