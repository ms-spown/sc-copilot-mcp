import axios from "axios";
import { fetchWithCache } from "../../core/cache.js";
import type { HttpClient } from "../../core/http.js";
import { positive } from "../fleet/compare.js";
import { resolveShip, type VehicleRow } from "../fleet/resolve.js";
import { isRow, label } from "./normalize.js";
import { validQuantumSpeed, validSpool } from "./travel.js";

/**
 * The few figures of a ship that the trade planner needs: cargo (UEX), quantum speed and spool-up
 * (Star Citizen Wiki). The wiki sheet is found the way `sc_fleet_get` does it: the ship is resolved
 * in UEX's vehicle list by words (several candidates are refused, never guessed), then the wiki is
 * asked for UEX's exact ship name.
 */

export interface ShipSheet {
  name: string | null;
  cargo_scu: number | null;
  quantum_speed_ms: number | null;
  spool_seconds: number | null;
  /** What could not be found, in words, for the answer. */
  missing: string[];
  wiki_version: string | null;
}

export class ShipLookupError extends Error {}

export async function fetchShipSheet(
  uexClient: HttpClient,
  scwClient: HttpClient,
  shipName: string,
): Promise<ShipSheet> {
  const list = (await fetchWithCache(uexClient, "/vehicles")).data?.data;
  const found = resolveShip(shipName, Array.isArray(list) ? (list as VehicleRow[]) : []);
  if (found.match === "not_found") {
    throw new ShipLookupError(`No ship matches "${label(shipName, 60)}" in UEX's vehicle list.`);
  }
  if (found.match === "ambiguous") {
    const names = found.candidates
      .map((c) => label(c.name_full ?? c.name, 60))
      .filter((n): n is string => n !== null)
      .join("; ");
    throw new ShipLookupError(
      `"${label(shipName, 60)}" fits several ships (${names}). Say which one.`,
    );
  }
  const v = found.vehicle;
  const sheet: ShipSheet = {
    name: label(v.name_full ?? v.name, 60),
    cargo_scu: positive(v.scu) ?? null,
    quantum_speed_ms: null,
    spool_seconds: null,
    missing: [],
    wiki_version: null,
  };
  try {
    const res = await fetchWithCache(scwClient, `/vehicles/${encodeURIComponent(v.name)}`);
    const record = isRow(res.data?.data) ? res.data.data : {};
    const quantum = isRow(record.quantum) ? record.quantum : {};
    sheet.quantum_speed_ms = validQuantumSpeed(positive(quantum.quantum_speed));
    sheet.spool_seconds = validSpool(positive(quantum.quantum_spool_time));
    sheet.wiki_version = label(record.version ?? record.game_version, 30);
    if (sheet.cargo_scu === null) sheet.cargo_scu = positive(record.cargo_capacity) ?? null;
    if (sheet.quantum_speed_ms === null) {
      sheet.missing.push("the wiki sheet gives no usable quantum speed for this ship");
    }
  } catch (error) {
    const gone = axios.isAxiosError(error) && error.response?.status === 404;
    sheet.missing.push(
      gone
        ? "the wiki has no page for this exact ship name, so no quantum speed"
        : "the wiki could not be read, so no quantum speed",
    );
  }
  if (sheet.cargo_scu === null)
    sheet.missing.push("no cargo capacity (SCU) is known for this ship");
  return sheet;
}
