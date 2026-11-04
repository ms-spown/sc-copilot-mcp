# MCP App feasibility spike (milestone 4)

Historical note: a record of the feasibility test of 3 November 2026, kept as written. It is not a description of the
current dashboard, and the test page it mentions was not the dashboard (see [ROADMAP.md](ROADMAP.md) for what is verified).

Question: can this server show a live dashboard inside Claude Desktop as an MCP App, in an install mode a player can
actually use, without a web server of our own? Answer: **yes, in the plain `claude_desktop_config.json` mode**, with
the limits below. Date of the test: 3 November 2026.

## What was tested

| | |
| --- | --- |
| Host | Claude Desktop 4.4212.0, Windows, the Store (MSIX) build |
| Install mode | A stdio server declared in `claude_desktop_config.json`, started by Claude Desktop itself (the parent process of the server was `Claude.exe`). No extension (MCPB) |
| Server | A throwaway server on the low-level `Server` of `@modelcontextprotocol/sdk` 1.x, no SDK 2.x, no helper package |
| View | One hand-written HTML page: no CDN, no package, no network. It talks to the host with `postMessage` JSON-RPC (`ui/initialize`, `ui/notifications/*`, `tools/call`, `ui/message`, `ui/update-model-context`, `ui/request-display-mode`) |
| Tools | `spike_hello` (model-visible, opens the View), `spike_poll` (`visibility: ["app"]`, a counter, called once a second by the View), `spike_report` (`visibility: ["app"]`, the View writes what it saw to a local log) |
| Method | The View reported what it received and what the host answered; the server wrote it to a log file on the PC. The results below come from that log, except where a line says "reported by the user" |

The spike code lives on the branch `telemetry/m4-spike`; it is not part of the product.

## Results

### Measured (from the log)

| Question | Result |
| --- | --- |
| Does the View render? | Yes, inline. The host sent `ui/initialize` answers with protocol `2026-01-26`, host name `Claude`, 12 context keys and 76 style variables |
| Is the server told the client supports MCP Apps? | Yes. At `initialize` the client declares `extensions["io.modelcontextprotocol/ui"]` with the type `text/html;profile=mcp-app`, so the server can list the dashboard tools only for clients that can show them |
| Display modes offered | `inline` and `fullscreen`. Asking for `fullscreen` works and sends `host-context-changed` (display mode, safe area, container size). Asking for `inline` back works. **`pip` is not offered**: the host answers the request with `{ mode: "inline" }` and no error, so never rely on it and read the mode in the answer |
| Does polling continue? | Yes, once a second: 198 ticks without a gap over about 3 minutes, including two switches to fullscreen and back |
| What does the host do when the window is hidden? | It sends `visibilitychange` (`hidden: true`) to the View; the View stopped its polling after 198 ticks and restarted it when the event came back with `hidden: false` |
| `ui/message` | Accepted (`{}`) |
| `ui/update-model-context` | Accepted (`{}`) |
| Host capabilities declared | `message` (text), `updateModelContext` (text, image), `serverTools`, `serverResources`, `openLinks`, `downloadFile`, `logging`, `sandbox` |
| Theme | `dark` here; the style variables use `light-dark(...)` values and must be applied by the View with fallbacks |
| Other clients that connected to the same server | The chat of Claude Desktop (`claude-ai`) and its local agent mode (`local-agent-mode-sc-spike`); both declared the MCP App extension. Only the chat showed the View |

### Reported by the user

- Minimising the window stops the counter. With the window open and in front on one of the screens, the counter keeps
  running even while another window has the focus. This matches how Chromium defines page visibility (minimised or
  fully covered = hidden; merely unfocused = visible). The practical rule for the dashboard: it updates while it is
  visible, and pauses when it is not. We rely on `visibilitychange`, not on focus.

### Not observed

- What happens when the user switches to another conversation and comes back (the log shows no event for it).
- The `ui/resource-teardown` request (the host did not send one during the test).
- Whether the model answered the test message sent with `ui/message` (the host accepted it; the answer was not logged).
- Anything on Claude on the web, on mobile, or in an extension (MCPB). We found no documentation saying whether an
  extension shows MCP Apps either way, so we make no claim.
- Claude Code: its documentation says it does not render the View and shows the tool result as text.

## Decisions

1. **Go for milestone 5**, documented as: *Claude Desktop, server declared in `claude_desktop_config.json`*. That is
   the mode `npm run install:claude` already sets up.
2. **No SDK 2.x.** The low-level `Server` of SDK 1.x is enough: it needs the `resources` capability, the
   `resources/list` and `resources/read` handlers, `_meta` kept on tool definitions, and `structuredContent` (an
   object) in results. The `@modelcontextprotocol/ext-apps` package is not needed; version 2 and later of it requires
   SDK 2.x, which this project does not use.
3. **No package in the View.** The protocol is small enough to write by hand, and the View stays one file with no
   network and the default restrictive content security policy (`connect-src 'none'`).
4. **List the dashboard tools only when they can be used**: telemetry on, and the client declared the MCP App
   extension. Clients that cannot show a View (Claude Code, for one) then never see the app-only polling tool.
5. **The host does not unmount old Views** (documented by Claude: one frame per tool call stays mounted), so several
   Views can poll at once. The server caches the poll answer for half a second and a View stops polling when it has
   been off screen too long.
   Update (dashboard v2): the Views of one connector are also documented to share one sandbox origin, so they now
   elect one leader over a `BroadcastChannel` and only that one polls; this is not verified inside Claude Desktop,
   and without the channel the old behaviour applies.
6. **No `pip`.** Only `inline` and `fullscreen`, negotiated, never assumed.

## Not done, on purpose

- **The reference test host of the MCP Apps repository (`basic-host`).** It speaks HTTP only, not stdio, and installing
  the repository runs a build that needs a development dependency whose install script downloads a binary. The project
  rule is to stop and ask in that case; the answer was to replace it with a small fake host page. The fake host
  (`scripts/spike-mcp-app/fake-host.html` on the spike branch) plays the host side of `ui/*` and was used to check the
  View's protocol handling in a normal browser. It proves nothing about Claude.
- **A local web server of our own.** Not needed, so not built.

## Sources

- The MCP Apps specification (version `2026-01-26`) and its example servers, in the repository
  [modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps).
- The MCP Apps pages of Claude's connector documentation (getting started, quick start, design guidelines,
  troubleshooting, instance supersession). Read for the metadata shapes, the default content security policy and the
  behaviour of old Views; the test above is what we measured ourselves.
