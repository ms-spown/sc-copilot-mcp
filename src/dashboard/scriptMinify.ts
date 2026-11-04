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
 * Where the output would form `<!--` or `-->` (an HTML-like comment to a JavaScript engine) a space is kept between the two
 * pieces, and the minifier throws if its INPUT holds such a comment or starts with a hashbang: both would swallow the rest
 * of a line, which is what a minifier that joins lines must never do silently.
 *
 * What a lexer cannot know, and how that is covered:
 *   - Division or regular expression after `)`: the paren is remembered, a `/` after `if (...)`, `for (...)`, `while (...)`
 *     or `with (...)` starts a regular expression, after any other `)` it divides. After `}` it starts a regular expression
 *     (a division there means a statement that begins with an object literal: it does not exist in practice). After
 *     a postfix `++`/`--` (after an operand, on its line), `]`, a name, a number, a string it divides (after a prefix
 *     `++`/`--` it starts a regular expression). After a reserved word (`return typeof in new ...`) it starts a
 *     regular expression, unless that word follows a `.` (a property name). After `of`, `yield` or `await` it could be
 *     either (they are also valid names): the minifier THROWS rather than guess.
 *   - Scripts that rely on automatic semicolon insertion (a statement without its `;` followed by a line that starts with
 *     `(`, `[`, a template or `/`) are not supported: the page's script comes from the TypeScript compiler, which always writes
 *     its semicolons. Such an input fails the equivalence test below or the parse; it does not ship altered.
 *   - That is not a proof for arbitrary scripts. The proof is a test (scriptMinify.test.ts): a JavaScript parser reads the
 *     script that ships before and after and must find the same tokens and the same tree. A misread regular expression or
 *     division corrupts the script and fails that comparison at build time, so it cannot ship silently.
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

/** A reserved word after which a `/` starts a regular expression (`return /x/`), not a division. */
const REGEX_AFTER_WORD = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
]);
/** Words that are valid names AND keywords: after them a `/` is ambiguous, so the minifier refuses it. */
const AMBIGUOUS_WORD = new Set(["of", "yield", "await"]);
/** A word whose parenthesis is followed by a statement (so a `/` after the `)` is a regular expression). */
const STATEMENT_PAREN_WORD = new Set(["if", "for", "while", "with"]);
/** A word after which a line break must stay (restricted productions). */
const BREAK_AFTER_WORD = new Set(["return", "break", "continue", "throw", "yield", "async"]);

type Kind = "word" | "number" | "string" | "regex" | "template" | "punct";

export function minifyScript(src: string): string {
  if (src.startsWith("#!")) throw new Error("scriptMinify: a hashbang line cannot be minified");
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  // the last characters written, to see a `<!--` or a `-->` that two pieces would form
  let tail = "";
  // the two previous tokens
  let pKind: Kind | null = null;
  let pText = "";
  let ppText = "";
  // `${` nesting: "t" for a template expression, "b" for a block or an object literal
  const stack: string[] = [];
  // for every open parenthesis: does a statement follow its closing one (`if (...) /re/`)?
  const parens: boolean[] = [];
  let closedStatementParen = false;
  // was the last `++` or `--` a postfix one (`i++ / 2` divides, `++/re/.lastIndex` does not)?
  let incDecIsPostfix = false;
  // a line break is due after the `}` that closes a top-level declaration of the page's function
  let breakDue = false;

  const regexAllowed = (): boolean => {
    if (pKind === null) return true;
    if (pKind === "word") {
      if (ppText === ".") return false; // a property named like a keyword
      if (AMBIGUOUS_WORD.has(pText)) {
        throw new Error(
          `scriptMinify: a "/" after "${pText}" is ambiguous (division or regular expression)`,
        );
      }
      return REGEX_AFTER_WORD.has(pText);
    }
    if (pKind === "number" || pKind === "string" || pKind === "regex") return false;
    if (pKind === "template") return !pText.endsWith("`");
    if (pText === ")") return closedStatementParen;
    if (pText === "++" || pText === "--") return !incDecIsPostfix;
    return pText !== "]";
  };

  /** Does the previous token end an operand (so that a `++` right after it is a postfix one)? */
  const endsOperand = (): boolean => {
    if (pKind === "number" || pKind === "string" || pKind === "regex") return true;
    if (pKind === "template") return pText.endsWith("`");
    if (pKind === "word")
      return ppText === "." || !(REGEX_AFTER_WORD.has(pText) || AMBIGUOUS_WORD.has(pText));
    return pText === ")" || pText === "]";
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
    if (pKind === "number" && isWordChar(first)) return true;
    if (pKind === "number" && first === "." && /^[0-9_]+$/.test(pText)) return true;
    if (last === "+" && first === "+") return true;
    if (last === "-" && first === "-") return true;
    if (last === "/" && (first === "/" || first === "*")) return true;
    if (last === "<" && (first === "!" || first === "/")) return true;
    if (last === "-" && first === ">") return true;
    return false;
  };

  /** Would `text`, written right after what is written, form `<!--` or `-->` with the characters before it? */
  const formsHtmlComment = (text: string): boolean => {
    const joined = tail + text.slice(0, 3);
    for (const m of joined.matchAll(/<!--|-->/g)) {
      const at = m.index ?? 0;
      if (at < tail.length && at + m[0].length > tail.length) return true;
    }
    return false;
  };

  const write = (piece: string): void => {
    out.push(piece);
    tail = (tail + piece).slice(-3);
  };

  while (i < n) {
    const { gap, newline } = skipGap();
    if (i >= n) break;
    const c = src[i];
    let kind: Kind;
    let end: number;
    let closesTopLevel = false;
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
      if ((c === "+" || c === "-") && src[i + 1] === c) {
        end = i + 2;
        incDecIsPostfix = endsOperand() && !newline;
      } else if (c === "." && src.startsWith("...", i)) end = i + 3;
      if (c === "<" && src.startsWith("<!--", i))
        throw new Error(
          "scriptMinify: an HTML-like comment (<!--) in the script cannot be minified",
        );
      if (c === "-" && src.startsWith("-->", i) && (newline || out.length === 0))
        throw new Error(
          "scriptMinify: an HTML-like comment (-->) in the script cannot be minified",
        );
      if (c === "{") stack.push("b");
      else if (c === "}") {
        stack.pop();
        closesTopLevel = stack.length === 1;
      } else if (c === "(") {
        parens.push(pKind === "word" && ppText !== "." && STATEMENT_PAREN_WORD.has(pText));
      } else if (c === ")") {
        closedStatementParen = parens.pop() ?? false;
      }
    }
    const text = src.slice(i, Math.min(end, n));
    if (breakDue) {
      // between top-level declarations of the page, so that an error trace points at a line of a few hundred characters
      if (text !== ";") write("\n");
      breakDue = false;
    }
    if (gap) {
      const keepBreak =
        newline &&
        ((pKind === "word" && ppText !== "." && BREAK_AFTER_WORD.has(pText)) ||
          (kind === "punct" &&
            (src.startsWith("++", i) || src.startsWith("--", i) || src.startsWith("=>", i))));
      if (keepBreak) write("\n");
      else if (needsSpace(text) || formsHtmlComment(text)) write(" ");
    } else if (formsHtmlComment(text)) write(" ");
    write(text);
    if (closesTopLevel) breakDue = true;
    ppText = pText;
    pKind = kind;
    pText = text;
    i = end;
  }
  return out.join("");
}
