/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The pure logic of the "ship sheet" part of the live dashboard View: which scale the speed gauge uses, what the
 * wiki sheet line says, and what to tell the player when there is no sheet. No DOM, no clock, no network.
 *
 * Kept apart from viewLogic.ts on purpose (it grows on its own). The page serialises these functions with
 * Function.prototype.toString exactly like the ones of viewLogic.ts (page.ts concatenates SPECS_VIEW_FUNCTIONS), so
 * the same three rules apply: only function declarations, no import, no module-level value. Functions of this file may
 * call each other; none calls a function of viewLogic.ts (in a test run the import would not resolve inside the page).
 * Every name starts with `specs` or `speed` so that it cannot collide with the other module.
 *
 * What the numbers are: the wiki's figures for the ship, not measurements of the game. A figure of 0 is "not
 * provided" and is never a limit. The hydrogen tank has no figure anywhere: the View keeps its straight-line estimate.
 */

/** "1 100": thousands grouped with a narrow no-break space. */
export function specsFmt(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
}

/** How old the copy of the sheet is, in words. */
export function specsAgeText(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return "il y a moins d’une minute";
  const m = Math.round(s / 60);
  if (m < 60) return "il y a " + m + " min";
  const h = Math.floor(m / 60);
  return h < 24 ? "il y a " + h + " h" : "il y a " + Math.floor(h / 24) + " j";
}

/** The highest speed seen in a series of [time, speed] samples (the observed scale), 0 when there is none. */
export function speedObservedMax(samples: any): number {
  let max = 0;
  const list = Array.isArray(samples) ? samples : [];
  for (const s of list) {
    if (Array.isArray(s) && typeof s[1] === "number" && Number.isFinite(s[1]) && s[1] > max) {
      max = s[1];
    }
  }
  return max;
}

