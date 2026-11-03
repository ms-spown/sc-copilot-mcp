/**
 * The telemetry schema as a table, mirroring `sc_telemetry.proto` (a test compares the two field by field).
 *
 * Origin of the schema: see the header of sc_telemetry.proto and THIRD_PARTY.md. We never extract it ourselves.
 */

export type Scalar = "bool" | "float" | "int32" | "uint32" | "int64" | "string";
/** "enum:<Name>" and "msg:<Name>" refer to ENUMS and MESSAGES below. */
export type FieldType = Scalar | `enum:${string}` | `msg:${string}`;

export interface FieldSpec {
  name: string;
  type: FieldType;
  repeated?: boolean;
  /** Declared `optional` in the proto: presence is explicit on the wire. */
  optional?: boolean;
}

type MessageSpec = Record<number, FieldSpec>;

/** Enum values by number: the full names as written in the proto. */
export const ENUMS: Record<string, Record<number, string>> = {
  VehicleComponentDeploymentState: {
    0: "VEHICLE_COMPONENT_DEPLOYMENT_STATE_UNSPECIFIED",
    1: "VEHICLE_COMPONENT_DEPLOYMENT_STATE_RETRACTED",
    2: "VEHICLE_COMPONENT_DEPLOYMENT_STATE_DEPLOYING",
    3: "VEHICLE_COMPONENT_DEPLOYMENT_STATE_DEPLOYED",
    4: "VEHICLE_COMPONENT_DEPLOYMENT_STATE_RETRACTING",
  },
  VehicleType: {
    0: "VEHICLE_TYPE_UNSPECIFIED",
    1: "VEHICLE_TYPE_SPACESHIP",
    2: "VEHICLE_TYPE_GROUND",
    3: "VEHICLE_TYPE_GRAVLEV",
    4: "VEHICLE_TYPE_BOAT",
  },
  ActorLocomotionState: {
    0: "ACTOR_LOCOMOTION_STATE_UNSPECIFIED",
    1: "ACTOR_LOCOMOTION_STATE_ON_FOOT",
    2: "ACTOR_LOCOMOTION_STATE_EVA",
    3: "ACTOR_LOCOMOTION_STATE_SEATED",
  },
  ActorCrewRole: {
    0: "ACTOR_CREW_ROLE_UNSPECIFIED",
    1: "ACTOR_CREW_ROLE_PILOT",
    2: "ACTOR_CREW_ROLE_GUNNER",
    3: "ACTOR_CREW_ROLE_CREW",
  },
  DoorOpenState: {
    0: "DOOR_OPEN_STATE_UNSPECIFIED",
    1: "DOOR_OPEN_STATE_OPENED",
    2: "DOOR_OPEN_STATE_CLOSED",
  },
  DoorLockState: {
    0: "DOOR_LOCK_STATE_UNSPECIFIED",
    1: "DOOR_LOCK_STATE_UNLOCKED",
    2: "DOOR_LOCK_STATE_LOCKED",
  },
  AnnunciatorState: {
    0: "ANNUNCIATOR_STATE_UNSPECIFIED",
    1: "ANNUNCIATOR_STATE_NOMINAL",
    2: "ANNUNCIATOR_STATE_OFF",
    3: "ANNUNCIATOR_STATE_MINOR_FLASHING",
    4: "ANNUNCIATOR_STATE_MINOR_ON",
    5: "ANNUNCIATOR_STATE_MAJOR_FLASHING",
    6: "ANNUNCIATOR_STATE_MAJOR_ON",
  },
  CountermeasureType: {
    0: "COUNTERMEASURE_TYPE_UNSPECIFIED",
    1: "COUNTERMEASURE_TYPE_DECOY",
    2: "COUNTERMEASURE_TYPE_NOISE",
  },
  GameEventType: {
    0: "GAME_EVENT_TYPE_UNSPECIFIED",
    1: "GAME_EVENT_TYPE_ACTOR_SPAWN",
    2: "GAME_EVENT_TYPE_ACTOR_DEAD",
    3: "GAME_EVENT_TYPE_ACTOR_ENTER_SEAT",
    4: "GAME_EVENT_TYPE_ACTOR_LEAVE_SEAT",
    5: "GAME_EVENT_TYPE_ACTOR_RESPAWN",
    6: "GAME_EVENT_TYPE_ACTOR_DOWNED",
  },
};

const availability = (name: string): FieldSpec => ({ name, type: "msg:Availability" });

