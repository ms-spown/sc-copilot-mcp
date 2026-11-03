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
| Patch dumps | `providers/dumps/` | Legacy; history is thin |

## Testing approach

- **Behaviour first.** Feature tests are written as scenarios (`describe("Feature: …")`, `describe("Scenario: …")`,
  `it("Given …, When …, Then …")`) in `*.behaviour.test.ts` files. `src/e2e/protocol.behaviour.test.ts` drives the
  real MCP protocol through an in-memory client.
- **No network, no real data.** Fake clients, temp folders, hand-made fixtures. Real services are only touched by
  `npm run check:sources`, which a human runs.
- **Mutation of reality is faked at the edge.** Providers receive their HTTP client, so tests pass a fake.