/** A positive finite number or null (the sheet says 0 when it has no figure). */
function specsPositive(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** Why the gauge keeps the scale deduced from what was seen, without the lead-in ("" when there is nothing to say). */
export function specsScaleWhy(specs: any): string {
  if (!specs || typeof specs !== "object") return "";
  switch (specs.status) {
    case "pending":
      return "fiche du vaisseau en cours de recherche";
    case "unknown":
      return "fiche du vaisseau introuvable";
    case "ambiguous":
      return "plusieurs fiches possibles, aucune choisie";
    case "error":
      return "fiche du vaisseau indisponible (wiki injoignable)";
    case "ready":
      return "la fiche ne donne pas de vitesse";
    default:
      return "";
  }
}

/** The same, as a whole line: « échelle déduite : fiche du vaisseau introuvable ». */
export function specsScaleReason(specs: any): string {
  const why = specsScaleWhy(specs);
  return why ? "échelle déduite : " + why : "échelle déduite des relevés";
}

/**
 * The speed gauge. With a sheet that gives a speed: the scale runs from 0 to the maximum speed of the sheet (the SCM
 * speed when the sheet has no maximum), with a mark at the SCM speed, the value as a share of the SCM speed, and
 * what lies beyond the frame said instead of cut. Without one: the scale is the highest speed seen (`observedMax`)
 * and the line says why the sheet is not used.
 *
 * Returns { source, fraction, scmMark, maxMark, pctScm, over, sub, scale, scmMs, maxMs }:
 *   fraction  0..1 on the scale, null when there is no speed or no scale;
 *   scmMark   position of the SCM mark, 0..1, null when the sheet gives no SCM speed;
 *   maxMark   1 when the sheet gives a maximum speed and the mark is drawn at the end of the scale, else null;
 *   over      "none", "scm" (above the SCM speed, within the sheet), "max" (above the sheet's top speed), "quantum".
 */
export function speedGauge(specs: any, speed: any, observedMax: any, inQuantum: any): any {
  const v = typeof speed === "number" && Number.isFinite(speed) && speed >= 0 ? speed : null;
  const scm = specs && specs.status === "ready" ? specsPositive(specs.speed_scm_ms) : null;
  const max = specs && specs.status === "ready" ? specsPositive(specs.speed_max_ms) : null;
  const out: any = {
    source: "observed",
    fraction: null,
    scmMark: null,
    maxMark: null,
    pctScm: null,
    over: "none",
    sub: "",
    scale: "",
    scmMs: scm,
    maxMs: max,
  };
  if (scm === null && max === null) {
    const top = specsPositive(observedMax);
    out.fraction = v !== null && top !== null ? Math.min(1, v / top) : null;
    out.scale = specsScaleReason(specs);
    return out;
  }
  const top = Math.max(scm === null ? 0 : scm, max === null ? 0 : max);
  out.source = "sheet";
  out.fraction = v === null ? null : Math.min(1, v / top);
  out.scmMark = scm === null ? null : Math.min(1, scm / top);
  out.maxMark = max === null ? null : 1;
  const parts: string[] = [];
  if (scm !== null) parts.push("SCM " + specsFmt(scm));
  if (max !== null) parts.push("max " + specsFmt(max));
  out.scale = "marques " + parts.join(" · ") + "\u00a0m/s, d’après la fiche (wiki)";
  if (v === null) return out;
  if (scm !== null) out.pctScm = Math.round((v / scm) * 100);
  const base =
    scm !== null
      ? specsFmt(out.pctScm) + "\u00a0% de la vitesse SCM"
      : specsFmt(Math.round((v / top) * 100)) + "\u00a0% de la vitesse max";
  if (v > top) {
    if (inQuantum === true) {
      out.over = "quantum";
      out.sub = "hors cadre : saut quantique";
    } else {
      out.over = "max";
      out.sub = base + " · au-delà de la fiche";
    }
  } else if (scm !== null && v > scm) {
    out.over = "scm";
    out.sub = base + " · au-dessus du SCM";
  } else {
    out.sub = base;
  }
  return out;
}

function specsText(v: unknown): string {
  return typeof v === "string" ? v.slice(0, 60) : "";
}

/**
 * What to show about the sheet. { status, line, rows, note, candidates }:
 *   line  the lead line of the card (the wiki's name for the ship; the candidates when ambiguous), "" otherwise;
 *   rows  [label, value] pairs for the card, only for a sheet that was found;
 *   note  what the sheet is and is not (always says that the hydrogen tank is not known).
 */
export function specsInfo(specs: any, ageMs?: any): any {
  const hydrogen =
    "Capacité du réservoir d’hydrogène : non fournie par la fiche, l’autonomie en hydrogène reste une estimation par la pente.";
  const kind =
    "Chiffres du wiki communautaire, pas mesurés par le jeu : un vaisseau modifié, une variante ou un correctif peut différer.";
  const out: any = { status: "none", line: "", rows: [], note: hydrogen, candidates: [] };
  if (!specs || typeof specs !== "object") return out;
  out.status = typeof specs.status === "string" ? specs.status : "none";
  const name = specsText(specs.name);
  if (specs.status === "ready") {
    const cells: [string, unknown, string, string][] = [
      ["Vitesse SCM", specs.speed_scm_ms, "\u00a0m/s", "SCM"],
      ["Vitesse max", specs.speed_max_ms, "\u00a0m/s", "max"],
      ["Cargaison", specs.cargo_scu, "\u00a0SCU", "cargaison"],
      ["Boucliers", specs.shield_hp, "\u00a0PV", "boucliers"],
      ["Coque", specs.hull_hp, "\u00a0PV", "coque"],
    ];
    const short: string[] = [];
    for (const c of cells) {
      const n = specsPositive(c[1]);
      out.rows.push([c[0], n === null ? "non fournie" : specsFmt(n) + c[2]]);
      if (n !== null) short.push(c[3] + " " + specsFmt(n) + c[2]);
    }
    const age = specsAgeText(ageMs);
    const version = specsText(specs.version);
    const edited =
      typeof specs.updated_at === "string" && /^\d{4}-\d{2}-\d{2}/.test(specs.updated_at)
        ? specs.updated_at.slice(0, 10)
        : "";
    const when = [
      age
        ? "lue " +
          age +
          (specs.stale === true ? " (copie ancienne : le wiki ne répondait pas)" : "")
        : "",
      edited ? "fiche modifiée le " + edited : "",
      version ? "version " + version : "",
    ]
      .filter(Boolean)
      .join(" · ");
    out.rows.push(["Lecture", when || "date inconnue"]);
    // The card is titled "Fiche du vaisseau (wiki)": its first line is the name the wiki gives the ship.
    out.line = (name || "sans nom") + (short.length ? "" : " · aucun chiffre fourni");
    out.note = kind + " " + hydrogen;
  } else if (specs.status === "ambiguous") {
    const list = Array.isArray(specs.candidates)
      ? specs.candidates.slice(0, 8).map((c: unknown) => specsText(c))
      : [];
    out.candidates = list;
    out.line = "Plusieurs fiches possibles, aucune choisie : " + list.join(", ") + ".";
    out.note = kind + " " + hydrogen;
  } else {
    out.note = hydrogen;
  }
  return out;
}

/**
 * How old the copy of the sheet is when the View draws it, in ms, or null: the time since the server read it
 * (`fetched_at`), measured on the server's clock at the moment of the poll (`poll.at`), plus the time since that poll
 * arrived. Nothing here depends on the two clocks agreeing.
 */
export function specsAgeMs(poll: any, receivedAt: any, now: any): any {
  const specs = poll && poll.specs;
  if (!specs || typeof specs.fetched_at !== "string" || typeof poll.at !== "number") return null;
  const fetched = Date.parse(specs.fetched_at);
  if (!Number.isFinite(fetched)) return null;
  const since = typeof receivedAt === "number" && typeof now === "number" ? now - receivedAt : 0;
  return Math.max(0, poll.at - fetched) + Math.max(0, since);
}

/**
 * The speed dial of instrumentInfo (viewLogic.ts) against the ship's sheet. A sheet that gives a speed: the arc runs
 * from 0 to the sheet's top speed, marks at the SCM and top speeds, the value as a share of the SCM speed, what is
 * beyond the frame said (`over`), and the scale line reads « d'après la fiche (wiki) ». Anything else: the dial is
 * returned as it was, with the scale line saying why the sheet is not used.
 * Adds: marks { scm, max } (0..1 or null), over, sub (long) and subShort (for the small dial).
 */
export function speedWithSheet(speed: any, specs: any, speedMs: any, quantum: any): any {
  if (!speed || speed.known !== true) return speed;
  const g = speedGauge(specs, speedMs, 0, quantum === true);
  const out: any = Object.assign({}, speed);
  if (g.source !== "sheet") {
    const why = specsScaleWhy(specs);
    out.marks = null;
    out.over = "none";
    if (why && typeof out.sub === "string") {
      out.sub = out.sub.replace("déduite des vitesses vues", "déduite : " + why);
    }
    out.subShort = out.sub;
    return out;
  }
  out.fraction = g.fraction;
  out.peak = null;
  out.marks = { scm: g.scmMark, max: g.maxMark };
  out.over = g.over;
  out.level = g.over === "none" ? "ok" : "info";
  out.subShort = g.sub + (g.sub ? " · " : "") + "fiche (wiki)";
  out.sub = (g.sub ? g.sub + " · " : "") + g.scale;
  return out;
}

/**
 * Rebuilds the sheet from untrusted data (a snapshot from another page on the channel): only known fields, right
 * types, capped text. null when it is not a sheet.
 */
export function specsClean(raw: any): any {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const status = raw.status;
  if (
    status !== "pending" &&
    status !== "ready" &&
    status !== "unknown" &&
    status !== "ambiguous" &&
    status !== "error"
  ) {
    return null;
  }
  const out: any = { status, source: "star-citizen.wiki" };
  const text = (v: any, max: number): string | undefined =>
    typeof v === "string" ? v.slice(0, max) : undefined;
  const name = text(raw.name, 60);
  if (name !== undefined) out.name = name;
  const keys = ["speed_scm_ms", "speed_max_ms", "cargo_scu", "shield_hp", "hull_hp"];
  for (const k of keys) {
    if (typeof raw[k] === "number" && Number.isFinite(raw[k]) && raw[k] > 0) out[k] = raw[k];
  }
  const fetched = text(raw.fetched_at, 40);
  if (fetched !== undefined) out.fetched_at = fetched;
  const updated = text(raw.updated_at, 40);
  if (updated !== undefined) out.updated_at = updated;
  const version = text(raw.version, 30);
  if (version !== undefined) out.version = version;
  if (raw.stale === true) out.stale = true;
  if (Array.isArray(raw.candidates)) {
    out.candidates = raw.candidates
      .filter((c: any) => typeof c === "string")
      .slice(0, 8)
      .map((c: string) => c.slice(0, 60));
  }
  return out;
}

/** The names the page needs, in the order they are serialised (after those of viewLogic.ts). */
export const SPECS_VIEW_FUNCTIONS = [
  specsFmt,
  specsAgeText,
  speedObservedMax,
  specsPositive,
  specsScaleWhy,
  specsScaleReason,
  speedGauge,
  specsAgeMs,
  speedWithSheet,
  specsClean,
  specsText,
  specsInfo,
];
