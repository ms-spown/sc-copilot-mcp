/**
 * Whitespace-only minifier for the View script (page.ts). It is a lexer, not a parser, and it changes NOTHING but the
 * blanks between two tokens: comments go, indentation and line breaks go, the blanks around punctuation go. Strings,
 * template literals (with their `${ }` parts, nested), regular expressions and every token's own text are copied byte for
 * byte. No name is touched.
 *
 * A blank is kept (as one space, or as one line break) only where removing it would change what the script means:
 *   - between two tokens that would fuse (`a in b`, `typeof x`, `1 .x`, `a + +b`, `a - -b`, `a / /re/`, `a < !b`);
 *   - after a regular expression that a word follows (`/x/ in y` would read `in` as flags);
 *   - as a line break after `return break continue throw yield async` and before `++ -- =>`: there the line break itself
 *     carries a meaning (automatic semicolon insertion).
 * `<!--`, `-->` and `</script` can never appear that were not in the text before: the pairs that would make them keep their
 * blank.
 *
 * The proof is a test (scriptMinify.test.ts): a JavaScript parser reads the script before and after and must produce the same
 * tree, with the positions left out. A regular expression read as a division (or the reverse) would corrupt the script and
 * fail that comparison; the lexer decides it from the token before (the usual rule), which is exact for the code that
 * TypeScript emits.
 */

const isWordChar = (c: string): boolean =>
  (c >= "a" && c <= "z") ||
  (c >= "A" && c <= "Z") ||
  (c >= "0" && c <= "9") ||
  c === "_" ||
  c === "$" ||
  c === "\\" ||
  c > "\u007f";
const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isBlank = (c: string): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f";

/** A word after which a `/` starts a regular expression (`return /x/`), not a division. */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);
/** A word after which a line break must stay (restricted productions). */
const BREAK_AFTER_WORD = new Set(["return", "break", "continue", "throw", "yield", "async"]);

type Kind = "word" | "number" | "string" | "regex" | "template" | "punct";

export function minifyScript(src: string): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  // the previous token
  let pKind: Kind | null = null;
  let pText = "";
  // `${` nesting: "t" for a template expression, "b" for a block or an object literal
  const stack: string[] = [];

  const regexAllowed = (): boolean => {
    if (pKind === null) return true;
    if (pKind === "word") return REGEX_AFTER_WORD.has(pText);
    if (pKind === "number" || pKind === "string" || pKind === "regex") return false;
    if (pKind === "template") return !pText.endsWith("`");
    return pText !== ")" && pText !== "]" && pText !== "}";
  };

  /** Skips blanks and comments from `i`; tells whether a line break was among them. */
  const skipGap = (): { gap: boolean; newline: boolean } => {
    let gap = false;
    let newline = false;
    while (i < n) {
      const c = src[i];
      if (isBlank(c)) {
        if (c === "\n" || c === "\r") newline = true;
        gap = true;
        i += 1;
      } else if (c === "/" && src[i + 1] === "/") {
        gap = true;
        while (i < n && src[i] !== "\n" && src[i] !== "\r") i += 1;
      } else if (c === "/" && src[i + 1] === "*") {
        gap = true;
        const end = src.indexOf("*/", i + 2);
        const stop = end < 0 ? n : end + 2;
        if (/[\n\r]/.test(src.slice(i, stop))) newline = true;
        i = stop;
      } else break;
    }
    return { gap, newline };
  };

  /** Scans a template chunk from `i` (just after a backtick, or on the `}` that closes a `${`): up to the next `${` or backtick. */
  const scanTemplate = (from: number): number => {
    let j = from;
    while (j < n) {
      const c = src[j];
      if (c === "\\") j += 2;
      else if (c === "`") {
        return j + 1;
      } else if (c === "$" && src[j + 1] === "{") {
        stack.push("t");
        return j + 2;
      } else j += 1;
    }
    return n;
  };

  const needsSpace = (text: string): boolean => {
    if (pKind === null) return false;
    const last = pText[pText.length - 1];
    const first = text[0];
    if (isWordChar(last) && isWordChar(first)) return true;
    if (pKind === "regex" && isWordChar(first)) return true;
    if (pKind === "number" && first === "." && /^[0-9]+$/.test(pText)) return true;
    if (last === "+" && first === "+") return true;
    if (last === "-" && first === "-") return true;
    if (last === "/" && (first === "/" || first === "*")) return true;
    if (last === "<" && (first === "!" || first === "/")) return true;
    if (last === "-" && first === ">") return true;
    return false;
  };

  while (i < n) {
    const { gap, newline } = skipGap();
    if (i >= n) break;
    const c = src[i];
    let kind: Kind;
    let end: number;
    if (c === '"' || c === "'") {
      kind = "string";
      end = i + 1;
      while (end < n && src[end] !== c) end += src[end] === "\\" ? 2 : 1;
      end = Math.min(end + 1, n);
    } else if (c === "`") {
      kind = "template";
      end = scanTemplate(i + 1);
    } else if (c === "}" && stack.length > 0 && stack[stack.length - 1] === "t") {
      stack.pop();
      kind = "template";
      end = scanTemplate(i + 1);
    } else if (c === "/" && regexAllowed()) {
      kind = "regex";
      end = i + 1;
      let inClass = false;
      while (end < n) {
        const d = src[end];
        if (d === "\\") end += 2;
        else if (d === "[") {
          inClass = true;
          end += 1;
        } else if (d === "]") {
          inClass = false;
          end += 1;
        } else if (d === "/" && !inClass) {
          end += 1;
          break;
        } else end += 1;
      }
      while (end < n && isWordChar(src[end])) end += 1;
    } else if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      kind = "number";
      end = i + 1;
      const radix = c === "0" && /[xXbBoO]/.test(src[i + 1] ?? "");
      while (end < n) {
        const d = src[end];
        if (isWordChar(d) || d === ".") end += 1;
        else if ((d === "+" || d === "-") && !radix && /[eE]/.test(src[end - 1])) end += 1;
        else break;
      }
    } else if (isWordChar(c)) {
      kind = "word";
      end = i + 1;
      while (end < n && isWordChar(src[end])) end += 1;
    } else {
      kind = "punct";
      end = i + 1;
      if (c === "{") stack.push("b");
      else if (c === "}") stack.pop();
    }
    const text = src.slice(i, Math.min(end, n));
    if (gap) {
      const keepBreak =
        newline &&
        ((pKind === "word" && BREAK_AFTER_WORD.has(pText)) ||
          (kind === "punct" &&
            (src.startsWith("++", i) || src.startsWith("--", i) || src.startsWith("=>", i))));
      if (keepBreak) out.push("\n");
      else if (needsSpace(text)) out.push(" ");
    }
    out.push(text);
    pKind = kind;
    pText = text;
    i = end;
  }
  return out.join("");
}
