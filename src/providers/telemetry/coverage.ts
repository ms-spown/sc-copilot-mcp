/**
 * What becomes of every field of the stream: where the server exposes it, where the dashboard View shows it, or why
 * it is ignored on purpose. coverage.test.ts fails when a field of schema.ts has no entry here, when an entry names
 * a field that no longer exists, when an `exposed:` path does not resolve in a fully populated frame, and when a
 * View widget does not exist in the page. A future change of the schema therefore forces a decision.
 *
 * Each entry has two sides:
 *  - `server`: `exposed:<root>.<path>` (root `poll` = the answer of sc_live_poll, root `state` = the state of
 *    sc_live_state) or `ignored:<reason>`;
 *  - `view`: `view:<widget>` (a `data-w` id of the page, see WIDGETS) or `ignored:<reason>`.
 *
 * Status of each field (reliable or not verified) is the one of docs/TELEMETRY.md. A field that is present but not
 * verified is exposed under `unverified` and labelled so in the View.
 */

export interface Reason {
  en: string;
  fr: string;
}

export const REASONS = {
  container: {
    en: "Container message: its own fields are listed one by one.",
    fr: "Message conteneur : ses champs sont listés un par un.",
  },
  never_filled: {
    en: "The game never fills it (field test); it is on the 'not in the stream' line.",
    fr: "Le jeu ne le remplit jamais (test terrain) ; il figure sur la ligne « ce que le flux ne contient pas ».",
  },
  cosmetic_hud: {
    en: "A display or aiming preference of the player, of no use on a dashboard; the first frame after a seat change can also carry stale settings.",
    fr: "Une préférence d'affichage ou de visée du joueur, sans utilité sur un tableau de bord ; la première trame après un changement de siège peut aussi porter des réglages périmés.",
  },
  modes_not_verified: {
    en: "Not in the list of verified flight modes: available to the model, not drawn.",
    fr: "Hors de la liste des modes de vol vérifiés : disponible pour le modèle, non dessiné.",
  },
  maker_derived: {
    en: "The game never fills the maker: the server derives it from the class prefix (`ship.manufacturer_derived`) and the View shows that.",
    fr: "Le jeu ne remplit jamais le constructeur : le serveur le déduit du préfixe de classe (`ship.manufacturer_derived`) et la vue montre celui-là.",
  },
  same_for_all: {
    en: "Always the same value for the ships that send vehicle data (ground vehicles send none).",
    fr: "Toujours la même valeur pour les vaisseaux qui envoient des données de véhicule (les véhicules terrestres n'en envoient pas).",
  },
  presets: {
    en: "Weapon presets are not in the stream (field test): not exposed.",
    fr: "Les présélections d'armes ne sont pas dans le flux (test terrain) : non exposées.",
  },
  game_events: {
    en: "The game sent no usable event in the field test; the names of the last frame stay in `sc_live_state` and nothing is built on them.",
    fr: "Le jeu n'a envoyé aucun événement exploitable pendant le test terrain ; les noms de la dernière trame restent dans `sc_live_state` et rien n'est construit dessus.",
  },
  force_feedback: {
    en: "Force feedback for joysticks: not in the stream (field test) and of no use here.",
    fr: "Retour de force des manches : absent du flux (test terrain) et sans utilité ici.",
  },
  turret: {
    en: "Turret seats only, never verified, of no use on a dashboard.",
    fr: "Sièges de tourelle seulement, jamais vérifié, sans utilité sur un tableau de bord.",
  },
  same_as_server: {
    en: "Not exposed by the server, so not shown.",
    fr: "Non exposé par le serveur, donc non affiché.",
  },
  model_only: {
    en: "Exposed to the model, not worth a widget.",
    fr: "Exposé au modèle, ne mérite pas de widget.",
  },
} as const satisfies Record<string, Reason>;

export type ReasonId = keyof typeof REASONS;

