import { describe, expect, it } from "vitest";
import { dashboardHtml, viewScript } from "./page.js";
import { SPECS_SAMPLES } from "./testing/specsFixtures.js";
import {
  SPECS_VIEW_FUNCTIONS,
  specsAgeText,
  specsFmt,
  specsInfo,
  specsScaleReason,
  speedGauge,
  speedObservedMax,
} from "./specsView.js";
import {
  extractElement,
  findAll,
  findButton,
  isShown,
  startPage,
  visibleText,
  type FakeNode,
} from "./testing/pageHarness.js";
import { VIEW_FUNCTIONS } from "./viewLogic.js";

const NBSP = String.fromCharCode(0xa0);
const plain = (s: string) => s.replaceAll(NBSP, " ").replaceAll(String.fromCharCode(0x202f), " ");
const READY = { ...SPECS_SAMPLES.ready };

describe("Feature: the speed gauge uses the limits of the ship's sheet", () => {
  it("Given SCM 210 and max 1100, When the ship does 183 m/s, Then it is 87 % of the SCM speed, marks at SCM and max", () => {
    const g = speedGauge(READY, 183, 500, false);
    expect(g.source).toBe("sheet");
    expect(g.pctScm).toBe(87);
    expect(plain(g.sub)).toBe("87 % de la vitesse SCM");
    expect(g.scmMark).toBeCloseTo(210 / 1100, 5);
    expect(g.maxMark).toBe(1);
    expect(g.fraction).toBeCloseTo(183 / 1100, 5);
    expect(g.over).toBe("none");
    expect(plain(g.scale)).toBe("repères d’après le wiki : SCM 210 · max 1 100 m/s");
  });

  it("Given a ship stopped, Then 0 % of the SCM speed and an empty bar, not a missing one", () => {
    const g = speedGauge(READY, 0, 0, false);
    expect(g.fraction).toBe(0);
    expect(g.pctScm).toBe(0);
  });

  it("Given a speed above SCM but within the sheet, Then it says above the SCM speed", () => {
    const g = speedGauge(READY, 400, 0, false);
    expect(g.over).toBe("scm");
    expect(plain(g.sub)).toBe("190 % de la vitesse SCM · au-dessus du SCM");
  });

  it("Given a speed beyond the sheet's maximum, Then it says so and the bar is full, not cut silently", () => {
    const g = speedGauge(READY, 1500, 0, false);
    expect(g.over).toBe("max");
    expect(g.fraction).toBe(1);
    expect(plain(g.sub)).toContain("au-delà de la fiche");
  });

  it("Given a quantum jump, Then the speed is out of the frame and it says so instead of a huge percentage", () => {
    const g = speedGauge(READY, 12000, 12000, true);
    expect(g.over).toBe("quantum");
    expect(g.fraction).toBe(1);
    expect(g.sub).toBe("hors cadre : saut quantique");
    expect(g.sub).not.toMatch(/%/);
    // Quantum mode within the frame (spooling): an ordinary reading.
    expect(speedGauge(READY, 100, 0, true).over).toBe("none");
  });

  it("Given a sheet with a maximum only, Then the scale is the maximum and the share is of the maximum", () => {
    const g = speedGauge({ status: "ready", speed_max_ms: 1000 }, 250, 0, false);
    expect(g.scmMark).toBeNull();
    expect(g.maxMark).toBe(1);
    expect(plain(g.sub)).toBe("25 % de la vitesse max");
  });

  it("Given a sheet with an SCM speed only, Then the SCM mark is the end of the scale", () => {
    const g = speedGauge({ status: "ready", speed_scm_ms: 200 }, 100, 0, false);
    expect(g.scmMark).toBe(1);
    expect(g.maxMark).toBeNull();
    expect(g.pctScm).toBe(50);
  });

  it("Given speeds of 0 in the sheet (not provided), Then they are no limit: the observed scale stays", () => {
    const g = speedGauge({ status: "ready", speed_scm_ms: 0, speed_max_ms: 0 }, 100, 400, false);
    expect(g.source).toBe("observed");
    expect(g.fraction).toBeCloseTo(0.25, 5);
    expect(g.scale).toBe("échelle déduite : la fiche ne donne pas de vitesse");
  });

  it("Given no usable sheet, Then the scale is the highest speed seen, with one line saying why", () => {
    const why = (specs: unknown) => speedGauge(specs, 100, 400, false);
    for (const [specs, line] of [
      [undefined, "échelle déduite des relevés"],
      [SPECS_SAMPLES.unknown, "échelle déduite : fiche du vaisseau introuvable"],
      [SPECS_SAMPLES.pending, "échelle déduite : fiche du vaisseau en cours de recherche"],
      [SPECS_SAMPLES.ambiguous, "échelle déduite : plusieurs fiches possibles, aucune choisie"],
      [SPECS_SAMPLES.error, "échelle déduite : fiche du vaisseau indisponible (wiki injoignable)"],
    ] as const) {
      const g = why(specs);
      expect(g.source).toBe("observed");
      expect(g.fraction).toBeCloseTo(0.25, 5);
      expect(g.scmMark).toBeNull();
      expect(g.maxMark).toBeNull();
      expect(g.sub).toBe("");
      expect(g.scale).toBe(line);
    }
  });

  it("Given no speed or no observed maximum, Then there is no fraction, never NaN", () => {
    expect(speedGauge(READY, null, 0, false).fraction).toBeNull();
    expect(speedGauge(READY, undefined, 0, false).sub).toBe("");
    expect(speedGauge(SPECS_SAMPLES.unknown, 5, 0, false).fraction).toBeNull();
    expect(speedGauge(SPECS_SAMPLES.unknown, Number.NaN, 10, false).fraction).toBeNull();
    expect(speedGauge(SPECS_SAMPLES.unknown, -3, 10, false).fraction).toBeNull();
  });

  it("Given garbage in the sheet, Then no output holds NaN, undefined or null", () => {
    const junk: unknown[] = [
      null,
      "x",
      [],
      { status: "ready", speed_scm_ms: "210", speed_max_ms: Number.NaN },
      { status: "ready", speed_scm_ms: Infinity },
      { status: 7 },
      { status: "ready", name: { a: 1 }, candidates: "no" },
    ];
    for (const specs of junk) {
      for (const v of [0, 50, 99999, null]) {
        const text = JSON.stringify([speedGauge(specs, v, 300, false), specsInfo(specs)]);
        expect(text).not.toMatch(/NaN|undefined|Infinity/);
      }
    }
  });

  it("Given the highest speed seen, Then speedObservedMax reads the series", () => {
    expect(speedObservedMax(undefined)).toBe(0);
    expect(speedObservedMax([])).toBe(0);
    expect(
      speedObservedMax([
        [1, 20],
        [2, 180],
        [3, 90],
      ]),
    ).toBe(180);
    expect(speedObservedMax([[1, Number.NaN], "x", null])).toBe(0);
  });
});

