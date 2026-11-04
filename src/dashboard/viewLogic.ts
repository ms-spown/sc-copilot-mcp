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
    /**
     * A ship loss leads the header verdict ("fatal") for this long only; after it, or when a red condition that began after the
     * loss is on, the verdict goes back to the normal order of gravity (the alert box keeps the loss for 15 minutes).
     */
    lossLeadMs: 180000,
    /** Channel shared by the Views of this connector (same sandbox origin). No network is involved. */
    channelName: "sc-copilot-dashboard-v2",
    /** A peer not heard for this long is gone (its heartbeat is every heartbeatMs). */
    peerTtlMs: 6000,
    heartbeatMs: 2000,
    /** The leader shares its answer with the other Views at most this often. */
    snapshotMinMs: 900,
    /** Without BroadcastChannel nothing can be coordinated: a View away this long retires. */
    noChannelRetireMs: 30000,
    /** Peers remembered at most (a hostile page on the channel must not grow the table). */
    maxPeers: 32,
    /** A rank (creation time) further in the future than this is refused. */
    maxRankSkewMs: 60000,
    /** Plain series kept for a sparkline, and for the estimates (ms). */
    sparkKeepMs: 62000,
    maxSamples: 800,
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

/**
 * What to tell the player when Game.log says they are not in a server session, or null when it says nothing alarming
 * (online, unknown). Never claims the game is not running: only `closed` (the game's own quit line) says it.
 */
export function connectionInfo(conn: any, now: number): any {
  const since = typeof conn.since === "string" ? Date.parse(conn.since) : NaN;
  const ago = Number.isFinite(since) ? formatAge(Math.max(0, now - since)) : "";
  const when = ago ? ", il y a " + ago : "";
  switch (conn.state) {
    case "disconnected": {
      const inactive = conn.code === 30028;
      const why = inactive
        ? "Renvoyé du serveur pour inactivité"
        : conn.code
          ? "Le serveur a coupé la connexion (code " + conn.code + ")"
          : "La session de jeu est terminée";
      const reason =
        !inactive && conn.reason ? " Raison donnée par le jeu : " + conn.reason + "." : "";
      return {
        id: "disconnected",
        tone: "bad",
        label: "Déconnecté du serveur",
        detail:
          why +
          when +
          "." +
          reason +
          " Les valeurs affichées sont les dernières reçues ; le suivi reprend dès que tu es de nouveau en partie.",
        grey: true,
        help: "",
      };
    }
    case "menu":
      return {
        id: "menu",
        tone: "neutral",
        label: "Dans les menus",
        detail:
          "Pas de partie en cours" +
          when +
          ". Les valeurs affichées sont les dernières reçues ; le suivi reprend dès que tu rejoins un serveur.",
        grey: true,
        help: "",
      };
    case "closed":
      return {
        id: "closed",
        tone: "neutral",
        label: "Jeu fermé",
        detail:
          "Le jeu a écrit sa ligne de fermeture" +
          when +
          ". Le suivi reprendra au prochain lancement.",
        grey: true,
        help: "",
      };
    default:
      return null;
  }
}

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
  // Game.log knows what the stream cannot say (kicked, back in the menu, game closed): it wins over the frames,
  // which may keep repeating the last values. Never applies to the states that mean "no telemetry at all".
  if (
    poll &&
    poll.connection &&
    (state === "live" || state === "connected" || state === "waiting")
  ) {
    const away = connectionInfo(poll.connection, now);
    if (away) return away;
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
    /** When this View received the plan (ms, its own clock): a plan that came after a run began is not that run's. */
    planAt: null,
    /** The hashes of the sections held, as the server sent them (the next poll says which ones it already has). */
    hash: {},
    /** What the stream never contains, once the server has said it. */
    notInStream: null,
    /** Highest value seen per countermeasure kind for this vehicle: the reference of the relative bar. */
    peaks: {},
    shipKey: "",
    /** Deduced scales of the dials (never shrink during a session). */
    scales: { speed: 0, vspeed: 0 },
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
  // The window already bounds it (about 2.5 samples a second at most); this is the hard ceiling.
  if (kept.length > cfg.maxSamples) kept.splice(0, kept.length - cfg.maxSamples);
  return kept;
}

