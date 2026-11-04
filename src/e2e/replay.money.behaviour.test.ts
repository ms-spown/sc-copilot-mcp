/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import {
  expectAbsent,
  expectPresent,
  sweepWithBalance,
  sweepWithoutBalance,
} from "../testing/replay/audit.js";
import {
  contractAccepted,
  contractCompleted,
  haulingSteps,
  missionId,
} from "../testing/replay/lines.js";
import { PLAYER_RUN, scheduleRun } from "../testing/replay/scripts.js";
import { F, MONEY, newestRun, useWorld } from "../testing/replay/story.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * Feature: a contract is paid near a cargo sale. The log has no reward line and no balance: the only evidence of a
 * reward is a rise of the balance after a contract ended. Whatever is read that way must be called PROBABLE, never a
 * fact; every balance change goes to exactly one entry; and a contract's balance change that holds the cargo run is
 * counted once in the session.
 */

const rig = useWorld();

const REWARD_NEAR = 60_000; // paid 1.6 s after the last cargo sale, 3 s after "Contract Complete"
const REWARD_FAR = 45_000; // paid 1.5 s after the second contract ended, far from any sale

describe("Feature: a reward paid inside the window of a cargo sale", () => {
  it("Scenario: the reward is only ever 'probable', the sum invariant holds and the session counts the money once", async () => {
    const w = await rig.start();
    const A = missionId(1);
    const B = missionId(2);
    scheduleRun(w, 20); // sales written at 100 s and 102 s
    // Contract A ends with the cargo run (a hauling contract of the same trip) and is paid 2 s after the last sale.
    w.at(5).log(contractAccepted(w.ms(5), "Waste Disposal | Easy", A));
    w.at(6).log(haulingSteps(w.ms(6), A, "Outpost_Test_One", "Station_Test_Two"));
    w.at(101).log(contractCompleted(w.ms(101), "Waste Disposal | Easy", A));
    w.at(104).change(REWARD_NEAR);
    // Contract B is alone: paid long after the run.
    w.at(200).log(contractAccepted(w.ms(200), "Ore Delivery | Hard", B));
    w.at(201).log(haulingSteps(w.ms(201), B, "Outpost_Test_One", "Station_Test_Three"));
    w.at(295).log(contractCompleted(w.ms(295), "Ore Delivery | Hard", B));
    w.at(296.5).change(REWARD_FAR);
    await w.playTo(10);
    await w.applyPlan();
    await w.playTo(330);

    const p = await w.poll(true);
    const variation = PLAYER_RUN.end + REWARD_NEAR + REWARD_FAR - PLAYER_RUN.start;
    expect(p.balance).toMatchObject({
      uec: PLAYER_RUN.end + REWARD_NEAR + REWARD_FAR,
      delta: variation,
    });

    // ---- The movements: every change has exactly one entry, and they add up to the variation, to the aUEC.
    const mv = p.ledger.movements;
    const listed = mv.listed as {
      amount: number;
      category: string;
      confidence: string;
      several?: true;
      ref?: string;
    }[];
    expect(mv.total_auec).toBe(variation);
    expect(listed.reduce((s, x) => s + x.amount, 0)).toBe(variation);
    expect(mv.count).toBe(6);
    expect(listed).toHaveLength(6);

    // ---- Reward is a guess: whatever the explainer reads as one is 'probable', nothing is 'matched' or 'measured'.
    const rewards = listed.filter((x) => x.category === "probable_contract_reward");
    expect(rewards.length).toBeGreaterThan(0);
    for (const r of rewards) expect(r.confidence).toBe("probable");
    // The lone reward, far from any sale, names its contract and claims nothing more.
    const far = rewards.find((r) => r.amount === REWARD_FAR)!;
    expect(far).toMatchObject({ ref: "Ore Delivery | Hard", confidence: "probable" });
    expect(far.several).toBeUndefined();
    // Inside the sale window the evidence is thinner and the entries say so: several changes compete for one event.
    // KNOWN LIMITATION, pinned here so that a change is deliberate: with the reward in the window, the fee of the cargo
    // sale cannot be measured, so the two sale changes (270 680 and 23 292, price minus fee) are read the same way as
    // the 60 000 reward, as 'probable' and 'several'. The total of "probable rewards" then exceeds the reward itself.
    const near = rewards
      .filter((r) => r.several === true)
      .map((r) => r.amount)
      .sort((a, b) => a - b);
    expect(near).toEqual(
      [
        PLAYER_RUN.sells[1].amount - PLAYER_RUN.sells[1].fee,
        REWARD_NEAR,
        PLAYER_RUN.sells[0].amount - PLAYER_RUN.sells[0].fee,
      ].sort((a, b) => a - b),
    );
    // The purchases, which no reward can reach, are explained by the log and by the measured fee.
    expect(listed.filter((x) => x.category === "explained_by_transaction")).toEqual([
      expect.objectContaining({ amount: -F.cost, confidence: "matched", side: "buy" }),
    ]);
    expect(listed.filter((x) => x.category === "fee_on_transaction")).toEqual([
      expect.objectContaining({ amount: -F.buyFee, confidence: "measured", side: "buy" }),
    ]);
    expect(listed.filter((x) => x.category === "unexplained")).toEqual([]);
    expect(mv.unmatched_transactions).toBe(2);
    // The words: every mention of a reward in the explanations says 'probable'.
    const sentences: string[] = [
      ...mv.explanation,
      ...newestRun(p).money.decomposition.explanation,
    ];
    const mentions = sentences.filter((s) => /récompense/i.test(s));
    expect(mentions.length).toBeGreaterThan(0);
    for (const s of mentions) {
      expect((s.match(/récompense/gi) ?? []).length).toBe(
        (s.match(/récompenses? probables?/gi) ?? []).length,
      );
    }
    // ... and the run says where the amount comes from: the balance alone, the log has no reward line.
    expect(sentences.some((s) => s.includes("lu sur le solde seul"))).toBe(true);

    // ---- The run itself: the reward is in the balance, so its net is not the run's own, and the card says so.
    const run = newestRun(p).money;
    expect(run.net).toMatchObject({ auec: F.net + REWARD_NEAR, method: "mesure" });
    expect(run.fees.total).toBeNull(); // the sale fee cannot be told from the reward: not invented
    expect(run.fees.method).toBeNull();
    expect(run.fees.reason).toBe("solde_autre_raison");
    expect(run.fees.buy).toEqual({ auec: F.buyFee, method: "groupe" });
    expect(run.fees.sell).toBeNull();
    // The margin explains the run; the rest (the reward, as a negative gap) is shown as unexplained, not as a fee.
    expect(run.fees.unexplained).toBe(F.gross - (F.net + REWARD_NEAR));
    expect(run.decomposition.closes).toBe(false);
    const parts = Object.values(run.decomposition.parts) as number[];
    expect(parts.reduce((a, b) => a + b, 0)).toBe(F.net + REWARD_NEAR);
    expect(run.decomposition.parts).toMatchObject({ transactions: -F.cost, fees: -F.buyFee });

    // ---- The contracts: their gain is a raw measure that says it may hold other flows.
    const gains = Object.fromEntries(p.ledger.contracts.map((c: any) => [c.title, c.gain]));
    expect(gains["Ore Delivery | Hard"]).toMatchObject({
      auec: REWARD_FAR,
      confidence: "mesure_brute",
      mixed_flows_possible: true,
    });
    expect(gains["Waste Disposal | Easy"]).toMatchObject({
      auec: F.net + REWARD_NEAR, // the whole run happened while this contract was open
      confidence: "mesure_brute",
      mixed_flows_possible: true,
    });

    // ---- The session counts the money ONCE: contract A's balance change holds the cargo run, which the run counts.
    const file = w.sessionsJson();
    const trips = file.sessions[0]!.trips;
    expect(trips.map((t) => [t.kind, t.label, t.net_auec])).toEqual([
      ["hauling", "Waste Disposal | Easy", F.net + REWARD_NEAR],
      ["trade", "Cargo Laranite (lien par prix)", F.net + REWARD_NEAR],
      ["hauling", "Ore Delivery | Hard", REWARD_FAR],
    ]);
    expect(trips[1]).toMatchObject({ net_doubtful: true, fees_auec: null });
    const cur = (await w.call("sc_session_current", { include_balance: true })).data;
    expect(cur.session.money).toMatchObject({
      overlap_excluded: 1,
      net_auec: variation, // run + contract B, the overlapping contract is left out
      net_source: "trips",
      balance_change_auec: variation,
    });
    expect(cur.session.money.net_auec).toBe(cur.session.money.balance_change_auec);
    // The only planned trip is the run whose net holds the reward: it is not compared with its plan (it used to show 113 %
    // of the plan for a run that made 79 % of it).
    expect(cur.session.money.plan).toBeNull();

    // ---- Privacy: none of it without the balance, all of it with.
    const without = await sweepWithoutBalance(w);
    expectAbsent(
      without.all,
      [
        ...MONEY,
        REWARD_NEAR,
        REWARD_FAR,
        F.net + REWARD_NEAR,
        variation,
        PLAYER_RUN.end + REWARD_NEAR + REWARD_FAR,
      ],
      "the answers without the balance",
    );
    expect(without.all).not.toMatch(/probable_contract_reward|récompense|"gain"/);
    const withB = await sweepWithBalance(w);
    expectPresent(withB, [REWARD_NEAR, REWARD_FAR, variation], "the answers with the balance");
    // Positive control for the labels: with the balance they are there.
    expect(withB).toMatch(/probable_contract_reward/);
    expect(withB).toMatch(/solde_autre_raison/);
  });
});
