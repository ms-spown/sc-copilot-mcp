import { describe, expect, it } from "vitest";
import { judgePreflight, type PreflightPlanEcho } from "../providers/uex/preflight.js";
import { describePreflight } from "./preflightText.js";

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
