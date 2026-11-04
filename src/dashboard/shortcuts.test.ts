/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { shortcutsFor, shortcutsKeyNote, shortcutsTable } from "./shortcutsPanel.js";
import { SHORTCUTS_SOURCES } from "./shortcutsSources.js";
import * as V from "./viewLogic.js";
import { cleanPoll } from "./viewLogic.js";

/**
 * Feature: the "Raccourcis" reminders. The pure part: the table of keys, and what each situation of the game shows.
 * Every poll below is made up. The rule behind every case: a signal that is not verified shows nothing, and a key that
 * fewer than two independent sources agree on is never printed.
 */

const LIB = { ...V };
const NB = String.fromCharCode(160);
const live = (patch: any = {}): any => ({
  v: 1,
  state: "live",
  ship: null,
  pilot: null,
  derived: null,
  conditions: [],
  ...patch,
});
const shipFlight = (patch: any = {}, extra: any = {}): any =>
  live({
    ship: { landed: false, gear: "retracted", ...patch },
    pilot: { locomotion: "seated" },
    derived: {},
    ...extra,
  });
const cond = (id: string, data?: any): any => ({
  id,
  level: "warning",
  confidence: "confirmed",
  ...(data ? { data } : {}),
});
const run = (poll: any, opts: any = {}) => shortcutsFor(LIB, poll, opts);
const ids = (poll: any, opts: any = {}) => run(poll, opts).items.map((i: any) => i.id);
const texts = (r: any) =>
  [r.label, r.empty, ...r.items.flatMap((i: any) => [i.label, i.note, ...i.keys])].join("\n");

describe("Feature: the table of default keys is explicit data, with at least two sources behind every key", () => {
  const table = shortcutsTable();
  const meta = SHORTCUTS_SOURCES;

  it("Given the sources file, Then it is versioned, dated, names its sources and says nothing is verified in the game", () => {
    expect(meta.version).toBe(1);
    expect(meta.checked).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(meta.game).toBe("4.10");
    expect(Object.keys(meta.sources).length).toBeGreaterThanOrEqual(2);
    for (const s of Object.values(meta.sources)) expect(s.length).toBeGreaterThan(10);
    expect(meta.verified).toEqual([]);
  });

  it("Given every action, Then a key has at least two distinct sources, each one written in the sources file, and no key has none", () => {
    const seen = new Set<string>();
    for (const e of table) {
      expect(seen.has(e.id), e.id).toBe(false);
      seen.add(e.id);
      expect(e.label.length, e.id).toBeGreaterThan(3);
      if (e.keys.length > 0) {
        const letters = new Set<string>(e.src.split(""));
        expect(letters.size, `${e.id}: a key needs two distinct sources`).toBeGreaterThanOrEqual(2);
        expect(e.src.length, `${e.id}: a source is listed twice`).toBe(letters.size);
        for (const letter of letters)
          expect(meta.sources[letter], `${e.id} ${letter}`).toBeTruthy();
      } else {
        expect(e.src, e.id).toBe("");
      }
    }
    for (const id of meta.verified) expect(seen.has(id), id).toBe(true);
  });

  it("Given the keys that were wrong or disputed, Then they are gone: no B, no C, no R, no Alt, nothing held", () => {
    const keys = table.flatMap((e: any) => e.keys);
    for (const k of ["B", "C", "R", "Alt", "Ctrl", "N", "V", "L", "O", "U", "I", "P"]) {
      expect(keys, k).not.toContain(k);
    }
    for (const e of table)
      expect(Object.keys(e).sort(), e.id).toEqual(["id", "keys", "label", "src"]);
    // the shown reminders carry no "hold" either
    const decoy = run(shipFlight({}, { conditions: [cond("hostile_lock")] })).items[0];
    expect(Object.keys(decoy).sort()).toEqual(["id", "keys", "label", "note", "tier"]);
  });

  it("Given the actions withheld for a reason, Then each is in the table, has no key and says why", () => {
    const byId = Object.fromEntries(table.map((e: any) => [e.id, e]));
    for (const [id, why] of Object.entries(meta.withheld)) {
      expect(byId[id], id).toBeTruthy();
      expect(byId[id].keys, id).toEqual([]);
      expect(why.length, id).toBeGreaterThan(5);
    }
    for (const id of ["qt", "cruise", "decoupled", "ready", "lights", "gear", "land_auto"]) {
      expect(byId[id].keys, id).toEqual([]);
    }
  });

  it("Given the wording, Then the exact phrases are the ones written (no stray escape, no non-breaking space in the table)", () => {
    const labels = Object.fromEntries(table.map((e: any) => [e.id, e.label]));
    expect(labels.land_auto).toBe("Atterrissage automatique");
    expect(labels.suit).toBe("Lampe de combinaison");
    expect(labels.lights).toBe("Phares");
    expect(labels.land_req).toBe("Demander l’atterrissage");
    expect(labels.qt).toBe("Saut quantique");
    expect(shortcutsKeyNote()).toBe(
      "Touche par défaut du jeu, d’après des sources publiques : à vérifier dans vos réglages (sans touche affichée : voir vos réglages). Sur un clavier AZERTY, les lettres X, H, J et T gardent leur place ; la prise en compte de la disposition par le jeu n’est pas vérifiée.",
    );
    const bad = new RegExp(
      "[" + [0xa0, 0x202f, 0x200b, 0xfeff].map((c) => String.fromCharCode(c)).join("") + "]",
    );
    expect(JSON.stringify(table) + shortcutsKeyNote()).not.toMatch(bad);
    expect(JSON.stringify(table) + shortcutsKeyNote()).not.toMatch(/u00a0|u202f|\\u/i);
  });

  it("Given the sentence on AZERTY, Then it makes no claim about how the game maps keys", () => {
    expect(shortcutsKeyNote()).not.toMatch(/QWERTY|positionn|emplacement du clavier/i);
    expect(shortcutsKeyNote()).toContain("n’est pas vérifiée");
  });
});

