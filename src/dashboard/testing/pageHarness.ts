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
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  className = "";
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  style = {
    props: {} as Record<string, string>,
    setProperty(name: string, value: string) {
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
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = String(value);
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(fn);
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
}

export interface WorldOptions {
  theme?: "light" | "dark";
  modes?: string[];
  scenario?: Scenario;
  /** Skip the automatic ui/initialize answer (never needed today). */
  start?: number;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function startPage(options: WorldOptions = {}): Promise<PageWorld> {
  const scenario = options.scenario ?? new Scenario();
  const clock = { now: scenario.epoch };
  const timers: TimerEntry[] = [];
  let nextTimer = 1;
  const posted: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const docListeners: Record<string, (() => void)[]> = {};
  const observers: { kind: string; cb: (entries: unknown[]) => void }[] = [];

  const parent = {
    postMessage(message: unknown) {
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
    setTimeout(fn: () => void, ms: number) {
      const id = nextTimer++;
      timers.push({ id, at: clock.now + ms, fn });
      return id;
    },
    clearTimeout(id: number) {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    setInterval(fn: () => void, ms: number) {
      const id = nextTimer++;
      timers.push({ id, at: clock.now + ms, fn, every: ms });
      return id;
    },
    clearInterval(id: number) {
      win.clearTimeout(id);
    },
    IntersectionObserver: class {
      constructor(cb: (entries: unknown[]) => void) {
        observers.push({ kind: "intersection", cb });
      }
      observe() {}
    },
    ResizeObserver: class {
      constructor(cb: (entries: unknown[]) => void) {
        observers.push({ kind: "resize", cb });
      }
      observe() {}
    },
  };

  const root = new FakeNode("div");
  const body = new FakeNode("body");
  const doc = {
    hidden: false,
    documentElement: new FakeNode("html"),
    body,
    createElement: (tag: string) => new FakeNode(tag),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag),
    getElementById: (id: string) => (id === "app" ? root : null),
    addEventListener(type: string, fn: () => void) {
      (docListeners[type] ??= []).push(fn);
    },
    dispatch(type: string) {
      for (const fn of docListeners[type] ?? []) fn();
    },
  };

  const host = createFakeHost({
    scenario,
    theme: options.theme,
    availableDisplayModes: options.modes,
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

  const advance = async (ms: number) => {
    const target = clock.now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > target) break;
      clock.now = Math.max(clock.now, next.at);
      if (next.every) next.at += next.every;
      else timers.shift();
      next.fn();
      await flush();
    }
    clock.now = target;
    await flush();
  };

  const html = dashboardHtml();
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
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
      for (const o of observers.filter((x) => x.kind === "intersection")) {
        o.cb([{ isIntersecting: on }]);
      }
    },
    pendingTimers: () => timers.length,
  };
}
