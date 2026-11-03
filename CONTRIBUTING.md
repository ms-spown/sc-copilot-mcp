# Contributing

This is a small personal project; changes go straight to `main` while only the maintainer works on it.
Keep commits small and clear.

## Where to start

- **Architecture and rules:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Adding a tool, step by step:** [docs/ADDING_A_TOOL.md](docs/ADDING_A_TOOL.md).
- **Good first issues:** after a patch, run `npm run check:sources` and fix what it flags; or improve a tool's
  description or its tests. Please read the [code of conduct](CODE_OF_CONDUCT.md) and, before touching anything
  that reaches the network or handles text from players, [SECURITY.md](SECURITY.md).
- **Style:** behaviour is specified as Given/When/Then scenarios in `*.behaviour.test.ts` files; commits are small,
  with a message that says why. Formatting is Prettier (`npm run format`), checked in CI.

## Before you commit

```bash
npm ci --ignore-scripts
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npm run audit:prod
```

Generated files: after changing a tool run `npm run golden:update` and `npm run docs:tools` (tests fail if you forget).

Tests must not use the network or real game data. Use fake clients, temp folders and hand-made fixtures. A new
tool needs: its definition and handler in `src/tools/`, an entry in `src/tools/catalog.ts` (source, kind, trust,
channel, profiles), tests, and a refreshed `src/tools/tools-surface.golden.json` (see CLAUDE.md). Never add a
host except in `ALLOWED_HOSTS`, never a remote write, and read `SECURITY.md` and `THIRD_PARTY.md` first.

## New patch procedure (target: well under an evening)

Run this when a new LIVE or PTU build appears. Everything is read-only.

1. **Pull and build.** `git pull && npm ci --ignore-scripts && npm run build`.
2. **Check every source.** `npm run check:sources` (first run downloads the SCMDB files into your cache, a
   minute or two; later runs take seconds). It prints each source's version and re-validates the shape of every
   file and endpoint the tools rely on. Exit code 1 means something to look at.
3. **Read the notes.** Differences between sources are expected for hours or days after a patch. A source on an
   older build is not a bug; one that is _down_ or whose _shape changed_ is.
4. **If a shape check fails.** The error names the file and field ("unexpected shape at …"). Open that source's
   files, adapt the validator in `src/providers/scmdb/store.ts` (or the client) and the query in
   `queries.ts`, add a small synthetic fixture for the new shape, run the suite.
5. **If you have the game installed:** set `SC_INSTALL_DIR`, run the game once, then `npm run check:sources`
   again: the `game-log` line must show the new version and build. If the header stops parsing, update
   `src/providers/gamelog/parser.ts` and add a hand-made line to the fixture in
   `src/providers/gamelog/gamelog.test.ts`. Do not commit a real log.
6. **UEX specifics.** `check:sources` calls the five endpoints the tools use. A new required parameter shows as
   an HTTP 400 with UEX's own message.
7. **Spot-check in Claude** with `sc_data_status`, one trade route (`uex_get_trade_routes` with a cargo size),
   one `scmdb_changes` and one `sc_log_recent_events`.
8. **Commit** with what changed and the build numbers seen.

Source-specific places to look when something moves:

| Source                | Verification                                                   | Where the code is                                 |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| UEX                   | `check:sources` (UEX section), `sc_data_status`                | `src/providers/uex/client.ts`, `src/tools/uex.ts` |
| Star Citizen Wiki API | `sc_data_status`, `scw_get_vehicle` on a big ship              | `src/providers/wiki/`, `src/tools/wiki.ts`        |
| starcitizen.tools     | `sc_data_status` (reachability only)                           | `src/tools/sctools.ts`                            |
| SCMDB                 | `check:sources` (SCMDB section: every file kind, LIVE and PTU) | `src/providers/scmdb/`                            |
| Patch dumps           | `sc_list_builds` (history is nearly empty)                     | `src/providers/dumps/`                            |
| Game.log              | `check:sources` (Game.log section), `sc_log_status`            | `src/providers/gamelog/`                          |

## About `scripts/mcp-probe.mjs`

Inherited from upstream and stale: it calls a dataset name that no longer exists and expects builds that are no
longer published, so 4 of its 14 checks fail for reasons unrelated to the code. `check:sources` replaces it.
