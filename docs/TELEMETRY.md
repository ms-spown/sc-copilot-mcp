# Live telemetry

English · [Français](TELEMETRY.fr.md)

An optional, **off by default** way for sc-copilot-mcp to see what the running game reports about your ship and
your character: speed, altitude, fuel, power, warning lights, health, wallet. Read this whole page before you
switch it on, in particular [Risks](#risks).

> **Read this first**
>
> - **What it is.** An optional way to let Claude read what the running game reports about your ship and character (speed, fuel, power, health, wallet), through an undocumented local feature of Star Citizen. It is local and read-only, and off by default.
> - **Two switches, both yours.** `SC_TELEMETRY=on` in the server entry, and `GRPC_CLIENT_SERVER_ENABLED=true` for the RSI Launcher ([details](#two-switches-both-explicit)). Installing or updating sets neither.
> - **Risks.** CIG has neither allowed nor forbidden it, the RSI terms apply to you, and the risk is yours: read [Risks](#risks) (near the end of this page) before you switch it on.
> - **Not verified.** The maintainer has not yet seen the dashboard itself inside Claude Desktop (see [Who shows it](#live-dashboard)).
> - **Turn it off.** `npm run telemetry -- disable --apply` (without `--apply`, `enable` and `disable` are dry runs that write nothing). It removes only what the tool set: a variable you set by hand stays, and the command says how to remove it. Then restart Claude Desktop, quit the RSI Launcher completely (tray icon too) and start it again. It does not delete your saved sessions.
> - **What is saved, and how to erase it.** Frames and raw log lines stay in memory and are never written. The one exception is the session summary: the balance at the start and at the last sighting; the game version, the times (including how long the game was seen running) and the breaks; the last place and goods the log named; your note; the count of refused prices; ship losses: time, model, cause, place, presumed cargo (SCU and aUEC paid); and, for each trip, its label (contract title, places, goods), quantity, cost, revenue, margin, fees, net and the applied plan (planned profit, quantity, terminals). It is kept in a local file, `sessions.json`, only when telemetry is on; this server never sends it anywhere, except that the `sc_session_*` tools return parts of it to your MCP client, and so to your conversation (money figures included, unless you hide them: "Masquer le solde" in the dashboard or `SC_BALANCE=hidden` hides them from the tools until you click "Afficher le solde", and `include_balance` false hides them from one call); `SC_SESSIONS=off` disables it; and deleting `sessions.json` and the `.bak` and `.corrupt` copies next to it erases it. Details: [Saved sessions](#saved-sessions).

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
  remove it. It does not delete your saved sessions (`sessions.json`, which holds balances): see
  [Saved sessions](#saved-sessions) to wipe them.
- Both commands are dry runs unless you pass `--apply`. Restart Claude Desktop after a change to its configuration.

### Only for one launch (`--session`)

```bash
npm run telemetry -- enable --session --apply
```

Without `--apply` this is a dry run and writes nothing. With it, the command creates a small launcher script,
`start-rsi-launcher-with-telemetry.cmd`, in `%APPDATA%\sc-copilot-mcp\` (`disable --apply` removes it); the script sets
the variable only for the RSI Launcher it starts. Nothing permanent is
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
| `ActorState.uec_balance` | `poll.balance.uec` | Balance (shown by default, can be hidden) (`balance`) |
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
| `sc_trade_suggest` | same | Used by the dashboard's commerce buttons only (the [action bar](#trade-actions-find-the-next-route) and the [pre-flight check](#before-leaving-the-pre-flight-check-and-the-price-that-moved)): the trade planner, or one price re-read for the plan in force, behind a throttle. Claude is told not to call it; it uses `uex_plan_trade` |

States: `off` (server switch not set), `waiting` (no telemetry for now: normal in menus, during loading, before the
character has appeared, or if the game was started without the game-side setting; this server cannot tell whether
the game is running), `game_without_telemetry` (the game runs, `Game.log` has no registration line: restart the
launcher), `connected` (the HTTP/2 session with the game is open, no frames yet: menus or loading), `live`,
`incompatible` (the game answers in a shape we do not know: a patch changed it).

**Connection state (from `Game.log`).** The stream does not tell when the player is cut from the game: it goes quiet
or keeps repeating its last values. When the game log is configured (`SC_INSTALL_DIR` or `SC_GAME_LOG_PATH`),
`sc_live_status`, `sc_live_state` and the dashboard also read where the player stands towards the servers, from the
lines the game writes (markers seen in a real log: two kicks, the menu and the rejoin between them; each is
matched on the line's own tag, so a marker word inside free text cannot forge a state): joined a server (`online`), cut by the
server (`disconnected`, with the game's own code, for example 30028 for inactivity), back in the menus (`menu`), game
quit (`closed`). When it is not `online`, the dashboard says so at once in red, greys every value and shows no
"no alert" line, and the tools say the last values are not current. Only a state, a time and a numeric code reach the
tools (the game's own reason text stays in the page, as text only); no handle, address or session id. A voluntary
quit to the menu and a server change are not yet checked on a real log. One `stat` per poll, and only the bytes added since the last
read are parsed. Without a configured log nothing is reported, and nothing is claimed either way.

The reader starts at the first request, reconnects with a growing delay, stops after five minutes without a request
(with saved sessions on, it is kept alive while the game runs and the session summaries are saved: see
[Saved sessions](#saved-sessions)), and keeps frames and events in memory only. Events exist only for the time the server was running while the game was
sending frames, and they are inferred, not reported by the game.

## Live dashboard

An optional live view of the same stream, drawn inside the conversation. Compact: the ship, where it is, three dials
(speed, hydrogen, health), the alerts and a one-line verdict ("all is well", "watch this", or the price refused at the
kiosk). Full screen: a cockpit
with the instruments on the left, the ship in the middle and the pilot on the right. It is an MCP App: a small page
that this server provides and that the client renders next to the chat.

- **Who shows it.** Claude Desktop is the host we tested (Microsoft Store build 4.4212.0, server declared in
  `claude_desktop_config.json`). **Claude Code and other text clients do not render it**: for them the
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
- **The compact view, in the order of what a glance in flight needs.** The header with the verdict, then the price
  refusal if there is one, the alerts (no row at all while there is none: the verdict says it), the three dials, the
  ship on one small row, the session on ONE line ("Session 4 · 6 trajets · 1 h 28 min", plus the net per hour only
  while the balance is shown; a real button with `aria-expanded` unfolds the whole card, which keeps **Nouvelle
  session** as a secondary button), the balance row beside it, then the contract line and "Chercher une route". Measured
  in real Chrome on the preview's made-up flight, at 560 px: 691 px high before, 326 px now; at 360 px with a price
  refusal 915 px before, 510 px now. Not verified: how Claude Desktop sizes the inline frame.
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
  The short readings that explain a label are reachable by keyboard and touch, not only by hover: in the compact view the age
  of the data ("Données de ...") and the legend under the speed dial (its scale and source), in both views the clock time of a
  refused price (the header verdict), in full screen the confidence tag of a calibrated figure. Tab to the label, or tap it; Enter or Space
  closes the bubble if it is open and opens and keeps it if it is not, a tap keeps it open, Escape (only when a bubble is
  open), a tap elsewhere, a scroll or a resize closes it. The lamps and the power nodes are named in full ("Radar : verrouillage
  hostile, nominal") for a screen reader and show that name on hover or tap; they are not tab stops.
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

  The health dial uses the same limit as `health_low`: red under 30 percent, amber from 30 to under 50 percent, green from
  50 percent (a choice, not a measure). The health band sent to the model follows it: low under 30 percent, medium
  under 50 percent.

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
- **Route plan.** After `uex_get_trade_routes`, Claude may pass a `plan` when it opens the dashboard: commodity, buy
  and sell terminals, SCU, `expected_profit_auec` (the planned PROFIT: sales minus purchases before any fee, not a
  turnover), unit buy and sell prices, an estimated trip time in minutes, a safety note, a short note and up to 30
  recent prices (`price_points`, oldest first, with `price_points_for` and `price_points_label`) that draw the
  price curve. Claude fills the prices from the UEX price tools; the price curve never comes from a dashboard call to UEX. Text is cleaned and
  capped (60 characters) and displayed as plain text; numbers are bounded; fewer than two usable price points make no
  curve. The plan feeds the commerce card below. A suggested route has the same shape as a plan: the action bar (see Trade
  actions) applies one through the same cleaner.
- **Balance privacy.** The balance is shown in the page by default (the server's default since 2.6; it started hidden before). "Masquer le solde" hides it on that screen AND for Claude's tools: the page tells the server (a click, sent once), and from then on `sc_live_state`, `sc_live_events`, `sc_session_*` and `sc_trade_journal` answer without amounts, an `include_balance: true` is ignored (an instruction hidden in a UEX name or a journal note cannot reveal them) and the answer says the player hid them. "Afficher le solde" lifts it; the last click wins, whichever dashboard it comes from, and every dashboard follows the server's state at its next poll (a new one reads it on mounting). The click is kept in the memory of THIS server process only, never in a file: **a server restart forgets it** (the dashboard then starts as the configuration says, except that a dashboard that holds its own "Masquer" click says it again to the restarted server instead of showing the balance; a click of another dashboard on "Afficher le solde" is followed), another client or another server process has its own memory (Claude Desktop can start two), so a click protects only the tools of the same process, and only `SC_BALANCE=hidden` covers every client durably. Lifting the mask needs a token that only the served page carries (a caller that did not read the page is refused; hiding needs none). With `SC_BALANCE=hidden` in the server's entry the dashboard starts hidden and the tools answer without amounts, permanently; a click on "Afficher le solde" lifts it for the running process. The hidden state is visible and reversible: the "Solde" row reads "••••••" with its button. Whatever the state, the balance is never put in the automatic summary that the page may send to the model, nor in the fixed messages of the buttons, nor on the channel between dashboards (a dashboard that follows another one shows it hidden, with the button to take the lead), with one exception: the button "Route avec mon solde et ce vaisseau" sends it in one message, says so in the text, and only when you press it; it changes nothing else (not the server's choice, not the screen). `include_balance: false` hides one call. When amounts are shown they reach the model and your conversation: it is your choice.
- **Health strip: what is wired, what is missing.** A new player who installs the server sees a dashboard that
  silently shows less than it could: without the game log there is no connection state (a "kicked for inactivity"
  stays invisible), no trade journal, no ledger and weaker session figures; with telemetry off nothing at all; a game
  started without the game-side variable shows only "Jeu lancé sans télémétrie". The page now says so itself. It is
  **invisible while nothing needs doing**; when something is missing, ONE line ("3 réglages à faire", with a "Voir"
  button that has `aria-expanded`) says how many; unfolded, it names each point, says what is lost and gives the exact
  fix, in a box you can copy with a button (the clipboard may be refused in the host's
  sandbox: the text is then selected and the page says to press Ctrl+C). The button "?" in the header opens the full
  list at any time, with "Tout est branché" (or "Rien à régler pour l'instant" when a line only waits for the game) and
  the legend below. The eight lines:
  1. **Telemetry**: its state and, when it is off, `npm run telemetry -- enable` (a dry run: add `--apply`).
  2. **Game log** (`SC_INSTALL_DIR` or `SC_GAME_LOG_PATH`): not configured, configured but unreadable (the file only
     exists after a first launch, or the folder is wrong), or read. The page shows the NAME of the setting and a fixed
     short label (`LIVE/Game.log`, `Game.log`, `custom`), never a path and never a value: the server builds the label
     and the page accepts only that list. The fix is the line to add by hand to the `env` block of the `sc-copilot`
     entry (`npm run install:claude` keeps that block as it is but does not add this line, so it is not suggested).
  3. **The registration line** of the telemetry service in `Game.log`: seen, not seen (the game was started without
     `GRPC_CLIENT_SERVER_ENABLED`: quit the RSI Launcher completely, tray icon included), or not checkable yet.
  4. **Connection state** and 5. **trade journal and ledger**: they need the log; they point to line 2 instead of
     repeating it.
  6. **Saved sessions**: on (with the time of the last write of this server process), off by `SC_SESSIONS=off` (a
     deliberate choice: listed behind the "?", not a reminder), read-only (a newer file) or degraded (a write failed,
     the sessions stay in memory).
  7. **Balance**: whether it is shown or hidden on this screen, what "Masquer le solde" and "Afficher le solde" do (the mask also covers Claude's tools, is sticky, and is forgotten when the server restarts: `SC_BALANCE=hidden` is the permanent way), nothing in the automatic summary or on the channel between dashboards, only the route button sends it (when you press it), and that the saved sessions keep their figures in a local file.
  8. **Freshness of the data**: not measured here (it would need the sources, so the network); the line points to
     `sc_data_status`.

  The server adds one small `health` object to the poll answer: codes (`log`: `off`, `unchecked`, `ok`, `unreadable`;
  `registration`; `sessions`), the setting name, the fixed label and the time of the last write. It is built from what
  the server already holds (the telemetry state, the game-log hint the service keeps, the connection tracker's answer,
  the session bar): **no new network, no new file read** (with telemetry off nothing is read at all and the log is
  reported as "not checked"), no amount, nothing derived from the balance, and it takes no part in the section hashes.
  Every sentence and every command is written in the page; the page rebuilds the object field by field and drops the
  whole of it when a `log`, `registration` or `sessions` code is unknown (an unknown setting name or label is dropped
  alone). `npm run doctor` stays the deep check (it reads the Claude config, the user
  variable and the port); the page does not duplicate it.
- **How to read the dashboard (the legend).** Shown at the first open (in the compact view only when something needs setting up, so that the dials stay first) and behind the "?" afterwards: **Mesuré**
  (sent by the game just now), **Calculé** (a sum or difference of measured values), **Estimé** (a trend over the last
  minutes, with its window), **Probable** (deduced from clues, never confirmed by the game), **Inconnu** (not sent by the
  game: a dash, never an invented zero). Each term has a glyph, and every state is written as well as coloured. "Grisé"
  means the values are not current, "non vérifié" that the field has never been seen working.
- **What the page remembers.** One flag in the browser's own storage, `sc-copilot-help-seen`: "the legend was read". It
  is best effort and never needed: when the storage is unavailable (a sandbox) the page works the same, and the legend
  opens by itself only when something needs setting up (closing it is then kept in memory for the session). The page stores nothing but this flag; what the server saves is described in [Saved sessions](#saved-sessions).
- **What the buttons do.** "Analyser ma situation", "Route avec mon solde et ce vaisseau" and "Bilan de session" post
  a short fixed message in the conversation, as if you had typed it, asking Claude to use `sc_live_state` and
  `sc_live_events`; a confirmation appears next to the buttons and clears itself. The first button follows the
  situation (it is "Analyser" in the compact header): "Analyser la perte" after a ship loss (asks for `sc_session_current` and
  `sc_trade_journal`), "Que faire maintenant ?" after a refused price (`sc_trade_journal`, `uex_get_price_history`,
  `uex_get_market_status`), "Debrief du trajet" for half an hour after a run ended (`sc_trade_journal`,
  `sc_session_current`, `uex_get_price_history`), else the plain analysis. Each message is fixed text: no number, no ship,
  nothing read from the log or the game, never a balance. The player's choice is read at the moment of the click:
  with the amounts hidden, every tool call in the message says `include_balance false` and the message says not to include
  the balance; with them shown, the message does not name `include_balance` at all (the server applies the player's
  choice, so the answers carry the amounts the dashboard itself shows). This rule is the same for "Analyser", "Bilan de
  session" and the three contextual messages. A refused item (not goods) leaves the plain "Analyser". The model is told to
  say so if a tool is missing, and, for the price history, to use the selling terminal named by the journal or by you, else to ask. Session markers live in this
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

### Gauges from the ship sheet

The speed dial can be drawn against the real limits of the ship instead of against what was seen so far. The
limits do not come from the game: they come from the ship's page on the Star Citizen Wiki, community-written and
labelled "wiki" wherever they are shown.

- **How the ship is found.** The stream gives a class name such as `AEGS_Vanguard_Harbinger`. The server turns it
  into words (the maker is derived from the prefix: Aegis; the ship is "Vanguard Harbinger") and asks the wiki,
  in the background and once per ship and per session, for the ships whose name contains the longest of those
  words. If exactly one row carries that very class name (`class_name`), it is the ship. Otherwise the words go
  through the same word matching as `sc_fleet_get` and only a single candidate is accepted. With several
  candidates nothing is chosen (`ambiguous`, with their names); with none the ship is `unknown`. A wiki that does
  not answer gives `error` and is asked again at most every five minutes. The poll never waits for the wiki: the
  first answers say `pending`.
- **What is read.** Speed in standard cruise mode (SCM) and maximum speed, cargo in SCU, shield and hull points.
  A value of 0 in the sheet means "not provided" and is never used as a limit. The sheet comes with its age
  (when this server read it), the date the wiki last changed it and the game version it is stamped with, when the
  wiki gives them. The figures are carried in `sc_live_poll` under `specs`, a fourth section of the lighter poll next to the ship,
  the pilot and the weapons: it is sent once, then left out (`unchanged`) while its hash (`have.specs`) is the one the
  View holds.
- **What the dial does with them.** The arc of the speed dial runs from 0 to the maximum speed of the sheet, with a
  mark at the SCM speed and one at the maximum, and the value is given as a share of the SCM speed ("87 % de la
  vitesse SCM"). Its scale line reads "d'après la fiche (wiki)" instead of the deduced scale. Above the SCM speed it
  says so; above the maximum of the sheet, and during a quantum jump, the speed is out of the frame and the View
  says that instead of cutting the arc silently. The card "Fiche du vaisseau (wiki)" of the full view lists every
  figure with its age.
- **What is not known.** The capacity of the hydrogen tank is not confirmed in the wiki data this project reads,
  so it is neither shown nor deduced: the hydrogen endurance stays the labelled straight-line estimate. The stream
  has no shield level or hull state either, so the sheet's shield and hull points are only a reference, not a
  gauge.
- **When the scale stays observed.** If the sheet is pending, unknown, ambiguous, unavailable, or gives no speed,
  the dial keeps the scale deduced from the speeds seen and one line says why ("échelle déduite : fiche du vaisseau
  introuvable"). A modified ship, a variant or a patch can differ from the wiki: check the age and the date before
  relying on a number.
- **Third-party text.** Names and versions from the wiki are cleaned and capped on the server, and shown as plain
  text. No new host is contacted: the wiki is already on the list of hosts this server may reach.

The dashboard shows what the stream shows and inherits every limit and risk of this page. We do not claim it is
approved by Cloud Imperium Games.

A preview for people who work on the page: `npm run build`, then `node scripts/dashboard-preview.mjs`, then open
the local address it prints (loopback, port 4173 by default). It plays a made-up flight, including a full quantum
jump, against a fake host; no game and no Claude is involved. The list that follows is not complete (`scripts/dashboard-preview.mjs` also reads `conn`, `preflight`, `transport`, `sessions`, `health`, `seen`, `help`, `calib`, `specs`, `balance`, `card`, `menu` and `open`): read that script for the current ones. Parameters: `t`, `theme`, `w`, `mode`, `scroll`,
`forced`, `cut`, `plan`, `trade` (the commerce card with an invented trade journal: `story`, `estimated`, `unknown`, `partial`, `second`, `none`), `fw` (frame width in full screen), `suggest` (what the commerce action bar's tool answers, with invented routes and no UEX: `ok`, `wait`, `error`, `empty`, `nospeed`, `reported`, `slow`), `click` (a button label to press) and `refine=1` (opens "Affiner").

### Context shortcuts

A zone "Raccourcis" under the ship banner reminds you of the actions that make sense at that moment (landing gear
out, on foot, in a ground vehicle...). It reads states the stream and `Game.log` already carry, never a figure and never
the balance, and it presses nothing: it is a display.

- **When it shows.** Only while the stream is live, `Game.log` does not say menu, disconnected or closed, and the values
  are not grey (no stale frames). Otherwise it is hidden. For a context it cannot name it shows nothing in the compact
  view and, in full screen, "Contexte inconnu : aucun rappel pour l'instant." (unknown context, no reminder yet).
- **What triggers what.** Gear out (`ship.gear` is "deployed") and not landed (`ship.landed` is false): "Atterrissage
  automatique", worded "si la demande est accordée" because a pad being granted is not in the stream, then the landing
  request. Landed: the take-off request. Powerplant off: Flight Ready. Quantum mode: the jump. Hostile lock: decoys
  and noise (a countermeasure the stream reports as spent is left out). Shields cut, that is their power off (in
  flight only, and not in quantum mode where they are cut on purpose): power the shields; shields that are merely down
  get no advice, since powering a generator that is on does not bring them back. On foot or in EVA: the suit light, at the lowest priority
  ("si besoin"). A ground vehicle (recognised about 12 s after sitting down): the lights. Seated with no ship frame yet:
  Flight Ready, "si c'est un vaisseau".
- **How much.** Compact view: at most three, in a wrapping line. Full screen: at most six. The rest, the sentence on keys
  and the "Il fait sombre" button sit behind ONE button (`aria-expanded`), the zone's only tab stop while folded. No live
  region, nothing stored. In the flight order of full screen (next section) it is limited to what has a key (X, H, J, T) or is
  an alert; the rest is behind the same button.
- **Keys.** The rule: a key is printed only when at least two independent public sources give it and none gives another
  one. That leaves X (space brake), H (decoys), J (noise) and T (suit light), always next to the word "défaut", with a
  tip that says to check it in your own settings, and **none has been checked in the game on 4.10**. Every other action
  is shown WITHOUT a key, on purpose: the quantum jump (B is the SCM/NAV toggle in the master modes; the jump is a hold of
  the left mouse button, which is not shown either), cruise and decoupled mode (a 4.10.2 guide swaps them against the
  wiki), Flight Ready (a 4.10.2 guide says right Alt + R, not R), landing gear, auto land, landing request, take-off,
  lights, shields power and exit seat. The table is data, `shortcutsTable()` in `src/dashboard/shortcutsPanel.ts`, one
  row per action with the letters of the sources behind its key (`src`); the sources themselves, their dates, the
  version of the table, the game version, the list of keys somebody saw working in the game (empty) and the reason each
  withheld action has no key are in `src/dashboard/shortcutsSources.ts`, which is not shipped in the page. A test requires
  two distinct sources for every key. On a keyboard with the AZERTY layout the letters X, H, J and T keep their place;
  whether the game follows the layout or the physical position has not been checked.
- **What it never says.** That the lights are off: `ship.lights_on` cannot tell "off" from "not reported", so the lights
  reminder carries no state ("état non lu"). The current flight mode: `advanced_hud_enabled_scm` and
  `advanced_hud_enabled_nav` are display preferences and are not read. That it is dark: nothing in the stream or the log
  says so. The suit light is listed on foot and in EVA, and "Il fait sombre" is a button you press: it puts the lights
  first, and lives only in the memory of the page (nothing is saved, it is gone when the page reloads).
- **Not built yet.** Your own key bindings (`actionmaps.xml`) and the helmet state; see [ROADMAP.md](ROADMAP.md).

### Order of the sections in full screen

Full screen has two orders of its sections, chosen from what the page already knows. Only the placement and one fold change:
no section changes its words, no figure is added, and the balance choice is untouched (the new words carry no amount).

- **Flight order** ("vol"). The verdict and the alerts, the ship banner, the line of the trip under way (the same text as the
  compact view, only for a run that is open or partial and not cut by a ship loss), then the instruments; after them the
  shortcuts (limited as above; with a reminder of an ALERT in them, a countermeasure, a hostile lock or shields cut, the
  zone stands instead between the banner and the line of the trip, at once, and goes back down 3 seconds after the alert
  ends), the commerce card, the session, the health strip, then the rest. The commerce card is
  folded to one line (its stage and its route, nothing else) with a button named "Carte Commerce" (the name never changes:
  `aria-expanded` and `aria-controls` carry the state) while nothing
  fresh happened in it: fresh means what the "Ask Claude" button already counts as a commerce event (a ship loss, a refused
  price, a run that ended in the last half hour). Your own fold wins and lasts until the order changes, so after a landing
  and a take-off the card is folded again by the rule; the rule never folds
  the card while the keyboard focus is inside it.
- **Commerce order** ("commerce"): the order the page always had (banner, shortcuts, session, commerce card, instruments),
  because preparing a route is the job on the ground.
- **What decides.** Flight: the stream is live and the ship section says it is not landed (in the air, in quantum mode or
  in a jump). Commerce: landed, on foot, in EVA or in a ground vehicle. **Unknown, which gets the commerce order and says so on
  the button** ("Ordre : auto · contexte inconnu, ordre commerce"): no live stream, `Game.log` saying menu, disconnected
  or closed, a ship whose `landed` is not reported, a powered-off ship, a seat with no ship, or a ship section that
  contradicts the pilot's locomotion. The landing gear is not read: gear out would be a guess that you are about to land.
  **A grey stream is not a change of situation**: when the frames go stale (about 5 seconds) while an order is on screen,
  that order stays; only menu, disconnected, closed and a contradiction send the page back to the commerce order. **Not
  verified in the game:** when the game omits `is_landed` (in a hangar, at a respawn) the ship section may read "not landed"
  and show the flight order although you are standing on the ground; the button forces the other order.
- **No jumping.** A change is applied only after the situation has held for 3 seconds (a `landed` that flips every second
  moves nothing), at once the first time a known situation is read, and never while the keyboard focus is inside a section
  that would move (it waits for the focus to leave), and, for an automatic change, never while the page is scrolled more
  than 200 px down (it waits for the top; the player's own press of the button always applies). An automatic change is
  said once, "Ordre : vol" or "Ordre : commerce", in the page's existing status region (no region added). The compact view
  never changes order.
- **The button** "Ordre : auto / commerce / vol" in the header (full screen only) cycles auto, commerce, vol and applies at
  once. The choice lives in the memory of the page: no storage, no file, no new `localStorage` key.
- **Keyboard.** The page moves the nodes themselves (no CSS `order`), so the tab order is the drawn order; tests walk it for
  both orders. No new live region.

### Transport ledger

A panel of the full-screen dashboard ("Carnet de transport") that links the game log to the balance change the
telemetry measured, to show what a hauling run actually earned. In the small view it is one line while a contract
runs ("Contrat en cours : title, step 2/3").

- **Needs the game log.** The log is off by default (`SC_INSTALL_DIR` or `SC_GAME_LOG_PATH`). Without it the panel
  says so and points to `sc_log_status`, which explains how to enable it; nothing fails.
- **What it knows.** For the contracts of the current game session: the title, a short mission id, when it was
  accepted and when it ended (completed, abandoned or failed), and for each hauling step a pickup or a drop-off with
  its place and the name of the goods, in the order the game announced them. **Caveat:** those step lines exist in logs written up to spring 2025 and are
  absent from the 12 build 4.10 logs of the reference install (cause not verified), so on current builds expect the
  contracts, their times and the measured gain, but no steps. Duration is the end minus the
  acceptance. Steps are ticked from the number of "Objective Complete" notices of that contract; that assumes the
  notices come in step order, and the log does not say which step they close, so the ticks are an estimate.
- **What it does not know.** The quantity (SCU) and the reward: the game log carries neither, so the panel shows
  neither. A step without a quantity shows none. Contracts accepted in an earlier game session are not in the
  current log. Only the end of a very large log is read, and the panel says so.
- **The only money figure is measured.** The gain of a completed contract is the balance after the contract minus
  the balance at its acceptance, both taken from the telemetry's own history of balance changes (kept in memory,
  500 changes at most, nothing written). The balance is read a few seconds after the end (10 s, an assumption that
  has not been measured with the real game) so that a reward paid just after the notice is counted; until then the
  gain is "pending". It mixes purchases, rewards and fines made in between, so it is marked `mesure_brute` with
  `mixed_flows_possible: true`; it is not a net profit. If the telemetry was not running or had a gap at one of the
  two instants, the gain is unknown (never zero). When two contracts overlap, each figure also holds the other's
  reward and is flagged; the total counts the overlap once. The pace (aUEC per hour) needs at least two minutes of
  contract time. The balance history is in memory: with saved sessions on, the server keeps the reader alive while the game runs (not only while a View polls) and saves the settled result of each trip in the session file; without them, the dashboard has to be open for the history to exist.
- **Planned and measured contract reward.** If Claude passed a route `plan` when it opened the dashboard, the panel puts
  the planned profit (before fees) next to the "récompense mesurée" of the latest completed contract: the balance change
  over that contract, so the reward minus what the contract cost, not a profit. It cannot check that the contract is the
  planned route. For the result of a trading run, see the commerce card.
- **Balance privacy.** Everything derived from the balance (gain, total, pace, planned against measured) is built by
  the server and drawn by the page while the balance is shown (the default). With the balance hidden ("Masquer le solde", `SC_BALANCE=hidden`) the ledger shows steps and durations only, and the server's answer holds no such figure. None of it goes into the automatic summary sent to
  the model or into the fixed messages.
- **Load.** The log file's modification date is looked at at most every 5 seconds, from a poll, and nothing is read
  unless that date changed. The first read takes the end of the log (as the other log tools do); after that only the
  bytes the game added are read and parsed (with a short look-behind so that two lines written together are never
  cut apart). A shorter file, a different beginning (a new game session) or a UTF-16 log starts again with a full
  read. Reads are asynchronous and take no lock; parsing is synchronous work proportional to what was read. A poll
  never waits for it: it carries the last result. The ledger is a section of the lighter poll like the ship sheet
  (hash, left out while unchanged), and the other dashboards of the conversation receive it over the channel
  between Views without any figure derived from the balance.
- **Text from the game.** Contract titles, places and goods are cleaned (invisible and direction-changing characters
  removed), capped at 80 and 60 characters, and displayed as plain text only.

### Commerce card

A card at the top of the full-screen dashboard ("Commerce") that says what a trading run really earned, and one line
in the small view. It replaces the old "Prévu / Réalisé" block, which put a planned PROFIT next to a balance CHANGE:
the balance change also holds the cost of the goods, the sales and the fees, so the two lines did not talk about the
same thing. Each figure now has one meaning:

| Figure | Meaning | How it is obtained |
| --- | --- | --- |
| Bénéfice prévu | The plan's expected profit: planned sales minus planned purchases, before fees | From Claude's plan |
| Chiffre d'affaires | What the sales brought in (the amounts of the sell transactions) | Measured (log amounts) |
| Coût d'achat | What the purchases cost (the amounts of the buy transactions) | Measured (log amounts) |
| Marge brute | Revenue of the SCU paired with a purchase minus their cost, paired first in first out per commodity exactly as `sc_trade_journal` does (`pairCargoRuns`); unsold SCU and SCU sold without a purchase in the run are not valued. The figure to compare with the planned profit | Calculated |
| Écart de prix | Marge brute minus planned profit. Prices and quantities both move it, and the card says so when the bought quantity differs from the plan | Calculated |
| Frais | What the loading service took on top of the prices. The log has no fee line | Measured per side against the balance when possible; else the total deduced (marge brute minus the balance variation) only if it is a plausible fee (0 to 50 % of the turnover), labelled "estimé"; otherwise unknown, with the reason ("le solde a bougé pour une autre raison") |
| Bénéfice net | The variation of the balance over the run: balance after the last sale minus the balance just before the first purchase. It holds EVERY movement of that time (a reward, another purchase), not only the run; the card says how much of it the margin and the fees do not explain | Measured from the telemetry's balance history (tag "variation du solde"); unknown (never zero) when the dashboard did not see the balance before the purchase |

- **Before a run, and the balance warning.** While nothing is measured (no run yet, the balance hidden, or no readable
  journal) the card draws only what exists: the planned profit tile (tagged "plan"), one plain line saying why there is no
  bilan ("Journal du jeu non lisible : pas de bilan réel pour ce trajet", pointing to the health strip), and none of the
  empty "—" tiles. After a run, when the balance moved by more than the margin and the fees explain, the amber warning
  sits UNDER the figures and is one sentence naming what else moved it ("Le solde a aussi bougé de +85 000 aUEC (récompense
  probable), −9 000 aUEC (coût possible) … : ce n'est pas le bénéfice de ce trajet seul."), with a "Détail" button that
  opens the "Mouvements du solde" block, where the full account is. No new data: the same decomposition, read differently.
- **Where the transactions come from.** From the trade journal of the game log (`src/providers/gamelog/trade.ts`, the
  one behind `sc_trade_journal`): the dashboard parses nothing of its own. The ledger's reads (full, then only the
  bytes the game added) also keep the commerce lines, the journal pairs them, and the commerce model takes its
  transactions: only the completed ones count, exactly as the journal does; failed lines and unconfirmed ones (the
  ambiguous ones included) are left out and counted in a note on the card; an amount in another currency than aUEC is
  never added. The journal names goods by an id only (the first 8 characters of the game's GUID); the names that
  `sc_trade_journal` finds in the wiki list are looked up by the server in the background (one request for the public
  list, matched locally on the full GUID, at most every 5 minutes per GUID, never awaited by the poll, only with telemetry on, and
  not at all with `SC_COMMODITY_NAMES=off`): the run then carries `commodity_name`. Until it is known the card says "marchandise inconnue" (the id is never shown) and the
  compact line of a run under way takes the goods from the plan, labelled "d’après ton plan", and a plan cannot be checked against the journal's goods ("supposé"). Without the game log
  there is no journal: the card says so, shows the plan and shows the balance change under its own name ("Variation du
  solde", with the warning that it is not a profit). Tests and the preview feed invented log lines through the same
  parser.
- **How fees are measured.** For each side, the transactions that are close in time are grouped; the balance changes
  seen in a window around them (2 s before to 8 s after the group, an assumption not yet measured with the real game)
  are added up. Buying: fee = (balance fall) minus price. Selling: fee = price minus (balance rise). The fee may be a
  change of its own a moment later, hence the sum. A group is refused, never guessed, if the window holds a
  transaction of the other side, a line the journal could not confirm (it may have moved the balance too, and then the deduced total is withheld as well), a gap in the stream, more than two balance changes per transaction, or gives an
  implausible fee (negative, or more than half of the price). "mesuré" means one transaction was matched; "mesuré
  (groupé)" means several were settled together. If a side cannot be matched, the total is deduced from the margin and
  the net and labelled "estimé"; if the net is unknown too, the fees are unknown.
- **Net profit = balance variation.** The balance just before the first purchase is the one before the first balance
  fall around it; the final balance is read 8 s after the last transaction. It is the whole variation of the balance
  between the two, which can last hours: the card shows `fees.unexplained` (gross margin minus net minus fees) as "unexplained", and warns
  visibly (with the word "Attention") when it is more than 2 % of the turnover, in every fee path (measured, deduced).
  Nothing is built on such a net: no hourly figure and no next-trip figure. A run still in progress (cargo not fully
  sold) has no net. SCU sold that were not bought in the run (stock from before) are told ("Stock antérieur"), not
  valued, and make the fees undeducible.
- **Pace and projection.** Run time is the first purchase to the last transaction (at least two minutes, a finished
  run). The hourly figures rest on a cycle: the time between the start of this run and the previous one when there are
  two, else the run plus 10 minutes of loading, empty trip and waiting (an assumption, not measured, said on the card).
  Net per hour, runs per hour and the next trip net of fees (planned profit minus the observed fee rate times the
  turnover) are estimates. The "per 4 hours of play" figure (a hypothesis) appears only after two measured runs. The
  card lists the assumptions: same trip, same prices and quantity, cargo always available, prices that do not drop when
  you sell more, fees at the same rate.
- **Estimated against measured.** A measured bar is solid and tagged "mesuré"; an estimated one is hatched, has a
  dashed edge and the word "estimé". Colour is never the only signal.
- **Price curve.** The recent prices from the plan, their average, the target price of the plan and, once the balance
  is shown, the average price really obtained per SCU. The dot is the last price. The points are Claude's, taken from
  UEX, and may be old.
- **Balance privacy, stricter than the ledger.** Every amount of a run (turnover, cost, margin, fees, net, pace,
  projection) is built by the server only while the balance is shown and drawn only then. Without
  it the section carries goods, places, SCU, times and counts, nothing in aUEC. It travels on the channel between
  Views without any amount (stripped by the sender and again by the receiver) and never goes into the automatic
  summary or the fixed messages.
- **Several runs.** A purchase after a sale starts a new run (so does two hours of silence); the card shows the latest
  and lists the earlier ones. The plan is applied to the latest run only; if the commodity does not match it says the
  plan is not verified.
- **Action bar.** Right under the headline numbers sits the bar described in the next section (it is also reachable
  before there is any run or plan).
- **Where the money went ("Mouvements du solde").** A folded block in the card's details, and the words of the card's
  "unexplained" warning. A pure explainer (`src/dashboard/balanceMovements.ts`) labels EVERY balance change of the game
  session (and, for a run, the exact window its net was read over) with at most one cause and an honest confidence.
  Inputs, all already there: the telemetry's balance history (one point per change, precision about one frame on this
  server's clock, 500 changes kept in memory: it does not use the aggregated `uec_changed` events), the trade journal's
  transactions (cargo and shop items), the contracts' ends, insurance claim requests, hangar requests and `login_completed`
  (the ledger service keeps these last ones apart from its own events). Categories:

  | Category | Meaning | Confidence |
  | --- | --- | --- |
  | `explained_by_transaction` | a log transaction and the balance change agree (cargo settlements through the commerce model's own reconciliation; other lines by an exact amount) | `matched` |
  | `fee_on_transaction` | what a cargo settlement took on top of the log amount, per cluster: the model's `clusterFee`, not a copy | `measured` (`ambiguous` when the same window also holds a shop item, a contract end or an insurance/hangar event) |
  | `item_purchase` | a completed shop item line whose total equals one balance change; matched BEFORE the cargo reconciliation, which then only sees the changes left (an item bought next to a sale is not absorbed into its fee) | `matched` |
  | `probable_contract_reward` | an otherwise unexplained rise from 3 s before to 20 s after a contract ended `completed`; the amount is the balance's, the log has no reward line; the card says "Récompense probable de contrat" | `probable` |
  | `probable_insurance_or_hangar_cost` | an otherwise unexplained fall from 3 s before to 20 s after an insurance claim request or a hangar request completed. The log has no line for what these cost, so ANY fall in that window (fuel, a purchase) qualifies: the card says "Coût possible (hangar ou assurance)", tag "possible", and never names the cause | `probable` (shown as "possible") |
  | `unexplained` | everything else; reasons `no_cause`, `ambiguous` (two kinds of cause fit: none is chosen) or `stream_gap` (the change spans a cut in the stream: neither its time nor its content is known) | `none` / `ambiguous` |

  A change goes to at most one cause (strong evidence, an amount that matches, comes before time proximity). A change on
  the side of a cargo line whose fee could not be measured, inside that line's window (a reward paid just after a sale
  spoils the reconciliation), could be the sale or the reward: it is `unexplained` and `ambiguous`, with both causes named,
  never counted as a probable reward. Fees deduced from the balance (`estime`: gross margin minus net, when the stream was
  cut or the window unreadable) may hold a reward or a purchase made elsewhere: the card says so, and they feed neither the
  planned net, nor the rate carried to the next run, nor the fee rate of the route reliability. **Fuel,
  repairs, fines, transfers between players and rewards without a nearby event leave no line in the log: they can only be
  "non expliqué"**, and the block says what they could be without picking one. A contract that failed or was abandoned
  just before a fall only adds a hint, never a penalty claim. Invariant, tested: the amounts of all the entries add up,
  to the aUEC, to the balance change of the window; a settlement that holds a price and a fee is ONE balance change split
  in two parts of one cause. Same-sign unexplained changes less than 1 s apart are shown as one line (a chain is cut after 5 s). The session text says "Rien d’autre n’est resté sans piste", not that everything is explained: a proximity in time is a lead, not an explanation. The printed equation uses the matched transaction parts so that it sums exactly (they equal the gross margin within 0.1 % when it closes, and it says so). When the fees are measured in a window that also holds another possible cause, the card's fee tile and waterfall row say "ambigu", like the block.
  **Run decomposition.** For a run whose net was measured, the warning (shown when the net holds more than the margin and
  the fees explain) reads: variation = gross margin + fees + items + probable rewards + probable costs + unexplained, with
  the unexplained part named. The equation is shown as closing only when everything bought was sold in the run, there is no
  prior stock and every log line found its balance change; otherwise only the movements are added up. The legacy
  `fees.unexplained` keeps its sign (positive: the balance fell more than the margin says); the decomposition's parts are
  in the balance's sign. **Tolerances, and what is measured:** 3 s before / 20 s after for rewards and costs (the 3 s is
  measured: on the 95 logs of the reference install the "Contract Complete" notice comes 0 to 3.1 s after `MissionEnded`;
  the 20 s is an assumption, twice the ledger's settle delay), 2 s before / 8 s after for transactions (the commerce
  model's assumption), exact amounts within the larger of 1 aUEC and 0.1 %. Measured on those logs too: none of the 57
  contract ends (any state) found in logs that also hold commerce lines lies within 30 s of a shop or commerce line (so
  rewards and sales do not seem to compete), cargo purchases of a settlement are at least 10 s apart (consistent with the
  20 s cluster), only 12 % of item lines follow another within
  4 s, and insurance claim requests are mostly isolated (155 of 187 bursts are single lines). What could NOT be measured:
  the delay between a log line and the balance change it causes (the log has no balance: it needs a capture of both at
  once), and what insurance or hangar requests really cost. Every amount here is derived from the balance: built only while the balance is shown, drawn only then, stripped by the sender and the receiver on the channel between Views, never
  in `ui/update-model-context` or the fixed messages. The block lists the newest 40 movements (the totals cover all; the filters
  and "Ce trajet seulement" only see those lines, and the block says so when the list is shorter than the totals). Nothing
  of this is stored in the session summary.

#### Trade actions: find the next route

The bar asks the server, with no help from the model, for the routes that fit what the player wants. It is the
`uex_plan_trade` planner behind an app-only tool (`sc_trade_suggest`, `visibility: ["app"]`, listed only with
telemetry on and a client that shows Views). Nothing is asked until a click.

| Button | What it asks | Order of the cards |
| --- | --- | --- |
| **Plus rentable** | `profit_per_hour` | aUEC per estimated hour; the big figure is the hourly profit |
| **Plus rapide** | `speed` | shortest estimated cycle; the big figure is the duration |
| **Plus sûre** | `safety` | fewest risk factors of the planner's heuristic, then profit per hour. It never says "safe" |
| **Gros gain** | `profit` | aUEC per trip, duration set aside |

Under "Affiner" (folded): *Éviter Pyro*, *Zones d'armistice seulement* (UEX's armistice flag; unknown counts as no),
*Relevés de joueurs exigés* (`min_reports` 1: keeps only options with a player report at every end), *Aller-retour
seulement* (hides the open A>B>C chains; it is not `max_legs`: that one needs an origin and returns one-way routes
only), a budget (a number: `250000`, `2,5M`), the hold in SCU (prefilled from the ship sheet, with its source shown),
an origin (a terminal, planet or system name, resolved by the server), and *Proposer la suite à la fin d'un trajet*.
Once a search exists, changing an option searches again by itself after a short quiet time; before the first click
nothing is asked.

- **Measured, estimated, heuristic.** Prices are UEX's, crowdsourced; today almost every option is tagged
  *estimation UEX · aucun relevé de joueur* (UEX counts no player report for a price), and the bar says so and offers
  the player-report option. Durations are ESTIMATES (quantum flight plus a fixed 8 minutes per stop); without a quantum
  speed (no ship sheet) hourly figures and the "fastest" order are unavailable and the cards say "durée inconnue".
  Fuel is not subtracted. The prudence badge is the planner's heuristic over UEX place data (armistice flag,
  jurisdiction, system, kind of place, number of flights), always labelled "(heuristique)"; UEX has no piracy data.
  Prices older than 7 days are flagged "périmés". The ship's quantum speed comes from the server's own state (the flown
  ship's wiki sheet, then the same lookup as `uex_plan_trade`), never from the page.
- **Cards.** The first is the headline (big number, ring); the others are quiet rows; chains (A>B>C, no priced return)
  are apart and not comparable. Each card has *Appliquer comme plan* (the server builds the plan from its own option, by
  id: the outbound leg, the return named in the note; the commerce card then follows that route: planned profit,
  expected prices, estimated time) and *Demander à l'agent* (a fixed text built from the card, posted as a message: the
  route, prices, estimate status, chosen constraints, and a request to verify with `uex_get_trade_routes` and
  `uex_plan_trade`).
- **Et ensuite ?** When a run completes (less than 30 minutes ago), one suggestion is computed from where it ended: the
  selling terminal of the plan in force (the journal's shop names are game identifiers that UEX does not know, so
  without a plan nothing is asked: apply a route as the plan to get the follow-up; a terminal UEX does not know fails
  quietly), once per run (the server remembers the run, so a dashboard mounted again does not search again without a
  click), never applied by itself. It can be switched off.
- **Rate limit.** UEX is a shared service. The server answers an identical question from a 2-minute memory, shares one
  planner run between identical simultaneous calls, and otherwise starts at most ONE new planner run every 8 seconds for
  all Views: a request inside the interval gets "attends N s" (a state, not an error; an automatic re-search retries
  by itself at most twice), and none starts while another is still running. The planner has its own 20 s deadline,
  shorter than the page's 32 s wait. Only the leading
  View calls the server (a following View takes the lead when its button is pressed). There is no polling of the planner.
- **The balance.** *Budget = mon solde* exists only while the balance is shown and only if you tick it. The page then
  sends the number as the budget, with a private flag, in the tool call: it passes through the host to the local server,
  which uses it only to size the quantities (it is never sent to UEX, and this dashboard does not write it in the
  conversation). The answer never contains the balance or the budget; with the flag it carries no cost, no leg says it
  is limited by the budget, and a route applied as the plan is marked private. The quantities sized by the budget stay
  on your screen: the message to the agent then holds no quantity, total or hourly figure (it says the budget is your
  balance, not communicated), nothing goes on the channel between Views or into the automatic summary, the results and
  a private plan are dropped when you hide the balance, and a private plan reaches the saved session only while the
  balance is shown. The option ids are random (128 bits) and valid as long as the answer is kept (2 minutes).
- **The hold.** The page sends a hold only when you typed one; otherwise the server uses the flown ship's and the answer
  says where it comes from.
- **Not verified.** The host's own time limit for a tool call (the page waits 32 s), the behaviour of the buttons in
  Claude Desktop, and the quality of the heuristic against real piracy.

#### Before leaving: the pre-flight check, and the price that moved

A plan is a guess made earlier from crowdsourced prices. Two things tell the player whether it still holds.

**The pre-flight check.** On a plan (a route applied from the bar, or one Claude passed), the block "Avant de partir" has a
button *Vérifier avant de partir*. It calls the same app-only tool, action `preflight`, with no argument: the server checks
the plan IT holds (the View cannot name a plan), and the answer repeats the plan's names and unit prices so that the page
shows a verdict only for the plan on its card. The server re-reads the CURRENT UEX rows of the plan's goods at its two
terminals with ONE price `GET /commodities_prices?commodity_name=...` (the request `uex_get_commodity_prices` makes, so the
cache is shared) and the `GET /game_versions` that says which game version is LIVE (cached too): two GET calls per click at
most, plus the client's usual retries on a 429 or a 5xx; a hard guard refuses a fourth GET; no new host, never a POST. Rows
are filtered locally to the exact goods name, then to the terminal: by UEX id when the plan was built by this server's
planner (the id is kept server-side with the plan, never sent by the page, never taken from a plan Claude passed), else by
the exact name (case, spaces and the typographic apostrophe aside; a name cut at 60 characters matches by its start; a name
two terminals share is "ambigu", never guessed). When a terminal has rows of two game versions, the row of LIVE's version
is judged (a newer-dated row of another version is not); only rows of another version means "autre version du jeu".

| Verdict | When |
| --- | --- |
| **✓ Toujours valable** | The only green: BOTH legs found, fresh (not stale) AND each backed by at least one player report, margin down by less than 15 % |
| **≈ Inchangé · estimation UEX** | Nothing moved, but at least one price is UEX's own estimate (0 player reports, or the count is not given). Neutral, never green: "Les prix estimés par UEX n'ont pas bougé. Aucun joueur ne confirme ces prix : vérifie au terminal avant d'acheter". The plan was made from the same estimate, so "unchanged" proves little (on real data almost every price side has 0 reports, and a fresh `date_modified` does not prove a player report) |
| **⚠ À surveiller** | Margin down by 15 % to 30 %; or a row last reported more than 7 days ago, undated, or dated more than a day in the future; or a low or saturating stock; or a favourable move of 30 % or more (a wrong report is as likely as a good surprise; the card says "Hausse inhabituelle : prix plus favorable que prévu, vérifie qu'il n'a pas changé de produit ou de lot") |
| **✕ Dérivé** | Margin down by 30 % or more, or no longer positive; or nothing to buy (out of stock), no demand, or no price any more at a terminal |
| **? Impossible de vérifier** | UEX unreachable, a stale copy of the cache (never used as a verdict), goods or plan terminals not found or only found in another game version, a plan without both terminals and both unit prices. Never green |

The thresholds are CHOICES, not measures (`PREFLIGHT_WATCH_MARGIN_LOSS` 0.15, `PREFLIGHT_DRIFTED_MARGIN_LOSS` 0.30,
`PREFLIGHT_STALE_MS` 7 days in `src/providers/uex/preflight.ts`); they are sent with every answer and shown on the card.
The margin is the planned per-SCU margin (sell price minus buy price); each leg's effect is its adverse price move (a buy
price that rose, a sell price that fell) over that margin. The overall verdict is the worst of the legs and the margin
(drifted, then unknown, then watch, then unchanged-estimate, then valid). Each leg shows the plan's price against the current one and the
percentage, the age of UEX's row, the number of player reports (`estimation UEX · aucun relevé de joueur` when UEX counts
0; a missing count is "inconnu", never 0), the stock or demand status of the same row, and the next action: *Tu peux
partir*, *Vérifie au terminal avant d'acheter* (*Prix périmé : ...* for a stale row), *Relance la recherche*, *Réessaie
dans un instant*. The answer holds unit prices, per-SCU margins and percentages only: no quantity, no total, no profit, so
a plan sized from the balance and a typed plan give the same shape and nothing depends on whether the balance is shown.
The sentences are written by the server (`src/dashboard/preflightText.ts`, from codes and numbers, no sentence holds a
name) because the page has a size budget; the page cleans and caps them again, sets them with `textContent`, refuses a
green verdict that no leg backs, and ignores an answer made for another plan. *Demander à l'agent* posts a fixed text
(names reduced to letters, digits and a few signs and quoted as UEX data, unit prices, the verdict, "Ne lis pas mon
solde"). Same throttle as the search (see Rate limit): an identical check is answered from the 2-minute memory, identical
simultaneous checks share one read, a new UEX read starts at most every 8 seconds for all Views and never while a search
runs (and the other way round); a failure counts toward the interval and is not kept.

What it cannot see: a price nobody re-reported since the plan looks "unchanged" however far the kiosk's real price has
moved, and the cache keeps UEX's rows up to 5 minutes. That is why the age, the number of reports and the stock status are
part of the verdict, why the card says "le prix affiché au terminal prévaut", and why, after a refusal at the kiosk (next
paragraph), a check made BEFORE the refusal is overruled by a line telling the player to check the price on the spot.

**The price moved at the kiosk.** The game refuses a purchase or a sale whose displayed price is no longer the kiosk's
(`TransactionCostMismatch`). The trade journal (`providers/gamelog/trade.ts`) already lists such a transaction as failed
with that reason; nothing is parsed a second time (`providers/gamelog/priceRefusals.ts` only reads the journal). An error
line that follows several same-side requests cannot be attributed to one of them: it is counted ONCE, as an ambiguous
event ("une des transactions envoyées à ce moment a été refusée"). Each event is a time, a side (buy or sell), a kind
(cargo or shop item) and how sure the journal is: no amount, no shop, no item, no identifier, so it is sent with or without
the balance (`trade.price_refusals`, the newest 3, also on the channel between Views, rebuilt field by field on reception).
The dashboard shows, for 10 minutes, "Achat refusé : le prix a changé au kiosque. Relis le prix avant de racheter." (or
"Vente refusée", or an item of a shop), on the commerce card with the age first and the clock time after it, as one line
right under the header in the small view, and IN THE VERDICT of the header ("Prix changé : achat refusé · il y a 40 s",
amber, the clock time as its tooltip) instead of a green "Tout va bien" (a red condition still comes first). Only the stable
sentence sits in the live regions, the age does not; it is muted as soon as a later
transaction of the same side and kind went through (`superseded`); for a
cargo trade it suggests checking the plan again (the button is highlighted; nothing is asked by itself). The session
counts them: `price_refusals` (additive, optional, the file stays version 2 and older files read as 0; a watermark makes
the count idempotent) in the session summary, `sc_session_current`, `sc_session_list` and `sc_session_stats` (a total and
per session, a count, so never hidden with the amounts).

Measured on the reference install's 95 logs (March 2025 to November 2026, read-only, counts and timings only): 81 cargo
requests (39 purchases, 42 sales) and 183 shop requests; `TransactionCostMismatch` appeared twice (one cargo purchase,
one shop purchase), 162 and 247 ms after the request, on two different days, both attributed to their request by the
journal (failed, confirmed). Too few cases to give a rate. Not verified: the behaviour in a live session, and what the game
does with the price shown after a refusal.

**The ship that was destroyed.** The same alert slot shows a ship destroyed with the player aboard, for 15 minutes unless a newer refused price takes the slot (the ownership of the ship is not verified; with
the cause named only when the log states it) ("Vaisseau détruit à 12:12:00, joueur à bord (…) : collision." then "Cargo présumé perdu : 640 SCU, 947 857 aUEC payés (prix
d'achat, pas la valeur) (non confirmé)."; the saved session keeps it for good). It is the gravest event of the page: its chip in the header and its box
use the top tone of a scale (amber: worth a look, a hit or a refused price; red tint: danger now, shields down or a hostile lock; solid red: the ship is gone), the chips of
events older than a minute are made small and quiet while it stands, the box holds two lines (what happened; the cargo presumed lost, the aUEC paid only
with the amounts shown), the doubts are folded under "Pourquoi ce n'est pas certain ?" (a native details element, reachable with the keyboard: the ownership of
the ship not verified, the value lost, what became of an insurance claim, the replacement cost and the one responsible not logged, the attribution checked on 2025 logs only, the kind of causer
deduced from the shape of a name, the purchases and sales the journal could not confirm), and "Et maintenant" says facts only: the run the loss interrupted will not be finished (said only when
that run is still the newest of the journal), and a new session or a new run can begin (folded in the compact view). The fatal tone leads the header verdict for 3 minutes only, and
never over a red condition that began after the loss; after that the verdict goes back to the normal order of gravity (the loss is then an amber entry) while the box keeps
the loss for 15 minutes. The reduced chips keep their age and their "non vérifié" flag. **No insurance claim is shown, not even "none seen":** the log parser reads the line
of a claim request (`insurance_claim_requested`), but the dashboard receives it only inside the balance movement explainer (built, and kept, only with the
balance shown, and never as a standalone fact), so "no claim seen" would be false whenever the amounts are hidden. Showing it would take a new field in the
commerce section; it is not done. It is read from build 4.10's
`[ActorState] Dead ... destroyed vehicle` line (the actor must be the player, compared with a hash of his id from the login
line) and, as a legacy path no 4.10 log exercises, from the 2025 `Actor Death` and `Vehicle Destruction` lines
(`providers/gamelog/shipLossParse.ts`, `shipLoss.ts`). A collision is named as the cause only when a
`FatalCollision ... PlayerPilot: 1` of the same ship comes at most 1 s before; else the cause is "not logged". The cargo is
a presumption: the successful purchases bound to the ship by the cargo kiosk (`VehicleCargoDataRequest`) and not sold,
at the price PAID (failed purchases ignored, unconfirmed ones counted apart); the value lost, the insurance and the killer
are not in the log and are shown as "non journalisés"; and the purchase-to-ship-to-destruction chain is verified on 2025
logs only (no 4.10 session has a purchase followed by a loss). The records hold a time, a ship model, a cause
code, a kind of causer, a place token: no name, handle, GUID or raw identifier. The model is kept only when it starts with
a known maker's code (AEGS, DRAK, MISC, RSI ...), and the place only when it begins with a known family of the game's own
place names (an "OOC_" body, a jump point, a star system or a body ...): these are filters on the SHAPE of the text, not a
list of places, so anything else ("Hangar_" followed by a name, a custom entity) is shown as "modèle inconnu" or "lieu inconnu" (after the family, at most 6 short segments, none starting with hangar, apartment, home, habitat or room). A short hash of the ship's identifier
links a purchase to its ship, in memory only: it is never written, sent to a View or exported. The SCU go with or without
the balance (`trade.ship_losses`: the server sends the newest 5, the View keeps the newest 3; also on the channel between Views); the aUEC paid is a balance figure and
is withheld when the amounts are hidden. The session keeps `ship_losses` (additive, optional, the file stays version 2): only the time, the
model, the cause, the kind of causer, the place and the cargo presumed lost; the debrief lists them.

## Saved sessions

The dashboard works **by session**, and a session is saved. A session is a play period: when it began, the balance at
its start and at its last sighting, the trips made and what they earned, the time the game was seen running. You find
it again from any conversation, after a game crash, and after a reboot of the PC.

- **Why a file on the server and not the browser's `localStorage`.** `localStorage` belongs to one page origin: each
  conversation has its own, so two chats would not see the same session; it can be cleared by the host at any time; and
  the model's tools cannot read it. A small JSON file written by this server is shared by every conversation and every
  server process, survives the host, and is read by the tools and the dashboard alike. The page keeps no session data in the
  browser's storage: its only flag is `sc-copilot-help-seen` (the legend was read).
- **Where.** `sessions.json` in the per-user data folder (Windows: `%LOCALAPPDATA%\sc-copilot-mcp\data`).
  `SCMCP_SESSIONS_FILE` moves it; `SCMCP_DATA_DIR` moves the folder.
- **When it exists.** Only with `SC_TELEMETRY=on`. With telemetry off nothing is created, read or watched.
  `SC_SESSIONS=off` (or `0`, `false`, `no`) turns the sessions off while telemetry stays on: no file is created or read,
  and the session tools and the bar disappear.
- **To wipe it.** Stop Claude Desktop (or set `SC_SESSIONS=off`), then delete `sessions.json`. Files next to it
  (`sessions.json.v1.bak`, `sessions.json.corrupt-...`, `.bak-...`) are copies of older or unreadable files and hold the
  same balances: delete all of them to wipe the data, or run `npm run sessions -- wipe` (a dry run that lists them by
  name; `--apply` deletes them, in that folder only, and honours `SCMCP_SESSIONS_FILE`).
  The file is plain JSON: you can read it.
- **A deliberate change of behaviour.** The starting balance cannot be recovered from Game.log, so to capture it the
  server must be watching when the game starts. With sessions on, a small manager keeps the telemetry reader alive
  **while the game is believed to be running** (Game.log was written in the last five minutes and does not show the
  quit line), instead of stopping it five minutes after the last request. When the game is gone it stops touching the
  reader, which then idles out as before. Without the game log (`SC_INSTALL_DIR` or `SC_GAME_LOG_PATH`) the server does
  **not** probe the port on a timer: it only records what a dashboard or a tool asks for, and the start balance is then
  "the first one seen". Everything stays local and opt-in.

### Life of a session

- **It starts** when the game is seen running and there is no session, or the last one has been quiet for more than
  3 hours (`SC_SESSION_GAP_HOURS`, 0.25 to 48); when you press **Nouvelle session** (or call `sc_session_new`); and when
  the dashboard is opened after such a break (an empty session waits for the game, and an empty one is renewed, never
  piled up). A session in which the game has never been seen (no trip, no balance, no played time) is **empty**: the card
  says "en attente du jeu", it has nothing to end, and "Nouvelle session" would only recreate it, so neither is offered
  (`sc_session_end` answers `reason: "empty"` and `sc_session_new` answers `started: false`, both without changing anything).
- **It resumes** when the game is seen again within the gap, whether the game was closed cleanly or not. The break is
  written down: `game_closed` if the game wrote its quit line, `unclean` if there was no end marker (crash, reboot of the
  PC, or this server was not running). Nothing is invented about what happened meanwhile.
- **It ends** when you end it (**Terminer**, or `sc_session_end`: it is then not resumed, and the next session starts
  when the game is seen starting afresh), when a new one starts, or when the gap is exceeded (closed at its last
  sighting). A session you ended **stays on the card**, however long you wait and however often the dashboard polls,
  until you press **Nouvelle session** or the game shows a new play period (a join or the menu in Game.log dated after
  the end; when Game.log says nothing, a balance appearing after a silence). A restarted server that only sees its first
  balance late does not count as a new play period. Closing the game is not an end: the session waits and resumes when the
  game is back within the gap (the card says "jeu fermé" in the meantime). The file format is unchanged (no new value for
  `end_reason`, so an older server still reads it).
- Time is counted from what was seen: **active time** is the time the game was seen running; a gap adds nothing.

### What is stored, what a crash loses

Stored, per session: id and number, start and end time, the balance at the start (with how reliable it is:
`game_start` when the server saw the stream begin, `first_seen` when it started watching later, `new_session`,
`late`) and at the last sighting, the game version and channel, active time, the breaks, the note you wrote, and the
trips (end time, a label and goods and places cleaned and capped, SCU, cost, revenue, gross margin or measured result,
planned profit). **Never stored:** frames, raw log lines, your handle, your account id, IP addresses, GUIDs of players or
game sessions, mission identifiers (a trip's key is a hash). This server never sends session data over a network, and session tracking makes no request to any host (what you let Claude read through the `sc_session_*` tools is part of your conversation).

Every change is written at once (a trip, a start balance, a new session, a break); the only thing throttled is the
"last seen" clock, written at most every 15 seconds. A crash or a power cut therefore loses **at most the last 15
seconds of clock**, never a trip that was written. Writes go to a temporary file, are flushed, then renamed over the
file under a lock file, so the file is always the old version or the new one. Two server processes (Claude Desktop can
start two) read the freshest file under the lock and add to it: no trip is lost and time is not counted twice. A file
that is empty, not JSON, too big or of another shape is **set aside** (renamed `sessions.json.corrupt-<time>`; only the three newest such copies are kept, older ones are deleted)
and the server starts clean; a file from a **newer version** is never written (sessions then live in memory only
and the answer says so). The size is bounded IN BYTES: the file is kept under about 3 MB (the reader accepts up to 16 MB, so a file the server
wrote is always read back); when a write would pass it the **oldest sessions are dropped** and counted
(`history_trimmed` in `sc_session_stats`), the newest is never dropped; there are also at most 200 sessions and 500 trips
per session. The file is created for the owner only (mode 0600; on Windows the ACL of your user profile folder applies,
which is what protects it). If the disk refuses a write (for example when it is full), the content stays in memory and is
used in place of the older file until a write succeeds; `sc_session_new` and `sc_session_end` then say so (`persistence`).
The lock is touched while held, removed only by its owner, and a lock left by a crash is taken over after 5 seconds
(a change waits up to 8 s); orphan temporary files older than a minute are swept. Before "Nouvelle session", "Terminer"
and a clean shutdown the server re-reads the game log at once so that the last trip is kept (a trip whose result is still
settling is kept with an unknown result). A dead lock is taken over by one process at a time (through a takeover file,
with no check on a path before acting on it): several real processes starting together on a dead lock lose nothing. A run
of the commerce card that grows after it was saved (a late sale) replaces its trip, it is never stored twice.

### Trips, results and statistics

A trip is a **completed contract** of the transport ledger (its result is the balance change measured around it, and
stays unknown when two contracts overlapped or the balance was not seen) or a **completed trade run** of the commerce card
(its model, `src/dashboard/tradeRun.ts`, is the one pairing of the journal's purchases and sales; the trip keeps its
cost, turnover, **gross margin**, fees and **net**, each as that model measured or computed it, and the plan's profit
when the plan was tied to the run, by the goods' name or by prices: see Route reliability). A contract's balance change that overlaps a trade run is left out of the
totals (it already holds the run's sales), and the session shows the measured net and the gross margin separately. A trip is stored only once its result is
settled and is never recomputed later.

The figures per session: trips, active time, trips per hour, minutes per trip (an estimate), result (on ONE basis: the sum of each
trip's result, which is its net when the commerce model measured or computed one and else the gross margin of its cargo run,
else the change of the balance, and it says which; the measured net and the gross margin are shown apart, and a contract's
balance change that overlapped a cargo run is left out so that the run's sales are counted once), result per hour (from 10 minutes of active
time), best trip, and efficiency against the plan when Claude passed one with the dashboard. Across sessions: totals,
average per hour, trend (the last sessions against the ones before, 10 percent threshold), best and worst session, best
routes and goods when known. A figure that cannot be worked out is `null`, never zero. All of them are raw measures: the
balance also moves with purchases, fines and repairs. Each session also counts the transactions the game refused because the price moved (`price_refusals`, a count: it is not an aUEC figure, so it is given even when the amounts are hidden; see [the pre-flight check](#before-leaving-the-pre-flight-check-and-the-price-that-moved)).

### Route reliability (calibration)

UEX prices are crowdsourced estimates, and for most routes nobody has reported them recently, so the planner's profit is
a guess. Your own saved runs are evidence. For each completed trade run that carries a planned profit, the server
compares what the plan promised with what you really got (`src/providers/sessions/calibration.ts`, a pure module).

- **What is compared.** The realised gross margin over the planned profit (a margin before fees, so like for like); the
  net over the planned profit, only for a run whose net is its own (the net and the fees are known, the commerce model did
  not flag the net as doubtful, and what the margin and the fees leave unexplained of the balance change is at most 2 % of
  the turnover: a purchase made elsewhere or a reward is left out and counted in `net_excluded`, and an older trip without
  that information is left out too); and the fees over the turnover. The plan is first scaled to the quantity really moved
  when the plan's quantity is known and differs by more than 2 % (a half-loaded hold is not a bad price); a run that moved
  less than a quarter or more than four times the planned quantity is left out. A plan under 1 000 aUEC, or under the run's
  own fees, is ignored (a ratio over a few aUEC is noise), and a ratio that is not above zero or is above 500 % is shown as "écart très élevé", never
  as a percentage. The typical ratio is pooled (sum realised over sum planned), with the median, the minimum and the maximum of
  the per-run ratios beside it. It is not the efficiency figure of the sessions (`money.plan.efficiency`): that one is the
  measured result (net, else gross margin) over the plan as planned, while the calibration compares the gross margin with
  the plan rescaled to the quantity moved, so the two can differ on purpose.
- **Groups and which runs count.** Per goods (exact name once accents are folded and lower-cased, never a prefix, never the
  figure of another goods) and, when the run holds the plan's two terminals, per route. A goods group pools all its routes;
  the route group is preferred when it has 2 runs or more. Only runs of the last 60 days count, from the current patch line
  (the first two numbers of the game version, for example 4.10: a run of another patch line is left out, a run of unknown
  version is kept and counted, and with no current version known nothing is left out for its patch), and only the last 8
  runs of a group. What was left out, and why, is counted in the answer of the tool. The card line is about the first leg of
  a route only, and says so on a card with two legs.
- **How a plan is tied to a run.** One applied plan marks one run: the first trade run that ends after it, or, when several
  qualify in the same look, the closest to the plan. The journal names goods by an id, not by a name, so in practice every
  plan is tied to its run by prices (`plan_link`): the run's average buy and sell prices each within 15 % of the plan's, a
  bought quantity within a factor of 2.5 of the plan's (both must be known), and a realised unit margin that is positive and
  between half and twice the plan's. A run that fails any test is not tied, and the plan stays free for the right run. These
  thresholds are choices, not measurements. That is a resemblance, not a proof: the group says `goods_unverified`, the line
  says "similaires (marchandise non vérifiée)" instead of "de cette marchandise", the "lien par prix" explanation is in
  the fold "Comment lire ça", and the confidence is never `high`, with the reason in the tag's title. The session figures count such
  trips too (`price_linked_trips` in `money.plan`, in the best goods and routes), and their label ends with "(lien par prix)".
  To have two runs of a route, apply its plan twice. **Selection bias:** because a run must have a unit margin between half and
  twice the plan's to be tied, a run that yields 30 % of the plan is never tied and never counted: the ratios of runs tied
  by prices (every real plan today) are censored to about 50 % to 200 % (a link by name would have no such bound), so the calibration cannot show that a route really yields 20 % of the plan (such runs are
  simply absent). When the confidence is held at `medium` for that reason the card says so in the fold "Comment lire ça" under the line (written text, one click away), not in the tooltip alone.
- **Confidence** (`none`, `low`, `medium`, `high`). `none` below 2 runs: no figure at all, only the count. `low` with 2
  or 3 runs, a spread above 0.6 (maximum minus minimum of the per-run ratios, in points of the plan) or a newest run older
  than 21 days. `medium` with 4 to 7 runs. `high` only with 8 runs, a spread of at most 0.3, fresh runs and goods tied by
  name. It says how much to lean on the figure; it is not a probability.
- **The expectation.** "Net expected is about the planned profit times the typical ratio (n runs)": the planned profit times
  the typical net ratio when at least 2 runs have their own net, otherwise times the typical gross ratio less the usual fee
  rate on the plan's turnover. An ESTIMATE, always with its number of runs and its confidence; it claims no cause (a ratio
  below 100 % can come from prices, quantity or a slow sale).
- **Where it shows.** `sc_session_stats` (section `route_reliability`, not with `include_balance` false); a quiet line under each
  suggested route of the action bar: three values side by side, only when data exist and the balance is shown. ESTIMÉ (tag
  "ESTIMATION"): the planner's profit per trip and per hour from UEX prices. MESURÉ: the mean of the player's own runs of that
  route or goods (the mean realised gross margin, or the mean net when the ratio in use is the net one) with their number
  and the mean they were planned at. RÉALISÉ ÷ PRÉVU: the same ratio as the tile below (the net ratio, else the gross ratio
  less the usual fees), with a small bar on a 0 to 200 % scale, the tag "estimé · N trajets · confiance ..." (its tooltip
  explains the confidence) and what it gives: "Si tu refais ce trajet ≈ X aUEC (prévu Y × Z %)". **Rules.** Under 3 runs
  behind the figure in use the card gives their number and nothing else (no ratio, no applied figure, no tag; the tile "Si tu refais ce trajet" follows the same rule: no coefficient under 3 runs; the tools
  keep their 2-run minimum). The ratio is applied to the profit of the FIRST leg only, which is what "apply as
  plan" stores and so what the runs were compared with: a card with two legs says "Si tu refais le 1er tronçon" and gives no
  figure for the round trip; an hourly figure is applied only to a card of one leg, as the applied trip over the estimated
  cycle. On the gross basis the sentence writes the real decomposition ("prévu × ratio, moins les frais habituels ≈ F"). The
  "mesuré" cell counts the runs its mean is over (all runs on the gross basis, the net's runs on the net basis); on a card of
  two legs it and the ratio say "1er tronçon" beside the total they sit next to. A ratio that is not above zero or is above
  500 % is worded "écart très élevé", not printed, and nothing is applied to it; when nothing is applied, the sentence gives the
  one true reason (too few runs with known fees, a net too far from the plan, no planned turnover). The mean over the
  planned mean is the ratio; it is NOT the measured mean divided by today's estimate (the fold says so). The fold "Comment
  lire ça" also says that runs tied by prices are censored to about 50 % to 200 %, and that a link by name has no such bound (see the selection bias above). The block exists only while
  the balance is shown and is emptied, not just hidden, when it is hidden again. The tile "Si tu refais ce trajet" of the commerce card, which prefers the calibrated
  figure when the plan in force has a group of 3 runs or more; one sentence in the server instructions and in the prompt
  `trade_copilot` so that Claude quotes it with its number of runs.
- **Privacy.** A ratio times the plan reveals the realised result, so the section exists only where the balance is shown:
  absent from the tool with `include_balance` false (or under `SC_BALANCE=hidden`), from the dashboard poll (and so from its hash) of a View that hid the balance, from the channel between Views, from `ui/update-model-context` and from the message of "Demander à l'agent".
  The View ignores it while the balance is hidden, even if a server sent it.
- **Stored (file version 2).** For a trade trip: the plan's quantity, the plan's two terminals (UEX names: the plan's, not
  observed places), `plan_link`, how the fees were obtained (`fees_method`), and what the balance holds beyond the run
  (`unexplained_auec`, `net_doubtful`: all of them come from the balance and are withheld like the money, and a trip whose
  net is `net_doubtful` is not compared with its plan in the session's efficiency). A restarted server never replaces a stored
  trade trip by a version that has lost a figure the stored one measured; when the run also grew (a later sale), the
  measured net and fees are kept, `figures_from_before` is true and the net is `net_doubtful` (it no longer covers the
  whole run). Never frames, raw lines, handle or identifiers.
  A version 1 file is read as is (the new fields are unknown, so those trips count by goods, without scaling, and with no
  net); the format number moved so that an older build leaves a version 2 file alone: it opens it read-only, in memory,
  with a notice, and the data is not lost. Before the first write in the new format the server copies the version 1 file once
  to `sessions.json.v1.bak` and never overwrites or deletes that copy.
- **Not verified.** Nothing was observed with the real game. The thresholds (60 days, 8 runs, 21 days, 15 %, 2.5, the margin
  band, 1 000 aUEC, the confidence bounds) are our choice, not measured.

### In the dashboard and in the tools

- **The bar** at the top of the dashboard shows the session (number, state, since when, active time), then the figures
  that matter first: with the balance shown, the result, the rate per hour, the trips and the time; with the balance
  hidden, the trips and the time. In the compact view the bar is one line (a button that unfolds it) that also says the state
  ("en attente du jeu", "terminée à 16:10"). The card has five states: **no session** ("Démarrer une session"), **en attente
  du jeu** (an empty session: no figure, no dash, no button, and a line says why), **en cours** (or "inactive" after a long
  quiet), **terminée** ("terminée à 16:10", how it ended, its result, and "Nouvelle session" as the main button) and, in the
  **Sessions** menu, the list of past sessions with the state of each (in progress, waiting for the game, ended: by hand,
  replaced by a new session, or by a long inactivity) and one session in detail. **Terminer la session** and **Nouvelle
  session** sit on the card, and only where they change something. A session that holds something asks first, **inline
  next to the button**, with a cancel and no timer (a question that is no longer true, because another dashboard or the
  game changed the session, is withdrawn and says so); an action that closes nothing is done at once. The result is
  written in a line under the card (a live region, so a screen reader announces it) and stays there until a newer
  session is on the card; it never holds an amount. Two dashboards of two conversations show the same session, because it
  comes from the server.
- **When it opens**, the dashboard attaches to the last session unless it is open and there was a break of more than the
  gap, in which case a new (empty) one is made. A session you ended is never replaced behind your back.
- **Tools** (`local` profile; the first three also in `trade`): `sc_session_current` (the session so far, the last place
  and goods the log named, the latest trips: what Claude needs to accompany you and propose the next run),
  `sc_session_list`, `sc_session_stats`, `sc_session_new`, `sc_session_end`, `sc_session_debrief` (the report, see below) and `sc_session_export` (the dashboard's own call for the whole report; not for the model).
  `sc_session_new` and `sc_session_end` write only the server's own file. The prompt `trade_copilot` chains the others with the UEX route tools.
- **The session report (bilan).** To TAKE a session out of the server (share it with a crew or an org, keep a log, paste the
  trips into a spreadsheet): in the session menu, open a session and press **Copier le bilan** (the text goes to the
  clipboard; if the host refuses the clipboard it is shown selected, press Ctrl+C) or, when the page can make a file,
  **Télécharger .md**, **Télécharger .csv** or **Télécharger .csv (Excel FR)** (the host may block a download: copying always works).
  The dashboard gets the WHOLE session through its own tool `sc_session_export` (app-only, not listed to the model).
  Claude can produce a report with `sc_session_debrief`, which is small on purpose because a tool result is part of the
  conversation: Markdown by default (about 28 000 characters at most, 20 table rows per session, older trips cut with a count and a
  pointer to the dashboard), a CSV only when asked (`format` csv, 100 rows at most), never both; `id` for a past session or `last`
  for the newest N, up to 10. `last` skips sessions that hold nothing, as the statistics do, and a session that holds only a start
  balance counts as non-empty: with the balance hidden, which sessions `last` picks can therefore depend on balance data (only the
  choice of sessions; no amount is shown).
  The Markdown (in French, times in UTC, no clock or locale: the same session gives the same text) has: the header (start,
  end, duration, active time, game version and channel, the breaks and why: game closed normally or no end marker), the key
  numbers (trips, per hour, gross margin, fees, best trip, efficiency against the plan, route reliability with its number of
  runs, its confidence and the "marchandise non vérifiée (lien par prix)" caveat), the trips table (time, label and route,
  SCU, cost, revenue, gross margin, fees, net, each tagged *mesuré*, *calculé*, *estimé* or *inconnu*), what is unexplained, and a
  plain footer saying what is measured and what is estimated, and that UEX prices are crowdsourced. The CSV has the trips only,
  with English column names (`session,ended_at,kind,label,commodity,buy_terminal,sell_terminal,scu`, then, with amounts,
  `cost_auec,revenue_auec,gross_margin_auec,fees_auec,fees_method,net_auec,net_method,counted,planned_profit_auec,plan_link`),
  CRLF line ends and an empty cell for what is unknown (never 0). `counted` is `yes` only for a trip that has a result (the Markdown
  says *inconnu* for the others). **Separator.** Comma by default; **Excel in French expects a semicolon**, so use
  **Télécharger .csv (Excel FR)** (or `csv_delimiter` ";"): the file opens in columns, with a decimal comma. **Formulas.** A
  text cell that starts with `=`, `+`, `-` or `@` is prefixed with an apostrophe, and so is every `;`, `,`, tab or `|` inside it
  that is followed by one (an apostrophe is put right after the separator, so a reader that splits the cell there finds no formula),
  and a cell that holds a comma, a semicolon, a quote or a line break is quoted. That stops the usual formula injection in Excel
  and LibreOffice; it is a mitigation, not a promise about every program that can open a CSV: read a file from someone else
  before opening it, as you would any spreadsheet.
  **Privacy.** Every aUEC figure comes from the balance, so the report holds amounts only when the balance is shown (the
  dashboard's choice) unless `include_balance` is false (or the server starts hidden and the call does not say true). Otherwise it is the non-monetary report (counts, durations, SCU, labels) and
  says amounts are withheld; the best trip, the plan efficiency, the route reliability and the trips' methods are withheld with
  them. The balance at the start and at the last sighting never appear, even with amounts, unless you also switch on
  **Soldes de départ et final** (`include_start_balance`; per use, never remembered, ignored when the amounts are hidden); what can
  show, once amounts are on, is their difference (the balance change over the session, in the unexplained section). The
  server stores no handle, account id, address, GUID, raw log line or path, but the labels of the trips and your note are your
  own and the game's own wording: they are cleaned again, bounded and escaped (no HTML, no link, no table break), **not
  checked for what they say**, so read the report before you share it (the dashboard says so in every state). A long
  session stays bounded: the table of the download keeps up to 500 trips, the CSV up to 500 rows. The text is built on request,
  held in the page only while you look at it, and removed from the page (its text, not just hidden) when you hide the balance,
  leave the session, close the menu or the page goes away; it is never stored and never sent anywhere by the server.
- **Balance privacy.** Every aUEC figure (balances, results, turnover, gross margin, rates) is given to the model by default and drawn in the dashboard. It is withheld from the model, and from the dashboard, its poll and the session calls it makes, while the player's choice is hidden ("Masquer le solde" or `SC_BALANCE=hidden`, see the dashboard's Balance privacy), whatever `include_balance` says; `include_balance: false` hides one call. It never travels between dashboards. Counts, times and place names are never withheld.
- **Not verified in the real game:** the whole feature was built against fake games and invented logs. The start balance
  quality, the game-running detection from the log's date and the resume after a real crash have not been observed.

## Privacy

- The stream is **unencrypted and readable by any program on your PC** while it is on. It is bound to loopback, so
  it is not reachable from the network.
- It contains your health, your ship and your **aUEC balance**. It does not contain your position.
- This server never logs frames, never writes them to disk and never sends them over a network. Its diagnostics
  contain field numbers only. Frames and raw log lines stay in memory and are never written. The one exception is the session summary: the balance at the start and at the last sighting; the game version, the times (including how long the game was seen running) and the breaks; the last place and goods the log named; your note; the count of refused prices; ship losses: time, model, cause, place, presumed cargo (SCU and aUEC paid); and, for each trip, its label (contract title, places, goods), quantity, cost, revenue, margin, fees, net and the applied plan (planned profit, quantity, terminals). It is kept in a local file, `sessions.json`, only when telemetry is on; this server never sends it anywhere, except that the `sc_session_*` tools return parts of it to your MCP client, and so to your conversation (money figures included, unless you hide them: "Masquer le solde" in the dashboard or `SC_BALANCE=hidden` hides them from the tools until you click "Afficher le solde", and `include_balance` false hides them from one call); `SC_SESSIONS=off` disables it; and deleting `sessions.json` and the `.bak` and `.corrupt` copies next to it erases it. The summaries include balances, by your explicit decision, and this server makes no network request for them (see [Saved sessions](#saved-sessions)).
- **Tool results are part of your conversation with Claude**, which goes to Anthropic. The balance is returned by default, so that Claude can help with your trades; hide it with the dashboard's "Masquer le solde" (sticky, kept in the memory of this server process until it restarts, and protecting only the tools of that process) or `SC_BALANCE=hidden` (permanent, every client) if you would rather not share it. What Claude reads, amounts included, is what leaves your machine; the server itself sends nothing over a network.

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

The dashboard's own health strip (see [Live dashboard](#live-dashboard)) lists what is missing with its fix:

| What the strip says | What to do |
| --- | --- |
| "Télémétrie du jeu: Désactivée côté serveur" | `npm run telemetry -- enable`, then add `--apply` and restart Claude Desktop |
| "Journal du jeu (Game.log): Non configuré" | Add `SC_INSTALL_DIR` (the folder that contains `Game.log`) to the `env` of the `sc-copilot` entry, restart Claude Desktop. Without it: no connection state, no trade journal, no ledger |
| "Journal du jeu: illisible" | `Game.log` only exists after a first launch of the game; otherwise fix the folder. `npm run doctor` for the full check |
| "Télémétrie du jeu: Le jeu a été lancé sans la télémétrie" | Quit the RSI Launcher completely (tray icon too), start it again, start the game. `npm run telemetry -- status` shows both switches |
| "Sessions enregistrées: À régler" | Read-only: update the server. Write failed: free disk space or fix the rights of the data folder (or `SCMCP_SESSIONS_FILE`) |

## Credits

- **Mallachi (Diftic)**, Star Citizen Telemetry skill for Wingman AI and its field-test report: the schema
  reading, the list of what works and what does not, and every quirk above. Read-only reference, nothing copied:
  `Diftic/wingman-skills`, branch `feat/sc-telemetry`, `sc_telemetry/TELEMETRY_REPORT.md`.
- **ShipBit, Wingman AI** (GPLv3): `services/sc_telemetry/sc_telemetry.proto`, copied unchanged with attribution
  into `src/providers/telemetry/`, and the design of the reader and the event rules, rewritten here.
  https://github.com/ShipBit/wingman-ai

The schema was rebuilt by a third party from data inside the game binary. We did not repeat that work. See
[THIRD_PARTY.md](../THIRD_PARTY.md).
