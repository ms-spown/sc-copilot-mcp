import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FleetStore } from "../providers/fleet/store.js";
import { GameLog } from "../providers/gamelog/reader.js";
import { Scmdb } from "../providers/scmdb/store.js";
import { MAX_INSTRUCTIONS_LENGTH, SERVER_INSTRUCTIONS } from "../instructions.js";
import { PROMPTS } from "../prompts.js";
import {
  InterruptionSchema,
  SessionSchema,
  ShipLossSchema,
  TripSchema,
} from "../providers/sessions/types.js";
import { CATALOG, PROFILE_NAMES } from "../tools/catalog.js";
import { allTools } from "../tools/registry.js";

/**
 * Feature: what the documentation states as a fact (counts, scripts, links, the privacy sentence) is checked against
 * the code and the repository, in English and in French, so that it cannot drift again unnoticed.
 *
 * `docsSafety` already checks that the translations carry the same identifiers and that relative links reach a file;
 * this file checks the statements it cannot see: numbers, tables, anchors, scripts and the sentence about what is
 * written to disk. No network: the tools are only built, never called.
 */

const unused = { defaults: {}, get: async () => ({ data: {} }) } as never;
const tools = allTools({
  uexClient: unused,
  scwClient: unused,
  sctClient: unused,
  scmdb: new Scmdb({ raw: unused, api: unused, repo: "o/r", cacheDir: () => "" }),
  gameLog: new GameLog({}),
  fleet: new FleetStore("unused.json"),
});

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (rel: string) => {
  const text = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\r\n").join("\n");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
};

/** Every Markdown file a reader can open: the root, docs/ and .github/ (not node_modules, dist or worktrees). */
function markdownFiles(): string[] {
  const out: string[] = [];
  for (const dir of ["", "docs", ".github"]) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const e of fs.readdirSync(full, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".md")) out.push(path.posix.join(dir, e.name));
    }
  }
  return out.sort();
}
const MD_FILES = markdownFiles();

/** The text without fenced code blocks (their `#` lines are not headings, their links are examples). */
const withoutFences = (text: string) => text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");

// ---------------------------------------------------------------------------------------------
// Numbers in words: the documents spell some counts ("Seven ready-made prompts", "Sept prompts")
// ---------------------------------------------------------------------------------------------

const WORDS_EN = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];
const WORDS_FR = [
  "zéro",
  "un",
  "deux",
  "trois",
  "quatre",
  "cinq",
  "six",
  "sept",
  "huit",
  "neuf",
  "dix",
];

const hiddenWhenTelemetryOff = tools.filter((t) => t.advertised?.() === false).map((t) => t.name);
const sessionTools = tools.filter((t) => t.name.startsWith("sc_session_")).map((t) => t.name);
const profileSize = (profile: (typeof PROFILE_NAMES)[number]) => {
  const names = new Set(
    tools.filter((t) => CATALOG[t.name]?.profiles.includes(profile)).map((t) => t.name),
  );
  names.add("sc_data_status");
  return names.size;
};

