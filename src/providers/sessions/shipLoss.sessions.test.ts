/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import {
  ledgerChannelClean,
  ledgerStripBalance,
  ledgerTradeNormalize,
} from "../../dashboard/ledgerPanel.js";
import { sessionBarInfo, sessionBarNormalize } from "../../dashboard/sessionPanel.js";
import { tradeAlertInfo, tradeLossCargo, tradeLossInfo } from "../../dashboard/tradePreflight.js";
import { buildTradeSection } from "../../dashboard/tradeRun.js";
import * as ViewLogic from "../../dashboard/viewLogic.js";
import * as Preflight from "../../dashboard/tradePreflight.js";
import { parseLog } from "../gamelog/parser.js";
import { buildShipLosses } from "../gamelog/shipLoss.js";
import { entityRef } from "../gamelog/shipLossParse.js";
import { buildTradeJournal } from "../gamelog/trade.js";
import { buildDebrief } from "./debrief.js";
import { session } from "./fixtures.testing.js";
import { latest, observe, type Observation, type ReduceConfig } from "./reducer.js";
import { summarizeSession, withoutMoney } from "./stats.js";
import { parseState } from "./store.js";
import { emptyState, SessionSchema, MAX_SHIP_LOSSES, type ShipLossInput } from "./types.js";
import { TradeRunTripSource } from "./trips.js";

/**
 * The ship-loss tracker, from the session file to every output: stored once, additive to the v2 file, and never carrying the
 * aUEC PAID for the cargo (a balance figure) to anyone who was not allowed the balance. The paid amount below is a distinctive
 * number so that a leak anywhere is a plain string search.
 */

const PAID = 947857;
const PAID_TEXT = [/947\D{0,6}857/];
// The page composes the view logic with the trade modules in one scope; so does this test.
const L = { ...ViewLogic, ...Preflight };
const T0 = Date.UTC(2026, 10, 4, 18, 0, 0);
const MIN = 60_000;
const cfg: ReduceConfig = { gapMs: 3 * 3_600_000, newId: () => "s_test_loss" };
const obs = (over: Partial<Observation> & { now: number }): Observation => ({
  running: true,
  balance: 1000,
  freshStart: false,
  connection: null,
  game: null,
  trips: [],
  context: null,
  ...over,
});
const loss = (over: Partial<ShipLossInput> = {}): ShipLossInput => ({
  at: new Date(T0 + 5 * MIN).toISOString(),
  ship_class: "MISC_Freelancer",
  cause: "collision",
  causer: "self",
  zone: "OOC_Stanton_3a_Lyria",
  cargo_scu: 640,
  cargo_paid_auec: PAID,
  ...over,
});
const hasPaid = (value: unknown) => {
  const json = JSON.stringify(value);
  return PAID_TEXT.some((p) => p.test(json));
};
const withLoss = () =>
  session(1, { ship_losses: [SessionSchema.shape.ship_losses.parse([loss()])[0]!] });

