/**
 * Pure output-shaping helpers, kept separate from the server entrypoint so they
 * can be unit tested. Importing index.ts would start a stdio server.
 */

export function isObject(data: unknown): data is Record<string, unknown> {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}

export function optimizeData(data: unknown): unknown {
  if (Array.isArray(data)) {
    return data.map(optimizeData);
  } else if (isObject(data)) {
    return Object.fromEntries(
      Object.entries(data)
        .filter(([k, v]) => {
          // Remove empty values to save context
          if (v === null || v === "" || v === 0) return false;
          // Filter out bulky historical/statistical data from UEX
          if (
            k.includes("_min") ||
            k.includes("_max") ||
            k.includes("_avg") ||
            k.includes("_week") ||
            k.includes("_month")
          )
            return false;
          if (k.startsWith("volatility_") || k.startsWith("id_")) return false;
          if (k === "date_added" || k === "date_modified") return false;
          return true;
        })
        .map(([k, v]) => [k, optimizeData(v)]),
    );
  }
  return data;
}

export const MAX_OUTPUT_CHARS = 40000;

/**
 * Serialise a payload, keeping it under the size cap *without* emitting
 * malformed JSON. Cutting a JSON string mid-token leaves callers unable to
 * parse anything at all, so oversized list payloads drop whole entries and say
 * how many were dropped.
 */
export function formatOutput(data: unknown, maxChars: number = MAX_OUTPUT_CHARS): string {
  const optimized = optimizeData(data);

  const pretty = JSON.stringify(optimized, null, 2);
  if (pretty.length <= maxChars) return pretty;

  const minified = JSON.stringify(optimized);
  if (minified.length <= maxChars) return minified;

  // Find the longest array in the payload and shrink it until it fits.
  const container = optimized as Record<string, unknown>;
  if (container && typeof container === "object") {
    let listKey: string | undefined;
    let longest = 0;
    for (const [k, v] of Object.entries(container)) {
      if (Array.isArray(v) && v.length > longest) {
        longest = v.length;
        listKey = k;
      }
    }

    if (listKey) {
      const full = container[listKey] as unknown[];
      for (let keep = Math.floor(full.length / 2); keep >= 1; keep = Math.floor(keep / 2)) {
        const candidate = {
          ...container,
          [listKey]: full.slice(0, keep),
          truncated: `showing ${keep} of ${full.length}; narrow the query or request fewer results`,
        };
        const text = JSON.stringify(candidate, null, 2);
        if (text.length <= maxChars) return text;
      }
    }
  }

  // A single oversized record: report the problem rather than returning broken JSON.
  return JSON.stringify(
    {
      error: "Result too large to return.",
      size_chars: minified.length,
      limit_chars: maxChars,
      hint: "Request a single record by name, or use a more specific filter.",
    },
    null,
    2,
  );
}

/** Preserve zeros/nulls that carry meaning (a diff summary of 0 is the answer). */
export function formatOutputRaw(data: unknown): string {
  const text = JSON.stringify(data, null, 2);
  return text.length <= MAX_OUTPUT_CHARS ? text : formatOutput(data);
}

/**
 * One record, in full when it fits the output budget, otherwise as its summary view with a
 * note saying so. Without this a large record (most ships: 200k characters against a 40k
 * budget) came back as a bare "Result too large" payload that was not even flagged as an error.
 */
export function formatRecord(
  record: unknown,
  project: (entry: Record<string, unknown>) => unknown,
): string {
  const size = JSON.stringify(optimizeData(record)).length;
  if (size <= MAX_OUTPUT_CHARS || !isObject(record)) return formatOutput(record);
  return formatOutput({
    summary: project(record),
    note: `The full record is ${size} characters, over the ${MAX_OUTPUT_CHARS} limit, so this is the summary view. Use scw_list_vehicles / scw_list_items filters or scw_get_ship_comparison for specific figures.`,
  });
}

/**
 * Wiki records embed multi-language prose and every hardpoint, so a single
 * vehicle can exceed the whole output budget. List views therefore return a
 * projection with enough to choose what to inspect; scw_get_vehicle /
 * scw_get_item return the full record for one thing.
 */
export function summarizeVehicle(v: Record<string, unknown>) {
  const manufacturer = v.manufacturer as Record<string, unknown> | undefined;
  const speed = v.speed as Record<string, unknown> | undefined;
  const crew = v.crew as Record<string, unknown> | undefined;
  return {
    name: v.name,
    manufacturer: manufacturer?.name,
    role: v.role,
    career: v.career,
    size: v.size,
    is_spaceship: v.is_spaceship,
    crew: crew ? { min: crew.min, max: crew.max } : undefined,
    cargo_capacity: v.cargo_capacity,
    health: v.health,
    shield_hp: v.shield_hp,
    speed_scm: speed?.scm,
    speed_max: speed?.max,
    msrp: v.msrp,
    max_medical_tier: v.max_medical_tier,
    slug: v.slug,
  };
}

export function summarizeItem(i: Record<string, unknown>) {
  const manufacturer = i.manufacturer as Record<string, unknown> | undefined;
  const weapon = i.vehicle_weapon as Record<string, unknown> | undefined;
  const shield = i.shield as Record<string, unknown> | undefined;
  return {
    name: i.name,
    type: i.type_label ?? i.type,
    classification: i.classification_label,
    size: i.size,
    grade: i.grade,
    class: i.class,
    manufacturer: manufacturer?.name,
    damage_per_shot: weapon?.damage_per_shot,
    rpm: weapon?.rpm,
    range: weapon?.range,
    shield_hp: shield?.hp,
    shield_regen: shield?.regeneration,
    slug: i.slug,
  };
}

/** Apply a projection to a wiki list response, preserving its pagination meta. */
export function summarizeList(
  payload: unknown,
  project: (entry: Record<string, unknown>) => unknown,
) {
  const body = payload as Record<string, unknown> | undefined;
  const rows = body?.data;
  if (!Array.isArray(rows)) return payload;

  const meta = body?.meta as Record<string, unknown> | undefined;
  return {
    data: rows.map((r) => project(r as Record<string, unknown>)),
    meta: meta
      ? {
          current_page: meta.current_page,
          last_page: meta.last_page,
          per_page: meta.per_page,
          total: meta.total,
        }
      : undefined,
    note: "Summary view. Use scw_get_vehicle or scw_get_item by name for the full record.",
  };
}
