import axios from "axios";
import { z } from "zod";
import { fetchWithCache } from "../core/cache.js";
import { formatOutputRaw } from "../core/format.js";
import type { HttpClient } from "../core/http.js";
import { setChannel, setGameVersion } from "../core/provenance.js";
import { findPassages, htmlToText } from "../core/text.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * Patch notes of each Star Citizen update, from the "Update:" pages of starcitizen.tools (a
 * community wiki that transcribes them, CC BY-SA). The official notes live on the RSI website,
 * which this project never fetches: the pages here link to it under "Official links".
 */

/** MediaWiki namespace id of "Update:" on starcitizen.tools. */
const UPDATE_NAMESPACE = 3016;
const MAX_SECTION_CHARS = 9000;
const MAX_INTRO_CHARS = 1500;

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: formatOutputRaw(value) }],
});

const versionParts = (v: string) => v.split(".").map((n) => Number(n));
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

interface UpdatePage {
  title: string;
  version: string;
}

/** "Update:Star Citizen Alpha 4.10.2" -> { version: "4.10.2" }. Other "Update:" pages are ignored. */
export function parseUpdateTitles(titles: string[]): UpdatePage[] {
  const pages: UpdatePage[] = [];
  for (const title of titles) {
    const m = title.match(/Alpha (\d+\.\d+(?:\.\d+)?)$/);
    if (m) pages.push({ title, version: m[1] });
  }
  return pages.sort((a, b) => compareVersions(b.version, a.version));
}

/** The page for a version: exact, else the newest of that family ("4.10" -> newest 4.10.x). Default: newest. */
export function pickUpdate(pages: UpdatePage[], wanted?: string): UpdatePage | null {
  if (!wanted) return pages[0] ?? null;
  const v = wanted.trim().replace(/^v/i, "");
  return (
    pages.find((p) => p.version === v) ?? pages.find((p) => p.version.startsWith(`${v}.`)) ?? null
  );
}

/** A page with no real notes yet: the wiki's own stub banner, or hardly any sections. */
export function isStub(doc: { text: { "*": string }; sections?: unknown[] }): boolean {
  return /This article is a stub/i.test(doc.text["*"]) || (doc.sections ?? []).length < 4;
}

