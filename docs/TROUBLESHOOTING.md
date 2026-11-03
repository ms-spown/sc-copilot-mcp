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
- **`waiting`, game not running**: nothing to read. Start the game.
- **`waiting` or `game_without_telemetry` with the game running**: the game was started without the variable. Quit
  the RSI Launcher completely, tray icon included (a launcher left in the tray keeps its old environment), start it
  again, start the game. `Game.log` must then contain `Service 'sc.game.telemetry.v1.GameTelemetryService' registered`.
- **`connected` but no data**: menus or loading screens send nothing. Data starts once the character has spawned;
  ship data comes 6 to 9 seconds after you sit down.
- **`live` but `sc_live_state` has no ship**: you are on foot or in a ground vehicle (they send no vehicle data).
- **`incompatible`**: the game answers in a shape this version does not know, usually after a patch. Update the
  server and open an issue with the game version; nothing else is needed from you.
- **Nothing happens after `enable --apply`**: the server and Claude Desktop read their environment at start. Restart
  both, and the launcher.
- To undo everything the tool set: `npm run telemetry -- disable --apply`. A variable you set by hand stays; the
  command prints how to remove it.

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