describe("Feature: nothing contextual unless the stream is alive and the game is in a match", () => {
  it("Given no poll, a stream that is not live or a stale view, Then nothing is shown", () => {
    for (const poll of [
      null,
      undefined,
      {},
      live({ state: "off" }),
      live({ state: "waiting" }),
      live({ state: "connected" }),
      live({ state: "game_without_telemetry" }),
      live({ state: "incompatible" }),
    ]) {
      const r = run(poll);
      expect(r.show).toBe(false);
      expect(r.items).toEqual([]);
    }
    expect(run(shipFlight(), { grey: true }).show).toBe(false);
  });

  it("Given Game.log says menu, disconnected or closed, Then nothing is shown whatever the frames repeat", () => {
    for (const state of ["menu", "disconnected", "closed"]) {
      const r = run(shipFlight({ gear: "deployed" }, { connection: { state } }));
      expect(r.show, state).toBe(false);
      expect(r.items, state).toEqual([]);
    }
  });

  it("Given Game.log says online or has read nothing yet, Then the reminders are shown", () => {
    for (const state of ["online", "unknown"]) {
      expect(run(shipFlight({}, { connection: { state } })).show, state).toBe(true);
    }
    expect(run(shipFlight()).show).toBe(true);
  });

  it("Given a context the poll does not allow to name, Then it says so (colon after a non-breaking space) and offers nothing", () => {
    for (const poll of [live(), live({ pilot: {} }), live({ pilot: { locomotion: "weird" } })]) {
      const r = run(poll);
      expect(r.show).toBe(true);
      expect(r.id).toBe("unknown");
      expect(r.label).toBe("Contexte inconnu");
      expect(r.items).toEqual([]);
      expect(r.empty).toBe("Contexte inconnu" + NB + ": aucun rappel pour l’instant.");
      expect(r.lightable).toBe(false);
    }
  });
});

