/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The pure logic of the live dashboard View: reducing poll answers into a view state, formatting, polling and
 * `ui/update-model-context` decisions, estimates, alerts. No DOM, no network, no clock of its own (time is always an
 * argument), so vitest tests it directly under Node.
 *
 * The same functions ship inside the page: page.ts serialises each one with Function.prototype.toString. For that to
 * work this file follows three rules, enforced by viewPage.test.ts which runs the assembled page:
 *   - only function declarations, no imports, no module-level values (a function may call another one of this file);
 *   - tunable numbers come from viewConfig(), never from a constant;
 *   - nothing here may write HTML: the page sets text with textContent only.
 */

export function viewConfig() {
  return {
    /** Polling period while the stream is live. Never below minPollMs (2 Hz is the ceiling). */
    pollMs: 1000,
    /** The game is connected but sends no frames (menus, loading). */
    connectedPollMs: 2000,
    /** Telemetry off, game absent, stream cut or server unreachable: one request every 5 seconds. */
    slowPollMs: 5000,
    minPollMs: 500,
    maxBackoffMs: 30000,
    /** Not visible for this long: the View retires for good until the player clicks "resume". */
    retireAfterMs: 30 * 60 * 1000,
    /** A frame older than this is shown as stale. */
    staleAfterMs: 5000,
    /** Minimum gap between two ui/update-model-context calls. */
    contextMinMs: 30000,
    /** Window of the sparklines. */
    historyMs: 60000,
    /** Window kept for the estimates. */
    trendWindowMs: 300000,
    /** An estimate needs at least this much history and this many samples. */
    trendMinSpanMs: 20000,
    trendMinSamples: 5,
    eventCap: 60,
    sampleMinGapMs: 400,
    requestTimeoutMs: 8000,
    alertWindowMs: 180000,
  };
}

// ---------------------------------------------------------------------------------------------
// Formatting (French)
// ---------------------------------------------------------------------------------------------

export function fmtNum(value: number, decimals?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "\u2014";
  const d = decimals === undefined ? 0 : decimals;
  const fixed = Math.abs(value).toFixed(d);
  const parts = fixed.split(".");
  const grouped = (parts[0] as string).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
  const body = parts.length > 1 ? grouped + "," + parts[1] : grouped;
  return value < 0 && Number(fixed) !== 0 ? "\u2212" + body : body;
}

/** A balance can arrive as a decimal string when it does not fit a number. */
export function fmtAuec(value: number | string, signed?: boolean): string {
  if (typeof value === "string") {
    if (!/^-?\d{1,20}$/.test(value)) return "\u2014";
    const neg = value.charAt(0) === "-";
    const digits = neg ? value.slice(1) : value;
    const body = digits.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
    return (neg ? "\u2212" : signed && digits !== "0" ? "+" : "") + body;
  }
  const body = fmtNum(value, 0);
  return signed && value > 0 ? "+" + body : body;
}

export function formatAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "\u2014";
  if (ms < 10000) return fmtNum(Math.round(ms / 100) / 10, 1) + " s";
  if (ms < 60000) return Math.round(ms / 1000) + " s";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => (n < 10 ? "0" + n : String(n));
  if (h > 0) return h + " h " + two(m);
  return m + " min " + two(s);
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "\u2014";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => (n < 10 ? "0" + n : String(n));
  if (h > 0) return h + " h " + two(m) + " min";
  if (m > 0) return m + " min " + two(s) + " s";
  return s + " s";
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "\u2014";
  const a = Math.abs(meters);
  if (a < 1000) return fmtNum(meters, 0) + " m";
  if (a < 100000) return fmtNum(meters / 1000, 1) + " km";
  return fmtNum(meters / 1000, 0) + " km";
}

export function formatClock(iso: string | null | undefined): string {
  if (typeof iso !== "string") return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const two = (n: number) => (n < 10 ? "0" + n : String(n));
  return two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
}

/** Identifiers from the game are letters, digits, "_", "." and "-". Anything else is not passed on. */
export function isSafeId(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value);
}

/** "DRAK_Cutter" with maker "Drake" -> "Drake Cutter". Always returns a display string, never an empty one. */
export function shipTitle(ship: any): string {
  if (!ship) return "\u2014";
  const cls = typeof ship.class_name === "string" ? ship.class_name : "";
  const maker = typeof ship.manufacturer_derived === "string" ? ship.manufacturer_derived : "";
  if (cls && maker) {
    const i = cls.indexOf("_");
    const rest = i > 0 ? cls.slice(i + 1) : cls;
    return maker + " " + rest.replace(/_/g, " ");
  }
  const raw = cls || (typeof ship.name === "string" ? ship.name : "");
  return raw ? raw.replace(/_/g, " ") : "\u2014";
}

// ---------------------------------------------------------------------------------------------
// Stream state
// ---------------------------------------------------------------------------------------------

