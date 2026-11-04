/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * TEST SUPPORT (also used by scripts/dashboard-preview.mjs): a function that plays the MCP Apps host for the View.
 * It answers the `ui/*` requests the way Claude Desktop 4.4212.0 was measured to (see the spike), serves
 * `tools/call` from a Scenario, and records everything the View sent so a test can check it.
 *
 * It owns no transport: `deliver` carries a message from the host to the View, `receive` takes one from the View.
 * No browser, no DOM, no network, no Node-only module.
 */
import type { Scenario } from "./scenario.js";
import { suggestAnswer } from "./suggestFixtures.js";

export interface HostOptions {
  scenario: Scenario;
  /** Called with every message the host sends to the View. */
  deliver: (message: Record<string, unknown>) => void;
  theme?: "light" | "dark";
  /** Display modes the host offers. Claude Desktop 4.4212.0: inline and fullscreen. */
  availableDisplayModes?: string[];
  /** Answer every poll in full, as the server did before the delta answers (for measuring). */
  legacyFullPolls?: boolean;
  /** Style variables to hand out (a plausible set is used by default). */
  variables?: Record<string, string>;
  /**
   * What `sc_trade_suggest` answers (structuredContent, or an isError result). May be asynchronous: the host then
   * answers when it settles (to test a slow planner). Default: the invented answer of testing/suggestFixtures.ts.
   */
  suggest?: (args: any) => unknown | Promise<unknown>;
  /**
   * The hold sizes `sc_trade_suggest` {action:"holds"} lists (the `holds` array of its answer). Default: none known. Those
   * calls are logged apart (`holdsCalls`), so `suggests` stays the list of searches, applies and checks.
   */
  holds?: unknown[] | (() => unknown[] | Promise<unknown[]>);
  /** The server's balance choice; give the same object to several hosts to play two dashboards of one process. */
  balanceServer?: { hidden: boolean; source?: "click" | "config" };
  /** The token the page was built with: lifting the mask and the one-off need it, as on the server. */
  balanceToken?: string;
}

export interface HostLog {
  /** Every request or notification the View sent, in order. */
  received: { method: string; params: any; at: number }[];
  polls: {
    includeBalance: boolean;
    at: number;
    bytes: number;
    /** The click recorded with this poll (balance_choice), and whether it was the route button's one-off. */
    choice?: string;
    token?: string;
    once?: boolean;
    refused?: boolean;
  }[];
  messages: string[];
  contexts: string[];
  modeRequests: string[];
  marks: string[];
  /** The arguments of every sc_trade_suggest call, in order. */
  suggests: any[];
  /** How many times the View asked for the known hold sizes (action holds). */
  holdsCalls: number;
  /** Calls of tools other than the poll and the marker (the session tools), in order. */
  tools: { name: string; args: any }[];
}

const LIGHT_VARS: Record<string, string> = {
  "--color-background-primary": "light-dark(#ffffff, #262624)",
  "--color-background-secondary": "light-dark(#f5f4ed, #30302e)",
  "--color-background-tertiary": "light-dark(#eceae0, #3a3a37)",
  "--color-background-inverse": "light-dark(#141413, #faf9f5)",
  "--color-text-primary": "light-dark(#141413, #faf9f5)",
  "--color-text-secondary": "light-dark(#5e5d59, #c2c0b6)",
  "--color-text-tertiary": "light-dark(#6f6e68, #9c9a92)",
  "--color-text-inverse": "light-dark(#faf9f5, #141413)",
  "--color-text-success": "light-dark(#1f6b3a, #7bd79a)",
  "--color-text-warning": "light-dark(#8a5a00, #f2bd5a)",
  "--color-text-danger": "light-dark(#a8261c, #ff8f85)",
  "--color-text-info": "light-dark(#1a5fa6, #7ab6f5)",
  "--color-border-secondary": "light-dark(#c9c7ba, #55534f)",
  "--color-border-tertiary": "light-dark(#e1dfd4, #43423f)",
  "--color-ring-primary": "light-dark(#1a5fa6, #7ab6f5)",
  "--font-sans": '"Anthropic Sans", system-ui, -apple-system, "Segoe UI", sans-serif',
  "--font-mono": 'ui-monospace, "Cascadia Mono", Consolas, monospace',
  "--border-radius-sm": "6px",
  "--border-radius-md": "10px",
};