describe("Feature: the session keeps each destroyed ship once", () => {
  it("Given the same loss seen on several looks, Then the session holds it once", () => {
    const s = emptyState();
    observe(s, obs({ now: T0 }), cfg);
    for (let i = 1; i <= 3; i++)
      observe(s, obs({ now: T0 + (5 + i) * MIN, shipLosses: [loss()] }), cfg);
    expect(latest(s)!.ship_losses).toHaveLength(1);
    expect(latest(s)!.ship_losses[0]).toMatchObject({
      ship_class: "MISC_Freelancer",
      cargo_scu: 640,
    });
  });

  it("Given a loss read while the journal was unreadable, Then a later look completes its cargo; a known cargo is never replaced", () => {
    const s = emptyState();
    observe(s, obs({ now: T0 }), cfg);
    observe(
      s,
      obs({ now: T0 + 6 * MIN, shipLosses: [loss({ cargo_scu: null, cargo_paid_auec: null })] }),
      cfg,
    );
    expect(latest(s)!.ship_losses[0]!.cargo_scu).toBeNull();
    observe(s, obs({ now: T0 + 7 * MIN, shipLosses: [loss()] }), cfg);
    expect(latest(s)!.ship_losses[0]!.cargo_scu).toBe(640);
    observe(s, obs({ now: T0 + 8 * MIN, shipLosses: [loss({ cargo_scu: 5 })] }), cfg);
    expect(latest(s)!.ship_losses[0]!.cargo_scu).toBe(640);
  });

  it("Given a loss from before the session, or an invalid one, Then it is not added; the list is bounded", () => {
    const s = emptyState();
    observe(s, obs({ now: T0 }), cfg);
    const bad = [
      loss({ at: new Date(T0 - 60 * MIN).toISOString() }),
      loss({ cause: "bogus" as never }),
      loss({ at: "not a date" }),
    ];
    observe(s, obs({ now: T0 + 2 * MIN, shipLosses: bad }), cfg);
    expect(latest(s)!.ship_losses).toEqual([]);
    const many = Array.from({ length: MAX_SHIP_LOSSES + 5 }, (_, i) =>
      loss({ at: new Date(T0 + (3 + i) * 1000).toISOString() }),
    );
    observe(s, obs({ now: T0 + 10 * MIN, shipLosses: many }), cfg);
    expect(latest(s)!.ship_losses).toHaveLength(MAX_SHIP_LOSSES);
  });

  it("Given a session file written before this field, Then it reads as an empty list (format version 2)", () => {
    const old: any = { ...session(1) };
    delete old.ship_losses;
    expect(SessionSchema.parse(old).ship_losses).toEqual([]);
  });
});

describe("Feature: a loss that does not read never costs the session", () => {
  const stored = (losses: unknown) =>
    parseState(JSON.stringify({ version: 2, sessions: [{ ...session(1), ship_losses: losses }] }));

  it("Given invalid entries among good ones, Then only the invalid ones are set aside and the session stays", () => {
    const good = loss();
    const r: any = stored([
      good,
      { ...good, cause: "bogus" },
      { ...good, cargo_scu: -5 },
      "not an object",
      { ...good, at: "yesterday" },
    ]);
    expect(r.kind).toBe("ok");
    expect(r.dropped).toBe(0);
    expect(r.state.sessions).toHaveLength(1);
    expect(r.state.sessions[0].ship_losses).toHaveLength(1);
    expect(r.state.sessions[0].ship_losses[0]).toMatchObject({ cargo_scu: 640 });
  });

  it("Given more entries than the bound, Then the newest are kept and the session stays", () => {
    const many = Array.from({ length: MAX_SHIP_LOSSES + 7 }, (_, i) =>
      loss({ at: new Date(T0 + i * 1000).toISOString() }),
    );
    const r: any = stored(many);
    expect(r.state.sessions).toHaveLength(1);
    const kept = r.state.sessions[0].ship_losses;
    expect(kept).toHaveLength(MAX_SHIP_LOSSES);
    expect(kept[kept.length - 1].at).toBe(many[many.length - 1]!.at);
  });

  it("Given a field that is not a list, Then it reads as empty and the session stays", () => {
    const r: any = stored("oops");
    expect(r.state.sessions).toHaveLength(1);
    expect(r.state.sessions[0].ship_losses).toEqual([]);
  });
});

