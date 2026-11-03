# sc-copilot-mcp: project instructions

A local, read-only MCP server for Star Citizen. Fork of voidput/SCMCP, GPLv3. Read `SECURITY.md` and
`THIRD_PARTY.md` before changing anything that touches a network host, a secret, a data source or a licence.

For Claude as a _user_ of the tools, see `docs/USING_WITH_CLAUDE.md` (the block to paste into a Claude project).

## Hard rules (the mission's absolute prohibitions)

- Never scrape RSI, Erkul, SPViewer or SC Trade Tools. Never read game memory, send keys, automate the game or
  write in the game folder.
- The game's local gRPC telemetry (`GRPC_CLIENT_SERVER_ENABLED`) is **opt-in only**: never on by default, never
  switched on without an explicit action by the user (`SC_TELEMETRY=on` in the server's entry, and the game-side
  variable set by a command the user runs). The address `127.0.0.1:2942` is fixed in code, never from the
  environment; the only thing sent to the game is the empty `TelemetryStream` request; frames are never logged,
  written to disk or sent over a network (the UEC balance stays on the machine). Never call it safe,
  undetectable or approved by CIG. Without `SC_TELEMETRY=on` no gRPC/HTTP2 code is loaded and nothing connects.
- No `Data.p4k` extraction and no extraction code or instructions in this repository. Whether it is safe for an
  account is unverified (see `SECURITY.md`).
- No remote write tool, including UEX `data_submit`; never use UEX's submission key.
- No game data in the repo beyond tiny hand-made synthetic fixtures. Never commit a real `Game.log`.
- Never print, log or commit a secret, the user's MCP config contents, their handle or account data.
- Never replace `claude_desktop_config.json` (it holds other servers): `npm run install:claude` does a minimal
  merge with a backup, dry run by default; writing it needs the user's agreement.
- No npm or Docker Hub publishing. No PR or issue at voidput without the user's explicit say-so.

## Layout

```
src/core/       http (host allowlist, guarded clients), cache (memory + disk, stale only on outage),
                provenance (AsyncLocalStorage), untrusted (cleaning/fencing), config, paths, errors, format
src/providers/  uex, wiki, sctools (clients) · scmdb (store + queries) · gamelog (parser + reader)
                fleet (store + name resolver) · dumps (patch-dump repo) · local (user's game-*.json) · probes
                telemetry (opt-in live stream: wire decoder, schema table, reader on node:http2, handler, service)
src/tools/      one file per group (definition + handler together), catalog.ts (provenance + profiles),
                registry.ts (envelope, scoping), status.ts (sc_data_status)
src/install/    mergeConfig (pure planning of the Claude Desktop config merge)
src/server.ts   MCP server around a registry (tests connect to it in memory; index.ts adds stdio)
src/e2e/        protocol-level behaviour tests; src/docs/ generator of docs/TOOLS.md
scripts/        install-claude-desktop.mjs, check-sources.mjs, mcp-probe.mjs (stale, see CONTRIBUTING)
```

## Conventions that matter

- Every outbound request goes through `createGuardedClient`. Add a host in `ALLOWED_HOSTS` in code review,
  never from the environment.
- Every tool needs an entry in `src/tools/catalog.ts` (source, kind, trust, channel, profiles). `core` must stay
  under 15 tools (a test enforces it). Untrusted free text gets `trust: "untrusted_text"`.
- `formatOutput` strips nulls, zeros and every `id_*` / `*_min|max|avg|week|month` key. Use `formatOutputRaw`
  when those are real data (routes, SCMDB, log events). The provenance envelope is built outside it.
- Tool names and input schemas are frozen by `src/tools/tools-surface.golden.json` (`npm run golden:update`);
  `docs/TOOLS.md` is generated (`npm run docs:tools`) and every tool must be in the README theme table. Tests
  enforce all three.
- Tests never use the network and never real game data: fake clients, temp dirs, hand-made fixtures.
- Windows is the primary target: no `process.cwd()` defaults, use `core/paths.ts`; CI runs on Windows.
- This tool shell rejects here-docs containing backticks; write such scripts to a file first.

## Verify before saying done

`npm run lint && npm test && npm run build && npm run audit:prod`, then `npm run check:sources` for anything that
touches a source. Report what ran and what did not.

## API facts that cost time (do not re-derive)

- UEX answers `{status, http_code, data, message}`; errors come as HTTP 4xx with a `status` code. Both hosts
  `api.uexcorp.uk` (documented) and `.space` answer. `/commodities_routes` needs one of `id_commodity`,
  `id_terminal_origin`, `id_planet_origin`, `id_orbit_origin`, otherwise HTTP 400. `/vehicles_purchases_prices`
  ignores names: filter by `id_vehicle`. `/marketplace_listings` returns at most 100 rows unless `id_item` and
  `operation` are both given.
- The wiki API pages with `page[number]` and `page[size]` (max 50), bare `page` voids the size. Single records can
  be 200k characters: tools fall back to a summary view. Name lookup is exact, `filter[name]` is a substring match.
- SCMDB: `data/latest.json` (schema 2) maps each channel to its files; missions are `merged.contracts`; the deltas
  file lists updates newest first, and the newest ones can have zero data changes.
- LIVE builds differ between sources (wiki and the game log said 12881860 while SCMDB said 12913470 on 2026-11-03).
  That is normal; show it. The game's file version (4.10.197.2878) is not the public version (4.10.2).
- Dump tags (`sc-gamedata-dumps`) are republished: cache by SHA, never trust a tag.