/** The `data-w` ids of the View, with their name for the doc. coverage.test.ts checks each exists in the page. */
export const WIDGETS = {
  ship: { en: "Ship name and maker", fr: "Nom et constructeur du vaisseau" },
  mode: { en: "Ship state banner", fr: "Bandeau d'état du vaisseau" },
  speed: { en: "Speed dial", fr: "Cadran de vitesse" },
  g: { en: "G-force dial", fr: "Cadran de force G" },
  vspeed: { en: "Vertical speed bar", fr: "Barre de vitesse verticale" },
  altitude: { en: "Altitude and radar altitude", fr: "Altitude et altitude radar" },
  atmosphere: { en: "Atmospheric density", fr: "Densité atmosphérique" },
  heading: { en: "Compass", fr: "Boussole" },
  hydrogen: {
    en: "Hydrogen gauge and estimated range",
    fr: "Jauge d'hydrogène et autonomie estimée",
  },
  boost: { en: "Boost gauge", fr: "Jauge de boost" },
  power: { en: "Power diagram", fr: "Schéma d'alimentation" },
  modes: { en: "Flight modes line", fr: "Ligne des modes de vol" },
  gear: { en: "Landing gear and VTOL", fr: "Train et VTOL" },
  headlights: { en: "Ship lights", fr: "Phares du vaisseau" },
  lights: { en: "Warning light panel", fr: "Panneau des voyants" },
  gimbals: { en: "Gimbals lock", fr: "Verrouillage des cardans" },
  weapons: { en: "Weapons of the seat", fr: "Armes du poste" },
  cm: { en: "Countermeasures", fr: "Contre-mesures" },
  health: { en: "Health", fr: "Santé" },
  hunger: { en: "Hunger", fr: "Faim" },
  thirst: { en: "Thirst", fr: "Soif" },
  heart: { en: "Heart rate", fr: "Rythme cardiaque" },
  gravity: { en: "Gravity", fr: "Gravité" },
  pressure: { en: "Pressure", fr: "Pression" },
  temperature: { en: "Outside temperature", fr: "Température extérieure" },
  air: { en: "Atmosphere breathable", fr: "Atmosphère respirable" },
  locomotion: { en: "Body position", fr: "Position du corps" },
  crew: { en: "Crew role and seat", fr: "Rôle et siège" },
  balance: { en: "Balance (hidden by default)", fr: "Solde (masqué par défaut)" },
  unverified: { en: "Unverified values card", fr: "Carte des valeurs non vérifiées" },
} as const satisfies Record<string, Reason>;

export type WidgetId = keyof typeof WIDGETS;

export interface CoverageEntry {
  server: string;
  view: string;
}

const x = (path: string, widget: WidgetId): CoverageEntry => ({
  server: `exposed:${path}`,
  view: `view:${widget}`,
});
/** Exposed by the server, deliberately not drawn. */
const xn = (path: string, reason: ReasonId): CoverageEntry => ({
  server: `exposed:${path}`,
  view: `ignored:${reason}`,
});
/** Ignored by the server (and therefore by the View). */
const ig = (reason: ReasonId): CoverageEntry => ({
  server: `ignored:${reason}`,
  view: "ignored:same_as_server",
});

