# Architecture

How a question becomes an answer, and where each rule lives. Read this before adding a source or a tool.

```
Claude ── MCP (stdio) ──► src/server.ts ──► tools/registry.ts ──► a tool handler ──► a provider ──► the outside world
                                               │  envelope: provenance + untrusted-text handling
                                               └─ scoping: SCMCP_TOOLS / SCMCP_PROFILES
```

## Layers

| Layer | Folder | Responsibility | Must not |
| --- | --- | --- | --- |
| Protocol | `src/server.ts`, `src/index.ts` | Wire the registry to MCP; `index.ts` adds stdio and reads `.env` | Contain logic |
| Tools | `src/tools/` | One file per group. A tool is its definition (name, description, schema) **and** its handler, together | Talk HTTP directly: they receive clients |
| Registry | `src/tools/registry.ts`, `catalog.ts` | Dispatch, error results, the `{provenance, data}` envelope, profiles | Know any source's details |
| Providers | `src/providers/<source>/` | Everything about one source: client, parsing, validation, queries | Format answers for Claude |
| Core | `src/core/` | Shared plumbing: guarded HTTP, cache, provenance, untrusted text, paths, config, errors | Depend on a provider |

## Cross-cutting rules (each is enforced somewhere)

- **Network**: every request uses `createGuardedClient` (`core/http.ts`): https only, per-upstream host allowlist
  on the URL and every redirect, token attached per request after the check. Tests: `core/http.test.ts`.
- **Provenance**: the registry wraps every successful result. Static facts (source, kind, trust, channel) come from
  `tools/catalog.ts`; dynamic ones (fetch time, stale flag, game version) are collected while the handler runs,
  through an `AsyncLocalStorage` in `core/provenance.ts`. `core/cache.ts` and the SCMDB store record their fetches.
- **Cache**: memory (5 min) plus disk. Old data is served, flagged stale, only when the upstream is unreachable,
  never for 4xx. Tests: `core/cache.test.ts`.
- **Untrusted text**: tools whose catalog entry says `trust: "untrusted_text"` have their strings cleaned,
  shortened and fenced by the registry (`core/untrusted.ts`), and carry a notice.
- **Output size**: `core/format.ts`. `formatOutput` strips nulls, zeros and `id_*`-style keys to save context;
  use `formatOutputRaw` when those are data. Never return a whole file or an unbounded list.
- **Surface stability**: `src/tools/tools-surface.golden.json` freezes names and input schemas.
  `docs/TOOLS.md` is generated from the code and checked by a test.

## Where each data source lives

| Source | Provider | Notes |
| --- | --- | --- |
| UEX | `providers/uex/` (client with envelope validation), tools in `tools/uex.ts` | Token in `.env`; `/commodities_routes` needs an origin |
| Star Citizen Wiki API | `providers/wiki/` | Pagination quirks, snapshots |
| starcitizen.tools | `providers/sctools/`, `tools/patchnotes.ts`, `core/text.ts` | MediaWiki; `Update:` pages are patch notes |
| SCMDB | `providers/scmdb/` (`store.ts` downloads and validates, `queries.ts` answers) | Cached by commit SHA |
| Game log | `providers/gamelog/` (`parser.ts` pure, `reader.ts` I/O, `context.ts` derived views) | Off by default; read-only |
| Fleet | `providers/fleet/` (`store.ts`, `resolve.ts`) | Local JSON file |
| Live telemetry | `providers/telemetry/` (`wire.ts` + `decode.ts` + `schema.ts` decode, `normalize.ts` flat state, `handler.ts` + `events.ts` debounced events, `reader.ts` HTTP/2 stream, `service.ts` lazy single reader, `index.ts` the only door) | Off unless `SC_TELEMETRY=on`; loopback only; memory only; see [TELEMETRY.md](TELEMETRY.md) |
| Live dashboard | `dashboard/` (`poll.ts` the poll payload, `service.ts` shared cache and session markers, `plan.ts`, `ledger*.ts` the transport ledger, `specs.ts` the ship sheet lookup from the wiki (background, cached by class name), `viewLogic.ts` pure View logic, `specsView.ts` + `specsStyles.ts` the pure View logic and styles of the sheet gauges, `viewApp.ts` the View, `page.ts` the one HTML page, `testing/` fake host and scenario), tools in `tools/dashboard.ts` | An MCP App on top of the telemetry; see below |
| Patch dumps | `providers/dumps/` | Legacy; history is thin |