describe("Feature: each situation shows what is useful in it", () => {
  it("Given the pilot on foot, Then only the suit light is offered, as a low priority 'si besoin', with its default key", () => {
    const r = run(live({ pilot: { locomotion: "on_foot" } }));
    expect(r.id).toBe("foot");
    expect(r.items).toEqual([
      { id: "suit", label: "Lampe de combinaison", keys: ["T"], note: "si besoin", tier: 3 },
    ]);
    expect(r.lightable).toBe(true);
  });

  it("Given an EVA, Then the suit light is offered the same way", () => {
    const r = run(live({ pilot: { locomotion: "eva" } }));
    expect(r.id).toBe("eva");
    expect(r.items.map((i: any) => [i.id, i.tier, i.note])).toEqual([["suit", 3, "si besoin"]]);
  });

  it("Given a ground vehicle, Then the lights come first, with no key and no claim about their state", () => {
    const r = run(
      live({ pilot: { locomotion: "seated" }, derived: { ground_vehicle: "ARGO_ATLS" } }),
    );
    expect(r.id).toBe("ground");
    expect(r.items.map((i: any) => i.id)).toEqual(["lights", "exit"]);
    expect(r.items[0]).toMatchObject({ keys: [], note: "état non lu", tier: 1 });
  });

  it("Given a ship on the ground, Then taking off comes first", () => {
    const r = run(shipFlight({ landed: true, gear: "deployed" }));
    expect(r.id).toBe("landed");
    expect(r.items[0]).toMatchObject({ id: "takeoff", keys: [] });
    expect(r.items.map((i: any) => i.id)).not.toContain("land_auto");
  });

  it("Given the gear out and the ship not on the ground, Then auto land is offered 'si la demande est accordée', without a key", () => {
    const r = run(shipFlight({ gear: "deployed" }));
    expect(r.id).toBe("gear");
    expect(r.items[0]).toEqual({
      id: "land_auto",
      label: "Atterrissage automatique",
      keys: [],
      note: "si la demande est accordée",
      tier: 1,
    });
    expect(r.items.map((i: any) => i.id)).toContain("land_req");
  });

  it("Given anything but a deployed gear and a ship surely in the air, Then auto land is never offered", () => {
    const cases: any[] = [
      shipFlight({ gear: "retracted" }),
      shipFlight({ gear: "deploying" }),
      shipFlight({ gear: "retracting" }),
      shipFlight({ gear: undefined }),
      shipFlight({ gear: "deployed", landed: true }),
      shipFlight({ gear: "deployed", landed: undefined }),
      shipFlight({ gear: "deployed" }, { derived: { in_quantum_mode: true } }),
      shipFlight({ gear: "deployed" }, { derived: { in_jump: true } }),
      shipFlight({ gear: "deployed" }, { conditions: [cond("powerplant_off")] }),
      shipFlight({ gear: "deployed" }, { connection: { state: "menu" } }),
      live({ pilot: { locomotion: "on_foot" } }),
    ];
    for (const poll of cases) expect(ids(poll), JSON.stringify(poll)).not.toContain("land_auto");
  });

  it("Given a ship in space, Then the quantum jump, cruise, decoupled mode and brake are offered, and only the brake has a key", () => {
    const r = run(shipFlight());
    expect(r.id).toBe("space");
    expect(r.items.map((i: any) => [i.id, i.keys.join("+")])).toEqual([
      ["qt", ""],
      ["cruise", ""],
      ["decoupled", ""],
      ["brake", "X"],
    ]);
  });

  it("Given a ship near a planet with the gear in, Then the landing request and the gear come first", () => {
    const r = run(shipFlight({}, { derived: { in_planet_frame: true } }));
    expect(r.id).toBe("planet");
    expect(r.items.slice(0, 2).map((i: any) => i.id)).toEqual(["land_req", "gear"]);
  });

  it("Given the powerplant off, Then Flight Ready comes first, without a key", () => {
    const r = run(shipFlight({}, { conditions: [cond("powerplant_off")] }));
    expect(r.id).toBe("off");
    expect(r.items).toEqual([
      {
        id: "ready",
        label: "Flight Ready (démarrer le vaisseau)",
        keys: [],
        note: "",
        tier: 1,
      },
    ]);
    expect(r.lightable).toBe(false);
  });

  it("Given the quantum mode, Then the jump comes first with NO key (B is the SCM/NAV toggle), and the shields reminder stays silent", () => {
    const r = run(
      shipFlight(
        {},
        {
          derived: { in_quantum_mode: true },
          conditions: [cond("shields_off", { quantum: true })],
        },
      ),
    );
    expect(r.id).toBe("quantum");
    expect(r.items).toEqual([{ id: "qt", label: "Saut quantique", keys: [], note: "", tier: 1 }]);
  });

  it("Given a jump in progress, Then there is nothing to press and it says so", () => {
    const r = run(
      shipFlight({}, { derived: { in_jump: true }, conditions: [cond("hostile_lock")] }),
    );
    expect(r.id).toBe("jump");
    expect(r.items).toEqual([]);
    expect(r.empty).toBe("Rien à presser pendant le saut.");
  });

  it("Given a hostile lock, Then the countermeasures come first (H, J, no 'hold'), and not the ones spent", () => {
    const r = run(shipFlight({}, { conditions: [cond("hostile_lock")] }));
    expect(r.items.slice(0, 2).map((i: any) => [i.id, i.keys.join("+"), i.tier])).toEqual([
      ["decoy", "H", 0],
      ["noise", "J", 0],
    ]);
    const spent = run(
      shipFlight(
        {},
        { conditions: [cond("hostile_lock"), cond("countermeasures_empty", { kind: "decoy" })] },
      ),
    );
    expect(spent.items.map((i: any) => i.id)).toContain("noise");
    expect(spent.items.map((i: any) => i.id)).not.toContain("decoy");
  });

  it("Given the shields cut (their power off) in flight, Then powering them is the first reminder, without a key", () => {
    const r = run(shipFlight({}, { conditions: [cond("shields_off")] }));
    expect(r.items[0]).toMatchObject({
      id: "shield_pw",
      keys: [],
      note: "boucliers coupés",
      tier: 0,
    });
  });

  it("Given the shields DOWN (spent), Then there is no advice to power them, in the air or on the ground", () => {
    for (const patch of [{}, { landed: true }]) {
      expect(
        ids(shipFlight(patch, { conditions: [cond("shields_down")] })),
        JSON.stringify(patch),
      ).not.toContain("shield_pw");
    }
  });

  it("Given the shields cut on the ground, Then there is no shields reminder either", () => {
    expect(ids(shipFlight({ landed: true }, { conditions: [cond("shields_off")] }))).not.toContain(
      "shield_pw",
    );
  });

  it("Given a seat with no ship frame yet, Then Flight Ready is hedged", () => {
    const r = run(live({ pilot: { locomotion: "seated" } }));
    expect(r.id).toBe("seated");
    expect(r.items[0]).toMatchObject({ id: "ready", note: "si c’est un vaisseau", keys: [] });
    expect(r.lightable).toBe(false);
  });

  it("Given a pilot down or dead, Then there is no reminder", () => {
    const r = run(shipFlight({}, { conditions: [cond("down_or_dead")] }));
    expect(r.id).toBe("down");
    expect(r.items).toEqual([]);
    expect(r.empty).toBe("À terre" + NB + ": aucun rappel.");
  });

  it("Given a ship with no known landing state, Then only the plain reminders are shown", () => {
    const r = run(shipFlight({ landed: undefined }));
    expect(r.id).toBe("ship");
    expect(r.items.map((i: any) => i.id)).toEqual(["exit", "lights"]);
  });
});

