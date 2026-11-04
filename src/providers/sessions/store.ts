import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  emptyState,
  MAX_FILE_BYTES,
  MAX_INTERRUPTIONS,
  MAX_SESSIONS,
  MAX_TRIPS,
  WRITE_SOFT_BYTES,
  SessionSchema,
  SESSIONS_VERSION,
  type Session,
  type StoreState,
} from "./types.js";

/**
 * The session file: ONE JSON document in the per-user data folder, shared by every server process of this user
 * (Claude Desktop can start two).
 *
 * Reliability rules, each one tested (store.test.ts, store.reliability.test.ts):
 *  - Every change is a read-modify-write UNDER A LOCK FILE on the freshest content (`transact`), so two processes
 *    never overwrite each other's work; the lock is taken with `wx`, carries its owner's token, is touched while it is
 *    held (a slow live holder is never robbed), is removed only by its owner, and a lock not touched for LOCK_STALE_MS
 *    is taken over.
 *  - A write goes to a temporary file in the same folder, is flushed to the disk, then renamed over the file
 *    (retried: Windows refuses a rename while another process reads the target). A kill or a power cut leaves the
 *    old file or the new one, never half of one.
 *  - A file that is empty, not JSON, too big or of another shape is SET ASIDE (`sessions.json.corrupt-<time>`, the
 *    three newest kept) and the server starts clean; a file with some invalid sessions keeps the valid ones and is
 *    copied to `.bak-<time>` before the next write. A file written by a NEWER version is never touched: sessions
 *    then live in memory only and the notice says so.
 *  - The size is bounded IN BYTES (WRITE_SOFT_BYTES: the oldest sessions go first), and by sessions, trips and
 *    interruptions; the read limit is far above it. Nothing here throws into the server: a failed write is reported in
 *    `notice`, the content stays in memory OVER the older file until a write succeeds, and the next change tries again.
 *  - The file is created with mode 0600 (owner only; on Windows the ACL of the user's profile folder applies).
 *  - Reading never creates the file or its folder.
 */

/** A lock not touched for this long belongs to a dead process. A live holder touches it every quarter of it. */
export const LOCK_STALE_MS = 5_000;
/** Longer than the stale delay: a lock left by a crash does not fail a change, it is taken over and the change goes on. */
export const LOCK_WAIT_MS = 8_000;
/** A temporary file this old is the leftover of a killed write. */
const ORPHAN_TMP_MS = 60_000;
/** The name `reclaim` gives a dead lock while it looks at it: `<lock>.stale-<pid>-<8 hex>`. */
const RECLAIMED_NAME = /\.stale-\d+-[0-9a-f]{8}$/;
const RENAME_RETRIES = 8;
const KEEP_CORRUPT = 3;

/** Updates of the file format: `MIGRATIONS[n]` turns a version n document into a version n+1 one. */
export const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> =
  {
    // Version 0 never shipped: it is the stub that proves the mechanism (sessions without a counter).
    0: (raw) => ({ ...raw, version: 1, revision: 0, saved_at: null, next_number: 1 }),
  };

export class StoreBusyError extends Error {}

export interface StoreOptions {
  now?: () => number;
  lockStaleMs?: number;
  lockWaitMs?: number;
  /** TESTS: how old a leftover temporary file must be to be swept. */
  orphanTmpMs?: number;
  /** TESTS: runs just before the rename, so a failure or a kill can be injected between write and rename. */
  beforeRename?: (tmp: string, target: string) => Promise<void> | void;
  /** TESTS: replaces fs.rename. */
  rename?: (from: string, to: string) => Promise<void>;
}

type Parsed =
  | { kind: "ok"; state: StoreState; dropped: number }
  | { kind: "newer"; version: number }
  | { kind: "invalid"; why: string };