## Optional features that are off by default

Live telemetry is the model for any feature that reads something on the player's machine that the player did not
ask for by installing the server:

- One switch in the server's environment (`SC_TELEMETRY=on`), read in `core/config.ts`. A second switch outside this
  process (the game-side variable) that the server never touches.
- `providers/telemetry/index.ts` is the only door. With the switch off it loads nothing else: no HTTP/2 code, no
  connection. The reader module is imported on the first request that needs it.
- The address `127.0.0.1:2942` is a constant in `reader.ts`. Tests inject a port through `endpointForTests`; the
  production code path has no way to take an address from the environment.
- Tools that need the feature set `advertised` (`ToolDefinition.advertised`): they are left out of `tools/list` while
  it is off. A tool that must always be there to explain the feature (`sc_live_status`) is always listed.
- Everything the feature reads stays in memory. Names that come from the stream are only passed on if they look like
  a game identifier. Anything that reaches the conversation and is personal (the aUEC balance) is withheld unless the
  caller asks for it.
- `npm run check:telemetry-silence` listens on the port itself and proves that the built server makes no connection
  when the switch is off and does when it is on.

## The live dashboard (an MCP App)

`sc_live_dashboard` points at a resource of type ui: one self-contained HTML page that the client renders in an iframe
and that talks to the host with JSON-RPC over `postMessage` (hand-written, no package). The page calls two tools
that only it may call (`visibility: ["app"]`): `sc_live_poll` (state, events, session counters as
`structuredContent`) and `sc_live_mark` (session markers, in memory).

- **Conditional surface.** `ToolDefinition.requiresUi` and `registry.list(context)`: the three tools are listed only
  when telemetry is on AND the client declared `capabilities.extensions["io.modelcontextprotocol/ui"]` with the HTML
  MIME type. `server.ts` announces the `resources` capability, and serves `resources/list` and `resources/read`, only
  when there is a resource to serve (telemetry on). With telemetry off the server is unchanged.
- **One page, tested as it ships.** The View logic is pure TypeScript (`viewLogic.ts`: reducing polls, formatting,
  polling and context decisions, estimates). `page.ts` serialises those functions and `viewApp.ts` into one inline
  script with `Function.prototype.toString`; `viewPage.test.ts` runs that very script in `node:vm` against a fake DOM
  (which refuses `innerHTML`) and a fake host. No browser is involved in the tests.
- **Cost of many Views.** Claude mounts one iframe per tool call and never unmounts them, so several Views exist.
  Server side, `service.ts` shares one answer per half second (the cache key is `include_balance` only, so a balance
  is never handed to a View that did not ask); `tailorPoll` then cuts that shared answer per request (events newer
  than `since_seq`, sections whose hash is in `have` left out and listed in `unchanged`, `not_in_stream` only with
  `include_static`), so the cache never depends on what a View holds. View side, the Views of a connector share a
  sandbox origin and talk on a `BroadcastChannel` (`electLeader`, `notePeer`, `parseChannelMessage`, `cleanPoll`, all
  pure and tested): the most recent visible View polls and shares its answer (without balance or wallet events), the
  others follow and show a banner. Without `BroadcastChannel` a View away for 30 seconds retires. The channel handler
  is separate from the JSON-RPC handler, only the host window is believed for `ui/*`, and `dispose()` removes every
  listener, observer, timer and the channel.