describe("Feature: the player can say it is dark, nothing else does", () => {
  it("Given the button pressed on foot, Then the suit light is first and no longer 'si besoin'", () => {
    const r = run(live({ pilot: { locomotion: "on_foot" } }), { dark: true });
    expect(r.items[0]).toMatchObject({ id: "suit", tier: 1, note: "", keys: ["T"] });
  });

  it("Given the button pressed in a ship, Then the lights come first, added if the context had none", () => {
    expect(run(shipFlight(), { dark: true }).items[0]).toMatchObject({ id: "lights", tier: 1 });
    expect(run(shipFlight({ landed: true }), { dark: true }).items[0]).toMatchObject({
      id: "lights",
      note: "",
    });
    expect(
      run(live({ pilot: { locomotion: "seated" }, derived: { ground_vehicle: "X" } }), {
        dark: true,
      }).items[0],
    ).toMatchObject({ id: "lights" });
  });

  it("Given a context where lights make no sense, Then the button changes nothing and is not offered", () => {
    for (const poll of [
      shipFlight({}, { conditions: [cond("powerplant_off")] }),
      shipFlight({}, { derived: { in_quantum_mode: true } }),
      shipFlight({}, { derived: { in_jump: true } }),
      live(),
    ]) {
      const a = run(poll);
      const b = run(poll, { dark: true });
      expect(b).toEqual(a);
      expect(a.lightable).toBe(false);
    }
  });

  it("Given any darkness-like signal in the poll, Then it is ignored (there is no darkness signal)", () => {
    const base = live({ pilot: { locomotion: "on_foot" } });
    const sunny = run(base);
    for (const pilot of [
      { locomotion: "on_foot", breathable_atmosphere: false },
      { locomotion: "on_foot", pressure: 0.01, outside_temperature_c: -200 },
      { locomotion: "on_foot", gravity_g: 0 },
    ]) {
      expect(run(live({ pilot }))).toEqual(sunny);
    }
    expect(sunny.items[0].tier).toBe(3);
  });
});

