# Security

## What this server is allowed to do

It runs locally over stdio and is **read-only toward the game and every remote service**.

It never: scrapes RSI, Erkul, SPViewer or SC Trade Tools; reads game memory; sends keys or automates the game;
writes in the game folder; extracts `Data.p4k`; or calls any remote write endpoint, including UEX data
submission. The only writes are local: the cache, wiki snapshots, and the fleet file.

**Live telemetry is opt-in and off by default.** The game has an undocumented local gRPC server
(`GRPC_CLIENT_SERVER_ENABLED`). This server can read it only when the user sets `SC_TELEMETRY=on` in its
entry; the game-side variable is set by a command the user runs (`npm run telemetry -- enable --apply`; without
`--apply` it only shows what it would do, and `disable` removes only what it set), never by the installer. Without
`SC_TELEMETRY=on` no gRPC/HTTP2 code is loaded and no connection is attempted. When on, it connects only to
`127.0.0.1:2942` (fixed in code, not configurable), sends only the empty `TelemetryStream` request, keeps
frames in memory, and never logs, writes or transmits them. What it reads, what it does not, and the risks of
using an undocumented game feature are in [docs/TELEMETRY.md](docs/TELEMETRY.md); read its Risks section first.

Contacted hosts are fixed in `src/core/http.ts` (plus the opt-in loopback telemetry port above, which is not a host and not HTTP): `api.uexcorp.uk`, `api.uexcorp.space`,
`api.star-citizen.wiki`, `star-citizen.wiki`, `starcitizen.tools`, `api.github.com`,
`raw.githubusercontent.com`. Nothing else, and no analytics or usage reporting of any kind.

## Threat model