export function createFakeHost(options: HostOptions) {
  const { scenario, deliver } = options;
  const modes = options.availableDisplayModes ?? ["inline", "fullscreen"];
  let displayMode = "inline";
  let nextId = 1000;
  const waiting = new Map<number, (result: unknown) => void>();
  const log: HostLog = {
    received: [],
    polls: [],
    messages: [],
    contexts: [],
    modeRequests: [],
    marks: [],
    suggests: [],
    holdsCalls: 0,
    tools: [],
  };
  /** The server's runtime balance choice (shared by the Views of one process). Starts shown. */
  const balanceServer: { hidden: boolean; source?: "click" | "config" } = options.balanceServer ?? {
    hidden: false,
  };
  const tokenOk = (t: unknown) => options.balanceToken !== undefined && t === options.balanceToken;
  /** A test holds the answers of polls to deliver them late (a poll in flight while the player clicks). */
  const hold: { on: boolean; held: (() => void)[] } = { on: false, held: [] };
  /** Set by a test to change what the next polls answer. */
  const overrides: {
    poll?: (base: any, includeBalance: boolean) => any;
    /** Answers a call of any other tool with its structured content (an Error is an isError answer). */
    tool?: (name: string, args: any) => Record<string, unknown> | Error;
  } = {};

  const hostContext = (theme: "light" | "dark") => ({
    theme,
    displayMode,
    availableDisplayModes: modes,
    platform: "desktop",
    locale: "fr-FR",
    styles: { variables: { ...LIGHT_VARS, ...(options.variables ?? {}) } },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  });

  const respond = (id: unknown, result: unknown) =>
    deliver({ jsonrpc: "2.0", id: id as number, result });

  return {
    log,
    overrides,
    /** Hold the answers of polls (`on`), then `release()` delivers them in order, late. */
    hold,
    releasePolls(): void {
      const held = hold.held.splice(0);
      for (const f of held) f();
    },
    get displayMode() {
      return displayMode;
    },
    /** A message from the View. */
    receive(message: Record<string, any>, nowMs = scenario.now): void {
      if (message.method === undefined) {
        const resolve = waiting.get(message.id);
        if (resolve) {
          waiting.delete(message.id);
          resolve(message.result ?? message.error);
        }
        return;
      }
      const { method, params, id } = message;
      log.received.push({ method, params, at: nowMs });
      if (id === undefined) return; // a notification: nothing to answer
      switch (method) {
        case "ui/initialize":
          respond(id, {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "Claude", version: "fake" },
            hostCapabilities: {
              message: { text: {} },
              updateModelContext: { text: {}, image: {} },
              serverTools: {},
              serverResources: {},
            },
            hostContext: hostContext(options.theme ?? "dark"),
          });
          return;
        case "tools/call": {
          scenario.advanceTo(Math.max(scenario.t, nowMs - scenario.epoch));
          if (params.name === "sc_live_poll") {
            const a = params.arguments ?? {};
            // Like the server: a click is remembered (the last one wins, shared by the Views of the process), hidden
            // ignores include_balance true, and the one-off of the route button changes nothing.
            let refused = false;
            if (a.balance_choice === "hidden") {
              balanceServer.hidden = true;
              balanceServer.source = "click";
            } else if (a.balance_choice === "shown") {
              if (tokenOk(a.balance_token)) {
                balanceServer.hidden = false;
                balanceServer.source = "click";
              } else refused = true;
            }
            const onceAsked = a.balance_once === true && a.include_balance === true;
            const once = onceAsked && tokenOk(a.balance_token);
            if (onceAsked && !once) refused = true;
            const include = once || (!balanceServer.hidden && a.include_balance !== false);
            const base = scenario.poll(
              include,
              options.legacyFullPolls
                ? { includeStatic: true }
                : {
                    includeStatic: a.include_static === true,
                    ...(typeof a.since_seq === "number" ? { sinceSeq: a.since_seq } : {}),
                    ...(a.have && typeof a.have === "object" ? { have: a.have } : {}),
                  },
            );
            const answered = overrides.poll ? overrides.poll(base, include) : base;
            const structuredContent = {
              ...answered,
              balance_state: balanceServer.hidden ? "hidden" : "shown",
              balance_source: balanceServer.source ?? "config",
              ...(refused ? { balance_refused: true } : {}),
            };
            log.polls.push({
              includeBalance: include,
              at: nowMs,
              bytes: JSON.stringify(structuredContent).length,
              ...(typeof a.balance_choice === "string" ? { choice: a.balance_choice } : {}),
              ...(typeof a.balance_token === "string" ? { token: a.balance_token } : {}),
              ...(once ? { once: true } : {}),
              ...(refused ? { refused: true } : {}),
            });
            const deliverPoll = () =>
              respond(id, {
                content: [{ type: "text", text: `live dashboard poll: ${base.state}` }],
                structuredContent,
              });
            if (hold.on) hold.held.push(deliverPoll);
            else deliverPoll();
          } else if (params.name === "sc_live_mark") {
            log.marks.push(params.arguments?.action);
            const structuredContent = scenario.mark(params.arguments?.action);
            respond(id, {
              content: [{ type: "text", text: String(structuredContent["message"]) }],
              structuredContent,
            });
          } else if (params.name === "sc_trade_suggest" && params.arguments?.action === "holds") {
            log.holdsCalls++;
            const known = options.holds ?? [];
            void Promise.resolve(typeof known === "function" ? known() : known).then((list) =>
              respond(id, {
                content: [{ type: "text", text: "trade suggestion: holds" }],
                structuredContent: { v: 1, state: "holds", holds: list },
              }),
            );
          } else if (params.name === "sc_trade_suggest") {
            log.suggests.push(params.arguments ?? {});
            const make = options.suggest ?? ((a: any) => suggestAnswer(a));
            void Promise.resolve(make(params.arguments ?? {})).then((out: any) => {
              if (out && out.isError === true) {
                respond(id, {
                  content: [{ type: "text", text: "sc_trade_suggest: error" }],
                  isError: true,
                });
                return;
              }
              respond(id, {
                content: [{ type: "text", text: "trade suggestion: " + String(out?.state) }],
                structuredContent: out,
              });
            });
          } else if (overrides.tool && String(params.name).startsWith("sc_session_")) {
            log.tools.push({ name: params.name, args: params.arguments ?? {} });
            const out = overrides.tool(params.name, params.arguments ?? {});
            if (out instanceof Error) {
              respond(id, { content: [{ type: "text", text: out.message }], isError: true });
            } else {
              respond(id, {
                content: [{ type: "text", text: "ok" }],
                structuredContent: out,
              });
            }
          } else {
            deliver({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } });
          }
          return;
        }
        case "ui/message":
          log.messages.push(params.content?.[0]?.text ?? "");
          respond(id, {});
          return;
        case "ui/update-model-context":
          log.contexts.push(params.content?.[0]?.text ?? "");
          respond(id, {});
          return;
        case "ui/request-display-mode": {
          log.modeRequests.push(params.mode);
          // Measured: a mode the host does not offer (pip) is answered with the current mode, no error.
          if (modes.includes(params.mode)) displayMode = params.mode;
          respond(id, { mode: displayMode });
          deliver({
            jsonrpc: "2.0",
            method: "ui/notifications/host-context-changed",
            params: { displayMode },
          });
          return;
        }
        default:
          deliver({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      }
    },
    /** What Claude sends after the tool call returned. */
    toolResult(structuredContent: Record<string, unknown>): void {
      deliver({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          content: [{ type: "text", text: "The live dashboard is open." }],
          structuredContent,
        },
      });
    },
    contextChanged(params: Record<string, unknown>): void {
      if (typeof params["displayMode"] === "string") displayMode = params["displayMode"];
      deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params });
    },
    /** The host asks the View something and waits for the answer. */
    request(method: string, params?: unknown): Promise<unknown> {
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        deliver({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
      });
    },
  };
}

export type FakeHost = ReturnType<typeof createFakeHost>;
