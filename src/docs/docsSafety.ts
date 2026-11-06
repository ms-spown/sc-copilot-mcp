// Anti-injection check for the repository's text files (run by `npm run check:docs`, by the test
// suite and by CI). Pure logic: it receives file contents and returns findings, it touches no disk.
//
// Why it exists: the files Claude reads (the paste-in block of docs/USING_WITH_CLAUDE*.md, the tool
// descriptions in src/tools, the prompts, CLAUDE.md, the README) are an instruction channel. A
// contribution that hides text there (invisible characters, a comment, a look-alike word, a link to
// an unreviewed host) would be executed by the model of every user. This check cannot prove a text
// is harmless; it makes the usual hiding places fail loudly so that a human looks. What it does NOT
// detect (hostile text written in plain sight) is listed in CONTRIBUTING.md.
//
// Nothing in this file may contain an invisible or look-alike character: adversarial samples are
// built from code points in the tests (String.fromCodePoint), never typed. The check runs on itself,
// and there is no hidden exception: every exemption below is an exported constant with a reason.

import { posix } from "node:path";

export type Rule =
  | "invisible-char"
  | "carriage-return"
  | "homoglyph"
  | "binary-file"
  | "html-comment"
  | "html-tag"
  | "html-attribute"
  | "link-scheme"
  | "link-host"
  | "link-definition"
  | "link-title"
  | "link-path"
  | "mixed-script"
  | "code-script"
  | "package-script"
  | "claude-config"
  | "translation-orphan"
  | "translation-drift";

export interface Finding {
  file: string;
  line: number;
  rule: Rule;
  message: string;
}

export interface TrackedFile {
  path: string;
  bytes: Uint8Array;
}

export interface TextFile {
  path: string;
  text: string;
}

export interface CheckOptions {
  /**
   * Every path of the repository (images included). When given, a relative link must point to one of
   * them; without it only the syntax of a relative link is checked.
   */
  knownPaths?: Iterable<string>;
}

/**
 * Hosts a link or image in Markdown, a prompt, a tool description or a configuration file may point
 * to, whatever the path. Every entry was checked against the URLs actually present in the repository.
 * A pull request that needs another host must add it here, which puts the link in front of a human
 * reviewer (see CONTRIBUTING.md). Matching is exact: a subdomain is a different host. github.com is
 * not here on purpose: see ALLOWED_PATH_PREFIXES.
 */
export const ALLOWED_LINK_HOSTS: readonly string[] = [
  "chatgpt.com", // ChatGPT's connector settings (docs/CHATGPT.md, npm run chatgpt)
  "img.shields.io", // licence badge
  "keepachangelog.com", // CHANGELOG format reference
  "modelcontextprotocol.io", // the protocol this server speaks
  // The tunnel-client download (src/install/chatgptTunnel.ts: pinned URLs, size and SHA-256). Used by `npm run chatgpt -- setup`
  // only, never by the server, whose hosts are ALLOWED_API_HOSTS.
  "persistent.oaistatic.com",
  "platform.openai.com", // OpenAI Platform pages where the player creates the tunnel and its runtime key (docs/CHATGPT.md)
  "semver.org", // CHANGELOG versioning reference
  "star-citizen.wiki", // Star Citizen Wiki
  "starcitizen.tools", // Star Citizen Tools wiki
  "uexcorp.space", // UEX Corp (token page, "Powered by UEX")
];

/**
 * Hosts that are only allowed under a path prefix (lower-case comparison, whole path segments, an
 * optional ".git" after the repository name). The list comes from the URLs present in the repository;
 * each prefix is a project this repository credits or builds on, nothing else.
 */
export const ALLOWED_PATH_PREFIXES: Readonly<Record<string, readonly string[]>> = {
  "github.com": [
    "ms-spown/sc-copilot-mcp", // this repository: badge, issues, advisories, package metadata
    "voidput/SCMCP", // the upstream fork and its changelog commits
    "voidput/sc-gamedata-dumps", // the patch-dump repository (NOTICE)
    "KrovaxCode/SCMDB_DATA", // SCMDB data (README, NOTICE)
    "ShipBit/wingman-ai", // source of the telemetry schema (GPLv3, THIRD_PARTY.md)
    "modelcontextprotocol/ext-apps", // MCP Apps (docs/MCP_APP_SPIKE.md)
    "openai/tunnel-client", // OpenAI's Secure MCP Tunnel client, Apache-2.0 (docs/CHATGPT.md, THIRD_PARTY.md)
  ],
};

/**
 * Hosts the server itself talks to (src/core/http.ts ALLOWED_HOSTS). A test keeps this list a superset
 * of that one. Code under src/ that the model does not read (providers, core, install...) may contain
 * these in addition to the documentation hosts; prompts and tool descriptions may not.
 */
export const ALLOWED_API_HOSTS: readonly string[] = [
  "api.uexcorp.uk",
  "api.uexcorp.space",
  "api.star-citizen.wiki",
  "api.github.com",
  "raw.githubusercontent.com",
];

/**
 * The only HTML comments tolerated, as exact (file, text) pairs: any other comment, or any edit of
 * one of these, fails. HTML comments are invisible once rendered, which is what an injection needs.
 */
export const ALLOWED_HTML_COMMENTS: readonly { file: string; comment: string; reason: string }[] = [
  {
    file: ".github/PULL_REQUEST_TEMPLATE.md",
    comment:
      "<!-- What does this change, and what problem does it solve for a player or a maintainer? -->",
    reason: "GitHub pull request template: guidance shown to the author, not read by Claude.",
  },
  {
    file: ".github/PULL_REQUEST_TEMPLATE.md",
    comment: "<!-- Please keep the pull request small and focused. -->",
    reason: "GitHub pull request template: guidance shown to the author, not read by Claude.",
  },
  {
    file: "docs/TOOLS.md",
    comment: "<!-- Generated by `npm run docs:tools` from the code. Do not edit by hand. -->",
    reason: "Header written by the generator; toolDocs.test.ts compares the file byte for byte.",
  },
];