/** What to tell the player about the stream, in French. `grey` means: dim every value, they are not current. */
export function streamInfo(view: any, now: number): any {
  const cfg = viewConfig();
  const poll = view.poll;
  if (view.link === "init") {
    return {
      id: "init",
      tone: "neutral",
      label: "Connexion\u2026",
      detail: "",
      grey: true,
      help: "",
    };
  }
  if (view.link === "error" && !poll) {
    return {
      id: "error",
      tone: "bad",
      label: "Serveur injoignable",
      detail: "Nouvel essai en cours.",
      grey: true,
      help: "",
    };
  }
  const state = poll ? poll.state : "off";
  const age = frameAge(view, now);
  if (view.link === "error") {
    return {
      id: "error",
      tone: "bad",
      label: "Serveur injoignable",
      detail: "Dernières données il y a " + formatAge(age),
      grey: true,
      help: "",
    };
  }
  switch (state) {
    case "off":
      return {
        id: "off",
        tone: "neutral",
        label: "Télémétrie désactivée",
        detail: "Rien n\u2019est lu dans le jeu.",
        grey: true,
        help: "npm run telemetry -- enable",
      };
    case "waiting":
      return {
        id: "waiting",
        tone: "neutral",
        label: "En attente du premier signal",
        detail:
          "En attente du premier signal du jeu : menus, chargement ou avant l’apparition du personnage.",
        grey: true,
        help: "",
      };
    case "game_without_telemetry":
      return {
        id: "game_without_telemetry",
        tone: "warn",
        label: "Jeu lancé sans télémétrie",
        detail:
          "Quitte complètement le launcher (icône de la barre des tâches comprise), puis relance-le.",
        grey: true,
        help: "",
      };
    case "incompatible":
      return {
        id: "incompatible",
        tone: "bad",
        label: "Format inconnu",
        detail: "Un patch du jeu a probablement changé la télémétrie. Mets le serveur à jour.",
        grey: true,
        help: "",
      };
    case "connected":
      return {
        id: "connected",
        tone: "neutral",
        label: "Connecté, pas encore de trame",
        detail:
          "Menus ou chargement : le flux commence une fois le personnage apparu. Rien d’anormal.",
        grey: true,
        help: "",
      };
    default: {
      const stale = age === null || age > cfg.staleAfterMs;
      return {
        id: stale ? "stale" : "live",
        tone: stale ? "warn" : "ok",
        label: stale ? "Flux interrompu" : "En direct",
        detail: stale
          ? "Dernière trame il y a " +
            formatAge(age) +
            ". Le flux reprend dès que le jeu renvoie des données."
          : "",
        grey: stale,
        help: "",
      };
    }
  }
}

/** Age of the data on screen right now: the age when the server built the answer plus the time since we got it. */
export function frameAge(view: any, now: number): number | null {
  const poll = view.poll;
  if (!poll || typeof poll.frame_age_ms !== "number") return null;
  return poll.frame_age_ms + Math.max(0, now - view.receivedAt);
}

// ---------------------------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------------------------

export function initialViewState(): any {
  return {
    poll: null,
    receivedAt: 0,
    link: "init",
    failures: 0,
    lastError: "",
    events: [],
    lastSeq: 0,
    series: {},
    plan: null,
  };
}

export function seriesValues(poll: any): any {
  const out: any = {};
  const ship = poll && poll.ship;
  const ins = ship && ship.instruments;
  if (ins) {
    if (typeof ins.speed_ms === "number") out.speed = ins.speed_ms;
    if (typeof ins.altitude_m === "number") out.altitude = ins.altitude_m;
    if (typeof ins.vertical_speed_ms === "number") out.vspeed = ins.vertical_speed_ms;
    if (ins.g && typeof ins.g.current === "number") out.g = ins.g.current;
    if (typeof ins.hydrogen_fuel === "number") out.hydrogen = ins.hydrogen_fuel;
    if (ins.boost && typeof ins.boost.reserves === "number") out.boost = ins.boost.reserves;
  }
  const pilot = poll && poll.pilot;
  if (pilot) {
    if (pilot.health && typeof pilot.health.percent === "number") out.health = pilot.health.percent;
    if (pilot.hunger && typeof pilot.hunger.percent === "number") out.hunger = pilot.hunger.percent;
    if (pilot.thirst && typeof pilot.thirst.percent === "number") out.thirst = pilot.thirst.percent;
    if (typeof pilot.heart_rate_bpm === "number" && pilot.heart_rate_bpm > 0) {
      out.heart = pilot.heart_rate_bpm;
    }
  }
  return out;
}

/** Appends a sample and drops what is older than the window. Returns a new array. */
export function pushSample(series: number[][] | undefined, t: number, v: number, windowMs: number) {
  const cfg = viewConfig();
  const base = series || [];
  const last = base[base.length - 1];
  const kept = base.filter((s) => t - (s[0] as number) <= windowMs);
  if (last && t - (last[0] as number) < cfg.sampleMinGapMs) return kept;
  kept.push([t, v]);
  return kept;
}

