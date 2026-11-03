/**
 * Small, dependency-free HTML to plain text for MediaWiki output. It is not an HTML parser and
 * does not try to be one: it turns the parts a patch-notes page uses (headings, paragraphs, list
 * items, line breaks) into readable lines, drops everything else, and decodes common entities.
 * The result is third-party text: callers treat it as untrusted.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) =>
      String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)),
    )
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

export function htmlToText(html: string): string {
  const text = html
    .replace(/<(style|script|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => {
      const title = inner
        .replace(/<[^>]+>/g, "")
        .replace(/\[edit\]/gi, "")
        .trim();
      return `\n\n${"#".repeat(Number(level))} ${title}\n`;
    })
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|ul|ol|table|tr|dd|dt)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .replace(/\[edit\]/gi, "")
    .replace(/^edit$/gm, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Passages around each occurrence of `needle`, with the heading each one sits under. */
export function findPassages(
  text: string,
  needle: string,
  options: { radius?: number; max?: number } = {},
): { heading: string | null; passage: string }[] {
  const radius = options.radius ?? 160;
  const max = options.max ?? 8;
  const lower = text.toLowerCase();
  const want = needle.toLowerCase();
  if (!want) return [];
  const out: { heading: string | null; passage: string }[] = [];
  let from = 0;
  while (out.length < max) {
    const at = lower.indexOf(want, from);
    if (at < 0) break;
    const before = text.slice(0, at);
    const headings = [...before.matchAll(/^#{1,6} (.+)$/gm)];
    const start = Math.max(0, at - radius);
    const end = Math.min(text.length, at + want.length + radius);
    out.push({
      heading: headings.at(-1)?.[1] ?? null,
      passage: `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\n+/g, " ")}${end < text.length ? "…" : ""}`,
    });
    from = end; // do not report the same stretch twice
  }
  return out;
}