/**
 * Files allowed to contain letters of a non-Latin script (Japanese sample, a real translation...), as
 * (file, reason). Empty today: no tracked file needs it. Fullwidth, mathematical and other letters
 * that fold to a different form under NFKC stay refused even in these files.
 */
export const ALLOWED_NON_LATIN_FILES: readonly { file: string; reason: string }[] = [];

/**
 * Exact files that build a web page and may therefore hold HTML comments and tags, as (file, reason).
 * Empty today. Every other rule (links, characters, scripts) still applies to them.
 */
export const ALLOWED_HTML_MARKUP_FILES: readonly { file: string; reason: string }[] = [];

/**
 * The URI of the MCP App page this server serves (the `ui:` scheme is the one MCP Apps define for it). Only this
 * exact prefix is accepted: it names a resource of this server and is never fetched from a network.
 */
export const ALLOWED_UI_RESOURCE_PREFIX = "ui:" + "//sc-copilot/";

/**
 * XML namespace names that look like URLs but are identifiers: they are never fetched. Exact (file, name) pairs,
 * like the HTML comments above: any other file, or any other name, fails.
 */
export const ALLOWED_NAMESPACE_URIS: readonly { file: string; uri: string; reason: string }[] = [
  {
    file: "src/dashboard/viewApp.ts",
    uri: "http:" + "//www.w3.org/2000/svg",
    reason:
      "The SVG namespace, passed to createElementNS to draw the gauges. An identifier, not a link.",
  },
];

/** Binary files that are not scanned. Any other tracked file must be valid UTF-8 text. */
const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"]);

/** Extensions read as prose (Markdown rules): compared in lower case. */
const MARKDOWN_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdown",
  ".mkd",
  ".mkdn",
  ".mdwn",
  ".mdx",
  ".mdc",
  ".txt",
  ".rst",
  ".adoc",
  ".html",
  ".htm",
]);

/** Configuration formats: strings in them can reach a reader or the model. */
const CONFIG_EXTENSIONS = new Set([".yml", ".yaml", ".json", ".jsonc", ".json5", ".toml"]);

const SCRIPT_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
]);

const MAX_FINDINGS_PER_RULE_PER_FILE = 20;

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).toLowerCase();
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(path));
}

/** Tests and test helpers hold hostile samples on purpose. Character rules still apply to them. */
function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(lower) || /(^|\/)(testing|__tests__)\//.test(lower);
}

function isClaudePath(path: string): boolean {
  return path.startsWith(".claude/");
}

/**
 * Prompts, tool descriptions, provider strings, configuration files and `.claude/` are read by the
 * model or by a reader: same hiding places as Markdown, fewer rules. Test files are not sources.
 */
export function isInstructionSource(path: string): boolean {
  if (isTestPath(path)) return false;
  if (baseNameOf(path) === "package-lock.json") return false; // checked by checkLockfile
  if (isMarkdownPath(path)) return false; // checked as Markdown
  return path.startsWith("src/") || isClaudePath(path) || CONFIG_EXTENSIONS.has(extensionOf(path));
}

function allowsHtmlMarkup(path: string): boolean {
  return ALLOWED_HTML_MARKUP_FILES.some((s) => s.file === path);
}

/**
 * The API hosts accept any path, so they are only tolerated where the model does not read the text
 * (providers, core...). Prompts, tool descriptions and documents may only use the reviewed hosts.
 */
function hostsFor(path: string): readonly string[] {
  return path.startsWith("src/") && !isModelFacing(path)
    ? [...ALLOWED_LINK_HOSTS, ...ALLOWED_API_HOSTS]
    : ALLOWED_LINK_HOSTS;
}

function contextFor(path: string, known?: LinkContext["known"]): LinkContext {
  return {
    hosts: hostsFor(path),
    dir: directoryOf(path),
    // A host computed at run time (a template literal) is only tolerated outside model-facing text.
    dynamicHosts: path.startsWith("src/") && !isModelFacing(path),
    known,
  };
}

// ---------------------------------------------------------------------------------------------
// Rule (a): invisible, control and look-alike characters, in every tracked text file
// ---------------------------------------------------------------------------------------------

// Letters that render as blanks, which category tests do not catch.
const BLANK_LETTERS = new Map<number, string>([
  [0x034f, "combining grapheme joiner"],
  [0x115f, "Hangul choseong filler"],
  [0x1160, "Hangul jungseong filler"],
  [0x17b4, "Khmer inherent vowel (invisible)"],
  [0x17b5, "Khmer inherent vowel (invisible)"],
  [0x2800, "braille blank"],
  [0x3164, "Hangul filler"],
  [0xffa0, "halfwidth Hangul filler"],
]);

const SUSPECT_CATEGORY = /^[\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Cc}\p{Zl}\p{Zp}\p{Variation_Selector}]$/u;

function hex(cp: number): string {
  return "U+" + cp.toString(16).toUpperCase().padStart(4, "0");
}

/** Why a code point is refused, or null when it is fine. `atStart` allows a leading BOM. */
function describeForbidden(cp: number, atStart: boolean): string | null {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return null; // a lone CR is checked apart
  if (cp === 0xfeff) return atStart ? null : "byte order mark in the middle of a file";
  if (cp >= 0xe0000 && cp <= 0xe007f) return "Unicode tag character (invisible text)";
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
    return "bidirectional control character";
  }
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return "control character";
  const blank = BLANK_LETTERS.get(cp);
  if (blank) return blank;
  if (cp < 0xa0) return null; // printable ASCII, fast path
  if (!SUSPECT_CATEGORY.test(String.fromCodePoint(cp))) return null;
  if (cp === 0x2028 || cp === 0x2029) return "line or paragraph separator";
  if (
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef) ||
    (cp >= 0x180b && cp <= 0x180f)
  ) {
    return "variation selector";
  }
  if (cp >= 0xd800 && cp <= 0xdfff) return "lone surrogate";
  if (cp >= 0xe000 && cp <= 0xf8ff) return "private-use character";
  return "invisible or unassigned character (format or unassigned category)";
}

