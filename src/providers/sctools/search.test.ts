import { describe, expect, it } from "vitest";
import { cleanSnippet } from "./search.js";

describe("cleanSnippet: no tag can survive or be rebuilt", () => {
  it.each([
    ["<scr<script>ipt>alert(1)</scr</script>ipt>", "iptalert(1)ipt"],
    ["<<script>script>alert(1)<</script>/script>", "scriptalert(1)/script"],
    ["a <script", "a script"],
    ["a <b unclosed text", "a b unclosed text"],
    ["x <img src=a onerror=b", "x img src=a onerror=b"],
    ["&lt;script&gt;alert(1)&lt;/script&gt;", "scriptalert(1)/script"],
    ["&#60;script&#62;x&#x3c;/script&#x3E;", "scriptx/script"],
    ["&amp;lt;script&amp;gt;", "&lt;script&gt;"],
    ['<span class="searchmatch">Wikelo</span> trades', "Wikelo trades"],
  ])("%j gives %j", (input, want) => {
    const out = cleanSnippet(input);
    expect(out).toBe(want);
    expect(out).not.toMatch(/[<>]/);
  });

  it("never returns a chevron for a pile of nested or broken markup", () => {
    const nasty = "<<<<<<<script>>>>>>>" + "<a<b<c>d>e>".repeat(50) + "&lt;&lt;&#60;<";
    expect(cleanSnippet(nasty)).not.toMatch(/[<>]/);
  });
});
