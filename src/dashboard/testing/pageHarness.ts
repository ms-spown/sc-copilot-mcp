/**
 * TEST SUPPORT (Node only): runs the ASSEMBLED View page, the exact script that ships, inside a vm with a tiny fake
 * DOM, a fake window with a virtual clock, and the fake host. No browser, no jsdom, no network.
 *
 * The fake DOM refuses innerHTML, outerHTML and insertAdjacentHTML: if the View ever builds markup from a string,
 * the test fails at once instead of passing by luck.
 */
import vm from "node:vm";
import { dashboardHtml } from "../page.js";
import { createFakeHost, type FakeHost } from "./fakeHost.js";
import { Scenario } from "./scenario.js";

export class FakeNode {
  /** Every change made to any node (text, attribute, style, class, child): the cost of a render. */
  static writes = 0;
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  private cls = "";
  get className(): string {
    return this.cls;
  }
  set className(value: string) {
    FakeNode.writes++;
    this.cls = value;
  }
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  style = {
    props: {} as Record<string, string>,
    setProperty(name: string, value: string) {
      FakeNode.writes++;
      this.props[name] = value;
    },
  };
  parentNode: FakeNode | null = null;
  scrollWidth = 360;
  scrollHeight = 240;
  private text = "";
  constructor(readonly tag: string) {}

  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    FakeNode.writes++;
    this.text = String(value);
    this.children = [];
  }
  get innerHTML(): string {
    throw new Error("innerHTML read: the View must not use it");
  }
  set innerHTML(_value: string) {
    throw new Error("innerHTML written: the View must only use textContent");
  }
  set outerHTML(_value: string) {
    throw new Error("outerHTML written");
  }
  insertAdjacentHTML(): void {
    throw new Error("insertAdjacentHTML used");
  }
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  appendChild(child: FakeNode): FakeNode {
    FakeNode.writes++;
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  setAttribute(name: string, value: string): void {
    FakeNode.writes++;
    this.attrs[name] = String(value);
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== fn);
  }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number } {
    return { left: 0, top: 0, right: 0, bottom: 0 };
  }
  /** The node that last received the focus (the keyboard tests read it). */
  static focused: FakeNode | null = null;
  focus(): void {
    FakeNode.focused = this;
  }
  click(): void {
    for (const fn of this.listeners["click"] ?? []) fn({ target: this });
  }
}

/** Everything under `root`, root included. */
export function walk(root: FakeNode, fn: (node: FakeNode) => void): void {
  fn(root);
  for (const c of root.children) walk(c, fn);
}

/** Is the node shown? (No ancestor carries data-hidden="1".) */
export function isShown(node: FakeNode): boolean {
  for (let n: FakeNode | null = node; n; n = n.parentNode) {
    if (n.attrs["data-hidden"] === "1") return false;
  }
  return true;
}