/** Folds a poll answer into the view state. Pure: returns a new state. */
export function reducePoll(prev: any, poll: any, now: number): any {
  const cfg = viewConfig();
  if (!poll || typeof poll !== "object" || poll.v !== 1) {
    return reducePollError(prev, "réponse de version inconnue", now);
  }
  const next: any = Object.assign({}, prev, {
    poll,
    receivedAt: now,
    link: "ok",
    failures: 0,
    lastError: "",
  });
  // Server restarted: its event numbers start again.
  let events = prev.events;
  let lastSeq = prev.lastSeq;
  if (typeof poll.last_seq === "number" && poll.last_seq < prev.lastSeq) {
    events = [];
    lastSeq = 0;
  }
  const fresh = (Array.isArray(poll.events) ? poll.events : []).filter(
    (e: any) => e && typeof e.seq === "number" && e.seq > lastSeq,
  );
  if (fresh.length > 0) {
    events = events.concat(fresh).slice(-cfg.eventCap);
    lastSeq = fresh[fresh.length - 1].seq;
  }
  next.events = events;
  next.lastSeq = lastSeq;
  // History only grows with current data: a cut stream must not draw a flat line of old values.
  const age = typeof poll.frame_age_ms === "number" ? poll.frame_age_ms : null;
  const seriesKeys = [
    "speed",
    "altitude",
    "vspeed",
    "g",
    "hydrogen",
    "boost",
    "health",
    "hunger",
    "thirst",
    "heart",
  ];
  const series: any = Object.assign({}, prev.series);
  if (poll.state === "live" && age !== null && age <= cfg.staleAfterMs) {
    const values = seriesValues(poll);
    for (const key of seriesKeys) {
      if (typeof values[key] === "number") {
        series[key] = pushSample(series[key], now, values[key], cfg.trendWindowMs);
      }
    }
  }
  next.series = series;
  return next;
}

export function reducePollError(prev: any, message: string, now: number): any {
  void now;
  return Object.assign({}, prev, {
    link: "error",
    failures: prev.failures + 1,
    lastError: String(message).slice(0, 120),
  });
}

/** Events the player may see: the wallet ones only while the balance is shown. */
export function visibleEvents(view: any, showBalance: boolean): any[] {
  return view.events.filter((e: any) => showBalance || e.type !== "uec_changed");
}

// ---------------------------------------------------------------------------------------------
// Polling decisions
// ---------------------------------------------------------------------------------------------

/**
 * Should the View poll now, and how long to wait before the next one?
 *  - torn down, retired, hidden or off screen: no poll at all;
 *  - live: every pollMs; connected without frames: connectedPollMs; off, waiting, cut or unreachable: slowPollMs;
 *  - repeated failures back off, up to maxBackoffMs;
 *  - never faster than minPollMs (2 Hz).
 */
export function pollingDecision(s: any): any {
  const cfg = viewConfig();
  if (s.tornDown) return { run: false, delayMs: 0, reason: "teardown", retire: false };
  if (s.retired) return { run: false, delayMs: 0, reason: "retired", retire: false };
  if (s.hidden || s.offscreen) {
    const since = typeof s.awaySince === "number" ? s.awaySince : s.now;
    return {
      run: false,
      delayMs: 0,
      reason: s.hidden ? "hidden" : "offscreen",
      retire: s.now - since >= cfg.retireAfterMs,
    };
  }
  let delay = cfg.pollMs;
  if (s.state === "connected") delay = cfg.connectedPollMs;
  else if (s.state !== "live") delay = cfg.slowPollMs;
  if (s.failures > 0) {
    delay = Math.max(delay, Math.min(cfg.maxBackoffMs, 1000 * Math.pow(2, s.failures)));
  }
  return { run: true, delayMs: Math.max(delay, cfg.minPollMs), reason: "visible", retire: false };
}

// ---------------------------------------------------------------------------------------------
// Mode, health, gauges
// ---------------------------------------------------------------------------------------------

export function modeInfo(poll: any): any {
  if (!poll || poll.state === "off") return { id: "unknown", label: "Inconnu" };
  const ship = poll.ship;
  const derived = poll.derived || {};
  if (ship) {
    if (derived.in_jump) return { id: "jump", label: "Saut quantique" };
    if (derived.in_quantum_mode) return { id: "quantum", label: "Quantique" };
    if (ship.landed === true) return { id: "landed", label: "Posé" };
    if (ship.landed === false) return { id: "flight", label: "En vol" };
    return { id: "ship", label: "À bord" };
  }
  const pilot = poll.pilot;
  if (pilot && pilot.locomotion === "on_foot") return { id: "foot", label: "À pied" };
  if (pilot && pilot.locomotion === "eva") return { id: "eva", label: "EVA" };
  if (derived.ground_vehicle) return { id: "ground", label: "Véhicule terrestre" };
  if (pilot && pilot.locomotion === "seated") return { id: "seated", label: "Assis" };
  return { id: "unknown", label: "Inconnu" };
}

export function levelFor(fraction: number, low: number, critical: number): string {
  if (!Number.isFinite(fraction)) return "none";
  if (fraction <= critical) return "bad";
  if (fraction <= low) return "warn";
  return "ok";
}