describe("Feature: a loss is the same loss whatever the look knew of its model and place", () => {
  it("Given a loss first stored without model or place, Then a later look fills them in, once", () => {
    const s = emptyState();
    observe(s, obs({ now: T0 }), cfg);
    observe(
      s,
      obs({ now: T0 + 6 * MIN, shipLosses: [loss({ ship_class: null, zone: null })] }),
      cfg,
    );
    observe(s, obs({ now: T0 + 7 * MIN, shipLosses: [loss()] }), cfg);
    observe(s, obs({ now: T0 + 8 * MIN, shipLosses: [loss()] }), cfg);
    const kept = latest(s)!.ship_losses;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ ship_class: "MISC_Freelancer", zone: "OOC_Stanton_3a_Lyria" });
  });

  it("Given a known model, Then another model never replaces it", () => {
    const s = emptyState();
    observe(s, obs({ now: T0 }), cfg);
    observe(s, obs({ now: T0 + 6 * MIN, shipLosses: [loss()] }), cfg);
    observe(s, obs({ now: T0 + 7 * MIN, shipLosses: [loss({ ship_class: "DRAK_Cutter" })] }), cfg);
    expect(latest(s)!.ship_losses[0]!.ship_class).toBe("MISC_Freelancer");
  });

  it("Given a later look that found MORE cargo, Then it replaces the smaller figure; a smaller or unknown one never does", () => {
    const s = emptyState();
    observe(s, obs({ now: T0 }), cfg);
    observe(
      s,
      obs({ now: T0 + 6 * MIN, shipLosses: [loss({ cargo_scu: 100, cargo_paid_auec: 1000 })] }),
      cfg,
    );
    observe(
      s,
      obs({ now: T0 + 7 * MIN, shipLosses: [loss({ cargo_scu: 640, cargo_paid_auec: 6400 })] }),
      cfg,
    );
    expect(latest(s)!.ship_losses[0]).toMatchObject({ cargo_scu: 640, cargo_paid_auec: 6400 });
    observe(
      s,
      obs({ now: T0 + 8 * MIN, shipLosses: [loss({ cargo_scu: 50, cargo_paid_auec: 500 })] }),
      cfg,
    );
    observe(
      s,
      obs({ now: T0 + 9 * MIN, shipLosses: [loss({ cargo_scu: null, cargo_paid_auec: null })] }),
      cfg,
    );
    expect(latest(s)!.ship_losses[0]).toMatchObject({ cargo_scu: 640, cargo_paid_auec: 6400 });
  });
});

describe("Feature: a place or a model the filter dropped is said to be unknown", () => {
  it("Given a loss with no place and no model, Then the debrief says so", () => {
    const s = session(1, {
      ship_losses: [
        SessionSchema.shape.ship_losses.parse([loss({ zone: null, ship_class: null })])[0]!,
      ],
    });
    const md = buildDebrief([s], { includeMoney: false }).markdown;
    expect(md).toContain("lieu inconnu");
    expect(md).toContain("modèle inconnu");
  });
});