describe("Feature: the README states the real tool and prompt counts", () => {
  const readmes = [
    {
      lang: "en",
      file: "README.md",
      toolsHeading: /^## Tools \((\d+)\)$/m,
      listed: /Claude sees (\d+) of them by default/,
      sessions: /the (\w+) `sc_session_\*` tools/,
      prompts: /^(\w+) ready-made prompts chain/m,
      words: WORDS_EN,
    },
    {
      lang: "fr",
      file: "README.fr.md",
      toolsHeading: /^## Outils \((\d+)\)$/m,
      listed: /Claude en voit (\d+) par défaut/,
      sessions: /les (\w+)\s+outils `sc_session_\*`/,
      prompts: /^(\w+) prompts prêts à l'emploi les enchaînent/m,
      words: WORDS_FR,
    },
  ];

  for (const r of readmes) {
    const text = read(r.file);

    it(`Given ${r.file}, When the tool counts are read, Then they match the registry`, () => {
      expect(Number(r.toolsHeading.exec(text)?.[1])).toBe(tools.length);
      expect(Number(r.listed.exec(text)?.[1])).toBe(tools.length - hiddenWhenTelemetryOff.length);
    });

    it(`Given ${r.file}, When the session tools and the prompts are counted, Then the words match`, () => {
      const sessionsWord = r.sessions.exec(text)?.[1]?.toLowerCase();
      expect(sessionsWord, "the sentence about the sc_session_* tools").toBeDefined();
      expect(r.words.indexOf(sessionsWord as string)).toBe(sessionTools.length);
      const promptsWord = r.prompts.exec(text)?.[1]?.toLowerCase();
      expect(promptsWord, "the sentence about the prompts").toBeDefined();
      expect(r.words.indexOf(promptsWord as string)).toBe(PROMPTS.length);
    });

    it(`Given ${r.file}, When the prompt table is read, Then it lists exactly the prompts of the server`, () => {
      const start = text.indexOf("\n## Prompts\n");
      const section = text.slice(start, text.indexOf("\n## Configuration\n"));
      const listed = [...section.matchAll(/^\| `([a-z_]+)`\s*\|/gm)].map((m) => m[1]).sort();
      expect(listed).toEqual(PROMPTS.map((p) => p.name).sort());
    });

    it(`Given ${r.file}, When the profile table is read, Then each size matches the catalog`, () => {
      for (const profile of PROFILE_NAMES) {
        const row = new RegExp(`^\\| \\*\\*${profile}\\*\\*\\s*\\|\\s*(\\d+)\\s*\\|`, "m").exec(
          text,
        );
        expect(row, `a row for the profile ${profile}`).not.toBeNull();
        expect(Number(row?.[1]), profile).toBe(profileSize(profile));
      }
    });
  }
});

describe("Feature: the capabilities guide states the real prompt and hidden-tool counts", () => {
  const doc = read("docs/CAPABILITIES.md");

  it("Given the prompts section, Then 'all N tell Claude' matches the number of prompts", () => {
    const word = /all (\w+) tell Claude to quote/.exec(doc)?.[1];
    expect(word, "the sentence 'all N tell Claude to quote'").toBeDefined();
    expect(WORDS_EN.indexOf(word as string)).toBe(PROMPTS.length);
  });

  it("Given the profiles section, Then the telemetry tools that stay hidden are counted right", () => {
    const word = /The (\w+) telemetry and session tools stay hidden/.exec(doc)?.[1];
    expect(word, "the sentence about the hidden telemetry and session tools").toBeDefined();
    const words = [...WORDS_EN, "eleven", "twelve", "thirteen", "fourteen", "fifteen"];
    expect(words.indexOf(word as string)).toBe(hiddenWhenTelemetryOff.length);
  });
});

// ---------------------------------------------------------------------------------------------
// English and French say the same thing
// ---------------------------------------------------------------------------------------------

const PAIRS = [
  ["README.md", "README.fr.md"],
  ["docs/TELEMETRY.md", "docs/TELEMETRY.fr.md"],
  ["docs/USING_WITH_CLAUDE.md", "docs/USING_WITH_CLAUDE.fr.md"],
] as const;

/** The numbers of the prose, normalised: "3,200" and "3 200" are 3200, "0,25" and "0.25" are 0.25. */
function numbersOf(text: string): string[] {
  const prose = withoutFences(text)
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\]\([^)]*\)/g, "] ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\|[ :|-]+\|$/gm, " ");
  const found: string[] = [];
  for (const m of prose.matchAll(/(?<![\w.])\d+(?:[ ,]\d{3})*(?:[.,]\d+)?(?![\w])/g)) {
    let token = m[0];
    if (/^\d{1,3}(?:[ ,]\d{3})+$/.test(token)) token = token.replace(/[ ,]/g, "");
    else token = token.replace(",", ".");
    found.push(token);
  }
  return found.sort();
}

