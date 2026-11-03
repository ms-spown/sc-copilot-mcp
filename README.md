# Star Citizen MCP (SCMCP)

[![CI](https://github.com/ms-spown/sc-copilot-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/ms-spown/sc-copilot-mcp/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

> **sc-copilot-mcp** is a fork of [voidput/SCMCP](https://github.com/voidput/SCMCP), being hardened and
> extended (work in progress, documentation below still describes the upstream project).
> The repository's `LICENSE` file is GPLv3; this fork is treated as GPLv3. Upstream's `package.json` and
> README said ISC, which contradicts it - that question is open with the author. Nothing is published to
> npm or Docker Hub from this fork: the `voidput/scmcp` image is the upstream author's, not ours.

A Model Context Protocol (MCP) server providing real-time access to Star Citizen market data, trade routes, and wiki information. This MCP is designed to enable AI assistants like Claude and Gemini to seamlessly retrieve the latest Star Citizen trading data and lore directly into your chat!

## Features
- **Commodity Prices & Averages:** Fetch current and historical pricing for commodities via UEX. Understand the economy.
- **Trade Routes:** Find profitable trade routes based on your cargo capacity and available investment. Maximize your aUEC.
- **Terminal & Location Data:** List trading terminals, outposts, and cities across systems like Stanton and Pyro.
- **Wiki Search:** Query the Star Citizen Wiki and Star Citizen Tools for ships, items, components, and lore.
- **Built-in Caching:** API responses are automatically cached in-memory for 5 minutes to significantly reduce latency and redundant network requests.

## Available Tools

### UEX Economy Tools
- `uex_get_commodities`: List all commodities in the game.
- `uex_get_commodity_prices`: Get current commodity prices (filterable by system, planet, and terminal).
- `uex_get_commodity_averages`: Get historical average prices over time.
- `uex_get_terminals`: List trading terminals (filterable by system and planet).
- `uex_get_trade_routes`: Find optimized, high-profit trade routes based on your ship's SCU and starting investment.
- `uex_get_commodity_ranking`: Rank commodities by their profitability metrics.

### Star Citizen Wiki Tools
- `scw_search`: Search the Star Citizen Wiki for any topic.
- `scw_get_vehicle`: Retrieve detailed ship and ground vehicle data, including manufacturer and stats.
- `scw_get_item`: Retrieve weapon, armor, and ship component data.

### Star Citizen Tools (starcitizen.tools)
- `sct_search`: Search Star Citizen Tools (starcitizen.tools) for any topic.
- `sct_get_article`: Get the text content of an article from Star Citizen Tools (e.g. for lore, character info, or detailed guides).

### Patch History & Extracted Game Data
- `sc_list_builds`: List the game builds that have a data dump, newest first.
- `sc_diff_versions`: Diff any dataset between two patches — what was added, removed, and every changed field for one ship, weapon or component.
- `sc_local_datasets` / `sc_search_local` / `sc_read_local_collection`: Query the game data extracted from your own install — mining spawns, blueprints, missions, reputation and Wikelo trades, none of which any public API serves.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `UEXTOKEN` | for UEX tools | UEX Corp API bearer token |
| `GITHUB_TOKEN` | no | Raises the GitHub rate limit when listing or fetching build dumps |
| `SCMCP_DATA_REPO` | no | Data repo holding the per-build dumps (default `voidput/sc-gamedata-dumps`) |
| `SCMCP_DATA_REPO_PATH` | no | Path to the dumps inside that repo (default `data`) |
| `SCMCP_BUILD_CACHE_DIR` | no | Where fetched dumps are cached (default `.build-cache/`) |
| `SCMCP_GAME_DATA_DIR` | no | Directory of local `game-*.json` files, for the `sc_*_local` tools |
| `SCMCP_SNAPSHOT_DIR` | no | Where wiki-API snapshots are written (default `.snapshots/`) |
| `SCMCP_UEX_BASE_URL` | no | UEX API base (default `https://api.uexcorp.uk/2.0`). Must be https on `api.uexcorp.uk` or `api.uexcorp.space`, otherwise the server refuses to start |
| `SCMCP_SCW_BASE_URL` | no | Star Citizen Wiki API base (default `https://api.star-citizen.wiki/api/v2`), same allowlist rule |
| `SCMCP_SCT_BASE_URL` | no | Star Citizen Tools base (default `https://starcitizen.tools`), same allowlist rule |

## Installation & Local Development

Create a `.env` file in the root directory and add your UEX API token:
```env
UEXTOKEN=your_uex_api_token
```

### Automated Setup

We provide a convenient installation script that will build the MCP and automatically add it to your Claude Code or Gemini CLI:
```bash
./install.sh
```

### Manual Setup

Install dependencies:
```bash
npm install
```

Run linting and formatting:
```bash
npm run lint
npm run format
```

Run tests:
```bash
npm run test
```

Start the MCP server:
```bash
npm run build
npm start
```

## Docker

No image is published for this fork. The `Dockerfile` is kept for building one locally
(`docker build -t sc-copilot-mcp .`); do not pull `voidput/scmcp`, which is the upstream
author's image and not built from this code.

## Credits & Data Sources

SCMCP stores no game data of its own — every answer comes from somebody else's
work. Each request carries a `sc-copilot-mcp/<version> (+https://github.com/ms-spown/sc-copilot-mcp)`
User-Agent so these projects can see who is calling.

| Source | Used for | Terms |
| --- | --- | --- |
| [UEX Corp](https://uexcorp.space/) ([API](https://uexcorp.space/api/documentation/)) | Commodity prices, terminals, trade routes, ship purchase/rental locations | Requires an API token and attribution — see the "Powered by UEX" badge below |
| [Star Citizen Wiki](https://star-citizen.wiki/) ([API](https://api.star-citizen.wiki/api/v2)) | Ships, items, components, shop data | Content [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) — **non-commercial** |
| [Star Citizen Tools](https://starcitizen.tools/) | Article search and lore text | Content [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| [StarBreaker](https://github.com/diogotr7/StarBreaker) | Local DataCore/DataForge extraction behind `sc_*_local` tools | Reverse-engineering toolkit |
| [Model Context Protocol SDK](https://github.com/modelcontextprotocol) | The MCP server itself | MIT |

Wiki text reproduced through this server stays under its own licence: attribute
the wiki it came from and share alike. The Star Citizen Wiki's content is
non-commercial — that restriction travels with the data, not with this server.

This is an unofficial Star Citizen fan project, published non-commercially. It
uses no Cloud Imperium assets, artwork or branding of any kind.

This site is not endorsed by or affiliated with the Cloud Imperium or Roberts
Space Industries group of companies. All game content and materials are
copyright Cloud Imperium Rights LLC and Cloud Imperium Rights Ltd. Star
Citizen®, Squadron 42®, Roberts Space Industries®, and Cloud Imperium® are
registered trademarks of Cloud Imperium Rights LLC. All rights reserved.

## Release & Versioning

Releases are manual in this fork: there is no semantic-release and nothing is published automatically.
Conventional commit messages (`feat:`, `fix:`) are still welcome.

---

<p align="center">
  <a href="https://uexcorp.space/">
    <img src="image.png" alt="Powered by UEX" height="30">
  </a>
</p>

<p align="center">
  This site is not endorsed by or affiliated with the Cloud Imperium or Roberts Space Industries group of companies.<br>
  All game content and materials are copyright Cloud Imperium Rights LLC and Cloud Imperium Rights Ltd.<br>
  Star Citizen&reg;, Squadron 42&reg;, Roberts Space Industries&reg;, and Cloud Imperium&reg; are registered trademarks of Cloud Imperium Rights LLC. All rights reserved.
</p>
