# sc-copilot-mcp

[![CI](https://github.com/ms-spown/sc-copilot-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ms-spown/sc-copilot-mcp/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

A local, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that turns Claude
into a Star Citizen copilot: market and trade routes, ships, missions, crafting, mining, the patch you are
on, what your own game just logged, and your fleet.

It runs on your PC over stdio. It does not touch the game: it never reads game memory, sends keys,
automates anything, or writes to the game folder. The only file of the game it can read is the `Game.log`
you point it at, and only if you do.

> Fork of [voidput/SCMCP](https://github.com/voidput/SCMCP) v1.5.0, hardened and extended (see [CHANGELOG](CHANGELOG.md)). The upstream
> `LICENSE` file is GPLv3 while its `package.json` and README said ISC; this fork is treated as GPLv3 (see
> [THIRD_PARTY.md](THIRD_PARTY.md)). Nothing is published to npm or Docker Hub from here: the `voidput/scmcp`
> image belongs to the upstream author.

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
   `npm run check:sources` asks every data source for its version and verifies the files and fields the tools rely
   on. In Claude, ask for `sc_data_status`.

## Tools (42)

Full parameter reference: **[docs/TOOLS.md](docs/TOOLS.md)** (generated from the code). By theme:

| Theme                                  | Tools                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Freshness**                          | `sc_data_status`: game version per source, age, disagreements, which sources are down                                                                                                                                                                                                                                                                                                           |
| **Trading** (UEX)                      | `uex_get_trade_routes` (sized to your ship or cargo, profit for the cargo that fits, player reports behind each price), `uex_get_commodity_prices`, `uex_get_commodity_averages`, `uex_get_commodity_ranking`, `uex_get_commodities`, `uex_get_terminals`, `uex_get_terminal_inventory`, `uex_search_marketplace`, `uex_get_ship_prices`, `uex_get_game_versions`, `scw_search_ships_by_vendor` |
| **Ships and items** (Wiki)             | `scw_get_vehicle`, `scw_get_item`, `scw_get_ship_comparison`, `scw_list_vehicles`, `scw_list_items`, `scw_get_filters`, `scw_search`, `scw_snapshot_save`, `scw_snapshot_list`, `scw_snapshot_diff`, `sc_get_vocabulary`                                                                                                                                                                        |
| **Missions, crafting, mining** (SCMDB) | `scmdb_search_missions`, `scmdb_search_crafting`, `scmdb_search_mining`, `scmdb_changes`                                                                                                                                                                                                                                                                                                        |
| **Patches and lore**                   | `sc_patch_notes` (notes of an update, by section or keyword), `sct_search`, `sct_get_article`, `sc_list_builds`, `sc_diff_versions`                                                                                                                                                                                                                                                             |
| **Your game log** (off by default)     | `sc_log_context` (what you are doing now), `sc_log_recent_events`, `sc_log_sessions`, `sc_log_status`                                                                                                                                                                                                                                                                                           |
| **Your fleet**                         | `sc_fleet_get`, `sc_fleet_upsert`, `sc_fleet_remove`                                                                                                                                                                                                                                                                                                                                            |
| **Your own data files**                | `sc_local_datasets`, `sc_search_local`, `sc_read_local_collection`                                                                                                                                                                                                                                                                                                                              |

### Profiles

`SCMCP_PROFILES` picks what is advertised (comma-separated; unset advertises everything). `sc_data_status`
is always included. `SCMCP_TOOLS` (explicit names) wins over profiles; an unknown name stops the server
at startup instead of listing nothing. Scoping is for speed, not security: an unlisted tool can still be called.

| Profile   | Tools | For                                                                                  |
| --------- | ----- | ------------------------------------------------------------------------------------ |
| **core**  | 14    | The everyday copilot: status, ships, trade basics, missions, patch notes, your fleet |
| **trade** | 12    | The full UEX market toolbox                                                          |
| **data**  | 16    | Reference data, crafting, mining, patch history, wiki browsing                       |
| **local** | 11    | Your game log, your fleet, your own data files                                       |

When to use which is in [docs/USING_WITH_CLAUDE.md](docs/USING_WITH_CLAUDE.md); each tool's description says
what it returns and its limits.

## Prompts

The server also offers ready-made prompts (in Claude Desktop they appear as templates you can pick), each chaining
the right tools in the right order and telling Claude to state how fresh the data is:

| Prompt | What it does |
| --- | --- |
| `haul_plan` | Best 3 trade routes for one of your ships, with the risks (few reports, old data, too-good profit, illegal cargo) |
| `patch_briefing` | What the newest update changed and what it means for you and your fleet |
| `session_debrief` | What you did in your last session, from your game log, and what to do next |
| `mining_prep` | An ore's stats and locations, the right laser and modules, where to sell it |
| `mission_hunt` | Missions by place, faction, reward or blueprint, and which of your ships fits |

## Configuration

| Variable                                                         | Purpose                                                                                                                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UEXTOKEN`                                                       | UEX bearer token, in `.env`. Only ever sent to UEX hosts                                                                                                        |
| `SCMCP_PROFILES`, `SCMCP_TOOLS`                                  | Which tools to advertise (see above)                                                                                                                            |
| `SC_INSTALL_DIR`                                                 | A channel folder such as `…\StarCitizen\LIVE`: enables `sc_log_*` on its `Game.log`. Off if unset                                                               |
| `SC_GAME_LOG_PATH`                                               | A specific `.log` file instead (only `.log` files are accepted)                                                                                                 |
| `SCMCP_FLEET_FILE`                                               | Fleet file (default `%APPDATA%\sc-copilot-mcp\fleet.json`)                                                                                                      |
| `SCMCP_CACHE_DIR`, `SCMCP_DATA_DIR`, `SCMCP_CONFIG_DIR`          | Cache (HTTP responses, dumps, SCMDB), data (wiki snapshots) and config folders. Defaults are per-user (`%LOCALAPPDATA%` / `%APPDATA%` on Windows, XDG on Linux) |
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

**Not in the log, so never reported:** ordinary quantum travel, combat and kills, wallet balance, your position, a
death. Every context field is "the last time the game logged it", not a live reading. Unknown lines are ignored and
counted. CIG does not guarantee the format; `npm run check:sources` shows if the header still parses.

## Limits you should know

- **Crowdsourced prices can be wrong.** Read `data_age` (null means UEX gave no date) and the per-row `updated_at`, and sanity-check a route before flying 696 SCU.
- **Patch history is thin.** The patch-dump repository now holds two unlabelled builds, so `sc_diff_versions`
  has little to compare. `scmdb_changes` is the working answer for "what changed".
- **PTU is labelled, never mixed in.** SCMDB has PTU data; UEX and the wiki do not.
- **Sources lag each other.** Builds differ for hours or days; `sc_data_status` shows it.
- **`sc_*_local` read files you already have** in `SCMCP_GAME_DATA_DIR`. This project does not extract game
  files and does not document how; whether doing so is safe for your account is unverified (see
  [SECURITY.md](SECURITY.md)).
- Wiki name lookups are strict; the fleet tool matches by words and lists candidates when unsure.

## Troubleshooting

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). First steps: `npm run doctor`, then `npm run check:sources`.

## Development

```bash
npm ci --ignore-scripts && npm run lint && npm test && npm run build && npm run audit:prod
```

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
