import { describe, expect, it } from "vitest";
import { dashboardHtml, viewScript } from "./page.js";
import { specsSamples } from "./testing/specsFixtures.js";
import {
  SPECS_VIEW_FUNCTIONS,
  specsAgeMs,
  specsAgeText,
  specsClean,
  specsFmt,
  specsInfo,
  specsScaleReason,
  speedGauge,
  speedObservedMax,
  speedWithSheet,
} from "./specsView.js";
import {
  extractElement,
  findAll,
  findButton,
  startPage,
  visibleText,
  type FakeNode,
} from "./testing/pageHarness.js";
import { Scenario } from "./testing/scenario.js";
import { VIEW_FUNCTIONS } from "./viewLogic.js";

const NBSP = String.fromCharCode(0xa0);
const plain = (s: string) => s.replaceAll(NBSP, " ").replaceAll(String.fromCharCode(0x202f), " ");
const NOW = Date.parse("2026-11-03T18:00:00Z");
const SPECS_SAMPLES = specsSamples(NOW);
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
    expect(plain(g.scale)).toBe("marques SCM 210 · max 1 100 m/s, d’après la fiche (wiki)");
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
  it("Given a ready sheet, Then the card names the ship and lists only the reliable figures", () => {
    const info = specsInfo({ ...READY, cargo_scu: undefined });
    expect(info.line).toBe("Cutter");
    expect(plain(info.rows[0][1])).toBe("210 m/s");
    expect(plain(info.rows[1][1])).toBe("1 100 m/s");
    expect(plain(info.rows[3][1])).toBe("4 000 PV");
    expect(plain(info.rows[4][1])).toBe("12 000 PV");
    expect(specsInfo({ status: "ready", name: "X" }).line).toBe("X · aucun chiffre fourni");
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
    const rows = specsInfo(READY, 3 * 60_000).rows;
    expect(rows[5][1]).toBe(
      "lue il y a 3 min · fiche modifiée le 2026-11-02 · version 4.10.2-LIVE.1",
    );
    const old = specsInfo({ ...READY, stale: true }, 2 * 3_600_000).rows[5][1];
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
    expect(info.line).toContain("Cutter Alpha, Cutter Beta, Cutter Gamma");
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
    expect(style).toContain(".arc-mark");
    expect(style).toContain('data-sheet="1"');
    expect(style).not.toMatch(/url\(|@import|https?:/);
  });
});

describe("Feature: the dial of instrumentInfo is completed with the sheet", () => {
  const dial = (extra = {}) => ({
    known: true,
    text: "184",
    unit: "m/s",
    fraction: 0.6,
    peak: 0.7,
    level: "ok",
    sub: "échelle 0–300 m/s, déduite des vitesses vues",
    ...extra,
  });

  it("Given a ready sheet, Then marks, share of SCM and the sheet as the source replace the deduced scale", () => {
    const out = speedWithSheet(dial(), READY, 183, false);
    expect(out.marks.scm).toBeCloseTo(210 / 1100, 5);
    expect(out.marks.max).toBe(1);
    expect(out.peak).toBeNull();
    expect(out.fraction).toBeCloseTo(183 / 1100, 5);
    expect(plain(out.subShort)).toBe("87 % SCM");
    expect(plain(out.sub)).toBe(
      "87 % de la vitesse SCM · marques SCM 210 · max 1 100 m/s, d’après la fiche (wiki)",
    );
    expect(out.sub).not.toContain("déduite");
  });

  it("Given a speed beyond the sheet, Then the dial is full and it says so; in quantum, out of the frame", () => {
    const over = speedWithSheet(dial(), READY, 1500, false);
    expect(over.over).toBe("max");
    expect(over.fraction).toBe(1);
    expect(plain(over.sub)).toContain("au-delà de la fiche");
    const q = speedWithSheet(dial({ sub: "mode quantique" }), READY, 12000, true);
    expect(q.over).toBe("quantum");
    expect(q.sub).toContain("hors cadre : saut quantique");
  });

  it("Given no usable sheet, Then the dial keeps its scale and the line says why, in one line", () => {
    const why: [unknown, string][] = [
      [undefined, "échelle 0–300 m/s, déduite des vitesses vues"],
      [SPECS_SAMPLES.unknown, "échelle 0–300 m/s, déduite : fiche du vaisseau introuvable"],
      [
        SPECS_SAMPLES.pending,
        "échelle 0–300 m/s, déduite : fiche du vaisseau en cours de recherche",
      ],
      [
        SPECS_SAMPLES.ambiguous,
        "échelle 0–300 m/s, déduite : plusieurs fiches possibles, aucune choisie",
      ],
      [
        SPECS_SAMPLES.error,
        "échelle 0–300 m/s, déduite : fiche du vaisseau indisponible (wiki injoignable)",
      ],
      [
        { status: "ready", speed_scm_ms: 0, speed_max_ms: 0 },
        "échelle 0–300 m/s, déduite : la fiche ne donne pas de vitesse",
      ],
    ];
    for (const [specs, line] of why) {
      const out = speedWithSheet(dial(), specs, 100, false);
      expect(out.sub).toBe(line);
      expect(out.subShort).toBe(line);
      expect(out.marks).toBeNull();
      expect(out.fraction).toBe(0.6);
      expect(out.peak).toBe(0.7);
    }
  });

  it("Given an unknown dial (ship off, no data), Then it is returned untouched", () => {
    const off = { known: false, text: "—", fraction: null };
    expect(speedWithSheet(off, READY, 0, false)).toBe(off);
    expect(speedWithSheet(undefined, READY, 0, false)).toBeUndefined();
  });
});