/** Health 0 is "down or dead": the stream cannot tell which. An absent gauge is not zero. */
export function healthInfo(pilot: any): any {
  const g = pilot && pilot.health;
  if (!g || typeof g.current !== "number" || !(g.max > 0)) {
    return { known: false, text: "\u2014", level: "none", fraction: null, zero: false };
  }
  if (g.current <= 0) {
    return { known: true, text: "À terre ou mort", level: "bad", fraction: 0, zero: true };
  }
  const fraction = Math.min(1, g.current / g.max);
  return {
    known: true,
    text: fmtNum(Math.round(fraction * 100)) + "\u00a0%",
    level: levelFor(fraction, 0.3, 0.15),
    fraction,
    zero: false,
  };
}

export function gaugeInfo(gauge: any, low: number, critical: number): any {
  if (!gauge || typeof gauge.current !== "number" || !(gauge.max > 0)) {
    return { known: false, text: "\u2014", level: "none", fraction: null };
  }
  const fraction = Math.max(0, Math.min(1, gauge.current / gauge.max));
  return {
    known: true,
    text: fmtNum(Math.round(fraction * 100)) + "\u00a0%",
    level: levelFor(fraction, low, critical),
    fraction,
  };
}

/** Hydrogen and boost reserves come as fractions from 0 to 1. */
export function fractionInfo(value: unknown, low: number, critical: number): any {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { known: false, text: "\u2014", level: "none", fraction: null };
  }
  const fraction = Math.max(0, Math.min(1, value));
  return {
    known: true,
    text: fmtNum(Math.round(fraction * 100)) + "\u00a0%",
    level: levelFor(fraction, low, critical),
    fraction,
  };
}

export function lightsInfo(lights: any): any[] {
  const defs = [
    ["thr", "THR", true],
    ["shld", "SHLD", true],
    ["prox", "PROX", true],
    ["hit", "HIT", true],
    ["radr", "RADR", true],
    ["qdrv", "QDRV", true],
    ["wpn", "WPN", true],
    ["pwr", "PWR", false],
    ["cool", "COOL", false],
    ["misl", "MISL", false],
  ];
  const texts: any = {
    nominal: "nominal",
    off: "éteint",
    minor_on: "alerte mineure",
    minor_flashing: "alerte mineure (clignote)",
    major_on: "alerte majeure",
    major_flashing: "alerte majeure (clignote)",
    unspecified: "inconnu",
  };
  return defs.map((d) => {
    const key = d[0] as string;
    const raw = lights && typeof lights[key] === "string" ? lights[key] : "unspecified";
    let tone = "off";
    if (raw === "nominal") tone = key === "qdrv" ? "info" : "ok";
    else if (raw === "minor_on" || raw === "minor_flashing") tone = "warn";
    else if (raw === "major_on" || raw === "major_flashing") tone = "bad";
    return {
      key,
      label: d[1],
      verified: d[2],
      raw,
      text: texts[raw] || "inconnu",
      tone,
    };
  });
}

export function powerInfo(power: any): any[] {
  const defs = [
    ["powerplants", "Centrale"],
    ["engines", "Moteurs"],
    ["weapons", "Armes"],
    ["coolers", "Refroid."],
    ["life_support", "Vie"],
    ["gravity_generators", "Gravité"],
    ["sensors", "Capteurs"],
    ["shield_generators", "Bouclier gén."],
    ["shield_emitters", "Bouclier ém."],
  ];
  return defs.map((d) => ({
    key: d[0],
    label: d[1],
    known: !!power && typeof power[d[0] as string] === "boolean",
    on: !!power && power[d[0] as string] === true,
  }));
}

export function flightModesInfo(modes: any): any[] {
  const defs = [
    ["coupled", "Couplé"],
    ["esp", "ESP"],
    ["g_safe", "G-safe"],
    ["speed_limiter", "Limiteur"],
    ["cruise_mode", "Croisière"],
    ["gravity_compensation", "Comp. gravité"],
  ];
  return defs.map((d) => {
    const m = modes && modes[d[0] as string];
    return {
      key: d[0],
      label: d[1],
      known: !!m,
      active: !!m && m.active === true,
      enabled: !!m && m.enabled === true,
    };
  });
}

export function countermeasureLabel(kind: string): string {
  if (kind === "decoy") return "Leurres";
  if (kind === "noise") return "Brouillage";
  return "Contre-mesures";
}

// ---------------------------------------------------------------------------------------------
// Events, alerts, timeline
// ---------------------------------------------------------------------------------------------

