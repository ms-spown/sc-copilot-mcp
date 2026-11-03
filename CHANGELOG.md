# Changelog

All notable changes to this fork. The history of the original project (voidput/SCMCP, up to 1.5.0) is kept in
[docs/UPSTREAM_CHANGELOG.md](docs/UPSTREAM_CHANGELOG.md). Format: [Keep a Changelog](https://keepachangelog.com/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [2.1.0] - 2026-11-03

### Added
- **Optional live telemetry, off by default.** The game has an undocumented local telemetry server; with two explicit
  switches (`SC_TELEMETRY=on` on the server, `GRPC_CLIENT_SERVER_ENABLED=true` in the RSI Launcher's environment) the
  server reads it on `127.0.0.1:2942` and nothing else. No new dependency: a hand-written protobuf decoder and
  `node:http2`. Without `SC_TELEMETRY=on` no HTTP/2 code is loaded and no connection is made
  (`npm run check:telemetry-silence` proves it).
  - Tools `sc_live_status` (always listed), `sc_live_state` and `sc_live_events` (listed only when telemetry is on);
    kind `local_telemetry`. The aUEC balance is withheld unless `include_balance` is true.
  - States `off`, `waiting`, `game_without_telemetry`, `connected`, `live`, `incompatible`; derived events with a
    `confirmed` / `unverified` flag; a source line in `sc_data_status`.
  - `npm run telemetry -- status | enable | disable` (dry run unless `--apply`; a byte-faithful, backed-up edit of one
    key of the Claude Desktop configuration; `--session` for one launch only), and a section in `npm run doctor`.
  - [docs/TELEMETRY.md](docs/TELEMETRY.md): what the stream contains and does not, privacy, troubleshooting, and the
    risks of using an undocumented game feature. The schema file comes from Wingman AI (GPLv3), see THIRD_PARTY.md.
- **[docs/CAPABILITIES.md](docs/CAPABILITIES.md)**: every capability by need, checked against the code by a test.
- **Contribution policy** in CONTRIBUTING.md (automated and AI-assisted contributions welcome; the project pays
  nothing) and `npm run check:docs`, run by the tests and by CI: it refuses invisible characters, HTML comments,
  unreviewed link hosts and translation drift in the files Claude reads.
- French README and Claude block (`README.fr.md`, `docs/USING_WITH_CLAUDE.fr.md`), contributed by an external author.
- `ToolDefinition.advertised`: a tool can be left out of `tools/list` while its feature is off.
- **Live dashboard (an MCP App), optional.** With live telemetry on, Claude Desktop can show a live dashboard in the
  conversation: ship, speed, hydrogen, health, state of the stream and recent alerts inline; instruments, warning
  lights, power flags, weapons, countermeasures, vitals, events, session timeline, pace and estimates in full screen.
  Every value shows its age and greys out when the stream is not live; nothing is invented.
  - Tools `sc_live_dashboard` (opens it; optional `plan` of a trade route, compared with the measured balance change),
    `sc_live_poll` and `sc_live_mark` (reserved to the page). Listed only when `SC_TELEMETRY=on` and the client
    declared the MCP Apps extension: Claude Code never sees them. Without telemetry the server announces no
    `resources` capability and serves no resource.
  - The aUEC balance is hidden until the player clicks; the poll carries it only on request, and it never enters
    `ui/update-model-context`. Only the button "Route avec mon solde et ce vaisseau" sends it, saying so.
  - Polling about once a second, suspended when hidden, off screen or torn down, slowed when the stream is cut, shared
    for 500 ms between all the dashboards of a conversation.
  - `tools/list` entries carry `_meta` (frozen in the golden file) and `registry.list(context)` takes the client
    context; `scripts/dashboard-preview.mjs` previews the page against a fake host.
  - Documentation: the "Live dashboard" section of [docs/TELEMETRY.md](docs/TELEMETRY.md), a rule in the Claude block,
    troubleshooting, architecture and the threat model.

- **French translation of the live telemetry page**, [docs/TELEMETRY.fr.md](docs/TELEMETRY.fr.md), linked from
  `README.fr.md` and from the English page; `npm run check:docs` compares the pair.

### Changed
- **`provenance.data_age` is now the age of the data itself**, from dates the source gives (UEX `date_modified` of the
  rows returned, the SCMDB channel's `generated_at`); `null` with `data_age_note` when the source gives none. The old
  meaning (age of the fetch or cache) is the new `provenance.cache_age`, also used by `sc_data_status`.
- `uex_get_commodity_prices` answers `buy_locations` and `sell_locations` (cheapest / best first, `limit` default 15,
  max 50, with totals; `side` keeps one), leaves out rows of an older game version than LIVE and counts them
  (`excluded_older_version`, `include_older_versions` to keep them), and adds `updated_at` to each row. Rows of a
  version newer than LIVE are kept and counted (`newer_than_live`); without a known LIVE version nothing is excluded.
  Rows reported by players come before UEX estimates (`is_estimate`, `estimates` count per list).
- `uex_get_trade_routes` ranks routes with a UEX estimate (`is_estimate`, 0 reports at an end) after reported ones;
  new `min_reports` drops them. UEX dates no route price (its `date_added` is the recalculation time), so route
  answers have `data_age: null`. Only `date_modified` is read as a date; ship price rows carry `updated_at`.
- The SCMDB tools are now `untrusted_text` (they return free text written by others) and `sc_fleet_get` too (wiki
  text). Their searches ignore case, accents and punctuation and fall back to close spellings with a "did you mean"
  note, so `quantanium` finds Quantainium; a filter that matches nothing says so. The unit of `time_to_complete` is
  stated as unknown, because no source proves one.
- `sc_fleet_get` shows disagreeing UEX and wiki values side by side (`conflict`, crew and cargo) instead of choosing
  one, and treats a wiki speed of 0 as not provided.
- `sct_search` returns a readable list (title, excerpt, URL); a MediaWiki error is an error, not "no result".
- The server announces itself as `sc-copilot-mcp` (it said `star-citizen-mcp`).
- `sc_data_status` and the error paths of the SCMDB tools clean the strings they pass on; the untrusted-text fence is
  also neutralised inside JSON values.

### Security
Fixes for the findings of an independent security audit (each checked by a test that builds its attack from code
points and uses no network).
- **Invisible characters are removed by Unicode category**, not from a list of ranges: format, private-use,
  surrogate, unassigned and control characters, and variation selectors. The tag block U+E0000-E007F ("ASCII
  smuggling"), U+FE00-FE0F, U+E0100-E01EF, U+061C, U+206A-206F, soft hyphen, the Hangul, Khmer and braille blanks and
  the combining grapheme joiner no longer get through; NEL, U+2028 and U+2029 become a newline.
- **Errors are no longer outside the envelope.** What a remote server says in an error (the UEX `status` and
  `message`, the starcitizen.tools error text, a remote error body) is cleaned, cut at 300 characters and fenced
  like untrusted text; names quoted in "fits several ships" errors are fenced; no error message, including one a
  tool builds itself, keeps an invisible character or grows without bound. Our own wording stays readable.
- **Third-party text under `structured` trust.** Game and build versions from UEX, the wiki, the game log, local
  files and the dump repository are cleaned and cut at 80 characters where they enter, so `provenance.game_version`
  and `sc_data_status` cannot carry a sentence; the per-row versions of `uex_get_trade_routes` and
  `uex_get_terminal_inventory` get the same treatment. A patch-dump tag that is not a plain build string (a sentence)
  is dropped, and the collection names a dump lists are fenced in the errors that quote them. **Trust changes you
  will see (nine tools now `untrusted_text`, with the notice and cleaned, bounded strings):** `sc_list_builds` and
  `sc_diff_versions` (the dump repository is configurable), `scw_get_filters`, and the UEX tools that hand rows back
  unprojected: `uex_get_commodity_prices` and `uex_get_ship_prices` (both in the `core` profile),
  `uex_get_commodities`, `uex_get_commodity_averages`, `uex_get_commodity_ranking`, `uex_get_terminals`. New guard
  tests fail if free text from UEX, the wiki or the dump repository reaches a `structured` tool, as one already did
  for SCMDB.
- **The installer no longer rewrites the whole Claude Desktop config.** `npm run install:claude` inserts or replaces
  only the `sc-copilot` entry, as text (CRLF, indentation, BOM, `1.0` and integers above 2^53 of the other servers are
  kept); when the result is not exactly what was expected it writes nothing and prints the entry to add by hand.
- **The installer preview no longer prints a secret** already in the file: for an entry it replaces it shows the
  names of its `env` keys, never the values (other keys and arguments that name a secret are hidden too).
- **A collection name could leave the build cache folder** (`ships__../../../x` in `sc_diff_versions`). It is now
  restricted to letters, digits, `_`, `-` and `.` without `..`, and the resolved path must stay inside the cache;
  the dataset name of `collectLabels` gets the same check as the other local readers.
- **`npm run check:docs` hardened** after an independent audit executed bypasses that the check accepted:
  - Invisible Markdown: a link definition (`[//]: # (text)`, `[x]: <>`) must be used, point to a reviewed URL or a
    file of the repository, and carry no title; links and images with a title are refused.
  - Every link target is judged: bare `www.` addresses, e-mail addresses, `<...>` links, images, `srcset`, and URLs
    in HTML attributes; a relative link must name a file or folder that exists.
  - A lone carriage return (it hides text in a terminal) is refused; CRLF stays allowed.
  - Look-alike letters: any letter outside the Latin script (whole words included), any character that NFKC folds
    into another (fullwidth, mathematical, circled...), Latin look-alike blocks, non-ASCII digits and slash-like
    punctuation are refused in every tracked text file (the ellipsis is tolerated). No file needs an exception.
  - Extensions are compared without regard to case and cover `.markdown`, `.mdx`, `.mdc` and other prose formats;
    translations too.
  - github.com is allowed under reviewed project prefixes only (`ALLOWED_PATH_PREFIXES`), not for any path.
    Credentials in a URL, ports, punycode hosts and non-https schemes are refused; hosts are compared in lower case.
  - YAML and JSON files, `.claude/` and all of `src/` (tests and `testing/` helpers aside) are now checked for link
    hosts and look-alikes; prompts, tools and configuration also for comments and tags. The lock file is checked for
    entries that do not come from the npm registry over https.
  - `package.json` scripts with a URL, a network command or an npm lifecycle hook, and any hook, script or
    setting under `.claude/`, are reported for review.
  - CONTRIBUTING.md lists what the check does not detect, and no longer says "no native code" without nuance:
    production dependencies have none, development tools ship prebuilt native binaries.
- **Live telemetry reader hardened against a local program that pretends to be the game** (port 2942 has no
  authentication). Found by an independent audit that ran the attacks:
  - A 1 MiB frame of empty weapons gave 500 000 entries (250 ms, 65 MB of heap) and a 21 MB `sc_live_state` answer.
    Now at most 64 weapons, 16 countermeasure entries and 32 game events are decoded per frame (the surplus is
    ignored and noted as an anomaly), a frame with more than 5 000 fields is refused, and `sc_live_state` /
    `sc_live_events` cut their lists under 40 000 characters and say so. The 1 MiB message limit is kept.
  - A flood of empty messages used about half a core. Frames are now decoded at most about 33 times a second: the
    newest frame of a burst is kept and handled in the next slot, all frames are still counted in
    `frames_received`. The game's ~17 frames a second are unaffected.
  - The gRPC framer copied the whole buffer on every chunk. It now keeps a list of chunks and joins them once per
    message (100 000 one-byte chunks: well under a second).
  - Event data is cut to 80 characters per value (the ring already held 200 events and names are filtered).
  - The handler tracks 8 countermeasure kinds at most (a program could invent a new one per frame).
  - Limits are documented in `docs/TELEMETRY.md` and `SECURITY.md`.

### Fixed
- Stopping the telemetry reader while it was connecting could throw `ERR_HTTP2_INVALID_SESSION` from an event handler.
- The test suite no longer reaches the network. A status test ran the dump-repository probe against GitHub and timed
  out on a loaded CI; probes now take their sources as an argument, and `vitest.setup.ts` makes any test that opens a
  socket to another host fail, even if the code under test swallows the error. This found and fixed a second test that
  called a GitHub-backed tool for real.
- Tools no longer show full local paths (they hold the Windows user name): `scw_snapshot_save`, `scw_snapshot_list`,
  `sc_local_datasets` and the vocabulary source show the last three parts, as the log tools do; an unknown snapshot
  label no longer puts the full path in its error. `shortPath` moved to `core/paths.ts` (still re-exported by the log
  reader).

## [2.0.0] - 2026-11-03

First release of the fork. Licence treated as GPLv3 (see THIRD_PARTY.md).

### Added
- **Provenance on every answer** (`source`, `channel`, `game_version`, `fetched_at`, `data_age`, `kind`, `trust`,
  `stale`) and `sc_data_status`, which shows each source's version, age, disagreements and outages.
- **SCMDB tools**: `scmdb_search_missions`, `scmdb_search_crafting`, `scmdb_search_mining`, `scmdb_changes`.
- **Game log tools** (off by default, read-only): `sc_log_status`, `sc_log_recent_events`, `sc_log_context`,
  `sc_log_sessions`; events verified on real logs across patches 4.0 to 4.10.
- **Fleet**: `sc_fleet_get`, `sc_fleet_upsert`, `sc_fleet_remove` on a local file; names matched by words with
  candidates when ambiguous.
- **`sc_patch_notes`**: the notes of an update from starcitizen.tools, by section or keyword. No RSI scraping.
- **Ship-sized trade routes** (`ship_name`), profit for the cargo that fits, player reports behind each price.
- **MCP prompts**: `haul_plan`, `patch_briefing`, `session_debrief`, `mining_prep`, `mission_hunt`.
- **Tool profiles** (`SCMCP_PROFILES`: core, trade, data, local) and explicit scoping (`SCMCP_TOOLS`).
- **Resilience**: retries on transient failures, rate limiting under each source's limit, disk cache served (flagged
  stale) only when a source is unreachable.
- **Tooling**: `npm run doctor`, `npm run check:sources`, `npm run install:claude` (minimal, backed-up merge of the
  Claude Desktop config), generated `docs/TOOLS.md`, `npm run golden:update`.
- Documentation, security model, third-party licence table, contribution guides, issue and PR templates, CI
  (lint, format, types, tests on Linux and Windows, production audit, signatures) and CodeQL.

### Changed
- Source split into `core`, `providers` and `tools`; every outbound request goes through a host-allowlisted client
  that attaches the UEX token only to UEX hosts and checks redirects.
- Default UEX host is the documented `api.uexcorp.uk`.
- Cache, snapshot and config folders are per-user instead of the working directory; the GitHub token is the
  dedicated `SCMCP_GITHUB_TOKEN`; `.env` is read from the package folder only.
- Descriptions of the tools rewritten for model selection.

### Fixed
- `uex_get_trade_routes` always failed (UEX requires an origin) and its profit was UEX's figure for the route's
  maximum volume (for example 100,000 SCU), not the player's cargo.
- `scw_get_vehicle`, `scw_get_item` and `scw_get_ship_comparison` returned "Result too large" for most ships.
- Dataset names with `:` (Windows drive letters, alternate data streams) are refused.
- Repository names accepted `../x`; a dump commit id is validated before it enters a path.

### Removed
- Docker image publishing, semantic-release, `Dockerfile`, `install.sh`, `Makefile` (nothing is published).

### Security
- 0 advisories (production and development), CodeQL on every push, secret scanning and push protection enabled.