/** Compatibility forms that are harmless in prose and may stay (code point, why). */
const NFKC_ALLOWED = new Map<number, string>([[0x2026, "horizontal ellipsis"]]);

/** Punctuation that looks like a character of a URL without folding to it under NFKC. */
const URL_LOOKALIKES = new Map<number, string>([
  [0x2044, "fraction slash (looks like /)"],
  [0x2215, "division slash (looks like /)"],
  [0x29f8, "big solidus (looks like /)"],
  [0x2236, "ratio (looks like :)"],
]);

/** Blocks of Latin-script letters made to imitate other Latin letters (IPA, small capitals...). */
const LATIN_LOOKALIKE_BLOCKS: readonly (readonly [number, number])[] = [
  [0x0250, 0x02af], // IPA extensions
  [0x1d00, 0x1dbf], // phonetic extensions
  [0x2c60, 0x2c7f], // Latin Extended-C
  [0xa720, 0xa7ff], // Latin Extended-D
  [0xab30, 0xab6f], // Latin Extended-E
];

const LATIN_OR_NEUTRAL = /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]$/u;
const SCRIPT_NAMES = [
  "Cyrillic",
  "Greek",
  "Armenian",
  "Cherokee",
  "Coptic",
  "Georgian",
  "Hebrew",
  "Arabic",
  "Thai",
  "Devanagari",
  "Han",
  "Hiragana",
  "Katakana",
  "Hangul",
];

function scriptNameOf(ch: string): string {
  const found = SCRIPT_NAMES.find((s) => new RegExp(`^\\p{Script=${s}}$`, "u").test(ch));
  return found ?? "non-Latin";
}

/** Why a printable non-ASCII character is a look-alike risk, or null. */
function describeHomoglyph(ch: string, cp: number, allowNonLatin: boolean): string | null {
  if (cp < 0x80 || NFKC_ALLOWED.has(cp)) return null;
  const folded = ch.normalize("NFKC");
  if (folded !== ch) {
    const shown = /^[\p{L}\p{N}\p{P}\p{S}]+$/u.test(folded) ? `"${folded}"` : "a space or control";
    return `compatibility form of ${shown} (NFKC): write the plain character.`;
  }
  const lookalike = URL_LOOKALIKES.get(cp);
  if (lookalike) return `${lookalike}: write the plain character.`;
  if (/^\p{L}$/u.test(ch)) {
    if (!LATIN_OR_NEUTRAL.test(ch)) {
      return allowNonLatin
        ? null
        : `${scriptNameOf(ch)} letter: letters outside the Latin script can imitate Latin ones. ` +
            "Build such samples from code points in tests.";
    }
    if (LATIN_LOOKALIKE_BLOCKS.some(([lo, hi]) => cp >= lo && cp <= hi)) {
      return "Latin letter from a block of look-alikes (IPA, small capitals...).";
    }
  } else if (/^\p{Nd}$/u.test(ch)) {
    return "non-ASCII digit.";
  }
  return null;
}

export function checkInvisibleCharacters(
  file: TextFile,
  nonLatinFiles: readonly { file: string }[] = ALLOWED_NON_LATIN_FILES,
): Finding[] {
  const findings: Finding[] = [];
  const allowNonLatin = nonLatinFiles.some((f) => f.file === file.path);
  const push = (line: number, rule: Rule, message: string) => {
    if (findings.length < MAX_FINDINGS_PER_RULE_PER_FILE) {
      findings.push({ file: file.path, line, rule, message });
    }
  };
  let line = 1;
  let index = 0;
  for (const ch of file.text) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x0a) {
      line++;
    } else if (cp === 0x0d) {
      if (file.text.charCodeAt(index + 1) !== 0x0a) {
        push(
          line,
          "carriage-return",
          `${hex(cp)}: carriage return without line feed. It hides the start of the line in a terminal; use LF or CRLF.`,
        );
      }
    } else {
      const why = describeForbidden(cp, index === 0);
      if (why) {
        push(
          line,
          "invisible-char",
          `${hex(cp)}: ${why}. Remove it (the text must be readable as it is).`,
        );
      } else {
        const alike = describeHomoglyph(ch, cp, allowNonLatin);
        if (alike) push(line, "homoglyph", `${hex(cp)}: ${alike}`);
      }
    }
    index += ch.length;
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Helpers shared by the Markdown and instruction-source rules
// ---------------------------------------------------------------------------------------------

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 0x0a) line++;
  return line;
}

type Script = "Latin" | "Cyrillic" | "Greek";

function scriptOf(ch: string): Script | null {
  if (/^\p{Script=Latin}$/u.test(ch)) return "Latin";
  if (/^\p{Script=Cyrillic}$/u.test(ch)) return "Cyrillic";
  if (/^\p{Script=Greek}$/u.test(ch)) return "Greek";
  return null;
}