/** Turns the text of the file into a state. Pure. Never throws. */
export function parseState(text: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "invalid", why: "not JSON" };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { kind: "invalid", why: "not an object" };
  let doc = raw as Record<string, unknown>;
  if (typeof doc.version !== "number" || !Number.isInteger(doc.version) || doc.version < 0)
    return { kind: "invalid", why: "no version" };
  if (doc.version > SESSIONS_VERSION) return { kind: "newer", version: doc.version };
  while ((doc.version as number) < SESSIONS_VERSION) {
    const step = MIGRATIONS[doc.version as number];
    if (!step) return { kind: "invalid", why: "unknown old version" };
    doc = step(doc);
  }
  if (!Array.isArray(doc.sessions)) return { kind: "invalid", why: "no sessions list" };
  const sessions: Session[] = [];
  const ids = new Set<string>();
  const numbers = new Set<number>();
  let dropped = 0;
  for (const item of doc.sessions) {
    const r = SessionSchema.safeParse(cutOversized(item));
    if (!r.success || ids.has(r.data.id) || numbers.has(r.data.number)) {
      dropped++;
      continue;
    }
    ids.add(r.data.id);
    numbers.add(r.data.number);
    sessions.push(r.data);
  }
  sessions.sort((a, b) => a.number - b.number);
  const maxNumber = sessions.reduce((m, s) => Math.max(m, s.number), 0);
  const next =
    typeof doc.next_number === "number" && Number.isInteger(doc.next_number) ? doc.next_number : 1;
  return {
    kind: "ok",
    dropped,
    state: {
      version: SESSIONS_VERSION,
      revision:
        typeof doc.revision === "number" && Number.isFinite(doc.revision) && doc.revision >= 0
          ? Math.floor(doc.revision)
          : 0,
      saved_at: typeof doc.saved_at === "string" ? doc.saved_at : null,
      next_number: Math.max(next, maxNumber + 1),
      dropped_sessions:
        typeof doc.dropped_sessions === "number" && doc.dropped_sessions >= 0
          ? Math.floor(doc.dropped_sessions)
          : 0,
      sessions,
    },
  };
}

