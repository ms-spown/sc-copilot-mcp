/**
 * TEST SUPPORT (also used by scripts/dashboard-preview.mjs): the `health` section of the poll for each situation that
 * matters, as the server's pure builder produces it (health.ts) from made-up facts. No path, no value of any setting.
 */
import { buildHealth, type HealthFacts, type HealthSection } from "../health.js";

export type HealthVariant =
  | "ok"
  | "nolog"
  | "unreadable"
  | "unregistered"
  | "sessionsoff"
  | "degraded"
  | "readonly"
  | "off"
  | "custom"
  | "everything";

const BASE: HealthFacts = {
  telemetryOn: true,
  state: "live",
  hint: null,
  log: { configured: true, via: "install_dir", label: "LIVE/Game.log" },
  logFollowed: true,
  sessionsOff: false,
  sessionStatus: "ok",
  savedAtMs: null,
};

/** The facts behind each variant (exported so that tests can tweak one). */
export function healthFacts(variant: HealthVariant, nowMs: number): HealthFacts {
  const saved = nowMs - 4 * 60_000;
  switch (variant) {
    case "ok":
      return { ...BASE, savedAtMs: saved };
    case "nolog":
      return { ...BASE, log: { configured: false, via: null, label: null }, logFollowed: false };
    case "unreadable":
      return { ...BASE, state: "waiting", logFollowed: false, savedAtMs: saved };
    case "unregistered":
      return {
        ...BASE,
        state: "game_without_telemetry",
        hint: { running: true, telemetryRegistered: false },
        savedAtMs: saved,
      };
    case "sessionsoff":
      return { ...BASE, sessionsOff: true, sessionStatus: null };
    case "degraded":
      return { ...BASE, sessionStatus: "degraded", savedAtMs: saved };
    case "readonly":
      return { ...BASE, sessionStatus: "readonly" };
    case "off":
      return {
        ...BASE,
        telemetryOn: false,
        state: "off",
        logFollowed: false,
        sessionStatus: null,
      };
    case "custom":
      return {
        ...BASE,
        log: { configured: true, via: "log_path", label: "custom" },
        savedAtMs: saved,
      };
    case "everything":
      return {
        ...BASE,
        state: "game_without_telemetry",
        hint: { running: true, telemetryRegistered: false },
        log: { configured: true, via: "install_dir", label: "LIVE/Game.log" },
        logFollowed: false,
        sessionStatus: "degraded",
      };
  }
}

export function healthSection(variant: HealthVariant, nowMs: number): HealthSection {
  return buildHealth(healthFacts(variant, nowMs));
}