- **Coverage.** `providers/telemetry/coverage.ts` decides what becomes of every field of the schema (exposed where,
  shown by which widget, or ignored and why); `coverage.test.ts` fails when a field has no entry, `cockpit.test.ts`
  checks the widgets exist in the page, and the tables of docs/TELEMETRY.md and .fr.md are generated from it
  (`npm run docs:coverage`). The state of the moment (`conditions`) is computed in `handler.ts` from the smoothed
  state, with its own debouncing.
- **The balance** exists only in the `balance` part of a poll, on request; it never enters `ui/update-model-context`.
- **The ship sheet.** `specs.ts` holds a `ShipSpecsResolver` that `DashboardService` consults for the class name of the
  flown ship. `current()` is synchronous and answers from memory; the first sight of a ship starts one wiki search in
  the background through the guarded client (`scwClient`, a host already on the allowlist) and `fetchWithCache`
  (`record: false`), never in the poll's hot path and never while telemetry is off. States: `pending`, `ready`,
  `unknown`, `ambiguous`, `error` (retried at most every 5 minutes); at most 32 ships are remembered. The class name
  becomes words (`shipNameToWords`, pure) and goes through `resolveShip`; only a single candidate, or the one row
  whose `class_name` is the very class name, is accepted. The result is the optional `specs` field of the poll
  (`poll.ts`). The View side lives in `specsView.ts` (pure, serialised into the page after `viewLogic.ts` by
  `page.ts`) and `specsStyles.ts`, so the sheet gauges stay out of the files the rest of the View changes in.
- **The transport ledger** is kept in modules of its own. `ledger.ts` is pure (log events and a balance history in, a
  bounded payload out: contracts, steps, durations, and, only with `include_balance`, gains, totals, pace and
  planned against measured). `ledgerService.ts` keeps the last result in memory and refreshes it from the game log at
  most every 5 seconds: the file's modification date is looked at, and nothing is read unless it changed. The first
  read is a full one; after that only the bytes added since the last position are parsed (with a 16 kB look-behind
  so that two lines written together are never cut apart, and a key per event to ignore what the look-behind
  re-reads). A shorter file, a different beginning (a new game session) or a UTF-16 log starts again with a full read.
  The poll calls the synchronous `state()` and never waits for the file. `TelemetryService.balanceHistory()` (500
  points at most, one per change, memory only, optional on the `Telemetry` interface) feeds it and is exposed by no
  tool. The ledger is the fifth section of the delta protocol (`have.ledger`, `hash.ledger`, `unchanged`): its hash
  is computed from the content built for that balance choice, so the shared cache (keyed by `include_balance`)
  never mixes the two and a hash of a version with amounts is never sent to a View that did not ask for the balance.
  The panel is `ledgerPanel.ts` (with `ledgerStyles.ts`), compiled into the page after `specsView.ts`; it writes
  only the nodes that change. On the channel between Views the ledger travels without every balance-derived field
  (`ledgerStripBalance` before sending, `ledgerChannelClean` on reception); `testing/ledgerScenario.ts` plays an
  invented transport session for the tests and the preview (`transport=` parameter).
- **Preview.** `scripts/dashboard-preview.mjs` serves the page and a fake host with a made-up flight (a full quantum
  jump included) on `127.0.0.1`. Its iframe carries `allow-same-origin` (the preview only) so that two Views can reach
  each other on the channel.

## Testing approach

- **Behaviour first.** Feature tests are written as scenarios (`describe("Feature: …")`, `describe("Scenario: …")`,
  `it("Given …, When …, Then …")`) in `*.behaviour.test.ts` files. `src/e2e/protocol.behaviour.test.ts` drives the
  real MCP protocol through an in-memory client.
- **No network, no real data.** Fake clients, temp folders, hand-made fixtures. Real services are only touched by
  `npm run check:sources`, which a human runs.
- **Mutation of reality is faked at the edge.** Providers receive their HTTP client, so tests pass a fake.
- **A fake game for the telemetry.** `providers/telemetry/testing/` has a protobuf encoder written from the `.proto`
  (not from the decoder's table, so one wrong field number cannot hide itself) and a gRPC server over HTTP/2 on an
  ephemeral port. No real frame is stored anywhere in the repository.
