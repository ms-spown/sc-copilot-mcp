import { describe, expect, it } from "vitest";
import {
  buildDebrief,
  CSV_COLUMNS_BASE,
  CSV_COLUMNS_MONEY,
  csvNumber,
  csvText,
  DEBRIEF_FOR_EXPORT,
  DEBRIEF_FOR_MODEL,
  DEBRIEF_LIMITS,
  debriefText,
  fmtInt,
  markdownText,
} from "./debrief.js";
import { group, leaks, MONEY, report, richSession, trip } from "./debrief.fixtures.testing.js";
import { session, stamp } from "./fixtures.testing.js";
import type { Session, Trip } from "./types.js";

/**
 * Feature: the session debrief. Synthetic sessions only. The report is pure (no clock, no locale): same input, same bytes.
 * Amounts exist only when the balance was allowed; the start and last balance only on a separate explicit flag.
 */

const NB = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

/** A small RFC 4180 reader (quotes, doubled quotes, commas and CRLF inside quotes), to prove the CSV round-trips. */
function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

describe("Feature: what the report holds", () => {
  const cal = report([
    group(),
    group({ kind: "commodity", buy_terminal: null, sell_terminal: null }),
  ]);

  it("Given a session with a balance allowed, Then it has the header, key numbers, a tagged table, what is unexplained and a footer", () => {
    const d = buildDebrief([richSession()], { includeMoney: true, calibration: cal });
    const md = NB(d.markdown);
    expect(md).toContain("# Bilan de la session 3");
    expect(md).toContain("2026-11-04 18:00 UTC");
    expect(md).toContain("durée totale 3 h 20 min");
    expect(md).toContain("Temps de jeu");
    expect(md).toContain("4.10.197.2878 (build 12881860) · canal live");
    expect(md).toContain("jeu fermé normalement");
    expect(md).toContain("sans marqueur de fin");
    expect(md).toContain("Trajets : 4");
    expect(md).toContain("Marge brute des cargaisons");
    expect(md).toContain("Frais :");
    expect(md).toContain("Meilleur trajet : Cargo Laranite");
    expect(md).toContain("Efficacité face au plan : 74 %");
    expect(md).toContain("## Fiabilité des routes");
    expect(md).toContain("n = 5, confiance moyenne");
    expect(md).toContain("Marchandise non vérifiée (lien par prix)");
    expect(md).toContain("(mesuré)");
    expect(md).toContain("(calculé)");
    expect(md).toContain("(estimé)");
    expect(md).toContain("inconnu");
    expect(md).toContain("## Ce qui n’est pas expliqué");
    expect(md).toContain("## Lecture");
    expect(md).toContain("collaboratifs");
    expect(d.sessions).toEqual([3]);
    expect(d.trips_total).toBe(4);
    expect(d.truncated).toBe(false);
  });

  it("Given a figure that is unknown, Then it says inconnu and never 0", () => {
    const s = session(1, {
      active_ms: 3_600_000,
      trips: [trip({ commodity: "Gold", label: "Cargo Gold", gross_margin_auec: 5_000 })],
    });
    const d = buildDebrief([s], { includeMoney: true });
    const row = d.markdown.split("\n").find((l) => l.startsWith("| ") && l.includes("Cargo Gold"))!;
    const cells = row.split(" | ");
    expect(NB(row)).toContain("5 000 (calculé)");
    // cost, revenue, fees and net were not measured: unknown, not zero
    expect(cells.filter((c) => c.includes("inconnu")).length).toBeGreaterThanOrEqual(5);
    expect(row).not.toMatch(/\b0\b/);
    const csv = parseCsv(d.csv);
    const header = csv[0]!;
    const r = csv[1]!;
    for (const col of ["cost_auec", "revenue_auec", "fees_auec", "net_auec"])
      expect(r[header.indexOf(col)]).toBe("");
    expect(r[header.indexOf("net_method")]).toBe("unknown");
  });

  it("Given a session with too little active time, Then the rate is unknown, not zero", () => {
    const s = session(1, {
      active_ms: 120_000,
      trips: [trip({ net_auec: 10_000, net_kind: "balance_delta", label: "x" })],
    });
    const md = NB(buildDebrief([s], { includeMoney: true }).markdown);
    expect(md).toContain("Par heure de jeu : inconnu");
    expect(md).not.toContain("par heure ·");
  });

  it("Given a contract that overlaps a cargo run, Then its net is not counted and says why", () => {
    const s = session(1, {
      active_ms: 3_600_000,
      trips: [
        trip({
          key: "000000a1",
          started_at: stamp(-1200),
          ended_at: stamp(0),
          label: "Cargo",
          commodity: "Gold",
          gross_margin_auec: 1000,
          net_auec: 900,
          net_kind: "transactions",
          fees_auec: 100,
          fees_method: "estime",
        }),
        trip({
          key: "000000a2",
          kind: "hauling",
          source: "contract_ledger",
          started_at: stamp(-600),
          ended_at: stamp(-300),
          label: "Contrat",
          net_auec: 5555,
          net_kind: "balance_delta",
        }),
      ],
    });
    const d = buildDebrief([s], { includeMoney: true });
    expect(d.markdown).toContain("non compté (chevauche une cargaison)");
    const csv = parseCsv(d.csv);
    const h = csv[0]!;
    const hauling = csv.find((r) => r[h.indexOf("kind")] === "hauling")!;
    expect(hauling[h.indexOf("net_auec")]).toBe("");
    expect(hauling[h.indexOf("net_method")]).toBe("excluded_overlap");
    expect(hauling[h.indexOf("counted")]).toBe("no");
    // and the amount of the excluded contract is nowhere
    expect(leaks(d.markdown + d.csv, [])).toEqual([]);
    expect(d.markdown + d.csv).not.toMatch(/5\D?555/);
  });

  it("Given several sessions, Then there is a total, a session column and the sessions in order", () => {
    const a = richSession(2, { id: "s_rich_2" });
    const b = richSession(4, { id: "s_rich_4" });
    const d = buildDebrief([b, a], { includeMoney: true });
    expect(d.sessions).toEqual([2, 4]);
    expect(d.markdown).toContain("# Bilan : 2 sessions");
    expect(d.markdown).toContain("## Total");
    expect(d.markdown).toContain("| Session |");
    expect(parseCsv(d.csv)[0]![0]).toBe("session");
    expect(d.trips_total).toBe(8);
  });

  it("Given no session, Then it says so", () => {
    const d = buildDebrief([], { includeMoney: false });
    expect(d.markdown).toContain("Aucune session à résumer.");
    expect(parseCsv(d.csv)).toHaveLength(1);
  });

  it("Given the route reliability, Then it speaks only of the goods in the export, with n and the confidence", () => {
    const other = group({ commodity: "Quantainium", buy_terminal: "A", sell_terminal: "B" });
    const one = group({
      kind: "commodity",
      commodity: "Gold",
      buy_terminal: null,
      sell_terminal: null,
      n: 1,
      confidence: "none",
      gross_ratio: null,
      fee_rate: null,
      goods_unverified: false,
    });
    const md = NB(
      buildDebrief([richSession()], {
        includeMoney: true,
        calibration: report([group(), other, one]),
      }).markdown,
    );
    expect(md).toContain("Laranite, Port Tressler → Area18 TDD");
    expect(md).not.toContain("Quantainium");
    expect(md).toContain("Gold : n = 1, trop peu de trajets pour un chiffre (confiance aucune)");
    expect(md).toContain("réalisé ≈ 82 % du prévu (marge brute), n = 5");
    expect(md).toContain("Frais ≈ 3 % du chiffre d’affaires (n = 5)");
    expect(md).not.toMatch(/tendance|hausse|baisse/i);
  });

  it("Given a capped confidence and a huge ratio, Then the line says so and shows no ratio", () => {
    const md = NB(
      buildDebrief([richSession()], {
        includeMoney: true,
        calibration: report([group({ confidence_capped: true, gross_ratio: 9 })]),
      }).markdown,
    );
    expect(md).toContain("écart très élevé");
    expect(md).toContain("Confiance plafonnée à « moyenne »");
    expect(md).not.toContain("900 %");
  });

  it("Given a run that went down, Then the number keeps its sign", () => {
    expect(fmtInt(-12_345)).toBe("-12\u00a0345");
    expect(fmtInt(0)).toBe("0");
    expect(fmtInt(1_234_567.6)).toBe("1\u00a0234\u00a0568");
  });
});