describe("Feature: what must never be claimed", () => {
  it("Given lights_on true, false or absent, Then the answer is identical and never says the lights are off", () => {
    for (const patch of [
      { landed: true },
      { landed: false },
      { landed: false, gear: "deployed" },
    ]) {
      const results = [true, false, undefined].map((lights_on) =>
        run(shipFlight({ ...patch, lights_on })),
      );
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
      for (const r of results) {
        for (const i of r.items) {
          expect(`${i.label} ${i.note}`).not.toMatch(
            /phares?.*(éteint|off)|(éteint|off).*phares?/i,
          );
        }
      }
    }
    // the vehicle case: a ground vehicle sends no lights at all
    const g = run(live({ pilot: { locomotion: "seated" }, derived: { ground_vehicle: "X" } }));
    expect(texts(g)).not.toMatch(/éteint/i);
  });

  it("Given the HUD preferences advanced_hud_enabled_scm and nav, Then they change nothing", () => {
    const plain = run(shipFlight());
    for (const hud of [
      { advanced_hud_enabled_scm: true },
      { advanced_hud_enabled_nav: true },
      { advanced_hud_enabled_scm: false, advanced_hud_enabled_nav: true },
    ]) {
      expect(run(shipFlight({}, { ship: { landed: false, gear: "retracted", ...hud } }))).toEqual(
        plain,
      );
    }
  });

  it("Given a poll with the balance, Then no figure reaches the reminders", () => {
    const poll = shipFlight(
      { gear: "deployed" },
      {
        balance: 123456789,
        pilot: { locomotion: "seated", balance: 123456789, uec_balance: 987654321 },
        ledger: { status: "ok", gain: 424242 },
      },
    );
    const r = run(poll);
    expect(r.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toMatch(/\d{4,}/);
    expect(r).toEqual(run(shipFlight({ gear: "deployed" })));
  });

  it("Given a poll rebuilt by cleanPoll (what the page really holds), Then the signals survive and the answer is the same", () => {
    const raw: any = {
      v: 1,
      state: "live",
      frame_age_ms: 100,
      ship: { name: "DRAK_Cutter_1", landed: false, gear: "deployed", lights_on: false },
      pilot: { locomotion: "seated" },
      derived: { in_planet_frame: true },
      conditions: [{ id: "hostile_lock", level: "critical" }],
      connection: { state: "online" },
    };
    const clean = cleanPoll(raw);
    const r = run(clean);
    expect(r.id).toBe("gear");
    expect(r.items.map((i: any) => i.id).slice(0, 3)).toEqual(["decoy", "noise", "land_auto"]);
  });

  it("Given any context, Then there are at most 8 reminders, ordered by priority, a key only with its sources, and the poll untouched", () => {
    const polls = [
      shipFlight({ gear: "deployed" }, { conditions: [cond("hostile_lock"), cond("shields_off")] }),
      shipFlight({}, { derived: { in_planet_frame: true }, conditions: [cond("hostile_lock")] }),
      live({ pilot: { locomotion: "on_foot" } }),
    ];
    const table = shortcutsTable();
    for (const poll of polls) {
      const before = JSON.stringify(poll);
      for (const dark of [false, true]) {
        const r = run(poll, { dark });
        expect(r.items.length).toBeLessThanOrEqual(8);
        const tiers = r.items.map((i: any) => i.tier);
        expect(tiers).toEqual([...tiers].sort());
        for (const i of r.items) {
          if (i.keys.length) {
            const e = table.find((x: any) => x.id === i.id);
            expect(new Set(e.src.split("")).size).toBeGreaterThanOrEqual(2);
          }
        }
      }
      expect(JSON.stringify(poll)).toBe(before);
    }
  });
});
