# Troubleshooting

Start with `npm run doctor` (your installation) and `npm run check:sources` (the data sources); between them they
find most problems. In Claude, `sc_data_status` shows what each source is on and which are down.

## Claude does not show the Star Citizen tools

- Did you restart Claude Desktop after `npm run install:claude -- --apply`? It only reads its config at startup.
- `npm run doctor` says whether the `sc-copilot` entry exists and points at this checkout.
- Is `dist/` built? (`npm ci --ignore-scripts && npm run build`.) Claude starts `dist/index.js`.
- Too many tools? Set `SCMCP_PROFILES` (for example `core,trade`) in the `env` of the config entry.

## "UEX 401" or "the server rejected the credentials"

Your token is wrong or revoked. Create a new one at <https://uexcorp.space/api/apps> and put it in `.env`
(`UEXTOKEN=...`) next to `package.json`. Never use UEX's separate *submission* key. A 401 is never hidden behind
cached data, so you will see it right away. Public endpoints answer without a token.

## An answer says `stale: true`

The live request failed (network down, UEX or the wiki having a bad moment) and the last good copy was served.
`stale_reason` says why and `cache_age` how old the copy is. Try again later; `sc_data_status` shows which source is down.

## Prices or missions look wrong

Prices are crowdsourced. Check `provenance.data_age` (the real age of the rows; `cache_age` is only the fetch) and each row's `updated_at`, and in
route results `is_estimate` / `reports_origin` / `reports_destination` (0 means UEX's own estimate; `min_reports`
drops them). Price rows from an older game version are left out and counted (`excluded_older_version`). Mission rewards are datamined values and can differ in game. Sources also sync at
different times after a patch: `sc_data_status` lists the builds each one is on.

## PTU data is missing

Only SCMDB has PTU data, and only while a PTU build is up. UEX and the wiki serve LIVE only. Ask a tool for
`channel: "ptu"` and it says so when none exists; it never answers with LIVE data under a PTU label.

## "Local rate limit reached"

The server keeps itself under each source's request limit (UEX allows 120 a minute, it stays under 100). Wait the
number of seconds it says. Asking for large lists repeatedly is what usually triggers it.

## The game log tools say it is off or unreadable

- Off is the default. Set `SC_INSTALL_DIR` (the folder that contains `Game.log`, for example `...\StarCitizen\LIVE`)
  in the `env` of the Claude config entry, then restart Claude Desktop.
- Only `.log` files are read. `sc_log_status` names the file by its last three path parts.
- `sc_log_context` is "the last time the game logged it", not live: there is no position or ship telemetry in the log.
- The game keeps writing the log while it runs: reading it is safe and takes no lock.

## Live telemetry (optional, off by default)

`sc_live_status` always answers and says the state and the cause; `npm run telemetry -- status` shows both switches
without changing anything; `npm run doctor` repeats it. Full explanations and the risks are in
[TELEMETRY.md](TELEMETRY.md).

- **`off`**: `SC_TELEMETRY=on` is not set in the `sc-copilot` entry. `npm run telemetry -- enable --apply`, then
  restart Claude Desktop.
- **`waiting`**: no telemetry for now. This is normal in menus, during a loading screen and before the character has
  appeared; it does not mean the game is off (this server cannot know). Nothing to fix then.
- **`game_without_telemetry`, or `waiting` that lasts once the character has spawned**: the game was started without the variable. Quit
  the RSI Launcher completely, tray icon included (a launcher left in the tray keeps its old environment), start it
  again, start the game. `Game.log` must then contain `Service 'sc.game.telemetry.v1.GameTelemetryService' registered`.
- **`connected` but no data**: the session with the game is open; menus or loading screens send nothing. Data starts once the character has spawned;
  ship data comes 6 to 9 seconds after you sit down.
- **`live` but `sc_live_state` has no ship**: you are on foot or in a ground vehicle (they send no ship data). This is normal: ship data comes once you are seated in a ship.
- **`incompatible`**: the game answers in a shape this version does not know, usually after a patch. Update the
  server and open an issue with the game version; nothing else is needed from you.
- **Nothing happens after `enable --apply`**: the server and Claude Desktop read their environment at start. Restart
  both, and the launcher.
- To undo everything the tool set: `npm run telemetry -- disable --apply`. A variable you set by hand stays; the
  command prints how to remove it.

## The live dashboard does not appear

- **Claude Code and other text clients never show it.** They cannot render a page, so the server does not even list
  `sc_live_dashboard`, `sc_live_poll` and `sc_live_mark` to them. Use `sc_live_state` there.
- **`SC_TELEMETRY=on` must be set** in the `sc-copilot` entry. Without it the three tools and the page are not
  served at all. `sc_live_status` tells you.
- **Quit Claude Desktop completely** (tray icon included) and start it again after any change to the server entry:
  closing the window is not enough, the tool list is read when the app starts.
- Ask Claude to open the live dashboard; if it answers with text only, say that `sc_live_dashboard` is the tool to
  call. If the tool is missing from the list, the client did not declare that it can show Views.
- **It shows "Télémétrie désactivée", "En attente du jeu" or "Jeu lancé sans télémétrie"**: follow the matching
  line of the section above. The page is only a mirror of `sc_live_status`.
- **It stopped updating**: the page pauses when its window is hidden or scrolled out of view and retires after 30
  minutes away; click "Reprendre".
- **"Remplacé par un tableau de bord plus récent"**: Claude opened a second dashboard (they all stay in the
  conversation). Only the most recent visible one calls the game's data, the older ones follow it. Click "Reprendre
  ici" to make this one the leader. If a dashboard does not follow, the host may not share the origin of its Views
  (not verified by us): each one then polls by itself, and one away for 30 seconds retires.
- **The balance is masked**: that is the default. Click "Afficher le solde" in the page.

## A tool says "unexpected shape" or "format may have changed"

A source changed after a patch. Run `npm run check:sources`: it names the file and field. Please open a
"A data source changed or broke" issue with its output (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Windows specifics

- Paths with spaces are fine; the installer writes absolute paths as JSON.
- Caches live in `%LOCALAPPDATA%\sc-copilot-mcp`, your fleet in `%APPDATA%\sc-copilot-mcp\fleet.json`.
  Delete the cache folder any time; it is rebuilt on demand.
- If `npm run install:claude` cannot find the config, pass `--config <path to claude_desktop_config.json>`.

## Still stuck

Open an issue with the output of `npm run doctor` (it prints no secrets). Do not paste your `.env`, your Claude
config, or an unredacted `Game.log`.
