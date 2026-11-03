import {
  COVERAGE,
  REASONS,
  WIDGETS,
  type ReasonId,
  type WidgetId,
} from "../providers/telemetry/coverage.js";

/**
 * The "Coverage" section of docs/TELEMETRY.md and docs/TELEMETRY.fr.md, generated from the coverage table so the two
 * documents and the code cannot drift (docs/coverageDoc.test.ts compares them). `npm run docs:coverage` rewrites it.
 * The field identifiers (`Message.field`) are the same in both languages.
 */

export type Lang = "en" | "fr";

const TEXT = {
  en: {
    heading: "Coverage",
    intro:
      "What becomes of every field of the stream. `poll.` is the answer of `sc_live_poll` (what the dashboard receives), `state.` the state of `sc_live_state`. Values that are present but not verified sit under `unverified` in the poll and are labelled as such in the page. A test (`coverage.test.ts`) fails when a field of the schema has no line here, so a new field in a patch forces a decision.",
    field: "Field",
    server: "Server",
    view: "Dashboard",
    ignored: "ignored",
    summary: (n: number, exposed: number, ignored: number, shown: number) =>
      `${n} fields: ${exposed} exposed by the server, ${ignored} ignored on purpose; ${shown} shown by the dashboard (the others are exposed to the model only, or ignored).`,
  },
  fr: {
    heading: "Couverture",
    intro:
      "Ce que devient chaque champ du flux. `poll.` est la réponse de `sc_live_poll` (ce que reçoit le tableau de bord), `state.` l'état de `sc_live_state`. Les valeurs présentes mais non vérifiées sont sous `unverified` dans le poll et étiquetées comme telles dans la page. Un test (`coverage.test.ts`) échoue quand un champ du schéma n'a pas de ligne ici : un nouveau champ dans un patch force une décision.",
    field: "Champ",
    server: "Serveur",
    view: "Tableau de bord",
    ignored: "ignoré",
    summary: (n: number, exposed: number, ignored: number, shown: number) =>
      `${n} champs : ${exposed} exposés par le serveur, ${ignored} ignorés volontairement ; ${shown} affichés par le tableau de bord (les autres sont exposés au modèle seulement, ou ignorés).`,
  },
} as const;

export function coverageSection(lang: Lang): string {
  const t = TEXT[lang];
  const rows: string[] = [];
  let exposed = 0;
  let ignored = 0;
  let shown = 0;
  for (const [key, entry] of Object.entries(COVERAGE)) {
    let server: string;
    if (entry.server.startsWith("exposed:")) {
      exposed++;
      server = `\`${entry.server.slice("exposed:".length)}\``;
    } else {
      ignored++;
      server = `${t.ignored} : ${REASONS[entry.server.slice("ignored:".length) as ReasonId][lang]}`;
    }
    let view: string;
    if (entry.view.startsWith("view:")) {
      shown++;
      const id = entry.view.slice("view:".length) as WidgetId;
      view = `${WIDGETS[id][lang]} (\`${id}\`)`;
    } else if (entry.view === "ignored:same_as_server") {
      view = "-";
    } else {
      view = `${t.ignored} : ${REASONS[entry.view.slice("ignored:".length) as ReasonId][lang]}`;
    }
    rows.push(`| \`${key}\` | ${server} | ${view} |`);
  }
  return [
    `## ${t.heading}`,
    "",
    t.intro,
    "",
    t.summary(rows.length, exposed, ignored, shown),
    "",
    `| ${t.field} | ${t.server} | ${t.view} |`,
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** The heading line the section starts with, per language. */
export const coverageHeading = (lang: Lang): string => `## ${TEXT[lang].heading}`;

/** Replaces the section in `doc` (from its heading to the next `## `), or inserts it before `before`. */
export function withCoverage(doc: string, lang: Lang, before: string): string {
  const text = doc.replace(/\r\n/g, "\n");
  const start = text.indexOf(coverageHeading(lang) + "\n");
  const section = coverageSection(lang);
  if (start >= 0) {
    const next = text.indexOf("\n## ", start + 3);
    return text.slice(0, start) + section + (next >= 0 ? text.slice(next) : "");
  }
  const at = text.indexOf(before);
  if (at < 0) throw new Error(`cannot place the coverage section: no "${before}"`);
  return text.slice(0, at) + section + "\n" + text.slice(at);
}

/** The section as it stands in a document (up to the next `## `), CRLF normalised; null when absent. */
export function coverageOf(doc: string, lang: Lang): string | null {
  const text = doc.replace(/\r\n/g, "\n");
  const start = text.indexOf(coverageHeading(lang) + "\n");
  if (start < 0) return null;
  const next = text.indexOf("\n## ", start + 3);
  return text.slice(start, next >= 0 ? next : undefined);
}
