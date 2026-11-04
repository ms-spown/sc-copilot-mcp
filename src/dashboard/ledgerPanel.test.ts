import { describe, expect, it } from "vitest";
import {
  ledgerCurrent,
  ledgerGainText,
  ledgerInlineText,
  ledgerNormalize,
  ledgerPretty,
  ledgerStepNumber,
  ledgerStepText,
  ledgerStripBalance,
  ledgerTradeMoney,
} from "./ledgerPanel.js";
import { fmtAuec } from "./viewLogic.js";

/** The pure part of the panel, under Node. The DOM part is tested in ledgerPage.test.ts, on the assembled page. */

const contract = (extra: Record<string, unknown> = {}) => ({
  id: "abcd1234",
  title: "Job",
  state: "in_progress",
  accepted_at: "2026-11-03T18:00:00.000Z",
  ended_at: null,
  duration_ms: null,
  steps: [
    { kind: "pickup", location: "Outpost_One", cargo: "HaulCargo_Waste_Stanton" },
    { kind: "dropoff", location: "Station_Two", cargo: "HaulCargo_Waste_Stanton" },
    { kind: "dropoff", location: "Station_Three", cargo: "HaulCargo_Waste_Stanton" },
  ],
  steps_total: 3,
  steps_done: 1,
  ...extra,
});
const payload = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  status: "ok",
  contracts: [contract()],
  totals: {},
  ...extra,
});

describe("Feature: the View distrusts the payload", () => {
  it("Given anything that is not a version 1 payload, Then it is dropped", () => {
    for (const bad of [null, undefined, 3, "x", [], {}, { v: 2 }]) {
      expect(ledgerNormalize(bad)).toBeNull();
    }
  });

  it("Given fields of the wrong type or size, Then they are repaired or removed, never trusted", () => {
    const evil = ledgerNormalize(
      payload({
        status: "<script>",
        contracts: [
          null,
          contract({
            title: "X".repeat(900),
            state: "weird",
            steps_total: 10 ** 9,
            steps_done: -4,
            accepted_at: "not a date",
            steps: [{ kind: "teleport", location: "a", cargo: "b" }, ...contract().steps],
            gain: { auec: "12", reason: "<b>", overlapping: "yes" },
          }),
          ...Array.from({ length: 40 }, () => contract()),
        ],
      }),
    )!;
    expect(evil.status).toBe("off");
    expect(evil.contracts.length).toBeLessThanOrEqual(10);
    const c = evil.contracts[0];
    expect([...c.title].length).toBe(80);
    expect(c.state).toBe("ended");
    expect(c.accepted_at).toBeNull();
    expect(c.steps).toHaveLength(3); // the unknown kind is dropped
    expect(c.steps_done).toBe(0);
    expect(c.gain).toEqual({ auec: null, reason: "", overlapping: false });
  });

  it("Given invisible characters in a title, Then the View removes them too", () => {
    const n = ledgerNormalize(
      payload({
        contracts: [contract({ title: `A\u202eB\u200bC${String.fromCodePoint(0xe0041)}` })],
      }),
    )!;
    expect(n.contracts[0].title).toBe("ABC");
  });

  it("Given the balance is hidden again, Then everything derived from it is removed from the kept payload", () => {
    const stripped = ledgerStripBalance(
      payload({
        balance: { gain_auec: 5 },
        plan_compare: { expected_auec: 1 },
        contracts: [contract({ gain: { auec: 9 } })],
      }),
    );
    expect(JSON.stringify(stripped)).not.toMatch(/gain|balance|plan_compare/);
    expect(stripped.contracts[0].title).toBe("Job");
  });
});

describe("Feature: the compact line and the step counter", () => {
  it("Given a contract with three steps and one objective done, Then it reads step 2 of 3", () => {
    const n = ledgerNormalize(payload())!;
    expect(ledgerStepNumber(n.contracts[0])).toBe(2);
    expect(ledgerInlineText(n)).toBe("Contrat en cours : Job · étape 2/3");
  });

  it("Given every objective done but the contract not closed, Then the counter stops at the last step", () => {
    const n = ledgerNormalize(payload({ contracts: [contract({ steps_done: 3 })] }))!;
    expect(ledgerStepNumber(n.contracts[0])).toBe(3);
  });

  it("Given a contract without steps, Then there is no step part (nothing is invented)", () => {
    const n = ledgerNormalize(
      payload({ contracts: [contract({ steps: [], steps_total: 0, steps_done: 0 })] }),
    )!;
    expect(ledgerInlineText(n)).toBe("Contrat en cours : Job");
  });

  it("Given nothing running, a finished contract, or a log that is not ok, Then the line is empty", () => {
    expect(ledgerInlineText(null)).toBe("");
    expect(
      ledgerCurrent(ledgerNormalize(payload({ contracts: [contract({ state: "completed" })] }))),
    ).toBeNull();
    expect(ledgerInlineText(ledgerNormalize(payload({ status: "off" })))).toBe("");
  });
});

describe("Feature: wording", () => {
  it("Given game identifiers, Then they read as words, and a step with no goods shows none", () => {
    expect(ledgerPretty("HaulCargo_Waste_Stanton")).toBe("Waste Stanton");
    expect(ledgerStepText({ kind: "pickup", location: "Outpost_One", cargo: "" })).toBe(
      "Chargement · Outpost One",
    );
    expect(
      ledgerStepText({ kind: "dropoff", location: "Station_Two", cargo: "HaulCargo_Ore" }),
    ).toBe("Livraison · Station Two · Ore");
  });

  it("Given a gain, a missing gain and a negative gain, Then a missing one is never drawn as zero", () => {
    const L = { fmtAuec };
    expect(ledgerGainText(L, { auec: 0, reason: "", overlapping: false }).text).toContain("0");
    expect(ledgerGainText(L, { auec: -500, reason: "", overlapping: false }).tone).toBe("warn");
    for (const reason of ["pending", "balance_unknown", "no_times", ""]) {
      const g = ledgerGainText(L, { auec: null, reason, overlapping: false });
      expect(g.text).toMatch(/^Gain (en attente|indisponible)/);
      expect(g.text).not.toMatch(/aUEC/);
    }
    expect(ledgerGainText(L, null).text).toBe("");
  });
});

describe("Feature: the planned net says where its fee rate comes from", () => {
  it("Given a planned net, Then the origin of its rate is kept, and an unknown origin is dropped", () => {
    const money = (rate_from: unknown) =>
      ledgerTradeMoney({
        planned_net: { auec: 100, basis: "prix_du_plan", fee_rate: 0.1, fee: 10, rate_from },
      }).planned_net;
    expect(money("trajet_precedent").rate_from).toBe("trajet_precedent");
    expect(money("ce_trajet").rate_from).toBe("ce_trajet");
    expect(money("<script>").rate_from).toBe("");
  });
});
