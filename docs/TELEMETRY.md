# Live telemetry

English · [Français](TELEMETRY.fr.md)

An optional, **off by default** way for sc-copilot-mcp to see what the running game reports about your ship and
your character: speed, altitude, fuel, power, warning lights, health, wallet. Read this whole page before you
switch it on, in particular [Risks](#risks).

## What it is, and where it comes from

Star Citizen 4.10.2 and later contain a small local server that streams the game's own telemetry. It is
**undocumented by CIG**: it is not a supported feature, it is off unless a variable is set in the game's
environment, and it can change or disappear with any patch.

| | |
| --- | --- |
| Address | `127.0.0.1:2942`, gRPC over HTTP/2, no TLS, no token |
| Service | `sc.game.telemetry.v1.GameTelemetryService`, method `TelemetryStream` (server streaming) |
| Request | an empty message. It is the only thing this project ever sends to the game |
| Rate | about 17 frames a second once your character has spawned; nothing in menus or loading screens |
| Clients | the game accepts several at once |
| Game-side switch | `GRPC_CLIENT_SERVER_ENABLED=true` in the environment of `StarCitizen.exe`, inherited from the RSI Launcher |
| Proof it is on | `Game.log` contains `Service 'sc.game.telemetry.v1.GameTelemetryService' registered` |

What we know about the schema and the quirks of the stream comes from other people's work, not from ours:
the field test by Mallachi (Diftic) and the Wingman AI project by ShipBit. See [Credits](#credits). We did not
extract anything from the game ourselves, and this repository contains no extraction code.

## Two switches, both explicit

Nothing is enabled by installing or updating this server. You need both:

1. **Server side**: `SC_TELEMETRY=on` (also accepted: `1`, `true`, `yes`; anything else, or nothing, means off) in the `env` of the `sc-copilot` entry of your MCP configuration.
2. **Game side**: `GRPC_CLIENT_SERVER_ENABLED=true` in the environment of the RSI Launcher, then quit the launcher
   **completely** (also from the taskbar tray) and start it again, because the game inherits the variable from it.

Without switch 1 the server loads no gRPC or HTTP/2 code and never connects to port 2942
(`npm run check:telemetry-silence` proves it on your machine). Without switch 2 the game does not listen, and
the reader just waits.

### One command (Windows)

```bash
npm run telemetry -- status              # read only: shows both switches and the port
npm run telemetry -- enable              # dry run: shows what would change
npm run telemetry -- enable --apply      # does it
npm run telemetry -- disable --apply     # undoes what the tool did
```

- `enable --apply` sets the Windows **user** variable `GRPC_CLIENT_SERVER_ENABLED=true` and adds
  `SC_TELEMETRY=on` to the `sc-copilot` entry of `claude_desktop_config.json`, by editing that one key and keeping a
  timestamped backup of the file. It never replaces the file, which holds your other servers.
- `disable --apply` removes only what the tool set. A variable you set by hand stays, and the command says how to
  remove it.
- Both commands are dry runs unless you pass `--apply`. Restart Claude Desktop after a change to its configuration.

### Only for one launch (`--session`)

```bash
npm run telemetry -- enable --session
```

Creates a small launcher script that sets the variable only for the RSI Launcher it starts. Nothing permanent is
set on your user account, but you must always start the launcher through that script, and a launcher already open
in the tray defeats it.

### By hand

- **Windows**: Settings > System > About > Advanced system settings > Environment Variables > add the user variable
  `GRPC_CLIENT_SERVER_ENABLED` = `true`. Add `"env": { "SC_TELEMETRY": "on" }` to the `sc-copilot` entry. Quit and
  restart the launcher and Claude Desktop.
- **Linux (Lutris, Steam)**: not tested by us. Lutris: Configure > System options > Environment variables. Steam:
  launch options `GRPC_CLIENT_SERVER_ENABLED=true %command%`. Under Wine or Proton the game's port should be the
  host's, which we have not verified.

## What the stream contains

Status in the tables comes from the published field test (game 4.10.2 LIVE, October 2026): **reliable** = seen
changing with real values; **not verified** = present but never seen changing, or never tested.

### Reliable

| Data | Notes |
| --- | --- |
| Speed, vertical speed | m/s |
| Altitude | metres; only meaningful inside a planet's frame. The game sends 3.4e38 for "no planet" and we drop it |
| Heading | degrees, **only inside a planet's frame** and not during a quantum jump (it freezes) |
| G-force | current and maximum |
| Hydrogen fuel, boost | boost has engaged / output / reserves / critical |
| Landing gear, VTOL | retracted, deploying, deployed, retracting |
| Flight modes | coupled, ESP, G-safe, speed limiter, cruise, gravity compensation, each enabled and active |
| Quantum | the QDRV light says quantum mode is on; a jump is inferred from the engine light, zero G and not landed |
| Power | nine on/off flags (powerplants, engines, weapons, coolers, life support, gravity, sensors, shield generators and emitters). No amounts |
| Warning lights | THR, SHLD, PROX, HIT, RADR, QDRV are understood; WPN only "no power" is used. A RADR light means a hostile lock |
| Weapons per seat | name, powered, ready to fire |
| Countermeasures | decoy and noise counts |
| Ship and seat | ship name and instance id, seat name, crew role |
| Pilot | health, hunger, thirst, heart rate, locomotion (on foot, EVA, seated), gravity, pressure, outside temperature, breathable or not |
| Wallet | aUEC balance |

### Not in the stream, or never filled

Position and camera direction. Shield level, hull and component health, heat, ammo, capacitor, power
distribution, quantum fuel. Doors, weapon presets, force feedback, missiles. **Death events**: the game sends none,
and health 0 means "down or dead" with no way to tell which. Ground vehicles (the Ursa was tested) send no vehicle
data at all, only the seat name.

### Present but not verified

Oxygen, body temperature, intoxication level, radiation, PWR / COOL / MISL lights, hydrogen running low, an
unbreathable atmosphere. They are returned under `unverified` or as events marked `unverified`. Do not reason
from them.

### Quirks the server handles for you

- A field the game does not send is left out, never shown as 0. Inside a section that is present, a missing number
  really is the default (a landed ship sends no `speed`: it is 0).
- Heading and radar altitude are dropped when they are not valid; EVA and on-foot flicker is smoothed; warning
  lights are debounced; a new vehicle starts a silent baseline so getting in is not a burst of events.
- Vehicle data arrives 6 to 9 seconds after you sit down.
- The first frame after a seat change can carry stale settings.

## What the tools do with it

| Tool | Listed | Purpose |
| --- | --- | --- |
| `sc_live_status` | always | The state of the stream, why, and how to enable it |
| `sc_live_state` | when `SC_TELEMETRY=on` | A snapshot with the age of the last frame and what is not available |
| `sc_live_events` | when `SC_TELEMETRY=on` | Recent derived events, each marked `confirmed` or `unverified` |
| `sc_live_dashboard` | when `SC_TELEMETRY=on` and the client can show Views | Opens the [live dashboard](#live-dashboard) in the conversation |
| `sc_live_poll`, `sc_live_mark` | same | Used by the dashboard itself to refresh and to set session markers. Claude is told not to call them |

States: `off` (server switch not set), `waiting` (nothing answers on the port), `game_without_telemetry` (the game
runs, `Game.log` has no registration line: restart the launcher), `connected` (port open, no frames yet), `live`,
`incompatible` (the game answers in a shape we do not know: a patch changed it).

The reader starts at the first request, reconnects with a growing delay, stops after five minutes without a request,
and keeps everything in memory only. Events exist only for the time the server was running while the game was
sending frames, and they are inferred, not reported by the game.

## Live dashboard

An optional live view of the same stream, drawn inside the conversation: your ship, speed, hydrogen, health and
the state of the stream at a glance, and, in full screen, instruments, warning lights, power flags, weapons by
seat, countermeasures, vitals, recent events and a session timeline. It is an MCP App: a small page that this
server provides and that the client renders next to the chat.

- **Who shows it.** Claude Desktop is the host we tested (Microsoft Store build 4.4212.0, server declared in
  `claude_desktop_config.json`). **Claude Code and other text clients do not render it**: for them the three
  dashboard tools are not listed at all, so the model never sees them. The server lists them only when
  `SC_TELEMETRY=on` AND the client declared the MCP Apps extension at start. Other hosts that render MCP Apps
  may work; we have not tried them.
- **How to open it.** Switch the telemetry on (see above), restart Claude Desktop completely (quit it from the
  tray, not only the window), then ask Claude to open the live dashboard. Claude calls `sc_live_dashboard`.
  While it is open you can keep talking to Claude: it answers from `sc_live_state`, not from the page.
- **Two modes.** Inline: a compact view with five data (ship, speed, hydrogen, health, balance), the state of the
  stream and a band of recent alerts. Full screen (button in the page): the complete panel. The button asks the
  host; if the host answers with another mode the page follows what it is told.
- **Age and gaps.** Every value comes with the age of its frame, and everything turns grey when the stream is not
  live. Nothing is invented: a missing field is shown as a dash, health 0 reads "down or dead", and one
  collapsible line lists what the stream does not contain (cargo, position, shield level, hull, heat, ammo).
- **Estimates are labelled.** Remaining hydrogen, hunger and thirst are straight-line estimates over the last
  minutes, shown with their window. Pace (aUEC per hour) and flight time come from the balance change and from
  take-off and landing events since the session marker. The balance change mixes purchases, rewards and fines, and
  the game does not measure cargo: it is the only measure of a run.
- **Route plan.** After `uex_get_trade_routes`, Claude may pass a `plan` (commodity, buy and sell terminals, SCU,
  expected profit, a short note) when it opens the dashboard. The page shows planned next to measured profit. The
  text is cleaned and capped (60 characters) and displayed as plain text.
- **Balance privacy.** The balance is hidden in the page until you click "Afficher le solde". Only then does the
  page ask the server for it (`include_balance`). The balance is never put in the automatic summary that the
  page may send to the model, nor in the fixed messages of the buttons, with one exception: the button "Route
  avec mon solde et ce vaisseau" sends it in a message, says so in the text, and only when you press it.
- **What the buttons do.** "Analyser ma situation", "Route avec mon solde et ce vaisseau" and "Bilan de
  session" post a short fixed message in the conversation, as if you had typed it, asking Claude to use
  `sc_live_state` and `sc_live_events`. Session markers (start, end, reset of the balance change) live in this
  server's memory. Nothing in the page sends anything to the game.
- **Load.** The page polls about once a second while it is visible (never faster than twice a second), every 5
  seconds when the stream is off or cut. It stops when the window is hidden or the View is scrolled out of view,
  and gives up for good after 30 minutes away until you click "Reprendre". Claude Desktop keeps every dashboard it
  opened in the conversation, so several can exist: the server answers all of them from one read, cached for half
  a second.
- **No network, no package.** The page is one file inside this server: no CDN, no font, no request. It declares
  its own restrictive content policy and sets every text with `textContent`.

The dashboard shows what the stream shows and inherits every limit and risk of this page. We do not claim it is
approved by Cloud Imperium Games.

A preview for people who work on the page: `npm run build`, then `node scripts/dashboard-preview.mjs`, then open
the local address it prints (loopback, port 4173 by default). It plays a made-up flight against a fake host; no game and no Claude is involved.

## Privacy

- The stream is **unencrypted and readable by any program on your PC** while it is on. It is bound to loopback, so
  it is not reachable from the network.
- It contains your health, your ship and your **aUEC balance**. It does not contain your position.
- This server never logs frames, never writes them to disk and never sends them over a network. Its diagnostics
  contain field numbers only.
- **Tool results are part of your conversation with Claude**, which goes to Anthropic. For that reason the balance
  is withheld unless the tool is called with `include_balance`, and Claude is told to ask you first. What you let
  Claude read is what leaves your machine.

### Limits against a program that pretends to be the game

Port 2942 has no authentication: any local program can answer on it. The reader therefore treats the stream as
untrusted input and bounds it. The figures are in the code (`decode.ts`, `reader.ts`, `service.ts`, `events.ts`,
`tools/telemetry.ts`) and tested with a fake game; real frames are never used.

| What | Limit | When it is exceeded |
| --- | --- | --- |
| One message | 1 MiB (the declared length is checked before the body is waited for) | The stream is reported `incompatible` |
| Fields read in one frame (nested messages included) | 5 000 | The frame is refused and counted in `frames_rejected` |
| Weapons per frame | 64 | The rest is not decoded; the anomaly `WeaponsFrame.weapons: more than 64 entries, the rest ignored` is listed |
| Countermeasure entries per frame | 16 | Same, with `WeaponsFrame.countermeasures` |
| Game events per frame | 32 | Same, with `EventsFrame.events` |
| Frames decoded per second | About 33 (at most one every 30 ms) | Frames that arrive faster are counted in `frames_received` but only the newest of a burst is decoded, in the next slot (the ones in between are never decoded). The game sends about 17 a second, so nothing changes in normal use |
| Names (ship, seat, weapon) | 64 characters of `[A-Za-z0-9_.-]` | Replaced by `(unrecognised name)` |
| Text kept in one event | 80 characters per value | Cut |
| Event ring | 200 events | The oldest are dropped |
| Countermeasure kinds tracked | 8 | New kinds are ignored |
| One `sc_live_state` / `sc_live_events` answer | 40 000 characters of payload (before the provenance envelope) | The weapons list or the older events are cut, and the answer says so |

A frame that goes over a cap is still used for the rest of its content, but it counts as a bad frame: five in a row
and the state becomes `incompatible`.

## Risks

Written to be neither alarming nor reassuring. This is not legal advice.

- **It is an undocumented feature.** CIG has not announced it, supports it or documents it. It can change or be
  removed in any patch, and then this feature stops working (the state becomes `incompatible` or `waiting`).
- **CIG has neither allowed nor forbidden it**, as far as we know. We found no statement either way.
- **The RSI terms apply to you.** Read the Terms of Service and the rules on third-party tools and on
  undocumented or unapproved features. We cannot tell you whether they cover this.
- **The game can see it.** Technically the game knows the setting is on and that a client is connected. We do not
  know what, if anything, is reported to CIG's servers.
- **No sanction found, which is not a guarantee.** At the time of writing we found no report of an account being
  sanctioned for this. That says nothing about the future.
- **The risk is yours.** Using this feature is your decision and your responsibility.
- In case of doubt, ask RSI support before you enable it, and leave it off until you have an answer.

We make no claim that it is safe, undetectable or approved by Cloud Imperium Games. It is none of those things as
far as we can establish.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `sc_live_status` says `off` | The server switch is not set | `npm run telemetry -- enable --apply`, restart Claude Desktop |
| `waiting`, game not running | Nothing to read | Start the game |
| `waiting` or `game_without_telemetry`, game running | The game was started without the variable | Quit the RSI Launcher completely, tray icon included, start it again, start the game. Check `Game.log` for the "registered" line |
| `connected` but no data | Menus or loading | Spawn in. Data starts after the character exists |
| `live` but no ship data | You are on foot or in a ground vehicle | Sit in a ship. Vehicle data comes 6 to 9 seconds later |
| `incompatible` | A patch changed the schema | Update the server; report it with the game version |
| Port 2942 in use by something else | Another telemetry client is not the problem (several are allowed); another program is | `npm run telemetry -- status` and your usual port tools |

`npm run doctor` reports both switches, whether the launcher must be restarted, and the state of the port.

## Credits

- **Mallachi (Diftic)**, Star Citizen Telemetry skill for Wingman AI and its field-test report: the schema
  reading, the list of what works and what does not, and every quirk above. Read-only reference, nothing copied:
  `Diftic/wingman-skills`, branch `feat/sc-telemetry`, `sc_telemetry/TELEMETRY_REPORT.md`.
- **ShipBit, Wingman AI** (GPLv3): `services/sc_telemetry/sc_telemetry.proto`, copied unchanged with attribution
  into `src/providers/telemetry/`, and the design of the reader and the event rules, rewritten here.
  https://github.com/ShipBit/wingman-ai

The schema was rebuilt by a third party from data inside the game binary. We did not repeat that work. See
[THIRD_PARTY.md](../THIRD_PARTY.md).
