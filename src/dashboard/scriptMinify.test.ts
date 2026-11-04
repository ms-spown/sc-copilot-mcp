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

  it("Given a slash after a postfix ++ or --, Then it is a division (a regex there would swallow a line into a comment)", () => {
    for (const input of [
      "var i=1,z;i++ / 2; // n's\nz=1",
      "var i=1,z;i-- / 2; // n's\nz=1",
      "var i=1,z;z = i++ / 2 / 3; // it's\nz=1",
    ]) {
      expect(same(input, minifyScript(input))).toBe(true);
    }
  });

  it("Given a prefix ++, a spread before a keyword-named property, or a number before a name, Then each is read as JavaScript reads it", () => {
    for (const input of [
      "var o;++/a b/.lastIndex;",
      "var a=[1],b;b=[...a.in / 2 / 1]",
      "var a=[1],b=[2];b=[...a, ...b.of]",
      "var x=12. in{};",
      "var x=1_000 .toString();",
      "var x=[...0 .toString()];",
    ]) {
      expect(same(input, minifyScript(input))).toBe(true);
    }
  });

  it("Given a slash after a word, Then a keyword used as a property or a plain name divides, and an ambiguous word is refused", () => {
    for (const input of [
      "var w={of:4,in:2,new:1,do:3,typeof:5},y;y = w.of / 2; // n's\ny=w.in / 2 / 1;y=w.new / 2 / 1;y=w.do / 2 / 1;y=w.typeof / 2 / 1",
      "var w={a:4},y;y=w?.a / 2; // n's\ny=1",
      "var a=1,y;y = typeof /x y/.source",
    ]) {
      expect(same(input, minifyScript(input))).toBe(true);
    }
    for (const input of ["var of=4,y;y = of / 2; // n\ny=1", "async function f(){await /x/g}"]) {
      expect(() => minifyScript(input)).toThrow(/ambiguous/);
    }
  });

  it("Given a slash after a closing parenthesis or brace, Then it follows the statement that was closed", () => {
    for (const input of [
      "var a=1,b=2,c,d;c=(a) / b / 2; // n's\nd=1",
      "var a=1;if (a) /x y/.test('x y');",
      "var a=1;while (a--) /x y/.test('x y');",
      "var a=1;for (;a;) /x y/.test('x y'),a=0;",
      "var a=1;if (a) {}\n/x y/.test('x y')",
      "var a=1;function f() {}\n/x y/.test('x y')",
    ]) {
      expect(same(input, minifyScript(input))).toBe(true);
    }
  });

  it("Given tokens that would form an HTML-like comment, Then a space is kept between them", () => {
    for (const input of [
      "var a=3,b=2,x;x=a<! --b",
      "var a=3,b=2,x;x=a < ! --b",
      "var a=3,x;x=a<!(a--) /* c */ >a",
    ]) {
      const small = minifyScript(input);
      expect(small).not.toContain("<!--");
      expect(small).not.toContain("-->");
      expect(same(input, small)).toBe(true);
    }
    expect(minifyScript("x=a-- >b")).toBe("x=a-- >b");
  });

  it("Given input that holds an HTML-like comment or a hashbang, Then it is refused (it would swallow the rest of a line)", () => {
    for (const input of [
      "#!/usr/bin/env node\nx=1",
      "x=a<!--b\ny=2",
      "x=1;\n--> c\ny=2",
      "--> c\ny=2",
      "x=1;/*\n*/ --> c\ny=2",
    ]) {
      expect(() => minifyScript(input)).toThrow(/cannot be minified/);
    }
    // a `-->` that is not at the start of a line is an ordinary `--` and `>`
    expect(same("var a=1,b;b=a-->0", minifyScript("var a=1,b;b=a-->0"))).toBe(true);
  });

  it("Given the page's function boundaries, Then the shipped script keeps a line break there, so an error trace is readable", () => {
    const small = viewScript();
    expect(small.split("\n").length).toBeGreaterThan(150);
  });
});