/** Key: `Message.field`, exactly as in schema.ts. */
export const COVERAGE: Record<string, CoverageEntry> = {
  "Availability.enabled": x("poll.ship.flight_modes.coupled.enabled", "modes"),
  "Availability.active": x("poll.ship.flight_modes.coupled.active", "modes"),
  "Gauge.current": x("poll.pilot.health.current", "health"),
  "Gauge.max": x("poll.pilot.health.max", "health"),

  "VehicleDoorState.open_state": x("poll.unverified.ship.doors.open_state", "unverified"),
  "VehicleDoorState.lock_state": x("poll.unverified.ship.doors.lock_state", "unverified"),

  "VehicleFlightSettings.ifcs_coupled": x("poll.ship.flight_modes.coupled", "modes"),
  "VehicleFlightSettings.ifcs_esp": x("poll.ship.flight_modes.esp", "modes"),
  "VehicleFlightSettings.ifcs_gravity_compensation": x(
    "poll.ship.flight_modes.gravity_compensation",
    "modes",
  ),
  "VehicleFlightSettings.ifcs_g_safe": x("poll.ship.flight_modes.g_safe", "modes"),
  "VehicleFlightSettings.ifcs_cruise_mode": x("poll.ship.flight_modes.cruise_mode", "modes"),
  "VehicleFlightSettings.ifcs_spacebreak_enables_boost": x(
    "poll.unverified.ship.flight_settings.spacebreak_enables_boost",
    "unverified",
  ),
  "VehicleFlightSettings.ifcs_speed_limiter": x("poll.ship.flight_modes.speed_limiter", "modes"),
  "VehicleFlightSettings.ifcs_proximity_assist": xn(
    "poll.ship.flight_modes.proximity_assist",
    "modes_not_verified",
  ),
  "VehicleFlightSettings.ifcs_proximity_assist_landing": xn(
    "poll.ship.flight_modes.proximity_assist_landing",
    "modes_not_verified",
  ),
  "VehicleFlightSettings.ifcs_stability": xn(
    "poll.ship.flight_modes.stability",
    "modes_not_verified",
  ),
  "VehicleFlightSettings.ifcs_core": xn("poll.ship.flight_modes.core", "modes_not_verified"),
  "VehicleFlightSettings.advanced_hud_enabled_scm": ig("cosmetic_hud"),
  "VehicleFlightSettings.advanced_hud_enabled_nav": ig("cosmetic_hud"),
  "VehicleFlightSettings.advanced_hud_labels": ig("cosmetic_hud"),
  "VehicleFlightSettings.course_prediction": ig("cosmetic_hud"),
  "VehicleFlightSettings.ifcs_wind_compensation": xn(
    "poll.ship.flight_modes.wind_compensation",
    "modes_not_verified",
  ),
  "VehicleFlightSettings.ifcs_g_safe_disabled_by_boost": x(
    "poll.unverified.ship.flight_settings.g_safe_disabled_by_boost",
    "unverified",
  ),
  "VehicleFlightSettings.ifcs_command_behaviour": xn(
    "poll.ship.flight_modes.command_behaviour",
    "modes_not_verified",
  ),
  "VehicleFlightSettings.flight_light_amplification": ig("cosmetic_hud"),

  "VehicleFlightState.is_landed": x("poll.ship.landed", "mode"),
  "VehicleFlightState.gear": x("poll.ship.gear", "gear"),
  "VehicleFlightState.vtol": x("poll.ship.vtol", "gear"),
  "VehicleFlightState.transformation": x("poll.unverified.ship.transformation", "unverified"),

  "VehicleFlight.state": x("poll.ship.landed", "mode"),
  "VehicleFlight.settings": x("poll.ship.flight_modes", "modes"),
  "VehicleFlight.instruments": x("poll.ship.instruments", "speed"),

  "VehicleFlightInstruments.speed": x("poll.ship.instruments.speed_ms", "speed"),
  "VehicleFlightInstruments.hydrogen_fuel": x("poll.ship.instruments.hydrogen_fuel", "hydrogen"),
  "VehicleFlightInstruments.quantum_fuel": x("poll.unverified.ship.quantum_fuel", "unverified"),
  "VehicleFlightInstruments.g_meter": x("poll.ship.instruments.g", "g"),
  "VehicleFlightInstruments.boost": x("poll.ship.instruments.boost", "boost"),
  "VehicleFlightInstruments.altitude": x("poll.ship.instruments.altitude_m", "altitude"),
  "VehicleFlightInstruments.radar_altitude": x(
    "poll.ship.instruments.radar_altitude_m",
    "altitude",
  ),
  "VehicleFlightInstruments.vertical_speed_indicator": x(
    "poll.ship.instruments.vertical_speed_ms",
    "vspeed",
  ),
  "VehicleFlightInstruments.atmospheric_density": x(
    "poll.ship.instruments.atmospheric_density",
    "atmosphere",
  ),
  "VehicleFlightInstruments.heading": x("poll.ship.instruments.heading_deg", "heading"),

  "VehicleThrusterBoost.engaged": x("poll.ship.instruments.boost.engaged", "boost"),
  "VehicleThrusterBoost.output": x("poll.ship.instruments.boost.output", "boost"),
  "VehicleThrusterBoost.reserves": x("poll.ship.instruments.boost.reserves", "boost"),
  "VehicleThrusterBoost.critical": x("poll.ship.instruments.boost.critical", "boost"),

  "VehiclePowerState.powerplants": x("poll.ship.power.powerplants", "power"),
  "VehiclePowerState.engines": x("poll.ship.power.engines", "power"),
  "VehiclePowerState.weapons": x("poll.ship.power.weapons", "power"),
  "VehiclePowerState.coolers": x("poll.ship.power.coolers", "power"),
  "VehiclePowerState.life_support": x("poll.ship.power.life_support", "power"),
  "VehiclePowerState.gravity_generators": x("poll.ship.power.gravity_generators", "power"),
  "VehiclePowerState.sensors": x("poll.ship.power.sensors", "power"),
  "VehiclePowerState.shield_generators": x("poll.ship.power.shield_generators", "power"),
  "VehiclePowerState.shield_emitters": x("poll.ship.power.shield_emitters", "power"),

  "VehicleAnnunciator.pwr": x("poll.ship.warning_lights.pwr", "lights"),
  "VehicleAnnunciator.wpn": x("poll.ship.warning_lights.wpn", "lights"),
  "VehicleAnnunciator.thr": x("poll.ship.warning_lights.thr", "lights"),
  "VehicleAnnunciator.shld": x("poll.ship.warning_lights.shld", "lights"),
  "VehicleAnnunciator.cool": x("poll.ship.warning_lights.cool", "lights"),
  "VehicleAnnunciator.qdrv": x("poll.ship.warning_lights.qdrv", "lights"),
  "VehicleAnnunciator.radr": x("poll.ship.warning_lights.radr", "lights"),
  "VehicleAnnunciator.prox": x("poll.ship.warning_lights.prox", "lights"),
  "VehicleAnnunciator.hit": x("poll.ship.warning_lights.hit", "lights"),
  "VehicleAnnunciator.misl": x("poll.ship.warning_lights.misl", "lights"),

  "VehicleState.name": x("poll.ship.name", "ship"),
  "VehicleState.class_name": x("poll.ship.class_name", "ship"),
  "VehicleState.manufacturer": xn("poll.unverified.ship.manufacturer", "maker_derived"),
  "VehicleState.type": xn("poll.ship.type", "same_for_all"),
  "VehicleState.lights_enabled": x("poll.ship.lights_on", "headlights"),
  "VehicleState.doors": x("poll.unverified.ship.doors", "unverified"),
  "VehicleState.annunciators": x("poll.ship.warning_lights", "lights"),
  "VehicleState.flight": x("poll.ship.instruments", "speed"),
  "VehicleState.power": x("poll.ship.power", "power"),
  "VehicleFrame.state": x("poll.ship", "ship"),

  "WeaponsSettings.fallback_convergence_distance": ig("cosmetic_hud"),
  "WeaponsSettings.magnified_ui": ig("cosmetic_hud"),
  "WeaponsSettings.precision_lines": ig("cosmetic_hud"),
  "WeaponsSettings.staggered_fire": ig("cosmetic_hud"),
  "WeaponsSettings.use_lag_pips": ig("cosmetic_hud"),
  "WeaponsSettings.use_single_pips": ig("cosmetic_hud"),
  "WeaponsSettings.use_fading_pips": ig("cosmetic_hud"),
  "WeaponsSettings.gimbals_locked": x("poll.weapons.gimbals_locked", "gimbals"),
  "WeaponState.name": x("poll.weapons.weapons[].name", "weapons"),
  "WeaponState.is_powered": x("poll.weapons.weapons[].powered", "weapons"),
  "WeaponState.ready_to_fire": x("poll.weapons.weapons[].ready", "weapons"),
  "WeaponState.contained_in_preset": ig("presets"),
  "Countermeasures.type": x("poll.weapons.countermeasures", "cm"),
  "Countermeasures.amount": x("poll.weapons.countermeasures.decoy", "cm"),
  "WeaponsFrame.settings": x("poll.weapons.gimbals_locked", "gimbals"),
  "WeaponsFrame.preset_index": ig("presets"),
  "WeaponsFrame.preset_name": ig("presets"),
  "WeaponsFrame.weapons": x("poll.weapons.weapons", "weapons"),
  "WeaponsFrame.countermeasures": x("poll.weapons.countermeasures", "cm"),

  "GameEvent.type": xn("state.game_events[]", "game_events"),
  "EventsFrame.events": xn("state.game_events", "game_events"),

  "AxisFeedback.resistance": ig("force_feedback"),
  "AxisFeedback.damping": ig("force_feedback"),
  "FeedbackAxes.x": ig("force_feedback"),
  "FeedbackAxes.y": ig("force_feedback"),
  "FeedbackAxes.z": ig("force_feedback"),
  "ForceFeedbackFrame.angular": ig("force_feedback"),
  "ForceFeedbackFrame.linear": ig("force_feedback"),
  "ForceFeedbackFrame.gunfire": ig("force_feedback"),
  "ForceFeedbackFrame.stick_shaker": ig("force_feedback"),

  "ActorVitals.health": x("poll.pilot.health", "health"),
  "ActorVitals.oxygen": x("poll.unverified.pilot.oxygen", "unverified"),
  "ActorVitals.hunger": x("poll.pilot.hunger", "hunger"),
  "ActorVitals.thirst": x("poll.pilot.thirst", "thirst"),
  "ActorVitals.body_temperature": x("poll.unverified.pilot.body_temperature", "unverified"),
  "ActorVitals.heart_rate": x("poll.pilot.heart_rate_bpm", "heart"),
  "ActorVitals.gravity": x("poll.pilot.gravity_g", "gravity"),
  "ActorVitals.pressure": x("poll.pilot.pressure", "pressure"),
  "ActorVitals.intoxication_level": x("poll.unverified.pilot.intoxication_level", "unverified"),
  "ActorEnvironment.external_temperature": x("poll.pilot.outside_temperature_c", "temperature"),
  "ActorEnvironment.ambient_radiation_rate": x(
    "poll.unverified.pilot.ambient_radiation_rate",
    "unverified",
  ),
  "ActorEnvironment.breathable_atmosphere": x("poll.pilot.breathable_atmosphere", "air"),
  "ActorState.locomotion": x("poll.pilot.locomotion", "locomotion"),
  "ActorState.crew_role": x("poll.pilot.crew_role", "crew"),
  "ActorState.seat_name": x("poll.pilot.seat", "crew"),
  "ActorState.uec_balance": x("poll.balance.uec", "balance"),
  "ActorFrame.vitals": x("poll.pilot", "health"),
  "ActorFrame.state": x("poll.pilot.locomotion", "locomotion"),
  "ActorFrame.environment": x("poll.pilot.outside_temperature_c", "temperature"),

  "TurretFrame.light_amplification": ig("turret"),

  "TelemetryStreamResponse.vehicle": x("poll.ship", "ship"),
  "TelemetryStreamResponse.weapons": x("poll.weapons", "weapons"),
  "TelemetryStreamResponse.events": xn("state.game_events", "game_events"),
  "TelemetryStreamResponse.actor": x("poll.pilot", "health"),
  "TelemetryStreamResponse.force_feedback": ig("force_feedback"),
  "TelemetryStreamResponse.turret": ig("turret"),
};
