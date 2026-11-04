import { parse, tokenizer } from "acorn";
import { describe, expect, it } from "vitest";
import { dashboardHtml, rawViewScript, viewScript } from "./page.js";
import { minifyScript } from "./scriptMinify.js";

/**
 * The shipped script is the assembled one with its blanks removed (scriptMinify.ts). Removing blanks must change nothing a
 * JavaScript engine would see: a real parser (acorn, a development tool) reads the script before and after, and the two
 * must give the same token stream AND the same syntax tree, positions left out.
 */

const OPTIONS = { ecmaVersion: "latest", sourceType: "script" } as const;
const tree = (code: string): string =>
  JSON.stringify(parse(code, OPTIONS), (key, value: unknown) => {
    if (key === "start" || key === "end") return undefined;
    return typeof value === "bigint" ? `${value}n` : value;
  });
const tokens = (code: string): string[] => {
  const out: string[] = [];
  for (const t of tokenizer(code, OPTIONS)) {
    out.push(`${t.type.label}\u0000${String((t as { value?: unknown }).value)}`);
  }
  return out;
};
/** True when the two sources are the same program: same tokens, same tree. */
const same = (a: string, b: string): boolean =>
  JSON.stringify(tokens(a)) === JSON.stringify(tokens(b)) && tree(a) === tree(b);

describe("Feature: removing the blanks of the script changes no token and no node", () => {
  it("Given the real script of the page, Then a JavaScript parser reads the shipped one exactly as the assembled one", () => {
    const raw = rawViewScript();
    const small = viewScript();
    expect(small.length).toBeLessThan(raw.length * 0.9);
    const before = tokens(raw);
    const after = tokens(small);
    expect(after.length).toBe(before.length);
    expect(after).toEqual(before);
    expect(tree(small)).toBe(tree(raw));
  });

  it("Given the shipped page, Then it holds no more HTML comment opener or closer and no more script tag than a single one", () => {
    const html = dashboardHtml();
    expect(html).not.toContain("<!--");
    expect(html).not.toContain("-->");
    expect(html.match(/<script/gi)).toHaveLength(1);
    expect(html.match(/<\/script/gi)).toHaveLength(1);
    expect(viewScript()).not.toContain("\\\n");
  });

  it("Given tokens that would fuse, Then one blank is kept between them", () => {
    const cases: Array<[string, string]> = [
      ["a  in  b;", "a in b;"],
      ["typeof   x;", "typeof x;"],
      ["x = a  +  +b;", "x=a+ +b;"],
      ["x = a  -  -b;", "x=a- -b;"],
      ["x = a  ++  +  b;", "x=a++ +b;"],
      ["x = a  /  /re/.source;", "x=a/ /re/.source;"],
      ["x = 1 .toString();", "x=1 .toString();"],
      ["x = 1.5.toFixed(1);", "x=1.5.toFixed(1);"],
      ["x = a  <  !b;", "x=a< !b;"],
      ["x = a  <  /re/.source;", "x=a< /re/.source;"],
      ["x = a--  >  b;", "x=a-- >b;"],
      ["x = /x/  in  y;", "x=/x/ in y;"],
      ["var  a  =  1;  var  b;", "var a=1;var b;"],
    ];
    for (const [input, expected] of cases) {
      expect(minifyScript(input)).toBe(expected);
      expect(same(input, minifyScript(input))).toBe(true);
    }
  });

  it("Given a line break that carries a meaning, Then it stays", () => {
    const cases = [
      "function f() {\n  return\n  1;\n}",
      "function f() {\n  return\n}\nvar a = 1;",
      "var a = 1, b = 2;\na\n++b;",
      "for (;;) {\n  break\n  ;\n}",
    ];
    for (const input of cases) {
      const small = minifyScript(input);
      expect(small).toContain("\n");
      expect(same(input, small)).toBe(true);
    }
    expect(minifyScript("function f() {\n  return\n  1;\n}")).toBe("function f(){return\n1;}");
  });

  it("Given strings, templates, regular expressions and comments, Then the text of the first three is copied and the comments go", () => {
    const input = [
      "// a comment with 'a quote and a `tick",
      "var s = 'a  b // not a comment', t = \"c  /* nor this */  d\";",
      "var u = `x  ${ a  +  `inner  ${ {k: 1}.k }  tail` }   end\n   kept`;",
      "var r = /a\\/b[/]  c/g, d = a / b / c, e = typeof /x y/;",
      "var q = a /* in the middle */ + /* and again */ b;",
      "if (a) return_ = /=/.test(x);",
      "/* leading */ x = [1 , 2 , 3 ] ;",
    ].join("\n");
    const small = minifyScript(input);
    expect(small).toContain("'a  b // not a comment'");
    expect(small).toContain('"c  /* nor this */  d"');
    expect(small).toContain("`x  ${a+`inner  ${{k:1}.k}  tail`}   end\n   kept`");
    expect(small).toContain("/a\\/b[/]  c/g");
    expect(small).toContain("a/b/c");
    expect(small).toContain("typeof/x y/");
    expect(small).not.toContain("comment with");
    expect(small).not.toContain("in the middle");
    expect(same(input, small)).toBe(true);
  });

  it("Given an unterminated string, template or comment, Then nothing throws", () => {
    for (const input of ["x = 'open", "x = `open ${", "x = 1; /* open", "x = /open"]) {
      expect(() => minifyScript(input)).not.toThrow();
    }
  });
});
