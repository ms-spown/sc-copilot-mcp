# Roadmap

Where the project stands and what is next, in product order: what helps the player most first. It is a plan, not a
promise, and every item says what is verified and what is not. The history of what shipped is in
[CHANGELOG.md](../CHANGELOG.md); what each tool does is in [CAPABILITIES.md](CAPABILITIES.md).

## Where it stands (2.5.0)

- **Data and answers:** UEX prices and routes, the Star Citizen Wiki, SCMDB (missions, crafting, mining), patch notes,
  your fleet, the optional local game log, honest `data_age` and estimate markers everywhere.
- **Trade:** a personal trade journal read from `Game.log` (gross margin only: the log has no balance), a profit per
  hour planner with round trips and chains, price history and market status, refining ranking, item and marketplace
  prices, a ranking of hauling contract templates (SCMDB has templates, not the live offers).
- **Optional live telemetry and dashboard (opt-in, local, read-only):** ship and pilot state, state alerts, a
  connection state read from the log (kicked, menu, online), a transport ledger, a commerce card that compares the
  planned profit with the real one (turnover, cost, gross margin, fees measured per side, net), where the money went,
  saved play sessions that survive a crash, an action bar that finds the next route.
- **Route reliability and checks (2.3.0 and 2.4.0):** the planner's profit set against the result of your own runs
  (the typical ratio, with the number of runs and a confidence level; small samples stay silent), a health strip that
  says what is wired and what is missing with the exact fix, a pre-flight check of the planned route's prices before
  you leave, the alert when the price moved at the kiosk, and a session report to copy or save (Markdown or CSV).
- **A lighter, clearer page and a hardened server (2.5.0):** the dashboard page went from 357 to about 324 kB (a
  token-level script minifier proven equivalent, shared DOM helpers), the chat view from about 690 to about 330 px
  (verdict and alerts first, three dials, the session on one line, a price refusal shown in the verdict), the
  documentation was read against the code (35 defects fixed, a test keeps counts, commands and links true), and a
  whole-system security and privacy audit was fixed (names fenced as untrusted text, a total request deadline, the
  trade journal amounts shown only when you allow amounts, the installer keeping your environment variables, bounded
  caches, `npm run sessions -- wipe`).
- **The agent:** server `instructions`, refreshed prompts (`haul_plan`, `trade_copilot`, `trade_review`,
  `session_debrief`), a block to paste into a Claude project.

## Next, in order of value

1. **Losses.** (Studied: a ship destroyed with the player aboard is certain in the 4.10 log, the cargo lost is only
   inferable, its value and the insurance are not logged.) Cargo lost or a ship destroyed, attributed to the run it cost, with the insurance claim.
2. **Price watchlists.** Follow a commodity or a route and say when its price moves.
3. **On foot.** Vitals forecast, helmet state (in the log, not in the stream), kill and death counters, an interface
   that adapts to ship, foot and EVA.

## Verified, and not verified

- **Verified:** the parser on real logs of 95 files; the planned versus real arithmetic on a real run; the sessions
  file under concurrent processes and a killed process (simulated); the privacy guarantees by tests and probes.
- **Not verified:** the live dashboard itself inside Claude Desktop (only a throwaway test page was displayed there,
  see [MCP_APP_SPIKE.md](MCP_APP_SPIKE.md), a historical note); a complete run with telemetry, log and dashboard open together (the windows that match a log
  transaction with a balance change are assumptions: 2 s before to 8 s after for fees, 3 s before to 20 s after for
  rewards); the voluntary quit to the menu; the behaviour inside Claude Desktop (whether it honours server
  `instructions`, the size limit for an MCP App page, clipboard and storage in its sandbox).
- **Impossible with the data we have:** a stock level (not in the log), a unit sale price (only the total), the amount
  of a contract reward (only measured as a balance change), a fee line (only inferred by comparing amounts),
  piracy risk (the "safer" option is a labelled heuristic, never a guarantee).

## Distribution ideas (studied, not started)

- **Server `instructions`:** shipped. Whether Claude Desktop uses the field is not verified; the pasted block stays the
  reliable channel there, and [USING_WITH_CLAUDE.md](USING_WITH_CLAUDE.md) has a three question test.
- **A skills plugin** (one skill per activity: trade, mining, missions) and a **`.mcpb` bundle** for one click
  installation: possible, to be re-checked against the current Claude Desktop before building anything.

## Not planned

Anything that writes to the game or to a website, reads game memory or sends keys, extracts game files, scrapes a site,
publishes to npm or Docker Hub, or turns the telemetry on by itself. See [SECURITY.md](../SECURITY.md).