export function eventLabel(ev: any): string {
  const labels: any = {
    powerplant_offline: "Centrale hors service",
    powerplant_online: "Centrale rétablie",
    engines_offline: "Moteurs coupés",
    engines_damaged: "Moteurs endommagés",
    shields_down: "Boucliers tombés",
    shields_restored: "Boucliers rétablis",
    shields_powered_off: "Boucliers coupés{quantum_suffix}",
    shields_powered_on: "Boucliers réalimentés",
    weapons_unavailable: "Armes sans énergie",
    boost_depleted: "Réserve de boost critique",
    hydrogen_low: "Hydrogène bas ({percent}\u00a0%)",
    landed: "Posé",
    took_off: "Décollage",
    gear_deployed: "Train sorti",
    gear_retracted: "Train rentré",
    quantum_mode_on: "Mode quantique activé",
    quantum_mode_off: "Mode quantique coupé",
    jump_started: "Saut quantique",
    jump_finished: "Fin du saut",
    proximity_warning: "Alerte de proximité",
    vehicle_changed: "Nouveau vaisseau : {vehicle}",
    under_fire: "Touché",
    locked_on: "Verrouillage hostile",
    countermeasures_low: "Contre-mesures basses ({kind} : {count})",
    countermeasures_empty: "Contre-mesures épuisées ({kind})",
    ground_vehicle_entered: "Véhicule terrestre : {vehicle}",
    health_low: "Santé basse ({percent}\u00a0%)",
    player_down: "À terre ou mort",
    respawned: "Rétabli ou réapparu",
    oxygen_low: "Oxygène bas ({percent}\u00a0%)",
    not_breathable: "Air non respirable",
    exhausted: "Effort intense",
    hunger_low: "Faim ({percent}\u00a0%)",
    thirst_low: "Soif ({percent}\u00a0%)",
    intoxicated: "Intoxication signalée",
    uec_changed: "Solde modifié",
  };
  const template = labels[ev && ev.type];
  if (typeof template !== "string") return "Événement inconnu";
  const data = (ev && ev.data) || {};
  return template.replace(/\{(\w+)\}/g, (_m: string, key: string) => {
    const v = data[key];
    if (key === "quantum_suffix") return data.quantum === 1 ? " · mode quantique" : "";
    if (key === "vehicle") return isSafeId(v) ? String(v).replace(/_/g, " ") : "?";
    if (key === "kind") return typeof v === "string" ? countermeasureLabel(v).toLowerCase() : "?";
    if (key === "count" || key === "percent") return typeof v === "number" ? fmtNum(v) : "?";
    return "?";
  });
}

/**
 * Alerts to show in the band: recent, important events, newest first, at most `limit`. A "restored" event clears
 * its alert. Confirmed events come first; unverified ones are kept but flagged (`verified: false`).
 */
export function activeAlerts(events: any[], now: number, limit: number, covered?: string[]): any[] {
  const cfg = viewConfig();
  const skip: string[] = covered || [];
  const important: any = {
    shields_down: ["bad", "shields"],
    locked_on: ["bad", "lock"],
    countermeasures_low: ["warn", "cm"],
    countermeasures_empty: ["bad", "cm"],
    engines_damaged: ["bad", "engines"],
    health_low: ["warn", "health"],
    player_down: ["bad", "health"],
    powerplant_offline: ["bad", "power"],
    boost_depleted: ["warn", "boost"],
    under_fire: ["warn", "fire"],
    proximity_warning: ["warn", "prox"],
    hydrogen_low: ["warn", "hydrogen"],
    oxygen_low: ["warn", "oxygen"],
    not_breathable: ["warn", "air"],
  };
  const clears: any = {
    shields_restored: "shields",
    powerplant_online: "power",
    respawned: "health",
  };
  const byKey: any = {};
  for (const e of events) {
    if (!e || typeof e.type !== "string") continue;
    const clear = clears[e.type];
    if (clear) delete byKey[clear];
    const imp = important[e.type];
    if (imp) byKey[imp[1]] = { event: e, tone: imp[0] };
  }
  const out = Object.keys(byKey)
    .filter((k) => skip.indexOf(k) < 0)
    .map((k) => byKey[k])
    .filter((a: any) => now - Date.parse(a.event.at) <= cfg.alertWindowMs)
    .map((a: any) => ({
      seq: a.event.seq,
      tone: a.tone,
      verified: a.event.confidence === "confirmed",
      label: eventLabel(a.event),
      at: a.event.at,
      ageMs: Math.max(0, now - Date.parse(a.event.at)),
    }));
  out.sort((a: any, b: any) => (a.verified === b.verified ? b.seq - a.seq : a.verified ? -1 : 1));
  return out.slice(0, limit);
}

/**
 * The conditions that hold now, as chips: tone (info, warn, bad), a French label, and how long they have lasted
 * (the server's `since` against the answer's own clock, so the View and the server never need the same clock).
 * Ids the View does not know still get a chip with a neutral label: nothing the server flags is hidden.
 */