/** Words that mix Latin letters with Cyrillic or Greek ones: the classic look-alike substitution. */
function findMixedScriptWords(text: string): { word: string; index: number }[] {
  const out: { word: string; index: number }[] = [];
  for (const m of text.matchAll(/[\p{L}\p{M}]+/gu)) {
    const word = m[0];
    if (!/[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(word)) continue;
    const scripts = new Set<Script>();
    for (const ch of word) {
      const s = scriptOf(ch);
      if (s) scripts.add(s);
    }
    if (scripts.size > 1) out.push({ word, index: m.index as number });
  }
  return out;
}

function describeWord(word: string): string {
  const odd = [...word].find((ch) => {
    const s = scriptOf(ch);
    return s === "Cyrillic" || s === "Greek";
  });
  return `"${word}" mixes scripts (${odd ? hex(odd.codePointAt(0) as number) : "?"} is not Latin)`;
}

const FORBIDDEN_TAG =
  /<\/?(script|iframe|object|embed|style|form|input|meta|link|base|svg)(?![a-z0-9-])/gi;

function checkTags(file: TextFile): Finding[] {
  const findings: Finding[] = [];
  for (const m of file.text.matchAll(FORBIDDEN_TAG)) {
    findings.push({
      file: file.path,
      line: lineAt(file.text, m.index as number),
      rule: "html-tag",
      message: `active HTML tag "${m[0]}" is not allowed.`,
    });
  }
  return findings;
}

function checkComments(file: TextFile): Finding[] {
  const allowed = new Set(
    ALLOWED_HTML_COMMENTS.filter((c) => c.file === file.path).map((c) => c.comment),
  );
  const findings: Finding[] = [];
  for (const m of file.text.matchAll(/<!--[\s\S]*?-->|<[!?][^>]*>?/g)) {
    if (allowed.has(m[0])) continue;
    findings.push({
      file: file.path,
      line: lineAt(file.text, m.index as number),
      rule: "html-comment",
      message:
        "HTML comment or declaration: invisible once rendered, so not allowed. " +
        "Write the text where readers can see it, or remove it.",
    });
  }
  return findings;
}

function checkMixedScripts(file: TextFile): Finding[] {
  return findMixedScriptWords(file.text).map((w) => ({
    file: file.path,
    line: lineAt(file.text, w.index),
    rule: "mixed-script" as const,
    message: describeWord(w.word),
  }));
}

// ---------------------------------------------------------------------------------------------
// Rule (c): links and images
// ---------------------------------------------------------------------------------------------

interface LinkContext {
  hosts: readonly string[];
  dynamicHosts: boolean;
  /** Directory of the file, "" for the root. */
  dir: string;
  known?: { files: ReadonlySet<string>; dirs: ReadonlySet<string> };
}

type TargetKind = "inline" | "definition" | "autolink" | "attribute";

const DANGEROUS_SCHEMES = new Set(["javascript", "data", "vbscript"]);

// Written in two pieces so that this file does not hold a literal URL of its own.
const HTTPS_PREFIX = "https:" + "//";

function stripBlanksAndControls(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp > 0x20 && !(cp >= 0x7f && cp <= 0x9f)) out += ch;
  }
  return out;
}

/** Destinations written as Markdown links, reference definitions, autolinks or HTML attributes. */
function linkTargets(text: string): { target: string; index: number; kind: TargetKind }[] {
  const out: { target: string; index: number; kind: TargetKind }[] = [];
  const add = (target: string | undefined, index: number, kind: TargetKind) => {
    if (target !== undefined) out.push({ target, index, kind });
  };
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]*)/g)) add(m[1], m.index as number, "inline");
  for (const m of text.matchAll(/<([a-z][a-z0-9+.-]*:[^\s<>]*)>/gi)) {
    add(m[1], m.index as number, "autolink");
  }
  for (const m of text.matchAll(/<([^\s<>@:]+@[^\s<>@]+)>/g)) {
    add("mailto:" + m[1], m.index as number, "autolink"); // e-mail autolink
  }
  const attr =
    /\b(srcset|href|src|xlink:href|action|formaction|poster|data|background|cite|longdesc|ping|archive|codebase)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
  for (const m of text.matchAll(attr)) {
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (m[1].toLowerCase() === "srcset") {
      for (const candidate of value.split(","))
        add(candidate.trim().split(/\s+/)[0], m.index as number, "attribute");
    } else {
      add(value, m.index as number, "attribute");
    }
  }
  return out;
}

