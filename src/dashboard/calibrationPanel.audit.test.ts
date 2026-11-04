import { describe, expect, it } from "vitest";
import {
  calibrationExpected,
  calibrationKey,
  calibrationLine,
  calibrationNextTile,
  calibrationNormalize,
  calibrationPick,
} from "./calibrationPanel.js";
import { ledgerNum, ledgerOneOf, ledgerText } from "./ledgerPanel.js";

/**
 * Feature (audit of the first version): names that are not plain Latin still make groups, an enormous ratio is never
 * printed as a percentage, unverified goods are said on the line and on the tile, a two-leg card says which leg the line
 * is about. Invented figures; non-Latin samples are built from code points.
 */

const L = { ledgerNum, ledgerText, ledgerOneOf };
const NBSP_FREE = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");
const word = (...codes: number[]) => String.fromCodePoint(...codes);
const CYRILLIC = word(0x41b, 0x430, 0x440, 0x430, 0x43d, 0x438, 0x442); // a name with no Latin letter at all
const CYRILLIC_2 = word(0x417, 0x43e, 0x43b, 0x43e, 0x442, 0x43e);

const group = (over: Record<string, unknown> = {}) => ({
  kind: "commodity",
  commodity: "Laranite",
  buy_terminal: null,
  sell_terminal: null,
  n: 4,
  confidence: "medium",
  gross_ratio: 0.8,
  gross_min: 0.7,
  gross_max: 0.9,
  high_variance: false,
  net_ratio: 0.76,
  net_n: 4,
  net_confidence: "medium",
  fee_rate: 0.05,
  fee_n: 4,
  last_run_age_days: 1,
  quantity_adjusted: 0,
  quantity_unknown: 0,
  ...over,
});
const calib = (...groups: Record<string, unknown>[]) =>
  calibrationNormalize(L, { v: 1, patch_line: "4.10", groups })!;

describe("Feature: the comparison key never makes a group invisible", () => {
  it("Given accents, Then they are folded; given a name with no Latin letter, Then it is still a key and two such names differ", () => {
    expect(calibrationKey("Médical  Supplies")).toBe("medicalsupplies");
    expect(calibrationKey("ŒUF")).toBe(calibrationKey("œuf"));
    expect(calibrationKey(CYRILLIC)).not.toBe("");
    expect(calibrationKey(CYRILLIC)).toBe(calibrationKey(CYRILLIC.toUpperCase()));
    expect(calibrationKey(CYRILLIC)).not.toBe(calibrationKey(CYRILLIC_2));
  });

  it("Given a name of signs only, Then it falls back on a stable hash, and a blank name stays empty", () => {
    const k = calibrationKey("--- / ---");
    expect(k).toMatch(/^h[0-9a-f]+$/);
    expect(calibrationKey("--- / ---")).toBe(k);
    expect(calibrationKey("+++")).not.toBe(k);
    expect(calibrationKey("   ")).toBe("");
    expect(calibrationKey(null)).toBe("");
  });

  it("Given a group named without Latin letters, Then it is picked for the same name and for no other", () => {
    const c = calib(group({ commodity: CYRILLIC }), group({ commodity: CYRILLIC_2, n: 3 }));
    expect(calibrationPick(c, CYRILLIC, null, null)!.group.commodity).toBe(CYRILLIC);
    expect(calibrationPick(c, CYRILLIC_2, null, null)!.group.n).toBe(3);
    expect(calibrationPick(c, "Laranite", null, null)).toBeNull();
    expect(calibrationLine(c, CYRILLIC, null, null)).not.toBeNull();
  });
});

describe("Feature: a ratio that rests on a tiny plan is not printed as a percentage", () => {
  it("Given a ratio of 666, Then the line says the gap is very high and shows no percentage of it", () => {
    const c = calib(group({ gross_ratio: 666, net_ratio: 650 }));
    const line = calibrationLine(c, "Laranite", null, null);
    expect(NBSP_FREE(line.text)).toContain("écart très élevé entre le réalisé et le prévu");
    expect(line.text).not.toMatch(/66\s?600|\b666\b/);
    // no calibrated expectation either: a huge ratio times the plan is not an estimate
    expect(calibrationExpected(c.groups[0], 100_000, 300_000)).toBeNull();
    expect(
      calibrationNextTile(
        c,
        { commodity: "Laranite", scu: 10, sell_unit_price: 100 },
        { planned_profit: 100_000 },
      ),
    ).toBeNull();
  });
});

