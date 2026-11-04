import { transform } from "lightningcss";
import { describe, expect, it } from "vitest";
import { compactCss, pageCss } from "./page.js";

/**
 * The style sheet is shipped compacted (page.ts compactCss). Compacting must change nothing a browser would see: a real CSS
 * parser (lightningcss, a development tool) reads the sheet before and after and must produce the same rules.
 */

// lightningcss keeps the raw tokens of a custom property and of `color-mix(...)`, blanks after commas included; a blank after a
// comma means nothing to a browser, so it is removed from both sides before comparing (no string of the sheet holds ", ").
const parsed = (css: string) =>
  Buffer.from(
    transform({ filename: "page.css", code: Buffer.from(css), minify: true, errorRecovery: false })
      .code,
  )
    .toString("utf8")
    .replace(/,\s+/g, ",");

describe("Feature: compacting the style sheet changes no rule", () => {
  it("Given the real sheet of the page, Then a CSS parser reads the compacted one exactly as the original", () => {
    const raw = pageCss();
    const small = compactCss(raw);
    expect(small.length).toBeLessThan(raw.length * 0.92);
    expect(parsed(small)).toBe(parsed(raw));
  });

  it("Given strings, comments and values with blanks, Then strings are kept byte for byte and no value is glued", () => {
    const css = `
      /* a comment with "a quote and { braces } */
      .a::before { content: "\\26A0\\00a0 two  spaces ; } , :"; width: calc(1px + 2px); margin: 0 auto  4px; }
      .a .b:hover > .c , .d { font-family: "Segoe UI", 'Mono', sans-serif; color: var(--x, #fff); }
      @media (max-width: 560px) and (min-width: 100px) { .e { padding: 1px 2px; } }
      [data-hidden="1"] { display: none !important; }
    `;
    const small = compactCss(css);
    expect(small).toContain('content:"\\26A0\\00a0 two  spaces ; } , :"');
    expect(small).toContain("calc(1px + 2px)");
    expect(small).toContain("margin:0 auto 4px");
    expect(small).toContain(".a .b:hover > .c,.d");
    expect(small).toContain("@media (max-width:560px) and (min-width:100px){");
    expect(small).toContain("font-family:\"Segoe UI\",'Mono',sans-serif");
    expect(small).toContain('[data-hidden="1"]{display:none !important}');
    expect(small).not.toContain("comment");
    expect(parsed(small)).toBe(parsed(css));
  });

  it("Given an unterminated comment or string, Then nothing throws", () => {
    expect(() => compactCss("a{b:c} /* open")).not.toThrow();
    expect(() => compactCss('a{content:"open}')).not.toThrow();
  });
});