describe("Feature: the age of the sheet is worked out from when it was read", () => {
  it("Given fetched_at and the poll's own time, Then the age is the gap plus the time since the poll arrived", () => {
    const poll = { at: NOW, specs: READY };
    expect(specsAgeMs(poll, 1000, 1000)).toBe(3 * 60_000);
    expect(specsAgeMs(poll, 1000, 31_000)).toBe(3 * 60_000 + 30_000);
    expect(specsAgeMs({ at: NOW, specs: { status: "ready" } }, 0, 0)).toBeNull();
    expect(specsAgeMs({ at: NOW, specs: { fetched_at: "no" } }, 0, 0)).toBeNull();
    expect(specsAgeMs({ specs: READY }, 0, 0)).toBeNull();
    expect(specsAgeMs(null, 0, 0)).toBeNull();
  });
});

describe("Feature: a sheet from another page is rebuilt field by field", () => {
  it("Given a hostile object, Then only known fields with the right types survive", () => {
    const clean = specsClean({
      status: "ready",
      name: "N".repeat(500),
      speed_scm_ms: 210,
      speed_max_ms: "fast",
      cargo_scu: -4,
      shield_hp: Infinity,
      fetched_at: "2026-11-03T00:00:00Z",
      candidates: ["a", 5, "b".repeat(500), ...Array.from({ length: 20 }, () => "c")],
      evil: "<img src=x>",
      __proto__: { polluted: true },
    });
    expect(clean.name.length).toBe(60);
    expect(clean.speed_scm_ms).toBe(210);
    expect(clean).not.toHaveProperty("speed_max_ms");
    expect(clean).not.toHaveProperty("cargo_scu");
    expect(clean).not.toHaveProperty("shield_hp");
    expect(clean).not.toHaveProperty("evil");
    expect(clean.candidates.length).toBeLessThanOrEqual(8);
    expect(clean.candidates.every((c: string) => c.length <= 60)).toBe(true);
    expect(clean.source).toBe("star-citizen.wiki");
  });

  it("Given anything that is not a sheet, Then null", () => {
    for (const bad of [null, undefined, "x", 3, [], { status: "weird" }, { name: "x" }]) {
      expect(specsClean(bad)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The assembled page, against a fake host whose scenario carries `specs` (through the real delta protocol)
// ---------------------------------------------------------------------------------------------

const SECOND = 1000;

async function pageWith(name: keyof ReturnType<typeof specsSamples> | null, seconds = 34) {
  const scenario = new Scenario();
  const world = await startPage({ scenario });
  if (name) scenario.specs = specsSamples(scenario.now)[name];
  // 30 s into the story: the ship cruises at about 200 m/s.
  await world.advance(seconds * SECOND);
  return world;
}

// The dial that is drawn: the compact one, or the large one in full screen (the other is not updated).
const speedDials = (root: FakeNode) =>
  findAll(
    root,
    (n) =>
      n.className.startsWith("dial") &&
      n.attrs["data-key"] === "speed" &&
      n.attrs["data-sheet"] !== undefined,
  );
const marks = (root: FakeNode) => findAll(root, (n) => n.attrs["class"] === "arc-mark");

describe("Feature: the speed dial of the cockpit shows the ship's limits", () => {
  it("Given a ready sheet, Then the arc carries the SCM and max marks and the share of SCM is written", async () => {
    const w = await pageWith("ready");
    const dials = speedDials(w.root);
    expect(dials.length).toBeGreaterThan(0);
    for (const d of dials) expect(d.attrs["data-sheet"]).toBe("1");
    const text = plain(visibleText(w.root));
    // The small dial keeps to one short line; the source of the scale is the tooltip of that line.
    expect(text).toMatch(/\d+ % SCM/);
    expect(text).not.toMatch(/fiche \(wiki\)/);
    const sub = findAll(
      w.root,
      (n) => n.className === "dial-sub" && (n.attrs["data-tip"] ?? "") !== "",
    );
    expect(sub.length).toBeGreaterThan(0);
    expect(plain(sub[0]!.attrs["data-tip"]!)).toMatch(
      /\d+ % de la vitesse SCM · marques SCM .* d’après la fiche \(wiki\)/,
    );
    expect(text).not.toMatch(/déduite des vitesses vues/);
    const scm = marks(w.root).find((m) => m.attrs["data-kind"] === "scm")!;
    const max = marks(w.root).find((m) => m.attrs["data-kind"] === "max")!;
    expect(scm.attrs["stroke-dasharray"]).toMatch(/^0 \d+(\.\d+)? 1\.2 200$/);
    expect(max.attrs["stroke-dasharray"]).toMatch(/^0 99\.4 1\.2 200$/);
    // No second dial and no parallel line in the compact view.
    expect(speedDials(w.root)).toHaveLength(1);
    expect(text).not.toContain("Fiche du vaisseau :");
  });

  it("Given no sheet for the ship, Then the scale stays deduced and one line says why", async () => {
    for (const [name, line] of [
      ["unknown", "déduite : fiche du vaisseau introuvable"],
      ["pending", "déduite : fiche du vaisseau en cours de recherche"],
      ["error", "déduite : fiche du vaisseau indisponible"],
      ["ambiguous", "déduite : plusieurs fiches possibles"],
    ] as const) {
      const w = await pageWith(name);
      // The compact dial is narrow: its sub is the short sentence; the full view carries the whole line.
      findButton(w.root, "Plein écran").click();
      await w.advance(2 * SECOND);
      const text = visibleText(w.root);
      expect(text).toContain(line);
      for (const d of speedDials(w.root)) expect(d.attrs["data-sheet"]).toBe("0");
      expect(marks(w.root).every((m) => m.attrs["stroke-dasharray"] === "0 0 0 200")).toBe(true);
    }
  });

  it("Given an older server (no specs at all), Then the dial is exactly what it was", async () => {
    const w = await pageWith(null);
    const text = visibleText(w.root);
    expect(text).toMatch(/déduite des vitesses vues/);
    expect(text).not.toMatch(/NaN|undefined|null/);
    for (const d of speedDials(w.root)) expect(d.attrs["data-sheet"]).toBe("0");
  });

  it("Given the quantum jump of the story, Then the speed is said to be out of the frame", async () => {
    const scenario = new Scenario();
    const w = await startPage({ scenario });
    scenario.specs = specsSamples(scenario.now).ready;
    await w.advance(54 * SECOND);
    expect(plain(visibleText(w.root))).toContain("hors cadre : saut quantique");
    for (const d of speedDials(w.root)) expect(d.attrs["data-over"]).toBe("quantum");
  });

  it("Given the sheet held by the View, Then later polls do not carry it again, and the page still shows it", async () => {
    const w = await pageWith("ready", 10 + 24);
    const withSheet = w.host.log.polls.filter((p) => p.bytes > 0);
    expect(withSheet.length).toBeGreaterThan(5);
    await w.advance(5 * SECOND);
    const text = plain(visibleText(w.root));
    expect(text).toMatch(/\d+ % SCM/);
    // Asked with the hash, answered without the section: the poll is lighter than the first one that carried it.
    const sheetBytes = JSON.stringify(specsSamples(NOW).ready).length;
    const last = w.host.log.polls[w.host.log.polls.length - 1]!;
    const carrying = w.host.log.polls.find((p) => p.bytes > last.bytes + sheetBytes / 2);
    expect(carrying).toBeDefined();
  });

  it("Given hostile text in the sheet, Then it is shown as text and nothing becomes markup", async () => {
    const scenario = new Scenario();
    const w = await startPage({ scenario });
    const tags = "<img src=x onerror=alert(1)>";
    scenario.specs = {
      ...specsSamples(scenario.now).ready,
      name: tags,
      version: "<script>1</script>",
    };
    await w.advance(34 * SECOND);
    findButton(w.root, "Plein écran").click();
    await w.advance(2 * SECOND);
    expect(visibleText(w.root)).toContain(tags);
    // The fake DOM refuses innerHTML: reaching this point means only textContent was used.
  });

  it("Given the full-screen view, Then the card gives every figure, the age and the hydrogen note", async () => {
    const w = await pageWith("ready");
    findButton(w.root, "Plein écran").click();
    await w.advance(2 * SECOND);
    const text = plain(visibleText(w.root));
    expect(text).toContain("Fiche du vaisseau (wiki)");
    expect(text).toContain("Vitesse SCM");
    expect(text).toContain("210 m/s");
    expect(text).toContain("4 SCU");
    expect(text).toMatch(/lue il y a [34] min/);
    expect(text).toContain("Capacité du réservoir d’hydrogène : non fournie");
    expect(text).not.toMatch(/NaN|undefined/);
  });

  it("Given an ambiguous sheet in full screen, Then the candidates are named and none is chosen", async () => {
    const w = await pageWith("ambiguous");
    findButton(w.root, "Plein écran").click();
    await w.advance(2 * SECOND);
    const text = visibleText(w.root);
    expect(text).toContain("Cutter Alpha, Cutter Beta, Cutter Gamma");
    expect(text).toContain("aucune choisie");
  });
});

describe("Feature: followers show the leader's sheet (snapshots over the channel are checked)", () => {
  it("Given a snapshot with a sheet, Then specsClean keeps the sheet and drops anything unknown", () => {
    const sheet = specsClean({ ...READY, injected: { a: 1 } });
    expect(sheet).toMatchObject({ status: "ready", name: "Cutter", speed_scm_ms: 210 });
    expect(sheet).not.toHaveProperty("injected");
  });
});