export function conditionItems(poll: any, now: number, receivedAt: number, limit: number): any[] {
  const list = poll && Array.isArray(poll.conditions) ? poll.conditions : [];
  const tones: any = { info: "info", warning: "warn", critical: "bad" };
  const out: any[] = [];
  for (const c of list) {
    if (!c || typeof c.id !== "string" || !tones[c.level]) continue;
    const data = c.data && typeof c.data === "object" ? c.data : {};
    const pct = typeof data.percent === "number" ? fmtNum(data.percent) + "\u00a0%" : "?";
    const kind = typeof data.kind === "string" ? countermeasureLabel(data.kind) : "Contre-mesures";
    const quantum = data.quantum === true;
    const labels: any = {
      powerplant_off: "Centrale hors service",
      engines_off: "Moteurs coupés",
      engines_damaged: "Moteurs endommagés",
      shields_off: quantum ? "Boucliers coupés · mode quantique" : "Boucliers coupés",
      shields_down: "Boucliers tombés",
      weapons_unpowered: "Armes sans énergie",
      hostile_lock: "Verrouillage hostile",
      under_fire: "Touché",
      proximity: "Proximité : risque de collision",
      hydrogen_low: "Hydrogène bas (" + pct + ")",
      boost_critical: "Réserve de boost critique",
      countermeasures_low:
        kind + " bas" + (typeof data.count === "number" ? " (" + fmtNum(data.count) + ")" : ""),
      countermeasures_empty: kind + " épuisé",
      health_low: "Santé basse (" + pct + ")",
      down_or_dead: "À terre ou mort",
      hunger_low: "Faim (" + pct + ")",
      thirst_low: "Soif (" + pct + ")",
      not_breathable: "Air non respirable",
      in_quantum: "Mode quantique",
      in_jump: "Saut quantique en cours",
    };
    const label = typeof labels[c.id] === "string" ? labels[c.id] : "Condition inconnue";
    let ageMs: number | null = null;
    if (typeof c.since === "number" && typeof poll.at === "number") {
      ageMs = Math.max(0, poll.at - c.since + Math.max(0, now - receivedAt));
    }
    out.push({
      key: c.id + (typeof data.kind === "string" && isSafeId(data.kind) ? ":" + data.kind : ""),
      id: c.id,
      tone: tones[c.level],
      verified: c.confidence !== "unverified",
      label,
      ageMs,
    });
  }
  return out.slice(0, limit);
}

/** Alert keys of activeAlerts that an active condition already says (the event band does not repeat them). */
export function coveredAlertKeys(poll: any): string[] {
  const map: any = {
    shields_down: "shields",
    hostile_lock: "lock",
    countermeasures_low: "cm",
    countermeasures_empty: "cm",
    engines_damaged: "engines",
    health_low: "health",
    down_or_dead: "health",
    powerplant_off: "power",
    boost_critical: "boost",
    under_fire: "fire",
    proximity: "prox",
    hydrogen_low: "hydrogen",
    not_breathable: "air",
  };
  const out: string[] = [];
  const list = poll && Array.isArray(poll.conditions) ? poll.conditions : [];
  for (const c of list) {
    if (c && typeof c.id === "string" && map[c.id]) out.push(map[c.id]);
  }
  return out;
}

export function timelineItems(events: any[], markers: any[], limit: number): any[] {
  const kept = [
    "took_off",
    "landed",
    "jump_started",
    "jump_finished",
    "vehicle_changed",
    "under_fire",
    "shields_down",
    "shields_powered_off",
    "shields_powered_on",
    "player_down",
    "respawned",
    "locked_on",
  ];
  const items: any[] = [];
  for (const e of events) {
    if (e && kept.indexOf(e.type) >= 0) {
      items.push({
        at: e.at,
        label: eventLabel(e),
        kind: "event",
        verified: e.confidence === "confirmed",
      });
    }
  }
  const marks: any = {
    start: "Début de session",
    end: "Fin de session",
    reset_delta: "Solde remis à zéro",
  };
  for (const m of markers || []) {
    if (m && marks[m.kind])
      items.push({ at: m.at, label: marks[m.kind], kind: "marker", verified: true });
  }
  items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return items.slice(-limit);
}

// ---------------------------------------------------------------------------------------------
// Estimates and pace
// ---------------------------------------------------------------------------------------------

/**
 * Remaining time at the recent rate, from a series of [t, fraction] samples. It is an ESTIMATE from a straight line
 * through the last minutes, never a measurement: the result says over which window it was computed.
 */
export function trendEstimate(series: number[][] | undefined, now: number, windowMs?: number): any {
  const cfg = viewConfig();
  const win = windowMs === undefined ? cfg.trendWindowMs : windowMs;
  const pts = (series || []).filter((s) => now - (s[0] as number) <= win);
  if (pts.length < cfg.trendMinSamples) return { kind: "none", reason: "pas assez de mesures" };
  const first = pts[0] as number[];
  const last = pts[pts.length - 1] as number[];
  const span = (last[0] as number) - (first[0] as number);
  if (span < cfg.trendMinSpanMs) return { kind: "none", reason: "historique trop court" };
  let sx = 0;
  let sy = 0;
  for (const p of pts) {
    sx += (p[0] as number) - (first[0] as number);
    sy += p[1] as number;
  }
  const mx = sx / pts.length;
  const my = sy / pts.length;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    const dx = (p[0] as number) - (first[0] as number) - mx;
    num += dx * ((p[1] as number) - my);
    den += dx * dx;
  }
  if (den === 0) return { kind: "none", reason: "historique trop court" };
  const perMs = num / den;
  const perMin = perMs * 60000;
  // The straight line remembers the burn of a minute ago: if nothing was used in the last 15 seconds, say stable.
  let before: number[] | undefined;
  for (const p of pts) if (now - (p[0] as number) >= 15000) before = p;
  if (perMin <= -0.001 && before && (last[1] as number) >= (before[1] as number) - 0.0005) {
    return { kind: "stable", perMin: 0, windowMs: span };
  }
  if (perMin > 0.002) return { kind: "rising", perMin, windowMs: span };
  if (perMin > -0.001) return { kind: "stable", perMin, windowMs: span };
  const current = last[1] as number;
  const remainingMs = current <= 0 ? 0 : current / -perMs;
  return { kind: "estimate", perMin, windowMs: span, remainingMs };
}