describe("Feature: the aUEC paid for the cargo presumed lost follows the balance", () => {
  it("Given the summary, Then the SCU are always given and the paid amount sits under money only", () => {
    const s = withLoss();
    const full = summarizeSession(s);
    expect(full.ship_losses[0]).toMatchObject({ cargo_scu: 640, cause: "collision" });
    expect(full.money.lost_cargo_paid_auec).toBe(PAID);
    const shut = withoutMoney(full);
    expect(shut.money).toBe("withheld");
    expect(hasPaid(shut)).toBe(false);
    expect(shut.ship_losses[0]!.cargo_scu).toBe(640);
  });

  it("Given the debrief, Then the paid amount appears only with money; the Markdown and the CSV carry no leak", () => {
    const s = withLoss();
    const without = buildDebrief([s], { includeMoney: false });
    expect(without.markdown).toContain("Vaisseaux détruits");
    expect(without.markdown).toContain("640");
    expect(without.markdown).toContain("non journalisés");
    expect(without.markdown).toContain("builds 2025 seulement");
    expect(hasPaid([without.markdown, without.csv])).toBe(false);
    const withMoney = buildDebrief([s], { includeMoney: true });
    expect(hasPaid(withMoney.markdown)).toBe(true);
    expect(withMoney.markdown).toContain("prix d’achat, pas la valeur");
  });

  it("Given the commerce section, Then the paid amount exists only when the balance was asked for", () => {
    const parsed = parseLog(
      [
        "<2026-11-04T18:00:00.000Z> [Notice] <AccountLoginCharacterStatus_Character> Character: createdAt 1 - updatedAt 2 - geid 700000000001 - accountId 5 - name ZedName - state STATE_CURRENT [A][B]",
        "<2026-11-04T18:00:10.000Z> [Notice] <CEntityComponentCommodityUIProvider::LoadSelectedShipBindings> Sending VehicleCargoDataRequest for vehicleEntityId[700000000555] [A][B]",
        `<2026-11-04T18:00:25.000Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> Sending SShopCommodityBuyRequest - playerId[1111111111] shopId[2222222] shopName[SCShop_Cargo_Test] kioskId[3333333] price[${PAID}.000000] shopPricePerCentiSCU[1.889409] resourceGUID[5c2e9a41-1111-4222-8333-444444444444] autoLoading[1] quantity[64000.000000 cSCU] Cargo Box Data: boxSize[32.000000] | unitAmount[20] [A][B]`,
        "<2026-11-04T18:15:00.000Z> [Notice] <FatalCollision> Fatal Collision occured for vehicle MISC_Freelancer_700000000555 [Part: Nose, Pos: x: 1.5, y: 2.5, z: 3.5, Zone: OOC_Stanton_3a_Lyria, PlayerPilot: 1] after hitting entity: Rock",
        "<2026-11-04T18:15:00.200Z> [Notice] <[ActorState] Dead> [ACTOR STATE][CSCActorControlStateDead::PrePhysicsUpdate] Actor 'ZedName' [700000000001] ejected from zone 'MISC_Freelancer_700000000555' [700000000555] to zone 'OOC_Stanton_3a_Lyria' [800000000002] due to previous zone being in a destroyed vehicle with detached interior. [A][B]",
      ].join("\n"),
    );
    const tx = buildTradeJournal(parsed.commerce, "2026-11-04T19:00:00.000Z").transactions;
    const losses = buildShipLosses(parsed.ships, tx);
    const input = {
      transactions: tx,
      history: [],
      nowMs: Date.parse("2026-11-04T18:20:00Z"),
      losses,
    };
    const shut = buildTradeSection({ ...input, includeBalance: false });
    const open = buildTradeSection({ ...input, includeBalance: true });
    expect(shut.ship_losses).toHaveLength(1);
    expect(shut.ship_losses![0]).toMatchObject({ cargo_scu: 640, run_id: expect.any(String) });
    expect(hasPaid(shut)).toBe(false);
    expect(open.ship_losses![0]!.paid_auec).toBe(PAID);
    // the lost run is the one the loss names, and it is still "open" (never a finished trip)
    expect(open.runs[0]!.id).toBe(open.ship_losses![0]!.run_id);

    // what the View keeps, strips and lets through the channel between Views
    const kept = ledgerTradeNormalize(JSON.parse(JSON.stringify(open)));
    expect(kept.ship_losses[0].paid_auec).toBe(PAID);
    const ledger = { v: 1, status: "ok", contracts: [], trade: open };
    expect(hasPaid(ledgerStripBalance(ledger))).toBe(false);
    expect(ledgerStripBalance(ledger).trade.ship_losses[0].cargo_scu).toBe(640);
    const channel = ledgerChannelClean({ ...ledger, contracts_total: 0, totals: {}, as_of: null });
    expect(hasPaid(channel)).toBe(false);
    expect(channel.trade.ship_losses[0].cargo_scu).toBe(640);
    // a hostile peer: text that is not one of the fixed words does not survive
    const hostile = ledgerTradeNormalize({
      v: 1,
      source: "journal",
      runs: [],
      ship_losses: [
        {
          at: "2026-11-04T18:15:00Z",
          cause: "<b>x</b>",
          causer: "evil",
          zone: "z" + String.fromCharCode(0x202e) + "",
          ship_class: "A\u0000B",
        },
      ],
    });
    expect(hostile.ship_losses[0]).toMatchObject({ cause: "unknown", causer: "unknown" });
    expect(hostile.ship_losses[0].zone).not.toContain("" + String.fromCharCode(0x202e) + "");
  });

  it("Given the trip source, Then the loss it hands the session carries the paid amount and the key of the run it interrupted", async () => {
    const parsed = parseLog(
      [
        "<2026-11-04T18:00:00.000Z> [Notice] <AccountLoginCharacterStatus_Character> Character: createdAt 1 - updatedAt 2 - geid 700000000001 - accountId 5 - name ZedName - state STATE_CURRENT [A][B]",
        "<2026-11-04T18:00:10.000Z> [Notice] <CEntityComponentCommodityUIProvider::LoadSelectedShipBindings> Sending VehicleCargoDataRequest for vehicleEntityId[700000000555] [A][B]",
        `<2026-11-04T18:00:25.000Z> [Notice] <CEntityComponentCommodityUIProvider::SendCommodityBuyRequest> Sending SShopCommodityBuyRequest - playerId[1111111111] shopId[2222222] shopName[SCShop_Cargo_Test] kioskId[3333333] price[${PAID}.000000] shopPricePerCentiSCU[1.889409] resourceGUID[5c2e9a41-1111-4222-8333-444444444444] autoLoading[1] quantity[64000.000000 cSCU] Cargo Box Data: boxSize[32.000000] | unitAmount[20] [A][B]`,
        "<2026-11-04T18:15:00.200Z> [Notice] <[ActorState] Dead> [ACTOR STATE][CSCActorControlStateDead::PrePhysicsUpdate] Actor 'ZedName' [700000000001] ejected from zone 'MISC_Freelancer_700000000555' [700000000555] to zone 'OOC_Stanton_3a_Lyria' [800000000002] due to previous zone being in a destroyed vehicle with detached interior. [A][B]",
      ].join("\n"),
    );
    const tx = buildTradeJournal(parsed.commerce, "2026-11-04T19:00:00.000Z").transactions;
    const source = new TradeRunTripSource(
      () => tx,
      async () => [],
      () => undefined,
      () => buildShipLosses(parsed.ships, tx),
    );
    const got = await source.collect(Date.parse("2026-11-04T18:20:00Z"));
    expect(got.trips).toEqual([]); // an interrupted run never becomes a trip
    expect(got.ship_losses).toHaveLength(1);
    expect(got.ship_losses![0]).toMatchObject({ cargo_scu: 640, cargo_paid_auec: PAID });
    // nothing derived from a ship's identifier (nor a key of the run) leaves the trip source
    expect(Object.keys(got.ship_losses![0]!).sort()).toEqual(
      ["at", "cargo_paid_auec", "cargo_scu", "cause", "causer", "ship_class", "zone"].sort(),
    );
    expect(JSON.stringify(got.ship_losses)).not.toContain(entityRef("700000000555"));
    // and the reducer stores it
    const s = emptyState();
    observe(s, obs({ now: Date.parse("2026-11-04T17:59:00Z") }), cfg);
    observe(s, obs({ now: Date.parse("2026-11-04T18:20:00Z"), shipLosses: got.ship_losses! }), cfg);
    expect(latest(s)!.ship_losses).toHaveLength(1);
  });
});

