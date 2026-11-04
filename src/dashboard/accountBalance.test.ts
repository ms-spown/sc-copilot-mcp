/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { HIDDEN_MODES, SHOWN_MODES } from "../testing/balanceModes.js";
import { wantsBalance } from "../core/balance.js";
import type { SessionManager } from "../providers/sessions/manager.js";
import type { Telemetry } from "../providers/telemetry/index.js";
import {
  ACCOUNT_LIVE_MS,
  buildAccountBalance,
  newestSavedBalance,
  type SavedBalance,
} from "./accountBalance.js";
import { DashboardService } from "./service.js";
import { accountAgo, accountInfo, cleanPoll, contextSummary, sharablePoll } from "./viewLogic.js";

/**
 * The account balance reminder ("Solde" of the header), server side and pure View side. Synthetic readings only: an
 * invented balance of 8 675 309 aUEC, matched as a WHOLE figure (never as a substring of a time or an id).
 */

const NOW = Date.UTC(2026, 10, 4, 15, 0, 0);
const HOUR = 3_600_000;
const BAL = 8_675_309;
const WHOLE = /(?<![\d])8[\s\u00a0\u202f]?675[\s\u00a0\u202f]?309(?![\d])/;
const iso = (ms: number) => new Date(ms).toISOString();

const snap = (uec: number | string | undefined, ageMs: number) =>
  ({
    state: {
      pilot: { unverified: {}, ...(uec === undefined ? {} : { uec_balance: uec }) },
      derived: {},
      conditions: [],
      unverified: {},
    },
    frame_age_ms: ageMs,
    received_at: iso(NOW - ageMs),
  }) as never;