export const MESSAGES: Record<string, MessageSpec> = {
  Availability: {
    1: { name: "enabled", type: "bool" },
    2: { name: "active", type: "bool" },
  },
  Gauge: {
    1: { name: "current", type: "float" },
    2: { name: "max", type: "float" },
  },
  VehicleDoorState: {
    1: { name: "open_state", type: "enum:DoorOpenState" },
    2: { name: "lock_state", type: "enum:DoorLockState" },
  },
  VehicleFlightSettings: {
    1: availability("ifcs_coupled"),
    2: availability("ifcs_esp"),
    3: availability("ifcs_gravity_compensation"),
    4: availability("ifcs_g_safe"),
    5: availability("ifcs_cruise_mode"),
    6: { name: "ifcs_spacebreak_enables_boost", type: "bool" },
    7: availability("ifcs_speed_limiter"),
    8: availability("ifcs_proximity_assist"),
    9: availability("ifcs_proximity_assist_landing"),
    10: availability("ifcs_stability"),
    11: availability("ifcs_core"),
    12: { name: "advanced_hud_enabled_scm", type: "bool" },
    13: { name: "advanced_hud_enabled_nav", type: "bool" },
    14: { name: "advanced_hud_labels", type: "bool" },
    15: { name: "course_prediction", type: "bool" },
    16: availability("ifcs_wind_compensation"),
    17: { name: "ifcs_g_safe_disabled_by_boost", type: "bool" },
    18: availability("ifcs_command_behaviour"),
    19: { name: "flight_light_amplification", type: "bool" },
  },
  VehicleFlightState: {
    1: { name: "is_landed", type: "bool" },
    2: { name: "gear", type: "enum:VehicleComponentDeploymentState", optional: true },
    3: { name: "vtol", type: "enum:VehicleComponentDeploymentState", optional: true },
    4: { name: "transformation", type: "enum:VehicleComponentDeploymentState", optional: true },
  },
  VehicleFlight: {
    1: { name: "state", type: "msg:VehicleFlightState" },
    2: { name: "settings", type: "msg:VehicleFlightSettings" },
    3: { name: "instruments", type: "msg:VehicleFlightInstruments" },
  },
  VehicleFlightInstruments: {
    1: { name: "speed", type: "float" },
    2: { name: "hydrogen_fuel", type: "float" },
    3: { name: "quantum_fuel", type: "float" },
    4: { name: "g_meter", type: "msg:Gauge", optional: true },
    5: { name: "boost", type: "msg:VehicleThrusterBoost" },
    6: { name: "altitude", type: "float" },
    7: { name: "radar_altitude", type: "float" },
    8: { name: "vertical_speed_indicator", type: "float" },
    9: { name: "atmospheric_density", type: "float" },
    10: { name: "heading", type: "float" },
  },
  VehicleThrusterBoost: {
    1: { name: "engaged", type: "bool" },
    2: { name: "output", type: "float" },
    3: { name: "reserves", type: "float" },
    4: { name: "critical", type: "bool" },
  },
  VehiclePowerState: {
    1: { name: "powerplants", type: "bool" },
    2: { name: "engines", type: "bool" },
    3: { name: "weapons", type: "bool" },
    4: { name: "coolers", type: "bool" },
    5: { name: "life_support", type: "bool" },
    6: { name: "gravity_generators", type: "bool" },
    7: { name: "sensors", type: "bool" },
    8: { name: "shield_generators", type: "bool" },
    9: { name: "shield_emitters", type: "bool" },
  },
  VehicleAnnunciator: {
    1: { name: "pwr", type: "enum:AnnunciatorState" },
    2: { name: "wpn", type: "enum:AnnunciatorState" },
    3: { name: "thr", type: "enum:AnnunciatorState" },
    4: { name: "shld", type: "enum:AnnunciatorState" },
    5: { name: "cool", type: "enum:AnnunciatorState" },
    6: { name: "qdrv", type: "enum:AnnunciatorState" },
    7: { name: "radr", type: "enum:AnnunciatorState" },
    8: { name: "prox", type: "enum:AnnunciatorState" },
    9: { name: "hit", type: "enum:AnnunciatorState" },
    10: { name: "misl", type: "enum:AnnunciatorState" },
  },
  VehicleState: {
    1: { name: "name", type: "string" },
    2: { name: "class_name", type: "string" },
    3: { name: "manufacturer", type: "string" },
    4: { name: "type", type: "enum:VehicleType" },
    5: { name: "lights_enabled", type: "bool" },
    6: { name: "doors", type: "msg:VehicleDoorState", optional: true },
    7: { name: "annunciators", type: "msg:VehicleAnnunciator", optional: true },
    8: { name: "flight", type: "msg:VehicleFlight", optional: true },
    9: { name: "power", type: "msg:VehiclePowerState", optional: true },
  },
  VehicleFrame: {
    2: { name: "state", type: "msg:VehicleState" },
  },
  WeaponsSettings: {
    1: { name: "fallback_convergence_distance", type: "bool" },
    2: { name: "magnified_ui", type: "bool" },
    3: { name: "precision_lines", type: "bool" },
    4: { name: "staggered_fire", type: "bool" },
    5: { name: "use_lag_pips", type: "bool" },
    6: { name: "use_single_pips", type: "bool" },
    7: { name: "use_fading_pips", type: "bool" },
    8: { name: "gimbals_locked", type: "bool" },
  },
  WeaponState: {
    1: { name: "name", type: "string" },
    2: { name: "is_powered", type: "bool" },
    3: { name: "ready_to_fire", type: "bool" },
    4: { name: "contained_in_preset", type: "bool" },
  },
  Countermeasures: {
    1: { name: "type", type: "enum:CountermeasureType" },
    2: { name: "amount", type: "uint32" },
  },
  WeaponsFrame: {
    1: { name: "settings", type: "msg:WeaponsSettings" },
    2: { name: "preset_index", type: "uint32" },
    3: { name: "preset_name", type: "string" },
    4: { name: "weapons", type: "msg:WeaponState", repeated: true },
    5: { name: "countermeasures", type: "msg:Countermeasures", repeated: true },
  },
  GameEvent: {
    1: { name: "type", type: "enum:GameEventType" },
  },
  EventsFrame: {
    1: { name: "events", type: "msg:GameEvent", repeated: true },
  },
  AxisFeedback: {
    1: { name: "resistance", type: "float" },
    2: { name: "damping", type: "float" },
  },
  FeedbackAxes: {
    1: { name: "x", type: "msg:AxisFeedback" },
    2: { name: "y", type: "msg:AxisFeedback" },
    3: { name: "z", type: "msg:AxisFeedback" },
  },
  ForceFeedbackFrame: {
    2: { name: "angular", type: "msg:FeedbackAxes" },
    3: { name: "linear", type: "msg:FeedbackAxes" },
    4: { name: "gunfire", type: "float" },
    5: { name: "stick_shaker", type: "float" },
  },
  ActorVitals: {
    1: { name: "health", type: "msg:Gauge" },
    2: { name: "oxygen", type: "msg:Gauge" },
    3: { name: "hunger", type: "msg:Gauge" },
    4: { name: "thirst", type: "msg:Gauge" },
    5: { name: "body_temperature", type: "msg:Gauge" },
    7: { name: "heart_rate", type: "float" },
    8: { name: "gravity", type: "float" },
    9: { name: "pressure", type: "float" },
    10: { name: "intoxication_level", type: "int32" },
  },
  ActorEnvironment: {
    1: { name: "external_temperature", type: "float" },
    2: { name: "ambient_radiation_rate", type: "float" },
    3: { name: "breathable_atmosphere", type: "bool" },
  },
  ActorState: {
    1: { name: "locomotion", type: "enum:ActorLocomotionState" },
    2: { name: "crew_role", type: "enum:ActorCrewRole" },
    3: { name: "seat_name", type: "string" },
    4: { name: "uec_balance", type: "int64" },
  },
  ActorFrame: {
    1: { name: "vitals", type: "msg:ActorVitals" },
    2: { name: "state", type: "msg:ActorState" },
    3: { name: "environment", type: "msg:ActorEnvironment" },
  },
  TurretFrame: {
    1: { name: "light_amplification", type: "bool" },
  },
  TelemetryStreamResponse: {
    3: { name: "vehicle", type: "msg:VehicleFrame" },
    4: { name: "weapons", type: "msg:WeaponsFrame" },
    5: { name: "events", type: "msg:EventsFrame" },
    6: { name: "actor", type: "msg:ActorFrame" },
    7: { name: "force_feedback", type: "msg:ForceFeedbackFrame" },
    8: { name: "turret", type: "msg:TurretFrame" },
  },
};

export const ROOT_MESSAGE = "TelemetryStreamResponse";
export const SERVICE_PATH = "/sc.game.telemetry.v1.GameTelemetryService/TelemetryStream";