describe("Feature: the sheet line says where the figures come from and what is not known", () => {
  it("Given a ready sheet, Then the line names the ship, says wiki, and lists only the reliable figures", () => {
    const info = specsInfo({ ...READY, cargo_scu: undefined });
    expect(plain(info.line)).toContain("Fiche du vaisseau : Cutter (wiki)");
    expect(plain(info.line)).toContain("SCM 210 m/s");
    expect(plain(info.line)).toContain("max 1 100 m/s");
    expect(plain(info.line)).toContain("boucliers 4 000 PV");
    expect(plain(info.line)).toContain("coque 12 000 PV");
    expect(info.line).not.toMatch(/cargaison/);
    expect(info.rows.map((r: string[]) => r[0])).toEqual([
      "Vitesse SCM",
      "Vitesse max",
      "Cargaison",
      "Boucliers",
      "Coque",
      "Lecture",
    ]);
    expect(info.rows[2][1]).toBe("non fournie");
  });

  it("Given a sheet with an age and a date, Then the reading and the wiki's date are given", () => {
    const rows = specsInfo({ ...READY, age_ms: 3 * 60_000 }).rows;
    expect(rows[5][1]).toBe(
      "lue il y a 3 min · fiche modifiée le 2026-11-02 · version 4.10.2-LIVE.1",
    );
    const old = specsInfo({ ...READY, age_ms: 2 * 3_600_000, stale: true }).rows[5][1];
    expect(old).toContain("copie ancienne");
    expect(specsInfo({ status: "ready", name: "X" }).rows[5][1]).toBe("date inconnue");
  });

  it("Given any state, Then the note says the hydrogen tank capacity is not provided", () => {
    for (const specs of [undefined, ...Object.values(SPECS_SAMPLES)]) {
      const note = specsInfo(specs).note;
      expect(note).toContain("Capacité du réservoir d’hydrogène : non fournie");
      expect(note).toContain("estimation par la pente");
    }
  });

  it("Given a sheet, Then the View never invents a hydrogen figure", () => {
    const text = JSON.stringify(specsInfo({ ...READY, fuel: { capacity: 7.8 }, hydrogen: 5 }));
    expect(text).not.toMatch(/7[.,]8/);
  });

  it("Given an ambiguous answer, Then the candidates are listed and none is chosen", () => {
    const info = specsInfo(SPECS_SAMPLES.ambiguous);
    expect(info.line).toContain("Cutter Alpha, Cutter Beta, Cutter Gamma");
    expect(info.line).toContain("aucune choisie");
    expect(info.rows).toEqual([]);
  });

  it("Given other states, Then there is no line (the speed gauge says it)", () => {
    for (const s of [
      SPECS_SAMPLES.unknown,
      SPECS_SAMPLES.pending,
      SPECS_SAMPLES.error,
      undefined,
    ]) {
      expect(specsInfo(s).line).toBe("");
    }
  });

  it("Given long text in a name, Then the View caps it too", () => {
    const info = specsInfo({ status: "ready", name: "N".repeat(500), speed_scm_ms: 1 });
    expect(info.line.length).toBeLessThan(300);
  });

  it("Given ages and numbers, Then they read well", () => {
    expect(specsAgeText(10_000)).toBe("il y a moins d’une minute");
    expect(specsAgeText(5 * 60_000)).toBe("il y a 5 min");
    expect(specsAgeText(3 * 3_600_000)).toBe("il y a 3 h");
    expect(specsAgeText(50 * 3_600_000)).toBe("il y a 2 j");
    expect(specsAgeText(-1)).toBe("");
    expect(plain(specsFmt(1234567))).toBe("1 234 567");
    expect(specsFmt(Number.NaN)).toBe("—");
    expect(specsScaleReason(null)).toBe("échelle déduite des relevés");
  });
});

