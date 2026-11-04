# What sc-copilot-mcp can do

A guide to every capability of the server, for a player who is discovering it and for a developer who wants
to know exactly what each tool reads, how fresh it is and where it stops. The exact parameters of each tool
are in [TOOLS.md](TOOLS.md) (generated from the code); this page explains what to use for which need.

## Introduction

sc-copilot-mcp is a local [Model Context Protocol](https://modelcontextprotocol.io) server. It runs on your PC
over stdio and gives Claude tools to answer Star Citizen questions: market and trade routes, ships and items,
missions, crafting, mining, patch notes, what your own game just logged, your fleet and, if you switch it on,
live telemetry.

65 tools exist. While live telemetry is off (the default) 52 are listed to the client, because `sc_live_state`,
`sc_live_events`, `sc_live_dashboard`, `sc_live_poll`, `sc_live_mark` and `sc_trade_suggest` are hidden until telemetry
is on, and so are the seven session tools (`sc_session_current`, `sc_session_list`, `sc_session_stats`,
`sc_session_new`, `sc_session_end`, `sc_session_debrief`, `sc_session_export`). The app-only tools (the four of the dashboard and `sc_session_export`) are listed only to a client that can show them
(Claude Desktop), never to Claude Code, and are refused by name ("Unknown tool") to a client that did not declare the UI
extension; a host that does declare it and exposes them to the model is outside this server's control.

### What it does not do

- It is read-only toward the game and toward every remote service. The only things it writes are local: the
  cache, the wiki snapshots, your fleet file and, only with live telemetry on, your saved play sessions
  (`sessions.json`, see [section 9](#9-live-telemetry) and [SECURITY.md](../SECURITY.md)).
- It never scrapes RSI, Erkul, SPViewer or SC Trade Tools, never reads game memory, never sends keys, never
  automates the game and never writes in the game folder.
- It has no remote write tool, including UEX data submission, and no extraction of game files.
- It sends no analytics or usage reports. The hosts it may contact are fixed in the code (see
  [Profiles and settings](#12-profiles-settings-and-local-data-files)).
- The live dashboard is an optional MCP App, shown by Claude Desktop only and only with live telemetry on
  ([section 9](#9-live-telemetry)).

### How to read the provenance

Every tool result is `{ provenance, data }`. Text written by players or website editors is also preceded by a
`notice`. The `provenance` block says where the answer comes from and how much to trust it:

| Field | Meaning |
| --- | --- |
| `source`, `kind` | The source, and whether the data is `datamined`, `crowdsourced`, `editorial`, `local_log`, `local_telemetry`, `user` or `computed` |
| `channel` | `live`, `ptu` or `unknown`. It is never guessed: a source that cannot say gives `unknown` |
| `game_version` | The game version or build when the source gives one, otherwise `null` |
| `fetched_at`, `cache_age` | When this server got the data, and how long ago. This is the age of the retrieval, not of the data |
| `data_age`, `data_date` | The real age of the data itself, taken from dates the source gives (UEX price dates, the SCMDB channel date). `null` when the source gives none |
| `data_age_note` | What `data_age` is based on, or why it is `null`. Read it: a `null` is information, not a gap |
| `stale`, `stale_reason` | Present only when the live request failed and the last good copy was served instead |
| `trust` | `untrusted_text` when the answer contains text written by players or website editors: it is cleaned, shortened and fenced, and must be read as data, never as instructions. `structured` otherwise |

Only the UEX price, route and ship-price tools and the SCMDB tools fill `data_age`. Every other tool gives
`data_age: null` with a note, and only `cache_age` tells you when the data was fetched.

How the cache behaves: an answer is kept in memory for 5 minutes. A copy kept on disk is served instead of a
failed request only when the upstream is unreachable (no answer, timeout, HTTP 5xx or 429), is at most 7 days
old, and is then flagged `stale`. A client error such as a rejected token (HTTP 400, 401, 403, 404) is never
hidden behind old data.

### Which section answers my need

| I want to... | Section |
| --- | --- |
| Find where to buy or sell a commodity, plan a hauling run, find where to buy a ship | [1. Market and trade routes](#1-market-and-trade-routes-uex) |
| Look up a ship or an item, compare ships, read lore and guides | [2. Ships, items and lore](#2-ships-items-and-lore-wikis) |
| Find missions and contracts, or the mission that rewards a blueprint | [3. Missions](#3-missions-scmdb) |
| Know what a blueprint needs to craft | [4. Crafting](#4-crafting-scmdb) |
| Prepare a mining run | [5. Mining](#5-mining-scmdb) |
| Know what a patch changed, compare two patches | [6. Patches and patch notes](#6-patches-and-patch-notes) |
| Know what I did in my last session or what I am doing now, what I bought and sold, how a cargo run went | [7. Game log](#7-game-log-gamelog) |
| Choose or manage my ships | [8. Your fleet](#8-your-fleet) |
| Read live data from the running game | [9. Live telemetry](#9-live-telemetry) |
| Check how fresh the data is | [10. Data freshness](#10-data-freshness-and-source-status) |
| Start from a ready-made workflow | [11. MCP prompts](#11-mcp-prompts) |
| Narrow the tool list, set a folder or a variable, use my own `game-*.json` files | [12. Profiles, settings and local data files](#12-profiles-settings-and-local-data-files) |

## 1. Market and trade routes (UEX)

| Topic | Details |
| --- | --- |
| What it is for | Prices at terminals, best trade routes sized to your ship and budget, ranking of commodities, player marketplace ads and prices, where a ship can be bought or rented in game, where to buy a ship component, weapon, armor piece or food, which refinery to use for an ore, trade options ranked by estimated profit per hour (round trips and open chains), how a price has moved, and shortage and saturation warnings |
| Example questions | "Where do I sell Quantainium for the best price?" (Où vendre du Quantainium au meilleur prix ?) ; "Plan a hauling run for my C2 starting from ArcCorp with 200,000 aUEC" (Prépare-moi une route de transport avec mon C2 au départ d'ArcCorp, 200 000 aUEC) ; "Is Gold at 10,000 a good price?" (Est-ce qu'un prix de 10 000 pour l'or est bon ?) ; "Where can I buy a Carrack?" (Où acheter un Carrack ?) ; "What is the most profitable round trip per hour for my Cutlass Black, staying in armistice zones?" (Quel aller-retour rapporte le plus par heure avec mon Cutlass Black, en restant en zone d'armistice ?) ; "Is the Medical Supplies price at Lorville high right now?" (Le prix des fournitures médicales à Lorville est-il élevé en ce moment ?) ; "Is Laranite saturated anywhere?" (La laranite est-elle saturée quelque part ?) ; "Which commodity is the most profitable right now?" (Quelle marchandise rapporte le plus en ce moment ?) ; "Where is the Burst quantum drive cheapest, and how does it compare with the Voyage?" (Où le propulseur quantique Burst est-il le moins cher, et comment se compare-t-il au Voyage ?) ; "Is 3,000 aUEC a fair price for an MG Scrip?" (3 000 aUEC est-il un prix correct pour un MG Scrip ?) ; "Which refinery gives the best yield for Laranite?" (Quelle raffinerie donne le meilleur rendement pour la Laranite ?) |
| Tools | `uex_get_commodity_prices`, `uex_get_trade_routes`, `uex_get_commodity_averages`, `uex_get_commodity_ranking`, `uex_get_commodities`, `uex_get_terminals`, `uex_get_terminal_inventory`, `uex_search_marketplace`, `uex_get_ship_prices`, `uex_get_game_versions`, `scw_search_ships_by_vendor` (despite its prefix, this one reads UEX terminals, not the wiki), `uex_get_refining_margins`, `uex_get_item_prices`, `uex_compare_items`, `uex_get_marketplace_prices`, `uex_get_price_history`, `uex_get_market_status`, `uex_plan_trade` (reads UEX plus, for a named ship, the wiki sheet) |
| Source | UEX Corp, a crowdsourced database: prices are what players reported, plus UEX estimates for places nobody reported |
| Freshness | `uex_get_commodity_prices`, `uex_get_trade_routes` and `uex_get_ship_prices` give `data_age` from the `date_modified` of the rows returned and a per-row `updated_at`; `uex_get_refining_margins`, `uex_get_item_prices`, `uex_compare_items` and `uex_get_marketplace_prices` date their rows too (`data_age_days` and `stale` per row; refinery reports and shop prices are weeks old, not hours); `uex_get_price_history` and `uex_get_market_status` date every point or row (`age_days`, `stale`), and `uex_plan_trade` dates every leg (`price_age_days`, `stale`) and leaves prices older than `max_age_days` (default 7) out; the other UEX tools give `data_age: null`. `game_version` is the LIVE version UEX reports. Prices change within hours |
| Limits | `uex_get_trade_routes` needs an origin: at least one of `commodity_name`, `origin_terminal_name` or `origin_planet_name`, otherwise it returns an error. Profit is computed for the cargo that fits (`ship_name` or `cargo_capacity`, and `investment`), not for the route's maximum volume. Routes are ranked reported first, estimates (`is_estimate`) after; check `reports_origin` and `reports_destination` and `min_reports` before flying a long route. In `uex_get_commodity_prices`, rows from a game version older than LIVE are left out and counted, newer (PTU) rows are kept and counted. `uex_get_commodities` is truncated and is for finding names and legality. `uex_get_terminal_inventory` reads capability flags (what kinds of goods a terminal sells), not live stock. `uex_search_marketplace` sees at most the first 100 ads unless `id_item` and `operation` are both set (then 1,000), and ad text is written by players (`untrusted_text`). `uex_get_ship_prices` has no rows for ships sold only for real money. `scw_search_ships_by_vendor` lists vendors, not the ships on sale. **Refining** (`uex_get_refining_margins`): the yield figure is a bonus in percent that players reported per ore and refinery. UEX has no ratio between SCU of ore and SCU of refined product, no refining cost in aUEC and no processing time, so the tool RANKS (refineries for one ore; ores by an index where the best is 100) and never gives an aUEC profit. The refined product's price is UEX's undated commodity average; the ore's sale prices at refinery terminals are patchy and often old; the refinery `capacity` value has an unverified unit (UEX's documentation says percentage, values reach 1075), so it is shown but not used to rank. The refinery audit endpoint is never read (its rows carry a player's name). **Shop items** (`uex_get_item_prices`, `uex_compare_items`): UEX needs a category (or maker) to list items, so the category is a required input; at most three categories are opened per call (a wrong or too wide name returns the list of categories), at most four items are priced per call, and every answer is cut, and says so, if it would exceed the output limit; a price check (`check_price`) only uses lines whose unit UEX states as `unit`, and an ore ranking row carries the age of the report behind its best bonus. Item prices come per item (`items_prices`); the whole-catalogue dump `items_prices_all` (about 6 MB) is never used. Prices can be two to three months old: each row has `data_age_days`, `stale` (over 30 days) and `older_than_live`. The comparison gives numbers and differences, never a verdict on which value is better. **Player market** (`uex_get_marketplace_prices`): prices come as text from UEX and are converted; a price per `set`, `pack`, `stack` or `crate` is a bundle of an unstated size and is never compared with a per-unit price. The history endpoint is capped at 1000 rows (newest first) and the summary says when it is cut; the trend list holds at most the 500 most traded items and its prices carry no unit. UEX's `marketplace_averages` endpoint is deprecated and not used. Fuel prices are not offered: see the Fuel line below. **Trade intelligence**: `uex_get_price_history` rests on about 10 UEX snapshots over a few weeks: it says SHORT HISTORY, gives no verdict under 4 points, and cannot tell a player report from an estimate. `uex_get_market_status` reads the UEX stock levels, whose legend differs by side (selling, level 7 means no demand). `uex_plan_trade`: travel time is an ESTIMATE (ship quantum speed from the wiki sheet or `quantum_speed_ms`, UEX distances, 8 minutes per stop by default, `stop_minutes`); quantum fuel is never subtracted (UEX gives no usable unit, and its fuel prices are weeks old); the quantity is capped by the hold (whole SCU), the budget and the buy stock, not by the demand or the container sizes; a route between Stanton and Pyro is not planned; the safety field is a labelled heuristic built from UEX armistice data, never a promise (UEX holds no piracy data). `options` (one-way routes repeated, round trips) and `chains` (open A>B>C, no return leg priced) are two lists that are never ranked against each other. The order follows the objective: a price with no player report is tagged `[ESTIMATE]` (`report_status`, `report_counts`) but not ranked lower; `min_reports` requires reports and drops what could not be checked. A plan has a 25 s deadline and costs 15 to 28 requests typically on a cold cache (at most about 43 with `min_reports`: ship sheet 2, prices and places 5, orbit matrices up to 3, routes 1, terminal distances up to 5, report checks up to 12 or 25, fuel 1); a second plan within 5 minutes reuses them |
| Fuel | No fuel price tool on purpose. Checked on 2026-11-04 on UEX's `fuel_prices_all` (196 rows, Quantum and Hydrogen fuel): the median row is 43 days old and only 10 rows are under 7 days old. Prices do differ between terminals (Quantum Fuel from 815 to 3,165), but with data this old nobody can say whether they have moved, so a "cheapest refuel stop" would be a guess dressed as a fact. To be reconsidered if UEX's reports become fresher |
| Prerequisites | None. A UEX token in `UEXTOKEN` is optional; the server prints a notice when it is missing. Names must be exact for terminal, planet and system filters |
| Local or network | Network: `api.uexcorp.uk` (default; `api.uexcorp.space` is also allowed). The token is only ever sent to those hosts. Nothing is written except the cache |

## 2. Ships, items and lore (wikis)

| Topic | Details |
| --- | --- |
| What it is for | Specifications of a ship, vehicle, weapon, armor or ship component; side-by-side ship comparison; browsing by manufacturer, role, size or grade; lore, guides and mechanics from a community wiki; a list of in-game names for a speech recognizer |
| Example questions | "What are the specs of the Carrack?" (Quelles sont les caractéristiques du Carrack ?) ; "Compare the Cutlass Red and the Ursa Medivac" (Compare le Cutlass Red et l'Ursa Medivac) ; "List the size 2 military shields" (Liste les boucliers militaires de taille 2) ; "What is Wikelo?" (Qu'est-ce que Wikelo ?) ; "Which filters can I use to list vehicles?" (Quels filtres puis-je utiliser pour lister les véhicules ?) |
| Tools | `scw_get_vehicle`, `scw_get_item`, `scw_get_ship_comparison`, `scw_list_vehicles`, `scw_list_items`, `scw_get_filters`, `scw_search` (Star Citizen Wiki); `sct_search`, `sct_get_article` (Star Citizen Tools, lore and guides); `sc_get_vocabulary` (names merged from UEX, the wiki and, if configured, your local files) |
| Source | The Star Citizen Wiki API (datamined values, community-edited) and the Star Citizen Tools wiki (community-written articles) |
| Freshness | `data_age` is `null`; `cache_age` tells when it was fetched. The wiki API serves one environment, LIVE: it has no PTU data. `game_version` is the version of a wiki record |
| Limits | Name lookups are strict (`scw_search` finds the exact name first). Most ships exceed the output limit, so `scw_get_vehicle` returns the key figures with a note; use `scw_get_ship_comparison` to compare. A ship that cannot be found is reported as such, not dropped. `scw_search` and `sct_search` return at most 10 results. `sct_get_article` needs the exact title and cuts the text at 20,000 characters. Wiki text is community-written (`untrusted_text`). `sc_get_vocabulary` leaves out armor, clothes and ship components unless you ask for them |
| Prerequisites | None. `sc_get_vocabulary` adds locally extracted names only when `SCMCP_GAME_DATA_DIR` is set |
| Local or network | Network: `api.star-citizen.wiki` and `star-citizen.wiki` (the wiki API, rate-limited by the server to stay under the wiki's limit), `starcitizen.tools` (articles). `sc_get_vocabulary` also reads UEX (`api.uexcorp.uk`) |

## 3. Missions (SCMDB)

| Topic | Details |
| --- | --- |
| What it is for | Search the datamined mission list: reward, contractor, type, place, minimum reputation, illegality and the blueprints a mission can reward |
| Example questions | "Which missions pay the most in Pyro?" (Quelles missions paient le mieux à Pyro ?) ; "What gives the Corbel armor blueprint?" (Quelle mission donne le plan de l'armure Corbel ?) ; "Show me Wikelo missions" (Montre-moi les missions Wikelo) ; "Illegal hauling missions above 50,000 aUEC" (Missions de transport illégales à plus de 50 000 aUEC) ; "Is this mission new in the last patch?" (Cette mission est-elle nouvelle dans le dernier patch ?) |
| Tools | `scmdb_search_missions` (and `scmdb_changes`, see [Patches](#6-patches-and-patch-notes), for "is this mission new"); `scmdb_rank_hauling` for hauling contracts (below) |
| Source | SCMDB, a community mirror of datamined game data; `scmdb_rank_hauling` also reads UEX (places, distances, container sizes) and the wiki ship sheet (quantum speed) |
| Freshness | `data_age` is the date the SCMDB maintainer last regenerated the channel; `game_version` is that channel's build. SCMDB can lag a patch by hours or days; `sc_data_status` shows the gap |
| Limits | Rewards are datamined values, not what players see after modifiers. `time_to_complete` is passed through as the data gives it, and its unit is not stated by the source. Results are sorted by reward and capped at 30 (10 by default). A misspelled query or filter still finds the closest missions, and a filter that matches nothing says so in `note`. Mission titles and descriptions are third-party text (`untrusted_text`) |
| Prerequisites | None. LIVE by default; pass `channel` `ptu` for the test build, which may be absent (the tool then returns an error saying SCMDB has no PTU build) |
| Local or network | Network: `raw.githubusercontent.com` for the data files, `api.github.com` only to learn the current commit. Files are read on demand into your cache and answered in small pieces |

### Hauling contracts (`scmdb_rank_hauling`, `trade` profile)

SCMDB holds contract TEMPLATES (the 136 `Hauling*` definitions of LIVE 4.10.2 at the time of writing), not the offers on your mobiGlas: a pickup or a destination is a pool of candidates and the game picks the place when it offers the contract. So the tool never says a contract is available. It has two modes, and every figure carries how sure it is.

| Topic | Details |
| --- | --- |
| Mode `templates` | Ranks contract families (identical templates merged, `variants` counts them) for a ship: `ship_name` (hold and container sizes from UEX, quantum speed from the wiki sheet; `sc_fleet_get` lists your ships) or `cargo_scu` and `max_container_size`. Shows the fixed reward, the SCU range, the reward per SCU as a RANGE (reward over the largest SCU to reward over the smallest), the commodities, the required Hauling rank (`rank` filters by yours), whether the containers fit the ship, the trips the hold needs, the partial-payout table and flags (once only, cooldown, intro needed). Illegal contracts are left out unless `include_illegal`; contracts whose containers are too big are left out unless `include_unfit`. With a ship, suitability comes first (containers that fit, then one trip, then trips that depend on the SCU rolled, then several trips), then `sort` (`reward_per_scu` by the low end of the range, or `reward`). `reward_per_hour` is null: a template has no concrete pickup and drop-off |
| Mode `offers` | You (or Claude, from what you read in the mobiGlas) give 1 to 10 offers: reward, scu, pickup, dropoffs (1 to 6), optionally the largest container size. Places are resolved with UEX to an orbit (a name that fits several orbits is refused with suggestions, never guessed). The server estimates minutes and reward per hour for each offer (stops, hops and quantum flights), groups offers that share a pickup orbit into bundles of 2 to 4 whose SCU fit the hold in one trip, orders the drop-offs (exact search up to 6 stops, nearest neighbour above, flagged), and compares each bundle with the best single offer |
| Labels | `datamined`: reward, SCU, container size, rank, illegal flag, pools. `deduced`: an order with `maxSCU` 0 and a `minSCU` is read as a fixed quantity (flagged `scu_fixed_quantity_is_deduced`; not documented by the source). `estimated`: reward per SCU, minutes, reward per hour, bundles. `given_by_player`: the offers' numbers and names. `unknown`: null with its reason (placeholder commodity, order without SCU, availability, a route between two systems). `measured` never appears: no game log or telemetry is read |
| Assumptions | 8 minutes per stop and a 2 minute hop inside one orbit (both unmeasured; `stop_minutes` changes the first), straight quantum flights between UEX orbit centres. Not counted: the flight to the first pickup, anything after the last drop-off, loading time, quantum fuel, interdiction. No transit time between star systems (UEX has none): such a route has no hourly figure. An offer larger than the hold is timed as repeated trips. Container fit (the ship's largest container size at least the contract's) and trips (hold) are rules of thumb, not verified in game |
| Not used | `timeToComplete` (its unit is not stated by the source) is never shown as a duration and no rate is derived from it. Availability and frequency of a template are not in the data |
| Build and dates | The answer states the SCMDB channel and build of the file (it can differ from the build you play; `sc_data_status` shows the gap) and the provenance dates the channel. Titles and place names are third-party text (`untrusted_text`) |
| Requests | `templates`: SCMDB files (cached on disk by commit) and, for a named ship, 2 requests (UEX `/vehicles`, wiki sheet). `offers`: UEX `/terminals` (1), one orbit matrix per star system met (at most 3), and 2 for a named ship: at most 6, none on a repeat within 5 minutes. No per-pair distance request. The answer is cut to fit the output limit and says so |

## 4. Crafting (SCMDB)

| Topic | Details |
| --- | --- |
| What it is for | Find a blueprint and its recipe (resources and items per slot, minimum quality), craft time, and the missions that can reward it |
| Example questions | "What do I need to craft a mining laser?" (Que faut-il pour fabriquer un laser de minage ?) ; "What can I make with Quantainium?" (Que puis-je fabriquer avec du Quantainium ?) ; "Which missions reward this blueprint?" (Quelles missions donnent ce plan ?) ; "List the shield blueprints" (Liste les plans de boucliers) |
| Tools | `scmdb_search_crafting`; to find the mission that rewards a blueprint from the mission side, `scmdb_search_missions` with `reward_blueprint`; to compare blueprint data between two builds, `sc_diff_versions` with the `blueprints` dataset |
| Source | SCMDB (datamined) |
| Freshness | Same as [Missions](#3-missions-scmdb): `data_age` is the channel's generation date |
| Limits | Datamined recipes as the data gives them, capped at 30 rows (10 by default). A misspelled query, type or `uses_resource` still finds the closest blueprints, and a filter that matches nothing says so in `note`. Names of blueprints and missions are third-party text (`untrusted_text`). The server does not say how to obtain a resource in game |
| Prerequisites | None. LIVE by default, `channel` `ptu` on request |
| Local or network | Network: `raw.githubusercontent.com`, `api.github.com` (commit lookup). `include_sources` false skips loading the mission file, which is faster on the first call |

## 5. Mining (SCMDB)

| Topic | Details |
| --- | --- |
| What it is for | Ore reference (instability, resistance, optimal charge window, scan signatures, rarity, where it appears) and mining lasers, modules and gadgets with their modifiers |
| Example questions | "Where do I find Quantainium?" (Où trouver du Quantainium ?) ; "Which laser handles unstable rock?" (Quel laser gère la roche instable ?) ; "What scan signature does Hadanite have?" (Quelle signature de scan a l'Hadanite ?) ; "Prepare a mining run for Quantainium" (Prépare une session de minage de Quantainium) |
| Tools | `scmdb_search_mining`; to see where to sell an ore, `uex_get_commodity_prices`; to choose a refinery or compare ores once refined, `uex_get_refining_margins` (UEX yield reports, a ranking and not an aUEC profit: see [section 1](#1-market-and-trade-routes-uex)); the prompt `mining_prep` chains them |
| Source | SCMDB (datamined) |
| Freshness | Same as [Missions](#3-missions-scmdb) |
| Limits | Ranking is by datamined weights, not by live spawn rates; `relative_share` compares locations and is not a spawn probability. An unknown ore name returns the ore names that exist. Rows per section are capped at 30 (8 by default) |
| Prerequisites | None. `scope` limits the search to `ores`, `equipment` or `all` |
| Local or network | Network: `raw.githubusercontent.com`, `api.github.com` (commit lookup) |

## 6. Patches and patch notes

| Topic | Details |
| --- | --- |
| What it is for | What the newest update changed, by section or keyword; the datamined differences in missions, blueprints and items; comparing two builds of the game data; comparing ship or item stats between two snapshots you saved |
| Example questions | "What changed in the latest patch for hauling?" (Qu'est-ce que le dernier patch a changé pour le transport ?) ; "Show me the Bug fixes section of 4.10.2" (Montre-moi la section Bug fixes du 4.10.2) ; "Which blueprints were added in the last update?" (Quels plans ont été ajoutés dans la dernière mise à jour ?) ; "What changed on the Mantis between 4.9 and 4.10?" (Qu'est-ce qui a changé sur le Mantis entre la 4.9 et la 4.10 ?) ; "Did the Cutlass shield HP change since the snapshot I saved?" (Les PV de bouclier du Cutlass ont-ils changé depuis mon instantané ?) |
| Tools | `sc_patch_notes`, `scmdb_changes`, `sc_list_builds`, `sc_diff_versions`, `scw_snapshot_save`, `scw_snapshot_list`, `scw_snapshot_diff` |
| Source | `sc_patch_notes`: the Star Citizen Tools wiki, which transcribes the official notes. `scmdb_changes`: SCMDB. `sc_list_builds` and `sc_diff_versions`: a community patch-dump repository on GitHub (`voidput/sc-gamedata-dumps` by default). Snapshots: the Star Citizen Wiki API plus files you save on this PC |
| Freshness | `sc_patch_notes` gives the update's version as `game_version` and `channel` `unknown`; its `data_age` is `null`. `scmdb_changes` has the SCMDB channel date as `data_age`. The dump tools give `data_age: null`, and builds there are cached by commit, never by tag, because tags are republished. Snapshots are as old as the day you saved them |
| Limits | The official notes are on the RSI website, which this server does not read: `sc_patch_notes` is a community transcription and may lag or be a stub (without a version it picks the newest page that is not a stub among the newest six). A section is cut at 9,000 characters. `scmdb_changes` compares the two newest builds of SCMDB (the `to` argument looks at an older update) and lists counts and examples. The patch-dump repository is thin: the README says it currently holds two unlabelled builds, and its builds are not marked LIVE or PTU, so `sc_diff_versions` may have little to compare; `scmdb_changes` is the working answer for "what changed". `sc_diff_versions` supports 14 datasets (`ships`, `ship-components`, `fps-weapons`, `ammo`, `mining`, `mining-spawns`, `blueprints`, `missions`, `reputation`, `containers`, `starmap`, `manufacturers`, `wikelo-trades`, `strings`). Snapshots keep a reduced set of identifying and stat fields (for example name, type, size, health, shield HP, cargo, speed, crew), not the full records |
| Prerequisites | None. Snapshots are written under `SCMCP_DATA_DIR` (or `SCMCP_SNAPSHOT_DIR`). `scw_snapshot_diff` without `to_label` compares against the current wiki data |
| Local or network | Network: `starcitizen.tools` (patch notes), `raw.githubusercontent.com` and `api.github.com` (SCMDB and the dumps), `api.star-citizen.wiki` (`scw_snapshot_save`, and `scw_snapshot_diff` without `to_label`). `scw_snapshot_list` is local; so is a `scw_snapshot_diff` between two saved snapshots. Only `scw_snapshot_save` writes a snapshot file (the cache is written by every network tool) |

## 7. Game log (Game.log)

| Topic | Details |
| --- | --- |
| What it is for | What your own game logged: where you have been, what you accepted and completed, what you bought, and a summary of what you are doing now |
| Example questions | "What am I doing right now?" (Qu'est-ce que je suis en train de faire ?) ; "Debrief my last session" (Fais le bilan de ma dernière session) ; "Which contracts did I complete today?" (Quels contrats ai-je terminés aujourd'hui ?) ; "Is the log readable and which version does it say?" (Le journal est-il lisible et quelle version indique-t-il ?) |
| Tools | `sc_log_status`, `sc_log_context`, `sc_log_recent_events`, `sc_log_sessions`, `sc_trade_journal` |
| Source | The `Game.log` file the game writes on your PC (and its `logbackups` folder) |
| Freshness | The data is as old as the last line the game wrote (`cache_age`); `data_age` is `null`. `channel` (LIVE or PTU) and `game_version` come from the log header. Every context field is the last time the game logged it, not a live reading |
| Limits | Reported: session start and quit, login, jurisdiction and zone changes, contracts accepted, completed, failed or abandoned, objectives, hauling pickups and drop-offs (only in logs written up to spring 2025: none in the build 4.10 logs of the reference install), blueprints received, shop purchases, insurance claims, hangar requests, the ship whose comms channel you joined or left, jump-point transits. Not in the log, so never reported: ordinary quantum travel, combat and kills, wallet balance, your position, a death. Names and ids of the player are never returned and paths are shortened. Lines the parser does not know are counted as ignored. CIG does not guarantee the format. Very large logs are read from their end (the last 8 MB), and the answer says so. "Running" means the log was written in the last 2 minutes. `session` `previous` reads the newest file of `logbackups`. Contract titles and item names are text from the log (`untrusted_text` for `sc_log_context` and `sc_log_recent_events`) |
| Prerequisites | Off until you set `SC_INSTALL_DIR` (a LIVE or PTU folder) or `SC_GAME_LOG_PATH` (a `.log` file; other files are refused). `sc_log_status` explains how when it is off; the other three return an error saying the log is off |
| Local or network | The log is read locally: the reader has no network code, reads without locking the file and never writes. The one exception is `sc_trade_journal`, which asks the wiki for its public commodity list to name cargo (the same request for everyone, nothing from your log is sent; `resolve_names` false keeps it fully local) |

### Trade journal (`sc_trade_journal`)

Example questions: "What did I buy and sell in my last session?" (Qu'ai-je acheté et vendu pendant ma dernière session ?) ; "How did my last cargo run go?" (Comment s'est passé mon dernier transport de marchandises ?) ; "What did I spend on gear?" (Combien ai-je dépensé en équipement ?)

It reads the shop and cargo-kiosk lines of the log, per session, newest first (`sessions` log files, default 2, max 10; files with no trade are left out). For each purchase or sale: time (UTC), kind (`item` or `commodity`), side, shop, quantity with its unit (SCU for cargo, a cSCU quantity on a purchase is converted), the TOTAL of the line in aUEC, the unit price when it can be derived, the outcome with a `confidence`, and for cargo the `autoLoading` flag as `auto_loading`. Then: spending by category, cargo runs and session totals. Every aUEC amount in that list (line totals, unit prices, spending, run cost, revenue and margin, totals) is withheld unless `include_balance` is true (here the flag means "amounts"; ask the player first); counts, SCU, kinds, statuses and categories are always shown.

What is verified, and what is not (checked on the author's own logs, March 2025 to November 2026; counts are of requests found, not a promise about every account):

- Item requests (about 183 in 17 files): every one is followed by exactly one response within about 6 seconds, so success or failure is known (`confirmed`). Values seen: Success (182), TransactionCostMismatch (1). `client_price` is the line total. Shop-UI requests state no currency (shown as "not stated (assumed aUEC)"); the small-kiosk flow states `currencyType` and any other currency than UEC is listed but left out of the aUEC totals.
- Cargo purchases (39 lines): `price` is the line total and the quantity is in cSCU. Cargo sales (40 lines): `amount` is the line total, the quantity is in SCU. The log has NO success line for cargo, only failures (`InvalidQuantityError`, `TransactionCostMismatch`, `AutoLoadStartFailed`; 12 seen, each within 2 seconds of its request). A cargo line with no error line within 3 seconds is therefore reported as completed with confidence `inferred`; a line in the last 3 seconds of the log is `unconfirmed`. A sale with amount 0 failed in every case seen and is excluded as `zero_amount`.
- Cargo sales in the current build (4.10) are verified on only two lines of one session (3 November 2026: 640 SCU and 56 SCU, quantity in plain SCU and equal to the boxes listed, no error line). Between March 2025 and that day the available logs hold no cargo sale, so the 4.10 sale format rests on those two lines.
- When one cargo error line follows several requests of the same side within 3 seconds it cannot be attributed to one of them: those lines get confidence `ambiguous`, are listed as unconfirmed and are not counted.
- Failed, unconfirmed and other-currency lines are listed but never counted in totals, categories or runs.

What the log does not contain, so the journal never invents it: the wallet balance (so no net result, only a GROSS margin), the autoload fee, fuel and every other cost, contract rewards and fines, a per-unit price for cargo sales (it is the total divided by the quantity), a terminal id, and a commodity name next to its GUID.

- Cargo runs: per commodity, purchases are matched first-in first-out with later sales in the same session. A run is `closed` when every purchased SCU has been sold, `open` otherwise. Only the paired SCU is valued: `cost_auec`, `revenue_auec`, `gross_margin_auec` (revenue minus cost) and `gross_margin_per_scu_auec` are estimates. A sale larger than what was bought is shown as `sold_without_purchase_scu` and not valued (the cargo may come from a mission or an earlier session). The pairing assumes the cargo sold is the cargo bought: with cargo from several sources it can pair the wrong lots.
- Commodity names: the log has only the game's resource GUID. The wiki's commodity list carries the same GUID, and six GUIDs from real logs all resolved; for the three that also appear in the log's hauling-contract names, the wiki name agrees (Waste, Scrap, Stims). A GUID with no match, or a wiki that cannot be reached, gives "unknown commodity". A name is never guessed from a contract title. `commodity_id` is the first 8 characters of the GUID.
- Categories (`food`, `weapon`, `armor`, `ship_component`, `other`) are INFERRED from the item class name, the log has no category field. Rules: `Food_` or `Drink_` prefix is food; four capital letters then an underscore (`HRST_LaserRepeater_S2`) is a ship component; a name with `armor`, `undersuit`, `backpack` or `helmet` is armor; `rifle`, `smg`, `pistol`, `shotgun`, `sniper`, `lmg`, `gren`, `melee`, `optics`, `barrel` or `mag` is a weapon, magazine or attachment; everything else (tools, medical items, cargo containers) is other. Only purchases are grouped.
- Place: `location_hint` is the last `RequestLocationInventory` location token the game logged before the line, with its age in seconds. It can be stale (after a jump or a long wait) and it is never a terminal: the cargo kiosks have generic shop names, and the log carries no terminal id.
- Very large logs are read from their end (the last 40 MB), and the answer says so. The output is capped (40 transactions per session by default, 120 in all) and is cut further, with a `truncated` note giving the counts, when it would exceed the output limit; totals and spending always cover the whole session.

### Ship losses (dashboard, saved sessions and the session debrief)

Example questions: "Did I lose my ship during that run?" (Ai-je perdu mon vaisseau pendant ce trajet ?) ; "What did that crash cost me in cargo?" (Combien de cargo ai-je perdu dans ce crash ?)

When your own ship is destroyed with you aboard, the dashboard shows it in the alert slot (the header verdict, the compact line and the box of the commerce card, before a refused price), the commerce card marks the run it interrupted, the saved session keeps it (the `ship_losses` list of `sessions.json`, additive, format version 2) and the session debrief lists it. Needs the game log (`SC_INSTALL_DIR` or `SC_GAME_LOG_PATH`); the saved session and the dashboard also need telemetry on, like everything else of the sessions. Nothing is sent anywhere and no tool changed.

What is verified, and what is not (checked on the author's own logs; the 4.10 files hold three such losses, all collisions, none with a purchase):

- Certain: a ship was destroyed with the player aboard (the log does not say whose ship it was: the ownership is not verified). Build 4.10 writes `[ActorState] Dead ... ejected from zone 'SHIP' ... destroyed vehicle`; the actor must be the player, compared with a hash of his id from the login line, and a line is refused while that login line is not in the text read (a long log read from its end whose header has none). The 2025 builds wrote an `Actor Death` of the player inside the ship (kept as a legacy path: no 4.10 log has it). A suicide (a respawn), a bleed-out, a routine insurance claim, another actor's death and an AI vehicle the player destroyed are never counted.
- Cause: a collision only when a `FatalCollision ... PlayerPilot: 1` of the same ship comes at most 1 second before the 4.10 line, or when the 2025 `Vehicle Destruction` line of the ship says so (it also gives combat or self-destruct and a kind of causer: the player, another player or an AI, from the SHAPE of the name, a heuristic shown as "d'après le nom"). `PlayerPilot: 1` does not prove that the pilot was the local player, so a 4.10 collision names no causer. Otherwise the cause is "not logged": combat is never guessed. The alert shows a loss for 15 minutes (a price refusal that is newer takes the slot); the session card keeps it.
- Cargo presumed lost, an estimate: the successful cargo purchases bound to that ship by the cargo kiosk (`VehicleCargoDataRequest`, at most 30 minutes before the purchase, at most 3 hours before the loss) that no successful sale of the same goods followed. SCU and aUEC PAID (the purchase price, not the value). Purchases the game refused (an error line right after) are ignored; purchases the journal cannot confirm are counted apart and not in the total, and sales it cannot confirm are not deducted (the alert says so: the cargo lost may then be overestimated). The boxes may have survived in the wreck: the log does not say. Hauling-contract cargo, cargo of other ships and mission cargo are not covered.
- Attribution verified on 2025-build logs only: purchase, ship and destruction chain together on three 2025 cases (two Starlifter C2 with 640 and 176 SCU, one test purchase). No 4.10 session has a purchase followed by a loss: the 4.10 chain holds by identity of the ship ids (3 of 3), not by an observed case.
- Not logged, ever: the value lost, whether the cargo was insured, the insurance cost or claim, and who destroyed the ship. The screens say "non journalisés". A suicide that happens aboard the ship in 4.10 cannot be told from a destruction by its lines.
- A loss with cargo ends the run: what follows is another run, so a later sale of the same goods is not paired with the lost cargo (the journal's cargo runs are cut the same way).
- Model and place are filters on the SHAPE of the text, not a list of places: the model is kept only if it starts with a known maker's code, the place only if it starts with a known family of the game's place names; anything else is shown as "modèle inconnu" or "lieu inconnu" (the debrief) or left out of the alert. "Another player" is a deduction by exclusion (the name is not AI-shaped), so the screens say "un autre joueur ou une entité inconnue (d'après le nom)".
- Privacy: a short hash of the ship's identifier is used in memory only, to link a purchase to its ship; it is never written to disk, sent to a View or put in an export. The saved session keeps only the time, the ship model, the cause, the kind of causer, the place token and the cargo presumed lost (SCU, and the aUEC paid). No name, handle, GUID or raw identifier is read into a record. The SCU are always shown; the aUEC paid is a balance-derived figure, withheld unless `include_balance` is true or the dashboard shows the balance.

## 8. Your fleet

| Topic | Details |
| --- | --- |
| What it is for | Keep a list of the ships you own, and let Claude advise from it (which ship for this route, this mission or this mining run) |
| Example questions | "Which of my ships should I haul with?" (Avec lequel de mes vaisseaux dois-je faire du transport ?) ; "Add a Drake Vulture bought with real money to my fleet" (Ajoute un Drake Vulture acheté en argent réel à ma flotte) ; "Remove the Cutlass from my fleet" (Retire le Cutlass de ma flotte) ; "What is the cargo capacity of my fleet?" (Quelle est la capacité de cargo de ma flotte ?) |
| Tools | `sc_fleet_get`, `sc_fleet_upsert`, `sc_fleet_remove` |
| Source | A small JSON file on your PC, plus the public stats of each ship (manufacturer, role, size, crew, cargo SCU, health, shields, speed) from UEX and the Star Citizen Wiki |
| Freshness | The list is what you saved; `data_age` is `null`. Stats are as fresh as the UEX and wiki retrievals |
| Limits | Each ship has an origin, `pledge` (bought with real money) or `in_game`, and an optional note of up to 500 characters. The file holds no price and no account data. A name that fits several ships comes back with the candidates instead of a guess. When UEX and the wiki disagree on a field (crew, cargo) both values are shown with `conflict: true` and neither is picked. A speed or crew of 0 is reported as not provided. The file is refused if it is corrupt or from a newer version, instead of being overwritten |
| Prerequisites | None. The file is created on the first add. Default location: `%APPDATA%\sc-copilot-mcp\fleet.json` on Windows; `SCMCP_FLEET_FILE` changes it |
| Local or network | `sc_fleet_upsert` and `sc_fleet_remove` are local and only change the fleet file. `sc_fleet_get` reaches UEX and the wiki to add stats; with `enrich` false it lists the file as is and makes no network call |

## 9. Live telemetry

This section is a summary. See also [TELEMETRY.md](TELEMETRY.md): that page holds the complete tables, the setup steps and the risks.

| Topic | Details |
| --- | --- |
| What it is for | A snapshot of the running game (your ship, weapons, pilot) and a short list of recent events inferred from it, so Claude can answer "what is my ship doing" or "did I just jump" |
| Example questions | "Is the live telemetry working?" (La télémétrie en direct fonctionne-t-elle ?) ; "How much hydrogen do I have left?" (Combien d'hydrogène me reste-t-il ?) ; "Is my landing gear down?" (Mon train d'atterrissage est-il sorti ?) ; "What just happened in the last minutes?" (Que vient-il de se passer ces dernières minutes ?) ; "Use my current balance as the budget for a hauling run" (Utilise mon solde actuel comme budget pour une route de transport) |
| Tools | `sc_live_status` (always listed), `sc_live_state`, `sc_live_events` (listed only when telemetry is on), `sc_live_dashboard` (opens the live dashboard), `sc_live_poll`, `sc_live_mark` and `sc_trade_suggest` (used by the dashboard itself, the last one for the commerce buttons; listed only when telemetry is on and the client can show it); the saved play sessions: `sc_session_current`, `sc_session_list`, `sc_session_stats`, `sc_session_new`, `sc_session_end`, `sc_session_debrief` (the report of a session, to share or keep: Markdown by default, CSV on request, about 28,000 characters at most; amounts only with `include_balance`, the start and last balance only with `include_start_balance` as well), `sc_session_export` (used by the dashboard itself for the whole report; listed only to a client that can show it) (listed only when telemetry is on and `SC_SESSIONS` is not `off`) |
| Source | An undocumented local server inside the game, read on `127.0.0.1` only |
| Freshness | Every snapshot carries `frame_age_ms`, the age of the last frame, and Claude is told to say it. Events live in memory only, from the moment the reader started, and are inferred by this server because the game sends almost none |
| Limits | Reliable in the field test: speed, altitude (only inside a planet's frame), heading (same), g-force, hydrogen and boost, landing gear, flight modes, nine power on/off flags, warning lights, weapons per seat, countermeasure counts, pilot vitals. Absent from the stream: position, shield level, hull, heat, ammo, power distribution, quantum fuel, and any death event (health 0 means down or dead). A field the game does not send is left out or listed as not available, never shown as zero. Ground vehicles send no vehicle data. Events carry a `confidence` of `confirmed` or `unverified`; a missing event proves nothing. The complete tables, including what is present but not verified, are in [TELEMETRY.md](TELEMETRY.md#what-the-stream-contains) |
| Prerequisites | Off by default, and two explicit switches are needed: `SC_TELEMETRY=on` in the `env` of the server entry, and `GRPC_CLIENT_SERVER_ENABLED=true` in the environment of the RSI Launcher (a game-side variable that this server never sets itself). Without the first, no connection is attempted and no telemetry code is loaded. A helper command, `npm run telemetry -- status`, shows both switches; the steps are in [TELEMETRY.md](TELEMETRY.md#two-switches-both-explicit) |
| Local or network | Local only: `127.0.0.1` port 2942, fixed in the code. Frames and raw log lines stay in memory and are never written. The one exception is the session summary: the balance at the start and at the last sighting; the game version, the times (including how long the game was seen running) and the breaks; the last place and goods the log named; your note; the count of refused prices; ship losses: time, model, cause, place, presumed cargo (SCU and aUEC paid); and, for each trip, its label (contract title, places, goods), quantity, cost, revenue, margin, fees, net and the applied plan (planned profit, quantity, terminals). It is kept in a local file, `sessions.json`, only when telemetry is on; this server never sends it anywhere, except that the `sc_session_*` tools return parts of it to your MCP client, and so to your conversation (the money figures only with `include_balance`); `SC_SESSIONS=off` disables it; and deleting `sessions.json` and the `.bak` and `.corrupt` copies next to it erases it. |

What to know before you switch it on:

- **Default off.** While off, `sc_live_status` answers with state `off` and how to enable it (it changes no setting),
  `sc_live_state` and `sc_live_events` are not listed and refuse if called by name, and `sc_data_status` reports
  the source as not configured. Other states are `waiting`, `game_without_telemetry`, `connected`, `live` and
  `incompatible`.
- **A live dashboard, in Claude Desktop only.** `sc_live_dashboard` shows the stream as a small page in the
  conversation, inline (three dials, alerts, a verdict) or in full screen (a cockpit with dials, compass, power
  diagram, warning lights, weapons, pilot vitals and one chronology), with the age of each value, the alerts of the
  moment, what the stream lacks and, if Claude passes a route plan, planned next to measured profit. Several
  dashboards share one stream of calls: only the most recent visible one polls. Claude Code does not render it and never
  lists its tools. The balance stays hidden in the page until you click. The speed dial is drawn against the ship's own limits (SCM and maximum speed from its Star Citizen Wiki page, found in the background, one search per ship, only when exactly one sheet fits) and says so when it keeps a scale deduced from the speeds seen; the hydrogen tank capacity is not known, so the hydrogen endurance stays an estimate. See
  [TELEMETRY.md](TELEMETRY.md#live-dashboard).
- **A transport ledger in that dashboard.** With the game log enabled (`SC_INSTALL_DIR` or `SC_GAME_LOG_PATH`), a
  panel lists the contracts of the current game session (title, accepted and ended times and, when the log carries them, pickup and drop-off steps
  with place and goods: those lines exist in logs up to spring 2025 and are absent from the build 4.10 logs of the
  reference install, so on current builds expect no steps) and, only after you click to show the balance, the balance change measured over each
  completed contract. The game log has no quantity (SCU) and no reward, so the ledger shows neither; the gain is a
  raw measure that mixes purchases, rewards and fines. See [TELEMETRY.md](TELEMETRY.md#transport-ledger).
- **Saved play sessions.** The dashboard works by session and a session is kept in a local file written by this
  server (the player's own summary: balances at the start and at the last sighting, trips and their results, times;
  never frames, raw log lines, handle or identifiers), so it is found again from any conversation and after a game
  crash or a reboot. It exists only with telemetry on; `SC_SESSIONS=off` creates nothing. A session resumes when the
  game is seen again within 3 hours (`SC_SESSION_GAP_HOURS`), else a new one starts; "Nouvelle session" and "Terminer"
  are in the dashboard and as tools. To catch the starting balance the server keeps the reader alive while the game
  runs. See [TELEMETRY.md](TELEMETRY.md#saved-sessions).
- **Your balance is withheld by default.** Tool results become part of your conversation with Claude, which goes
  to Anthropic. The aUEC balance (and balance-change events) is returned only when `include_balance` is true,
  and Claude is told to ask you first. Everything else in a snapshot is returned as soon as you call the tool.
- **It is an undocumented game feature.** As far as we know CIG has neither allowed nor forbidden using it, it
  can change or disappear in any patch, the RSI terms apply to you, and the risk is yours. Read the
  [Risks](TELEMETRY.md#risks) section before you decide.

## 10. Data freshness and source status

| Topic | Details |
| --- | --- |
| What it is for | One call that shows which game version each source is on, how old each is, where sources disagree, and which sources are down or not configured |
| Example questions | "Is the data up to date for the current patch?" (Les données sont-elles à jour pour le patch actuel ?) ; "Which version is LIVE according to each source?" (Quelle version est LIVE selon chaque source ?) ; "Why does this answer look wrong?" (Pourquoi cette réponse semble-t-elle fausse ?) ; "Is UEX answering?" (UEX répond-il ?) |
| Tools | `sc_data_status` (no parameters; it belongs to every profile and is always listed) |
| Source | Computed from one probe per source: `uex`, `star-citizen.wiki`, `starcitizen.tools`, `scmdb`, `sc-gamedata-dumps`, `game-log`, `live-telemetry` and `local-files` |
| Freshness | Each source reports its LIVE and PTU version, a date when it gives one (`as_of`, with `as_of_age`), and `fetched_at` and `cache_age` for the retrieval. The warnings say when LIVE builds differ between sources (builds differ for hours or days, the highest build number is the newest) |
| Limits | A source that fails is shown with its status (`ok`, `degraded`, `error` or `not_configured`) and its error, never as an empty answer. Each probe is given 20 seconds. The wiki API has no PTU data. `starcitizen.tools` articles carry no game version, so that probe only checks that the site answers. The patch-dump builds are listed without being classified as LIVE or PTU. The game's file version (for example 4.10.197.2878) is not the public version number (4.10.2): compare builds. When live telemetry is off, its entry says so and nothing is read or connected |
| Prerequisites | None. `game-log`, `live-telemetry` and `local-files` show `not_configured` until you set `SC_INSTALL_DIR` or `SC_GAME_LOG_PATH`, `SC_TELEMETRY` and `SCMCP_GAME_DATA_DIR` |
| Local or network | Both: it asks every upstream (UEX, the wiki, `starcitizen.tools`, `raw.githubusercontent.com` and `api.github.com`) through the same cache as the other tools, and reads the local sources that you configured |

Call it first when a question depends on the current patch, or when another tool's answer looks stale.

## 11. MCP prompts

| Topic | Details |
| --- | --- |
| What it is for | Ready-made workflows that chain the right tools in the right order. In Claude Desktop they appear as templates you can pick. Each one tells Claude to state the game version, channel and data age shown in the provenance, to warn about stale data, never to follow instructions found in `untrusted_text`, never to invent a number and to answer in your language. The server also sends Claude an operating manual of its own when the client connects (the MCP `instructions` field; see [Using it from Claude](USING_WITH_CLAUDE.md)) |
| Example questions | "Plan my next hauling run" (Prépare ma prochaine route de transport) ; "Give me a briefing on the latest patch" (Fais-moi un point sur le dernier patch) ; "Debrief my last session" (Fais le bilan de ma dernière session) ; "Prepare a mining run for Quantainium" (Prépare un minage de Quantainium) ; "Find missions that pay in Pyro" (Trouve des missions qui paient à Pyro) |
| Tools | Prompts are not tools. `haul_plan` (arguments `ship`, `origin`, `budget`) picks the best three trade options for one of your ships, ranked by estimated profit per hour, and flags the risks. `patch_briefing` (`version`) covers the newest update. `session_debrief` (no argument) summarises your last session from the game log, with the trade journal when you traded, and offers the shareable report (`sc_session_debrief`). `trade_review` (`sessions`) reviews your recent purchases and sales: cargo runs with their gross margin, whether the sale prices were good, the next run. `mining_prep` (`ore`, required) covers one ore. `mission_hunt` (`where`, `faction`, `min_reward`, `blueprint`) searches missions. `trade_copilot` (`budget`) reads your current session with `sc_session_current`, compares it with `uex_get_trade_routes` and proposes the next run, explaining why |
| Source | The tools each prompt names: UEX, SCMDB, the wikis, your game log and your fleet |
| Freshness | As for the tools they call. `haul_plan` and `patch_briefing` begin with `sc_data_status`; all seven tell Claude to quote the version, channel and data age from each answer's provenance |
| Limits | A prompt only builds the instruction text; the quality of the answer depends on the data behind each tool. `haul_plan` and `session_debrief` mention live telemetry as an option, and only after asking you: the balance is used as a budget only if you agree, and telemetry cannot describe an earlier session. `mission_hunt` reminds Claude that rewards are datamined and that PTU data is used only on request |
| Prerequisites | A client that supports MCP prompts. The log, fleet and telemetry steps of a prompt need those features to be set up |
| Local or network | The prompt itself is local; the tools it names follow their own sections |

## 12. Profiles, settings and local data files

### Profiles

Choose what the server advertises with `SCMCP_PROFILES` (comma-separated; unset advertises everything).
`sc_data_status` is always added. `SCMCP_TOOLS` (explicit tool names) wins over profiles. An unknown tool or
profile name stops the server at startup instead of listing nothing. Scoping is for speed (a client that sees
many tools spends a round trip choosing), not security: a tool that is not listed can still be called by name.
The thirteen telemetry and session tools stay hidden while telemetry is off, even when named in `SCMCP_TOOLS`. Naming
`sc_live_dashboard` there also adds the tools the page needs (`sc_live_poll`, `sc_live_mark`, `sc_trade_suggest` and the
session tools of its session bar).

| Profile | Tools | For |
| --- | --- | --- |
| **core** (14) | `sc_data_status`, `uex_get_commodity_prices`, `uex_get_trade_routes`, `uex_get_game_versions`, `uex_get_ship_prices`, `scw_get_vehicle`, `scw_get_item`, `scw_get_ship_comparison`, `sct_search`, `sct_get_article`, `sc_patch_notes`, `scmdb_search_missions`, `scmdb_changes`, `sc_fleet_get` | The everyday copilot; a test keeps it under 15 tools |
| **trade** (23) | The eighteen tools of [section 1](#1-market-and-trade-routes-uex), the three read-only session tools (`sc_session_current`, `sc_session_list`, `sc_session_stats`), `scmdb_rank_hauling` ([section 3](#3-missions-scmdb)) and `sc_data_status` | The full market toolbox |
| **data** (16) | Wiki browsing and snapshots, missions, crafting, mining, patch notes and history, vocabulary | Reference data, crafting, mining and patch history |
| **local** (26) | The game log, telemetry, fleet and local-file tools | Things on your PC. Thirteen are listed while telemetry is off |

### Variables

Set them in the `env` of the server entry of your MCP configuration. The UEX token goes in a `.env` file next
to the package (never one from the working directory), not in the Claude configuration.

| Variable | Purpose |
| --- | --- |
| `UEXTOKEN` | Your UEX read token. Only ever sent to UEX hosts. Optional |
| `SCMCP_PROFILES`, `SCMCP_TOOLS` | Which tools to advertise (above) |
| `SC_INSTALL_DIR`, `SC_GAME_LOG_PATH` | Turn on the game log ([section 7](#7-game-log-gamelog)) |
| `SC_TELEMETRY` | Server switch of the live telemetry ([section 9](#9-live-telemetry)). `on`, `1`, `true` or `yes` mean on; anything else means off |
| `SC_SESSIONS`, `SCMCP_SESSIONS_FILE`, `SC_SESSION_GAP_HOURS` | Saved play sessions ([section 9](#9-live-telemetry)): `SC_SESSIONS=off` switches them off, the file can be moved, and the quiet time (default 3 hours) after which a new session starts can be set |
| `SCMCP_FLEET_FILE` | Fleet file ([section 8](#8-your-fleet)) |
| `SCMCP_CACHE_DIR`, `SCMCP_DATA_DIR`, `SCMCP_CONFIG_DIR` | Cache (can be deleted), data (wiki snapshots and `sessions.json`: keep it) and config folders. Defaults are per user |
| `SCMCP_SNAPSHOT_DIR`, `SCMCP_BUILD_CACHE_DIR` | Override the snapshot folder and the folder where patch-dump builds are cached |
| `SCMCP_UEX_BASE_URL`, `SCMCP_SCW_BASE_URL`, `SCMCP_SCT_BASE_URL` | Override an API base. It must be https on an allowlisted host or the server refuses to start |
| `SCMCP_SCMDB_REPO`, `SCMCP_DATA_REPO`, `SCMCP_DATA_REPO_PATH` | Where SCMDB and the patch dumps are read from |
| `SCMCP_GITHUB_TOKEN` | Optional, raises the GitHub rate limit. Dedicated: an ambient GitHub token is never used |
| `SCMCP_GAME_DATA_DIR` | Folder of `game-*.json` files you already have (below) |

The hosts the server may contact are fixed in the code, not in the environment: `api.uexcorp.uk`,
`api.uexcorp.space`, `api.star-citizen.wiki`, `star-citizen.wiki`, `starcitizen.tools`, `api.github.com` and
`raw.githubusercontent.com`. Telemetry, when on, uses the loopback address `127.0.0.1` only.

### Your own data files

| Topic | Details |
| --- | --- |
| What it is for | Read `game-*.json` datasets that you already have on disk, for example to search names that no public API exposes |
| Example questions | "What datasets do I have locally?" (Quels jeux de données ai-je en local ?) ; "Search my local data for Hadanite" (Cherche Hadanite dans mes données locales) ; "Read the first 25 records of this collection" (Lis les 25 premiers enregistrements de cette collection) |
| Tools | `sc_local_datasets`, `sc_search_local`, `sc_read_local_collection` |
| Source | Your own files, in the folder named by `SCMCP_GAME_DATA_DIR` |
| Freshness | The build the files say they come from, shown by `sc_local_datasets` and by `sc_data_status`; it may lag the installed game |
| Limits | Read-only. Dataset names that try to leave the folder are rejected. Paging is at most 200 records per page. For missions, crafting and mining the SCMDB tools need no local files and are preferred. This project does not extract game files and does not say how; whether doing so could affect an account is unverified (see [SECURITY.md](../SECURITY.md)) |
| Prerequisites | `SCMCP_GAME_DATA_DIR` set to a folder with `game-*.json` files; without it each tool returns an error that says so |
| Local or network | Local only |
