/**
 * Edits ONE key of the env object of one server in a JSON text, as text: every other byte of the file (line
 * endings, indentation, number spellings such as 1.0 or 12345678901234567890, key order, non-ASCII characters)
 * stays exactly as it was. Parsing and re-printing the whole file would not guarantee that.
 *
 * The input must already be valid JSON (the caller parses it first) with the server's entry being an object and
 * its env, when present, an object. The result is checked by the caller against the expected content.
 */

interface Member {
  key: string;
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
  value: Node;
}
interface Node {
  start: number;
  end: number;
  members?: Member[];
}
interface Edit {
  from: number;
  to: number;
  insert: string;
}

const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

function skipWs(t: string, i: number): number {
  while (i < t.length && isWs(t[i])) i++;
  return i;
}

function stringEnd(t: string, i: number): number {
  let j = i + 1;
  while (j < t.length) {
    if (t[j] === "\\") j += 2;
    else if (t[j] === '"') return j + 1;
    else j++;
  }
  throw new Error("unterminated string");
}

function parseValue(t: string, i: number): Node {
  const c = t[i];
  if (c === "{") {
    const members: Member[] = [];
    let j = skipWs(t, i + 1);
    if (t[j] === "}") return { start: i, end: j + 1, members };
    for (;;) {
      j = skipWs(t, j);
      const keyEnd = stringEnd(t, j);
      const key = JSON.parse(t.slice(j, keyEnd)) as string;
      const valueStart = skipWs(t, skipWs(t, keyEnd) + 1);
      const value = parseValue(t, valueStart);
      members.push({
        key,
        keyStart: j,
        keyEnd,
        valueStart,
        valueEnd: value.end,
        value,
      });
      j = skipWs(t, value.end);
      if (t[j] === ",") {
        j++;
        continue;
      }
      return { start: i, end: j + 1, members };
    }
  }
  if (c === "[") {
    let j = skipWs(t, i + 1);
    if (t[j] === "]") return { start: i, end: j + 1 };
    for (;;) {
      const value = parseValue(t, skipWs(t, j));
      j = skipWs(t, value.end);
      if (t[j] === ",") {
        j++;
        continue;
      }
      return { start: i, end: j + 1 };
    }
  }
  if (c === '"') return { start: i, end: stringEnd(t, i) };
  let j = i;
  while (j < t.length && !isWs(t[j]) && ![",", "}", "]"].includes(t[j])) j++;
  return { start: i, end: j };
}

/** The last member with this key: JSON.parse also keeps the last of duplicated keys. */
function find(node: Node | undefined, key: string): Member | undefined {
  return node?.members?.filter((m) => m.key === key).at(-1);
}

/** The whitespace run right before a member's key, and the text between its key and its value (": "). */
function styleOf(t: string, m: Member): { gap: string; colon: string } {
  let g = m.keyStart;
  while (g > 0 && isWs(t[g - 1])) g--;
  return { gap: t.slice(g, m.keyStart), colon: t.slice(m.keyEnd, m.valueStart) };
}

function apply(t: string, edit: Edit): string {
  return t.slice(0, edit.from) + edit.insert + t.slice(edit.to);
}

function addMember(t: string, obj: Node, key: string, valueText: string): Edit {
  const members = obj.members ?? [];
  const last = members.at(-1);
  if (!last) {
    return { from: obj.start, to: obj.end, insert: `{ ${JSON.stringify(key)}: ${valueText} }` };
  }
  const { gap, colon } = styleOf(t, last);
  return {
    from: last.valueEnd,
    to: last.valueEnd,
    insert: `,${gap}${JSON.stringify(key)}${colon}${valueText}`,
  };
}

function removeMember(obj: Node, index: number): Edit {
  const members = obj.members ?? [];
  if (members.length === 1) return { from: obj.start + 1, to: obj.end - 1, insert: "" };
  if (index === members.length - 1)
    return { from: members[index - 1].valueEnd, to: members[index].valueEnd, insert: "" };
  return { from: members[index].keyStart, to: members[index + 1].keyStart, insert: "" };
}

/**
 * Sets (string) or removes (null) env[key] of mcpServers[server]. Returns the new text, or the same text when
 * there is nothing to do. `text` must not start with a BOM.
 */
export function editEnvKeyText(
  text: string,
  server: string,
  key: string,
  value: string | null,
): string {
  const root = parseValue(text, skipWs(text, 0));
  const entry = find(find(root, "mcpServers")?.value, server);
  if (!entry) return text;
  const env = find(entry.value, "env");
  const valueText = value === null ? "" : JSON.stringify(value);

  if (value === null) {
    if (!env) return text;
    const members = env.value.members ?? [];
    const index = members.lastIndexOf(find(env.value, key) as Member);
    if (index < 0) return text;
    return apply(text, removeMember(env.value, index));
  }
  if (env) {
    const existing = find(env.value, key);
    if (existing)
      return apply(text, { from: existing.valueStart, to: existing.valueEnd, insert: valueText });
    return apply(text, addMember(text, env.value, key, valueText));
  }
  // No env at all: add one to the entry, in the entry's own style.
  return apply(
    text,
    addMember(text, entry.value, "env", `{ ${JSON.stringify(key)}: ${valueText} }`),
  );
}