describe("Feature: where the account balance comes from, and nothing invented", () => {
  it("Given a live stream on the live channel, Then the reading is live, carries no time and no caveat", () => {
    const a = buildAccountBalance({
      status: { state: "live" },
      snapshot: snap(BAL, 200),
      connection: { state: "online" },
      channel: "live",
      nowMs: NOW,
    });
    expect(a).toEqual({ source: "live", uec: BAL });
  });

  it("Given a live stream whose channel could not be read, Then it is shown but flagged, never claimed as verified", () => {
    for (const channel of ["unknown", null, undefined] as const) {
      const a = buildAccountBalance({
        status: { state: "live" },
        snapshot: snap(BAL, 200),
        connection: { state: "online" },
        channel,
        nowMs: NOW,
      });
      expect(a).toEqual({ source: "live", uec: BAL, channel_unverified: true });
    }
    const kept = buildAccountBalance({
      status: { state: "waiting" },
      snapshot: snap(BAL, HOUR),
      nowMs: NOW,
    });
    expect(kept).toMatchObject({ source: "last_known", from: "stream", channel_unverified: true });
  });

  it("Given a stream that went quiet (the game closed), Then the kept frame is the last known balance with its time", () => {
    const a = buildAccountBalance({
      status: { state: "waiting" },
      snapshot: snap(BAL, 15 * HOUR),
      connection: { state: "closed" },
      channel: "live",
      nowMs: NOW,
    });
    expect(a).toEqual({
      source: "last_known",
      uec: BAL,
      at: iso(NOW - 15 * HOUR),
      from: "stream",
    });
  });

  it("Given a live frame but the log says the player is in the menus, Then it is not called live", () => {
    const a = buildAccountBalance({
      status: { state: "live" },
      snapshot: snap(BAL, 300),
      connection: { state: "menu" },
      nowMs: NOW,
    });
    expect(a.source).toBe("last_known");
  });

  it("Given a live state whose frame is older than the live window, Then it is the last known balance", () => {
    const a = buildAccountBalance({
      status: { state: "live" },
      snapshot: snap(BAL, ACCOUNT_LIVE_MS + 1000),
      nowMs: NOW,
    });
    expect(a.source).toBe("last_known");
  });

  it("Given no frame since the server started, Then the balance saved with a session is used, with its time", () => {
    const saved: SavedBalance = { auec: BAL, at: iso(NOW - 15 * HOUR) };
    const a = buildAccountBalance({
      status: { state: "waiting" },
      snapshot: null,
      saved,
      connection: { state: "closed" },
      nowMs: NOW,
    });
    expect(a).toEqual({ source: "last_known", uec: BAL, at: saved.at, from: "session" });
  });

  it("Given a kept frame and a saved balance, Then the newer reading wins", () => {
    const base = { status: { state: "waiting" as const }, nowMs: NOW };
    const olderFrame = buildAccountBalance({
      ...base,
      snapshot: snap(111_111, 20 * HOUR),
      saved: { auec: BAL, at: iso(NOW - 2 * HOUR) },
    });
    expect(olderFrame).toMatchObject({ uec: BAL, from: "session" });
    const newerFrame = buildAccountBalance({
      ...base,
      snapshot: snap(BAL, 1 * HOUR),
      saved: { auec: 111_111, at: iso(NOW - 6 * HOUR) },
    });
    expect(newerFrame).toMatchObject({ uec: BAL, from: "stream" });
  });

  it("Given nothing at all, Then it is unknown, with the reason (game closed, or just no reading)", () => {
    expect(
      buildAccountBalance({
        status: { state: "waiting" },
        snapshot: null,
        connection: { state: "closed" },
        nowMs: NOW,
      }),
    ).toEqual({ source: "unknown", reason: "game_closed" });
    expect(
      buildAccountBalance({
        status: { state: "game_without_telemetry" },
        snapshot: snap(undefined, 100),
        connection: { state: "online" },
        nowMs: NOW,
      }),
    ).toEqual({ source: "unknown", reason: "no_reading" });
  });

  it("Given a stream that only waits (the game may be open in its menus), Then it never says the game is closed", () => {
    for (const connection of [
      undefined,
      null,
      { state: "unknown" as const },
      { state: "menu" as const },
    ]) {
      expect(
        buildAccountBalance({
          status: { state: "waiting" },
          snapshot: null,
          connection,
          nowMs: NOW,
        }),
      ).toEqual({ source: "unknown", reason: "no_reading" });
    }
  });

  it("Given a game launched on the PTU, Then its stream is not presented as the account balance", () => {
    const base = {
      status: { state: "live" as const },
      connection: { state: "online" as const },
      nowMs: NOW,
    };
    // a live PTU frame, nothing saved: no balance, and the reason says why
    expect(buildAccountBalance({ ...base, snapshot: snap(BAL, 200), channel: "ptu" })).toEqual({
      source: "unknown",
      reason: "ptu",
    });
    // a saved live-channel balance is still the account's: shown as the last known one, never the PTU frame
    const saved: SavedBalance = { auec: 111_111, at: iso(NOW - 2 * HOUR) };
    expect(
      buildAccountBalance({ ...base, snapshot: snap(BAL, 200), saved, channel: "ptu" }),
    ).toEqual({ source: "last_known", uec: 111_111, at: saved.at, from: "session" });
    // the same frame on the live channel (or an unknown one) is live
    for (const channel of ["live", "unknown", null, undefined] as const)
      expect(buildAccountBalance({ ...base, snapshot: snap(BAL, 200), channel }).source).toBe(
        "live",
      );
  });

  it("Given a frame without a balance, Then it is not read as zero", () => {
    const a = buildAccountBalance({
      status: { state: "live" },
      snapshot: snap(undefined, 100),
      nowMs: NOW,
    });
    expect(a.source).toBe("unknown");
  });

  it("Given sessions saved over time, Then the newest balance reading wins, whatever the order of the file", () => {
    const s = (id: string, last: number | null, at: string | null) =>
      ({
        id,
        last_balance: last,
        last_balance_at: at,
        start_balance_at: null,
        last_activity_at: iso(NOW - 30 * HOUR),
      }) as never;
    const found = newestSavedBalance([
      s("a", 100, iso(NOW - 10 * HOUR)),
      s("b", 200, iso(NOW - 20 * HOUR)),
      s("c", null, null),
    ]);
    expect(found).toEqual({ auec: 100, at: iso(NOW - 10 * HOUR) });
    expect(newestSavedBalance([s("c", null, null)])).toBeNull();
    // a session played on the PTU (its own test economy) is never the account's balance, even when it is the newest
    const ptu = { ...(s("p", 999, iso(NOW - HOUR)) as object), game_channel: "ptu" } as never;
    expect(newestSavedBalance([s("a", 100, iso(NOW - 10 * HOUR)), ptu])).toEqual({
      auec: 100,
      at: iso(NOW - 10 * HOUR),
    });
    expect(newestSavedBalance([ptu])).toBeNull();
    expect(newestSavedBalance([])).toBeNull();
  });
});