/** The authority of a URL with every `${...}` placeholder of a template literal removed. */
function isDynamicHost(raw: string): boolean {
  const authority = /^[a-z][a-z0-9+.-]*:[\\/]+([^\\/?#]*)/i.exec(raw)?.[1] ?? "";
  if (!authority.includes("${")) return false;
  const rest = authority.replace(/\$\{[^}]*\}/g, "");
  return rest === "" || rest === ":";
}

/** Why an absolute URL is refused, or null. Hosts are compared in lower case. */
function urlProblem(raw: string, ctx: LinkContext): string | null {
  const hosts = ctx.hosts;
  if (isDynamicHost(raw)) {
    return ctx.dynamicHosts ? null : `"${raw}" builds its host at run time: write the host out.`;
  }
  const authority = /^[a-z][a-z0-9+.-]*:[\\/]+([^\\/?#]*)/i.exec(raw)?.[1] ?? "";
  if (authority.includes("@")) {
    return `"${raw}" carries credentials or a decoy before the real host`;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.replace(/\\/g, "/"));
  } catch {
    return `"${raw}" is not a valid URL`;
  }
  if (parsed.username || parsed.password) {
    return `"${raw}" carries credentials or a decoy before the real host (${parsed.hostname})`;
  }
  if (parsed.protocol !== "https:") return `"${raw}" must use https`;
  if (/:\d*$/.test(authority)) return `"${raw}" names a port; links use the default one`;
  const host = parsed.hostname.toLowerCase();
  if (host.split(".").some((label) => label.startsWith("xn--"))) {
    return `host "${host}" is an internationalised (punycode) name, which can imitate another host`;
  }
  const prefixes = ALLOWED_PATH_PREFIXES[host];
  if (prefixes) {
    const path = parsed.pathname.replace(/^\/+/, "").toLowerCase();
    if (/%2f|%5c/i.test(parsed.pathname)) return `"${raw}" hides a slash in its path`;
    const ok = prefixes.some((p) => {
      const prefix = p.toLowerCase();
      return path === prefix || path === prefix + ".git" || path.startsWith(prefix + "/");
    });
    if (ok) return null;
    return (
      `"${raw}" is under no reviewed prefix of ${host} (ALLOWED_PATH_PREFIXES in ` +
      "src/docs/docsSafety.ts). A new project needs a maintainer's review: justify the link in the " +
      "pull request, then add the prefix there."
    );
  }
  if (!hosts.includes(host)) {
    return (
      `host "${host}" is not in ALLOWED_LINK_HOSTS (src/docs/docsSafety.ts). A new link host ` +
      "needs a maintainer's review: justify the link in the pull request, then add the host there."
    );
  }
  return null;
}

/** Why a relative target is refused, or null (anchor, query and fragment aside). */
function relativeProblem(cleaned: string, kind: TargetKind, ctx: LinkContext): string | null {
  if (cleaned === "") {
    return kind === "definition"
      ? "an empty link target: a definition like this is a hidden comment, not a link."
      : null;
  }
  if (cleaned.startsWith("#")) {
    return kind === "definition"
      ? `the target "${cleaned}" is not a link: a definition like this is a hidden comment.`
      : null;
  }
  let rel = cleaned.replace(/[?#][\s\S]*$/, "");
  if (rel === "") return `the target "${cleaned}" has no path.`;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    return `the target "${cleaned}" is not valid percent-encoding.`;
  }
  const joined = rel.startsWith("/") ? rel.slice(1) : ctx.dir ? `${ctx.dir}/${rel}` : rel;
  const normal = posix.normalize(joined).replace(/\/+$/, "");
  if (normal === ".." || normal.startsWith("../")) {
    return `the target "${cleaned}" leaves the repository.`;
  }
  const path = normal === "." ? "" : normal;
  if (ctx.known && path !== "" && !ctx.known.files.has(path) && !ctx.known.dirs.has(path)) {
    return `the target "${cleaned}" is neither a reviewed URL nor a file of this repository.`;
  }
  return null;
}

/**
 * Blanks the content of inline code spans written on one line, so that `[x](url "text")` shown as an
 * example is not read as a link. A span never crosses a line: a backtick left open must not hide the
 * paragraphs below it, which GitHub renders.
 */
function maskInlineCode(text: string): string {
  return text.replace(/(?<![`\\])(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g, (s) =>
    s.replace(/[^\n]/g, " "),
  );
}

function checkLinks(
  file: TextFile,
  ctx: LinkContext,
  markdown: boolean,
  withTargets = true,
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const report = (rule: Rule, index: number, message: string) => {
    const line = lineAt(file.text, index);
    const key = `${line}|${rule}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file: file.path, line, rule, message });
  };

  const scanned = markdown ? maskInlineCode(file.text) : file.text;
  for (const { target, index, kind } of withTargets ? linkTargets(scanned) : []) {
    const cleaned = stripBlanksAndControls(target).replace(/\\/g, "/");
    if (/&#?[a-z0-9]+;/i.test(cleaned)) {
      report("link-scheme", index, `link target "${target}" contains a character reference.`);
      continue;
    }
    const scheme = /^([a-z][a-z0-9+.-]+):/i.exec(cleaned)?.[1]?.toLowerCase();
    if (scheme && DANGEROUS_SCHEMES.has(scheme)) {
      report("link-scheme", index, `link scheme "${scheme}:" is not allowed.`);
    } else if (scheme && scheme !== "https" && scheme !== "http") {
      report("link-scheme", index, `link scheme "${scheme}:" is not allowed (https links only).`);
    } else if (scheme) {
      const problem = urlProblem(cleaned, ctx);
      if (problem) report("link-host", index, problem);
    } else if (cleaned.startsWith("//")) {
      const problem = urlProblem("https:" + cleaned, ctx);
      if (problem) report("link-host", index, problem);
    } else if (markdown) {
      const problem = relativeProblem(cleaned, kind, ctx);
      if (problem) report("link-path", index, `link ${problem}`);
    }
  }

  // Every absolute URL, linked or not (GitHub links bare URLs by itself).
  for (const m of file.text.matchAll(/https?:[\\/]+[^\s<>"'`)\]\\]*/gi)) {
    const url = m[0].replace(/[.,;:!?*]+$/, "").replace(/\\/g, "/");
    if (ALLOWED_NAMESPACE_URIS.some((n) => n.file === file.path && n.uri === url)) continue;
    const problem = urlProblem(url, ctx);
    if (problem) report("link-host", m.index as number, problem);
  }
  // GitHub also links a bare "www." address.
  for (const m of file.text.matchAll(
    /(?<![\w./@-])www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'`)\]\\]*/gi,
  )) {
    const problem = urlProblem(HTTPS_PREFIX + m[0].replace(/[.,;:!?*]+$/, ""), ctx);
    if (problem) report("link-host", m.index as number, `bare address: ${problem}`);
  }
  // Any other scheme followed by two slashes (ftp, ws, file, ssh...).
  for (const m of file.text.matchAll(/(?<![\w+.-])([a-z][a-z0-9+.-]*):\/\//gi)) {
    const scheme = m[1].toLowerCase();
    if (scheme === "ui" && file.text.startsWith(ALLOWED_UI_RESOURCE_PREFIX, m.index as number)) {
      continue;
    }
    if (scheme !== "https" && scheme !== "http" && !scheme.endsWith("+https")) {
      report(
        "link-scheme",
        m.index as number,
        `URL scheme "${scheme}" is not allowed (https links only).`,
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Markdown structure: fenced blocks, inline code, link definitions and titles
// ---------------------------------------------------------------------------------------------

interface FencedBlock {
  content: string;
  startLine: number; // line of the first content line
}

/** Splits a Markdown text into fenced blocks and the rest (fences blanked so line numbers hold). */
function splitFences(text: string): { prose: string; fences: FencedBlock[] } {
  const lines = text.split("\n");
  const fences: FencedBlock[] = [];
  const prose: string[] = [];
  let open: { char: string; len: number; start: number; body: string[] } | null = null;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (open) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === open.char && close[1].length >= open.len) {
        fences.push({ content: open.body.join("\n"), startLine: open.start });
        open = null;
      } else {
        open.body.push(line);
      }
      prose.push("");
      return;
    }
    const start = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (start && !(start[1][0] === "`" && start[2].includes("`"))) {
      open = { char: start[1][0], len: start[1].length, start: i + 2, body: [] };
      prose.push("");
      return;
    }
    prose.push(raw);
  });
  if (open) {
    const unclosed: { start: number; body: string[] } = open;
    fences.push({ content: unclosed.body.join("\n"), startLine: unclosed.start });
  }
  return { prose: prose.join("\n"), fences };
}

function inlineCodeSpans(prose: string): { code: string; index: number }[] {
  const out: { code: string; index: number }[] = [];
  for (const m of prose.matchAll(/(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g)) {
    out.push({ code: m[2].replace(/^ (.*) $/s, "$1").trim(), index: m.index as number });
  }
  return out;
}

function checkCodeScripts(file: TextFile, prose: string, fences: FencedBlock[]): Finding[] {
  const findings: Finding[] = [];
  const odd = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;
  for (const span of inlineCodeSpans(prose)) {
    if (odd.test(span.code)) {
      findings.push({
        file: file.path,
        line: lineAt(prose, span.index),
        rule: "code-script",
        message: `code span "${span.code}" contains a Cyrillic or Greek letter (look-alike identifier).`,
      });
    }
  }
  for (const f of fences) {
    f.content.split("\n").forEach((l, i) => {
      if (odd.test(l)) {
        findings.push({
          file: file.path,
          line: f.startLine + i,
          rule: "code-script",
          message: "code block line contains a Cyrillic or Greek letter (look-alike identifier).",
        });
      }
    });
  }
  return findings;
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Link reference definitions (`[label]: target "title"`) render as nothing, which makes them the
 * standard way to write a Markdown comment. They must be used, point to a visible target and carry
 * no title. Inline titles (`[x](url "title")`) are hidden text too.
 */
function checkDefinitionsAndTitles(file: TextFile, rawProse: string, ctx: LinkContext): Finding[] {
  const prose = maskInlineCode(rawProse);
  const findings: Finding[] = [];
  const add = (rule: Rule, index: number, message: string) =>
    findings.push({ file: file.path, line: lineAt(prose, index), rule, message });

  const definition =
    /^[ \t>*+-]*\[((?:[^\]\\\n]|\\.)+)\]:[ \t]*\n?[ \t]*(<[^>\n]*>|[^\s]*)([^\n]*(?:\n[ \t]*(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?)/gm;
  const definedAt = new Set<number>();
  const defined: { label: string; index: number }[] = [];
  for (const m of prose.matchAll(definition)) {
    const labelIndex = (m.index as number) + m[0].indexOf("[");
    definedAt.add(labelIndex);
    defined.push({ label: normalizeLabel(m[1]), index: m.index as number });
    const rawTarget = m[2].replace(/^<|>$/g, "");
    const cleaned = stripBlanksAndControls(rawTarget).replace(/\\/g, "/");
    if (/^[a-z][a-z0-9+.-]+:/i.test(cleaned) || cleaned.startsWith("//")) {
      // Scheme and host are judged by checkLinks on the whole text.
    } else {
      const problem = relativeProblem(cleaned, "definition", ctx);
      if (problem)
        add("link-definition", m.index as number, `link definition [${m[1]}]: ${problem}`);
    }
    if (m[3].trim() !== "") {
      add(
        "link-title",
        m.index as number,
        `link definition [${m[1]}] has a title: it is invisible once rendered. Remove it.`,
      );
    }
  }

  const used = new Set<string>();
  for (const m of prose.matchAll(/\[((?:[^[\]\\]|\\.)+)\](?:\[((?:[^[\]\\]|\\.)*)\])?/g)) {
    if (definedAt.has(m.index as number)) continue;
    used.add(normalizeLabel(m[2] !== undefined && m[2] !== "" ? m[2] : m[1]));
  }
  for (const d of defined) {
    if (!used.has(d.label)) {
      add(
        "link-definition",
        d.index,
        `link definition [${d.label}] is never used: it is invisible once rendered. Remove it.`,
      );
    }
  }

  for (const m of prose.matchAll(/\]\(\s*(?:<[^>\n]*>|[^)\s]*)([^)]*)\)/g)) {
    if (m[1].trim() !== "") {
      add(
        "link-title",
        m.index as number,
        "link with a title or extra text after its target: it is hidden once rendered.",
      );
    }
  }
  return findings;
}

/** GitHub turns a bare e-mail address and a bare mailto: into a link. */
function checkBareAddresses(file: TextFile, prose: string): Finding[] {
  const findings: Finding[] = [];
  for (const m of maskInlineCode(prose).matchAll(
    /(?<![\w.+-])[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+|\b(?:mailto|xmpp):[^\s<>]+/gi,
  )) {
    findings.push({
      file: file.path,
      line: lineAt(prose, m.index as number),
      rule: "link-scheme",
      message: `"${m[0]}" is turned into a mailto: or xmpp: link by GitHub. Put it in a code span.`,
    });
  }
  return findings;
}

function cannotHideWithAttributes(file: TextFile): Finding[] {
  const findings: Finding[] = [];
  for (const tag of file.text.matchAll(/<[a-zA-Z][^<>]*>/g)) {
    if (/[\s/"']on[a-z]+\s*=/i.test(tag[0])) {
      findings.push({
        file: file.path,
        line: lineAt(file.text, tag.index as number),
        rule: "html-attribute",
        message: `event-handler attribute in "${tag[0].slice(0, 60)}" is not allowed.`,
      });
    } else if (/[\s"']style\s*=|[\s"']hidden(?=[\s=>/])/i.test(tag[0])) {
      findings.push({
        file: file.path,
        line: lineAt(file.text, tag.index as number),
        rule: "html-attribute",
        message: `style or hidden attribute in "${tag[0].slice(0, 60)}" can hide text.`,
      });
    }
  }
  return findings;
}

/** Rule (b) and (c) for a Markdown file. */
export function checkMarkdown(file: TextFile, ctx?: LinkContext): Finding[] {
  const context = ctx ?? contextFor(file.path);
  const { prose, fences } = splitFences(file.text);
  const findings: Finding[] = [
    ...checkComments(file),
    ...checkTags(file),
    ...cannotHideWithAttributes(file),
    ...checkMixedScripts(file),
    ...checkCodeScripts(file, prose, fences),
    ...checkLinks(file, context, true),
    ...checkDefinitionsAndTitles(file, prose, context),
    ...checkBareAddresses(file, prose),
  ];
  return findings;
}

/**
 * Sources whose strings are shown to the model as instructions: prompts, the server instructions, tool definitions, and every
 * file outside src/ (configuration, `.claude/`). The rest of src/ (providers, core, install...) gets
 * the link-host, scheme, look-alike and invisible-character rules only: it legitimately handles HTML
 * and parses text that looks like markup.
 */
function isModelFacing(path: string): boolean {
  return (
    path === "src/prompts.ts" ||
    path === "src/instructions.ts" ||
    path.startsWith("src/tools/") ||
    !path.startsWith("src/")
  );
}

export function checkInstructionSource(file: TextFile, ctx?: LinkContext): Finding[] {
  const context = ctx ?? contextFor(file.path);
  const facing = isModelFacing(file.path);
  const findings: Finding[] = [
    ...checkLinks(file, context, false, facing),
    ...checkMixedScripts(file),
  ];
  if (facing && !allowsHtmlMarkup(file.path))
    findings.push(...checkComments(file), ...checkTags(file));
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Dependencies, scripts and Claude Code configuration
// ---------------------------------------------------------------------------------------------

const NPM_REGISTRY_HOST = "registry.npmjs.org";

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isNpmRegistryUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" && url.host === NPM_REGISTRY_HOST && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

/** The lock file is not read by anyone; what matters is where it makes npm download from. */
export function checkLockfile(file: TextFile): Finding[] {
  const findings: Finding[] = [];
  for (const m of file.text.matchAll(/"resolved"\s*:\s*"([^"]*)"/g)) {
    if (!isNpmRegistryUrl(m[1])) {
      findings.push({
        file: file.path,
        line: lineAt(file.text, m.index as number),
        rule: "link-host",
        message: `lock file entry resolves to "${m[1]}", not to the ${NPM_REGISTRY_HOST} registry over https. Have a maintainer review it.`,
      });
    }
  }
  return findings;
}

const NETWORK_COMMAND =
  /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|nc|ncat|netcat|telnet|certutil|bitsadmin|scp|sftp|ftp)\b|https?:|(?<![\w.-])https?(?![\w.-])/i;

const LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishonly",
  "publish",
  "postpublish",
  "prepack",
  "postpack",
  "preversion",
  "version",
  "postversion",
]);

/** `scripts` of a package.json run commands on a developer's machine and in CI. */
export function checkPackageScripts(file: TextFile): Finding[] {
  let parsed: { scripts?: Record<string, unknown> };
  try {
    parsed = JSON.parse(stripBom(file.text)) as { scripts?: Record<string, unknown> };
  } catch {
    return [
      {
        file: file.path,
        line: 1,
        rule: "package-script",
        message: "package.json is not valid JSON.",
      },
    ];
  }
  const scripts = parsed.scripts ?? {};
  const names = new Set(Object.keys(scripts).map((n) => n.toLowerCase()));
  const findings: Finding[] = [];
  for (const [name, value] of Object.entries(scripts)) {
    const line = lineAt(file.text, Math.max(0, file.text.indexOf(`"${name}"`)));
    const lower = name.toLowerCase();
    const wraps = /^(pre|post)(.+)$/.exec(lower);
    if (LIFECYCLE_SCRIPTS.has(lower) || (wraps && names.has(wraps[2]))) {
      findings.push({
        file: file.path,
        line,
        rule: "package-script",
        message: `script "${name}" runs by itself (npm lifecycle). Have a maintainer review it.`,
      });
    }
    if (typeof value === "string" && NETWORK_COMMAND.test(value)) {
      findings.push({
        file: file.path,
        line,
        rule: "package-script",
        message: `script "${name}" contains a URL or a network command. Have a maintainer review it.`,
      });
    }
  }
  return findings;
}

const CLAUDE_CONFIG_KEYS =
  /"(hooks|mcpServers|apiKeyHelper|enableAllProjectMcpServers|statusLine|env|awsAuthRefresh|awsCredentialExport|ANTHROPIC_[A-Z_]+)"\s*:/;

/** `.claude/` holds hooks, settings and commands: executed or obeyed by Claude Code. */
export function checkClaudeFolder(file: TextFile): Finding[] {
  const findings: Finding[] = [];
  const at = (line: number, message: string) =>
    findings.push({ file: file.path, line, rule: "claude-config", message });
  const ext = extensionOf(file.path);
  if (SCRIPT_EXTENSIONS.has(ext))
    at(1, "an executable script under .claude/ (a hook?) needs a maintainer's review.");
  const key = CLAUDE_CONFIG_KEYS.exec(file.text);
  if (key) {
    at(
      lineAt(file.text, key.index),
      `Claude Code setting "${key[1]}" (hooks, servers, environment) needs a maintainer's review.`,
    );
  }
  file.text.split("\n").forEach((l, i) => {
    if (NETWORK_COMMAND.test(l))
      at(i + 1, "a URL or a network command under .claude/ needs a maintainer's review.");
  });
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Rule (d): translations keep every identifier of the original
// ---------------------------------------------------------------------------------------------

const TRANSLATION_PATH = /^(.*)\.([a-z]{2}(?:-[a-z]{2})?)(\.[a-z]+)$/i;
const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const UPPER_SNAKE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g;
const ABSOLUTE_URL = /https?:\/\/[^\s<>"'`)\]\\]+/g;

function matches(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[0].replace(/[.,;:!?*]+$/, ""));
}

interface Identifiers {
  spans: Set<string>; // inline code outside fenced blocks
  urls: Set<string>;
  variables: Set<string>; // UPPER_SNAKE names, anywhere
  blockIds: Set<string>; // snake_case names, spans, variables and URLs inside fenced blocks
}

function identifiersOf(text: string): Identifiers {
  const { prose, fences } = splitFences(text);
  const blockText = fences.map((f) => f.content).join("\n");
  const blockSpans = inlineCodeSpans(blockText).map((s) => s.code);
  return {
    spans: new Set(inlineCodeSpans(prose).map((s) => s.code)),
    urls: new Set(matches(text, ABSOLUTE_URL)),
    variables: new Set(matches(text, UPPER_SNAKE)),
    blockIds: new Set([
      ...matches(blockText, SNAKE_CASE),
      ...matches(blockText, UPPER_SNAKE),
      ...matches(blockText, ABSOLUTE_URL),
      ...blockSpans,
    ]),
  };
}

function difference(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !b.has(x)).sort();
}

function listed(items: string[]): string {
  return items.map((i) => `"${i}"`).join(", ");
}

export function checkTranslations(files: TextFile[]): Finding[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const findings: Finding[] = [];
  for (const file of files) {
    const parts = TRANSLATION_PATH.exec(file.path);
    if (!parts || !isMarkdownPath(file.path)) continue;
    const original = byPath.get(`${parts[1]}${parts[3]}`);
    if (!original) {
      findings.push({
        file: file.path,
        line: 1,
        rule: "translation-orphan",
        message: `translation without its original ${parts[1]}${parts[3]}.`,
      });
      continue;
    }
    const en = identifiersOf(original.text);
    const tr = identifiersOf(file.text);
    const problems: string[] = [];
    for (const [label, a, b] of [
      ["code spans", en.spans, tr.spans],
      ["URLs", en.urls, tr.urls],
      ["UPPER_CASE variable names", en.variables, tr.variables],
    ] as const) {
      const missing = difference(a, b);
      const added = difference(b, a);
      if (missing.length)
        problems.push(`${label} missing from the translation: ${listed(missing)}`);
      if (added.length) problems.push(`${label} not in the original: ${listed(added)}`);
    }
    const addedInBlocks = difference(tr.blockIds, en.blockIds);
    if (addedInBlocks.length) {
      problems.push(`identifiers in code blocks not in the original: ${listed(addedInBlocks)}`);
    }
    for (const p of problems) {
      findings.push({
        file: file.path,
        line: 1,
        rule: "translation-drift",
        message: `${p} (compare with ${original.path}; identifiers must be copied unchanged).`,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

function knownFrom(paths: Iterable<string>): NonNullable<LinkContext["known"]> {
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const p of paths) {
    files.add(p);
    for (let d = directoryOf(p); d !== ""; d = directoryOf(d)) dirs.add(d);
  }
  return { files, dirs };
}

/** All rules on already decoded text files. */
export function checkTexts(files: TextFile[], options: CheckOptions = {}): Finding[] {
  const known = options.knownPaths ? knownFrom(options.knownPaths) : undefined;
  const findings: Finding[] = [];
  for (const file of files) {
    findings.push(...checkInvisibleCharacters(file));
    const ctx = contextFor(file.path, known);
    if (baseNameOf(file.path) === "package-lock.json") findings.push(...checkLockfile(file));
    else if (isMarkdownPath(file.path)) findings.push(...checkMarkdown(file, ctx));
    else if (isInstructionSource(file.path)) findings.push(...checkInstructionSource(file, ctx));
    if (baseNameOf(file.path) === "package.json") findings.push(...checkPackageScripts(file));
    if (isClaudePath(file.path)) findings.push(...checkClaudeFolder(file));
  }
  findings.push(...checkTranslations(files.filter((f) => isMarkdownPath(f.path))));
  return findings;
}

/** All rules on raw tracked files (what `git ls-files` lists). */
export function checkTrackedFiles(files: TrackedFile[]): Finding[] {
  const texts: TextFile[] = [];
  const findings: Finding[] = [];
  for (const file of files) {
    if (BINARY_EXTENSIONS.has(extensionOf(file.path))) continue;
    if (file.bytes.includes(0)) {
      findings.push({
        file: file.path,
        line: 1,
        rule: "binary-file",
        message: "binary content in a file that is not a known image. Have a maintainer review it.",
      });
      continue;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(file.bytes);
      texts.push({ path: file.path, text });
    } catch {
      findings.push({
        file: file.path,
        line: 1,
        rule: "binary-file",
        message: "not valid UTF-8 text. Have a maintainer review it.",
      });
    }
  }
  const knownPaths = files.map((f) => f.path);
  return [...findings, ...checkTexts(texts, { knownPaths })];
}

export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.message}`).join("\n");
}