describe("Feature: privacy, the matrix of the balance and the start balance", () => {
  const cal = report([group()]);
  const s = richSession();
  const every = Object.keys(MONEY) as (keyof typeof MONEY)[];
  const balances: (keyof typeof MONEY)[] = ["startBalance", "lastBalance"];

  it("Given the balance is hidden, Then no amount is in either output, whatever the start-balance flag", () => {
    for (const flag of [false, true]) {
      const d = buildDebrief([s], { includeMoney: false, includeBalances: flag, calibration: cal });
      const text = d.markdown + "\n" + d.csv;
      expect(leaks(text, every), `flag ${flag}`).toEqual([]);
      expect(d.money_included).toBe(false);
      expect(d.balances_included).toBe(false);
      expect(d.markdown).toContain("Montants");
      expect(d.markdown).toContain("masqués");
      // nothing that follows the money either: ranking, methods, plan, reliability, markers
      expect(d.markdown).not.toContain("Meilleur trajet");
      expect(d.markdown).not.toContain("Efficacité");
      expect(d.markdown).not.toMatch(
        /Marchandise non vérifiée|lien par prix|confiance (faible|moyenne|élevée)/,
      );
      expect(d.markdown).not.toMatch(/\((mesuré|calculé|estimé)\)|non compté/);
      expect(d.markdown).toContain("Fiabilité des routes");
      expect(d.markdown).toContain("Masquée");
      const header = d.csv.split("\r\n")[0]!;
      expect(header).toBe(CSV_COLUMNS_BASE.join(","));
      for (const c of CSV_COLUMNS_MONEY) expect(header).not.toContain(c);
    }
  });

  it("Given the balance is shown without the start-balance flag, Then amounts are there and the balances are not", () => {
    const d = buildDebrief([s], { includeMoney: true, calibration: cal });
    const text = d.markdown + "\n" + d.csv;
    expect(leaks(text, balances)).toEqual([]);
    expect(
      leaks(text, [
        "cost",
        "revenue",
        "gross",
        "fees",
        "net",
        "planned",
        "unexplained",
        "contractNet",
      ]).sort(),
    ).toEqual(
      ["contractNet", "cost", "fees", "gross", "net", "planned", "revenue", "unexplained"].sort(),
    );
    expect(d.money_included).toBe(true);
    expect(d.balances_included).toBe(false);
    expect(d.markdown).not.toContain("au départ");
    expect(d.markdown).toContain("pas les soldes de départ");
  });

  it("Given the balance is shown with the start-balance flag, Then the start and last balance are there", () => {
    const d = buildDebrief([s], { includeMoney: true, includeBalances: true, calibration: cal });
    expect(leaks(d.markdown, balances).sort()).toEqual(["lastBalance", "startBalance"]);
    expect(leaks(d.csv, balances)).toEqual([]); // the CSV is the trips: never a balance
    expect(d.balances_included).toBe(true);
    expect(NB(d.markdown)).toContain("au départ (relevé dès le démarrage du jeu)");
  });

  it("Given the balance is hidden, Then the money fields of the trips are never even read", () => {
    const poisoned = richSession();
    for (const t of poisoned.trips) {
      for (const k of [
        "cost_auec",
        "revenue_auec",
        "fees_auec",
        "gross_margin_auec",
        "net_auec",
        "planned_profit_auec",
        "unexplained_auec",
      ] as const)
        Object.defineProperty(t, k, {
          get() {
            throw new Error(`money field ${k} was read without the balance`);
          },
          enumerable: true,
        });
    }
    // every field is poisoned: the hidden report copies the others by name and goes on without touching these
    const d = buildDebrief([poisoned], { includeMoney: false });
    expect(d.trips_total).toBe(4);
    expect(() => buildDebrief([poisoned], { includeMoney: true })).toThrow(/was read/);
  });

  it("Given a session with only a balance change, Then the change is money and follows the flag", () => {
    const lone = session(5, {
      start_balance: 8_811_223,
      last_balance: 8_911_223,
      active_ms: 3_600_000,
    });
    const hidden = buildDebrief([lone], { includeMoney: false });
    expect(hidden.markdown + hidden.csv).not.toMatch(/8\D?811\D?223|8\D?911\D?223|100\D?000/);
    const shown = buildDebrief([lone], { includeMoney: true });
    expect(NB(shown.markdown)).toContain("Variation du solde : 100 000 aUEC");
    expect(shown.markdown + shown.csv).not.toMatch(/8\D?811\D?223|8\D?911\D?223/);
  });
});

