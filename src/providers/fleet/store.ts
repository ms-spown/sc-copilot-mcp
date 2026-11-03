import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { userConfigDir } from "../../core/paths.js";

/**
 * The player's own fleet list, in a JSON file in the per-user config folder (never in the
 * repository). Written atomically (temp file, then rename) and versioned. It holds no price
 * and no account data: a ship is a name, where it came from, a note, and when it was added.
 * Nothing here talks to the network and nothing reads the RSI website; entries are typed in,
 * or imported by the user from a file they provide.
 */

export const FLEET_VERSION = 1;
const MAX_SHIPS = 300;

// Control characters have no business in a name or a note (they would reach a model's context).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
const text = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(CONTROL, "").trim())
    .pipe(z.string().max(max));

export const FleetShipInput = z.object({
  name: text(100).pipe(z.string().min(1, "name must not be empty")),
  origin: z.enum(["pledge", "in_game"]),
  notes: text(500).optional(),
});
export type FleetShipInput = z.infer<typeof FleetShipInput>;

const FleetShip = z.object({
  origin: z.enum(["pledge", "in_game"]),
  name: z.string().min(1),
  notes: z.string(),
  added_at: z.string(),
});
export type FleetShip = z.infer<typeof FleetShip>;

const FleetFile = z.object({ version: z.number(), ships: z.array(FleetShip) });

export class FleetError extends Error {}

export const fleetFilePath = (env: NodeJS.ProcessEnv = process.env) =>
  env.SCMCP_FLEET_FILE
    ? path.resolve(env.SCMCP_FLEET_FILE)
    : path.join(userConfigDir(env), "fleet.json");

const sameShip = (a: { name: string; origin: string }, b: { name: string; origin: string }) =>
  a.origin === b.origin && a.name.toLowerCase() === b.name.toLowerCase();

export class FleetStore {
  /** Writes are queued so two quick calls cannot overwrite each other. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly file: string,
    private now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<FleetShip[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new FleetError(
        `The fleet file cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}).`,
      );
    }
    let parsed: z.infer<typeof FleetFile>;
    try {
      parsed = FleetFile.parse(JSON.parse(raw));
    } catch {
      // Refuse rather than start from an empty list: the next write would erase the real one.
      throw new FleetError(
        "The fleet file exists but is not valid. It was not changed; fix or move it, then try again.",
      );
    }
    if (parsed.version !== FLEET_VERSION) {
      throw new FleetError(
        `The fleet file is version ${parsed.version}; this server reads version ${FLEET_VERSION}. It was not changed.`,
      );
    }
    return parsed.ships;
  }

  private async write(ships: FleetShip[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ version: FLEET_VERSION, ships }, null, 2)}\n`);
    await fs.rename(tmp, this.file);
  }

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Add a ship, or update the note of the same name and origin. added_at is kept on update. */
  async upsert(input: FleetShipInput): Promise<{ ship: FleetShip; created: boolean }> {
    // Inside the async function, so bad input rejects the promise like every other failure.
    const entry = FleetShipInput.parse(input);
    return this.serial(async () => {
      const ships = await this.list();
      const at = ships.findIndex((s) => sameShip(s, entry));
      if (at >= 0) {
        const updated = { ...ships[at], notes: entry.notes ?? ships[at].notes };
        ships[at] = updated;
        await this.write(ships);
        return { ship: updated, created: false };
      }
      if (ships.length >= MAX_SHIPS)
        throw new FleetError(`The fleet is limited to ${MAX_SHIPS} entries.`);
      const ship: FleetShip = {
        origin: entry.origin,
        name: entry.name,
        notes: entry.notes ?? "",
        added_at: this.now().toISOString(),
      };
      await this.write([...ships, ship]);
      return { ship, created: true };
    });
  }

  /** Remove by name. If the name exists under both origins, the origin must be given. */
  remove(name: string, origin?: "pledge" | "in_game"): Promise<FleetShip[]> {
    return this.serial(async () => {
      const ships = await this.list();
      const wanted = name.trim().toLowerCase();
      const matches = ships.filter(
        (s) => s.name.toLowerCase() === wanted && (!origin || s.origin === origin),
      );
      if (matches.length === 0)
        throw new FleetError(
          `No ship called "${name}"${origin ? ` (${origin})` : ""} in the fleet.`,
        );
      if (matches.length > 1) {
        throw new FleetError(
          `"${name}" is in the fleet as both pledge and in_game: say which one with origin.`,
        );
      }
      await this.write(ships.filter((s) => s !== matches[0]));
      return matches;
    });
  }
}
