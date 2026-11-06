# Using sc-copilot-mcp from ChatGPT

English · [Français](CHATGPT.fr.md)

This page connects this server to ChatGPT (web or desktop) through OpenAI's **Secure MCP Tunnel**. ChatGPT only
accepts a public HTTPS address or a tunnel; this server speaks stdio only, and it stays that way. The tunnel is a
program from OpenAI, `tunnel-client`, that runs on your PC and starts this server for ChatGPT. One command,
`npm run chatgpt`, downloads it, configures it and starts it.

> **Read first**
>
> - **What leaves your PC.** While the tunnel runs, ChatGPT (so OpenAI) can call every tool this server offers and
>   receives every answer: prices, wiki pages, your fleet file, the game log events if you set them up, and with live
>   telemetry on, your ship's state and your saved sessions. **The aUEC balance is shown by default**, so it reaches
>   ChatGPT too: start with `--balance hidden` to keep the amounts out. See [What leaves your PC](#what-leaves-your-pc).
> - **New and partly unverified.** The setup, the profile and the start were checked on Windows with tunnel-client
>   0.0.19 (details in [What is verified](#what-is-verified-and-what-is-not)). A full ChatGPT conversation through a
>   real tunnel, and whether ChatGPT shows the live dashboard, are not verified yet.
> - **Not ours.** tunnel-client, ChatGPT and the OpenAI Platform belong to OpenAI and follow their terms. This
>   project does not say they are safe or approved for anything; it only makes them easier to set up.

## What the tunnel is

- `tunnel-client` is OpenAI's program, open source under Apache-2.0
  ([github.com/openai/tunnel-client](https://github.com/openai/tunnel-client)). It runs on your PC, opens an
  **outbound** connection to OpenAI and waits for ChatGPT's requests. Nothing is opened on your router and no public
  address is created.
- For each tool call, it hands the request to this server, which it started itself as a child program (the same
  `dist/index.js` that Claude Desktop runs), and sends the answer back to ChatGPT.
- This project does not ship it. `npm run chatgpt -- setup` downloads the official archive of one **pinned** version
  (0.0.19) from OpenAI's download address, checks its size and SHA-256 against the values written in this
  repository, and only then unpacks it. A newer version is a reviewed change of this repository, never an automatic
  "latest".
- The server itself is unchanged: same tools, no HTTP transport, no new host. tunnel-client is what talks to OpenAI.

## What leaves your PC

- **Tool answers go to OpenAI.** Everything a tool returns is sent through the tunnel to ChatGPT and becomes part of
  your conversation there, under OpenAI's terms and settings, not this project's.
- **The aUEC balance.** Shown by default, like in Claude: the balance and every figure derived from it (session
  results, rates, trade amounts) reach ChatGPT. To keep them out, start the tunnel with `--balance hidden` (it sets
  `SC_BALANCE=hidden` for this server). The dashboard's "Masquer le solde" button is not a substitute here: it only
  protects the server process of the dashboard you click, and ChatGPT may not show the dashboard at all.
- **Live telemetry** stays off unless you start with `--telemetry on` and also switch the game side on (see
  [TELEMETRY.md](TELEMETRY.md), read its risks first).
- **The runtime key** (an OpenAI secret, see below) stays in a file on your PC that only tunnel-client reads. It is
  never printed, never written in the profile or in this repository, and never passed to this server.
- **What this server sends over a network does not change**: the same data sources as before, nothing else.

## Before you start

- A working installation of this repository (see the [README](../README.md#install)): Node.js, `npm ci --ignore-scripts`,
  `npm run build`, and your UEX token in `.env`. If Claude Desktop runs this server from the same folder, quit it
  before `npm run build`.
- A ChatGPT account where **Developer mode** and custom connectors are available. Which plans have it changes over
  time and is not verified here: check OpenAI's current help pages.
- An organization on the OpenAI Platform (`platform.openai.com`) where you may create a tunnel and an API key. The
  tunnel must be visible to your ChatGPT workspace.
- Windows 10 or 11 (x64 or arm64). Linux and macOS archives exist and the command supports them, but they are not
  tested.

## Step 1: the tunnel and the runtime key (OpenAI Platform)

1. **A role that may create tunnels.** At https://platform.openai.com/settings/organization/people/roles, create a
   role with Tunnels **Read**, **Manage** and **Use**, and give it to yourself (OpenAI's documentation says the Owner
   role alone cannot create tunnels).
2. **The tunnel.** At https://platform.openai.com/settings/organization/tunnels, create a tunnel and copy its ID. It
   looks like `tunnel_` followed by 32 lowercase letters and digits.
3. **The runtime key.** At https://platform.openai.com/settings/organization/api-keys, create a key, choose
   **Restricted** and allow only Tunnels **Read** and **Use**. Copy it (it is shown once). Never use an admin key or a
   key with all permissions: `npm run chatgpt -- key` refuses an admin key.

## Step 2: install the tunnel on your PC

In a terminal opened in this repository's folder (PowerShell is fine):

```powershell
npm run chatgpt -- setup --tunnel-id tunnel_0123456789abcdef0123456789abcdef --dry-run
npm run chatgpt -- setup --tunnel-id tunnel_0123456789abcdef0123456789abcdef
```

Put your own tunnel ID. The first line shows what would be downloaded and written, and changes nothing; the second
does it. Note the `--` after `npm run chatgpt`: without it npm keeps the options for itself (the command tells you).

What `setup` does:

- downloads the archive for your system, checks its size and SHA-256 (nothing is unpacked if they differ), and
  unpacks it into `%LOCALAPPDATA%\sc-copilot-mcp\chatgpt\tunnel-client\v0.0.19\`;
- writes the profile `profile.yaml` next to it: your tunnel ID, the status port, where the key file is, and the
  command that starts this server (this Node.js and this folder's `dist/index.js`);
- remembers all that in `state.json`, so that `start`, `doctor` and `status` find it.

Run it again whenever you like: after moving this folder, after changing Node.js, or with another tunnel ID. It does
not download again when the installed copy is intact. The status port is `8080` by default; if another program uses
it, add `--port 8090` (any free port from `1024` to `65535`).

## Step 3: save the runtime key

```powershell
npm run chatgpt -- key
```

Paste the key and press Enter. Nothing appears while you paste, not even stars; that is on purpose. You can also
pipe it: `Get-Clipboard | npm run chatgpt -- key`.

The key goes into one file, `control-plane-api-key`, in the same folder. The profile only points to that file, and
tunnel-client reads it at start. Why a file and not an environment variable: a user environment variable is handed to
every program you start, this server included; the file is read by tunnel-client only. Like any file of your user
folder, programs running under your Windows account can read it. To delete it: `npm run chatgpt -- key --remove`
(and revoke the key on the Platform if you no longer use it).

## Step 4: start the tunnel

```powershell
npm run chatgpt -- start --balance hidden
```

Keep that window open as long as you use ChatGPT with the game; `Ctrl+C` stops the tunnel (if Windows then asks
whether to end the batch job, answer yes). The window stays quiet while everything works: only warnings and errors
appear there.

| Option | What it does |
| --- | --- |
| `--balance hidden` | hides the aUEC amounts from ChatGPT for this run (`SC_BALANCE=hidden`); `--balance shown` shows them |
| `--telemetry on` | live telemetry for this run (`SC_TELEMETRY=on`); `--telemetry off` turns it off |
| `--profiles core,trade` | which tool profiles ChatGPT sees (`SCMCP_PROFILES`); the default is `core,trade,data,local`, like Claude Desktop |
| `--verbose` | tunnel-client's informational log too |
| `--dry-run` | shows the command and the settings, starts nothing |

Other settings of this server (for example `SC_INSTALL_DIR` for the game log) are read from the window's
environment: set them in the same PowerShell window before `start`, for example
`$env:SC_INSTALL_DIR = "C:\Program Files\Roberts Space Industries\StarCitizen\LIVE"`. tunnel-client passes its
environment on to this server. Then ask ChatGPT for `sc_data_status` to see what the server really uses.

`start` refuses to run twice for the same setup (one tunnel-client per tunnel ID, as OpenAI requires), refuses when
the status port is taken, and removes from the environment it passes on every variable tunnel-client would read by
itself (`CONTROL_PLANE_*`, `OPENAI_*`, `LOG_*`, `ALLOW_REMOTE_UI`...). So a key or a setting left in your
environment can neither override the profile nor reach this server; the command names what it removed, never the
values.

To check that OpenAI is reached, in another window:

```powershell
npm run chatgpt -- status
```

`Control-plane poll: PASS` means the tunnel really works. A local page also shows the tunnel's state:
`127.0.0.1:8080/ui` in your browser (with your port if you changed it).

## Step 5: connect ChatGPT

While `start` is running:

1. Open https://chatgpt.com/#settings/Connectors and turn **Developer mode** on (in the advanced settings).
2. Create an app (or "add a custom MCP server"; the labels change from time to time).
3. Fill in the form with these values:

```text
Name:            Star Citizen copilot   (your choice)
Connection:      Tunnel                 (pick your tunnel, or "Enter tunnel ID instead")
Tunnel ID:       tunnel_0123456789abcdef0123456789abcdef   (yours)
Authentication:  No authentication
```

4. Save. In a new conversation, enable the connector and ask: "Call sc_data_status".

ChatGPT checks the tunnel when you create the connector: create it only while the tunnel runs.

## Everyday use

- Start the tunnel (`npm run chatgpt -- start --balance hidden`), play and talk to ChatGPT, then `Ctrl+C`.
- After an update of this repository (`git pull`, `npm run build`): restart the tunnel, then in ChatGPT's connector
  settings use **Refresh** so that ChatGPT reads the new list of tools.
- Claude Desktop and ChatGPT can be used at the same time: each starts its own copy of this server. The saved
  sessions file is shared under a lock; the balance button of a dashboard only acts on its own copy.

## What is verified and what is not

Verified on Windows 11 with tunnel-client 0.0.19, on 2026-11-06, without a real key and with every network route of
tunnel-client sent to a dead local address:

- `setup` downloads the official archive, checks size and SHA-256 and unpacks it, in a user folder with a space and
  accented letters in its name;
- tunnel-client's own check (`npm run chatgpt -- doctor`) accepts the profile written by `setup`;
- `start` runs tunnel-client, which starts this server as its child and passes its environment on
  (`SC_TELEMETRY` and `SC_BALANCE` measured in the child); a second `start` is refused; `status` reads the local
  health page.

Not verified:

- a real conversation in ChatGPT through a real tunnel (it needs a tunnel and a key; the maintainer had not run it
  when this page was written);
- **whether ChatGPT shows the live dashboard** (this server's MCP App). OpenAI's documentation mentions UI resources,
  nothing more precise for this kind of page; the tools that only exist for the dashboard may be missing in ChatGPT;
- which ChatGPT plans offer Developer mode and tunnels;
- how ChatGPT copes with many tools at once: if it struggles, try `--profiles core`;
- Linux and macOS.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "npm kept the options for itself" | put `--` after `npm run chatgpt` |
| "dist/index.js is missing" | `npm run build` in this folder (quit Claude Desktop first if it runs the server from here), then `setup` again |
| "No successful contact with OpenAI yet" in `status` | wait a few seconds; then check the key (Restricted, Tunnels Read + Use), the tunnel ID, and your connection or proxy; the tunnel window shows the error; `start --verbose` shows more |
| The tunnel is not offered in ChatGPT | the tunnel must be running; your Platform role needs Tunnels Use; the tunnel must belong to the workspace of your ChatGPT account; or use "Enter tunnel ID instead" |
| "Something already listens on 127.0.0.1" | another tunnel or program uses the port: stop it, or `npm run chatgpt -- setup --port 8090` |
| "already running" | a tunnel is open in another window: use it, or stop it with `Ctrl+C` |
| "changed on disk" or "not installed" | `npm run chatgpt -- setup` again |
| ChatGPT shows old tools | restart the tunnel, then **Refresh** the connector in ChatGPT |
| A path problem in a profile you edited by hand | tunnel-client eats backslashes in the server command: keep forward slashes and quotes, or let `setup` rewrite the profile |

`npm run chatgpt -- doctor` checks everything this command set up, then runs tunnel-client's own check. Never turn on
tunnel-client's options `--log.http-raw-unsafe` (it logs whole requests, secrets included) or `--allow-remote-ui` (it
opens the status page to your network).

## Removing it

1. Stop the tunnel (`Ctrl+C`).
2. `npm run chatgpt -- key --remove`, then delete the folder `%LOCALAPPDATA%\sc-copilot-mcp\chatgpt`.
3. Delete the connector in ChatGPT, and revoke the key and delete the tunnel on the Platform.

Nothing else was changed on your PC: no environment variable, no Claude Desktop setting, nothing in the game folder.
