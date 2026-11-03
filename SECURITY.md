# Security

## What this server is allowed to do

It runs locally over stdio and is **read-only toward the game and every remote service**.

It never: scrapes RSI, Erkul, SPViewer or SC Trade Tools; reads game memory; sends keys or automates the game;
writes in the game folder; extracts `Data.p4k`; or calls any remote write endpoint, including UEX data
submission. The only writes are local: the cache, wiki snapshots, and the fleet file.

**Live telemetry is opt-in and off by default.** The game has an undocumented local gRPC server
(`GRPC_CLIENT_SERVER_ENABLED`). This server can read it only when the user sets `SC_TELEMETRY=on` in its
entry; the game-side variable is set by a command the user runs, never by the installer. Without
`SC_TELEMETRY=on` no gRPC/HTTP2 code is loaded and no connection is attempted. When on, it connects only to
`127.0.0.1:2942` (fixed in code, not configurable), sends only the empty `TelemetryStream` request, keeps
frames in memory, and never logs, writes or transmits them. The risks are described in `docs/TELEMETRY.md`
(written in a later milestone).

Contacted hosts are fixed in `src/core/http.ts` (plus the opt-in loopback telemetry port above, which is not a host and not HTTP): `api.uexcorp.uk`, `api.uexcorp.space`,
`api.star-citizen.wiki`, `star-citizen.wiki`, `starcitizen.tools`, `api.github.com`,
`raw.githubusercontent.com`. Nothing else, and no analytics or usage reporting of any kind.

## Threat model

| Threat                                                                                                                                                         | Defence                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Token leak.** The UEX token sent to the wrong host, through a redirect, an absolute URL or a configured base URL                                             | Hard-coded host allowlist per upstream, checked on every request and every redirect; https only; the token is attached per request after that check, never stored in default headers; base-URL overrides must be on the same allowlist or startup fails; the token lives in `.env` next to the package, never in the Claude config; tests prove no token reaches a non-allowlisted host                   |
| **Prompt injection through data.** Marketplace ads, wiki and website text, contract titles, and the maintainer's changelog can contain text aimed at the model | Every result carries `trust`. Third-party text is marked `untrusted_text`, stripped of invisible and bidi-control characters, shortened, and fenced; raw article text sits between `<<<UNTRUSTED_TEXT>>>` markers that cannot be closed from inside; a notice tells the model to treat it as data. This lowers the risk; it cannot remove it: do not give the model tools that act on what a listing says |
| **Stale data presented as fresh**                                                                                                                              | `fetched_at`, `cache_age`, `data_age`, `stale`; an outage serves old data only when flagged; 4xx errors never fall back to cache                                                                                                                                                                                                                                                                                       |
| **Source changes its format**                                                                                                                                  | Files are validated for the fields we read; an unsupported schema or changed shape is an explicit error, not an empty answer                                                                                                                                                                                                                                                                              |
| **Supply chain**                                                                                                                                               | `npm ci --ignore-scripts`; lockfile committed; `npm audit` (production, high+) and `npm audit signatures` block CI; actions pinned by commit SHA with `contents: read`; Dependabot for npm and actions; secret scanning and push protection on; nothing is published                                                                                                                                      |
| **Game log privacy**                                                                                                                                           | Off by default; only `*.log` files; read-only and lock-free; no network code in the module; the player's handle, account id and paths are never captured; shown paths are shortened to three parts                                                                                                                                                                                                        |
| **Local file tampering**                                                                                                                                       | The fleet file is refused if corrupt or from a newer version rather than overwritten; writes are atomic; dataset names reject `/`, `\`, `..` and `:`                                                                                                                                                                                                                                                      |
| **Another project's `.env`**                                                                                                                                   | Only the `.env` next to the package is read, never the working directory's                                                                                                                                                                                                                                                                                                                                |

## Unverified: extracting game files

Whether extracting `Data.p4k` (with community tools) could affect an account was researched and **not
established**: no statement from CIG on the subject was found, and no report either way about Easy
Anti-Cheat and offline file reading. Reading files from disk is not what anti-cheat watches (memory, injection),
but that is a general expectation, not a verified fact for this game. This project therefore ships no extraction
code and gives no instructions for it. If you do it yourself, you accept that risk.

## Reporting a vulnerability

Open a private security advisory on this repository (Security tab, "Report a vulnerability"), or contact the
maintainer through GitHub. Please include the tool or file, what you expected, what happened, and a minimal
reproduction. Do not include real tokens or personal logs.