/** Folds a poll answer into the view state. Pure: returns a new state. */
export function reducePoll(prev: any, incoming: any, now: number): any {
  const cfg = viewConfig();
  if (!incoming || typeof incoming !== "object" || incoming.v !== 1) {
    return reducePollError(prev, "réponse de version inconnue", now);
  }
  // Sections the server left out because this View already holds them unchanged: put them back.
  const poll: any = Object.assign({}, incoming);
  const names = ["ship", "pilot", "weapons", "specs", "ledger"];
  if (Array.isArray(incoming.unchanged)) {
    for (const name of names) {
      if (incoming.unchanged.indexOf(name) < 0) continue;
      if (prev.poll && prev.poll[name]) poll[name] = prev.poll[name];
      else {
        // Cannot happen with a server that follows the hashes; if it does, ask for everything next time.
        return reducePollError(Object.assign({}, prev, { hash: {} }), "section absente", now);
      }
    }
  }
  delete poll.unchanged;
  const hash: any = {};
  if (incoming.hash && typeof incoming.hash === "object") {
    for (const name of names) {
      const h = incoming.hash[name];
      if (typeof h === "string" && /^[0-9a-f]{1,16}$/.test(h)) hash[name] = h;
    }
  }
  let notInStream = prev.notInStream;
  if (Array.isArray(incoming.not_in_stream)) {
    notInStream = incoming.not_in_stream
      .filter((x: any) => typeof x === "string")
      .map((x: string) => x.slice(0, 40))
      .slice(0, 40);
  }
  if (notInStream && !poll.not_in_stream) poll.not_in_stream = notInStream;
  const next: any = Object.assign({}, prev, {
    hash,
    notInStream,
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
  const outOfSession =
    !!poll.connection &&
    (poll.connection.state === "disconnected" ||
      poll.connection.state === "menu" ||
      poll.connection.state === "closed");
  if (poll.state === "live" && age !== null && age <= cfg.staleAfterMs && !outOfSession) {
    const values = seriesValues(poll);
    for (const key of seriesKeys) {
      // A switched-off ship reports zeros that are not measurements: nothing is added to its curves.
      const shipKey = ["speed", "altitude", "vspeed", "g", "hydrogen", "boost"].indexOf(key) >= 0;
      if (typeof values[key] === "number" && !(shipKey && shipIsOff(poll))) {
        const keep =
          key === "hunger" || key === "thirst"
            ? cfg.trendWindowMs
            : key === "hydrogen"
              ? 120000
              : cfg.sparkKeepMs;
        series[key] = pushSample(series[key], now, values[key], keep);
      }
    }
  }
  next.series = series;
  // Per-vehicle references: the highest countermeasure count seen, and the dials' scales (speeds in quantum mode
  // are left out: they would flatten every other reading).
  const key = poll.ship && typeof poll.ship.name === "string" ? poll.ship.name : "";
  const peaks: any = key && key === prev.shipKey ? Object.assign({}, prev.peaks) : {};
  const cms = poll.weapons && poll.weapons.countermeasures;
  if (cms && typeof cms === "object") {
    for (const kind of Object.keys(cms)) {
      if (typeof cms[kind] === "number") peaks[kind] = Math.max(peaks[kind] || 0, cms[kind]);
    }
  }
  next.peaks = peaks;
  next.shipKey = key || prev.shipKey;
  const scales: any = Object.assign({ speed: 0, vspeed: 0 }, prev.scales);
  const ins = poll.ship && poll.ship.instruments;
  const quantum = !!(poll.derived && (poll.derived.in_quantum_mode || poll.derived.in_jump));
  if (ins && poll.state === "live" && !quantum) {
    if (typeof ins.speed_ms === "number") scales.speed = Math.max(scales.speed, ins.speed_ms);
    if (typeof ins.vertical_speed_ms === "number") {
      scales.vspeed = Math.max(scales.vspeed, Math.abs(ins.vertical_speed_ms));
    }
  }
  next.scales = scales;
  return next;
}

/** What to ask the server for: what this View does not hold yet, so the answer carries only what changed. */
export function pollArguments(
  view: any,
  showBalance: boolean,
  choice?: string | null,
  token?: string,
): any {
  const args: any = {};
  // The View states its choice every time (true or false): it never leaves it to the server's default.
  args.include_balance = !!showBalance;
  // A click of the player on the balance toggle, until the server has it. An ordinary poll never carries one.
  if (choice === "hidden" || choice === "shown") args.balance_choice = choice;
  // Lifting the mask needs the token of the served page (hiding never does).
  if (choice === "shown" && token) args.balance_token = token;
  if (!Array.isArray(view.notInStream)) args.include_static = true;
  if (view.lastSeq > 0) args.since_seq = view.lastSeq;
  const have: any = {};
  let any = false;
  const hashes = view.hash || {};
  for (const name of ["ship", "pilot", "weapons", "specs", "ledger"]) {
    if (view.poll && view.poll[name] && typeof hashes[name] === "string") {
      have[name] = hashes[name];
      any = true;
    }
  }
  if (any) args.have = have;
  return args;
}

/** A readable ceiling for a dial from the largest value seen: 1, 1.5, 2, 3, 5 or 7.5 times a power of ten, never below `min`. */
export function niceScale(seen: number, min: number): number {
  const target = Math.max(min, Number.isFinite(seen) ? seen * 1.1 : 0);
  const steps = [1, 1.5, 2, 3, 5, 7.5];
  let power = Math.pow(10, Math.floor(Math.log(target) / Math.LN10));
  for (let guard = 0; guard < 40; guard++) {
    for (const s of steps) if (s * power >= target) return s * power;
    power *= 10;
  }
  return target;
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
  // Another View is the leader: it polls for everybody, this one only shows what the leader shares.
  if (s.follower && !s.hidden && !s.offscreen) {
    return { run: false, delayMs: 0, reason: "follower", retire: false };
  }
  if (s.hidden || s.offscreen) {
    const since = typeof s.awaySince === "number" ? s.awaySince : s.now;
    return {
      run: false,
      delayMs: 0,
      reason: s.hidden ? "hidden" : "offscreen",
      retire: s.now - since >= (s.noChannel ? cfg.noChannelRetireMs : cfg.retireAfterMs),
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

/**
 * A shop as the journal gives it is a class name ("SCShop_Cargo_Tressler"): its words without the generic prefixes
 * ("Tressler"). "" when nothing but prefixes remains. A name that is not a class name (no underscore) is kept as it is.
 */
export function shopWords(token: unknown): string {
  if (typeof token !== "string") return "";
  if (token.indexOf("_") < 0) return token;
  const generic = ["scshop", "shop", "cargo", "commodity"];
  return token
    .split("_")
    .filter((w: string) => w !== "" && generic.indexOf(w.toLowerCase()) < 0)
    .join(" ");
}

export function levelFor(fraction: number, low: number, critical: number): string {
  if (!Number.isFinite(fraction)) return "none";
  if (fraction <= critical) return "bad";
  if (fraction <= low) return "warn";
  return "ok";
}

/**
 * Health 0 is "down or dead": the stream cannot tell which. An absent gauge is not zero. The dial is red under 30 % (as
 * the server's `health_low` alert, which fires under 30 %) and amber under 50 % (a choice, not a measure): at 35 % just
 * after a fight it must not read green. The zones of the dial's marks (viewApp.ts) and the bands sent to the model
 * (contextSummary: low under 30 %, mid under 50 %) follow the same two limits.
 */
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
    level: fraction < 0.3 ? "bad" : fraction < 0.5 ? "warn" : "ok",
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
    const titles: any = {
      thr: "Poussée",
      shld: "Boucliers",
      prox: "Proximité (collision)",
      hit: "Impacts subis",
      radr: "Radar : verrouillage hostile",
      qdrv: "Moteur quantique",
      wpn: "Armes",
      pwr: "Alimentation",
      cool: "Refroidissement",
      misl: "Missiles",
    };
    return {
      key,
      label: d[1],
      title: titles[key] || d[1],
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
  const titles: any = {
    powerplants: "Centrale (alimente tout le reste)",
    engines: "Moteurs",
    weapons: "Armes",
    coolers: "Refroidissement",
    life_support: "Support vie",
    gravity_generators: "Générateurs de gravité",
    sensors: "Capteurs",
    shield_generators: "Générateurs de boucliers",
    shield_emitters: "Émetteurs de boucliers",
  };
  return defs.map((d) => ({
    key: d[0],
    label: d[1],
    title: titles[d[0] as string] || d[1],
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

/** How long ago a reading was taken, for the account reminder: "il y a 15 h". Null when the time is not usable. */
export function accountAgo(ms: number | null | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  // A reading "in the future" (the two clocks differ a little) is as good as a fresh one.
  const age = ms < 0 ? 0 : ms;
  // Rounded, not cut: 15 h 59 is "16 h", not "15 h".
  if (age < 60000) return "il y a moins d’1\u00a0min";
  const minutes = Math.round(age / 60000);
  if (minutes < 60) return "il y a " + minutes + "\u00a0min";
  const hours = Math.round(age / 3600000);
  if (hours < 48) return "il y a " + hours + "\u00a0h";
  return "il y a " + Math.round(age / 86400000) + "\u00a0j";
}

/**
 * What the permanent "Solde" reminder of the header says. It is the account balance, whatever the session is (the poll's
 * `account`, built by the server only for an answer that asked for the balance). Nothing is invented: a reading that is not
 * live says so with its age, and no reading says why. While the player hides the balance there is no amount and no
 * `account` is read at all.
 *   kind  hidden | follower | wait | live | last_known | unknown (the screen reader is told when it changes, never at each poll)
 */
export function accountInfo(poll: any, showBalance: boolean, now: number, follower?: boolean): any {
  // A View that follows another one never gets the balance (it is not shared): that is not the player hiding it.
  if (!showBalance && follower) {
    return {
      kind: "follower",
      text: "••••••",
      note: "suivi par un autre tableau",
      tip: "Un autre tableau de bord lit le jeu : celui-ci ne reçoit pas le solde. Le bouton reprend la main.",
      speak: "",
    };
  }
  if (!showBalance) {
    return { kind: "hidden", text: "••••••", note: "masqué", tip: "", speak: "Solde masqué" };
  }
  if (!poll) return { kind: "wait", text: "—", note: "", tip: "", speak: "" };
  // A server that sends no `account` (an older one) still gives the live reading as `balance` while the stream is live.
  const a =
    poll.account ||
    (poll.balance && poll.state === "live" ? { source: "live", uec: poll.balance.uec } : null);
  // The balance was just shown again and the answer in hand was asked without it: wait for the next one, say nothing yet.
  if (!a && poll.state !== "off") return { kind: "wait", text: "—", note: "", tip: "", speak: "" };
  const usable =
    a &&
    typeof a === "object" &&
    (typeof a.uec === "number"
      ? Number.isFinite(a.uec)
      : typeof a.uec === "string" && /^-?\d{1,20}$/.test(a.uec));
  // The game's channel (live or PTU) could not be read from Game.log: the figure is shown, but a PTU one could not be told apart.
  const unverified = usable && a.channel_unverified === true;
  const unverifiedTip =
    " Le canal du jeu (live ou PTU) n’a pas pu être lu dans Game.log : un solde du PTU ne se distinguerait pas.";
  if (usable && a.source === "live") {
    return {
      kind: "live",
      text: fmtAuec(a.uec) + "\u00a0aUEC",
      note: unverified ? "canal non vérifié" : "",
      tip: "Relevé en direct du jeu." + (unverified ? unverifiedTip : ""),
      speak: "Solde en direct",
    };
  }
  if (usable && a.source === "last_known") {
    const at = typeof a.at === "string" ? Date.parse(a.at) : NaN;
    const ago = accountAgo(Number.isFinite(at) ? now - at : null);
    return {
      kind: "last_known",
      text: fmtAuec(a.uec) + "\u00a0aUEC",
      note:
        "dernier solde connu" +
        (ago ? " · " + ago : "") +
        (unverified ? " · canal non vérifié" : ""),
      tip:
        (a.from === "session"
          ? "Dernier solde enregistré avec une session de jeu : le jeu ne le donne pas en ce moment."
          : "Dernier relevé du flux du jeu, gardé en mémoire : le jeu ne le donne plus.") +
        (unverified ? unverifiedTip : ""),
      speak: "Solde : dernier solde connu",
    };
  }
  // No reading: the poll's own state tells telemetry off; the server tells a closed game or a game that gave no balance.
  let why = "aucun relevé pour l’instant";
  if (poll.state === "off") why = "télémétrie non activée";
  else if (a && a.reason === "game_closed") why = "jeu fermé";
  else if (a && a.reason === "ptu") why = "jeu lancé sur le PTU : autre économie";
  return {
    kind: "unknown",
    text: "Solde inconnu",
    note: why,
    tip:
      poll.state === "off"
        ? "La télémétrie du jeu est coupée sur le serveur (SC_TELEMETRY) : aucun solde n’est lu."
        : "Aucun solde n’a été relevé, ni en direct ni dans une session enregistrée.",
    speak: "Solde inconnu : " + why,
  };
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
  for (const k of [
    "commodity",
    "buy_terminal",
    "sell_terminal",
    "note",
    "safety_note",
    "price_points_label",
    "preamble",
  ]) {
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
  for (const k of ["buy_unit_price", "sell_unit_price", "est_trip_minutes"]) {
    const v = input[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1e9) out[k] = Math.round(v);
  }
  if (Array.isArray(input.price_points)) {
    const pts: number[] = [];
    for (const v of input.price_points) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9) {
        pts.push(Math.round(v * 100) / 100);
      }
    }
    const kept = pts.slice(-30);
    if (kept.length >= 2) {
      out.price_points = kept;
      if (input.price_points_for === "buy" || input.price_points_for === "sell")
        out.price_points_for = input.price_points_for;
    }
  }
  if (!out.price_points) delete out.price_points_label;
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------------------------
// What goes to the conversation
// ---------------------------------------------------------------------------------------------

/** Fixed French texts for ui/message. Only a ship identifier that passed isSafeId, and for "route" the balance. */
export function actionMessage(kind: string, ctx: any): string | null {
  const ship = ctx && isSafeId(ctx.vehicle) ? String(ctx.vehicle) : "";
  // The fixed messages that ask Claude to read tools (analyse, bilan and the contextual ones below). FIXED words and tool names
  // only: no number, no ship, nothing read from the log or the game, no name, never the balance, and no tool of the dashboard
  // itself. The player's choice is read at CLICK time (`ctx.showBalance`): hidden, every tool call says include_balance false and
  // the message says not to include the balance; shown, include_balance is not named at all (the server applies the player's
  // choice, which is how the dashboard itself shows its amounts). Shown, the message says NOTHING about the balance: Claude
  // should have all the information it needs. Without the flag the safe side is taken: hidden.
  const shown = !!ctx && ctx.showBalance === true;
  const both = shown ? "" : ", tous deux avec include_balance false";
  const tail = shown ? "" : " N’inclus pas mon solde.";
  if (kind === "analyse") {
    return (
      "Analyse ma situation dans le jeu à partir de la télémétrie en direct : appelle sc_live_state (sections ship, pilot et weapons) et sc_live_events" +
      both +
      ", dis l’âge des données et ce que le flux ne contient pas, puis ce qui demande mon attention." +
      (shown ? "" : " Ne lis pas mon solde.")
    );
  }
  if (kind === "bilan") {
    return (
      "Fais le bilan de ma session à partir de la télémétrie en direct : appelle sc_live_events et sc_live_state" +
      both +
      ", résume décollages, atterrissages, sauts, alertes et combats en distinguant les événements confirmed et unverified." +
      tail
    );
  }
  // The contextual "Ask Claude" button (tradePreflight.ts tradeAskInfo picks the kind). A tool that is not offered: Claude says so.
  if (kind === "loss") {
    return (
      "Analyse la perte de mon vaisseau : appelle sc_session_current puis sc_trade_journal" +
      both +
      ", et dis ce qu’ils établissent (vaisseau détruit avec moi à bord, cargo acheté et non vendu, seulement présumé perdu) et ce qu’ils ne disent pas (valeur perdue, suite donnée à l’assurance, coût de remplacement, responsable). Regarde aussi sc_log_context : il ne donne que le nombre de demandes d’assurance de la session, sans lien établi avec cette perte, dis-le tel quel. N’invente rien. Si un de ces outils manque, dis-le." +
      tail
    );
  }
  if (kind === "refusal") {
    return (
      "Que faire maintenant ? Un prix a changé au kiosque pendant ma transaction. Appelle sc_trade_journal" +
      (shown ? "" : " avec include_balance false") +
      " pour voir ce qui a été refusé et où j’en suis du trajet, puis relis les prix avec uex_get_price_history et uex_get_market_status pour cette marchandise en disant leur âge (prix collaboratifs). Pour uex_get_price_history, utilise le terminal de vente nommé par le journal ou par moi, sinon demande-le-moi. Propose un seul prochain pas concret, sans inventer de chiffre. Si un outil manque, dis-le." +
      tail
    );
  }
  if (kind === "debrief") {
    return (
      "Fais le debrief de mon dernier trajet : appelle sc_trade_journal puis sc_session_current" +
      both +
      ", regarde le prix de vente actuel avec uex_get_price_history (utilise le terminal de vente nommé par le journal ou par moi, sinon demande-le-moi), et dis ce qui a bien marché, ce que je changerais et la prochaine route. Distingue ce qui est mesuré de ce qui est estimé, et dis explicitement ce qui diffère entre ce que le journal établit et ce que tu trouves toi-même chez UEX (prix, quantités, frais) et pourquoi, avant de donner ton verdict. Si un outil manque, dis-le." +
      tail
    );
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
export function contextSummary(poll: any, events: any[], balanceHidden?: boolean): any {
  if (!poll || poll.state !== "live") return null;
  const mode = modeInfo(poll);
  const vehicle = poll.ship && isSafeId(poll.ship.name) ? shipTitle(poll.ship) : "";
  const h = healthInfo(poll.pilot);
  let band = "none";
  if (h.known) band = h.zero ? "zero" : h.fraction < 0.3 ? "low" : h.fraction < 0.5 ? "mid" : "ok";
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
      (balanceHidden
        ? ". Pour des valeurs à jour, appelle sc_live_state avec include_balance false (le joueur a masqué son solde)."
        : ". Pour des valeurs à jour, appelle sc_live_state."),
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

// ---------------------------------------------------------------------------------------------
// Several Views in one conversation: one of them polls (the leader), the others follow
// ---------------------------------------------------------------------------------------------

/** A short random identifier for this View. `random` is a number in [0, 1) given by the caller. */
export function makeViewId(now: number, random: number): string {
  const a = Math.floor(Math.abs(random) * 1e9).toString(36);
  const b = Math.floor(Math.abs(now)).toString(36);
  return ("v" + a + b + "00000000").slice(0, 16).toLowerCase();
}

/**
 * Who polls? Among the Views that are visible and have been heard recently (self included when visible), the one
 * with the highest rank, then the highest id when ranks are equal. The rank is the creation time of the View, or the
 * time of the last "take over here" click: the most recent View wins, and the others stop calling the server.
 * A View that is hidden or off screen is never a candidate, so it never polls and never blocks another one; when the
 * leader disappears (closed, hidden, or silent for peerTtlMs) the next one in line takes over.
 *   self  = { id, rank, visible }
 *   peers = { [id]: { id, rank, visible, seenAt } }
 */
export function electLeader(self: any, peers: any, now: number): any {
  const cfg = viewConfig();
  let best: any = self.visible ? { id: self.id, rank: self.rank } : null;
  for (const key of Object.keys(peers || {})) {
    const p = peers[key];
    if (!p || p.id === self.id || !p.visible) continue;
    if (!(now - p.seenAt <= cfg.peerTtlMs)) continue;
    if (!best || p.rank > best.rank || (p.rank === best.rank && p.id > best.id)) {
      best = { id: p.id, rank: p.rank };
    }
  }
  return { leaderId: best ? best.id : null, isLeader: !!best && best.id === self.id };
}

/** Peers after one message: updated or added (hello, claim, snapshot), or removed (bye). Pure; bounded. */
export function notePeer(peers: any, msg: any, now: number): any {
  const cfg = viewConfig();
  const next: any = {};
  for (const key of Object.keys(peers || {})) {
    const p = peers[key];
    if (p && now - p.seenAt <= cfg.peerTtlMs * 5) next[key] = p;
  }
  if (msg.t === "bye") {
    delete next[msg.id];
    return next;
  }
  next[msg.id] = { id: msg.id, rank: msg.rank, visible: msg.visible, seenAt: now };
  const ids = Object.keys(next);
  if (ids.length > cfg.maxPeers) {
    ids.sort((a, b) => next[a].seenAt - next[b].seenAt);
    for (let i = 0; i < ids.length - cfg.maxPeers; i++) delete next[ids[i] as string];
  }
  return next;
}

/** The rank that wins over every peer known now ("take over here"). */
export function claimRank(peers: any, now: number): number {
  let top = now;
  for (const key of Object.keys(peers || {})) {
    const p = peers[key];
    if (p && typeof p.rank === "number" && p.rank >= top) top = p.rank + 1;
  }
  return top;
}

/** The answer as it may be shared with the other Views: no balance, and no wallet event (their text has amounts). */
export function sharablePoll(poll: any): any {
  if (!poll || typeof poll !== "object") return null;
  const out: any = Object.assign({}, poll);
  delete out.balance;
  // The account reminder is an aUEC figure too: it never travels between Views (each one polls for its own).
  delete out.account;
  delete out.hash;
  delete out.unchanged;
  out.events = (Array.isArray(poll.events) ? poll.events : []).filter(
    (e: any) => e && e.type !== "uec_changed" && e.group !== "wallet",
  );
  return out;
}

/**
 * A message from the channel, checked. Anything on the channel is data from another page of the same origin, not
 * a trusted peer: types, ranges and lengths are verified, and the answer in a snapshot is rebuilt field by field
 * (cleanPoll). Returns null for anything that does not fit.
 */
export function parseChannelMessage(data: any, now: number): any {
  const cfg = viewConfig();
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const t = data.t;
  if (t !== "hello" && t !== "bye" && t !== "claim" && t !== "snapshot") return null;
  if (typeof data.id !== "string" || !/^[a-z0-9]{8,32}$/.test(data.id)) return null;
  if (typeof data.rank !== "number" || !Number.isFinite(data.rank)) return null;
  if (data.rank < 0 || data.rank > now + cfg.maxRankSkewMs) return null;
  const out: any = { t, id: data.id, rank: data.rank, visible: true };
  if (t === "hello" || t === "claim") {
    if (typeof data.visible !== "boolean") return null;
    out.visible = data.visible;
  }
  if (t === "snapshot") {
    const poll = cleanPoll(data.poll);
    if (!poll) return null;
    out.poll = poll;
  }
  return out;
}

/**
 * Rebuilds an answer of the server from untrusted data: only known fields, right types, capped lengths and counts.
 * Nothing is copied wholesale, so a hostile object cannot bring an unexpected field or a huge string into the page.
 * The balance is never accepted. Returns null when the object is not an answer at all.
 */
export function cleanPoll(raw: any): any {
  const obj = (x: any): any => (x && typeof x === "object" && !Array.isArray(x) ? x : null);
  const num = (x: any): number | undefined =>
    typeof x === "number" && Number.isFinite(x) ? x : undefined;
  const text = (x: any, max: number): string | undefined =>
    typeof x === "string" ? x.slice(0, max) : undefined;
  const bool = (x: any): boolean | undefined => (typeof x === "boolean" ? x : undefined);
  const word = (x: any): string | undefined =>
    typeof x === "string" && /^[a-z0-9_]{1,40}$/.test(x) ? x : undefined;
  const gameId = (x: any): string | undefined =>
    typeof x === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(x) ? x : undefined;
  const keysOf = (o: any, max: number): string[] => {
    const keys: string[] = [];
    for (const k in o) {
      if (keys.length >= max) break;
      if (Object.prototype.hasOwnProperty.call(o, k) && /^[a-z0-9_]{1,40}$/.test(k)) keys.push(k);
    }
    return keys;
  };
  const list = (x: any, max: number): any[] => (Array.isArray(x) ? x.slice(0, max) : []);
  const set = (o: any, k: string, v: any) => {
    if (v !== undefined) o[k] = v;
  };
  const scalar = (x: any): any => {
    if (typeof x === "number") return Number.isFinite(x) ? x : undefined;
    if (typeof x === "boolean") return x;
    if (typeof x === "string") return x.slice(0, 80);
    return undefined;
  };
  const scalarMap = (x: any, max: number, depth: number): any => {
    const source = obj(x);
    if (!source) return undefined;
    const out: any = {};
    for (const k of keysOf(source, max)) {
      const v =
        depth > 0 && obj(source[k]) ? scalarMap(source[k], 8, depth - 1) : scalar(source[k]);
      set(out, k, v);
    }
    return out;
  };
  const gauge = (x: any): any => {
    const g = obj(x);
    if (!g) return undefined;
    const out: any = {};
    set(out, "current", num(g.current));
    set(out, "max", num(g.max));
    set(out, "percent", num(g.percent));
    return out;
  };

  const p = obj(raw);
  if (!p || p.v !== 1) return null;
  const states = ["off", "waiting", "game_without_telemetry", "connected", "live", "incompatible"];
  if (states.indexOf(p.state) < 0) return null;
  const out: any = { v: 1, state: p.state };
  set(out, "at", num(p.at));
  set(out, "enabled", bool(p.enabled));
  set(out, "cause", text(p.cause, 400));
  out.frame_age_ms = num(p.frame_age_ms) === undefined ? null : p.frame_age_ms;
  out.received_at = typeof p.received_at === "string" ? p.received_at.slice(0, 40) : null;
  set(out, "last_seq", num(p.last_seq));

  // Where the player stands towards the servers (from Game.log): a known state, a UTC time, a numeric code and a short
  // reason in a fixed charset. Anything else is dropped.
  const conn = obj(p.connection);
  if (conn && ["unknown", "menu", "online", "disconnected", "closed"].indexOf(conn.state) >= 0) {
    const c: any = { state: conn.state };
    c.since =
      typeof conn.since === "string" && /^\d{4}-\d\d-\d\dT[\d:.]{1,16}Z$/.test(conn.since)
        ? conn.since
        : null;
    c.code =
      typeof conn.code === "number" &&
      Number.isInteger(conn.code) &&
      conn.code >= 0 &&
      conn.code < 1e7
        ? conn.code
        : null;
    c.reason =
      typeof conn.reason === "string" && /^[A-Za-z0-9 ._:\-/()]{1,80}$/.test(conn.reason)
        ? conn.reason
        : null;
    out.connection = c;
  }

  const ship = obj(p.ship);
  out.ship = null;
  if (ship) {
    const s: any = {};
    set(s, "name", gameId(ship.name));
    set(s, "instance_id", gameId(ship.instance_id));
    set(s, "class_name", gameId(ship.class_name));
    set(s, "manufacturer_derived", text(ship.manufacturer_derived, 40));
    set(s, "type", word(ship.type));
    set(s, "lights_on", bool(ship.lights_on));
    set(s, "landed", bool(ship.landed));
    set(s, "gear", word(ship.gear));
    set(s, "vtol", word(ship.vtol));
    const ins = obj(ship.instruments);
    if (ins) {
      const i: any = {};
      for (const k of [
        "speed_ms",
        "vertical_speed_ms",
        "hydrogen_fuel",
        "atmospheric_density",
        "altitude_m",
        "radar_altitude_m",
        "heading_deg",
      ]) {
        set(i, k, num(ins[k]));
      }
      const boost = obj(ins.boost);
      if (boost) {
        const b: any = {};
        set(b, "engaged", bool(boost.engaged));
        set(b, "output", num(boost.output));
        set(b, "reserves", num(boost.reserves));
        set(b, "critical", bool(boost.critical));
        i.boost = b;
      }
      const g = obj(ins.g);
      if (g) i.g = { current: num(g.current), max: num(g.max) };
      s.instruments = i;
    }
    const modes = obj(ship.flight_modes);
    if (modes) {
      s.flight_modes = {};
      for (const k of keysOf(modes, 16)) {
        const m = obj(modes[k]);
        if (m) s.flight_modes[k] = { enabled: bool(m.enabled), active: bool(m.active) };
      }
    }
    const power = obj(ship.power);
    if (power) {
      s.power = {};
      for (const k of keysOf(power, 16)) set(s.power, k, bool(power[k]));
    }
    const lights = obj(ship.warning_lights);
    if (lights) {
      s.warning_lights = {};
      for (const k of keysOf(lights, 16)) set(s.warning_lights, k, word(lights[k]));
    }
    out.ship = s;
  }

  const pilot = obj(p.pilot);
  out.pilot = null;
  if (pilot) {
    const q: any = {};
    set(q, "locomotion", word(pilot.locomotion));
    set(q, "crew_role", word(pilot.crew_role));
    set(q, "seat", pilot.seat === "" ? "" : gameId(pilot.seat));
    for (const k of ["health", "hunger", "thirst"]) set(q, k, gauge(pilot[k]));
    for (const k of ["heart_rate_bpm", "gravity_g", "pressure", "outside_temperature_c"]) {
      set(q, k, num(pilot[k]));
    }
    set(q, "breathable_atmosphere", bool(pilot.breathable_atmosphere));
    out.pilot = q;
  }

  const weapons = obj(p.weapons);
  out.weapons = null;
  if (weapons) {
    const w: any = { weapons: [], countermeasures: {} };
    for (const item of list(weapons.weapons, 64)) {
      const it = obj(item);
      if (!it) continue;
      const entry: any = {};
      set(entry, "name", gameId(it.name));
      set(entry, "instance_id", gameId(it.instance_id));
      set(entry, "powered", bool(it.powered));
      set(entry, "ready", bool(it.ready));
      w.weapons.push(entry);
    }
    set(w, "gimbals_locked", bool(weapons.gimbals_locked));
    const cms = obj(weapons.countermeasures);
    if (cms) for (const k of keysOf(cms, 8)) set(w.countermeasures, k, num(cms[k]));
    out.weapons = w;
  }

  const derived = obj(p.derived);
  out.derived = null;
  if (derived) {
    out.derived = {};
    for (const k of keysOf(derived, 16)) {
      const v = derived[k];
      if (typeof v === "boolean") out.derived[k] = v;
      else if (typeof v === "string") out.derived[k] = v.slice(0, 40);
    }
  }

  out.conditions = [];
  for (const item of list(p.conditions, 24)) {
    const c = obj(item);
    if (!c || !word(c.id)) continue;
    if (c.level !== "info" && c.level !== "warning" && c.level !== "critical") continue;
    const entry: any = { id: c.id, level: c.level };
    entry.confidence = c.confidence === "unverified" ? "unverified" : "confirmed";
    set(entry, "since", num(c.since));
    const data = scalarMap(c.data, 4, 0);
    if (data) entry.data = data;
    out.conditions.push(entry);
  }

  out.unverified = {};
  const unverified = obj(p.unverified);
  if (unverified) {
    for (const side of ["ship", "pilot", "weapons"]) {
      const m = scalarMap(unverified[side], 12, 1);
      if (m && Object.keys(m).length > 0) out.unverified[side] = m;
    }
  }

  out.not_available = [];
  for (const item of list(p.not_available, 12)) {
    const v = text(item, 40);
    if (v !== undefined) out.not_available.push(v);
  }
  if (Array.isArray(p.not_in_stream)) {
    out.not_in_stream = [];
    for (const item of list(p.not_in_stream, 40)) {
      const v = text(item, 40);
      if (v !== undefined) out.not_in_stream.push(v);
    }
  }

  out.events = [];
  for (const item of list(p.events, 60)) {
    const e = obj(item);
    if (!e || num(e.seq) === undefined || !word(e.type)) continue;
    if (e.type === "uec_changed" || e.group === "wallet") continue;
    const entry: any = { seq: e.seq, type: e.type };
    set(entry, "group", word(e.group));
    entry.confidence = e.confidence === "unverified" ? "unverified" : "confirmed";
    set(entry, "at", text(e.at, 40));
    set(entry, "text", text(e.text, 200));
    entry.data = scalarMap(e.data, 4, 0) || {};
    out.events.push(entry);
  }

  const session = obj(p.session);
  if (session) {
    const s: any = {};
    s.started_at = typeof session.started_at === "string" ? session.started_at.slice(0, 40) : null;
    s.ended_at = typeof session.ended_at === "string" ? session.ended_at.slice(0, 40) : null;
    for (const k of ["takeoffs", "landings", "jumps", "flight_ms"]) set(s, k, num(session[k]));
    s.flight_ms_is_estimate = true;
    s.markers = [];
    for (const item of list(session.markers, 40)) {
      const m = obj(item);
      if (!m || (m.kind !== "start" && m.kind !== "end" && m.kind !== "reset_delta")) continue;
      const at = text(m.at, 40);
      if (at !== undefined) s.markers.push({ kind: m.kind, at });
    }
    out.session = s;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Display information for the cockpit: everything the page shows, computed here (pure, tested)
// ---------------------------------------------------------------------------------------------

/** A speed with its unit: m/s up to 9 999, then km/s, then Mm/s (quantum travel is several million m/s). */
export function formatSpeed(ms: number): any {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return { value: "—", unit: "" };
  const a = Math.abs(ms);
  if (a < 10000) return { value: fmtNum(ms, 0), unit: "m/s" };
  if (a < 1000000) return { value: fmtNum(ms / 1000, a < 100000 ? 1 : 0), unit: "km/s" };
  return { value: fmtNum(ms / 1000000, a < 100000000 ? 1 : 0), unit: "Mm/s" };
}

/** Eight winds, French letters (O for Ouest). */
export function cardinal(deg: number): string {
  if (typeof deg !== "number" || !Number.isFinite(deg)) return "";
  const names = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  const i = Math.round((((deg % 360) + 360) % 360) / 45) % 8;
  return names[i] as string;
}

/** Is the powerplant reported off right now (the server's debounced condition)? */
export function shipIsOff(poll: any): boolean {
  const list = poll && Array.isArray(poll.conditions) ? poll.conditions : [];
  for (const c of list) if (c && c.id === "powerplant_off") return true;
  return false;
}

/** Where the ship is, in words, for the banner at the top. */
export function shipContext(poll: any): any {
  const ship = poll && poll.ship;
  const derived = (poll && poll.derived) || {};
  const out: any = {
    has: !!ship,
    title: "",
    maker: "",
    state: { id: "none", label: "" },
    chips: [],
  };
  if (!ship) {
    const mode = modeInfo(poll);
    out.state = { id: mode.id, label: mode.id === "unknown" ? "" : mode.label };
    return out;
  }
  out.title = shipTitle(ship);
  out.maker = typeof ship.manufacturer_derived === "string" ? ship.manufacturer_derived : "";
  if (out.maker && out.title.indexOf(out.maker + " ") === 0) {
    out.title = out.title.slice(out.maker.length + 1);
  }
  let state: any;
  if (shipIsOff(poll)) state = { id: "off", label: "Vaisseau éteint" };
  else if (derived.in_jump) state = { id: "jump", label: "Saut quantique" };
  else if (derived.in_quantum_mode) state = { id: "quantum", label: "Mode quantique" };
  else if (ship.landed === true) state = { id: "landed", label: "Posé" };
  else if (ship.landed === false && derived.in_planet_frame) {
    state = { id: "planet", label: "En vol · près d’une planète" };
  } else if (ship.landed === false) state = { id: "space", label: "En vol · dans l’espace" };
  else state = { id: "ship", label: "À bord" };
  out.state = state;
  const gear: any = {
    retracted: "Train rentré",
    deploying: "Train en sortie",
    deployed: "Train sorti",
    retracting: "Train en rentrée",
  };
  if (ship.gear && gear[ship.gear]) out.chips.push({ id: "gear", label: gear[ship.gear] });
  const vtol: any = {
    retracted: "VTOL rentré",
    deploying: "VTOL en sortie",
    deployed: "VTOL sorti",
    retracting: "VTOL en rentrée",
  };
  if (ship.vtol && vtol[ship.vtol]) out.chips.push({ id: "vtol", label: vtol[ship.vtol] });
  if (typeof ship.lights_on === "boolean") {
    // The lights field is not in the list of verified data: the chip says so. The server reads it as a bool(), so false
    // means "off" and "not reported" alike: only true is a statement, false is said as an unread state.
    out.chips.push({
      id: "lights",
      label: ship.lights_on ? "Phares allumés" : "Phares : état non lu",
      on: ship.lights_on === true,
      unverified: true,
    });
  }
  return out;
}

/**
 * Does the ship loss (`refusal.loss`, from tradeAlertInfo) still lead the verdict? Only for viewConfig().lossLeadMs after it,
 * and never over a red condition (conditionItems) that began AFTER the loss: the live state matters more then. Without `now`
 * (or without the loss's time) it leads, as before.
 */
export function lossLeads(refusal: any, items: any[], now?: number): boolean {
  if (!refusal || refusal.loss !== true) return false;
  if (typeof now !== "number" || typeof refusal.atMs !== "number") return true;
  const since = now - refusal.atMs;
  if (since > viewConfig().lossLeadMs) return false;
  for (const i of items) {
    if (i && i.tone === "bad" && typeof i.ageMs === "number" && i.ageMs < since) return false;
  }
  return true;
}

/**
 * The first-glance verdict: "all is well", "watch this" or "alert", from the conditions, or null without data. `refusal`
 * (tradeRefusalInfo, optional) is a price refused at the kiosk: it is the most urgent thing and goes in even when the ship
 * is off (the player is at a terminal); it never turns the verdict red, and a real red condition (hostile lock, hull) still comes first.
 */
export function summaryInfo(poll: any, items: any[], refusal?: any, now?: number): any {
  if (!poll || poll.state !== "live") return null;
  // A ship just destroyed leaves no ship in the stream, and perhaps no pilot yet: the loss is still worth saying.
  if (!poll.ship && !poll.pilot && !(refusal && refusal.loss)) return null;
  // With the ship off, "powerplant off" is the situation, not an alert: it must not hide a refusal at the kiosk.
  const off = shipIsOff(poll);
  const list = off ? items.filter((i: any) => i.id !== "powerplant_off") : items;
  const bad = list.filter((i: any) => i.tone === "bad");
  const warn = list.filter((i: any) => i.tone === "warn");
  const total = bad.length + warn.length + (refusal ? 1 : 0);
  if (off && !refusal) {
    return { id: "off", tone: "neutral", label: "Vaisseau éteint", count: 0 };
  }
  const more = total - 1 > 0 ? " (+" + (total - 1) + ")" : "";
  // A ship lost with the player aboard is above every red condition ("fatal", the one tone nothing else uses), but only for
  // the first minutes and only while no red condition began after it (lossLeads); then the normal order applies and the
  // loss, still in the alert box, is an amber entry of the verdict.
  if (lossLeads(refusal, list, now))
    return {
      id: "loss",
      tone: "fatal",
      label: refusal.label + " · " + refusal.ago + more,
      title: refusal.at,
      count: total,
    };
  if (bad.length > 0)
    return { id: "alert", tone: "bad", label: "Alerte : " + bad[0].label + more, count: total };
  if (refusal)
    return {
      id: "watch",
      tone: "warn",
      label: refusal.label + " · " + refusal.ago + more,
      title: refusal.at,
      count: total,
    };
  if (warn.length > 0)
    return {
      id: "watch",
      tone: "warn",
      label: "À surveiller : " + warn[0].label + more,
      count: total,
    };
  return { id: "ok", tone: "ok", label: "Tout va bien", count: 0 };
}

/** Everything the dials and gauges of the ship show, with nothing invented: a missing value is "—". */
export function instrumentInfo(poll: any, view: any): any {
  const ship = poll && poll.ship;
  const ins = ship && ship.instruments;
  const derived = (poll && poll.derived) || {};
  const off = shipIsOff(poll);
  const quantum = !!(derived.in_quantum_mode || derived.in_jump);
  const scales = (view && view.scales) || { speed: 0, vspeed: 0 };
  const none = (extra?: any) =>
    Object.assign(
      { known: false, text: "—", unit: "", fraction: null, level: "none", sub: "" },
      extra,
    );
  const out: any = { off, quantum };

  // Speed: the scale is deduced from the speeds seen outside quantum mode, and says so.
  if (ins && typeof ins.speed_ms === "number" && !off) {
    const f = formatSpeed(ins.speed_ms);
    const scale = niceScale(scales.speed, 100);
    out.speed = {
      known: true,
      text: f.value,
      unit: f.unit,
      fraction: quantum ? 1 : Math.max(0, Math.min(1, Math.abs(ins.speed_ms) / scale)),
      peak: quantum || scales.speed <= 0 ? null : Math.min(1, scales.speed / scale),
      level: quantum ? "info" : "ok",
      sub: quantum
        ? "mode quantique"
        : "échelle 0–" + fmtNum(scale) + " m/s, déduite des vitesses vues",
    };
  } else out.speed = none({ sub: off ? "éteint" : "" });

  // G: current against the maximum the game reports.
  if (ins && ins.g && typeof ins.g.current === "number" && !off) {
    const max = typeof ins.g.max === "number" && ins.g.max > 0 ? ins.g.max : 0;
    const frac = max > 0 ? Math.max(0, Math.min(1, Math.abs(ins.g.current) / max)) : null;
    out.g = {
      known: true,
      text: fmtNum(ins.g.current, 1),
      unit: "G",
      fraction: frac,
      level: frac === null ? "none" : frac >= 0.9 ? "bad" : frac >= 0.7 ? "warn" : "ok",
      sub: max > 0 ? "max du jeu " + fmtNum(max, 0) + " G" : "",
    };
  } else out.g = none({ sub: off ? "éteint" : "" });

  // Vertical speed: a signed bar around zero, scale from the largest seen.
  if (ins && typeof ins.vertical_speed_ms === "number" && !off) {
    const scale = niceScale(scales.vspeed, 20);
    out.vspeed = {
      known: true,
      text: fmtNum(ins.vertical_speed_ms, 1),
      unit: "m/s",
      signed: Math.max(-1, Math.min(1, ins.vertical_speed_ms / scale)),
      sub: "échelle ±" + fmtNum(scale) + " m/s",
    };
  } else out.vspeed = { known: false, text: "—", unit: "", signed: 0, sub: "" };

  // Altitude and heading exist only inside a planet's frame.
  const alt = ins && typeof ins.altitude_m === "number" ? ins.altitude_m : null;
  out.altitude = {
    known: alt !== null && !off,
    text: alt !== null && !off ? formatDistance(alt) : "—",
    radar:
      alt !== null && !off && ins && typeof ins.radar_altitude_m === "number"
        ? "radar " + formatDistance(ins.radar_altitude_m)
        : "",
    sub: alt === null && ins && !off ? "hors du champ d’une planète" : off ? "éteint" : "",
  };
  const heading = ins && typeof ins.heading_deg === "number" ? ins.heading_deg : null;
  out.heading = {
    valid: heading !== null && !off,
    deg: heading === null ? 0 : ((heading % 360) + 360) % 360,
    text: heading !== null && !off ? fmtNum(heading, 0) + "°" : "—",
    cardinal: heading !== null && !off ? cardinal(heading) : "",
    sub:
      heading === null && ins && !off
        ? derived.in_jump
          ? "figé pendant le saut"
          : "seulement dans le champ d’une planète"
        : "",
  };
  out.density =
    ins && typeof ins.atmospheric_density === "number" && ins.atmospheric_density > 0 && !off
      ? fmtNum(ins.atmospheric_density, 2)
      : "";

  // Hydrogen and boost.
  const hyd = ins ? fractionInfo(ins.hydrogen_fuel, 0.25, 0.1) : fractionInfo(undefined, 0.25, 0.1);
  out.hydrogen = off ? none({ sub: "éteint" }) : hyd;
  const boost = ins && ins.boost;
  if (boost && !off) {
    const reserve = fractionInfo(boost.reserves, 0.25, 0.1);
    out.boost = {
      known: reserve.known,
      reserve,
      output: fractionInfo(boost.output, 2, 2),
      engaged: boost.engaged === true,
      critical: boost.critical === true,
      level: boost.critical === true ? "bad" : reserve.level,
    };
  } else
    out.boost = {
      known: false,
      reserve: none(),
      output: none(),
      engaged: false,
      critical: false,
      level: "none",
    };
  return out;
}

export function vitalsInfo(poll: any): any {
  const pilot = poll && poll.pilot;
  const heart = pilot && typeof pilot.heart_rate_bpm === "number" && pilot.heart_rate_bpm > 0;
  const loco: any = { on_foot: "à pied", eva: "EVA", seated: "assis" };
  const crew: any = { pilot: "pilote", gunner: "artilleur", crew: "équipage" };
  return {
    health: healthInfo(pilot),
    hunger: gaugeInfo(pilot && pilot.hunger, 0.25, 0.1),
    thirst: gaugeInfo(pilot && pilot.thirst, 0.25, 0.1),
    heart: heart ? fmtNum(pilot.heart_rate_bpm, 0) : "—",
    gravity: pilot && typeof pilot.gravity_g === "number" ? fmtNum(pilot.gravity_g, 2) : "—",
    // The unit of the pressure is not given by the game: only the number is shown.
    pressure:
      pilot && typeof pilot.pressure === "number" && pilot.pressure !== 0
        ? fmtNum(pilot.pressure, 1)
        : "—",
    temperature:
      pilot && typeof pilot.outside_temperature_c === "number"
        ? fmtNum(pilot.outside_temperature_c, 0)
        : "—",
    air:
      pilot && typeof pilot.breathable_atmosphere === "boolean"
        ? pilot.breathable_atmosphere
          ? "respirable"
          : "non respirable"
        : "—",
    locomotion: pilot && pilot.locomotion ? loco[pilot.locomotion] || "inconnu" : "—",
    crew: pilot && pilot.crew_role && crew[pilot.crew_role] ? crew[pilot.crew_role] : "—",
    seat:
      pilot && typeof pilot.seat === "string" && pilot.seat !== ""
        ? pilot.seat.replace(/_/g, " ").slice(0, 40)
        : "",
  };
}

/** Weapons of the seat in one sentence, and one row each: red is kept for critical conditions, not for "no power". */
export function weaponsInfo(weapons: any, off: boolean): any {
  const list = weapons && Array.isArray(weapons.weapons) ? weapons.weapons : [];
  let powered = 0;
  let ready = 0;
  const rows: any[] = [];
  for (const w of list) {
    if (!w || typeof w.name !== "string") continue;
    if (w.powered === true) powered++;
    if (w.ready === true) ready++;
    rows.push({
      name: w.name.replace(/_/g, " "),
      state: w.powered ? (w.ready ? "ready" : "powered") : "off",
      text: w.powered ? (w.ready ? "prête" : "sous tension") : "sans énergie",
    });
  }
  const total = rows.length;
  let summary: string;
  if (!weapons) summary = "Pas de trame d’armes : seulement à un poste d’armes.";
  else if (total === 0) summary = "Aucune arme dans la trame.";
  else if (off) summary = total + (total > 1 ? " armes" : " arme") + " · vaisseau éteint";
  else if (powered === 0)
    summary = total + (total > 1 ? " armes sans énergie" : " arme sans énergie");
  else
    summary =
      ready +
      " prête" +
      (ready > 1 ? "s" : "") +
      " sur " +
      total +
      (powered < total ? " · " + (total - powered) + " sans énergie" : "");
  return {
    total,
    powered,
    ready,
    rows,
    summary,
    gimbals:
      weapons && typeof weapons.gimbals_locked === "boolean"
        ? weapons.gimbals_locked
          ? "Cardans verrouillés"
          : "Cardans libres"
        : "",
  };
}

/** Countermeasures: the count, and the share of the highest count seen for this vehicle (not a maximum the game gives). */
export function cmInfo(weapons: any, peaks: any): any[] {
  const cm =
    weapons && weapons.countermeasures && typeof weapons.countermeasures === "object"
      ? weapons.countermeasures
      : {};
  const out: any[] = [];
  for (const kind of ["decoy", "noise"]) {
    const v = cm[kind];
    if (typeof v !== "number") {
      out.push({
        kind,
        label: countermeasureLabel(kind),
        known: false,
        text: "—",
        fraction: null,
        peak: 0,
      });
      continue;
    }
    const peak = Math.max(v, peaks && typeof peaks[kind] === "number" ? peaks[kind] : v);
    out.push({
      kind,
      label: countermeasureLabel(kind),
      known: true,
      text: fmtNum(v),
      peak,
      fraction: peak > 0 ? v / peak : null,
      level: peak > 0 ? levelFor(v / peak, 0.34, 0.01) : "none",
    });
  }
  return out;
}

/** One chronology: the events and the player's markers together, oldest first. `filter`: all, alerts or markers. */
export function chronology(events: any[], markers: any[], filter: string, limit: number): any[] {
  const alertTypes = [
    "shields_down",
    "locked_on",
    "under_fire",
    "proximity_warning",
    "engines_damaged",
    "engines_offline",
    "powerplant_offline",
    "weapons_unavailable",
    "boost_depleted",
    "hydrogen_low",
    "countermeasures_low",
    "countermeasures_empty",
    "health_low",
    "player_down",
    "oxygen_low",
    "not_breathable",
    "hunger_low",
    "thirst_low",
  ];
  const items: any[] = [];
  if (filter !== "markers") {
    for (const e of events || []) {
      if (!e || typeof e.type !== "string") continue;
      if (filter === "alerts" && alertTypes.indexOf(e.type) < 0) continue;
      items.push({
        at: e.at,
        label: eventLabel(e),
        kind: "event",
        verified: e.confidence === "confirmed",
        alert: alertTypes.indexOf(e.type) >= 0,
      });
    }
  }
  if (filter !== "alerts") {
    const marks: any = {
      start: "Début des compteurs",
      end: "Fin des compteurs",
      reset_delta: "Solde remis à zéro",
    };
    for (const m of markers || []) {
      if (m && marks[m.kind])
        items.push({
          at: m.at,
          label: marks[m.kind],
          kind: "marker",
          verified: true,
          alert: false,
        });
    }
  }
  items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return items.slice(-limit).reverse();
}

/** The unverified values as labelled lines, each marked as unverified by the page. */
export function unverifiedItems(poll: any): any[] {
  const out: any[] = [];
  const u = poll && poll.unverified;
  if (!u || typeof u !== "object") return out;
  const labels: any = {
    oxygen: "Oxygène",
    body_temperature: "Température corporelle",
    intoxication_level: "Niveau d’intoxication",
    ambient_radiation_rate: "Rayonnement ambiant",
    quantum_fuel: "Carburant quantique",
    lights_on: "Phares allumés",
    atmospheric_density: "Densité atmosphérique",
    gimbals_locked: "Cardans verrouillés",
    manufacturer: "Constructeur (champ du jeu)",
    transformation: "Transformation",
    flight_settings: "Réglages de vol",
    doors: "Portes",
    spacebreak_enables_boost: "Frein spatial active le boost",
    g_safe_disabled_by_boost: "G-safe coupé par le boost",
    open_state: "ouverture",
    lock_state: "verrou",
    current: "valeur",
    max: "max",
    percent: "part",
  };
  const show = (key: string, v: any): string => {
    if (typeof v === "boolean") return v ? "oui" : "non";
    if (typeof v === "number")
      return key === "percent" ? fmtNum(v * 100, 0) + "\u00a0%" : fmtNum(v, 2);
    if (typeof v === "string") return v.replace(/_/g, " ").slice(0, 40);
    return "";
  };
  for (const side of ["pilot", "ship", "weapons"]) {
    const m = u[side];
    if (!m || typeof m !== "object") continue;
    for (const key of Object.keys(m)) {
      const v = m[key];
      let text: string;
      if (v && typeof v === "object") {
        const parts: string[] = [];
        for (const k of Object.keys(v)) {
          const s = show(k, v[k]);
          if (s) parts.push((labels[k] || k.replace(/_/g, " ")) + " " + s);
        }
        text = parts.join(" · ");
      } else text = show(key, v);
      if (text)
        out.push({ key: side + "." + key, label: labels[key] || key.replace(/_/g, " "), text });
    }
  }
  return out;
}

/** What the stream does not contain, in French; ids the page does not know are shown as they come. */
export function missingItems(ids: any): string[] {
  const names: any = {
    position: "Position",
    camera_direction: "Direction de la caméra",
    shield_level: "Niveau des boucliers",
    hull_and_component_health: "Coque et composants",
    heat: "Chaleur",
    ammo: "Munitions",
    power_allocation: "Répartition de l’énergie",
    quantum_fuel: "Carburant quantique",
    doors: "Portes",
    weapon_presets: "Présélections d’armes",
    death_events: "Événements de mort",
    force_feedback: "Retour de force",
    missiles: "Missiles",
  };
  const list = Array.isArray(ids) && ids.length > 0 ? ids : Object.keys(names);
  const out: string[] = ["Cargaison"];
  for (const id of list) {
    if (typeof id !== "string") continue;
    out.push(names[id] || id.replace(/_/g, " ").slice(0, 40));
  }
  return out;
}

/** The pinned data, as short "label value" texts for the bar at the top. */
export function pinnedItems(poll: any, view: any, pins: any): any[] {
  const ins = instrumentInfo(poll, view);
  const v = vitalsInfo(poll);
  const defs: any[] = [
    ["speed", "Vitesse", ins.speed.known ? ins.speed.text + "\u00a0" + ins.speed.unit : "—"],
    ["g", "Force G", ins.g.known ? ins.g.text + "\u00a0G" : "—"],
    ["altitude", "Altitude", ins.altitude.text],
    ["vspeed", "Vit. verticale", ins.vspeed.known ? ins.vspeed.text + "\u00a0m/s" : "—"],
    ["hydrogen", "Hydrogène", ins.hydrogen.text],
    ["boost", "Boost", ins.boost.known ? ins.boost.reserve.text : "—"],
    ["health", "Santé", v.health.text],
    ["hunger", "Faim", v.hunger.text],
    ["thirst", "Soif", v.thirst.text],
    ["heart", "Rythme", v.heart === "—" ? "—" : v.heart + "\u00a0bpm"],
  ];
  const out: any[] = [];
  for (const d of defs) {
    if (pins && pins[d[0]]) out.push({ key: d[0], label: d[1], text: d[2] });
  }
  return out;
}

/**
 * The DOM helpers every panel uses, built once on a document: text only goes through textContent, and a text, an attribute or a
 * style variable is only written when it changed (the last value is remembered on the node). One copy for the whole page: the
 * panels take it with `const { el, add, setText } = L.domKit(doc)`.
 */
export function domKit(doc: any): any {
  const el = (tag: string, cls?: string, text?: string): any => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const add = (parent: any, ...kids: any[]): any => {
    for (const k of kids) if (k) parent.appendChild(k);
    return parent;
  };
  const setText = (n: any, text: string) => {
    if (n._t !== text) {
      n._t = text;
      n.textContent = text;
    }
  };
  const setAttr = (n: any, name: string, value: string) => {
    const key = "_a_" + name;
    if (n[key] !== value) {
      n[key] = value;
      n.setAttribute(name, value);
    }
  };
  const setVar = (n: any, name: string, value: string) => {
    const key = "_v_" + name;
    if (n[key] !== value) {
      n[key] = value;
      n.style.setProperty(name, value);
    }
  };
  const show = (n: any, on: boolean) => setAttr(n, "data-hidden", on ? "0" : "1");
  // A tip is the long reading of a short label. Its text sits in data-tip and the View's one bubble shows it (hover, tap,
  // focus; Escape closes). With `focus` the node is a button (Enter opens it), in the tab order only while it has text.
  const setTip = (n: any, text: string, focus?: boolean) => {
    setAttr(n, "data-tip", text || "");
    if (!focus) return;
    setAttr(n, "tabindex", text ? "0" : "-1");
    setAttr(n, "role", text ? "button" : "");
    if (text && n["_a_aria-expanded"] === undefined) setAttr(n, "aria-expanded", "false");
  };
  return { el, add, setText, setAttr, setVar, show, setTip };
}

/** The names the page needs, in the order they are serialised. */
export const VIEW_FUNCTIONS = [
  viewConfig,
  domKit,
  fmtNum,
  fmtAuec,
  formatAge,
  formatDuration,
  formatDistance,
  formatClock,
  isSafeId,
  shipTitle,
  frameAge,
  connectionInfo,
  streamInfo,
  initialViewState,
  seriesValues,
  pushSample,
  reducePoll,
  reducePollError,
  visibleEvents,
  pollingDecision,
  modeInfo,
  shopWords,
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
  trendEstimate,
  estimateText,
  sessionRate,
  baselineLabel,
  accountAgo,
  accountInfo,
  sparkPoints,
  cleanPlan,
  actionMessage,
  contextSummary,
  initialContextGate,
  contextDecision,
  safeStyleVariables,
  pollArguments,
  niceScale,
  formatSpeed,
  cardinal,
  shipIsOff,
  shipContext,
  summaryInfo,
  lossLeads,
  instrumentInfo,
  vitalsInfo,
  weaponsInfo,
  cmInfo,
  chronology,
  unverifiedItems,
  missingItems,
  pinnedItems,
  makeViewId,
  electLeader,
  notePeer,
  claimRank,
  sharablePoll,
  parseChannelMessage,
  cleanPoll,
];