describe("Feature: the poll carries the reminder only to a View that asked for the balance", () => {
  const rig = (opts: {
    frameAgeMs?: number;
    saved?: SavedBalance | null;
    state?: string;
    channel?: "live" | "ptu" | "unknown";
    /** The saved sessions are switched off in the manager (enabled false) or there is no manager at all (SC_SESSIONS=off). */
    sessions?: "on" | "disabled" | "none";
    /** The service's own channel reader, used when there is no manager. */
    ownChannel?: boolean;
  }) => {
    const telemetry = {
      enabled: true,
      status: vi.fn(async () => ({
        state: opts.state ?? "waiting",
        cause: "x",
        frames_received: 0,
      })),
      snapshot: vi.fn(async () =>
        opts.frameAgeMs === undefined ? null : snap(BAL, opts.frameAgeMs),
      ),
      events: vi.fn(async () => ({ events: [], last_seq: 0 })),
      resetUecDelta: vi.fn(async () => undefined),
      balanceHistory: vi.fn(async () => []),
      stop: vi.fn(async () => undefined),
    } as unknown as Telemetry;
    const savedBalance = vi.fn(async () => opts.saved ?? null);
    const gameChannel = vi.fn(async () => opts.channel ?? "live");
    const sessions = {
      enabled: opts.sessions !== "disabled",
      bar: async () => ({
        v: 1,
        status: "ok",
        notice: null,
        gap_hours: 3,
        current: null,
        stale: false,
      }),
      calibrationSection: async () => undefined,
      gameChannel,
      savedBalance,
    } as unknown as SessionManager;
    const service = new DashboardService(
      telemetry,
      () => NOW,
      undefined,
      undefined,
      undefined,
      undefined,
      opts.sessions === "none" ? undefined : sessions,
      undefined,
      undefined,
      opts.ownChannel ? gameChannel : undefined,
    );
    return { service, savedBalance, gameChannel };
  };

  it.each(HIDDEN_MODES)(
    "Given a saved balance and $label, Then the answer has no account field, no amount, and the file was not asked",
    async (mode) => {
      for (const sessions of ["on", "none"] as const) {
        const { service, savedBalance, gameChannel } = rig({
          saved: { auec: BAL, at: iso(NOW - 15 * HOUR) },
          frameAgeMs: 200,
          state: "live",
          sessions,
          ownChannel: true,
        });
        const poll = await service.poll({
          includeBalance: wantsBalance(mode.args.include_balance, mode.policy),
        });
        expect(poll).not.toHaveProperty("account");
        expect(JSON.stringify(poll)).not.toMatch(WHOLE);
        expect(savedBalance).not.toHaveBeenCalled();
        // the log head is not even looked at while the amounts are hidden
        expect(gameChannel).not.toHaveBeenCalled();
      }
    },
  );

  it.each(SHOWN_MODES)(
    "Given a saved balance and $label, Then the answer carries the last known balance and its time",
    async (mode) => {
      const saved = { auec: BAL, at: iso(NOW - 15 * HOUR) };
      const { service } = rig({ saved });
      const poll = await service.poll({
        includeBalance: wantsBalance(mode.args.include_balance, mode.policy),
      });
      expect(poll.account).toEqual({
        source: "last_known",
        uec: BAL,
        at: saved.at,
        from: "session",
      });
      expect(poll.hash).not.toHaveProperty("account");
    },
  );

  it("Given a PTU game and a live stream, Then the poll does not carry the PTU frame as the account balance", async () => {
    const { service } = rig({ frameAgeMs: 200, state: "live", channel: "ptu" });
    const poll = await service.poll({ includeBalance: true });
    expect(poll.account).toEqual({ source: "unknown", reason: "ptu" });
    expect(JSON.stringify(poll.account)).not.toMatch(WHOLE);
  });

  it.each(["disabled", "none"] as const)(
    "Given saved sessions %s and a PTU game, Then the PTU frame is still not presented as the account balance",
    async (sessions) => {
      const { service, gameChannel } = rig({
        frameAgeMs: 200,
        state: "live",
        channel: "ptu",
        sessions,
        ownChannel: true,
      });
      const poll = await service.poll({ includeBalance: true });
      expect(poll.account).toEqual({ source: "unknown", reason: "ptu" });
      expect(gameChannel).toHaveBeenCalled();
    },
  );

  it("Given saved sessions off and no way to read the channel, Then the live frame is shown but flagged unverified", async () => {
    const { service } = rig({ frameAgeMs: 200, state: "live", sessions: "none" });
    const poll = await service.poll({ includeBalance: true });
    expect(poll.account).toEqual({ source: "live", uec: BAL, channel_unverified: true });
  });

  it("Given a failing sessions file, Then the answer still comes, with an unknown balance", async () => {
    const { service, savedBalance } = rig({});
    savedBalance.mockRejectedValueOnce(new Error("busy"));
    const poll = await service.poll({ includeBalance: true });
    expect(poll.account).toMatchObject({ source: "unknown" });
  });
});