export function patchNotesTools({ sctClient }: { sctClient: HttpClient }): ToolDefinition[] {
  const api = (params: Record<string, unknown>) =>
    fetchWithCache(sctClient, "/api.php", { params: { format: "json", ...params } });

  return [
    {
      name: "sc_patch_notes",
      description:
        "Patch notes of a Star Citizen update (newest by default, or a version such as '4.10.2' or '4.10'), from the community wiki starcitizen.tools, which transcribes them. Without arguments: the version, its summary and the list of sections. With section (part of a heading such as 'Hauling' or 'Ships'): that section's text. With search (a word such as 'Wikelo' or 'cargo'): the passages that mention it. Use it to answer what a patch changed, then scmdb_changes for the datamined mission and blueprint differences. The official notes are on the RSI website, which this server does not read. Wiki text is community-written.",
      inputSchema: {
        type: "object",
        properties: {
          version: {
            type: "string",
            description:
              "Update to read, e.g. '4.10.2' or '4.10' (newest 4.10.x). Default: the newest listed.",
          },
          section: {
            type: "string",
            description:
              "Part of a section heading to read in full (e.g. 'Ships', 'Hauling', 'Bug fixes').",
          },
          search: {
            type: "string",
            description:
              "A word or phrase to find in the notes; returns the passages and their headings.",
          },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const { version, section, search } = z
          .object({
            version: z.string().optional(),
            section: z.string().optional(),
            search: z.string().optional(),
          })
          .parse(args || {});

        const listing = await api({
          action: "query",
          list: "allpages",
          apnamespace: UPDATE_NAMESPACE,
          aplimit: 500,
        });
        const titles: string[] = (listing.data?.query?.allpages ?? []).map(
          (p: { title: string }) => p.title,
        );
        const pages = parseUpdateTitles(titles);
        if (pages.length === 0) {
          throw new Error(
            "starcitizen.tools lists no update pages; its structure may have changed.",
          );
        }
        const read = async (title: string) => {
          const parsed = await api({
            action: "parse",
            page: title,
            prop: "sections|text",
            redirects: 1,
            disablelimitreport: 1,
          });
          const found = parsed.data?.parse;
          if (!found?.text?.["*"]) throw new Error(`The page ${title} could not be read.`);
          return found;
        };

        let page = pickUpdate(pages, version);
        if (!page) {
          throw new Error(
            `No update page for "${version}". Newest available: ${pages
              .slice(0, 6)
              .map((p) => p.version)
              .join(", ")}.`,
          );
        }
        let doc = await read(page.title);
        if (!version) {
          // The newest page is usually a stub for an update that has not shipped: take the newest written one.
          for (const candidate of pages.slice(0, 6)) {
            const d = candidate === page ? doc : await read(candidate.title);
            if (!isStub(d)) {
              page = candidate;
              doc = d;
              break;
            }
          }
        }
        setGameVersion(page.version);
        setChannel("unknown");

        const sections: { n: string; level: number; title: string }[] = (doc.sections ?? []).map(
          (s: { index: string; level: string; line: string }) => ({
            n: s.index,
            level: Number(s.level),
            title: htmlToText(String(s.line)),
          }),
        );
        const full = htmlToText(doc.text["*"]);
        const url = `https://starcitizen.tools/${encodeURIComponent(page.title.replace(/ /g, "_")).replace(/%3A/g, ":")}`;
        const header = {
          version: page.version,
          page: page.title,
          url,
          transcription_of: "official patch notes",
        };

        if (search) {
          // The page's own table of contents repeats every heading: not a place a change is described.
          const body = full.replace(/^#{1,6} On this page[\s\S]*?(?=^#{1,6} )/m, "");
          const hits = findPassages(body, search);
          return ok({ ...header, search, matches: hits.length, passages: hits });
        }

        if (section) {
          const wanted = section.toLowerCase();
          const hit = sections.find((s) => s.title.toLowerCase().includes(wanted));
          if (!hit) {
            return ok({
              ...header,
              error: `No section matching "${section}".`,
              sections: sections.filter((s) => s.level <= 3).map((s) => s.title),
            });
          }
          let text: string;
          try {
            const body = await api({
              action: "parse",
              page: page.title,
              prop: "text",
              section: hit.n,
              redirects: 1,
              disablelimitreport: 1,
            });
            text = htmlToText(body.data?.parse?.text?.["*"] ?? "");
          } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 404) text = "";
            else throw error;
          }
          const cut = text.length > MAX_SECTION_CHARS;
          return ok({
            ...header,
            section: hit.title,
            text: cut ? `${text.slice(0, MAX_SECTION_CHARS)}…` : text,
            truncated: cut,
          });
        }

        const released = full.match(/Released\s+(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;
        const intro = full
          .split(/\n#{1,6} /)[0]
          .replace(/This article (is a stub|needs some)[^\n]*\n?/gi, "")
          .trim();
        // The page opens with navigation boxes; the summary is the paragraph saying what the update is.
        const lead =
          intro
            .split(/\n+/)
            .find((para) => /^Star Citizen (Alpha|Release) [\d.]+ is /.test(para.trim())) ?? intro;
        return ok({
          ...header,
          released,
          summary: lead.length > MAX_INTRO_CHARS ? `${lead.slice(0, MAX_INTRO_CHARS)}…` : lead,
          sections: sections.filter((s) => s.level <= 3).map((s) => s.title),
          other_updates: pages
            .filter((p) => p !== page)
            .slice(0, 8)
            .map((p) => p.version),
          hint: "Ask again with section or search to read the details.",
        });
      },
    },
  ];
}