| Threat                                                                                                                                                         | Defence                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Token leak.** The UEX token sent to the wrong host, through a redirect, an absolute URL or a configured base URL                                             | Hard-coded host allowlist per upstream, checked on every request and every redirect; https only; the token is attached per request after that check, never stored in default headers; base-URL overrides must be on the same allowlist or startup fails; the token lives in `.env` next to the package, never in the Claude config; tests prove no token reaches a non-allowlisted host                   |
| **Prompt injection through data.** Marketplace ads, wiki and website text, contract titles, and the maintainer's changelog can contain text aimed at the model | Every result carries `trust`. Third-party text is marked `untrusted_text`, stripped of invisible and bidi-control characters, shortened, and fenced; raw article text sits between `<<<UNTRUSTED_TEXT>>>` markers that cannot be closed from inside (fence markers are also defused inside structured values); a notice tells the model to treat it as data. This lowers the risk; it cannot remove it: do not give the model tools that act on what a listing says |
| **Stale data presented as fresh**                                                                                                                              | `fetched_at`, `cache_age`, `data_age`, `stale`; an outage serves old data only when flagged; 4xx errors never fall back to cache                                                                                                                                                                                                                                                                                       |
| **Source changes its format**                                                                                                                                  | Files are validated for the fields we read; an unsupported schema or changed shape is an explicit error, not an empty answer                                                                                                                                                                                                                                                                              |
| **Supply chain**                                                                                                                                               | `npm ci --ignore-scripts`; lockfile committed; `npm audit` (production, high+) and `npm audit signatures` block CI; actions pinned by commit SHA with `contents: read`; Dependabot for npm and actions; secret scanning and push protection on; nothing is published                                                                                                                                      |
| **Game log privacy**                                                                                                                                           | Off by default; only `*.log` files; read-only and lock-free; no network code in the module; the player's handle, account id and paths are never captured; shown paths are shortened to three parts                                                                                                                                                                                                        |
| **Local file tampering**                                                                                                                                       | The fleet file is refused if corrupt or from a newer version rather than overwritten; writes are atomic; dataset names reject `/`, `\`, `..` and `:`                                                                                                                                                                                                                                                      |
| **Any local program reads the telemetry.** The stream is unencrypted, has no token, accepts several clients and carries health, ship state and the aUEC balance | Not preventable by this server: it is the game's feature. Loopback only (not reachable from the network). Off by default. `docs/TELEMETRY.md` says it plainly. This server never logs, stores or sends frames; its diagnostics hold field numbers only |
| **A local program pretends to be the game** on port 2942 and sends hostile frames (crafted protobuf, huge or endless messages, text aimed at the model in names) | Hand-written decoder with hard limits: message 1 MiB (checked on the header, before the body is buffered), 5 000 fields per frame (a frame over it is refused), 64 weapons, 16 countermeasure entries and 32 game events per frame (the surplus is not decoded and an anomaly is noted), wire types, depth by schema; at most about 33 frames a second are decoded (the newest frame of a burst is never lost; the ones in between are counted but not decoded); the framer buffers chunks in a list and joins them once per message; event data is cut to 80 characters and the ring holds 200 events; an answer of `sc_live_state` or `sc_live_events` is cut under 40 000 characters (the payload, before the provenance envelope) and says so; one bad frame never stops the stream; five bad frames in a row make the state `incompatible`; strings from the stream are only passed on if they look like a game identifier (`[A-Za-z0-9_.-]`, 64 characters), otherwise replaced; diagnostics sets are bounded; sections keep their last value for 3 seconds only |
| **The aUEC balance reaches the model provider.** Tool results are part of the conversation | The balance is withheld unless the caller asks (`include_balance`); balance-change events are hidden by default; the prompts and `docs/USING_WITH_CLAUDE.md` tell Claude to ask the player first and to say where the figure came from |
| **Telemetry enabled without the user's knowledge** | Two explicit switches, neither set by installing or updating; `npm run telemetry -- enable` is a dry run unless `--apply`; without `SC_TELEMETRY=on` no HTTP/2 code is loaded and no connection is made (`npm run check:telemetry-silence` proves it on the built server; a test proves the module graph); the address is a constant in code |
| **The telemetry command damages the Claude Desktop configuration** | The file is edited as text: only the `SC_TELEMETRY` key is inserted, changed or removed (CRLF, indentation, numbers, BOM kept); if the result is not exactly what was expected nothing is written and the line to add by hand is printed; timestamped backup first; atomic write; tests use temporary files and a fake environment store; no secret is ever printed |
| **Reading the game's undocumented feature has consequences with the publisher** | Not a technical defence and not ours to settle. `docs/TELEMETRY.md` (Risks) states that the feature is undocumented, that CIG has neither allowed nor forbidden it to our knowledge, that the game can see that a client is connected, and that the risk is the user's. Nothing in this project calls it safe, undetectable or approved |
| **Hostile contribution.** Prompt injection in docs, prompts or tool descriptions; hidden characters; poisoned dependency | A human reviews every pull request, whoever or whatever wrote it. `npm run check:docs` runs in CI and in the tests: it refuses invisible, bidi and tag characters, HTML comments and active tags in Markdown, look-alike letters, links to hosts that have not been reviewed, and translations that change an identifier. Same dependency rules as for the supply chain: no new dependency without a reason, no install script, no native code (see CONTRIBUTING.md) |
| **Another project's `.env`**                                                                                                                                   | Only the `.env` next to the package is read, never the working directory's                                                                                                                                                                                                                                                                                                                                |

## Unverified: extracting game files

Whether extracting `Data.p4k` (with community tools) could affect an account was researched and **not
established**: no statement from CIG on the subject was found, and no report either way about Easy
Anti-Cheat and offline file reading. Reading files from disk is not what anti-cheat watches (memory, injection),
but that is a general expectation, not a verified fact for this game. This project therefore ships no extraction
code and gives no instructions for it. If you do it yourself, you accept that risk.

## Repository protection

Set on GitHub, not in the code, so the review rule in the threat model is enforced and not only promised:

- A ruleset on `main`: changes arrive by pull request only (squash merge), the four CI checks must pass (lint, tests
  and build on Ubuntu and Windows; dependency audit; CodeQL analysis), and force pushes and deletion are refused.
  No one is exempt from it.
- Workflow runs of pull requests from outside contributors wait for a maintainer's approval, every time.
- Only GitHub Actions pinned by commit SHA may run.
- Private vulnerability reporting, secret scanning with push protection, Dependabot alerts and CodeQL are on.

A maintainer who is alone on the project reviews their own changes with the CI and with independent read-only review
passes; there is no second human. That is a limit, and it is stated here on purpose.

## Reporting a vulnerability

Open a private security advisory on this repository (Security tab, "Report a vulnerability"), or contact the
maintainer through GitHub. Please include the tool or file, what you expected, what happened, and a minimal
reproduction. Do not include real tokens or personal logs.