describe("Feature: what the header says (pure)", () => {
  const poll = (account: any, state = "waiting") => ({ v: 1, state, account });
  const NB = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

  it("Given a live reading, Then the amount alone", () => {
    const i = accountInfo(poll({ source: "live", uec: BAL }, "live"), true, NOW);
    expect(NB(i.text)).toBe("8 675 309 aUEC");
    expect(i.kind).toBe("live");
    expect(i.note).toBe("");
  });

  it("Given a last known balance, Then it says so with its age", () => {
    const i = accountInfo(
      poll({ source: "last_known", uec: BAL, at: iso(NOW - 15 * HOUR), from: "session" }),
      true,
      NOW,
    );
    expect(NB(i.text)).toBe("8 675 309 aUEC");
    expect(NB(i.note)).toBe("dernier solde connu · il y a 15 h");
    expect(i.kind).toBe("last_known");
  });

  it("Given no reading, Then it says unknown and why, with no figure", () => {
    expect(
      accountInfo(poll({ source: "unknown", reason: "game_closed" }), true, NOW),
    ).toMatchObject({
      kind: "unknown",
      text: "Solde inconnu",
      note: "jeu fermé",
    });
    expect(accountInfo(poll({ source: "unknown", reason: "no_reading" }), true, NOW).note).toBe(
      "aucun relevé pour l’instant",
    );
    // Telemetry off: the poll's own state says it, nothing is read.
    expect(accountInfo({ v: 1, state: "off" }, true, NOW)).toMatchObject({
      kind: "unknown",
      note: "télémétrie non activée",
    });
  });

  it("Given the answer in hand was asked without the balance, Then it waits instead of saying unknown", () => {
    expect(accountInfo({ v: 1, state: "waiting" }, true, NOW).kind).toBe("wait");
    expect(accountInfo(null, true, NOW).kind).toBe("wait");
  });

  it("Given a reading whose channel is unverified, Then it is shown with a short note and a tooltip, never as certain", () => {
    const live = accountInfo(
      poll({ source: "live", uec: BAL, channel_unverified: true }, "live"),
      true,
      NOW,
    );
    expect(live.kind).toBe("live");
    expect(live.note).toBe("canal non vérifié");
    expect(live.tip).toContain("PTU");
    const kept = accountInfo(
      poll({
        source: "last_known",
        uec: BAL,
        at: iso(NOW - HOUR),
        from: "stream",
        channel_unverified: true,
      }),
      true,
      NOW,
    );
    expect(NB(kept.note)).toBe("dernier solde connu · il y a 1 h · canal non vérifié");
    // verified: no caveat
    expect(accountInfo(poll({ source: "live", uec: BAL }, "live"), true, NOW).note).toBe("");
    // hidden: nothing about the channel either
    expect(
      JSON.stringify(
        accountInfo(
          poll({ source: "live", uec: BAL, channel_unverified: true }, "live"),
          false,
          NOW,
        ),
      ),
    ).not.toContain("canal");
  });

  it("Given a PTU game, Then it says so and shows no figure", () => {
    const i = accountInfo(poll({ source: "unknown", reason: "ptu" }), true, NOW);
    expect(i.kind).toBe("unknown");
    expect(i.note).toContain("PTU");
    expect(i.text).toBe("Solde inconnu");
  });

  it("Given a View that follows another one, Then it does not say the player hid the balance", () => {
    const i = accountInfo(poll({ source: "live", uec: BAL }, "live"), false, NOW, true);
    expect(i.kind).toBe("follower");
    expect(i.note).toBe("suivi par un autre tableau");
    expect(JSON.stringify(i)).not.toMatch(/\d/);
    expect(JSON.stringify(i)).not.toContain("masqué");
    // hidden by the player: still "masqué"
    expect(accountInfo(poll({ source: "live", uec: BAL }, "live"), false, NOW, false).note).toBe(
      "masqué",
    );
  });

  it("Given an older server that sends only the live balance, Then it is shown as live", () => {
    const i = accountInfo({ v: 1, state: "live", balance: { uec: BAL } }, true, NOW);
    expect(i.kind).toBe("live");
  });

  it.each([
    ["a live reading", poll({ source: "live", uec: BAL }, "live")],
    [
      "a last known balance",
      poll({ source: "last_known", uec: BAL, at: iso(NOW - HOUR), from: "stream" }),
    ],
    ["a balance string", poll({ source: "live", uec: "8675309" }, "live")],
  ])("Given the player hid the balance and %s in the poll, Then no amount is drawn", (_l, p) => {
    const i = accountInfo(p, false, NOW);
    expect(i.kind).toBe("hidden");
    expect(JSON.stringify(i)).not.toMatch(/\d/);
    expect(i.text).toBe("••••••");
  });

  it("Given hostile values, Then they are not drawn", () => {
    for (const uec of ["<b>1</b>", "1e9999", Number.NaN, {}, "123456789012345678901234"]) {
      const i = accountInfo(poll({ source: "live", uec }, "live"), true, NOW);
      expect(i.kind).toBe("unknown");
    }
  });

  it("Given ages, Then they are in words", () => {
    expect(NB(accountAgo(10_000)!)).toBe("il y a moins d’1 min");
    expect(NB(accountAgo(5 * 60_000)!)).toBe("il y a 5 min");
    expect(NB(accountAgo(15 * HOUR)!)).toBe("il y a 15 h");
    // rounded, not cut
    expect(NB(accountAgo(15 * HOUR + 59 * 60_000)!)).toBe("il y a 16 h");
    expect(NB(accountAgo(59.6 * 60_000)!)).toBe("il y a 1 h");
    expect(NB(accountAgo(5 * 60_000 + 40_000)!)).toBe("il y a 6 min");
    expect(NB(accountAgo(72 * HOUR)!)).toBe("il y a 3 j");
    expect(accountAgo(-5000)).toBe("il y a moins d’1\u00a0min");
    expect(accountAgo(null)).toBeNull();
  });
});