export function estimateText(est: any): string {
  if (!est || est.kind === "none") return "estimation indisponible";
  if (est.kind === "stable") return "stable";
  if (est.kind === "rising") return "en hausse";
  if (est.remainingMs > 24 * 3600000) return "plus de 24 h";
  return "\u2248\u00a0" + formatDuration(est.remainingMs);
}

export function sessionRate(
  delta: number | null | undefined,
  sinceIso: string | null | undefined,
  now: number,
): any {
  if (typeof delta !== "number" || typeof sinceIso !== "string") return null;
  const since = Date.parse(sinceIso);
  if (!Number.isFinite(since)) return null;
  const elapsed = now - since;
  if (elapsed < 120000) return null;
  return { perHour: (delta / elapsed) * 3600000, elapsedMs: elapsed };
}

/** Where the balance change is counted from, in words. */
export function baselineLabel(poll: any): string {
  const bal = poll && poll.balance;
  const session = poll && poll.session;
  if (!bal || typeof bal.since !== "string") return "";
  const since = Date.parse(bal.since);
  const marks = (session && session.markers) || [];
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i];
    if (Math.abs(Date.parse(m.at) - since) <= 2500) {
      if (m.kind === "start") return "depuis le début de session";
      if (m.kind === "reset_delta") return "depuis la remise à zéro";
    }
  }
  return "depuis le démarrage du lecteur";
}

export function planProgress(plan: any, delta: number | null | undefined): any {
  if (!plan) return null;
  const expected = typeof plan.expected_profit_auec === "number" ? plan.expected_profit_auec : null;
  const actual = typeof delta === "number" ? delta : null;
  const ratio = expected !== null && expected > 0 && actual !== null ? actual / expected : null;
  return { expected, actual, ratio };
}

// ---------------------------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------------------------

/** Points of a polyline for the last `windowMs`, in a box of w by h. */
export function sparkPoints(
  series: number[][] | undefined,
  now: number,
  windowMs: number,
  w: number,
  h: number,
): any {
  const pts = (series || []).filter((s) => now - (s[0] as number) <= windowMs);
  if (pts.length < 2) return { points: "", min: null, max: null };
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    min = Math.min(min, p[1] as number);
    max = Math.max(max, p[1] as number);
  }
  const range = max - min;
  const pad = 2;
  const coords = pts.map((p) => {
    const x = ((windowMs - (now - (p[0] as number))) / windowMs) * w;
    const y = range < 1e-9 ? h / 2 : pad + (1 - ((p[1] as number) - min) / range) * (h - 2 * pad);
    return Math.round(x * 10) / 10 + "," + Math.round(y * 10) / 10;
  });
  return { points: coords.join(" "), min, max };
}

// ---------------------------------------------------------------------------------------------
// Plan (from the model, so untrusted)
// ---------------------------------------------------------------------------------------------

