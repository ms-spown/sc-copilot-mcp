# Adding a tool, step by step

A good first contribution. Budget an hour. Read [ARCHITECTURE.md](ARCHITECTURE.md) first.

## 1. Decide what it is

- **Which source?** Use an existing provider, or add one under `src/providers/<name>/` (client or reader +
  validation + queries). A new host must be added to `ALLOWED_HOSTS` in `src/core/http.ts`, in its own commit, with
  a note on why that host is safe. **Never scrape** RSI, Erkul, SPViewer or SC Trade Tools, and never add a tool that
  writes to a remote service.
- **Which profile?** `core` is capped at 14 tools (a test enforces < 15): a new tool goes to `trade`, `data` or `local`
  unless it is something nearly every player needs.
- **Who wrote the text it returns?** Players or website editors: `trust: "untrusted_text"`.

## 2. Write the behaviour first

Create `src/tools/<thing>.behaviour.test.ts`. Describe what the player experiences; fake only the outside world.

```ts
describe("Feature: <what the player gets>", () => {
  describe("Scenario: <a situation>", () => {
    it("Given <state>, When <ask>, Then <observable result>", async () => {
      const { registry } = world();                       // registry built with fake clients
      const { data, provenance } = body(await registry.call("my_tool", { query: "x" }));
      expect(data.rows).toHaveLength(2);
      expect(provenance).toMatchObject({ kind: "datamined", channel: "live" });
    });
  });
});
```

Cover at least: the normal answer, an empty result, bad input, the source being down, and (if it returns
third-party text) that it is flagged untrusted. Look at `hauling.behaviour.test.ts` and
`patchnotes.behaviour.test.ts` for complete examples with fake clients.

## 3. Implement

1. **Handler**: a function in `src/tools/<group>.ts` returning `{ definition + handler }` (copy a small tool such as
   `sc_fleet_remove`). Validate arguments with zod. Description: what it returns, when to use it, its limits, in
   words a model can act on; mention what the tool does **not** know.
2. **Register**: add the group to `allTools` in `src/tools/registry.ts`.
3. **Catalog**: add an entry in `src/tools/catalog.ts` (`source`, `kind`, `trust`, `channel`, `profiles`).
   `channel` is `unknown` unless the source really says LIVE or PTU: never guess.
4. **Provenance extras**: if your source knows the game version or a fetch time, call `setGameVersion`,
   `setChannel`, `recordFetch` (`core/provenance.ts`); `fetchWithCache` already records.
5. **Output**: keep it small and projected (never a whole file). Use `formatOutputRaw` if zeros or ids matter.
6. **Errors**: throw an `Error` with a message the user can act on; the registry turns it into an error result.

## 4. Update the generated and frozen files

```bash
npm run build
npm run golden:update   # refreshes the frozen names and schemas and prints what changed
npm run docs:tools       # regenerates docs/TOOLS.md
```

- Names and schemas are frozen in `src/tools/tools-surface.golden.json`; `golden:update` rewrites it and lists what
  was added, removed or changed. Changing an existing schema on purpose? Say why in the commit message.
- Regenerate `docs/TOOLS.md` with `npm run docs:tools` (a test fails if you forget).
- Add the tool name to the theme table in `README.md` (a test fails if you forget).

## 5. Check

```bash
npm run lint && npm run typecheck && npm test && npm run build && npm run audit:prod
npm run check:sources      # if you touched a source: needs the network
```

Then open a pull request using the template. Small and focused beats big and complete.