/** A hand-edited or old session with too many trips/interruptions is cut to the bound, not dropped. */
function cutOversized(item: unknown): unknown {
  if (!item || typeof item !== "object") return item;
  const s = item as Record<string, unknown>;
  const out = { ...s };
  if (Array.isArray(s.trips) && s.trips.length > MAX_TRIPS) out.trips = s.trips.slice(-MAX_TRIPS);
  if (Array.isArray(s.interruptions) && s.interruptions.length > MAX_INTERRUPTIONS)
    out.interruptions = s.interruptions.slice(-MAX_INTERRUPTIONS);
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const code = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

export class SessionStore {
  /** One sentence about the file when something is not as expected (corrupt, newer version, cannot write). */
  notice: string | null = null;
  /** The file is from a newer version: it is never written; sessions live in memory. */
  readOnly = false;
  private cache: { state: StoreState; mtimeMs: number; size: number } | null = null;
  private memory: StoreState | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pendingBackup = false;
  private readonly now: () => number;
  /** For tests and diagnostics. */
  writes = 0;
  lockTakeovers = 0;

  constructor(
    readonly file: string,
    private readonly opts: StoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  // -------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------

  /**
   * The current content, cached while the file's size and date have not changed. Never throws, never writes and never
   * creates anything; an unreadable file reads as empty (the next change sets it aside).
   */
  async read(): Promise<StoreState> {
    if (this.readOnly && this.memory) return this.memory;
    let stat;
    try {
      stat = await fs.stat(this.file);
    } catch (e) {
      if (code(e) === "ENOENT") {
        this.cache = null;
        return this.memory ?? emptyState();
      }
      return this.cache?.state ?? this.memory ?? emptyState();
    }
    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size)
      return this.overlay(this.cache.state);
    const loaded = await this.loadFile(stat.size);
    if (loaded.kind === "ok") {
      this.cache = { state: loaded.state, mtimeMs: stat.mtimeMs, size: stat.size };
      return this.overlay(loaded.state);
    }
    return this.memory ?? this.cache?.state ?? emptyState();
  }

  /** After a failed write the unsaved content is newer than the file: it is what the process works on. */
  private overlay(fileState: StoreState): StoreState {
    if (this.memory && this.memory.revision > fileState.revision) return this.memory;
    this.memory = null;
    return fileState;
  }

  private async loadFile(
    size: number,
  ): Promise<Parsed | { kind: "unreadable"; code: string | undefined }> {
    if (size > MAX_FILE_BYTES) {
      this.notice = "The session file is larger than expected and was not read.";
      return { kind: "invalid", why: "too big" };
    }
    let text: string;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (e) {
      return { kind: "unreadable", code: code(e) };
    }
    const parsed = parseState(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (parsed.kind === "newer") {
      this.readOnly = true;
      this.notice = `The session file is from a newer version (${parsed.version}); this server reads version ${SESSIONS_VERSION}. It was not changed and sessions are kept in memory only until it is updated.`;
    } else if (parsed.kind === "invalid") {
      this.notice = "The session file is not valid and will be set aside at the next change.";
    } else {
      this.readOnly = false;
      if (parsed.dropped > 0) {
        this.pendingBackup = true;
        this.notice = `${parsed.dropped} invalid session(s) in the file were ignored; a copy of the file is kept before the next write.`;
      } else if (
        this.notice?.startsWith("The session file") ||
        this.notice?.startsWith("Sessions")
      ) {
        this.notice = null;
      }
    }
    return parsed;
  }

  // -------------------------------------------------------------------------------------------
  // Changing: lock, read fresh, apply, write atomically
  // -------------------------------------------------------------------------------------------

  /**
   * Applies `fn` to the freshest content under the lock and writes the result if `fn` says it changed something.
   * `fn` works on a copy. Calls of one process are queued; calls of two processes are serialised by the lock file.
   * Throws StoreBusyError when the lock stays taken (nothing is lost: the caller tries again).
   */
  transact<T>(
    fn: (draft: StoreState) => { changed: boolean; result: T },
  ): Promise<{ result: T; written: boolean }> {
    const run = this.queue.then(
      () => this.transactNow(fn),
      () => this.transactNow(fn),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async transactNow<T>(
    fn: (draft: StoreState) => { changed: boolean; result: T },
  ): Promise<{ result: T; written: boolean }> {
    if (this.readOnly) return this.applyInMemory(fn);
    const release = await this.lock();
    try {
      const base = await this.freshForWrite();
      if (this.readOnly) return this.applyInMemory(fn);
      const draft = structuredClone(base);
      const out = fn(draft);
      if (!out.changed) {
        this.cacheFrom(base);
        return { result: out.result, written: false };
      }
      draft.revision = base.revision + 1;
      draft.saved_at = new Date(this.now()).toISOString();
      this.trim(draft);
      const written = await this.write(draft);
      if (!written) this.memory = draft;
      return { result: out.result, written };
    } finally {
      await release();
    }
  }

  private applyInMemory<T>(fn: (d: StoreState) => { changed: boolean; result: T }) {
    const draft = structuredClone(this.memory ?? emptyState());
    const out = fn(draft);
    if (out.changed) {
      draft.revision += 1;
      this.trim(draft);
      this.memory = draft;
    }
    return { result: out.result, written: false };
  }

  private cacheFrom(state: StoreState): void {
    // Unsaved content (after a refused write) stays until a write succeeds: a change that changes nothing never
    // forgets it, and the state passed here is then not the file's, so it is not cached as the file's.
    if (this.memory) return;
    fs.stat(this.file).then(
      (s) => {
        this.cache = { state, mtimeMs: s.mtimeMs, size: s.size };
      },
      () => undefined,
    );
  }

  /** The file as it is now, ready to be changed: a bad file is set aside first. */
  private async freshForWrite(): Promise<StoreState> {
    let stat;
    try {
      stat = await fs.stat(this.file);
    } catch (e) {
      if (code(e) === "ENOENT") return this.memory ? structuredClone(this.memory) : emptyState();
      throw e;
    }
    const loaded = await this.loadFile(stat.size);
    if (loaded.kind === "ok")
      return this.memory && this.memory.revision > loaded.state.revision
        ? structuredClone(this.memory)
        : loaded.state;
    if (loaded.kind === "newer") return emptyState(); // readOnly is set: the caller switches to memory
    if (loaded.kind === "unreadable") throw new Error(`session file unreadable (${loaded.code})`);
    // Empty, not JSON, wrong shape or too big: set it aside, never delete it, start clean.
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    const aside = `${this.file}.corrupt-${stamp}`;
    try {
      await fs.rename(this.file, aside);
      this.notice = `The session file was not valid and was set aside (${path.basename(aside)}). Starting clean.`;
      await this.pruneAside(".corrupt-");
    } catch {
      this.notice = "The session file is not valid and could not be set aside.";
      throw new Error("session file invalid and cannot be set aside");
    }
    return this.memory ? structuredClone(this.memory) : emptyState();
  }

  private async pruneAside(marker: string): Promise<void> {
    try {
      const dir = path.dirname(this.file);
      const base = path.basename(this.file) + marker;
      const names = (await fs.readdir(dir)).filter((n) => n.startsWith(base)).sort();
      for (const n of names.slice(0, Math.max(0, names.length - KEEP_CORRUPT))) {
        await fs.rm(path.join(dir, n), { force: true });
      }
    } catch {
      /* housekeeping only */
    }
  }

  private trim(state: StoreState): void {
    for (const s of state.sessions) {
      if (s.trips.length > MAX_TRIPS) {
        s.trips_dropped += s.trips.length - MAX_TRIPS;
        s.trips = s.trips.slice(-MAX_TRIPS);
      }
      if (s.interruptions.length > MAX_INTERRUPTIONS)
        s.interruptions = s.interruptions.slice(-MAX_INTERRUPTIONS);
    }
    if (state.sessions.length > MAX_SESSIONS) {
      // The oldest go first; the newest one is never dropped.
      const extra = state.sessions.length - MAX_SESSIONS;
      state.sessions = state.sessions.slice(extra);
      state.dropped_sessions += extra;
    }
    // The bound that matters is in BYTES: the file must stay far below what the reader accepts.
    let total = JSON.stringify(state).length;
    while (total > WRITE_SOFT_BYTES && state.sessions.length > 1) {
      const oldest = state.sessions.shift() as Session;
      total -= JSON.stringify(oldest).length + 1;
      state.dropped_sessions += 1;
    }
  }

  private async write(state: StoreState): Promise<boolean> {
    const dir = path.dirname(this.file);
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await this.sweepOrphans();
      if (this.pendingBackup) {
        await fs
          .copyFile(
            this.file,
            `${this.file}.bak-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}`,
          )
          .catch(() => undefined);
        this.pendingBackup = false;
        await this.pruneAside(".bak-");
      }
      const handle = await fs.open(tmp, "w", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
        await handle.sync(); // on the disk before the rename: a power cut keeps the old file or the new one
      } finally {
        await handle.close();
      }
      await this.opts.beforeRename?.(tmp, this.file);
      await this.renameOver(tmp, this.file);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      this.notice = `Sessions could not be saved (${code(e) ?? "error"}); they are kept in memory and the next change tries again.`;
      return false;
    }
    this.writes += 1;
    this.memory = null;
    if (this.notice?.startsWith("Sessions could not be saved")) this.notice = null;
    try {
      const s = await fs.stat(this.file);
      this.cache = { state, mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      this.cache = null;
    }
    return true;
  }

  /**
   * Leftovers of killed writes (temporary files nobody will finish) and of killed lock takeovers (`.stale-<pid>-<hex>`
   * files) are removed once they are old.
   */
  private async sweepOrphans(): Promise<void> {
    try {
      const dir = path.dirname(this.file);
      const prefix = `${path.basename(this.file)}.`;
      for (const n of await fs.readdir(dir)) {
        const tmp = n.endsWith(".tmp");
        if (!n.startsWith(prefix) || !(tmp || RECLAIMED_NAME.test(n))) continue;
        const p = path.join(dir, n);
        const s = await fs.stat(p).catch(() => null);
        // A reclaimed lock keeps the age it had: one younger than the stale delay may still be put back by its taker.
        const limit = Math.max(
          this.opts.orphanTmpMs ?? ORPHAN_TMP_MS,
          tmp ? 0 : (this.opts.lockStaleMs ?? LOCK_STALE_MS),
        );
        if (s && Date.now() - s.mtimeMs > limit) {
          await fs.rm(p, { force: true });
        }
      }
    } catch {
      /* housekeeping only */
    }
  }

  private async renameOver(from: string, to: string): Promise<void> {
    const rename = this.opts.rename ?? fs.rename;
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(from, to);
        return;
      } catch (e) {
        // Windows: another process reading the target, or an antivirus scan, makes the rename fail for a moment.
        const transient = ["EPERM", "EBUSY", "EACCES"].includes(code(e) ?? "");
        if (!transient || attempt >= RENAME_RETRIES) throw e;
        await sleep(15 * (attempt + 1));
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // The lock file
  // -------------------------------------------------------------------------------------------

  /** How long ago the file was last touched, read through an OPEN handle (no check on a path); null when it is not there. */
  private async age(file: string): Promise<number | null> {
    let h;
    try {
      h = await fs.open(file, "r");
    } catch {
      return null;
    }
    try {
      return Date.now() - (await h.stat()).mtimeMs;
    } catch {
      return null;
    } finally {
      await h.close().catch(() => undefined);
    }
  }

  /**
   * Removes a DEAD lock-like file with no check-then-act on its path: it is renamed to a name only this call knows
   * (atomic, one winner), looked at through a handle, and deleted if it really was stale. If it was fresh after all (it
   * was replaced between the decision and the rename) it is put back with `link`, which never overwrites.
   */
  private async reclaim(file: string, staleMs: number): Promise<boolean> {
    const mine = `${file}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      await fs.rename(file, mine);
    } catch {
      return false; // someone else moved it first, or it is gone
    }
    const age = await this.age(mine);
    if (age !== null && age <= staleMs) await fs.link(mine, file).catch(() => undefined);
    await fs.rm(mine, { force: true }).catch(() => undefined);
    return age === null || age > staleMs;
  }

  /**
   * A lock whose owner died is taken over by ONE process at a time: a takeover file is created exclusively (a dead one is
   * reclaimed the same way), the lock's age is read through a handle, and only a stale lock is renamed away and deleted.
   * While the stale lock exists nobody can create a new one (`wx` fails), so nothing fresh is removed.
   */
  private async takeOver(lockFile: string, staleMs: number): Promise<void> {
    const gate = `${lockFile}.takeover`;
    try {
      const h = await fs.open(gate, "wx", 0o600);
      await h.close();
    } catch {
      const a = await this.age(gate);
      if (a !== null && a > staleMs) await this.reclaim(gate, staleMs);
      return;
    }
    try {
      const a = await this.age(lockFile);
      if (a !== null && a > staleMs && (await this.reclaim(lockFile, staleMs)))
        this.lockTakeovers += 1;
    } finally {
      await fs.rm(gate, { force: true }).catch(() => undefined);
    }
  }

  private async lock(): Promise<() => Promise<void>> {
    const lockFile = `${this.file}.lock`;
    const staleMs = this.opts.lockStaleMs ?? LOCK_STALE_MS;
    const waitMs = this.opts.lockWaitMs ?? LOCK_WAIT_MS;
    const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
    const started = Date.now();
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    for (;;) {
      try {
        const handle = await fs.open(lockFile, "wx", 0o600);
        await handle.writeFile(token).catch(() => undefined);
        await handle.close();
        // A live holder keeps the lock fresh, however slow its write is: it is never taken over.
        const beat = setInterval(
          () => {
            const t = new Date();
            void fs.utimes(lockFile, t, t).catch(() => undefined);
          },
          Math.max(20, Math.floor(staleMs / 4)),
        );
        beat.unref();
        return async () => {
          clearInterval(beat);
          // Only the owner removes it: a lock that was taken over meanwhile is not ours any more.
          const now = await fs.readFile(lockFile, "utf8").catch(() => null);
          if (now === token) await fs.rm(lockFile, { force: true }).catch(() => undefined);
        };
      } catch (e) {
        if (code(e) !== "EEXIST" && code(e) !== "EPERM" && code(e) !== "EACCES") throw e;
      }
      // A lock whose owner died (no touch for the stale delay) is taken over, by ONE process at a time: the takeover
      // file is created exclusively, the staleness is checked AGAIN under it (another process may have replaced the lock
      // since), the dead lock is removed, and the takeover file is released. Everyone then competes for the lock with `wx`.
      const lockAge = await this.age(lockFile);
      if (lockAge === null) continue; // it vanished meanwhile: try to take it
      if (lockAge > staleMs) {
        await this.takeOver(lockFile, staleMs);
        continue;
      }
      if (Date.now() - started > waitMs) throw new StoreBusyError("the session file is busy");
      await sleep(15 + Math.floor(Math.random() * 25));
    }
  }
}