/** The View checks the plan again: it came through the model. Known fields only, capped, no control characters. */
export function cleanPlan(input: any): any {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const out: any = {};
  for (const k of ["commodity", "buy_terminal", "sell_terminal", "note"]) {
    const v = input[k];
    if (typeof v === "string") {
      const t = v
        .replace(
          // eslint-disable-next-line no-misleading-character-class
          /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\p{Variation_Selector}]|\u{34f}|[\u{115f}\u{1160}\u{17b4}\u{17b5}\u{2800}\u{3164}\u{ffa0}]/gu,
          " ",
        )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      if (t) out[k] = t;
    }
  }
  if (typeof input.scu === "number" && Number.isFinite(input.scu))
    out.scu = Math.max(0, Math.round(input.scu));
  if (
    typeof input.expected_profit_auec === "number" &&
    Number.isFinite(input.expected_profit_auec)
  ) {
    out.expected_profit_auec = Math.round(input.expected_profit_auec);
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------------------------
// What goes to the conversation
// ---------------------------------------------------------------------------------------------

/** Fixed French texts for ui/message. Only a ship identifier that passed isSafeId, and for "route" the balance. */
export function actionMessage(kind: string, ctx: any): string | null {
  const ship = ctx && isSafeId(ctx.vehicle) ? String(ctx.vehicle) : "";
  if (kind === "analyse") {
    return "Analyse ma situation dans le jeu à partir de la télémétrie en direct : appelle sc_live_state (sections ship, pilot et weapons) et sc_live_events, dis l\u2019âge des données et ce que le flux ne contient pas, puis ce qui demande mon attention. Ne lis pas mon solde.";
  }
  if (kind === "bilan") {
    return "Fais le bilan de ma session à partir de la télémétrie en direct : appelle sc_live_events et sc_live_state, résume décollages, atterrissages, sauts, alertes et combats en distinguant les événements confirmed et unverified. N\u2019inclus pas mon solde.";
  }
  if (kind === "route") {
    if (!ctx || ctx.balance === undefined || ctx.balance === null) return null;
    const bal = fmtAuec(ctx.balance);
    if (bal === "\u2014") return null;
    return (
      "Propose-moi une route commerciale rentable avec mon solde et ce vaisseau. Je t\u2019envoie volontairement mon solde actuel avec ce message : " +
      bal +
      " aUEC. Mon vaisseau : " +
      (ship || "inconnu") +
      ". Utilise sc_live_state pour le reste et uex_get_trade_routes pour la route."
    );
  }
  return null;
}

/** The compact state the View may send with ui/update-model-context. NEVER the balance, never an event text. */
export function contextSummary(poll: any, events: any[]): any {
  if (!poll || poll.state !== "live") return null;
  const mode = modeInfo(poll);
  const vehicle = poll.ship && isSafeId(poll.ship.name) ? shipTitle(poll.ship) : "";
  const h = healthInfo(poll.pilot);
  let band = "none";
  if (h.known)
    band = h.zero ? "zero" : h.fraction <= 0.3 ? "low" : h.fraction <= 0.6 ? "mid" : "ok";
  let seq = 0;
  for (const e of events) {
    if (e && e.confidence === "confirmed" && e.group !== "wallet" && e.seq > seq) seq = e.seq;
  }
  const healthWords: any = {
    none: "inconnue",
    zero: "à terre ou mort",
    low: "basse",
    mid: "moyenne",
    ok: "bonne",
  };
  return {
    key: mode.id + "|" + vehicle + "|" + band,
    seq,
    text:
      "Résumé automatique du tableau de bord en direct (envoyé par l\u2019interface, pas par le joueur) : mode " +
      mode.label.toLowerCase() +
      ", vaisseau " +
      (vehicle || "aucun") +
      ", santé " +
      healthWords[band] +
      ". Pour des valeurs à jour, appelle sc_live_state.",
  };
}

export function initialContextGate(): any {
  return { lastSentAt: null, lastKey: null, lastSeq: 0, baselined: false };
}

/**
 * At most one ui/update-model-context per contextMinMs, and only on a significant change: mode, vehicle, health
 * crossing a band, or a new confirmed event. The first summary only sets the baseline. A change that arrives too
 * early is not lost: the gate keeps its old key, so the next poll after the delay sends it.
 */
export function contextDecision(gate: any, summary: any, now: number): any {
  const cfg = viewConfig();
  if (!summary) return { send: false, gate, text: "" };
  if (!gate.baselined) {
    return {
      send: false,
      gate: Object.assign({}, gate, {
        baselined: true,
        lastKey: summary.key,
        lastSeq: summary.seq,
      }),
      text: "",
    };
  }
  const changed = summary.key !== gate.lastKey || summary.seq > gate.lastSeq;
  if (!changed) return { send: false, gate, text: "" };
  if (gate.lastSentAt !== null && now - gate.lastSentAt < cfg.contextMinMs) {
    return { send: false, gate, text: "" };
  }
  return {
    send: true,
    gate: Object.assign({}, gate, { lastSentAt: now, lastKey: summary.key, lastSeq: summary.seq }),
    text: summary.text,
  };
}

/** Host style variables are applied as they come, but only well-formed custom properties with plain values. */
export function safeStyleVariables(vars: any): any[] {
  const out: any[] = [];
  if (!vars || typeof vars !== "object") return out;
  for (const k of Object.keys(vars)) {
    const v = vars[k];
    if (
      /^--[a-z0-9-]{1,60}$/.test(k) &&
      typeof v === "string" &&
      v.length <= 300 &&
      !/[;{}<>\\]|url\(|@import|expression\(/i.test(v)
    ) {
      out.push([k, v]);
    }
  }
  return out;
}

/** The names the page needs, in the order they are serialised. */
export const VIEW_FUNCTIONS = [
  viewConfig,
  fmtNum,
  fmtAuec,
  formatAge,
  formatDuration,
  formatDistance,
  formatClock,
  isSafeId,
  shipTitle,
  frameAge,
  streamInfo,
  initialViewState,
  seriesValues,
  pushSample,
  reducePoll,
  reducePollError,
  visibleEvents,
  pollingDecision,
  modeInfo,
  levelFor,
  healthInfo,
  gaugeInfo,
  fractionInfo,
  lightsInfo,
  powerInfo,
  flightModesInfo,
  countermeasureLabel,
  eventLabel,
  activeAlerts,
  conditionItems,
  coveredAlertKeys,
  timelineItems,
  trendEstimate,
  estimateText,
  sessionRate,
  baselineLabel,
  planProgress,
  sparkPoints,
  cleanPlan,
  actionMessage,
  contextSummary,
  initialContextGate,
  contextDecision,
  safeStyleVariables,
];