export function visibleText(root: FakeNode): string {
  const parts: string[] = [];
  const fullscreen = root.attrs["data-mode"] === "fullscreen";
  const visit = (n: FakeNode) => {
    if (n.attrs["data-hidden"] === "1") return;
    // The style sheet hides the full-screen cards in the compact view.
    if (n.className === "full" && !fullscreen) return;
    // ... and hides the compact view in full screen.
    if (n.className.split(" ").includes("inline") && fullscreen) return;
    // ... and the balance row, which the compact view alone shows.
    if (n.className.split(" ").includes("balance-row") && fullscreen) return;
    // ... and the toast near the header, which only the compact view has room for.
    if (n.className.split(" ").includes("toast-top") && fullscreen) return;
    if (n.children.length === 0) {
      if (n.textContent) parts.push(n.textContent);
      return;
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  return parts.join("\n");
}

export function findButton(root: FakeNode, label: string): FakeNode {
  let found: FakeNode | null = null;
  walk(root, (n) => {
    if (n.tag === "button" && n.textContent === label && !found) found = n;
  });
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

export function findAll(root: FakeNode, predicate: (n: FakeNode) => boolean): FakeNode[] {
  const out: FakeNode[] = [];
  walk(root, (n) => {
    if (predicate(n)) out.push(n);
  });
  return out;
}

type TimerEntry = { id: number; at: number; fn: () => void; every?: number };

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A virtual clock with its timers, shareable by several pages so that Views of one conversation see one time. */
export class VirtualClock {
  now: number;
  timers: TimerEntry[] = [];
  private nextTimer = 1;
  constructor(epoch: number) {
    this.now = epoch;
  }
  add(fn: () => void, ms: number, every?: number): number {
    const id = this.nextTimer++;
    this.timers.push({ id, at: this.now + ms, fn, ...(every ? { every } : {}) });
    return id;
  }
  clear(id: number): void {
    const i = this.timers.findIndex((t) => t.id === id);
    if (i >= 0) this.timers.splice(i, 1);
  }
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > target) break;
      this.now = Math.max(this.now, next.at);
      if (next.every) next.at += next.every;
      else this.timers.shift();
      next.fn();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

class FakeChannel {
  private listeners: ((event: { data: unknown }) => void)[] = [];
  closed = false;
  constructor(
    readonly bus: FakeBus,
    readonly name: string,
  ) {
    bus.channels.add(this);
  }
  postMessage(data: unknown): void {
    if (this.closed) throw new Error("postMessage on a closed channel");
    this.bus.log.push({ name: this.name, data });
    this.bus.deliver(this.name, data, this);
  }
  addEventListener(type: string, fn: (event: { data: unknown }) => void): void {
    if (type === "message") this.listeners.push(fn);
  }
  removeEventListener(type: string, fn: (event: { data: unknown }) => void): void {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  close(): void {
    this.closed = true;
    this.bus.channels.delete(this);
  }
  receive(data: unknown): void {
    for (const fn of this.listeners) fn({ data });
  }
}

/** A BroadcastChannel bus shared by the pages of one test: same name, other channels, asynchronous, cloned. */
export class FakeBus {
  channels = new Set<FakeChannel>();
  /** Everything ever posted, as the pages posted it. */
  log: { name: string; data: unknown }[] = [];
  get open(): number {
    return this.channels.size;
  }
  deliver(name: string, data: unknown, from: FakeChannel | null): void {
    const copy = JSON.stringify(data);
    for (const c of [...this.channels]) {
      if (c === from || c.name !== name) continue;
      queueMicrotask(() => {
        if (!c.closed) c.receive(JSON.parse(copy));
      });
    }
  }
  /** A message from some other page of the same origin that is not one of ours. */
  inject(name: string, data: unknown): void {
    this.deliver(name, data, null);
  }
  create(name: string): FakeChannel {
    return new FakeChannel(this, name);
  }
}

export interface PageWorld {
  host: FakeHost;
  scenario: Scenario;
  root: FakeNode;
  doc: {
    hidden: boolean;
    documentElement: FakeNode;
    body: FakeNode;
    dispatch: (type: string) => void;
  };
  /** Moves the virtual clock forward, running the View's timers and the promises they start. */
  advance: (ms: number) => Promise<void>;
  clock: { now: number };
  /** A message from the parent window (the host). */
  fromHost: (data: unknown) => void;
  /** A message from a window that is NOT the parent. */
  fromStranger: (data: unknown) => void;
  /** What the View posted to its parent, in order. */
  posted: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  setHidden: (hidden: boolean) => void;
  setIntersecting: (on: boolean) => void;
  pendingTimers: () => number;
  /** The node the View selected last (the copy fallback), or null. */
  selected: () => FakeNode | null;
  /** Listeners and observers still registered by the View (window, document, observers). */
  listenerCount: () => number;
  bus: FakeBus | null;
  /** The page is being hidden for good. */
  firePageHide: () => void;
}

export interface WorldOptions {
  theme?: "light" | "dark";
  modes?: string[];
  scenario?: Scenario;
  /** Skip the automatic ui/initialize answer (never needed today). */
  start?: number;
  /** Share a clock between several pages (Views of one conversation). */
  clock?: VirtualClock;
  /** The BroadcastChannel bus: omitted = a private one, null = the browser has no BroadcastChannel. */
  bus?: FakeBus | null;
  /** The host answers every poll in full (the behaviour before the delta answers), for measuring. */
  legacyFullPolls?: boolean;
  /** What the fake host answers to sc_trade_suggest (see fakeHost.ts). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  suggest?: (args: any) => unknown | Promise<unknown>;
  /**
   * The browser's storage: omitted = the window has none (like a sandbox that hides it), "throws" = reaching it throws
   * (an opaque origin), a Map = a working one that the test can read back.
   */
  storage?: "throws" | Map<string, string>;
  /** The clipboard: omitted = none, "refuses" = writeText rejects, an array = a working one that collects the texts. */
  clipboard?: "refuses" | string[];
  /** Files: omitted = the page cannot make one (no Blob), an array = it can, and every link clicked is collected here. */
  downloads?: { name: string; mime: string; text: string }[];
}

/**
 * The content of the first element `tag` of a page, found without a regular expression: the search runs on a
 * lower-case copy (so <SCRIPT> counts) and the slice on the original; the opening tag may carry attributes, and
 * the closing one may carry spaces.
 */
export function extractElement(html: string, tag: string): string | null {
  const lower = html.toLowerCase();
  const open = lower.indexOf("<" + tag);
  if (open < 0) return null;
  const openEnd = lower.indexOf(">", open);
  if (openEnd < 0) return null;
  const close = lower.indexOf("</" + tag, openEnd);
  if (close < 0) return null;
  return html.slice(openEnd + 1, close);
}

export async function startPage(options: WorldOptions = {}): Promise<PageWorld> {
  const scenario = options.scenario ?? new Scenario();
  const vclock = options.clock ?? new VirtualClock(scenario.epoch);
  const clock = vclock;
  const bus = options.bus === undefined ? new FakeBus() : options.bus;
  const posted: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const docListeners: Record<string, (() => void)[]> = {};
  const observers: { kind: string; cb: (entries: unknown[]) => void; live: boolean }[] = [];

  const parent = {
    postMessage(message: Record<string, unknown>) {
      posted.push(message);
      host.receive(message, clock.now);
    },
  };
  const stranger = {};
  const fireMessage = (data: unknown, source: unknown) => {
    for (const fn of listeners["message"] ?? []) fn({ source, data });
  };

  const win = {
    parent,
    addEventListener(type: string, fn: (event: unknown) => void) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: (event: unknown) => void) {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== fn);
    },
    setTimeout(fn: () => void, ms: number) {
      return vclock.add(fn, ms);
    },
    clearTimeout(id: number) {
      vclock.clear(id);
    },
    setInterval(fn: () => void, ms: number) {
      return vclock.add(fn, ms, ms);
    },
    clearInterval(id: number) {
      vclock.clear(id);
    },
    ...(bus
      ? {
          BroadcastChannel: class {
            constructor(name: string) {
              return bus!.create(name);
            }
          },
        }
      : {}),
    IntersectionObserver: class {
      private entry: (typeof observers)[number];
      constructor(cb: (entries: unknown[]) => void) {
        this.entry = { kind: "intersection", cb, live: true };
        observers.push(this.entry);
      }
      observe() {}
      disconnect() {
        this.entry.live = false;
      }
    },
    ResizeObserver: class {
      private entry: (typeof observers)[number];
      constructor(cb: (entries: unknown[]) => void) {
        this.entry = { kind: "resize", cb, live: true };
        observers.push(this.entry);
      }
      observe() {}
      disconnect() {
        this.entry.live = false;
      }
    },
  };

  // Optional browser features, each present only when the test asks for it.
  const store = options.storage;
  if (store === "throws") {
    Object.defineProperty(win, "localStorage", {
      get() {
        throw new Error("SecurityError: the storage is not available here");
      },
    });
  } else if (store) {
    Object.assign(win, {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
      },
    });
  }
  const clip = options.clipboard;
  if (clip) {
    Object.assign(win, {
      navigator: {
        clipboard: {
          writeText: (text: string) =>
            clip === "refuses"
              ? Promise.reject(new Error("NotAllowedError"))
              : (clip.push(text), Promise.resolve()),
        },
      },
    });
  }
  const files = options.downloads;
  const blobs = new Map<string, { parts: string; type: string }>();
  if (files) {
    Object.assign(win, {
      Blob: class {
        parts: string;
        type: string;
        constructor(parts: unknown[], init: { type?: string } = {}) {
          this.parts = parts.join("");
          this.type = init.type ?? "";
        }
      },
      URL: {
        createObjectURL: (b: { parts: string; type: string }) => {
          const url = "blob:fake/" + blobs.size;
          blobs.set(url, b);
          return url;
        },
        revokeObjectURL: (url: string) => void blobs.delete(url),
      },
    });
  }
  let selected: FakeNode | null = null;
  Object.assign(win, {
    getSelection: () => ({
      removeAllRanges() {},
      addRange: (r: { node: FakeNode }) => void (selected = r.node),
    }),
  });

  const root = new FakeNode("div");
  const body = new FakeNode("body");
  const doc = {
    hidden: false,
    createRange: () => ({
      node: null as FakeNode | null,
      selectNodeContents(n: FakeNode) {
        this.node = n;
      },
    }),
    documentElement: new FakeNode("html"),
    body,
    createElement: (tag: string) => {
      const node = new FakeNode(tag);
      if (tag === "a" && files) {
        node.click = () => {
          const b = blobs.get(node.attrs["href"] ?? "");
          files.push({
            name: node.attrs["download"] ?? "",
            mime: (b?.type ?? "").split(";")[0] ?? "",
            text: b?.parts ?? "",
          });
        };
      }
      return node;
    },
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    getElementById: (id: string) => (id === "app" ? root : null),
    addEventListener(type: string, fn: () => void) {
      (docListeners[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      docListeners[type] = (docListeners[type] ?? []).filter((l) => l !== fn);
    },
    dispatch(type: string) {
      for (const fn of docListeners[type] ?? []) fn();
    },
  };

  const host = createFakeHost({
    scenario,
    theme: options.theme,
    availableDisplayModes: options.modes,
    legacyFullPolls: options.legacyFullPolls,
    ...(options.suggest ? { suggest: options.suggest } : {}),
    deliver: (message) => fireMessage(message, parent),
  });

  class FakeDate extends Date {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock.now);
      else super(...(args as [number]));
    }
    static now() {
      return clock.now;
    }
  }

  const advance = (ms: number) => vclock.advance(ms);

  const html = dashboardHtml();
  const script = extractElement(html, "script");
  if (!script) throw new Error("no script in the page");
  vm.runInNewContext(
    script,
    { window: win, document: doc, Date: FakeDate, console },
    { timeout: 5000 },
  );
  await flush();

  return {
    host,
    scenario,
    root,
    doc,
    advance,
    clock,
    fromHost: (data) => fireMessage(data, parent),
    fromStranger: (data) => fireMessage(data, stranger),
    posted,
    setHidden(hidden) {
      doc.hidden = hidden;
      doc.dispatch("visibilitychange");
    },
    setIntersecting(on) {
      for (const o of observers.filter((x) => x.kind === "intersection" && x.live)) {
        o.cb([{ isIntersecting: on }]);
      }
    },
    pendingTimers: () => vclock.timers.length,
    selected: () => selected,
    firePageHide() {
      for (const fn of [...(listeners["pagehide"] ?? [])]) fn({});
    },
    listenerCount: () =>
      Object.values(listeners).reduce((n, l) => n + l.length, 0) +
      Object.values(docListeners).reduce((n, l) => n + l.length, 0) +
      observers.filter((o) => o.live).length,
    bus,
  };
}