describe("Feature: nothing identifying is exported", () => {
  it("Given free text, Then it is cleaned, capped and escaped, and the footer says its content is not checked", () => {
    const s = richSession(1, {
      note: "x".repeat(2000),
      game_version: "4.10 ".repeat(40),
    });
    s.trips[0]!.label = "C:\\Users\\Someone\\AppData\\Game.log\u202e " + "A".repeat(500);
    const d = buildDebrief([s], { includeMoney: true });
    // the schema caps the note (500) and the label (80); the formatter caps again on its own
    expect(d.markdown.length).toBeLessThan(30_000);
    expect(d.markdown.split("\n").every((l) => l.length < 3000)).toBe(true);
    expect(d.markdown).not.toContain("A".repeat(81));
    expect(d.markdown).not.toContain("x".repeat(501));
    expect(d.markdown).not.toContain("\u202e");
    // escaped, not removed: the server does not police the content, and the footer says so
    expect(d.markdown).toContain("C:\\\\Users\\\\Someone");
    expect(d.markdown).toContain("Le serveur n’enregistre aucun pseudo, identifiant de compte");
    expect(d.markdown).toContain("leur contenu n’est pas contrôlé : relis-les avant de partager");
  });
});

describe("Feature: hostile text, the Markdown", () => {
  const hostile = [
    "a | b",
    "line1\nline2\r\nline3",
    "`code` and ``double``",
    "<script>alert(1)</script>",
    "<img src=x onerror=1>",
    "&amp; &lt;",
    "\u202Eevil\u202C",
    "\u200Bzero\u200Dwidth",
    "=SUM(A1:A9)",
    "+1+1",
    "-2+3",
    "@cmd",
    "[click](javascript:alert(1))",
    "![i](http://x/y.png)",
    "http://evil.example/path",
    "www.evil.example",
    "mail@evil.example",
    "# Heading",
    "**bold** __bold__ ~~strike~~",
    "> quote",
    "\\ back\\slash",
    "x".repeat(10_000),
    "\uD800 lone",
    "\u0000nul\u0007bell",
    "\u{1d518}\u{1d52b}\u{1d526}\u{1d520}\u{1d52c}\u{1d521}\u{1d522} 😀 ok",
  ];

  const sessionWith = (texts: string[]): Session =>
    session(1, {
      active_ms: 3_600_000,
      note: texts[0]!,
      game_version: texts[1] ?? null,
      trips: texts.map((t, i) =>
        trip({
          key: (i + 1).toString(16).padStart(8, "0"),
          ended_at: stamp(i),
          label: t,
          commodity: t,
          buy_terminal: t,
          sell_terminal: t,
          net_auec: 1,
          net_kind: "balance_delta",
        }),
      ),
    });

  /** Splits a table row on its unescaped pipes. */
  const cellsOf = (row: string) => row.replace(/\\./g, "..").split("|").slice(1, -1);

  for (const money of [false, true]) {
    it(`Given hostile labels (${money ? "amounts" : "no amounts"}), Then every table row keeps its columns, no HTML or control character gets through`, () => {
      const d = buildDebrief([sessionWith(hostile)], { includeMoney: money });
      const lines = d.markdown.split("\n");
      const head = lines.findIndex((l) => l.startsWith("| Fin (UTC)"));
      expect(head).toBeGreaterThan(0);
      const cols = cellsOf(lines[head]!).length;
      const rows = lines.slice(head + 2).filter((l) => l.startsWith("| "));
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(cellsOf(r).length, r.slice(0, 80)).toBe(cols);
        // markup that survives is escaped: strip the escapes and the entities, nothing special is left
        const bare = r.replace(/\\./g, "").replace(/&(amp|lt|gt);/g, "");
        const inner = bare.slice(1, -1).replace(/\|/g, "");
        expect(inner, r.slice(0, 80)).not.toMatch(/[<>`*_[\]~#]/);
        expect(r).not.toMatch(/[\p{Cc}\p{Cf}]/u);
        expect(r.length).toBeLessThan(2500);
      }
      // no raw html anywhere in the report, no link syntax a renderer would follow
      expect(d.markdown).not.toMatch(/<[a-zA-Z/!]/);
      expect(d.markdown).not.toMatch(/(^|[^\\])\]\(/);
      expect(d.markdown).not.toMatch(/https?:\/\/(?!\s)/);
      expect(d.markdown).not.toMatch(/(^|[^.\\a-z])www\.evil/i);
      expect(d.markdown).not.toMatch(/[^\\]@evil/);
      // the note is one escaped line
      const note = lines.find((l) => l.startsWith("- Note du joueur"))!;
      expect(note).toBeTruthy();
      expect(note.length).toBeLessThan(1200);
    });
  }

  it("Given a seeded random mix of hostile fragments, Then the invariants hold for 200 reports", () => {
    let seed = 20261104;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pieces = [
      ...hostile.filter((h) => h.length < 200),
      " ",
      "|",
      "\n",
      "\r",
      "\t",
      '"',
      ",",
      "é",
      "→",
      "\u2028",
      "\u0085",
    ];
    for (let n = 0; n < 200; n++) {
      const texts = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () =>
        Array.from(
          { length: Math.floor(rnd() * 6) },
          () => pieces[Math.floor(rnd() * pieces.length)]!,
        ).join(""),
      );
      const s = sessionWith(["note " + texts[0]!, ...texts]);
      const d = buildDebrief([s], { includeMoney: n % 2 === 0 });
      const lines = d.markdown.split("\n");
      const head = lines.findIndex((l) => l.startsWith("| Fin (UTC)"));
      const cols = cellsOf(lines[head]!).length;
      for (const r of lines.slice(head + 2).filter((l) => l.startsWith("| ")))
        expect(cellsOf(r).length).toBe(cols);
      expect(d.markdown).not.toMatch(/<[a-zA-Z/!]/);
      const csv = parseCsv(d.csv);
      expect(csv.every((r) => r.length === csv[0]!.length)).toBe(true);
    }
  });

  it("Given the helpers, Then they behave on their own", () => {
    expect(markdownText("a|b", 80)).toBe("a\\|b");
    expect(markdownText("<b>&", 80)).toBe("&lt;b&gt;&");
    expect(markdownText("R&R &amp; &#65;", 80)).toBe("R&R &amp;amp; &amp;\\#65;");
    expect(markdownText(42 as unknown, 80)).toBe("");
    expect(debriefText("a\u202Eb\nc", 80)).toBe("ab c");
    expect(debriefText("😀😀😀", 2)).toBe("😀😀");
  });
});

describe("Feature: hostile text, the CSV", () => {
  it("Given cells that a spreadsheet reads as formulas, Then they start with an apostrophe and stay text", () => {
    for (const f of ["=1+1", "+1", "-1", "@SUM(1)", "\t=1", '=HYPERLINK("http://x","y")']) {
      const cell = csvText(f, 80);
      const parsed = parseCsv(cell + "\r\n")[0]![0]!;
      expect(parsed.startsWith("'"), f).toBe(true);
      expect(/^[=+\-@\t\r]/.test(parsed), f).toBe(false);
    }
    expect(csvText("Gold", 80)).toBe("Gold");
    expect(csvText("a,b", 80)).toBe('"a,b"');
    expect(csvText('say "hi"', 80)).toBe('"say ""hi"""');
    expect(csvText("line\nbreak", 80)).toBe("line break");
  });

  it("Given hostile labels, Then the CSV parses back to the same number of rows and columns, with no formula cell", () => {
    const labels = [
      '=cmd|" /C calc"!A0',
      "+SUM(1)",
      "-1+2",
      "@x",
      "a,b,c",
      'q"uote"',
      "line\r\nbreak",
      "\u202E=1",
      "| pipe |",
      "x".repeat(10_000),
      "",
    ];
    const s = session(1, {
      trips: labels.map((l, i) =>
        trip({
          key: (i + 1).toString(16).padStart(8, "0"),
          ended_at: stamp(i),
          label: l,
          commodity: l,
          buy_terminal: l,
          sell_terminal: l,
          net_auec: -250,
          net_kind: "balance_delta",
        }),
      ),
    });
    for (const money of [false, true]) {
      const d = buildDebrief([s], { includeMoney: money });
      expect(d.csv.endsWith("\r\n")).toBe(true);
      expect(d.csv.replace(/\r\n/g, "").includes("\n")).toBe(false);
      const rows = parseCsv(d.csv);
      expect(rows).toHaveLength(labels.length + 1);
      const header = rows[0]!;
      expect(header).toEqual([...CSV_COLUMNS_BASE, ...(money ? CSV_COLUMNS_MONEY : [])]);
      for (const r of rows.slice(1)) {
        expect(r).toHaveLength(header.length);
        for (const col of ["label", "commodity", "buy_terminal", "sell_terminal"]) {
          const v = r[header.indexOf(col)]!;
          expect(/^[=+\-@\t\r]/.test(v), v.slice(0, 20)).toBe(false);
          expect(Array.from(v).length).toBeLessThanOrEqual(81);
        }
      }
      if (money) {
        // a negative amount is a number, not a text cell: it keeps its sign and is not prefixed
        expect(rows[1]![header.indexOf("net_auec")]).toBe("-250");
      }
    }
  });

  it("Given numbers, Then they are plain decimals and empty when unknown", () => {
    expect(csvNumber(null)).toBe("");
    expect(csvNumber(undefined)).toBe("");
    expect(csvNumber(Number.NaN)).toBe("");
    expect(csvNumber(Infinity)).toBe("");
    expect(csvNumber(0)).toBe("0");
    expect(csvNumber(-1234.4)).toBe("-1234");
    expect(csvNumber(12.345, 2)).toBe("12.35");
    expect(csvNumber(1e300)).toBe("");
  });
});

describe("Feature: determinism and size", () => {
  it("Given the same input in another order, Then the bytes are the same", () => {
    const a = richSession(2, { id: "s_rich_2" });
    const b = richSession(3, { id: "s_rich_3" });
    const cal = report([group()]);
    const one = buildDebrief([a, b], {
      includeMoney: true,
      includeBalances: true,
      calibration: cal,
    });
    const reversed: Session[] = [
      { ...b, trips: [...b.trips].reverse() },
      { ...a, trips: [...a.trips].reverse() },
    ];
    const two = buildDebrief(reversed, {
      includeMoney: true,
      includeBalances: true,
      calibration: cal,
    });
    expect(two.markdown).toBe(one.markdown);
    expect(two.csv).toBe(one.csv);
    expect(
      buildDebrief([a, b], { includeMoney: true, includeBalances: true, calibration: cal }),
    ).toEqual(one);
  });

  it("Given the clock or the locale changes, Then the report does not", () => {
    const s = richSession();
    const before = buildDebrief([s], { includeMoney: true });
    const realNow = Date.now;
    const realTz = process.env.TZ;
    try {
      Date.now = () => 0;
      process.env.TZ = "Pacific/Kiritimati";
      expect(buildDebrief([s], { includeMoney: true }).markdown).toBe(before.markdown);
    } finally {
      Date.now = realNow;
      if (realTz === undefined) delete process.env.TZ;
      else process.env.TZ = realTz;
    }
    expect(before.markdown).not.toMatch(/Généré|generated/i);
  });

  const big = (n: number, label: string): Session =>
    session(9, {
      active_ms: 10 * 3_600_000,
      trips: Array.from({ length: n }, (_, i) =>
        trip({
          key: (i + 1).toString(16).padStart(8, "0"),
          ended_at: stamp(i * 60),
          started_at: stamp(i * 60 - 30),
          label,
          commodity: label,
          buy_terminal: label,
          sell_terminal: label,
          scu: 96,
          cost_auec: 123_456,
          revenue_auec: 234_567,
          gross_margin_auec: 111_111,
          fees_auec: 1_000,
          fees_method: "mesure",
          net_auec: 100_000,
          net_kind: "balance_delta",
        }),
      ),
    });

  it("Given a 500-trip session, Then the Markdown table is cut with a note, the CSV is complete and both are bounded", () => {
    const d = buildDebrief([big(500, "Cargo Laranite")], { includeMoney: true });
    expect(d.trips_total).toBe(500);
    expect(d.markdown_rows).toBe(DEBRIEF_LIMITS.markdownRows);
    expect(d.csv_rows).toBe(500);
    expect(d.truncated).toBe(true);
    expect(d.markdown).toContain(
      "100 derniers trajets sur 500 : les 400 plus anciens sont omis ici (le CSV les contient)",
    );
    expect(d.markdown.length).toBeLessThan(60_000);
    expect(parseCsv(d.csv)).toHaveLength(501);
    // the newest are the ones kept
    expect(d.markdown.split("\n").filter((l) => l.startsWith("| 2026")).length).toBe(100);
  });

  it("Given 500 trips of maximum-length hostile text, Then both outputs stay under their character budgets", () => {
    const worst = '|`<>&\\*_"'.repeat(20) + "é".repeat(400);
    const d = buildDebrief([big(500, worst)], { includeMoney: true });
    const tableChars = d.markdown.length;
    expect(tableChars).toBeLessThan(150_000);
    expect(d.csv.length).toBeLessThan(DEBRIEF_LIMITS.csvChars + 2_000);
    expect(d.truncated).toBe(true);
    expect(d.markdown_rows).toBeLessThanOrEqual(DEBRIEF_LIMITS.markdownRows);
    expect(d.markdown_rows).toBeGreaterThanOrEqual(1);
    expect(d.csv_rows).toBeGreaterThanOrEqual(1);
    expect(parseCsv(d.csv).every((r) => r.length === parseCsv(d.csv)[0]!.length)).toBe(true);
    expect(d.markdown).toContain("plus anciens sont omis ici");
  });

  it("Given more sessions than the limit, Then only the newest are covered", () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      richSession(i + 1, { id: `s_rich_${i + 1}` }),
    );
    const d = buildDebrief(many, { includeMoney: false });
    expect(d.sessions).toHaveLength(DEBRIEF_LIMITS.sessions);
    expect(d.sessions[d.sessions.length - 1]).toBe(14);
  });
});

describe("Feature: honest about what it does not know", () => {
  it("Given trips dropped from the file and a break without a marker, Then the unexplained section says so, without amounts", () => {
    const s = richSession(1, { trips_dropped: 7 });
    const d = buildDebrief([s], { includeMoney: false });
    const part = d.markdown.split("## Ce qui n’est pas expliqué")[1]!.split("## Lecture")[0]!;
    expect(part).toContain("7 trajet(s) plus ancien(s)");
    expect(part).toContain("sans marqueur de fin");
  });

  it("Given a run stored twice, Then it is listed once and the report says so", () => {
    const t = (key: string, end: number): Trip =>
      trip({
        key,
        started_at: stamp(0),
        ended_at: stamp(end),
        commodity: "Gold",
        label: "Cargo Gold",
        gross_margin_auec: 1000,
      });
    const s = session(1, { active_ms: 3_600_000, trips: [t("00000a01", 10), t("00000a02", 20)] });
    const d = buildDebrief([s], { includeMoney: false });
    expect(d.trips_total).toBe(1);
    expect(d.markdown).toContain("enregistré(s) deux fois");
  });
});

/** The cell as a reader gets it, and its pieces when something splits it on ; , tab or | (spaces before a piece ignored). */
const readCell = (cell: string) => parseCsv(cell + "\r\n")[0]![0]!;
const pieces = (text: string) => text.split(/[;,\t|]/).map((x) => x.trimStart());
const startsFormula = (piece: string) => /^[=+\-@\r\t]/.test(piece);

describe("Feature: CSV injection, for any program that splits on another separator", () => {
  // the auditor's cases, and the neighbours
  const attacks = [
    "a;+cmd|' /C calc'!A0",
    'x;=HYPERLINK("http://evil.example","click")',
    "a,@SUM(1+1)",
    "a|=1+1",
    "ok; -2+3",
    "ok,\t=1",
    "=1+1",
    "@x",
    "\t=1",
    "plain;text;here",
  ];

  it("Given a formula starter after any separator, Then the cell is text (apostrophe) and quoted, so it is one cell", () => {
    for (const a of attacks) {
      const cell = csvText(a, 80);
      const dangerous = /^[\t=+\-@]/.test(a);
      if (dangerous) expect(cell.replace(/^"/, "").startsWith("'"), a).toBe(true);
      // a reader that splits the text on ; , tab or | sees no piece that starts with a formula character
      expect(pieces(readCell(cell)).filter(startsFormula), a).toEqual([]);
      // one cell whichever of the two delimiters reads it
      for (const d of [",", ";"]) expect(parseCsv(cell + "\r\n", d)[0], a + d).toHaveLength(1);
      // quoted whenever it holds either separator
      if (/[;,]/.test(a)) expect(cell.startsWith('"'), a).toBe(true);
    }
    expect(csvText("Gold", 80)).toBe("Gold");
    expect(csvText("100 - 50", 80)).toBe("100 - 50");
    // the auditor's cases, exactly
    expect(csvText("a;+cmd|' /C calc'!A0", 80)).toBe("\"a;'+cmd|' /C calc'!A0\"");
    expect(csvText('x;=HYPERLINK("u","y")', 80)).toBe('"x;\'=HYPERLINK(""u"",""y"")"');
  });

  it("Given a whole export of those labels, Then every row has the same columns with either delimiter, and no cell starts with a formula starter", () => {
    const s = session(1, {
      trips: attacks.map((l, i) =>
        trip({
          key: (i + 1).toString(16).padStart(8, "0"),
          ended_at: stamp(i),
          label: l,
          commodity: l,
          buy_terminal: l,
          sell_terminal: l,
          scu: 96.5,
          net_auec: -250,
          net_kind: "balance_delta",
        }),
      ),
    });
    for (const delim of [",", ";"] as const) {
      const d = buildDebrief([s], { includeMoney: true, csvDelimiter: delim });
      expect(d.csv_delimiter).toBe(delim);
      const rows = parseCsv(d.csv, delim);
      expect(rows).toHaveLength(attacks.length + 1);
      expect(rows[0]!.length).toBe(CSV_COLUMNS_BASE.length + CSV_COLUMNS_MONEY.length);
      for (const r of rows) {
        expect(r).toHaveLength(rows[0]!.length);
        for (const cell of r)
          expect(/^[\t\r]|^[=+\-@][^0-9]/.test(cell.replace(/^-?\d.*/, "0")), cell).toBe(false);
      }
      const h = rows[0]!;
      // numbers: a decimal point with the comma file, a decimal comma with the semicolon file
      expect(rows[1]![h.indexOf("scu")]).toBe(delim === ";" ? "96,5" : "96.5");
      expect(rows[1]![h.indexOf("net_auec")]).toBe("-250");
    }
    expect(buildDebrief([s], { includeMoney: true }).csv.split("\r\n")[0]).toContain(",");
    expect(
      buildDebrief([s], { includeMoney: true, csvDelimiter: ";" }).csv.split("\r\n")[0],
    ).not.toContain(",");
  });

  it("Given a number, Then the decimal comma is for the semicolon file only", () => {
    expect(csvNumber(96.5, 2)).toBe("96.5");
    expect(csvNumber(96.5, 2, true)).toBe("96,5");
    expect(csvNumber(1200, 2, true)).toBe("1200");
  });
});

describe("Feature: the counted column says what the Markdown says", () => {
  it("Given a trip with no known result, Then it is not counted; with a margin only or a net, it is", () => {
    const s = session(1, {
      active_ms: 3_600_000,
      trips: [
        trip({
          key: "0000000a",
          ended_at: stamp(1),
          label: "none",
          commodity: "A",
          started_at: stamp(-1),
        }),
        trip({
          key: "0000000b",
          ended_at: stamp(2),
          label: "gross",
          commodity: "B",
          started_at: stamp(-2),
          gross_margin_auec: 10,
        }),
        trip({
          key: "0000000c",
          commodity: "C",
          started_at: stamp(-3),
          ended_at: stamp(3),
          label: "net",
          net_auec: 5,
          net_kind: "balance_delta",
        }),
      ],
    });
    const d = buildDebrief([s], { includeMoney: true });
    const rows = parseCsv(d.csv);
    const h = rows[0]!;
    const counted = Object.fromEntries(
      rows.slice(1).map((r) => [r[h.indexOf("label")], r[h.indexOf("counted")]]),
    );
    expect(counted).toEqual({ none: "no", gross: "yes", net: "yes" });
  });
});

describe("Feature: the two presets", () => {
  const worst = '|`<>&\\*_"'.repeat(20) + "é".repeat(60);
  const many = (sessions: number, trips: number): Session[] =>
    Array.from({ length: sessions }, (_, k) =>
      session(k + 1, {
        id: `s_big_${k + 1}`,
        active_ms: 3_600_000,
        note: "n".repeat(500),
        trips: Array.from({ length: trips }, (_, i) =>
          trip({
            key: (k * 1000 + i + 1).toString(16).padStart(8, "0"),
            started_at: stamp(k * 100_000 + i * 60 - 30),
            ended_at: stamp(k * 100_000 + i * 60),
            label: worst,
            commodity: worst,
            buy_terminal: worst,
            sell_terminal: worst,
            scu: 96,
            cost_auec: 123_456,
            revenue_auec: 234_567,
            gross_margin_auec: 111_111,
            fees_auec: 1000,
            fees_method: "mesure",
            net_auec: 100_000,
            net_kind: "balance_delta",
          }),
        ),
      }),
    );

  it("Given 10 sessions of 500 hostile trips, Then the model's report is under 28 000 characters, in both formats", () => {
    const d = buildDebrief(many(10, 500), { includeMoney: true, ...DEBRIEF_FOR_MODEL });
    expect(d.markdown.length).toBeLessThanOrEqual(DEBRIEF_FOR_MODEL.maxChars);
    expect(d.csv.length).toBeLessThanOrEqual(DEBRIEF_FOR_MODEL.csvChars + 2000);
    expect(d.csv_rows).toBeLessThanOrEqual(DEBRIEF_FOR_MODEL.csvRows);
    expect(d.markdown_rows).toBeLessThanOrEqual(DEBRIEF_FOR_MODEL.markdownRowsPerSession * 10);
    expect(d.truncated).toBe(true);
    expect(d.markdown_omitted).toBe(d.trips_total - d.markdown_rows);
    expect(d.csv_omitted).toBe(d.trips_total - d.csv_rows);
    expect(d.markdown).toContain("se télécharge depuis la barre de session");
    expect(d.markdown).not.toContain("rapport tronqué");
  });

  it("Given one session of 500 trips, Then the model gets at most 20 table rows and the player's export gets all of them", () => {
    const one = many(1, 500);
    const model = buildDebrief(one, { includeMoney: false, ...DEBRIEF_FOR_MODEL });
    expect(model.markdown_rows).toBeLessThanOrEqual(20);
    const light = session(2, {
      active_ms: 3_600_000,
      trips: Array.from({ length: 500 }, (_, i) =>
        trip({
          key: (i + 1).toString(16).padStart(8, "0"),
          ended_at: stamp(i),
          started_at: stamp(i - 1),
          label: "Cargo " + i,
          commodity: "G" + i,
          scu: 8,
        }),
      ),
    });
    const full = buildDebrief([light], { includeMoney: false, ...DEBRIEF_FOR_EXPORT });
    expect(full.markdown_rows).toBe(500);
    expect(full.csv_rows).toBe(500);
    expect(full.markdown_omitted).toBe(0);
    expect(full.csv_omitted).toBe(0);
    expect(full.truncated).toBe(false);
  });

  it("Given a bound so small that even the text around the table does not fit, Then it is cut with a note and never exceeds it", () => {
    const d = buildDebrief(many(3, 5), { includeMoney: true, maxChars: 2000 });
    expect(d.markdown.length).toBeLessThanOrEqual(2000);
    expect(d.markdown).toContain("rapport tronqué");
    expect(d.truncated).toBe(true);
  });
});

describe("Feature: the escaping is complete and reversible (every occurrence, the escape character first)", () => {
  const alphabet = [
    "\\",
    "\\\\",
    "|",
    "\\|",
    "\\\\|",
    "`",
    "*",
    "_",
    "[",
    "]",
    "~",
    "#",
    "@",
    "<",
    ">",
    "&",
    "&amp;",
    "&lt;",
    "&#65;",
    "R&R",
    "://",
    "http://",
    "www.",
    "WWW.",
    '"',
    '""',
    ",",
    ";",
    "=",
    "+",
    "-",
    " ",
    "\r\n",
    "\n",
    "\t",
    "a",
    "é",
  ];
  let seed = 424242;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const sample = () =>
    Array.from(
      { length: Math.floor(rnd() * 12) },
      () => alphabet[Math.floor(rnd() * alphabet.length)]!,
    ).join("");

  /** The reverse of markdownText: drop one backslash level, then decode the three entities. */
  const unescapeMd = (s: string) =>
    s
      .replace(/\\(.)/g, "$1")
      .replace(/&(lt|gt|amp);/g, (_m, n: string) => ({ lt: "<", gt: ">", amp: "&" })[n]!);

  it("Given any mix of special characters, Then undoing the escape gives the cleaned text back, and nothing special is left bare", () => {
    for (let n = 0; n < 2000; n++) {
      const x = sample();
      const out = markdownText(x, 200);
      expect(unescapeMd(out), JSON.stringify(x)).toBe(debriefText(x, 200));
      const bare = out.replace(/\\./g, "").replace(/&(lt|gt|amp);/g, "");
      expect(bare, JSON.stringify(x)).not.toMatch(/[\\`*_[\]|~#@<>]/);
    }
  });

  it("Given the named sequences, Then each occurrence is escaped, backslash first", () => {
    expect(markdownText("\\|", 80)).toBe("\\\\\\|");
    expect(markdownText("\\\\|", 80)).toBe("\\\\\\\\\\|");
    expect(markdownText("a|b|c|d", 80)).toBe("a\\|b\\|c\\|d");
    expect(markdownText("`a` `b`", 80)).toBe("\\`a\\` \\`b\\`");
    expect(markdownText("www.a WWW.b", 80)).toBe("www\\.a WWW\\.b");
    expect(markdownText("http://a http://b", 80)).toBe("http\\://a http\\://b");
    expect(markdownText("&amp;&amp;", 80)).toBe("&amp;amp;&amp;amp;");
    expect(markdownText("a\r\nb", 80)).toBe("a b");
  });

  it("Given any mix, Then the CSV cell reads back as the cleaned text (apostrophe when it could start a formula), quotes doubled", () => {
    for (let n = 0; n < 2000; n++) {
      const x = sample();
      const cleaned = debriefText(x, 200);
      const cell = csvText(x, 200);
      for (const d of [",", ";"]) {
        const row = parseCsv(cell + "\r\n", d);
        expect(row, JSON.stringify(x)).toHaveLength(1);
        expect(row[0], JSON.stringify(x)).toHaveLength(1);
        // the reference: an apostrophe after every separator that precedes a formula starter, then one at the start
        const marked = cleaned.replace(/([;,\t|][ ]*)(?=[=+\-@\r])/g, "$1'");
        const expected = /^[=+\-@\t\r]/.test(marked) ? "'" + marked : marked;
        expect(row[0]![0], JSON.stringify(x)).toBe(expected);
        // and a reader that splits the text itself finds no piece that starts with a formula character
        expect(pieces(row[0]![0]!).filter(startsFormula), JSON.stringify(x)).toEqual([]);
      }
      // quoted exactly when the text holds a quote, a comma, a semicolon or a line break; every quote inside is doubled
      const read = parseCsv(cell + "\r\n")[0]![0]!;
      const quoted = /[",;\r\n]/.test(read);
      expect(cell.startsWith('"'), JSON.stringify(x)).toBe(quoted);
      if (quoted) expect(cell.slice(1, -1).replace(/""/g, "")).not.toContain('"');
    }
  });
});
