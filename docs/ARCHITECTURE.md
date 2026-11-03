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
| Live dashboard | `dashboard/` (`poll.ts` the poll payload, `service.ts` shared cache and session markers, `plan.ts`, `viewLogic.ts` pure View logic, `viewApp.ts` the View, `page.ts` the one HTML page, `testing/` fake host and scenario), tools in `tools/dashboard.ts` | An MCP App on top of the telemetry; see below |
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

`sc_live_dashboard` points at a `ui://` resource: one self-contained HTML page that the client renders in an iframe
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
- **Cost of many Views.** Claude mounts one iframe per tool call and never unmounts them, so several Views can poll.
  `service.ts` shares one answer per half second (the cache key is `include_balance`, so a balance is never handed
  to a View that did not ask), and a View stops polling when hidden, off screen, torn down or after 30 minutes away.
- **The balance** exists only in the `balance` part of a poll, on request; it never enters `ui/update-model-context`.
- **Preview.** `scripts/dashboard-preview.mjs` serves the page and a fake host with a made-up flight on `127.0.0.1`.

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
