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
| Quantum | the QDRV light says quantum mode is on; a jump is inferred from the engine light, zero G and not landed, and it ends when the drive light goes off (measured on a real ship; a ship that never reports the drive light falls back to a slower rule) |
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

What exists depends on what the player is doing:

| The player is | Character data (health, hunger, thirst, heart rate, atmosphere, balance) | Ship data (speed, altitude, warning lights, power, weapons) |
| --- | --- | --- |
| In menus or a loading screen | No frames at all | No |
| On foot | Yes | No, this is normal |
| Seated in a ship | Yes | Yes, 6 to 9 seconds after sitting down |
| In a ground vehicle | Yes | No, ground vehicles send none |

### Present but not verified

Oxygen, body temperature, intoxication level, radiation, PWR / COOL / MISL lights, hydrogen running low, an
unbreathable atmosphere, the transformation state, the boost-related flight settings, the ship lights, gimbal lock.
They are returned under `unverified` (in `sc_live_state` and in the dashboard's poll) or as events and conditions
marked `unverified`, and the dashboard labels each one "non vérifié". Do not reason from them. The Coverage table
below says, for every field of the stream, where it goes.

### Quirks the server handles for you

- A field the game does not send is left out, never shown as 0. Inside a section that is present, a missing number
  really is the default (a landed ship sends no `speed`: it is 0).
- Heading and radar altitude are dropped when they are not valid; EVA and on-foot flicker is smoothed; warning
  lights are debounced; a new vehicle starts a silent baseline so getting in is not a burst of events.
- Vehicle data arrives 6 to 9 seconds after you sit down.
- The first frame after a seat change can carry stale settings.

## Coverage

What becomes of every field of the stream. `poll.` is the answer of `sc_live_poll` (what the dashboard receives), `state.` the state of `sc_live_state`. Values that are present but not verified sit under `unverified` in the poll and are labelled as such in the page. A test (`coverage.test.ts`) fails when a field of the schema has no line here, so a new field in a patch forces a decision.

131 fields: 104 exposed by the server, 27 ignored on purpose; 93 shown by the dashboard (the others are exposed to the model only, or ignored).

| Field | Server | Dashboard |
| --- | --- | --- |
| `Availability.enabled` | `poll.ship.flight_modes.coupled.enabled` | Flight modes line (`modes`) |
| `Availability.active` | `poll.ship.flight_modes.coupled.active` | Flight modes line (`modes`) |
| `Gauge.current` | `poll.pilot.health.current` | Health (`health`) |
| `Gauge.max` | `poll.pilot.health.max` | Health (`health`) |
| `VehicleDoorState.open_state` | `poll.unverified.ship.doors.open_state` | Unverified values card (`unverified`) |
| `VehicleDoorState.lock_state` | `poll.unverified.ship.doors.lock_state` | Unverified values card (`unverified`) |
| `VehicleFlightSettings.ifcs_coupled` | `poll.ship.flight_modes.coupled` | Flight modes line (`modes`) |
| `VehicleFlightSettings.ifcs_esp` | `poll.ship.flight_modes.esp` | Flight modes line (`modes`) |
| `VehicleFlightSettings.ifcs_gravity_compensation` | `poll.ship.flight_modes.gravity_compensation` | Flight modes line (`modes`) |
| `VehicleFlightSettings.ifcs_g_safe` | `poll.ship.flight_modes.g_safe` | Flight modes line (`modes`) |
| `VehicleFlightSettings.ifcs_cruise_mode` | `poll.ship.flight_modes.cruise_mode` | Flight modes line (`modes`) |
| `VehicleFlightSettings.ifcs_spacebreak_enables_boost` | `poll.unverified.ship.flight_settings.spacebreak_enables_boost` | Unverified values card (`unverified`) |
| `VehicleFlightSettings.ifcs_speed_limiter` | `poll.ship.flight_modes.speed_limiter` | Flight modes line (`modes`) |
| `VehicleFlightSettings.ifcs_proximity_assist` | `poll.ship.flight_modes.proximity_assist` | ignored : Not in the list of verified flight modes: available to the model, not drawn. |
| `VehicleFlightSettings.ifcs_proximity_assist_landing` | `poll.ship.flight_modes.proximity_assist_landing` | ignored : Not in the list of verified flight modes: available to the model, not drawn. |
| `VehicleFlightSettings.ifcs_stability` | `poll.ship.flight_modes.stability` | ignored : Not in the list of verified flight modes: available to the model, not drawn. |
| `VehicleFlightSettings.ifcs_core` | `poll.ship.flight_modes.core` | ignored : Not in the list of verified flight modes: available to the model, not drawn. |
| `VehicleFlightSettings.advanced_hud_enabled_scm` | ignored : A display or aiming preference of the player, of no use on a dashboard; the first frame after a seat change can also carry stale settings. | - |
| `VehicleFlightSettings.advanced_hud_enabled_nav` | ignored : A display or aiming preference of the player, of no use on a dashboard; the first frame after a seat change can also carry stale settings. | - |
| `VehicleFlightSettings.advanced_hud_labels` | ignored : A display or aiming preference of the player, of no use on a dashboard; the first frame after a seat change can also carry stale settings. | - |
| `VehicleFlightSettings.course_prediction` | ignored : A display or aiming preference of the player, of no use on a dashboard; the first frame after a seat change can also carry stale settings. | - |
| `VehicleFlightSettings.ifcs_wind_compensation` | `poll.ship.flight_modes.wind_compensation` | ignored : Not in the list of verified flight modes: available to the model, not drawn. |
| `VehicleFlightSettings.ifcs_g_safe_disabled_by_boost` | `poll.unverified.ship.flight_settings.g_safe_disabled_by_boost` | Unverified values card (`unverified`) |
| `VehicleFlightSettings.ifcs_command_behaviour` | `poll.ship.flight_modes.command_behaviour` | ignored : Not in the list of verified flight modes: available to the model, not drawn. |
| `VehicleFlightSettings.flight_light_amplification` | ignored : A display or aiming preference of the player, of no use on a dashboard; the first frame after a seat change can also carry stale settings. | - |
| `VehicleFlightState.is_landed` | `poll.ship.landed` | Ship state banner (`mode`) |
| `VehicleFlightState.gear` | `poll.ship.gear` | Landing gear and VTOL (`gear`) |
| `VehicleFlightState.vtol` | `poll.ship.vtol` | Landing gear and VTOL (`gear`) |
| `VehicleFlightState.transformation` | `poll.unverified.ship.transformation` | Unverified values card (`unverified`) |
| `VehicleFlight.state` | `poll.ship.landed` | Ship state banner (`mode`) |
| `VehicleFlight.settings` | `poll.ship.flight_modes` | Flight modes line (`modes`) |
| `VehicleFlight.instruments` | `poll.ship.instruments` | Speed dial (`speed`) |
| `VehicleFlightInstruments.speed` | `poll.ship.instruments.speed_ms` | Speed dial (`speed`) |
| `VehicleFlightInstruments.hydrogen_fuel` | `poll.ship.instruments.hydrogen_fuel` | Hydrogen gauge and estimated range (`hydrogen`) |
| `VehicleFlightInstruments.quantum_fuel` | `poll.unverified.ship.quantum_fuel` | Unverified values card (`unverified`) |
| `VehicleFlightInstruments.g_meter` | `poll.ship.instruments.g` | G-force dial (`g`) |
| `VehicleFlightInstruments.boost` | `poll.ship.instruments.boost` | Boost gauge (`boost`) |
| `VehicleFlightInstruments.altitude` | `poll.ship.instruments.altitude_m` | Altitude and radar altitude (`altitude`) |
| `VehicleFlightInstruments.radar_altitude` | `poll.ship.instruments.radar_altitude_m` | Altitude and radar altitude (`altitude`) |
| `VehicleFlightInstruments.vertical_speed_indicator` | `poll.ship.instruments.vertical_speed_ms` | Vertical speed bar (`vspeed`) |
| `VehicleFlightInstruments.atmospheric_density` | `poll.unverified.ship.atmospheric_density` | Atmospheric density (`atmosphere`) |
| `VehicleFlightInstruments.heading` | `poll.ship.instruments.heading_deg` | Compass (`heading`) |
| `VehicleThrusterBoost.engaged` | `poll.ship.instruments.boost.engaged` | Boost gauge (`boost`) |
| `VehicleThrusterBoost.output` | `poll.ship.instruments.boost.output` | Boost gauge (`boost`) |
| `VehicleThrusterBoost.reserves` | `poll.ship.instruments.boost.reserves` | Boost gauge (`boost`) |
| `VehicleThrusterBoost.critical` | `poll.ship.instruments.boost.critical` | Boost gauge (`boost`) |
| `VehiclePowerState.powerplants` | `poll.ship.power.powerplants` | Power diagram (`power`) |
| `VehiclePowerState.engines` | `poll.ship.power.engines` | Power diagram (`power`) |
| `VehiclePowerState.weapons` | `poll.ship.power.weapons` | Power diagram (`power`) |
| `VehiclePowerState.coolers` | `poll.ship.power.coolers` | Power diagram (`power`) |
| `VehiclePowerState.life_support` | `poll.ship.power.life_support` | Power diagram (`power`) |
| `VehiclePowerState.gravity_generators` | `poll.ship.power.gravity_generators` | Power diagram (`power`) |
| `VehiclePowerState.sensors` | `poll.ship.power.sensors` | Power diagram (`power`) |
| `VehiclePowerState.shield_generators` | `poll.ship.power.shield_generators` | Power diagram (`power`) |
| `VehiclePowerState.shield_emitters` | `poll.ship.power.shield_emitters` | Power diagram (`power`) |
| `VehicleAnnunciator.pwr` | `poll.ship.warning_lights.pwr` | Warning light panel (`lights`) |
| `VehicleAnnunciator.wpn` | `poll.ship.warning_lights.wpn` | Warning light panel (`lights`) |
| `VehicleAnnunciator.thr` | `poll.ship.warning_lights.thr` | Warning light panel (`lights`) |
| `VehicleAnnunciator.shld` | `poll.ship.warning_lights.shld` | Warning light panel (`lights`) |
| `VehicleAnnunciator.cool` | `poll.ship.warning_lights.cool` | Warning light panel (`lights`) |
| `VehicleAnnunciator.qdrv` | `poll.ship.warning_lights.qdrv` | Warning light panel (`lights`) |
| `VehicleAnnunciator.radr` | `poll.ship.warning_lights.radr` | Warning light panel (`lights`) |
| `VehicleAnnunciator.prox` | `poll.ship.warning_lights.prox` | Warning light panel (`lights`) |
| `VehicleAnnunciator.hit` | `poll.ship.warning_lights.hit` | Warning light panel (`lights`) |
| `VehicleAnnunciator.misl` | `poll.ship.warning_lights.misl` | Warning light panel (`lights`) |
| `VehicleState.name` | `poll.ship.name` | Ship name and maker (`ship`) |
| `VehicleState.class_name` | `poll.ship.class_name` | Ship name and maker (`ship`) |
| `VehicleState.manufacturer` | `poll.unverified.ship.manufacturer` | ignored : The game never fills the maker: the server derives it from the class prefix (`ship.manufacturer_derived`) and the View shows that. |
| `VehicleState.type` | `poll.ship.type` | ignored : Always the same value for the ships that send vehicle data (ground vehicles send none). |
| `VehicleState.lights_enabled` | `poll.unverified.ship.lights_on` | Ship lights (`headlights`) |
| `VehicleState.doors` | `poll.unverified.ship.doors` | Unverified values card (`unverified`) |
| `VehicleState.annunciators` | `poll.ship.warning_lights` | Warning light panel (`lights`) |
| `VehicleState.flight` | `poll.ship.instruments` | Speed dial (`speed`) |
| `VehicleState.power` | `poll.ship.power` | Power diagram (`power`) |
| `VehicleFrame.state` | `poll.ship` | Ship name and maker (`ship`) |
| `WeaponsSettings.fallback_convergence_distance` | ignored : A display or aiming preference of the player, of no use on a dashboard; the first frame after a seat change can also carry stale settings. | - |
| `WeaponsSettings.magnified_ui` | ignored : A display or aiming preference of the player, of no use on a dashboard; the first frame after a seat change can also carry stale settings. | - |
| `WeaponsSettings.precision_lines` | ignored : A display or aiming preference of the player, of no use on a dashboard; the first frame after a seat change can also carry stale settings. | - |
| `WeaponsSettings.staggered_fire` | ignored : A display or aiming preference of the player, of no use on a dashboard; the first frame after a seat change can also carry stale settings. | - |
| `WeaponsSettings.use_lag_pips` | ignored : A display or aiming preference of the player, of no use on a dashboard; the first frame after a seat change can also carry stale settings. | - |
| `WeaponsSettings.use_single_pips` | ignored : A display or aiming preference of the player, of no use on a dashboard; the first frame after a seat change can also carry stale settings. | - |
| `WeaponsSettings.use_fading_pips` | ignored : A display or aiming preference of the player, of no use on a dashboard; the first frame after a seat change can also carry stale settings. | - |
| `WeaponsSettings.gimbals_locked` | `poll.unverified.weapons.gimbals_locked` | Gimbals lock (`gimbals`) |
| `WeaponState.name` | `poll.weapons.weapons[].name` | Weapons of the seat (`weapons`) |
| `WeaponState.is_powered` | `poll.weapons.weapons[].powered` | Weapons of the seat (`weapons`) |
| `WeaponState.ready_to_fire` | `poll.weapons.weapons[].ready` | Weapons of the seat (`weapons`) |
| `WeaponState.contained_in_preset` | ignored : Weapon presets are not in the stream (field test): not exposed. | - |
| `Countermeasures.type` | `poll.weapons.countermeasures` | Countermeasures (`cm`) |
| `Countermeasures.amount` | `poll.weapons.countermeasures.decoy` | Countermeasures (`cm`) |
| `WeaponsFrame.settings` | `poll.unverified.weapons.gimbals_locked` | Gimbals lock (`gimbals`) |
| `WeaponsFrame.preset_index` | ignored : Weapon presets are not in the stream (field test): not exposed. | - |
| `WeaponsFrame.preset_name` | ignored : Weapon presets are not in the stream (field test): not exposed. | - |
| `WeaponsFrame.weapons` | `poll.weapons.weapons` | Weapons of the seat (`weapons`) |
| `WeaponsFrame.countermeasures` | `poll.weapons.countermeasures` | Countermeasures (`cm`) |
| `GameEvent.type` | `state.game_events[]` | ignored : The game sent no usable event in the field test; the names of the last frame stay in `sc_live_state` and nothing is built on them. |
| `EventsFrame.events` | `state.game_events` | ignored : The game sent no usable event in the field test; the names of the last frame stay in `sc_live_state` and nothing is built on them. |
| `AxisFeedback.resistance` | ignored : Force feedback for joysticks: not in the stream (field test) and of no use here. | - |
| `AxisFeedback.damping` | ignored : Force feedback for joysticks: not in the stream (field test) and of no use here. | - |
| `FeedbackAxes.x` | ignored : Force feedback for joysticks: not in the stream (field test) and of no use here. | - |
| `FeedbackAxes.y` | ignored : Force feedback for joysticks: not in the stream (field test) and of no use here. | - |
| `FeedbackAxes.z` | ignored : Force feedback for joysticks: not in the stream (field test) and of no use here. | - |
| `ForceFeedbackFrame.angular` | ignored : Force feedback for joysticks: not in the stream (field test) and of no use here. | - |
| `ForceFeedbackFrame.linear` | ignored : Force feedback for joysticks: not in the stream (field test) and of no use here. | - |
| `ForceFeedbackFrame.gunfire` | ignored : Force feedback for joysticks: not in the stream (field test) and of no use here. | - |
| `ForceFeedbackFrame.stick_shaker` | ignored : Force feedback for joysticks: not in the stream (field test) and of no use here. | - |
| `ActorVitals.health` | `poll.pilot.health` | Health (`health`) |
| `ActorVitals.oxygen` | `poll.unverified.pilot.oxygen` | Unverified values card (`unverified`) |
| `ActorVitals.hunger` | `poll.pilot.hunger` | Hunger (`hunger`) |
| `ActorVitals.thirst` | `poll.pilot.thirst` | Thirst (`thirst`) |
| `ActorVitals.body_temperature` | `poll.unverified.pilot.body_temperature` | Unverified values card (`unverified`) |
| `ActorVitals.heart_rate` | `poll.pilot.heart_rate_bpm` | Heart rate (`heart`) |
| `ActorVitals.gravity` | `poll.pilot.gravity_g` | Gravity (`gravity`) |
| `ActorVitals.pressure` | `poll.pilot.pressure` | Pressure (`pressure`) |
| `ActorVitals.intoxication_level` | `poll.unverified.pilot.intoxication_level` | Unverified values card (`unverified`) |
| `ActorEnvironment.external_temperature` | `poll.pilot.outside_temperature_c` | Outside temperature (`temperature`) |
| `ActorEnvironment.ambient_radiation_rate` | `poll.unverified.pilot.ambient_radiation_rate` | Unverified values card (`unverified`) |
| `ActorEnvironment.breathable_atmosphere` | `poll.pilot.breathable_atmosphere` | Atmosphere breathable (`air`) |
| `ActorState.locomotion` | `poll.pilot.locomotion` | Body position (`locomotion`) |
| `ActorState.crew_role` | `poll.pilot.crew_role` | Crew role and seat (`crew`) |
| `ActorState.seat_name` | `poll.pilot.seat` | Crew role and seat (`crew`) |
| `ActorState.uec_balance` | `poll.balance.uec` | Balance (hidden by default) (`balance`) |
| `ActorFrame.vitals` | `poll.pilot` | Health (`health`) |
| `ActorFrame.state` | `poll.pilot.locomotion` | Body position (`locomotion`) |
| `ActorFrame.environment` | `poll.pilot.outside_temperature_c` | Outside temperature (`temperature`) |
| `TurretFrame.light_amplification` | ignored : Turret seats only, never verified, of no use on a dashboard. | - |
| `TelemetryStreamResponse.vehicle` | `poll.ship` | Ship name and maker (`ship`) |
| `TelemetryStreamResponse.weapons` | `poll.weapons` | Weapons of the seat (`weapons`) |
| `TelemetryStreamResponse.events` | `state.game_events` | ignored : The game sent no usable event in the field test; the names of the last frame stay in `sc_live_state` and nothing is built on them. |
| `TelemetryStreamResponse.actor` | `poll.pilot` | Health (`health`) |
| `TelemetryStreamResponse.force_feedback` | ignored : Force feedback for joysticks: not in the stream (field test) and of no use here. | - |
| `TelemetryStreamResponse.turret` | ignored : Turret seats only, never verified, of no use on a dashboard. | - |

## What the tools do with it

| Tool | Listed | Purpose |
| --- | --- | --- |
| `sc_live_status` | always | The state of the stream, why, and how to enable it |
| `sc_live_state` | when `SC_TELEMETRY=on` | A snapshot with the age of the last frame, the conditions of the moment and what is not available |
| `sc_live_events` | when `SC_TELEMETRY=on` | Recent derived events, each marked `confirmed` or `unverified` |
| `sc_live_dashboard` | when `SC_TELEMETRY=on` and the client can show Views | Opens the [live dashboard](#live-dashboard) in the conversation |
| `sc_live_poll`, `sc_live_mark` | same | Used by the dashboard itself to refresh and to set session markers. Claude is told not to call them |

States: `off` (server switch not set), `waiting` (no telemetry for now: normal in menus, during loading, before the
character has appeared, or if the game was started without the game-side setting; this server cannot tell whether
the game is running), `game_without_telemetry` (the game runs, `Game.log` has no registration line: restart the
launcher), `connected` (the HTTP/2 session with the game is open, no frames yet: menus or loading), `live`,
`incompatible` (the game answers in a shape we do not know: a patch changed it).

The reader starts at the first request, reconnects with a growing delay, stops after five minutes without a request,
and keeps everything in memory only. Events exist only for the time the server was running while the game was
sending frames, and they are inferred, not reported by the game.

## Live dashboard

An optional live view of the same stream, drawn inside the conversation. Compact: the ship, where it is, three dials
(speed, hydrogen, health), the alerts and a one-line verdict ("all is well" or "watch this"). Full screen: a cockpit
with the instruments on the left, the ship in the middle and the pilot on the right. It is an MCP App: a small page
that this server provides and that the client renders next to the chat.

- **Who shows it.** Claude Desktop is the host we tested (Microsoft Store build 4.4212.0, server declared in
  `claude_desktop_config.json`). **Claude Code and other text clients do not render it**: for them the three
  dashboard tools are not listed at all, so the model never sees them. The server lists them only when
  `SC_TELEMETRY=on` AND the client declared the MCP Apps extension at start. Other hosts that render MCP Apps
  may work; we have not tried them. The layout was iterated in a real browser against a fake host (360 to 2000 px,
  light and dark); **it has not been seen inside Claude Desktop by us**.
- **How to open it.** Switch the telemetry on (see above), restart Claude Desktop completely (quit it from the
  tray, not only the window), then ask Claude to open the live dashboard. Claude calls `sc_live_dashboard`, which
  tells it not to open a second one while one is already open (`hint` in the result). While it is open you can
  keep talking to Claude: it answers from `sc_live_state`, not from the page.
- **Two modes.** Inline: a compact view. Full screen (button in the page): the cockpit. The button asks the host; if
  the host answers with another mode the page follows what it is told.
- **What the cockpit shows.** Instruments: a speed dial whose scale is deduced from the speeds seen and says so
  (quantum travel is shown as "quantum mode" instead of flattening the scale), a G dial against the maximum the game
  reports, altitude with the radar altitude, a vertical speed bar around zero, a compass only when the heading is
  valid, and 60 second curves with their minimum and maximum. Energy: hydrogen with an estimated range, boost reserve
  and output. The nine power flags as a diagram, the flight modes, the ten warning lights as an annunciator panel
  (state in words, not only colour), weapons of your seat in one sentence plus a row each, countermeasures against
  the highest count seen for this vehicle. Pilot: health, hunger and thirst dials, heart rate, gravity, outside
  temperature, atmosphere, body position, role. One chronology of events and your own markers, with filters, a
  session card, the route plan, and two foldable lines: the unverified values and what the stream does not contain.
  Every datum can be pinned (a pin icon on hover or focus): it then appears in a bar under the header in both modes.
- **A ship that is off.** When the powerplant is reported off, the page shows "Vaisseau éteint", dashes instead of
  zeros, and adds nothing to the curves. Nothing is coloured red just because it is absent.
- **Alerts of the moment (conditions).** `sc_live_poll` (and `sc_live_state`) carry a `conditions` array computed
  from the current state, not from the history; the page shows it as coloured chips with the time they have lasted,
  before the recent events: blue for information, amber for a warning, red for critical. A condition that is not
  confirmed by the field test says "non vérifié".

  | Condition | Level | When |
  | --- | --- | --- |
  | `shields_off` | info in quantum mode (`data.quantum`), otherwise warning | A shield power flag (generators or emitters) is off, the powerplant is on, the ship is not on the ground. Only for a ship that was seen with both on |
  | `shields_down` | critical | The SHLD light is major |
  | `powerplant_off` | critical | The powerplant flag is off. The other power conditions (engines, shields, weapons) are then not raised |
  | `engines_off` | warning (info on the ground) | Powerplant on, engines flag off |
  | `engines_damaged` | warning | THR light minor |
  | `weapons_unpowered` | warning | WPN light major |
  | `hostile_lock` | critical | RADR light major |
  | `under_fire`, `proximity` | warning | HIT light, PROX light (not with the gear down) |
  | `hydrogen_low` | warning, unverified | Below 15 percent |
  | `boost_critical` | warning | The boost reports critical |
  | `countermeasures_low`, `countermeasures_empty` | warning, critical | Same thresholds as the events (three bursts or fewer; none), for a kind that was seen with some |
  | `health_low`, `down_or_dead` | warning, critical | Health under 30 percent; health 0 |
  | `hunger_low`, `thirst_low` | info | Under 25 percent |
  | `not_breathable` | critical, unverified | The atmosphere is reported as not breathable |
  | `in_quantum`, `in_jump` | info | Quantum mode on; a jump in progress |

  Measured on a real Aegis Harbinger (4.10.2): in quantum mode the SHLD light goes off and both shield power flags go
  false, and everything comes back on arrival. Events `shields_powered_off` and `shields_powered_on` (confirmed,
  debounced, silent at the baseline of a new vehicle) record it, the first with the quantum context. A ship that was
  never seen with its shields on (a ship without shields, or a dashboard opened while already in quantum mode)
  raises nothing for them: the trade-off is deliberate, to avoid a permanent false alarm.
- **Age and gaps.** Every card shows the age of its frame, and everything turns grey when the stream is not live.
  Nothing is invented: a missing field is shown as a dash, health 0 reads "down or dead", and one collapsible line
  lists what the stream does not contain.
- **Estimates are labelled.** Remaining hydrogen, hunger and thirst are straight-line estimates over the last
  minutes, shown with their window. The speed scale is deduced, not given by the game. Pace (aUEC per hour) appears
  only while the balance is shown, from the balance change since the session marker.
- **Route plan.** After `uex_get_trade_routes`, Claude may pass a `plan` (commodity, buy and sell terminals, SCU,
  expected profit, a short note) when it opens the dashboard. The page shows planned next to measured profit. The
  text is cleaned and capped (60 characters) and displayed as plain text.
- **Balance privacy.** The balance is hidden in the page until you click "Afficher le solde". Only then does the
  page ask the server for it (`include_balance`). The balance is never put in the automatic summary that the
  page may send to the model, nor in the fixed messages of the buttons, nor on the channel between dashboards (see
  below), with one exception: the button "Route avec mon solde et ce vaisseau" sends it in a message, says so in the
  text, and only when you press it.
- **What the buttons do.** "Analyser ma situation", "Route avec mon solde et ce vaisseau" and "Bilan de session" post
  a short fixed message in the conversation, as if you had typed it, asking Claude to use `sc_live_state` and
  `sc_live_events`; a confirmation appears next to the buttons and clears itself. Session markers live in this
  server's memory. Nothing in the page sends anything to the game.
- **Several dashboards: the facts.** Each dashboard is a separate iframe with its own calls to `sc_live_poll`, once
  a second while it is visible. Claude Desktop never unmounts the older ones. Server side nothing multiplies: one
  answer is shared for half a second whatever the number of Views. But every View that was open and visible made its
  own round trip to the host. Measured against the fake host, a minute of calls per second: 1, 3 and 5 dashboards
  made 1.00, 3.00 and 5.00 calls per second before; they make 1.00 whatever the number now.
- **Several dashboards: the fix.** Dashboards of one connector share an origin in Claude Desktop (documented by
  Anthropic; not verified by us), so they announce themselves on a `BroadcastChannel` (no network: the content policy
  of the page does not govern it). The most recent visible one is the leader and polls; the others stop calling the
  server, show "Remplacé par un tableau de bord plus récent" with a "Reprendre ici" button, and keep showing the
  leader's answer, shared about once a second. A hidden, scrolled-away or closed leader, or one silent for 6 seconds,
  gives way to the next one. What comes over the channel is treated as untrusted: types, ranges and lengths are
  checked, the answer is rebuilt field by field, the balance and the wallet events never leave a View, and only the
  leader sends a summary to the model. Without `BroadcastChannel` the old behaviour applies and a dashboard away for
  30 seconds retires. The model is also told not to open a second dashboard when one is open.
- **Load.** The page polls about once a second while it is visible and leads (never faster than twice a second),
  every 5 seconds when the stream is off or cut. It asks only for what it lacks: events newer than the last it holds,
  the sections whose hash changed, and the list of what the stream lacks once. Measured on the made-up flight over
  two minutes: 3810 bytes a second before, 2185 after. It stops when the window is hidden or scrolled out of view,
  and retires after 30 minutes away until you click "Reprendre". Closing or hiding for good removes every timer,
  listener and channel.
- **No network, no package.** The page is one file inside this server: no CDN, no font, no request. It declares
  its own restrictive content policy and sets every text with `textContent`.

The dashboard shows what the stream shows and inherits every limit and risk of this page. We do not claim it is
approved by Cloud Imperium Games.

A preview for people who work on the page: `npm run build`, then `node scripts/dashboard-preview.mjs`, then open
the local address it prints (loopback, port 4173 by default). It plays a made-up flight, including a full quantum
jump, against a fake host; no game and no Claude is involved. Parameters: `t`, `theme`, `w`, `mode`, `scroll`,
`forced`, `cut`, `plan`.

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
| `waiting` | No telemetry for now. Not a sign that the game is off: this server cannot know | Nothing to fix if you are in menus or loading. If you are in the game with your character spawned and it stays `waiting`, see the next line |
| `waiting` (character spawned for a while) or `game_without_telemetry` | The game was started without the variable | Quit the RSI Launcher completely, tray icon included, start it again, start the game. Check `Game.log` for the "registered" line |
| `connected` but no data | Menus or loading | Spawn in. Data starts after the character exists |
| `live` but no ship data | You are on foot or in a ground vehicle. This is normal | Sit in a ship. Ship data comes 6 to 9 seconds later |
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
