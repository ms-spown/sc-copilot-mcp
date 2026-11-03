import { isObject } from "../../core/format.js";

/** One readable search hit. The text is community-written: the registry fences it as untrusted. */
export interface SearchResult {
  title: string;
  excerpt?: string;
  url?: string;
}

const MAX_RESULTS = 10;
const MAX_EXCERPT = 240;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#039;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
};

/** MediaWiki snippets are HTML: the match is wrapped in a span. Keep the words, drop the markup. */
export function cleanSnippet(html: string, max: number = MAX_EXCERPT): string {
  const text = html
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|nbsp|#0?39);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function pageUrl(baseURL: string | undefined, title: string): string | undefined {
  if (!baseURL) return undefined;
  return `${baseURL.replace(/\/+$/, "")}/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

/**
 * Turn a MediaWiki search answer into a short list. Understands the `list=search` shape
 * (`query.search[]` with a snippet) and the raw OpenSearch shape (`[query, titles, extracts, urls]`),
 * so a change on the wiki side does not bring the raw arrays back to the player.
 */
export function parseSearchResults(data: unknown, baseURL?: string): SearchResult[] {
  const out: SearchResult[] = [];

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
  }
  return out.slice(0, MAX_RESULTS);
}