describe("Feature: the sheet functions ship inside the page like the others", () => {
  it("Given the two modules, Then no name is defined twice and every function is serialisable", () => {
    const names = [...VIEW_FUNCTIONS, ...SPECS_VIEW_FUNCTIONS].map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    const script = viewScript();
    for (const f of SPECS_VIEW_FUNCTIONS) {
      expect(script).toContain(`function ${f.name}(`);
    }
    // No module-level constant is used by name inside them: the script would fail in the page.
    expect(script).not.toContain("SPECS_");
    expect(script).not.toMatch(/__vi_|_import_/);
  });

  it("Given the page, Then the sheet styles are in the same stylesheet and use no image or address", () => {
    const style = extractElement(dashboardHtml(), "style")!;
    expect(style).toContain(".tick");
    expect(style).toContain(".specs-line");
    expect(style).not.toMatch(/url\(|@import|https?:/);
  });
});

// ---------------------------------------------------------------------------------------------
// The assembled page, against a fake host whose poll carries `specs`
// ---------------------------------------------------------------------------------------------

const SECOND = 1000;

async function pageWith(specs: unknown) {
  const world = await startPage();
  world.host.overrides.poll = (base) => (specs === undefined ? base : { ...base, specs });
  // 30 s into the story: the ship cruises at about 200 m/s.
  await world.advance(34 * SECOND);
  return world;
}

const byClass = (root: FakeNode, cls: string) =>
  findAll(root, (n) => n.className === cls || n.className.split(" ").includes(cls));

describe("Feature: the compact view shows the speed against the sheet", () => {
  it("Given a ready sheet, Then the SCM and max marks are drawn, the share is shown, and the line names the ship", async () => {
    const w = await pageWith(READY);
    const text = plain(visibleText(w.root));
    expect(text).toMatch(/\d+ % de la vitesse SCM/);
    expect(text).toContain("repères d’après le wiki : SCM 210 · max 1 100 m/s");
    expect(text).toContain("Fiche du vaisseau : Cutter (wiki)");
    const ticks = byClass(w.root, "tick");
    expect(ticks).toHaveLength(2);
    expect(ticks.every((t) => isShown(t))).toBe(true);
    const scm = ticks.find((t) => t.attrs["data-kind"] === "scm")!;
    expect(Number(scm.style.props["--at"])).toBeCloseTo(210 / 1100, 2);
    const bar = byClass(w.root, "bar").find((b) => b.attrs["data-marks"] === "1");
    expect(bar).toBeTruthy();
    expect(text).not.toMatch(/échelle déduite/);
  });

  it("Given an unknown sheet, Then the scale stays observed and the View says so in one line", async () => {
    const w = await pageWith(SPECS_SAMPLES.unknown);
    const text = visibleText(w.root);
    expect(text).toContain("échelle déduite : fiche du vaisseau introuvable");
    expect(text).not.toContain("Fiche du vaisseau :");
    expect(byClass(w.root, "tick").some((t) => isShown(t))).toBe(false);
    expect(byClass(w.root, "bar").some((b) => b.attrs["data-marks"] === "1")).toBe(false);
  });

  it("Given an ambiguous sheet, Then the candidates are named and nothing is chosen", async () => {
    const w = await pageWith(SPECS_SAMPLES.ambiguous);
    const text = visibleText(w.root);
    expect(text).toContain("plusieurs fiches possibles (Cutter Alpha, Cutter Beta, Cutter Gamma)");
    expect(text).toContain("échelle déduite : plusieurs fiches possibles, aucune choisie");
  });

  it("Given a pending or failed search, Then the scale stays observed, each with its own wording", async () => {
    const pending = await pageWith(SPECS_SAMPLES.pending);
    expect(visibleText(pending.root)).toContain("en cours de recherche");
    const failed = await pageWith(SPECS_SAMPLES.error);
    expect(visibleText(failed.root)).toContain("indisponible (wiki injoignable)");
  });

  it("Given an older server (no specs), Then the View works as before", async () => {
    const w = await pageWith(undefined);
    const text = visibleText(w.root);
    expect(text).toContain("échelle déduite des relevés");
    expect(text).not.toMatch(/NaN|undefined|null/);
  });

  it("Given the quantum jump of the story, Then the speed is said to be out of the frame", async () => {
    const w = await startPage();
    w.host.overrides.poll = (base) => ({ ...base, specs: READY });
    await w.advance(54 * SECOND);
    expect(plain(visibleText(w.root))).toContain("hors cadre : saut quantique");
  });

  it("Given hostile text in the sheet, Then it is shown as text and nothing becomes markup", async () => {
    const tags = "<img src=x onerror=alert(1)>";
    const w = await pageWith({
      ...READY,
      name: tags,
      version: "<script>1</script>",
      candidates: [tags],
    });
    expect(visibleText(w.root)).toContain(tags);
    // The fake DOM refuses innerHTML: reaching this point means only textContent was used.
  });

  it("Given the full-screen view, Then the card gives every figure, the age and the hydrogen note", async () => {
    const w = await pageWith(READY);
    findButton(w.root, "Plein écran").click();
    await w.advance(2 * SECOND);
    const text = plain(visibleText(w.root));
    expect(text).toContain("Fiche du vaisseau (wiki)");
    expect(text).toContain("Vitesse SCM");
    expect(text).toContain("210 m/s");
    expect(text).toContain("Cargaison");
    expect(text).toContain("4 SCU");
    expect(text).toContain("lue il y a 3 min");
    expect(text).toContain("Capacité du réservoir d’hydrogène : non fournie");
  });
});