describe("Feature: the reminder never leaves the page", () => {
  const withAccount = {
    v: 1,
    state: "live",
    frame_age_ms: 100,
    received_at: null,
    ship: { name: "DRAK_Cutter_1" },
    pilot: { health: { current: 80 } },
    account: { source: "live", uec: BAL },
    balance: { uec: BAL, delta: 0, since: null },
    session: { started_at: null, markers: [] },
    events: [],
    last_seq: 0,
  };

  it("Given the answer shared with the other Views, Then it has no account", () => {
    const shared = sharablePoll(withAccount);
    expect(shared).not.toHaveProperty("account");
    expect(JSON.stringify(shared)).not.toMatch(WHOLE);
  });

  it("Given a snapshot read from the channel, Then an account in it is dropped", () => {
    const clean = cleanPoll({ ...withAccount, sneaky: { account: { uec: BAL } } });
    expect(clean).not.toHaveProperty("account");
    expect(JSON.stringify(clean)).not.toMatch(WHOLE);
  });

  it.each([true, false])(
    "Given the summary sent to the model (balance hidden: %s), Then the amount is not in it",
    (hidden) => {
      const text = JSON.stringify(contextSummary(withAccount, [], hidden));
      expect(text).not.toMatch(WHOLE);
      expect(text).not.toContain("account");
    },
  );
});