describe("Feature: unverified goods are said where the figure is shown", () => {
  it("Given a group tied to its plan by prices, Then the line says the runs resemble the plan and the tag explains the cap", () => {
    const c = calib(group({ goods_unverified: true, confidence: "medium" }));
    const line = calibrationLine(c, "Laranite", null, null);
    expect(NBSP_FREE(line.text)).toBe(
      "D’après tes 4 trajets similaires (marchandise non vérifiée) : tu réalises ≈ 80 % du prévu (frais ≈ 5 %).",
    );
    expect(line.text).not.toContain("de cette marchandise");
    // the jargon is not in the visible line: it is one fold away
    expect(line.text).not.toMatch(/lien par prix|premier tronçon|marge brute/);
    expect(line.more).toContain("lien par prix");
    expect(line.tag).toBe("estimé · 4 trajets · confiance moyenne");
    expect(line.hint).toContain("Confiance moyenne.");
    expect(line.hint).toContain("plafonnée à « moyenne »");
    expect(line.hint).toContain("une ressemblance, pas une preuve");
    const route = calib(
      group({ kind: "route", buy_terminal: "A", sell_terminal: "B", goods_unverified: true }),
    );
    expect(calibrationLine(route, "Laranite", "A", "B").text).toContain(
      "tes 4 trajets similaires (marchandise non vérifiée)",
    );
  });

  it("Given a verified group, Then the wording is the plain one and there is no hint", () => {
    const line = calibrationLine(calib(group()), "Laranite", null, null);
    expect(line.text).toContain("D’après tes 4 trajets de cette marchandise");
    expect(line.more).not.toContain("lien par prix");
    // the tooltip still says the confidence, and nothing about a cap
    expect(line.hint).toMatch(/^Confiance \w+\.$/);
  });

  it("Given the tile of an unverified group, Then its sub-line says so too and carries the hint", () => {
    const c = calib(group({ goods_unverified: true }));
    const tile = calibrationNextTile(
      c,
      { commodity: "Laranite", scu: 100, sell_unit_price: 130 },
      { planned_profit: 100_000 },
    );
    expect(NBSP_FREE(tile.sub)).toBe(
      "prévu × 76 % (net typique de tes 4 trajets qui ressemblent au plan, marchandise non vérifiée)",
    );
    expect(tile.hint).toContain("plafonnée");
  });
});

describe("Feature: the ceiling is said in written text (the fold under the line), not only in the tooltip", () => {
  it("Given a group held at medium by the price link, Then the fold says why and what the link leaves out; a group that is not capped says nothing of it", () => {
    const capped = calib(group({ goods_unverified: true, confidence_capped: true, n: 8 }));
    const line = calibrationLine(capped, "Laranite", null, null);
    const more = NBSP_FREE(line.more);
    expect(more).toContain("Confiance plafonnée à « moyenne » : les trajets qui rendent moins");
    expect(more).toContain("moins de la moitié du prévu ne sont pas rattachés");
    // the visible line keeps only the honest short form, the caveat is behind « Comment lire ça »
    expect(line.text).not.toContain("plafonnée");
    const plain = calib(group({ goods_unverified: true, confidence_capped: false }));
    expect(calibrationLine(plain, "Laranite", null, null).more).not.toContain("plafonnée");
  });
});

describe("Feature: a two-leg card says which leg the line is about", () => {
  it("Given a card with two legs, Then the line says it is about the 1st leg and the fold says it is no round-trip figure; a one-leg card has none of it", () => {
    const c = calib(group());
    const two = calibrationLine(c, "Laranite", null, null, 2);
    expect(two.text).toContain("Sur le 1er tronçon, d’après tes 4 trajets");
    expect(two.more).toContain("premier tronçon seulement");
    expect(two.more).toContain("pas un chiffre pour l’aller-retour");
    for (const one of [
      calibrationLine(c, "Laranite", null, null, 1),
      calibrationLine(c, "Laranite", null, null),
    ]) {
      expect(one.text).not.toContain("tronçon");
      expect(one.more).not.toContain("tronçon");
    }
  });
});