const headingsOf = (text: string) =>
  [...withoutFences(text).matchAll(/^(#{1,6}) /gm)].map((m) => m[1].length);

/** The files a Markdown file links to (relative targets, anchor dropped), the translation mapped to the original. */
function linkedFiles(text: string, own: string): string[] {
  const dir = path.posix.dirname(own);
  const out = new Set<string>();
  for (const m of withoutFences(text).matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^[a-z]+:/i.test(target)) continue;
    const file = target.split("#")[0];
    if (file === "") continue;
    const resolved = path.posix.normalize(path.posix.join(dir, file)).replace(/\.fr\.md$/, ".md");
    out.add(resolved);
  }
  return [...out].sort();
}

describe("Feature: the English and French pages state the same things", () => {
  for (const [en, fr] of PAIRS) {
    const textEn = read(en);
    const textFr = read(fr);

    it(`Given ${en} and ${fr}, Then the numbers stated in the prose are the same`, () => {
      const a = numbersOf(textEn);
      const b = numbersOf(textFr);
      const only = (x: string[], y: string[]) => {
        const rest = [...y];
        return x.filter((n) => {
          const i = rest.indexOf(n);
          if (i >= 0) rest.splice(i, 1);
          return i < 0;
        });
      };
      expect({ onlyEnglish: only(a, b), onlyFrench: only(b, a) }).toEqual({
        onlyEnglish: [],
        onlyFrench: [],
      });
    });

    it(`Given ${en} and ${fr}, Then they have the same outline`, () => {
      expect(headingsOf(textFr)).toEqual(headingsOf(textEn));
    });

    it(`Given ${en} and ${fr}, Then they link to the same documents`, () => {
      expect(linkedFiles(textFr, fr)).toEqual(linkedFiles(textEn, en));
    });
  }
});

// ---------------------------------------------------------------------------------------------
// What is written to disk: one sentence, the same everywhere
// ---------------------------------------------------------------------------------------------

/** The reviewed sentence about what stays in memory and what is saved. Change it here and in every page below. */
const PRIVACY_EN =
  "Frames and raw log lines stay in memory and are never written. The one exception is the session summary: the balance at the start and at the last sighting; the game version, the times (including how long the game was seen running) and the breaks; the last place and goods the log named; your note; the count of refused prices; for each ship destroyed with you aboard, its time, model, cause, kind of causer (never a name), place token and the cargo presumed lost (SCU, and the aUEC paid with the money figures), identified only by a short hash; and, for each trip, its label (contract title, places, goods), quantity, cost, revenue, margin, fees, net and the applied plan (planned profit, quantity, terminals). It is kept in a local file, `sessions.json`, only when telemetry is on; this server never sends it anywhere, except that the `sc_session_*` tools return parts of it to your MCP client, and so to your conversation (the money figures only with `include_balance`); `SC_SESSIONS=off` disables it; and deleting `sessions.json` and the `.bak` and `.corrupt` copies next to it erases it.";
const PRIVACY_FR =
  "Les trames et les lignes brutes du journal restent en mémoire et ne sont jamais écrites. La seule exception est le résumé de session : le solde au départ et à la dernière observation ; la version du jeu, les heures (dont la durée pendant laquelle le jeu a été vu en marche) et les coupures ; le dernier lieu et les dernières marchandises nommés par le journal ; votre note ; le nombre de prix refusés ; pour chaque vaisseau détruit avec vous à bord, l'heure, le modèle, la cause, le type de responsable (jamais un nom), le lieu et le cargo présumé perdu (SCU, et les aUEC payés avec les chiffres d'argent), identifié seulement par une courte empreinte ; et, pour chaque trajet, son libellé (titre du contrat, lieux, marchandises), la quantité, le coût, le revenu, la marge, les frais, le net et le plan appliqué (profit prévu, quantité, terminaux). Il est gardé dans un fichier local, `sessions.json`, seulement quand la télémétrie est activée ; ce serveur ne l'envoie jamais nulle part, sauf que les outils `sc_session_*` en renvoient des parties à votre client MCP, donc à votre conversation (les chiffres d'argent seulement avec `include_balance`) ; `SC_SESSIONS=off` le désactive ; et supprimer `sessions.json` ainsi que les copies `.bak` et `.corrupt` à côté de lui l'efface.";

/**
 * The same sentence as rule 5 of the block pasted into Claude: no backticks (the block is a code fence) and addressed to
 * Claude, so "your" becomes "the player's". Nothing else may differ.
 */
const blockVariant = (sentence: string) =>
  sentence
    .replace(/`/g, "")
    .replace("your note", "the player's note")
    .replace(
      "your MCP client, and so to your conversation",
      "the player's MCP client, and so to the conversation",
    )
    .replace("votre note", "la note du joueur")
    .replace("with you aboard", "with the player aboard")
    .replace("avec vous à bord", "avec le joueur à bord")
    .replace(
      "votre client MCP, donc à votre conversation",
      "le client MCP du joueur, donc à la conversation",
    );

/**
 * What the session file stores, by key of the zod objects in providers/sessions/types.ts. Each key is covered by a phrase
 * of the sentence (the phrase must be in it), or allowed with a reason: a key that is in neither makes the test fail, so
 * whoever adds a stored field has to review the sentence.
 */
const COVERED_BY: Record<string, { en: string; fr: string } | string> = {
  // Session
  id: "allowed: an identifier of the file's own, no game identifier",
  number: "allowed: the session's rank, 1, 2, 3...",
  started_at: { en: "the times", fr: "les heures" },
  ended_at: { en: "the times", fr: "les heures" },
  end_reason: "allowed: why the session ended (manual, new session, gap)",
  last_activity_at: { en: "the times", fr: "les heures" },
  quit_at: { en: "the times", fr: "les heures" },
  updated_at: { en: "the times", fr: "les heures" },
  start_balance: { en: "the balance at the start", fr: "le solde au départ" },
  start_balance_at: { en: "the balance at the start", fr: "le solde au départ" },
  start_balance_quality: "allowed: how far the start balance can be trusted (a label)",
  last_balance: { en: "at the last sighting", fr: "à la dernière observation" },
  last_balance_at: { en: "at the last sighting", fr: "à la dernière observation" },
  game_version: { en: "the game version", fr: "la version du jeu" },
  game_channel: { en: "the game version", fr: "la version du jeu" },
  active_ms: { en: "how long the game was seen running", fr: "le jeu a été vu en marche" },
  interruptions: { en: "the breaks", fr: "les coupures" },
  from: { en: "the breaks", fr: "les coupures" },
  to: { en: "the breaks", fr: "les coupures" },
  trips: { en: "for each trip", fr: "pour chaque trajet" },
  trips_dropped: "allowed: a count of trips cut to stay under the size bound",
  last_location: {
    en: "the last place and goods",
    fr: "le dernier lieu et les dernières marchandises",
  },
  last_commodity: {
    en: "the last place and goods",
    fr: "le dernier lieu et les dernières marchandises",
  },
  last_context_at: { en: "the times", fr: "les heures" },
  note: { en: "your note", fr: "votre note" },
  price_refusals: { en: "the count of refused prices", fr: "le nombre de prix refusés" },
  price_refusal_last_at: { en: "the count of refused prices", fr: "le nombre de prix refusés" },
  ship_losses: {
    en: "for each ship destroyed with you aboard",
    fr: "pour chaque vaisseau détruit avec vous à bord",
  },
  // Ship loss
  at: { en: "its time", fr: "l'heure" },
  ship_ref: {
    en: "identified only by a short hash",
    fr: "identifié seulement par une courte empreinte",
  },
  ship_class: { en: "model", fr: "le modèle" },
  cause: { en: "cause", fr: "la cause" },
  causer: { en: "kind of causer (never a name)", fr: "le type de responsable (jamais un nom)" },
  zone: { en: "place token", fr: "le lieu" },
  via: "allowed: which log line told the destruction (a label about the covered time and cause)",
  cargo_scu: { en: "the cargo presumed lost (SCU", fr: "le cargo présumé perdu (SCU" },
  cargo_buys:
    "allowed: the number of purchase lines behind the SCU presumed lost, a count about a covered figure",
  unconfirmed_buys:
    "allowed: the number of purchases left out because the journal could not confirm them, a count",
  cargo_paid_auec: {
    en: "the aUEC paid with the money figures",
    fr: "les aUEC payés avec les chiffres d'argent",
  },
  run_key: "allowed: a hash of the trade run the lost purchases belong to, never a game identifier",
  // Trip
  key: "allowed: a hash of what identifies the trip, never a game identifier",
  kind: "allowed: a type tag (hauling, trade, contract); `kind` of a break is covered by the breaks",
  source: "allowed: where the trip came from (log ledger, trade journal, manual)",
  label: {
    en: "its label (contract title, places, goods)",
    fr: "son libellé (titre du contrat, lieux, marchandises)",
  },
  commodity: {
    en: "its label (contract title, places, goods)",
    fr: "son libellé (titre du contrat, lieux, marchandises)",
  },
  buy_terminal: {
    en: "its label (contract title, places, goods)",
    fr: "son libellé (titre du contrat, lieux, marchandises)",
  },
  sell_terminal: {
    en: "its label (contract title, places, goods)",
    fr: "son libellé (titre du contrat, lieux, marchandises)",
  },
  scu: { en: "quantity", fr: "la quantité" },
  cost_auec: { en: "cost", fr: "le coût" },
  revenue_auec: { en: "revenue", fr: "le revenu" },
  fees_auec: { en: "fees", fr: "les frais" },
  gross_margin_auec: { en: "margin", fr: "la marge" },
  net_auec: { en: "net", fr: "le net" },
  net_kind: "allowed: how the net was obtained, a label about a covered figure",
  fees_method: "allowed: how the fees were obtained, a label about a covered figure",
  unexplained_auec:
    "allowed: the part of the balance change the figures do not explain, a derived figure of the net",
  net_doubtful: "allowed: a flag about the net",
  figures_from_before: "allowed: a flag about the net and the fees",
  planned_profit_auec: {
    en: "the applied plan (planned profit, quantity, terminals)",
    fr: "le plan appliqué (profit prévu, quantité, terminaux)",
  },
  planned_scu: {
    en: "the applied plan (planned profit, quantity, terminals)",
    fr: "le plan appliqué (profit prévu, quantité, terminaux)",
  },
  plan_buy_terminal: {
    en: "the applied plan (planned profit, quantity, terminals)",
    fr: "le plan appliqué (profit prévu, quantité, terminaux)",
  },
  plan_sell_terminal: {
    en: "the applied plan (planned profit, quantity, terminals)",
    fr: "le plan appliqué (profit prévu, quantité, terminaux)",
  },
  plan_link:
    "allowed: how the plan was tied to the run (by name or by prices), a label about the plan",
};

/** The sentence may be wrapped over several lines or quoted in a block: compare on single spaces. */
const flat = (text: string) => text.replace(/^[> ]+/gm, "").replace(/\s+/g, " ");

describe("Feature: every page says the same true thing about what is saved", () => {
  const english = [
    "README.md",
    "SECURITY.md",
    "docs/TELEMETRY.md",
    "docs/CAPABILITIES.md",
    "docs/ARCHITECTURE.md",
  ];
  const french = ["README.fr.md", "docs/TELEMETRY.fr.md"];

  for (const file of english) {
    it(`Given ${file}, Then it carries the reviewed sentence`, () => {
      expect(flat(read(file))).toContain(PRIVACY_EN);
    });
  }
  for (const file of french) {
    it(`Given ${file}, Then it carries the reviewed sentence`, () => {
      expect(flat(read(file))).toContain(PRIVACY_FR);
    });
  }

  it("Given the block to paste, Then rule 5 carries the same sentence and does not contradict rule 8", () => {
    for (const [file, sentence] of [
      ["docs/USING_WITH_CLAUDE.md", PRIVACY_EN],
      ["docs/USING_WITH_CLAUDE.fr.md", PRIVACY_FR],
    ] as const) {
      const block = flat(read(file));
      const rule5 = block.slice(block.indexOf(" 5. "), block.indexOf(" 6. "));
      expect(rule5, file).toContain(blockVariant(sentence));
      expect(rule5, file).toContain("scw_snapshot_save");
      expect(block, file).toContain("sc_session_new");
    }
  });

  it("Given the stored shapes of the session file, Then every key is covered by the sentence or allowed with a reason", () => {
    const keys = new Set([
      ...Object.keys(SessionSchema.shape),
      ...Object.keys(TripSchema.shape),
      ...Object.keys(InterruptionSchema.shape),
      ...Object.keys(ShipLossSchema.shape),
    ]);
    // A key nobody reviewed: add it to COVERED_BY with the phrase of the sentence that covers it, or an "allowed" reason,
    // and change the sentence (and its copies) if the new field is a new category of what is stored.
    expect([...keys].filter((k) => !(k in COVERED_BY))).toEqual([]);
    expect(Object.keys(COVERED_BY).filter((k) => !keys.has(k))).toEqual([]);
    for (const [key, cover] of Object.entries(COVERED_BY)) {
      if (typeof cover === "string") {
        expect(cover, key).toMatch(/^allowed: .{10,}/);
        continue;
      }
      expect(PRIVACY_EN, `${key} (en)`).toContain(cover.en);
      expect(PRIVACY_FR, `${key} (fr)`).toContain(cover.fr);
    }
  });

  it("Given the pages that describe `disable`, Then each says it leaves the saved sessions in place", () => {
    const says: [string, RegExp][] = [
      ["README.md", /does not delete your saved sessions/],
      ["README.fr.md", /ne supprime pas vos sessions enregistrées/],
      ["docs/TELEMETRY.md", /does not delete your saved sessions/],
      ["docs/TELEMETRY.fr.md", /ne supprime pas vos sessions enregistrées/],
      ["SECURITY.md", /leaves `sessions.json` in place/],
    ];
    for (const [file, re] of says) expect(flat(read(file)), file).toMatch(re);
  });

  it("Given the app-only tools, Then the architecture page names each one and the troubleshooting page the dashboard ones", () => {
    const appOnly = tools.filter((t) => t.requiresUi && t.name !== "sc_live_dashboard");
    expect(appOnly.length).toBeGreaterThanOrEqual(4);
    const architecture = read("docs/ARCHITECTURE.md");
    for (const t of appOnly) expect(architecture, t.name).toContain(`\`${t.name}\``);
    const troubleshooting = read("docs/TROUBLESHOOTING.md");
    for (const name of ["sc_live_dashboard", "sc_live_poll", "sc_live_mark", "sc_trade_suggest"]) {
      expect(troubleshooting, name).toContain(`\`${name}\``);
    }
  });

  it("Given the documents, Then none repeats a claim that stopped being true", () => {
    const stale = [
      /Everything stays in memory/i,
      /Tout reste en mémoire/,
      /stores nothing new about the player/i,
      /ne stocke rien de nouveau/i,
      /The only writes are the local fleet list and caches/,
      /Les seules écritures concernent la liste locale de flotte/,
      /does not exist yet/,
      /It is short on purpose/,
      /keeps everything in memory only/,
    ];
    for (const file of MD_FILES.filter((f) => !/CHANGELOG/.test(f))) {
      const text = flat(read(file));
      for (const re of stale) expect(text, `${file}: ${re}`).not.toMatch(re);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Statements about the release and the server manual
// ---------------------------------------------------------------------------------------------

describe("Feature: the pages that name a version or a size name the current one", () => {
  it("Given the roadmap, Then 'Where it stands' is for the version in package.json (major and minor)", () => {
    const version = (JSON.parse(read("package.json")).version as string)
      .split(".")
      .slice(0, 2)
      .join(".");
    const heading = /^## Where it stands \((\d+\.\d+)\.\d+\)$/m.exec(read("docs/ROADMAP.md"));
    expect(heading, "the heading 'Where it stands (x.y.z)'").not.toBeNull();
    expect(heading?.[1]).toBe(version);
  });

  it("Given the guide to Claude, Then the size it gives for the server manual is the limit in the code", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_LENGTH);
    expect(flat(read("docs/USING_WITH_CLAUDE.md"))).toContain(
      `about ${MAX_INSTRUCTIONS_LENGTH.toLocaleString("en-US")} characters, the limit being ${MAX_INSTRUCTIONS_LENGTH.toLocaleString("en-US")}`,
    );
    const fr = String(MAX_INSTRUCTIONS_LENGTH).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    expect(flat(read("docs/USING_WITH_CLAUDE.fr.md"))).toContain(
      `${fr} caractères, la limite étant de ${fr}`,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Commands and links
// ---------------------------------------------------------------------------------------------

describe("Feature: the commands and links in the documentation exist", () => {
  const scripts = new Set(
    Object.keys(JSON.parse(read("package.json")).scripts as Record<string, string>),
  );
  // The changelogs describe history: a script that was renamed since may still be named there.
  const current = MD_FILES.filter((f) => !/CHANGELOG/.test(f));

  it("Given every `npm run <script>` in a page, Then package.json has that script", () => {
    const problems: string[] = [];
    let seen = 0;
    for (const file of current) {
      for (const m of read(file).matchAll(/npm run ([a-z][a-z0-9_-]*(?::[a-z0-9_-]+)*)/g)) {
        seen += 1;
        if (!scripts.has(m[1])) problems.push(`${file}: npm run ${m[1]}`);
      }
    }
    expect(seen).toBeGreaterThan(30);
    expect(problems).toEqual([]);
  });

  /** GitHub's anchors: lower case, punctuation dropped (letters of any language, digits, "-" and "_" kept), spaces to "-". */
  function anchorsOf(text: string): Set<string> {
    const counts = new Map<string, number>();
    const out = new Set<string>();
    for (const m of withoutFences(text).matchAll(/^#{1,6} +(.+?) *#*$/gm)) {
      const plain = m[1]
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[`*_~]/g, (c) => (c === "_" ? "_" : ""))
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, "")
        .replace(/ /g, "-");
      const n = counts.get(plain) ?? 0;
      counts.set(plain, n + 1);
      out.add(n === 0 ? plain : `${plain}-${n}`);
    }
    return out;
  }
  const anchorCache = new Map<string, Set<string>>();
  const anchorsFor = (file: string) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(read(file)));
    return anchorCache.get(file) as Set<string>;
  };

  it("Given every relative link, Then the file exists and the #anchor is a heading of that page", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of MD_FILES) {
      const dir = path.posix.dirname(file);
      const prose = withoutFences(read(file)).replace(/`[^`\n]*`/g, " ");
      for (const m of prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
        const [rawFile, rawAnchor] = target.split("#");
        const resolved =
          rawFile === "" ? file : path.posix.normalize(path.posix.join(dir, rawFile));
        checked += 1;
        const onDisk = path.join(ROOT, resolved);
        if (!fs.existsSync(onDisk)) {
          problems.push(`${file}: ${target} (no such file)`);
          continue;
        }
        if (rawAnchor === undefined || rawAnchor === "") continue;
        if (!resolved.endsWith(".md")) continue;
        let anchor = rawAnchor;
        try {
          anchor = decodeURIComponent(rawAnchor);
        } catch {
          // keep the raw anchor
        }
        if (!anchorsFor(resolved).has(anchor.toLowerCase())) {
          problems.push(`${file}: ${target} (no such heading in ${resolved})`);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(problems).toEqual([]);
  });
});
