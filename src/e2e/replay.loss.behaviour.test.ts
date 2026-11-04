import { describe, expect, it, vi } from "vitest";
import {
  expectAbsent,
  expectPresent,
  sweepWithBalance,
  sweepWithoutBalance,
} from "../testing/replay/audit.js";
import { entityRef } from "../providers/gamelog/shipLossParse.js";
import { buyLine, HANDLE } from "../testing/replay/lines.js";
import { useWorld } from "../testing/replay/story.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Feature: the player's ship is destroyed with cargo bought for it aboard. The lines go through the real log reader, the
 * ledger service, the commerce model, the session manager and its file; the card, the saved session and the debrief must
 * tell the same thing, and the amount paid must stay out of every answer given without the balance.
 */

const rig = useWorld();
const ME = "710000000001"; // invented ids throughout
const SHIP = "710000000555";
const PAID = 137_911;
const FEE = 1_500;
const stamp = (ms: number) => `<${new Date(ms).toISOString()}>`;
const character = (ms: number) =>
  `${stamp(ms)} [Notice] <AccountLoginCharacterStatus_Character> Character: createdAt 1 - updatedAt 2 - geid ${ME} - accountId 9 - name ${HANDLE} - state STATE_CURRENT [Team_GameServices][Login]`;
const kiosk = (ms: number) =>
  `${stamp(ms)} [Notice] <CEntityComponentCommodityUIProvider::LoadSelectedShipBindings> Sending VehicleCargoDataRequest for vehicleEntityId[${SHIP}] [Team_CoreGameplayFeatures][Shops][UI]`;
const crash = (ms: number) =>
  `${stamp(ms)} [Notice] <FatalCollision> Fatal Collision occured for vehicle MISC_Freelancer_${SHIP} [Part: Nose, Pos: x: 1.5, y: 2.5, z: 3.5, Zone: OOC_Stanton_3a_Lyria, PlayerPilot: 1] after hitting entity: Rock_${HANDLE}`;
const dead = (ms: number) =>
  `${stamp(ms)} [Notice] <[ActorState] Dead> [ACTOR STATE][CSCActorControlStateDead::PrePhysicsUpdate] Actor '${HANDLE}' [${ME}] ejected from zone 'MISC_Freelancer_${SHIP}' [${SHIP}] to zone 'OOC_Stanton_3a_Lyria' [820000000002] due to previous zone being in a destroyed vehicle with detached interior. [Team_ActorFeatures][Actor]`;

describe("Feature: a ship destroyed with cargo bought for it", () => {
  it("Scenario: the loss shows on the card and the session, once, and its price never leaves without the balance", async () => {
    const w = await rig.start();
    w.at(2).log(character(w.ms(2)));
    w.at(10).log(kiosk(w.ms(10)));
    w.at(12).log(buyLine(w.ms(12), PAID, 100));
    w.at(12.7).change(-(PAID + FEE));
    w.at(300).log(crash(w.ms(300)));
    w.at(300.3).log(dead(w.ms(300.3)));
    await w.playTo(330);

    // ---- The card: the run is interrupted, the loss names it, the SCU are shown without the balance.
    const withB = await w.poll(true);
    const loss = withB.ledger.trade.ship_losses[0];
    expect(loss).toMatchObject({
      ship_class: "MISC_Freelancer",
      cause: "collision",
      causer: "unknown",
      zone: "OOC_Stanton_3a_Lyria",
      cargo_scu: 100,
      paid_auec: PAID,
    });
    expect(loss.run_id).toBe(withB.ledger.trade.runs[0].id);
    expect(withB.ledger.trade.runs[0].stage).toBe("open"); // never a finished trip
    const shut = await w.poll(false);
    expect(shut.ledger.trade.ship_losses[0]).toMatchObject({ cargo_scu: 100 });
    expect(shut.ledger.trade.ship_losses[0].paid_auec).toBeUndefined();

    // ---- The saved session: once, with the run it interrupted, and no trip.
    await w.playTo(360);
    const file = w.sessionsJson();
    expect(file.sessions).toHaveLength(1);
    expect(file.sessions[0]!.trips).toEqual([]);
    expect(file.sessions[0]!.ship_losses).toHaveLength(1);
    expect(file.sessions[0]!.ship_losses[0]).toMatchObject({
      cargo_scu: 100,
      cargo_paid_auec: PAID,
      cause: "collision",
      ship_class: "MISC_Freelancer",
    });
    // only what the file may keep: no key derived from the ship's identifier, no count of purchases
    expect(Object.keys(file.sessions[0]!.ship_losses[0]!).sort()).toEqual(
      ["at", "cargo_paid_auec", "cargo_scu", "cause", "causer", "ship_class", "zone"].sort(),
    );
    expect(w.sessionsBytes()).not.toContain(entityRef(SHIP));
    const stored = JSON.stringify(file.sessions[0]!.ship_losses);
    await w.playTo(420);
    // not counted again, and not rewritten, on later looks
    expect(JSON.stringify(w.sessionsJson().sessions[0]!.ship_losses)).toBe(stored);

    // ---- Nothing personal in the file or the answers; the price only with the balance.
    const bytes = w.sessionsBytes();
    for (const secret of [HANDLE, ME, SHIP, "820000000002"]) expect(bytes).not.toContain(secret);
    const without = await sweepWithoutBalance(w);
    for (const secret of [HANDLE, ME, SHIP, "820000000002"])
      expect(without.all).not.toContain(secret);
    expectAbsent(without.all, [PAID, PAID + FEE], "the answers without the balance");
    expect(without.tools).toContain("Vaisseaux détruits");
    expect(without.tools).toContain("collision");
    expectPresent(await sweepWithBalance(w), [PAID], "the answers with the balance");

    // ---- The debrief carries it too, with what the log does not say.
    const debrief = (await w.call("sc_session_debrief", { include_balance: true })).text;
    expect(debrief).toContain("Vaisseaux détruits");
    expect(debrief).toContain("prix d’achat, pas la valeur");
    expect(debrief).toContain("non journalisés");
  });
});
