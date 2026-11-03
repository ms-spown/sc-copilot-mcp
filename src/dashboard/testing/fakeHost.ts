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

export interface HostOptions {
  scenario: Scenario;
  /** Called with every message the host sends to the View. */
  deliver: (message: Record<string, unknown>) => void;
  theme?: "light" | "dark";
  /** Display modes the host offers. Claude Desktop 4.4212.0: inline and fullscreen. */
  availableDisplayModes?: string[];
  /** Style variables to hand out (a plausible set is used by default). */
  variables?: Record<string, string>;
}

export interface HostLog {
  /** Every request or notification the View sent, in order. */
  received: { method: string; params: any; at: number }[];
  polls: { includeBalance: boolean; at: number }[];
  messages: string[];
  contexts: string[];
  modeRequests: string[];
  marks: string[];
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
  };
  /** Set by a test to change what the next polls answer. */
  const overrides: { poll?: (base: any) => any } = {};

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
            const include = params.arguments?.include_balance === true;
            log.polls.push({ includeBalance: include, at: nowMs });
            const base = scenario.poll(include);
            const structuredContent = overrides.poll ? overrides.poll(base) : base;
            respond(id, {
              content: [{ type: "text", text: `live dashboard poll: ${base.state}` }],
              structuredContent,
            });
          } else if (params.name === "sc_live_mark") {
            log.marks.push(params.arguments?.action);
            const structuredContent = scenario.mark(params.arguments?.action);
            respond(id, {
              content: [{ type: "text", text: String(structuredContent["message"]) }],
              structuredContent,
            });
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