describe("Feature: the page shows the loss in the alert slot", () => {
  const NOW = Date.parse("2026-11-04T18:20:00Z");
  const section = (over: any = {}) => ({
    ship_losses: [
      {
        at: "2026-11-04T18:15:00.000Z",
        ship_class: "MISC_Freelancer",
        cause: "collision",
        causer: "self",
        zone: "z",
        cargo_scu: 640,
        cargo_buys: 1,
        unconfirmed_buys: 0,
        run_id: null,
        paid_auec: PAID,
        ...over,
      },
    ],
    price_refusals: [
      {
        at: "2026-11-04T18:19:00.000Z",
        side: "buy",
        kind: "commodity",
        confidence: "confirmed",
        superseded: false,
      },
    ],
  });

  it("Given a recent loss, Then the alert is the loss with the honest labels and the exact sentence", () => {
    const a = tradeAlertInfo(L, { ...section(), price_refusals: [] }, NOW, true);
    expect(a.loss).toBe(true);
    expect(a.label).toBe("Vaisseau détruit");
    expect(a.text).toMatch(
      /^Vaisseau détruit à \d{2}:\d{2}:\d{2}, joueur à bord \(MISC Freelancer\)\xa0: collision\.$/,
    );
    expect(a.tone).toBe("fatal");
    expect(a.advice).toMatch(
      /^Cargo présumé perdu\xa0: 640\xa0SCU, 947\D{1,3}857\xa0aUEC payés \(prix d’achat, pas la valeur\) \(non confirmé\)\.$/,
    );
    // the doubts moved to the fold ("why"): still all there, none in the two lines
    expect(a.why).toContain("non journalisés");
    expect(a.why).toContain("Propriété du vaisseau non vérifiée");
    expect(a.why).toContain("2025");
    expect(a.text + a.advice).not.toMatch(/non journalisés|non vérifiée|2025/);
    // a collision names no causer: the owner of the ship is not verified
    expect(a.text).not.toMatch(/pilot|propre|son vaisseau/i);
  });

  it("Given a refusal NEWER than the loss (after the respawn), Then the refusal takes the slot; the loss wins when it is the newer", () => {
    const both = section(); // loss 18:15, refusal 18:19
    const a = tradeAlertInfo(L, both, NOW, true);
    expect(a.loss).toBeUndefined();
    expect(a.label).toContain("Prix changé");
    expect(tradeAlertInfo(L, section({ at: "2026-11-04T18:19:30.000Z" }), NOW, true).loss).toBe(
      true,
    );
  });

  it("Given a loss older than 15 minutes, Then it is out of the alert (the session card keeps it)", () => {
    expect(tradeLossInfo(L, section({ at: "2026-11-04T18:03:00.000Z" }), NOW, true)).toBeNull();
  });

  it("Given a causer taken from the shape of a name, Then the words say so on the alert and on the session card", () => {
    const npc = tradeLossInfo(L, section({ cause: "combat", causer: "npc" }), NOW, true);
    // on the alert, the cause alone is in the sentence and who goes in the fold, still said to come from the name's shape
    expect(npc.text).toContain("combat.");
    expect(npc.text).not.toContain("IA");
    expect(npc.why).toContain("Responsable d’après la forme du nom : une IA.");
    const other = tradeLossInfo(L, section({ cause: "combat", causer: "other" }), NOW, true);
    expect(other.why).toContain(
      "Responsable d’après la forme du nom : un autre joueur ou une entité inconnue.",
    );
    const s = withLoss();
    s.ship_losses[0] = { ...s.ship_losses[0]!, cause: "combat", causer: "other" };
    const info = sessionBarInfo(
      L,
      sessionBarNormalize(
        {
          v: 1,
          status: "ok",
          gap_hours: 3,
          stale: false,
          current: withoutMoney(summarizeSession(s)),
        },
        false,
      ),
      { showBalance: false, now: NOW },
    );
    expect(info.notes.join("\n")).toContain(
      "combat par un autre joueur ou une entité inconnue (d’après le nom)",
    );
    expect(info.notes.join("\n")).toContain("Propriété du vaisseau non vérifiée");
  });

  it("Given every text the loss produces, Then no no-break space is left as a bare '00a0' or a backslash escape", () => {
    const texts: string[] = [];
    for (const money of [true, false]) {
      for (const over of [
        {},
        { cargo_scu: 0 },
        { cargo_scu: null },
        { cause: "combat", causer: "npc" },
      ]) {
        const a = tradeLossInfo(L, section(over), NOW, money);
        texts.push(a.label, a.text, a.advice, a.why, a.at, a.ago);
      }
    }
    const summary = summarizeSession(withLoss());
    for (const money of [true, false]) {
      const info = sessionBarInfo(
        L,
        sessionBarNormalize(
          {
            v: 1,
            status: "ok",
            gap_hours: 3,
            stale: false,
            current: money ? summary : withoutMoney(summary),
          },
          money,
        ),
        { showBalance: money, now: NOW },
      );
      texts.push(info.line, ...info.notes);
    }
    for (const t of texts) {
      expect(t).not.toMatch(/[A-Za-z0-9]00a0/);
      expect(t).not.toMatch(/\\u/);
    }
    expect(texts.join("\n")).toMatch(/perdu\xa0: 640\xa0SCU/);
    expect(texts.join("\n")).toMatch(/Payé pour ce cargo\xa0: 947\D{1,3}857\xa0aUEC/);
  });

  it("Given sales the journal could not confirm, Then the alert says in its fold that the cargo lost may be overestimated", () => {
    const a = tradeLossInfo(L, section({ unconfirmed_sells: 2 }), NOW, true);
    expect(a.why).toContain("2 vente(s) non confirmée(s)");
    expect(a.why).toContain("surestimé");
    // the two lines stay short; the card of the commerce and the session keep the whole sentence
    expect(a.advice).not.toContain("non confirmée(s)");
    expect(tradeLossCargo(L, { cargo_scu: 640, unconfirmed_sells: 2 }, false)).toContain(
      "surestimé",
    );
  });

  it("Given the balance hidden, Then the SCU show and the paid amount does not, even if the section carried it", () => {
    const a = tradeLossInfo(L, section(), NOW, false);
    expect(a.advice).toContain("640");
    expect(hasPaid(a)).toBe(false);
    expect(hasPaid(tradeLossInfo(L, section(), NOW, true))).toBe(true);
  });

  it("Given a loss that is old, Then the refusal is back in the slot; with neither, null", () => {
    const old = section({ at: "2026-11-04T16:00:00.000Z" });
    expect(tradeAlertInfo(L, old, NOW, true).loss).toBeUndefined();
    expect(tradeAlertInfo(L, { ship_losses: old.ship_losses }, NOW, true)).toBeNull();
  });

  it("Given a loss recorded without its cause, Then a later look that knows it completes it, and never the other way round", () => {
    const s = emptyState();
    observe(s, obs({ now: T0 }), cfg);
    const unknown = loss({
      cause: "unknown",
      causer: "unknown",
      cargo_scu: null,
      cargo_paid_auec: null,
    });
    observe(s, obs({ now: T0 + 6 * MIN, shipLosses: [unknown] }), cfg);
    observe(
      s,
      obs({ now: T0 + 7 * MIN, shipLosses: [loss({ cause: "combat", causer: "other" })] }),
      cfg,
    );
    expect(latest(s)!.ship_losses).toHaveLength(1);
    expect(latest(s)!.ship_losses[0]).toMatchObject({
      cause: "combat",
      causer: "other",
      cargo_scu: 640,
    });
    // a known value is not replaced by "unknown", nor by another known value
    observe(s, obs({ now: T0 + 8 * MIN, shipLosses: [unknown] }), cfg);
    observe(
      s,
      obs({ now: T0 + 9 * MIN, shipLosses: [loss({ cause: "collision", causer: "npc" })] }),
      cfg,
    );
    expect(latest(s)!.ship_losses[0]).toMatchObject({ cause: "combat", causer: "other" });
  });

  it("Given no cargo, or an unreadable journal, Then it says so instead of a zero", () => {
    expect(tradeLossInfo(L, section({ cargo_scu: 0 }), NOW, true).advice).toContain("Aucun achat");
    expect(tradeLossInfo(L, section({ cargo_scu: null }), NOW, true).advice).toContain(
      "pas lisible",
    );
  });

  it("Given the ship gone from the stream, Then the header verdict still says the ship was destroyed", () => {
    const alert = tradeAlertInfo(L, { ...section(), price_refusals: [] }, NOW, false);
    const poll = { state: "live", ship: null, pilot: null };
    const v = L.summaryInfo(poll, [], alert);
    expect(v.label).toContain("Vaisseau détruit");
    expect(L.summaryInfo(poll, [], null)).toBeNull();
  });

  it("Given a session with a loss, Then the session card keeps a note for good; the paid total needs the balance", () => {
    const summary = summarizeSession(withLoss());
    const bar = (money: boolean) => ({
      v: 1,
      status: "ok",
      gap_hours: 3,
      stale: false,
      current: money ? summary : withoutMoney(summary),
    });
    const shut = sessionBarInfo(L, sessionBarNormalize(bar(false), false), {
      showBalance: false,
      now: NOW,
    });
    expect(shut.notes.join("\n")).toContain("Vaisseau détruit");
    expect(shut.notes.join("\n")).toContain("640");
    expect(shut.line).toContain("1\u00a0vaisseau\u00a0détruit");
    expect(hasPaid(shut)).toBe(false);
    const open = sessionBarInfo(L, sessionBarNormalize(bar(true), true), {
      showBalance: true,
      now: NOW,
    });
    expect(hasPaid(open.notes)).toBe(true);
    // balance shown in the page but the server sent none: nothing is invented
    const none = sessionBarInfo(L, sessionBarNormalize(bar(false), true), {
      showBalance: true,
      now: NOW,
    });
    expect(hasPaid(none)).toBe(false);
  });
});
