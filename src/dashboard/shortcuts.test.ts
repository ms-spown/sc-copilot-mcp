/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { shortcutsFor, shortcutsKeyNote, shortcutsTable } from "./shortcutsPanel.js";
import * as V from "./viewLogic.js";
import { cleanPoll } from "./viewLogic.js";

/**
 * Feature: the "Raccourcis" reminders. The pure part: the table of keys, and what each situation of the game shows.
 * Every poll below is made up. The rule behind every case: a signal that is not verified shows nothing, and a key that
 * the public sources do not agree on is never printed.
 */

const LIB = { ...V };
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

describe("Feature: the table of default keys is explicit data", () => {
  const table = shortcutsTable();

  it("Given the table, Then it is versioned, dated and names its sources", () => {
    expect(table.version).toBe(1);
    expect(table.checked).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect(table.game).toBe("4.10");
    expect(Object.keys(table.sources).length).toBeGreaterThan(0);
    for (const s of Object.values(table.sources)) expect(String(s).length).toBeGreaterThan(10);
  });

  it("Given every entry, Then it has a source for its key or no key, and none claims to be verified in game yet", () => {
    const seen = new Set<string>();
    for (const e of table.items) {
      expect(seen.has(e.id), e.id).toBe(false);
      seen.add(e.id);
      expect(e.label.length, e.id).toBeGreaterThan(3);
      expect(typeof e.verified, e.id).toBe("boolean");
      if (e.keys.length > 0) {
        expect(e.src.length, `${e.id} has a key without a source`).toBeGreaterThan(0);
        for (const letter of e.src) expect(table.sources[letter], e.id).toBeTruthy();
      } else {
        expect(e.src, e.id).toBe("");
        expect(e.hold, e.id).toBe(false);
      }
      // Nobody has seen these keys work on 4.10: the flag flips only after the maintainer checks it in the game.
      expect(e.verified, e.id).toBe(false);
    }
  });

  it("Given the actions whose sources disagree or are missing, Then they carry no key", () => {
    const keyed = Object.fromEntries(table.items.map((e: any) => [e.id, e.keys.join("+")]));
    for (const id of ["gear", "land_req", "land_auto", "takeoff", "shield_pw", "exit", "lights"]) {
      expect(keyed[id], id).toBe("");
    }
    // The keys the maintainer asked for, and no other.
    expect(
      Object.entries(keyed)
        .filter(([, k]) => k)
        .sort(),
    ).toEqual([
      ["brake", "X"],
      ["cruise", "C"],
      ["decoupled", "Alt+C"],
      ["decoy", "H"],
      ["noise", "J"],
      ["qt", "B"],
      ["qt_go", "B"],
      ["ready", "R"],
      ["suit", "T"],
    ]);
    expect(table.items.filter((e: any) => e.hold).map((e: any) => e.id)).toEqual([
      "qt_go",
      "decoy",
    ]);
  });

  it("Given the wording, Then the exact phrases are the ones written (no stray escape, no non-breaking space)", () => {
    const labels = Object.fromEntries(table.items.map((e: any) => [e.id, e.label]));
    expect(labels.land_auto).toBe("Atterrissage automatique");
    expect(labels.suit).toBe("Lampe de combinaison");
    expect(labels.lights).toBe("Phares");
    expect(labels.land_req).toBe("Demander l’atterrissage");
    expect(shortcutsKeyNote()).toBe(
      "Touche par défaut du jeu, d’après des sources publiques : à vérifier dans vos réglages (sans touche affichée : voir vos réglages). En AZERTY, les touches par défaut suivent l’emplacement QWERTY ; R, B, C, X, H, J et T sont les mêmes.",
    );
    const all = JSON.stringify(table) + shortcutsKeyNote();
    expect(all).not.toMatch(
      new RegExp(
        "[" + [0xa0, 0x202f, 0x200b, 0xfeff].map((c) => String.fromCharCode(c)).join("") + "]",
      ),
    );
    expect(all).not.toMatch(/u00a0|u202f|\\u/i);
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

  it("Given a context the poll does not allow to name, Then it says so and offers nothing", () => {
    for (const poll of [live(), live({ pilot: {} }), live({ pilot: { locomotion: "weird" } })]) {
      const r = run(poll);
      expect(r.show).toBe(true);
      expect(r.id).toBe("unknown");
      expect(r.label).toBe("Contexte inconnu");
      expect(r.items).toEqual([]);
      expect(r.empty).toBe("Contexte inconnu : aucun rappel pour l’instant.");
      expect(r.lightable).toBe(false);
    }
  });
});

describe("Feature: each situation shows what is useful in it", () => {
  it("Given the pilot on foot, Then only the suit light is offered, as a low priority 'si besoin', with its default key", () => {
    const r = run(live({ pilot: { locomotion: "on_foot" } }));
    expect(r.id).toBe("foot");
    expect(r.items).toEqual([
      {
        id: "suit",
        label: "Lampe de combinaison",
        keys: ["T"],
        hold: false,
        note: "si besoin",
        tier: 3,
      },
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
      hold: false,
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

  it("Given a ship in space, Then the quantum mode, cruise, decoupled mode and brake are offered with their default keys", () => {
    const r = run(shipFlight());
    expect(r.id).toBe("space");
    expect(r.items.map((i: any) => [i.id, i.keys.join("+")])).toEqual([
      ["qt", "B"],
      ["cruise", "C"],
      ["decoupled", "Alt+C"],
      ["brake", "X"],
    ]);
  });

  it("Given a ship near a planet with the gear in, Then the landing request and the gear come first", () => {
    const r = run(shipFlight({}, { derived: { in_planet_frame: true } }));
    expect(r.id).toBe("planet");
    expect(r.items.slice(0, 2).map((i: any) => i.id)).toEqual(["land_req", "gear"]);
  });

  it("Given the powerplant off, Then Flight Ready comes first", () => {
    const r = run(shipFlight({}, { conditions: [cond("powerplant_off")] }));
    expect(r.id).toBe("off");
    expect(r.items).toEqual([
      {
        id: "ready",
        label: "Flight Ready (démarrer le vaisseau)",
        keys: ["R"],
        hold: false,
        note: "",
        tier: 1,
      },
    ]);
    expect(r.lightable).toBe(false);
  });

  it("Given the quantum mode, Then engaging the jump (hold B) comes first, and the shields reminder stays silent", () => {
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
    expect(r.items[0]).toMatchObject({ id: "qt_go", keys: ["B"], hold: true });
    expect(ids(shipFlight({}, { derived: { in_quantum_mode: true } }))).not.toContain("shield_pw");
  });

  it("Given a jump in progress, Then there is nothing to press and it says so", () => {
    const r = run(
      shipFlight({}, { derived: { in_jump: true }, conditions: [cond("hostile_lock")] }),
    );
    expect(r.id).toBe("jump");
    expect(r.items).toEqual([]);
    expect(r.empty).toBe("Rien à presser pendant le saut.");
  });

  it("Given a hostile lock, Then the countermeasures come first, hold H for decoys, and not the ones spent", () => {
    const r = run(shipFlight({}, { conditions: [cond("hostile_lock")] }));
    expect(r.items.slice(0, 2).map((i: any) => [i.id, i.keys.join("+"), i.hold, i.tier])).toEqual([
      ["decoy", "H", true, 0],
      ["noise", "J", false, 0],
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

  it("Given the shields down, Then powering them is the first reminder, without a key", () => {
    const r = run(shipFlight({}, { conditions: [cond("shields_down")] }));
    expect(r.items[0]).toMatchObject({
      id: "shield_pw",
      keys: [],
      note: "boucliers tombés",
      tier: 0,
    });
  });

  it("Given a seat with no ship frame yet, Then Flight Ready is hedged", () => {
    const r = run(live({ pilot: { locomotion: "seated" } }));
    expect(r.id).toBe("seated");
    expect(r.items[0]).toMatchObject({ id: "ready", note: "si c’est un vaisseau" });
    expect(r.lightable).toBe(false);
  });

  it("Given a pilot down or dead, Then there is no reminder", () => {
    const r = run(shipFlight({}, { conditions: [cond("down_or_dead")] }));
    expect(r.id).toBe("down");
    expect(r.items).toEqual([]);
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
    ).toMatchObject({
      id: "lights",
    });
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
        for (const i of r.items)
          expect(`${i.label} ${i.note}`).not.toMatch(
            /phares?.*(éteint|off)|(éteint|off).*phares?/i,
          );
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

  it("Given any context, Then there are at most 8 reminders, ordered by priority, and the poll is left untouched", () => {
    const polls = [
      shipFlight(
        { gear: "deployed" },
        { conditions: [cond("hostile_lock"), cond("shields_down")] },
      ),
      shipFlight({}, { derived: { in_planet_frame: true }, conditions: [cond("hostile_lock")] }),
      live({ pilot: { locomotion: "on_foot" } }),
    ];
    for (const poll of polls) {
      const before = JSON.stringify(poll);
      for (const dark of [false, true]) {
        const r = run(poll, { dark });
        expect(r.items.length).toBeLessThanOrEqual(8);
        const tiers = r.items.map((i: any) => i.tier);
        expect(tiers).toEqual([...tiers].sort());
        for (const i of r.items) {
          // a key is only ever printed with a source behind it
          if (i.keys.length) {
            const e = shortcutsTable().items.find((x: any) => x.id === i.id);
            expect(e.src).not.toBe("");
          }
        }
      }
      expect(JSON.stringify(poll)).toBe(before);
    }
  });
});
