# sc-copilot-mcp

[![CI](https://github.com/ms-spown/sc-copilot-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ms-spown/sc-copilot-mcp/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

English · [Français](README.fr.md)

A local, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that turns Claude
into a Star Citizen copilot: market and trade routes, ships, missions, crafting, mining, the patch you are
on, what your own game just logged, your fleet, and, only if you turn it on, what your ship reports live.

It runs on your PC over stdio. It does not touch the game: it never reads game memory, sends keys,
automates anything, or writes to the game folder. The only file of the game it can read is the `Game.log`
you point it at, and only if you do.

> Fork of [voidput/SCMCP](https://github.com/voidput/SCMCP) v1.5.0, hardened and extended (see [CHANGELOG](CHANGELOG.md)). The upstream
> `LICENSE` file is GPLv3 while its `package.json` and README said ISC; this fork is treated as GPLv3 (see
> [THIRD_PARTY.md](THIRD_PARTY.md)). Nothing is published to npm or Docker Hub from here: the `voidput/scmcp`
> image belongs to the upstream author.

## What you can ask

| Need | Examples | Main tools |
| --- | --- | --- |
| Trade | "Best haul from ArcCorp for my C2?" | `uex_get_trade_routes`, `uex_plan_trade`, `uex_get_commodity_prices` |
| Ships | "Cutlass Black or Freelancer? Where can I buy it?" | `scw_get_ship_comparison`, `scw_get_vehicle`, `uex_get_ship_prices` |
| Missions | "Which missions pay a blueprint in Pyro?" | `scmdb_search_missions`, `scmdb_search_crafting` |
| Hauling contracts | "Which hauling contracts suit my Cutlass Black? Which of these three offers pays most per hour?" | `scmdb_rank_hauling` |
| Mining | "Where is Quantainium and which laser copes with it?" | `scmdb_search_mining` |
| Refining | "Which refinery gives the best yield for my Laranite?" | `uex_get_refining_margins` |
| Components and gear | "Where is the Burst quantum drive cheapest? Burst or Voyage?" | `uex_get_item_prices`, `uex_compare_items` |
| Player market | "Is 3,000 a fair price for an MG Scrip?" | `uex_get_marketplace_prices` |
| Patches | "What changed in the last update?" | `sc_patch_notes`, `scmdb_changes` |
| Your game | "What am I doing right now? Debrief my last session." | `sc_log_context`, `sc_log_sessions` |
| Your fleet | "Which of my ships carries 300 SCU?" | `sc_fleet_get` |
| Your ship, live (off by default) | "Is my landing gear down? How much hydrogen is left?" | `sc_live_status`, `sc_live_state`, `sc_live_dashboard` |
| Freshness | "Is this data current?" | `sc_data_status` |

Seven ready-made prompts chain these for you (see [Prompts](#prompts)). Every capability, with its source, its
freshness, its limits and what it needs: **[docs/CAPABILITIES.md](docs/CAPABILITIES.md)**.

## What you get

Every answer says where it came from. Tool results are `{ provenance, data }`:

| `provenance` field        | Meaning                                                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `source`, `kind`          | Which source, and whether it is `datamined`, `crowdsourced`, `editorial`, `local_log`, `user` or `computed`                        |
| `channel`, `game_version` | `live`, `ptu` or `unknown` (never guessed), and the build when the source gives one                                                |
| `fetched_at`, `cache_age` | When this server fetched the data, and how long ago (a cache hit keeps the original time)                                          |
| `data_age`, `data_date`   | How old the DATA is, from dates the source gives (UEX row dates, SCMDB channel date); `null` when none, `data_age_note` says why  |
| `trust`                   | `untrusted_text` for text written by players or website editors: cleaned, shortened, and to be read as data, never as instructions |
| `stale`, `stale_reason`   | Present only when the live request failed and the last good copy was served                                                        |

`sc_data_status` shows the version each source is on, how old it is, where sources disagree (for example
LIVE builds `12881860` and `12913470`), and which are down. A failing source is reported with its error,
never as an empty answer. A rejected token (HTTP 401/403) is never hidden behind cached data.

## Install

You need Node.js 20.19+ (or 22.13+, or 24+) and Git.

```bash
git clone https://github.com/ms-spown/sc-copilot-mcp.git
cd sc-copilot-mcp
npm ci --ignore-scripts      # always --ignore-scripts: no dependency needs an install script
npm run build
```

1. **UEX token.** Create one yourself at <https://uexcorp.space/api/apps>, then copy `.env.example` to `.env`
   in this folder and paste it after `UEXTOKEN=`. The server reads that `.env`, never one from the working
   directory. Without a token the public UEX endpoints still answer; the token is only for your own quota.
   Use the _read_ key. Never use UEX's separate submission key: this server has no write tool for UEX.
2. **Claude Desktop.** The installer merges one entry into your config and touches nothing else:

   ```bash
   npm run install:claude -- --install-dir "C:\path\to\StarCitizen\LIVE"   # dry run: shows the entry, writes nothing
   npm run install:claude -- --install-dir "C:\path\to\StarCitizen\LIVE" --apply
   ```

   `--apply` first copies `claude_desktop_config.json` to a timestamped `.bak-…`, then adds or updates
   only `mcpServers["sc-copilot"]`. Your other servers are never shown or changed, and no secret is written
   there. Leave out `--install-dir` to keep the game log off. Restart Claude Desktop afterwards.
   **Re-running it replaces that entry's `env`**: only `SCMCP_PROFILES`, the log setting you pass and `SC_TELEMETRY`
   survive. Any other variable you added by hand (`SC_SESSIONS=off`, `SC_SESSION_GAP_HOURS`, `SCMCP_SESSIONS_FILE`,
   `SCMCP_FLEET_FILE`, `SCMCP_TOOLS`) is dropped, so `SC_SESSIONS=off` silently reverts: add them back to the `env` of
   the entry afterwards, or edit the entry by hand instead of re-running the installer (the dry run shows the new entry
   before anything is written). After a `git pull` and `npm run build` the existing entry keeps working: re-run the
   installer only to change the entry itself.
   On macOS or Linux pass `--config <path>`; or add the same entry by hand:

   ```json
   {
     "mcpServers": {
       "sc-copilot": {
         "command": "node",
         "args": ["/path/to/sc-copilot-mcp/dist/index.js"],
         "env": { "SCMCP_PROFILES": "core,trade,data,local" }
       }
     }
   }
   ```

3. **Check it.** `npm run doctor` checks your installation (Node, build, token, Claude config, game log, fleet
   file) and says how to fix each problem; nothing is sent anywhere and no secret is printed.
   `npm run check:sources` asks every data source for its version and checks the main UEX endpoints, every SCMDB file
   kind and the `Game.log` header (it does not cover every UEX path the tools use: the ones it checks are listed in
   `scripts/check-sources.mjs`). In Claude, ask for `sc_data_status`.

## Tools (65)

Claude sees 52 of them by default: `sc_live_state`, `sc_live_events`, `sc_live_dashboard`, `sc_live_poll`,
`sc_live_mark` and `sc_trade_suggest` are listed only when live telemetry is on (the last four, and `sc_session_export`,
also need a client that can show them, such as Claude Desktop), and the seven `sc_session_*` tools only when it is on and `SC_SESSIONS` is not `off`.

Full parameter reference: **[docs/TOOLS.md](docs/TOOLS.md)** (generated from the code). By theme:

| Theme                                  | Tools                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Freshness**                          | `sc_data_status`: game version per source, age, disagreements, which sources are down                                                                                                                                                                                                                                                                                                           |
| **Trading** (UEX)                      | `uex_get_trade_routes` (sized to your ship or cargo, profit for the cargo that fits, player reports behind each price), `uex_get_commodity_prices`, `uex_get_commodity_averages`, `uex_get_commodity_ranking`, `uex_get_commodities`, `uex_get_terminals`, `uex_get_terminal_inventory`, `uex_search_marketplace`, `uex_get_ship_prices`, `uex_get_game_versions`, `scw_search_ships_by_vendor`, `uex_get_refining_margins` (refineries ranked by reported yield bonus; a ranking, never an aUEC profit), `uex_get_item_prices` and `uex_compare_items` (components, weapons, armor, food: cheapest shop, stats, price age), `uex_get_marketplace_prices` (player-market price guide, units kept apart), `uex_get_price_history` (how a price has moved, with a verdict and its number of points), `uex_get_market_status` (shortage and saturation warnings), `uex_plan_trade` (trade options ranked by estimated profit per hour) |
| **Ships and items** (Wiki)             | `scw_get_vehicle`, `scw_get_item`, `scw_get_ship_comparison`, `scw_list_vehicles`, `scw_list_items`, `scw_get_filters`, `scw_search`, `scw_snapshot_save`, `scw_snapshot_list`, `scw_snapshot_diff`, `sc_get_vocabulary`                                                                                                                                                                        |
| **Missions, crafting, mining** (SCMDB) | `scmdb_search_missions`, `scmdb_search_crafting`, `scmdb_search_mining`, `scmdb_changes`, `scmdb_rank_hauling` (hauling contract families ranked for your ship, or the offers you read in the mobiGlas priced in time: estimates, never live availability)                                                                                                                                                                                                                                                                                                        |
| **Patches and lore**                   | `sc_patch_notes` (notes of an update, by section or keyword), `sct_search`, `sct_get_article`, `sc_list_builds`, `sc_diff_versions`                                                                                                                                                                                                                                                             |
| **Your game log** (off by default)     | `sc_log_context` (what you are doing now), `sc_log_recent_events`, `sc_log_sessions`, `sc_log_status`, `sc_trade_journal` (what you bought and sold, cargo runs)                                                                                                                                                                                                                                                                                           |
| **Live telemetry** (off by default)    | `sc_live_status` (always listed: state and how to enable), `sc_live_state`, `sc_live_events` (listed only when `SC_TELEMETRY=on`), `sc_live_dashboard`, `sc_live_poll`, `sc_live_mark`, `sc_trade_suggest` (the live dashboard, in Claude Desktop only)                                                                                                                                                                                                                                                               |
| **Saved play sessions** (with telemetry) | `sc_session_current` (the session so far, to accompany you and propose the next run), `sc_session_list`, `sc_session_stats` (efficiency, rate per hour, trend, best routes), `sc_session_new`, `sc_session_end`, `sc_session_debrief` (the session report to share or keep: Markdown by default, CSV on request, about 28,000 characters at most; amounts only with the balance), `sc_session_export` (the dashboard's own, the whole report); the dashboard has a session bar and a "Copier le bilan" control. Kept in a local file, see [docs/TELEMETRY.md](docs/TELEMETRY.md#saved-sessions) |
| **Your fleet**                         | `sc_fleet_get`, `sc_fleet_upsert`, `sc_fleet_remove`                                                                                                                                                                                                                                                                                                                                            |
| **Your own data files**                | `sc_local_datasets`, `sc_search_local`, `sc_read_local_collection`                                                                                                                                                                                                                                                                                                                              |

### Profiles

`SCMCP_PROFILES` picks what is advertised (comma-separated; unset advertises everything). `sc_data_status`
is always included. `SCMCP_TOOLS` (explicit names) wins over profiles; an unknown name stops the server
at startup instead of listing nothing. Scoping is for speed, not security: an unlisted tool can still be called.

| Profile   | Tools | For                                                                                  |
| --------- | ----- | ------------------------------------------------------------------------------------ |
| **core**  | 14    | The everyday copilot: status, ships, trade basics, missions, patch notes, your fleet |
| **trade** | 23    | The full UEX market toolbox, with refining, shop items, the player market and hauling contracts |
| **data**  | 16    | Reference data, crafting, mining, patch history, wiki browsing                       |
| **local** | 26    | Your game log, live telemetry and sessions, your fleet, your own data files          |

When to use which is in [docs/USING_WITH_CLAUDE.md](docs/USING_WITH_CLAUDE.md); each tool's description says
what it returns and its limits.

## Prompts

The server also offers ready-made prompts (in Claude Desktop they appear as templates you can pick), each chaining
the right tools in the right order and telling Claude to state how fresh the data is:

| Prompt            | What it does                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `trade_copilot`   | Reads your saved session, compares it with live UEX routes and proposes the next run, with the reasoning; needs telemetry and saved sessions |
| `haul_plan`       | Best 3 trade options for one of your ships, ranked by estimated profit per hour, with the risks (few reports, old data, saturated markets, too-good profit, illegal cargo) |
| `patch_briefing`  | What the newest update changed and what it means for you and your fleet                                           |
| `session_debrief` | What you did in your last session, from your game log, and what to do next                                        |
| `trade_review`    | Your recent purchases and sales from the game log: cargo runs with their gross margin, what to change, the next run |
| `mining_prep`     | An ore's stats and locations, the right laser and modules, where to sell it                                       |
| `mission_hunt`    | Missions by place, faction, reward or blueprint, and which of your ships fits                                     |

## Configuration

| Variable                                                         | Purpose                                                                                                                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UEXTOKEN`                                                       | UEX bearer token, in `.env`. Only ever sent to UEX hosts                                                                                                        |
| `SCMCP_PROFILES`, `SCMCP_TOOLS`                                  | Which tools to advertise (see above)                                                                                                                            |
| `SC_INSTALL_DIR`                                                 | A channel folder such as `…\StarCitizen\LIVE`: enables `sc_log_*` on its `Game.log`. Off if unset                                                               |
| `SC_SESSIONS`                                                    | `off` (also `0`, `false`, `no`) switches the saved play sessions off while telemetry stays on (no file created or read). They exist only with `SC_TELEMETRY=on` (see below) |
| `SCMCP_SESSIONS_FILE`                                            | Session file (default `%LOCALAPPDATA%\sc-copilot-mcp\data\sessions.json`); `npm run sessions -- wipe --apply` deletes it and its copies (a dry run without `--apply`) |
| `SC_SESSION_GAP_HOURS`                                           | Quiet time after which the next play period is a new session (default 3, from 0.25 to 48) |
| `SC_TELEMETRY`                                                   | `on` (also `1`, `true`, `yes`) switches the optional live telemetry on, server side. Off if unset (see below)                                                   |
| `SC_GAME_LOG_PATH`                                               | A specific `.log` file instead (only `.log` files are accepted)                                                                                                 |
| `SCMCP_FLEET_FILE`                                               | Fleet file (default `%APPDATA%\sc-copilot-mcp\fleet.json`)                                                                                                      |
| `SCMCP_CACHE_DIR`, `SCMCP_DATA_DIR`, `SCMCP_CONFIG_DIR`          | Cache (HTTP responses, dumps, SCMDB: can be deleted), data (wiki snapshots and `sessions.json`: keep) and config folders. Defaults are per-user (`%LOCALAPPDATA%` / `%APPDATA%` on Windows, XDG on Linux) |
| `SCMCP_SNAPSHOT_DIR`, `SCMCP_BUILD_CACHE_DIR`                    | Override the wiki snapshot folder and the folder where patch-dump builds are cached                                                                             |
| `SCMCP_UEX_BASE_URL`, `SCMCP_SCW_BASE_URL`, `SCMCP_SCT_BASE_URL` | Override an API base. Must be https on an allowlisted host or the server refuses to start                                                                       |
| `SCMCP_SCMDB_REPO`, `SCMCP_DATA_REPO`, `SCMCP_DATA_REPO_PATH`    | Where SCMDB and the patch dumps are read from                                                                                                                   |
| `SCMCP_GITHUB_TOKEN`                                             | Optional, raises the GitHub rate limit. Dedicated: an ambient `GITHUB_TOKEN` is never used                                                                      |
| `SCMCP_GAME_DATA_DIR`                                            | Folder of `game-*.json` you already have, for `sc_*_local` (see limits)                                                                                         |

## The game log

Off until you set `SC_INSTALL_DIR` or `SC_GAME_LOG_PATH`. Read-only, no lock (the game keeps writing), no
network code, personal data never captured (no handle, account id or personal path in any answer).

Reported, because each was seen in real logs of this install across patches 4.0 to 4.10: session start and quit,
login, jurisdiction and zone changes (armistice, monitored space, private property), contracts accepted, completed,
failed or abandoned (followed through their mission id), objectives, hauling pickups and drop-offs, blueprints
received, shop purchases, insurance claims, hangar requests and queue, the ship whose comms channel you joined or
left, and jump-point transits between systems. `sc_log_context` turns these into "what am I doing now", and
`sc_log_sessions` into a table of your recent sessions.

`sc_trade_journal` is your personal trade journal, built from the same log: shop purchases and sales, cargo-kiosk
purchases and sales (in SCU), the outcome of each, spending by category (inferred from the item class name), and
cargo runs that pair purchases and sales of one commodity into a **gross** margin. The log has no wallet balance, no
autoload fee and no success line for cargo (it is inferred from the absence of an error), so there is no net result
and the figures are estimates. Commodity names come from the wiki's public commodity list, matched locally on the
game's GUID (nothing from your log is sent); otherwise the commodity is "unknown commodity".

**Not in the log, so never reported:** ordinary quantum travel, combat and kills, wallet balance, your position, a
death. Every context field is "the last time the game logged it", not a live reading. Unknown lines are ignored and
counted. CIG does not guarantee the format; `npm run check:sources` shows if the header still parses.

## Live telemetry (optional, off by default)

The game has an undocumented local telemetry server. If you choose, this server can read it so that Claude can
answer about your ship and character right now: speed, altitude, hydrogen, landing gear, power, warning lights,
health, hunger, thirst. **Read the [risks](docs/TELEMETRY.md#risks) before you switch it on**: it is an undocumented
game feature, and the risk is yours. Everything else is in [docs/TELEMETRY.md](docs/TELEMETRY.md) (it opens with a
short "Read this first" block).

- **Off unless you switch on two things:** `SC_TELEMETRY=on` in the server entry, and
  `GRPC_CLIENT_SERVER_ENABLED=true` in the environment of the RSI Launcher. Nothing is set by installing or
  updating. Without the first, no connection is ever attempted.
- **One command:** `npm run telemetry -- status` shows both switches and changes nothing. `npm run telemetry -- enable`
  is a dry run, `npm run telemetry -- enable --apply` does it and `npm run telemetry -- disable --apply` undoes
  what it set (it does not delete your saved sessions: see the next point). Then quit the RSI Launcher completely
  (tray icon too) and start it again.
- **What it never does:** talk to anything but `127.0.0.1:2942`, send the game anything except an empty request, or
  log, write or send the frames.
- **What it saves, and where.** Frames and raw log lines stay in memory and are never written. The one exception is the session summary: the balance at the start and at the last sighting; the game version, the times (including how long the game was seen running) and the breaks; the last place and goods the log named; your note; the count of refused prices; and, for each trip, its label (contract title, places, goods), quantity, cost, revenue, margin, fees, net and the applied plan (planned profit, quantity, terminals). It is kept in a local file, `sessions.json`, only when telemetry is on; this server never sends it anywhere, except that the `sc_session_*` tools return parts of it to your MCP client, and so to your conversation (the money figures only with `include_balance`); `SC_SESSIONS=off` disables it; and deleting `sessions.json` and the `.bak` and `.corrupt` copies next to it erases it. The file is in `%LOCALAPPDATA%\sc-copilot-mcp\data` (see [Saved sessions](docs/TELEMETRY.md#saved-sessions)).
- **What it cannot see:** position, shield level, hull, heat, ammo, power distribution or quantum fuel. Health 0
  means down or dead. The aUEC balance is withheld from Claude unless you agree (`include_balance`).
- **A live dashboard (optional).** With telemetry on, Claude Desktop can show a live dashboard in the conversation
  (`sc_live_dashboard`): the ship, three dials, the alerts of the moment (shields cut in quantum mode, power lost, hostile
  lock...) and a one-line verdict in a compact view; a cockpit with dials, a compass, a power diagram, warning lights,
  weapons, pilot vitals and one chronology in full screen. Only the most recent dashboard calls the game's data; the
  older ones follow it. Every value shows its age, nothing is invented, the aUEC balance stays hidden until you click,
  and nothing is sent to the game. The speed dial uses the ship's limits from the Star Citizen Wiki when exactly one
  sheet fits the ship (labelled "wiki"), and says so when it keeps its own scale. Claude Code does not display it. See
  [docs/TELEMETRY.md](docs/TELEMETRY.md#live-dashboard). **Unverified:** the layout was tested in a browser against
  a fake host, and a throwaway test page was displayed in Claude Desktop, but the maintainer has not yet seen this
  dashboard itself inside Claude Desktop (see [docs/ROADMAP.md](docs/ROADMAP.md)).
- **A transport ledger (optional, needs the game log).** In that dashboard, the contracts of the session with their
  pickup and drop-off steps (when the log carries them: absent from the build 4.10 logs of the reference install) and, once you show the balance, the raw balance change over each completed contract; the
  game log has no quantity and no reward. See [docs/TELEMETRY.md](docs/TELEMETRY.md#transport-ledger).
- **Read the risks first.** It is an undocumented game feature. As far as we know CIG has neither allowed nor
  forbidden using it, the RSI terms apply to you, and the risk is yours. The details are in
  [docs/TELEMETRY.md](docs/TELEMETRY.md#risks), and the rest of that page explains everything above.

## Limits you should know

- **Crowdsourced prices can be wrong.** Read `data_age` (null means UEX gave no date) and the per-row `updated_at`, and sanity-check a route before flying 696 SCU.
- **Patch history is thin.** The patch-dump repository now holds two unlabelled builds, so `sc_diff_versions`
  has little to compare. `scmdb_changes` is the working answer for "what changed".
- **PTU is labelled, never mixed in.** SCMDB has PTU data; UEX and the wiki do not.
- **Sources lag each other.** Builds differ for hours or days; `sc_data_status` shows it.
- **`sc_*_local` read files you already have** in `SCMCP_GAME_DATA_DIR`. This project does not extract game
  files and does not document how; whether doing so is safe for your account is unverified (see
  [SECURITY.md](SECURITY.md)).
- **Live telemetry is not a full instrument panel.** No position, shields, hull, heat or ammo, ground vehicles send
  nothing, and events are inferred (see [docs/TELEMETRY.md](docs/TELEMETRY.md)).
- Wiki name lookups are strict; the fleet tool matches by words and lists candidates when unsure.

## Documentation

- [docs/CAPABILITIES.md](docs/CAPABILITIES.md): everything it can do, need by need
- [docs/TOOLS.md](docs/TOOLS.md): every tool and parameter (generated)
- [docs/ROADMAP.md](docs/ROADMAP.md): where the project stands, what is next, what is verified and what is not
- [docs/TELEMETRY.md](docs/TELEMETRY.md): the optional live telemetry, its data and its risks
- [docs/USING_WITH_CLAUDE.md](docs/USING_WITH_CLAUDE.md): the block to paste into a Claude project, what the server
  already tells Claude by itself, and a canary test to check it
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
  [docs/ADDING_A_TOOL.md](docs/ADDING_A_TOOL.md)
- [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md)

## Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). First steps: `npm run doctor`, then `npm run check:sources`.

## Development

```bash
npm ci --ignore-scripts
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npm run check:docs && npm run check:page-size && npm run test:built && npm run audit:prod
```

The `&&` chain works in cmd, Git Bash and PowerShell 7; in Windows PowerShell 5.1 run the commands one per line.
See [CONTRIBUTING.md](CONTRIBUTING.md), including the new-patch procedure. Security model: [SECURITY.md](SECURITY.md).

## Credits and notices

See [NOTICE](NOTICE) and [THIRD_PARTY.md](THIRD_PARTY.md). Data from [UEX Corp](https://uexcorp.space/),
the [Star Citizen Wiki](https://star-citizen.wiki/), [Star Citizen Tools](https://starcitizen.tools/),
[SCMDB](https://github.com/KrovaxCode/SCMDB_DATA) and the community dump repository; thanks to all of them.

<p align="center">
  <a href="https://uexcorp.space/"><img src="image.png" alt="Powered by UEX" height="30"></a>
</p>

<p align="center">
  This is an unofficial Star Citizen fan project, not endorsed by or affiliated with the Cloud Imperium or
  Roberts Space Industries group of companies. All game content and materials are copyright Cloud Imperium
  Rights LLC and Cloud Imperium Rights Ltd. Star Citizen&reg;, Squadron 42&reg;, Roberts Space Industries&reg;
  and Cloud Imperium&reg; are registered trademarks of Cloud Imperium Rights LLC. All rights reserved.
</p>
