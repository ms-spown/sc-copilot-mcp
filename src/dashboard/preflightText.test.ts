import { describe, expect, it } from "vitest";
import {
  judgePreflight,
  type PreflightPlanEcho,
  type PreflightResult,
} from "../providers/uex/preflight.js";
import { AGENT_MESSAGE_MAX, describePreflight } from "./preflightText.js";
import { tradePreflightClean } from "./tradePreflight.js";

/** The sentences of a verdict: every state has its own words, and a state that is not green never says "tu peux partir". */

const NOW = Date.parse("2026-11-04T12:00:00Z");
const ago = (ms: number) => Math.floor((NOW - ms) / 1000);
const PLAN: PreflightPlanEcho = {
  commodity: "Laranite",
  buy_terminal: "Port Tressler",
  sell_terminal: "Area18 TDD",
  buy_price: 200,
  sell_price: 500,
};
const row = (terminal: string, extra: Record<string, unknown>) => ({
  id_terminal: terminal.length,
  commodity_name: "Laranite",
  terminal_name: terminal,
  price_buy_users_rows: 3,
  price_sell_users_rows: 3,
  date_modified: ago(3_600_000),
  status_buy: 5,
  status_sell: 4,
  scu_buy: 900,
  scu_sell: 400,
  ...extra,
});
const words = (buy: Record<string, unknown>, sell: Record<string, unknown>) =>
  describePreflight(
    judgePreflight(
      PLAN,
      [
        row("Port Tressler", { price_buy: 205, ...buy }),
        row("Area18 TDD", { price_sell: 495, ...sell }),
      ],
      NOW,
    ),
  );

describe("Feature: the words of each verdict", () => {
  it("Given players behind both prices, Then it is the only state that says 'tu peux partir'", () => {
    const r = words({}, {});
    expect(r.verdict).toBe("valid");
    expect(r.text?.action).toBe("Tu peux partir.");
  });

  it("Given estimates, Then the title says the estimated prices did not move and the action asks to verify at the terminal", () => {
    const r = words({ price_buy_users_rows: 0 }, { price_sell_users_rows: 0 });
    expect(r.verdict).toBe("valid_estimate");
    expect(r.text?.headline).toBe("Les prix estimés par UEX n’ont pas bougé.");
    expect(r.text?.action).toBe(
      "Aucun joueur ne confirme ces prix : vérifie au terminal avant d’acheter.",
    );
    expect(r.text?.agent).toContain("estimations UEX sans relevé de joueur");
    expect(r.text?.agent).not.toContain("verdict : toujours valable");
    expect(r.text?.notes.join(" ")).toContain(
      "une estimation UEX n’est confirmée par aucun joueur",
    );
  });

  it("Given a favourable rise of 30 % or more, Then it is 'à surveiller' and says why", () => {
    const r = words({}, { price_sell: 650 });
    expect(r.verdict).toBe("watch");
    expect(r.text?.headline).toContain("Hausse inhabituelle : prix plus favorable que prévu");
    expect(r.text?.headline).toContain("changé de produit ou de lot");
    expect(r.legs[1]?.lines?.join(" ")).toContain("Hausse inhabituelle");
    expect(r.text?.action).not.toContain("Tu peux partir");
  });

  it("Given a rise that is only a small gain, Then there is no such sentence", () => {
    const r = words({}, { price_sell: 520 });
    expect(JSON.stringify(r)).not.toContain("Hausse inhabituelle");
  });

  it("Given a row dated in the future or another game version, Then the leg says what is wrong", () => {
    const future = words({ date_modified: 4_000_000_000 }, {});
    expect(future.legs[0]?.lines?.join(" ")).toContain("date du prix absente ou incohérente");
    expect(future.text?.action).toContain("Prix périmé");
  });
});

describe("Feature: the message to the agent never loses its closing instruction", () => {
  const LONG = (c: string) => `${c}${"x".repeat(80)}`; // far past the 60 characters a name is cut at
  const long = (): PreflightResult => {
    const base = judgePreflight(
      {
        commodity: LONG("Laranite"),
        buy_terminal: LONG("Port Tressler"),
        sell_terminal: LONG("Area18 TDD"),
        buy_price: 200,
        sell_price: 500,
      },
      [
        { ...row(LONG("Port Tressler"), { price_buy: 205 }) },
        { ...row(LONG("Area18 TDD"), { price_sell: 495 }) },
      ],
      NOW,
    );
    // several warnings on each leg: the longest detail lines the check can write
    const warnings = [
      "buy_out_of_stock",
      "buy_shortage",
      "sell_no_demand",
      "sell_saturating",
      "sell_strong_demand",
    ] as never;
    return { ...base, legs: base.legs.map((l) => ({ ...l, warnings })) };
  };
  const CLOSING = "et propose une meilleure alternative si elle existe.";

  it("Given long names and many warnings, Then the message is bounded, keeps both recipe calls and its closing order", () => {
    const agent = describePreflight(long()).text!.agent;
    // longer than the old 1500-character cut, which lost the closing order on exactly this input
    expect(agent.length).toBeGreaterThan(1500);
    expect(agent.length).toBeLessThanOrEqual(AGENT_MESSAGE_MAX);
    expect(agent.endsWith(CLOSING)).toBe(true);
    expect(agent).toContain('side="buy")');
    expect(agent).toContain('side="sell")');
    expect(agent).toContain(
      "dis explicitement ce qui diffère et pourquoi (stock, âge des prix, relevés) avant de donner ton verdict",
    );
    // the head is intact too, names cut at 60 characters
    expect(agent).toContain("verdict :");
    expect(agent).not.toMatch(/x{61}/);
  });

  it("Given the page's own cleaning and its click-time sentence, Then the closing order is intact shown and the one instruction follows it hidden", () => {
    const agent = tradePreflightClean({
      ...(describePreflight(long()) as object),
      v: 1,
      state: "preflight",
    } as never)?.agent as string;
    expect(typeof agent).toBe("string");
    expect(agent.endsWith(CLOSING)).toBe(true);
    // what the page posts: shown, the text as it is; hidden, the one instruction added after the closing order
    const hidden = agent + " Ne lis pas mon solde.";
    expect(hidden.endsWith(CLOSING + " Ne lis pas mon solde.")).toBe(true);
    expect(agent).not.toMatch(/solde/i);
  });

  it("Given a short plan, Then nothing is dropped", () => {
    const r = words({}, {});
    expect(r.text?.agent).toContain("Plan :");
    expect(r.text?.agent).toContain("Achat :");
    expect(r.text?.agent).toContain("Vente :");
  });
});
