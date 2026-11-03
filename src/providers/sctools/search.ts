import { isObject } from "../../core/format.js";

/** One readable search hit. The text is community-written: the registry fences it as untrusted. */
export interface SearchResult {
  title: string;
  excerpt?: string;
  url?: string;
}

const MAX_RESULTS = 10;
const MAX_EXCERPT = 240;

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  ndash: "–",
  mdash: "—",
};

/** One pass, so "&amp;lt;" becomes the text "&lt;" and is never decoded twice. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (name) return NAMED[String(name).toLowerCase()] ?? whole;
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

/**
 * MediaWiki snippets are HTML: the match is wrapped in a span. Drop the tags first, then decode
 * the entities, then never leave a "<" or ">" behind: decoding must not bring a tag back.
 */
export function cleanSnippet(html: string, max: number = MAX_EXCERPT): string {
  const text = decodeEntities(html.replace(/<[^>]*>/g, ""))
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** Encode each part of the title but leave "/" and ":" as MediaWiki does ("Category:Ships"). */
function pageUrl(baseURL: string | undefined, title: string): string | undefined {
  if (!baseURL) return undefined;
  const path = title
    .replace(/ /g, "_")
    .split(/([/:])/)
    .map((part) => (part === "/" || part === ":" ? part : encodeURIComponent(part)))
    .join("");
  return `${baseURL.replace(/\/+$/, "")}/${path}`;
}

/**
 * Turn a MediaWiki search answer into a short list. Understands the `list=search` shape
 * (`query.search[]` with a snippet) and the raw OpenSearch shape (`[query, titles, extracts, urls]`),
 * so a change on the wiki side does not bring the raw arrays back to the player.
 */
export function parseSearchResults(data: unknown, baseURL?: string): SearchResult[] {
  const out: SearchResult[] = [];

  // MediaWiki answers errors with HTTP 200 and an "error" object: that is a failure, not "no result".
  if (isObject(data) && isObject(data.error)) {
    const code =
      typeof data.error.code === "string" ? cleanSnippet(data.error.code, 60) : "unknown";
    const info = typeof data.error.info === "string" ? cleanSnippet(data.error.info, 200) : "";
    throw new Error(`starcitizen.tools search failed (${code})${info ? `: ${info}` : ""}`);
  }

  if (isObject(data) && isObject(data.query) && Array.isArray(data.query.search)) {
    for (const hit of data.query.search) {
      if (!isObject(hit) || typeof hit.title !== "string") continue;
      const excerpt = typeof hit.snippet === "string" ? cleanSnippet(hit.snippet) : "";
      out.push({
        title: hit.title,
        ...(excerpt ? { excerpt } : {}),
        ...(pageUrl(baseURL, hit.title) ? { url: pageUrl(baseURL, hit.title) } : {}),
      });
    }
  } else if (Array.isArray(data) && Array.isArray(data[1])) {
    const [, titles, extracts, urls] = data as [unknown, unknown[], unknown[]?, unknown[]?];
    titles.forEach((title, i) => {
      if (typeof title !== "string") return;
      const extract = extracts?.[i];
      const url = urls?.[i];
      const excerpt = typeof extract === "string" ? cleanSnippet(extract) : "";
      const link = typeof url === "string" && url ? url : pageUrl(baseURL, title);
      out.push({
        title,
        ...(excerpt ? { excerpt } : {}),
        ...(link ? { url: link } : {}),
      });
    });
  } else {
    throw new Error("starcitizen.tools search: unexpected answer from the wiki.");
  }
  return out.slice(0, MAX_RESULTS);
}
