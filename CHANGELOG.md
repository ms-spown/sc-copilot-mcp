# Changelog

All notable changes to this fork. The history of the original project (voidput/SCMCP, up to 1.5.0) is kept in
[docs/UPSTREAM_CHANGELOG.md](docs/UPSTREAM_CHANGELOG.md). Format: [Keep a Changelog](https://keepachangelog.com/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed (documentation)
- What is saved: the pages no longer say that everything stays in memory, that the server "stores nothing new" or that
  the only writes are the fleet list and the caches. One reviewed sentence now says the same thing in the README, the
  telemetry page, CAPABILITIES, ARCHITECTURE, SECURITY and rule 5 of the block to paste into Claude (English and French):
  frames and raw log lines are never written; the session summary (`sessions.json`) is the one exception, only with
  telemetry on, never sent by this server, off with `SC_SESSIONS=off`, erased by deleting the file and its copies.
  `npm run telemetry -- disable --apply` is now said to leave `sessions.json` in place; `enable --session` needs
  `--apply`; the reader's five idle minutes are said to be suspended while saved sessions follow the game.
- Counts and tables: the `local` profile has 26 tools (not 24); there are seven prompts (`trade_copilot` was missing from
  the README tables); `sc_session_export` is UI-only; the thirteen telemetry and session tools are hidden while telemetry
  is off; "the three dashboard tools" is "the dashboard tools"; the roadmap is for 2.4.0 and its "Next" list no longer
  holds what shipped in 2.3.0 and 2.4.0; the server manual is "about 3,500 characters (limit 3,500)".
- Commands and paths: re-running `npm run install:claude` replaces the entry's `env` (only `SCMCP_PROFILES`, the log
  setting and `SC_TELEMETRY` survive) and the README says so; TROUBLESHOOTING no longer tells users to delete the whole
  `%LOCALAPPDATA%\sc-copilot-mcp` folder (`cache\` can go, `data\` holds `sessions.json`); `check:sources` is described as
  checking the main UEX endpoints, not every path the tools use; the full verification chain of CONTRIBUTING.md is the one
  named in the README and CLAUDE.md; the configuration tables list `SCMCP_SNAPSHOT_DIR` and `SCMCP_BUILD_CACHE_DIR`.
- Honesty about the dashboard: the README says the maintainer has not yet seen the dashboard itself inside Claude Desktop;
  CAPABILITIES no longer says the MCP App "does not exist yet"; `docs/MCP_APP_SPIKE.md` is marked as a historical note.
- French: README.fr gets the telemetry sentence in its introduction, the ROADMAP link and the "absent from build 4.10
  logs" caveat.
- A "Read this first" block opens `docs/TELEMETRY.md` and `docs/TELEMETRY.fr.md` (what it is, the two switches, the risks,
  what is unverified, how to turn it off, what is saved and how to erase it).

### Added
- `src/docs/docsAccuracy.test.ts`: the README tool, prompt and profile counts against the registry (English and French);
  the numbers, outline and linked documents of each English/French pair; the reviewed "what is saved" sentence in every page
  that carries it; every `npm run` command named in a page against `package.json`; every relative link and `#anchor` of
  every Markdown file; the roadmap's version and the manual's size against the code.

### Changed
- **The dashboard page is 38 kB lighter (357.3 kB to 319.3 kB), with no change of behaviour.** The room under the budget (2.7 kB) blocked
  every new View feature. The script is now shipped without its blanks (`minifyScript` in `src/dashboard/scriptMinify.ts`, a
  token-level pass: strings, templates and regular expressions byte for byte, no name touched; a test has a JavaScript parser read
  the script before and after and requires the same tokens and the same tree), the DOM helpers that eight panels each carried are
  one shared `domKit` in `viewLogic.ts`, three functions nobody called are no longer shipped, and two style rules for classes the
  page never produces are gone (a test now fails on a dead rule or a dead function). The budget of `npm run check:page-size` is
  345 kB (the new size plus about 8 %).
- **Dashboard, first UX pass (from the independent UX audit).** The compact (inline) view puts what a glance in flight
  needs first: header and verdict, the alerts (no row while there is none), the three dials, then the ship on a small row,
  the session on ONE line (a button with `aria-expanded` unfolds the card; the net per hour is in the line only while the
  balance is shown) and the rest. In real Chrome on the preview's made-up flight: 691 px to 326 px at 560 px wide, 915 px to
  510 px at 360 px with a price refusal. **Nouvelle session** is a secondary button; the objective buttons are one
  segmented choice (the chosen one is filled, with its check mark). A price refused at the kiosk now enters the verdict of
  the header ("Prix changé : achat refusé · il y a 40 s", the clock time as its tooltip) instead of a green "Tout va bien",
  and shows as one line right under the header; the pre-flight verdict "dérivé" offers "Relancer la recherche" as a real
  button. On the commerce card the long amber paragraph about the balance moved under the figures and became one sentence
  with a "Détail" button (the full account stays in "Mouvements du solde"); before a run only the planned profit is drawn,
  no more wall of empty tiles. The health strip is one line ("N réglages à faire", "Voir" unfolds the fixes). The route
  calibration line is plain French ("D'après tes N trajets similaires (marchandise non vérifiée) : tu réalises ≈ X % du
  prévu (frais ≈ Y %)", "Sur le 1er tronçon" for a two-leg route), the caveats are in a fold "Comment lire ça", the tag is
  "estimé · N trajets". Small copy fixes: "Session reprise après 1 arrêt du jeu", "Solde masqué", shorter health sentences.
  No data, tool or network change; the balance rules are unchanged. The page grows by about 4.6 kB (the features, on top of the slim page).

### Security
- **Names from UEX, the game log and the user's dataset files are fenced (audit F1).** `uex_get_terminal_inventory`,
  `scw_search_ships_by_vendor` and `uex_get_trade_routes` returned UEX's terminal, vendor, location, system, faction and
  commodity names as they came (a right-to-left override, Unicode tag characters, a zero-width space and a forged
  `<<<END_UNTRUSTED_TEXT>>>` passed with no fence and no notice) while declared `structured`. They are `untrusted_text` now,
  and so are `sc_log_status` and `sc_log_sessions` (header and jurisdiction lines of the log) and the three local dataset
  tools (a third party's records). The guard test plants the payload in the NAME fields of every UEX and wiki row, in a
  hostile Game.log and in a hostile planner market. Still `structured`: the telemetry tools (game identifiers, matched
  against `^[A-Za-z0-9_.-]{1,64}$`), `sc_data_status`, `uex_get_game_versions`, `uex_get_price_history`,
  `uex_get_market_status`, `uex_plan_trade` (names go through `cleanLabel`: cleaned, fence markers defused, 30 to 80
  characters), `scw_snapshot_list` (`cleanLabel`) and the two fleet writers (they echo what the player typed).
- **`sc_trade_journal` withholds every aUEC amount unless `include_balance` is true (audit F2).** Line totals, unit prices,
  spending, run cost, revenue and gross margin were returned freely while the session tools, the debrief and the poll
  withhold the same class of figures. Counts, SCU, kinds, statuses, categories and the structure stay; the answer carries a
  `money_note` when amounts are withheld. Here the flag means "amounts".
- **A total deadline on every outbound request (audit F3).** axios' timeout restarts at every byte, so a server that drips
  bytes kept a call, and every identical question joined to it in the cache, alive without limit. Each call now has one
  `AbortSignal.timeout` (1.5 times the idle timeout: 45 s by default, 180 s for the big downloads; `deadlineMs` to change),
  shared by its retries; it fails as a timeout and a good disk copy may answer.
- **Growth is bounded (audit F4).** Parsed SCMDB files: 16 at most and 160 MB of JSON text, least recently used first. Memory
  cache: 96 MB of JSON text besides the 300 entries. SCMDB cache folder: the files of the newest 3 commits. Dump cache
  folder: 60 files and 400 MB. Only files named like the server's own are pruned.
- A symbolic link or junction named `Game.log` is followed only to a file that is itself called `*.log` (audit F7).
  `SAFE_NAME` of SCMDB no longer accepts `.` and `..` as a file name (audit F13).

### Fixed (security audit)
- **`npm run install:claude --apply` keeps every `env` key of the existing entry (audit F5).** It carried over `SC_TELEMETRY`
  only, so a re-run silently dropped `SC_SESSIONS=off` (turning saved sessions back on), `SC_INSTALL_DIR`,
  `SC_SESSION_GAP_HOURS`, custom profiles and a token typed by hand. Only the keys the command line asks for overwrite
  (`--profiles`, `--install-dir`, `--game-log`); the default profiles apply to a new entry only. The dry run lists the kept
  keys by name, never their values. Dry run by default and the timestamped backup are unchanged.
- `npm run telemetry -- status` shows the Claude config path in the short form used elsewhere (audit F12).

### Added (security audit)
- `npm run sessions -- wipe` (dry run; `--apply` deletes): the sessions file and its copies (`.v<N>.bak`, `.bak-<time>`,
  `.corrupt-<time>`, `.lock`, `.tmp`) in the sessions folder only, by name; refuses a path that does not look like the
  sessions file or a fresh lock; honours `SCMCP_SESSIONS_FILE` (audit F8).
- CI runs `npm run check:telemetry-silence` after the build (audit F9).

## [2.4.0] - 2026-11-04

### Changed
- The page's style sheet is shipped compacted (`compactCss` in `src/dashboard/page.ts`: comments, indentation and the blanks
  around `{ } ; , :` out, strings untouched; a test has a CSS parser read both sheets and compares them): about 6.7 kB less
  in the shipped page, to keep room under the 360 kB budget. `docs/TOOLS.md` and the golden file changed with this release
  (the `action` enum of `sc_trade_suggest` gains `preflight`, and its description and the one of `sc_session_stats` say more).

### Added
- **Session report: take a session out of the server.** The stats were in `sc_session_stats` and the session bar, with no
  clean way to share them with a crew or an org, keep a log or paste the trips into a spreadsheet. New pure formatter
  `src/providers/sessions/debrief.ts`; new tool `sc_session_debrief` for the model (small on purpose, because a tool result is part
  of the conversation: Markdown by default, about 28 000 characters at most, 20 table rows per session, a CSV only on request with
  100 rows, never both, the text not duplicated in `structuredContent`, `csv_delimiter`, `id` or `last`, `include_balance`,
  `include_start_balance`); new app-only tool `sc_session_export` for the dashboard (the whole session, strict input); and, in the
  detail of a session, **Copier le bilan** (clipboard, with a selectable block when the host refuses it), **Télécharger .md**, **.csv**
  and **.csv (Excel FR)** (semicolon, decimal comma; only where the page can make a file, never required). The Markdown report
  (French, UTC, deterministic) has the header (times, active time, game version and channel, breaks and why), the key numbers
  (trips, per hour, gross margin, fees, best trip, efficiency against the plan, route reliability with its runs, confidence and the
  "marchandise non vérifiée (lien par prix)" caveat), a trips table with mesuré / calculé / estimé / inconnu tags, what is
  unexplained, and a footer on what is measured and what is estimated. The CSV (English columns, RFC 4180) has one row per trip;
  a text cell that could start a formula in a spreadsheet is prefixed with an apostrophe (a mitigation for Excel and LibreOffice,
  not a guarantee for every program). Amounts exist only when the balance is shown / `include_balance`; the start and last balance
  only with the separate `include_start_balance` (their difference can show with amounts); unknown stays unknown, never 0; no trend
  is invented. Labels and the note are cleaned, capped and escaped but their content is not checked: the report says to read it
  before sharing. A closed menu, a hidden balance, a left detail or a page that goes away now EMPTY the report and the session
  detail from the page (they were only hidden). A run stored twice in an older file now counts once in the session bar and the
  statistics, as in the report. App-only tools (`sc_live_poll`, `sc_live_mark`, `sc_trade_suggest`, `sc_session_export`) are now
  refused by name, as unknown tools, to a client that did not declare the UI extension (listing them only to Views was not
  enough). The CSV puts an apostrophe after every separator that precedes a formula starter, not only at the start of a cell. The prompt `session_debrief` and the server instructions tell Claude it can produce it. Docs EN/FR,
  SECURITY.


- **Pre-flight check: does the plan still hold, before leaving?** On the commerce card, *Vérifier avant de partir* asks the
  app-only tool `sc_trade_suggest` (new action `preflight`, no argument, same strict input, throttle, short memory and
  in-flight sharing as the search; no new listed tool) to re-read the CURRENT UEX prices of the plan in force at its buy and
  sell terminals: ONE cached `GET /commodities_prices` by goods name plus the cached `GET /game_versions` (two GETs per
  click at most, plus the client's usual retries; a guard refuses a fourth GET; no new host, never a POST), filtered
  locally to the exact goods, then to the terminal by UEX id when the planner built the plan (kept server-side, never sent
  by the page) else by exact normalised name, and to the row of LIVE's game version. The verdict is per leg and overall:
  **Toujours valable** (the only green: both legs fresh AND backed by at least one player report), **Inchangé · estimation
  UEX** (nothing moved but a price is UEX's own estimate: neutral, never green), **À surveiller** (margin down 15 % to
  30 %, a row older than 7 days, undated or dated in the future, low or saturating stock, or an unusual gain, which the card
  explains), **Dérivé** (margin down 30 % or more or no longer positive, out of stock, no demand, no price) or **Impossible de
  vérifier** (UEX down, a stale cache copy, terminal not found or ambiguous, incomplete plan: never green). The thresholds
  are named constants and choices, sent with each answer. It shows the plan's price against the current one and the drift,
  the margin per SCU now against planned, the age of UEX's row, the player reports (estimates labelled), the stock status and
  the next action. The answer holds unit prices and per-SCU margins only: the balance is never used or revealed and a plan
  sized from the balance stays private. The page refuses a green verdict that no leg backs and ignores an answer made for
  another plan; *Demander à l'agent* posts a fixed text with no quantity. Docs EN/FR, SECURITY.
- **The price moved at the kiosk.** The game's `TransactionCostMismatch` refusals, which the trade journal already lists as
  failed transactions, now raise an alert on the commerce card (and one line in the small view) for 10 minutes: "Le prix a
  changé pendant l'achat (ou la vente) : transaction refusée, le prix affiché n'est plus valable", with the time and the
  side, and a nudge to run the pre-flight check again. An error that follows several requests is counted once, as
  ambiguous. No amount travels (a time, a side, a kind), so it is shown with or without the balance and crosses the channel
  between Views (rebuilt on reception). The session counts them (`price_refusals`, additive and optional, the file stays
  version 2, a watermark keeps the count idempotent) and `sc_session_current`, `sc_session_list` and `sc_session_stats` report
  it (a total and per session). The alert is muted once a later transaction of the same side and kind went through, and its
  live region holds only the stable sentence and the absolute time. Nothing is parsed a second time. Measured read-only on the reference install's 95 logs: 2
  refusals, 162 and 247 ms after the request.
- **End-to-end replay of a complete trade run (tests only).** Every part of the trade and session pipeline was tested on
  its own; none had been played together. A harness (`src/testing/replay/`) now drives the real objects from one
  synthetic timeline: a Game.log that grows (commerce lines, errors, contracts, connection lines), telemetry frames
  carrying a balance that changes at precise times (through the fake game and the frame encoder), a plan applied by the
  action bar's tool, the session manager writing a temp file, a crash and restart, and every tool called through an
  in-memory MCP client, on one injected clock. Sixteen scenarios (`src/e2e/replay.*.behaviour.test.ts`) assert the exact
  figures and the privacy guarantees at every step: the player's run (gross margin 186 568, fees 19 468 / 24 100, net
  +143 000, price deviation +6 568, nothing unexplained), a second and a third run (calibration, a foreign spending kept
  out), a late sale of stock from before, rejected cargo lines, a disconnection and a restart, a quiet telemetry around a
  sale, a reward paid near a sale, hostile text in the log and in a note, and a stack switched off. Seven bugs it found
  are fixed below. How to add a scenario: CONTRIBUTING.
- `createSessionStack` (`src/providers/sessions/stack.ts`): the server's wiring of the ledger reader, the session file and
  the session manager, shared by `index.ts` and the replay harness so that they cannot drift apart. No change of behaviour.

### Fixed
- **A restarted server no longer replaces a measured trip by an unknown one.** After a restart the server re-reads the
  whole log and offers every trade run again, but the balance history of the runs it did not watch is gone (memory only):
  their net and fees came out unknown, and the stored trip (the frozen, measured one) was overwritten with `null` net and
  `null` fees. The session total silently fell back to the run's gross margin (186 568 instead of 143 000 in the replay),
  and the run left the net ratio of the route calibration. A trade trip is now replaced only when the run grew (a later
  sale) or when the new version loses nothing the stored one measured.
- **A run that grows after a restart keeps what was measured.** Same cause as above, for a run that also got a later sale
  while the server was down: its measured net and fees were replaced by unknown ones. A known figure is never replaced by an
  unknown one: they are kept, the trip carries the new optional tag `figures_from_before` (they do not cover the last
  lines, withheld without the balance like `net_doubtful`) and its net is flagged doubtful, so the calibration and the
  efficiency against the plan leave it out. The session file stays version 2 (an additive optional key; an older build
  drops it harmlessly).
- **A reward paid inside the window of a cargo sale is no longer added to the "probable rewards" by the sale's own changes.**
  When the fee of a sale could not be measured because of the reward, the sale's changes were read as probable rewards (the
  total exceeded the reward by the sale's revenue). A variation on the side of such a line, inside its window, is now
  `unexplained` and `ambiguous` with both causes named; the sum invariant holds.
- **Fees deduced from the balance (`estime`) no longer feed anything else.** Gross margin minus net may hold a reward or a
  purchase made elsewhere (first run with a stream gap: nothing to compare with). They are no longer carried to the next run
  as its reference rate, no longer net the plan, and no longer enter the fee rate of the route reliability. The card says
  "estimé, flux interrompu ou fenêtre illisible" and that the figure may hold another spending; the "next run" tile names
  the origin of the rate it nets the plan with (`planned_net.rate_from`: the earlier run's, never the deduced one). Fees
  measured before a restart on a run that grew are not in the fee rate either.
- **The session's efficiency against the plan no longer counts a net the commerce model flagged doubtful.** A reward paid
  during the run, or fuel bought elsewhere, is in the balance variation; the calibration already left such a net out, but
  `money.plan` of `sc_session_current`, `sc_session_list` and `sc_session_stats` (and the session bar) still compared it with
  the plan: 113 % of the plan for a run that made 79 % of it, or a negative efficiency after 500 000 of fuel. Such a trip is
  now left out of the plan comparison (the session total stays the raw measure of the balance, flagged on the trip).
- **`fees_method` leaked what the balance did, without the balance.** `sc_session_current` (the text the model reads and the
  structured copy the View reads) gave `fees_method` (`mesure`, `estime` or null) with no `include_balance`: it tells that the stream was cut around the
  sales, or that the balance moved for another reason, which the neighbouring `net_doubtful` and `net_kind` already hid. It
  is withheld with them.
- **The commerce card now counts a rejected sale of zero as failed**, as the trade journal does (the card dropped any line
  without a positive amount, so it said 1 failed line where the journal listed 2).

## [2.3.0] - 2026-11-04

### Added
- **Route reliability: what your own saved runs say about the planner's profit.** UEX prices are crowdsourced estimates,
  so a planned profit is a guess; the completed trade runs that carry a planned profit now say how the realised result
  compares with it, per goods and per route (`src/providers/sessions/calibration.ts`, a pure module). Realised gross
  margin over planned profit (pooled, with median, minimum and maximum), net over planned profit (only with net and fees
  both known), fees over turnover; the plan is scaled to the quantity really moved; no figure below 2 runs and the number
  of runs always shown; a confidence label (`none`, `low`, `medium`, `high`) from the number of runs, the spread and the
  age; runs older than 60 days or from another patch line are left out, only the last 8 per group count; a figure is
  never carried from one commodity to another; a plan under 1 000 aUEC is ignored and a ratio above 500 % is shown as "écart
  très élevé"; a net that holds a purchase made elsewhere (what the margin and the fees leave unexplained above 2 % of the
  turnover, or flagged doubtful by the commerce model) is left out of the net ratio and counted. Shown in `sc_session_stats` (`route_reliability`), as a quiet line under
  each suggested route of the action bar, in the commerce card's "Si tu refais ce trajet" tile (calibrated net
  expectation, an estimate), and in a sentence of the server instructions and the `trade_copilot` prompt. Every ratio is
  derived from the balance: it exists only where the balance is shown (not in the tool without `include_balance`, not in
  the poll of a View that did not ask, not on the channel between Views, not in `ui/update-model-context` or the message to
  the agent). Docs EN/FR, SECURITY.
- Session file version 2: a trade trip also keeps the plan's quantity and terminals, how the plan was tied to the run,
  how the fees were obtained and what the balance holds beyond the run (all optional, null for older trips). A version 1
  file is read as is and, before the first write in the new format, copied once to `sessions.json.v1.bak` (an existing copy
  is never overwritten). A build that only knows version 1 opens a version 2 file read-only, in memory, with a notice: the
  data is not lost.

- **Health strip and legend in the live dashboard: the page explains what is wired and what is missing.** A new player
  used to get a dashboard that silently showed less than it could (no connection state without the game log, no trade
  journal or ledger, nothing with telemetry off, only "Jeu lancé sans télémétrie" for a game started without the
  variable). A compact block under the header now lists what is missing, what is lost and the exact fix, with a copy
  button (a selectable text and "Ctrl+C" when the host refuses the clipboard). It is invisible while nothing needs
  doing; the "?" button in the header opens the full list of eight lines (telemetry, game log, registration line,
  connection state, trade journal and ledger, saved sessions, balance, data freshness) with "Tout est branché", and
  the legend "Comment lire ce tableau" (Mesuré, Calculé, Estimé, Probable, Inconnu, each with a glyph: colour is never
  the only signal), which is also shown at the first open.
  - Server: a small `health` object in the `sc_live_poll` answer (`src/dashboard/health.ts`, pure): codes, the name of
    the log setting (`SC_INSTALL_DIR` or `SC_GAME_LOG_PATH`, never its value) and a fixed label (`LIVE/Game.log`,
    `Game.log`, `custom`), never a path. Built from facts the server already holds: no new network, no new file read,
    nothing read at all while telemetry is off, no amount, outside the section hashes. The session manager now keeps the
    time of its last write in memory; the telemetry service exposes the game-log hint it already holds.
  - View: every code is re-validated in the page (the whole object is dropped when a `log`, `registration` or `sessions` code is unknown; an unknown `via` or label is dropped alone), also for what
    arrives on the channel between dashboards. No new live region. One best-effort flag in the browser's storage
    (`sc-copilot-help-seen`), never required; the two tests that forbade any use of `localStorage` now pin that single
    use.
  - The built page goes from 382.9 kB to 405.0 kB with the strip alone. A separate commit, `compact` in `page.ts`, sends
    the View functions without their indentation and brings it to about 331 kB; the page budget of `check:page-size` is
    now 360 kB. `npm run test:built` (run in CI after the build) runs the dashboard tests against the compiled page.
  - Where the browser's storage is unavailable the legend no longer opens at each open: it opens only when something
    needs setting up, and closing it is kept in memory. After "Compris" or "Plus tard" the focus goes to the "?" button.
  - Docs: `docs/TELEMETRY.md` and `docs/TELEMETRY.fr.md` (live dashboard, troubleshooting), `SECURITY.md`. Item 8
    (SCMDB and UEX ages) is not measured by the page: it needs the sources, so the network; the line points to
    `sc_data_status`. `npm run doctor` is unchanged: its facts (Claude config, user variable, port) are not available at
    runtime, so the two do not share code; the strip points to it.

### Fixed
- **A planned profit was never saved with a trade run in the real game.** The journal names goods by an id (the first 8
  characters of a GUID), the plan by a name, so the commerce model's name comparison always said "non vérifié" and the
  saved trip carried no plan: the efficiency against the plan had nothing to compare. A plan is now also tied to the run
  by its prices, strictly (average buy and sell prices each within 15 % of the plan's, a known bought quantity within a
  factor of 2.5 of the plan's, a positive realised unit margin between half and twice the plan's; a run that fails a test
  leaves the plan free, and the closest of several candidates takes it), recorded as `plan_link: "prices"`. Such goods are
  never verified: the calibration, its line and its tile say "marchandise non vérifiée (lien par prix)", the confidence is
  capped at medium, and the session figures count them (`price_linked_trips`, label suffix "(lien par prix)").
- **Tests that failed intermittently on a loaded machine.** Under CPU load (several suites at once plus busy-loop
  processes) 15 of 15 runs failed on at least one test; they all pass now. Causes, fixed at the root and without
  weakening an assertion: real-clock thresholds (`Date.now() - started < X`) replaced by injected clocks, counted
  work (bytes copied by the gRPC framer, field budget of the decoder), frozen timers or lower bounds; sleeps used to
  wait for a socket or a timer replaced by waits on the event itself; the fake game no longer drops a frame sent
  before its stream is registered; "nothing listens" tests use a port no test server can be handed (`UNUSED_PORT`)
  instead of a port just closed. Where real I/O is the point, the limit is a generous hang detector rather than a
  speed claim: the default test timeout goes from 5 s to 30 s, and to 120 s for the 400-round ledger read test and for
  the session-store tests (one fsync per change, dozens per test).


### Changed
- `npm run test:stress` (local, not in CI) runs the suite under CPU load and lists the tests that fail; the rules for
  time-dependent tests are in CONTRIBUTING.md ("Time in tests, and running the suite under load"). Test support only:
  no product behaviour changes.

## [2.2.0] - 2026-11-04

### Added
- **Commerce action bar in the live dashboard: find the next route.** Four buttons in the commerce card ("Plus
  rentable", "Plus rapide", "Plus sûre", "Gros gain") ask the trade planner (`planTrips`, the code of `uex_plan_trade`)
  for routes ranked by profit per hour, shortest cycle, fewest risk factors of its heuristic, or profit per trip. Folded
  options: avoid Pyro, armistice zones only, player reports required, round trips only (hides the open A>B>C chains), a
  budget, the hold (prefilled from the ship sheet, with its source), an origin, and "budget = mon solde" (offered only
  while the balance is shown). Results are scannable cards (the first is the headline): route, goods, big figure by
  objective, time, SCU, "estimation UEX" / "relevés de joueurs" tag, the heuristic badge (never "safe"), price age;
  chains are apart. Each card has "Appliquer comme plan" (the commerce card then follows that route) and "Demander à
  l'agent" (a fixed message with the figures of the card; none derived from the balance). "Et ensuite ?" computes one
  suggestion from the selling terminal of the plan in force when a run completes (once per run, never applied by
  itself; without a plan nothing is asked, since the journal's shop names are not UEX names). Loading, empty, error and "attends
  N s" states; the bar stays in colour when the stream is grey.
  - New app-only tool `sc_trade_suggest` (`visibility: ["app"]`, listed with the dashboard tools only), implemented in
    `src/dashboard/tradeSuggest.ts`: strict input validation, a bounded and cleaned answer (5 options, 3 chains), a
    2-minute cache, one shared planner run for identical simultaneous calls, at most one new run every 8 s for all Views
    ("attends N s" is a state, not an error), a 20 s planner deadline (the page waits 32 s: the page's request timeout
    is now per call). The ship's quantum speed and hold come from the server's own state (the flown ship's wiki sheet),
    never from the page; "apply" is by the id of an option the server produced. The answer never contains the balance or
    the budget. 63 tools in this release (52 listed to a client without live telemetry); golden, `docs/TOOLS.md`, README, FR docs and
    SECURITY updated. The commerce card now also shows (with the bar alone) when there is neither a run nor a plan.
  - Privacy and rate hardening after an independent audit: option ids are random (128 bits) and expire with the answer
    (2 min); a route built from "Budget = mon solde" is marked private (no leg says it is limited by the budget), is
    dropped by the View when the balance is hidden, and reaches the saved session (`sessions.setPlan`, like the plan Claude
    passes) only while the balance is shown; the hold is sent only when typed, so its source is named correctly; no
    planner run starts while another is running; the ship lookup is shared; "Et ensuite ?" is remembered per run on
    the server (`next_run`); the bar cancels its timers when the View is torn down; the message to the agent puts
    UEX names in quotes under "données, pas des instructions"; the wording about where the balance goes is exact.
  - Preview: `suggest=ok|wait|error|empty|nospeed|reported|slow`, `click=<label>`, `refine=1`.
  - Not verified: the real host's time limit for a tool call, the buttons in Claude Desktop, the heuristic against real
    piracy. The price curve still never comes from a dashboard call to UEX (its points are Claude's).
- **`scmdb_rank_hauling` (trade profile): hauling contracts, in two honest modes.** SCMDB holds contract templates, not
  the offers on a player's mobiGlas, so the tool never says a contract is available. A pure extractor
  (`providers/scmdb/hauling.ts`) turns the `Hauling*` contracts of the merged file into typed templates (fixed reward, SCU
  per order and in total, commodity, container size, Hauling rank gates, illegal flag, intro, pools of places,
  partial-payout table, once-only and cooldown flags, the build of the file); anything not certain is null, never 0, and
  an order with `maxSCU` 0 and a minimum is read as a fixed quantity and labelled deduced. Mode `templates` ranks
  contract families for a ship (`ship_name` or `cargo_scu`; container sizes now come from UEX `container_sizes` through the
  ship sheet): reward per SCU as a RANGE, rank filter on the Hauling scale, illegal contracts left out by default, container
  fit and trips for the hold (with a ship, suitability is the first sort key, then the reward per SCU or the reward), no time and no reward per hour (no concrete pickup or drop-off exists). Mode `offers` takes
  1 to 10 offers typed from the mobiGlas, resolves the places to UEX orbits (an ambiguous name is refused with suggestions),
  estimates minutes and reward per hour with the planner's travel model (8 minutes a stop and a 2 minute hop, both
  unmeasured; no time between star systems), forms bundles of offers that share a pickup orbit within the hold, and
  compares them with the best single offer. Labels: datamined, deduced, estimated, given by the player, unknown; nothing
  is measured and `timeToComplete` (unit not stated) is never used. At most 6 upstream requests per call (none on a repeat
  within 5 minutes), never a per-pair distance request, and the answer is cut to fit the output limit. Docs (English and
  French) and the frozen tool surface are updated.
- **Balance movement explainer ("Mouvements du solde")**: where the money went. A pure model
  (`src/dashboard/balanceMovements.ts`) labels every balance change of the game session, and of the exact window a run's
  net was read over, with at most one cause and an honest confidence: a log transaction that matches (`matched`), the fee
  on a cargo settlement (the commerce model's own reconciliation, `measured`), a shop item (`matched`), a probable
  contract reward or insurance/hangar cost (time proximity only, `probable`, amount from the balance), and everything
  else `unexplained`: fuel, repairs, fines and transfers leave no log line and are never given a cause; ambiguous
  candidates are flagged, not guessed, and a change across a cut in the stream is never explained. The amounts add up,
  to the aUEC, to the balance change (tested). The commerce card's "unexplained" warning now decomposes the net
  (margin, fees, items, probable rewards and costs, unexplained) and a folded block in the card's details lists the
  movements with a filter by category. All of it is built only when the View asked for the balance and never leaves it
  (channel, hash, model-visible text: tested). The ledger service keeps insurance, hangar and login events apart from
  its own list. Preview: `trade=movements&open=1`. Wording is strict: a rise after a completed contract is "Récompense
  probable de contrat"; a fall after an insurance claim or a hangar request is "Coût possible (hangar ou assurance)"
  (the log has no cost line, so any fall there qualifies, and no cause is named); the session text says "Rien d’autre
  n’est resté sans piste", never that all is explained; a shop item is matched before the cargo fee reconciliation, so it
  is not absorbed into a fee; fees measured next to another possible cause read "ambigu" on the card too.
- `npm run check:page-size` (run in CI after the build, listed in the quality gate): measures the dashboard page as it
  ships, from `dist/`, against a budget (410 kB; the built page was 382.9 kB). `tsconfig` now sets `removeComments`
  (the emitted View script no longer carries the sources' comments, about 19 kB). The vitest size test only measures the
  page as vitest transforms it and is a coarse guard. The size the host accepts for an MCP App HTML resource is not
  verified.
- **Commerce card in the live dashboard** ("Commerce"). It replaces the misleading "Prévu / Réalisé" block, which put a
  planned profit next to a balance change (the change also holds the goods bought, the sales and the fees). A pure model
  (`src/dashboard/tradeRun.ts`) turns the transactions of a run, the balance history and the plan into: planned profit,
  turnover, purchase cost, gross margin, price gap, fees, net profit (balance after the last sale minus the balance just
  before the first purchase), run time, net per hour and an extrapolation with its assumptions, plus the planned profit
  net of the observed fee rate. Fees are not in the game log: they are measured per side against the balance (a log
  amount matched with the balance change within a few seconds, labelled "mesuré") and, when that cannot be done, deduced
  as gross margin minus net and labelled "estimé"; unknown is shown as unknown, never as zero. The card shows the
  headline numbers (net profit, turnover, fees, the next trip), a waterfall from planned to real, fees per side, pace
  and projection, and a price curve ("cours") with the target price and the price really obtained; estimated figures are
  hatched and tagged, measured ones are solid. All amounts of a run are built only when the player shows the balance and
  never travel on the channel between Views or in a message to the model. The transactions come from the trade journal of the
  game log (`providers/gamelog/trade.ts`, the one behind `sc_trade_journal`): the ledger's reads (full, then incremental)
  also keep the commerce lines, and only the completed transactions count, exactly as the journal does (failed and
  unconfirmed ones are listed on the card, not counted). The dashboard parses nothing of its own. The gross margin follows the journal's own first-in
  first-out pairing (`pairCargoRuns`); a deduced fee total is refused when it is not a plausible fee (0 to 50 % of the
  turnover); the net is the variation of the balance and says how much of it the margin and the fees do not explain
  (a visible warning above 2 % of the turnover); sold stock that was not bought in the run is told; hourly figures
  rest on an observed cycle or on the run plus an assumed overhead, and "per 4 h of play" waits for two measured runs. Goods are shown by the
  journal's id (8 characters of the GUID) unless the plan names them; no wiki name lookup yet. The action bar of the
  next entry sits in a slot under the headline numbers.
- `sc_live_dashboard` plan: `buy_unit_price`, `sell_unit_price`, `est_trip_minutes`, `safety_note`, `price_points` (at
  most 30), `price_points_for`, `price_points_label`. Cleaned and bounded on the server and again in the page; the
  price curve never comes from a dashboard call to UEX (golden and docs/TOOLS.md regenerated).
- Preview: `trade=story|estimated|unknown|partial|second|none` and `fw=<px>`.

- **Trade intelligence (UEX), three tools in the `trade` profile.**
  - `uex_plan_trade` ranks one-way routes (from UEX `commodities_routes`), round trips A>B>A and two-leg chains A>B>C
    (the last two computed offline from one cached `commodities_prices_all` call) by estimated profit per hour, per run or by
    shortest run, sized to the hold (`ship_name` or `cargo_scu`) and the budget. It gives profit per SCU, per run and
    per hour and lists its assumptions. Travel time is an ESTIMATE: ship quantum spool-up plus distance divided by the
    quantum speed (wiki sheet, or `quantum_speed_ms`), plus a fixed time per stop (8 minutes, `stop_minutes`). The SCM
    speed is not used because UEX distances are in gigametres; the model matches the wiki's own figure (42 Gm in about
    176 s). Distances come from the route, else the `orbits_distances` matrix, else `terminals_distances`
    (`data: false` is an explicit "no data"). Prices older than 7 days are left out (`max_age_days`,
    `include_stale`); every leg has `price_age_days`, `stale` and `report_status` (`reported`, `estimate`,
    `unverified`: the price file cannot tell a player report from a UEX estimate, so the legs of the candidates are
    checked against `commodities_prices`). Each option carries `report_status`, an `estimate` flag and an
    `[ESTIMATE]` tag in its summary, and the answer counts them (`report_counts`); the ORDER follows the objective, not
    the report status (most UEX prices have no player report today). `min_reports` requires reports and drops
    options whose reports could not be checked; every failed check is named in `notes`, and a timeout or 429 stops
    the checks. `options` (one-way routes repeated, round trips: first purchase at the requested terminal or planet)
    and `chains` (open A>B>C, no return leg priced) are two lists, never ranked against each other. The plan has a
    25 s deadline, a failure of the UEX routes call degrades to the offline round trips, and the request count is
    15 to 28 typically, at most about 43. Fuel is not subtracted, and the answer says why with the measured age of
    UEX's fuel prices. Stanton to Pyro routes are not planned (the gate transit time is not in UEX). Each option
    carries a labelled safety heuristic (armistice flag and jurisdiction from UEX stations, cities and outposts,
    system, kind of place, number of flights): never a claim that a route is safe.
  - `uex_get_price_history` summarises `commodities_prices_history` for one commodity at one terminal: the points,
    low, high, mean, volatility, position of the latest price in the range and a verdict (high, low, normal) with the
    number of points it rests on. It always says SHORT HISTORY (about 10 snapshots) and gives no verdict under 4.
  - `uex_get_market_status` turns `commodities_status` and the `status_*` / `scu_*` fields of `commodities_prices` into
    shortage and saturation warnings. The legend is read side by side: when selling, level 7 means no demand.
- `fetchWithCache` shares one download between identical simultaneous requests and bounds its memory cache (300 entries).
- The planner is a provider-level function (`src/providers/uex/tripPlanner.ts`, `planTrips`) that the MCP tool wraps
  thinly, so other callers can rank options without going through the model.
- The `haul_plan` prompt uses the new tools; README, `docs/CAPABILITIES.md` (section 1, the profile sizes and counts),
  `docs/USING_WITH_CLAUDE*.md` and `docs/TOOLS.md` follow.
- **`uex_get_refining_margins`.** Which refinery is best for an ore, or which ore is worth refining most, from UEX
  (`refineries_yields`, `refineries_capacities`, `refineries_methods`, the ore-sales prices and the refined product
  linked by `id_parent`, which is one-directional for some ores). UEX has no ore-to-refined conversion ratio and no
  refining cost, so the tool ranks and never gives an aUEC profit: refineries by the yield bonus players reported
  (ties share a rank), ores by an index where the best is 100. The capacity value is shown with its unit marked
  unverified and is not used to rank. `refineries_audits` is never read (it carries a player's handle). The
  `mining_prep` prompt mentions it.
- **`uex_get_item_prices` and `uex_compare_items`.** Where to buy a ship component, weapon, armor piece or food
  cheapest (`items`, `items_prices`, `categories`), and two items side by side with their `items_attributes`
  (differences only for numbers of the same unit, no verdict on which is better). Every price row carries its age,
  a stale flag (over 30 days) and whether its game version is older than LIVE. `items_prices_all` (6.4 MB) is never
  called.
- **`uex_get_marketplace_prices`.** A player-market price guide from `marketplace_prices_averages`,
  `marketplace_trends` and, on request, `marketplace_prices_history` (capped by UEX at 1000 rows: the summary says when
  it is cut). Prices are converted from text to numbers; set, pack, stack and crate prices are bundles and stay apart
  from per-unit prices. Optional `check_price` places a price against the recent average. The deprecated
  `marketplace_averages` is not used.
- Trade profile: the profile grows by these tools (23 in this release). No fuel price tool: UEX's fuel prices are too old to rank refuel stops (median 43
  days; reasons in docs/CAPABILITIES.md).
- **Saved play sessions** (`sc_session_current`, `sc_session_list`, `sc_session_stats`, `sc_session_new`,
  `sc_session_end`; prompt `trade_copilot`; a session bar in the dashboard). The dashboard now works by session, and a
  session is kept in a local file written by this server (`sessions.json` in the per-user data folder,
  `SCMCP_SESSIONS_FILE` to move it), not in the browser: it is found again from any conversation, after a game crash
  and after a reboot. A session holds the balance at its start and at its last sighting, the trips (completed contracts
  of the transport ledger and completed trade runs of the dashboard's commerce model: cost, turnover, gross margin, fees and net, one pairing), the
  active time and the breaks. It resumes when the game is seen again within 3 hours (`SC_SESSION_GAP_HOURS`), else a
  new one starts; "Nouvelle session" and "Terminer" are in the bar and as tools. Statistics per session and across
  sessions (rate per hour, trend, best and worst session, best routes and goods, efficiency against the plan); an
  unknown figure is `null`, never zero; the result is on one basis (each trip's net, else its cargo run's gross margin) and a
  contract's balance change that overlapped a cargo run is left out so the run's sales count once. Writes are atomic,
  flushed, serialised by a lock file across server processes (owner token, touched while held, a crash's lock taken over
  after 5 s), bounded in BYTES (about 3 MB, the oldest sessions dropped first, far below the 16 MB the reader accepts),
  created 0600, kept in memory over the older file when the disk refuses a write (and said by `sc_session_new` /
  `sc_session_end`), and a bad file is set aside; a file from a newer version is never touched. The View's old flight
  counters are renamed "Compteurs de vol" and no longer touch the saved session. Before "Nouvelle session", "Terminer" and a
  clean shutdown the log is re-read at once so the last trip is kept. A game launched without the telemetry setting never
  gets a reader from the manager. Only with `SC_TELEMETRY=on`;
  `SC_SESSIONS=off` creates and reads nothing. **Amended rule, by the user's explicit decision:** session summaries,
  including balances and per-trip results, are now written to that one local file; frames, raw log lines, the handle,
  account ids, IPs and GUIDs are still never stored and no session data is sent over a network (session tracking makes no request) (CLAUDE.md, SECURITY.md,
  docs/TELEMETRY.md). Every aUEC figure still reaches the model, the dashboard poll and the channel between Views only
  with `include_balance` or the player's "show balance" choice. **Deliberate change of behaviour:** to capture the
  starting balance the server now keeps the telemetry reader alive while the game is believed to run (Game.log written
  in the last five minutes), instead of stopping it five minutes after the last request; without the game log it does
  not probe the port. Not verified in the real game.
- **Trade journal from the game log** (`sc_trade_journal`, profile `local`, read-only, off with the log). Per play
  session, newest first: every shop purchase and sale (`SendShopBuyRequest`, `SendStandardItemBuyRequest`,
  `SendShopSellRequest`) and cargo-kiosk purchase and sale (`SendCommodityBuyRequest` in cSCU, converted to SCU;
  `SendCommoditySellRequest` in SCU) with time, side, shop, quantity and unit, the TOTAL of the line, unit price,
  `auto_loading`, outcome and confidence. Item flows are paired with their `RmShopFlowResponse` (known); cargo success
  is inferred from the absence of a `RmToken_CommodityTransactionResponse` error within 3 s (the game logs only
  failures). Failed lines, sales of amount 0, unconfirmed lines and other currencies are listed and left out of the
  totals. Spending by category is inferred from the item class name. Cargo runs pair purchases and sales of one
  commodity first-in first-out into paired SCU, cost, revenue, GROSS margin and margin per SCU (estimated); there is no
  net figure and no balance, which the log does not have. `location_hint` is the last location token logged before the
  line, never a terminal. Commodity names come from the wiki's commodity list, matched locally on the resource GUID
  (six real GUIDs resolved; three agree with the log's own hauling-contract names), otherwise "unknown commodity".
  The parser is a pure module (`src/providers/gamelog/trade.ts`: `parseCommerceLine`, `parseCommerceText`,
  `buildTradeJournal`); `parseLog` keeps its commerce lines in a new `commerce` array, so the events of the log tools
  and their frozen schema are unchanged (note: `stats.recognized` now also counts these commerce and location lines,
  which were `ignored` before; the stats schema is the same). A cargo error line that follows several same-side
  requests within 3 s cannot be attributed to one: those lines are `ambiguous`, listed as unconfirmed and not counted.
  The answer is bounded to fit the 40 000-character output limit (rows, then runs, are cut, with a `truncated` note
  and counts). Verified on the author's logs (March 2025 to November 2026): 183 item
  requests all paired with a response, 79 cargo requests, 12 cargo errors each within 2 s of its request. The 4.10 cargo
  sale format rests on two lines of one session (3 November 2026); the earlier research note that found no sale after
  March 2025 predates them.
- **Server `instructions` (trade copilot operating manual).** The MCP `initialize` result now carries a compact
  manual (`src/instructions.ts`, at most 3 500 characters, ASCII, 3 000 today; the rules that must never be lost come
  first): honesty (never invent a number, `data_age` against `cache_age`, `[ESTIMATE]` markers, measured against
  estimated), the live rules (never `sc_live_poll` or `sc_live_mark`, one dashboard, balance only with
  `include_balance` after asking, never "the game is not running", the `connection` state, telemetry never called
  safe), which trade tool for which intent (planner, routes, price history, market status, refining, items,
  marketplace, journal) and how to accompany (one main option and up to two alternatives with the risks, a next step
  at the end, a debrief from the journal). Tests bound its length, check that it is plain ASCII with no link, that
  every tool it names exists in the registry, that the critical rules sit in its first 2 000 characters, and that a
  client receives it. The per-tool descriptions are unchanged (golden and `docs/TOOLS.md` too). Claude Code passes the
  field to the model; Claude Desktop and claude.ai were reported not to (open issues, November 2026), so the pasted
  block stays the reliable channel there until the canary test says otherwise.
  `check:docs` treats `src/instructions.ts` like the prompts: a link to an API host fails there too.
- Prompt `trade_review`: recent purchases and sales from the game log (`sc_trade_journal`), the cargo runs with their
  gross margin (never presented as net), whether the sale prices were good (`uex_get_price_history`), what to change
  and the next run (`uex_plan_trade`).
- `docs/USING_WITH_CLAUDE.md` and `.fr.md`: which part of the pasted block the server instructions make redundant, a
  trade accompaniment line in rule 3, and a canary test (three questions and the expected behaviour) to check in
  Claude Desktop or Claude Code whether the instructions are honoured.


### Fixed

- **Low-severity findings left open by independent audits** (one fix each, each with a test).
  - `scmdb_rank_hauling`, offers: `stop_minutes` is used to the second (0.4 was rounded to 0, 0.5 to 1; the answer's
    `time_model.stop_minutes` shows the exact value). A route that takes 0 seconds (0 minutes a stop and a pickup that
    is also the drop-off) has a null hourly figure with the reason "no travel time", is never the best single offer and
    no longer makes `vs_best_single` 0 or NaN. A drop-off at a pickup visited BEFORE its own cargo was loaded now costs
    the second pass (it was left out); one at its own pickup or a later one stays free. A wrong `quantum_speed_ms` is refused before any UEX or wiki request.
  - `scmdb_rank_hauling`, templates: a merged family is flagged `deduced_fixed_quantity` if ANY merged variant is (the
    fingerprint does not tell a `[288,288]` variant from a `[288,0]` one); a contract that can roll 0 SCU no longer
    reports 0 trips.
  - Saved sessions: the "total partiel" notice is also shown when only gross margins are known (the overlap case); a trade
    run stored twice by an older build no longer counts twice in turnover, cost, fees and gross margin, is no longer
    reported as a left-out contract (`overlap_excluded`) and no longer makes `net_complete` false (the trip counts still
    include the copy); orphan
    `.stale-<pid>-<hex>` files of killed lock takeovers are swept like the `.tmp` files.
  - `sc_trade_suggest`: a private (balance) budget cannot be probed through the cache. A private lookup is rate limited
    like a run (one per interval, hit or miss, taken even when the general throttle then refuses), and a cached answer is
    only served to a caller in the same private context (already true through the cache key; now also checked). Cost: two
    Views asking the same private question at the same moment no longer share one run, and a re-click within 8 s is
    throttled instead of served from memory. A typed budget keeps its free cache.
  - `npm run check:sources` also probes the SCMDB hauling fields the extractor reads (`haulingOrders`, SCU, container
    size) and UEX `container_sizes` (not run here).
  - README (EN and FR): the `local` profile has 24 tools, not 12 (as `docs/TOOLS.md` says).

### Changed
- Prompts `haul_plan` and `session_debrief` now say exactly what the answer must contain (a ranked list with the
  numbers, the assumptions, the estimate markers, one next action) and `session_debrief` reads the trade journal when
  you traded. Every prompt now ends with "never invent a number" and "answer in the language I write in".
- The transport ledger's last line is "Récompense mesurée, dernier contrat" (a contract's balance change is the reward
  minus what it cost, not a profit) and the planned line says "avant frais". The ledger payload budget is 26 000
  characters (it also holds the commerce section).

### Removed
- `planProgress` (the "Prévu / Réalisé" comparison of the plan card).

## [2.1.0] - 2026-11-03

### Added
- **Correction on the transport ledger steps.** The pickup and drop-off step lines (`CreateHaulingObjectiveHandler`) exist in game logs up to spring 2025 and are absent from the 12 build 4.10 logs of the reference install, so on current builds the ledger shows contracts, times and the measured gain but no steps (cause not verified); the documentation said otherwise and is corrected.
- **Transport ledger in the live dashboard** ("Carnet de transport"). Links the game log (contracts, pickup and
  drop-off steps with place and goods) to the balance change the telemetry measured. A full-screen panel and, while a
  contract runs, one line in the small view. It shows what the log gives (title, times, steps, duration) and never a
  quantity or a reward, which the log does not carry. The gain of a completed contract is the balance after minus the
  balance at acceptance, marked `mesure_brute` and `mixed_flows_possible`, unknown (never zero) when the telemetry did
  not see the balance, with the pace over the session and, if Claude passed a route plan, planned against measured.
  Everything derived from the balance is built only when the View asked for the balance. The poll answer gains an
  optional `ledger` section of the delta protocol (`have.ledger`, `hash.ledger`, `unchanged`; the hash is computed from
  the content built for that balance choice, so a hash never stands for an amount the View was not allowed to see; the
  input schema of `sc_live_poll` gains `have.ledger`, golden and docs/TOOLS.md regenerated). On the channel between
  Views the ledger travels without any balance-derived field. The log is looked at at most every 5 seconds and read
  only when its modification date changed, then incrementally (only the bytes added, with a look-behind; a shorter
  file, a new session or a UTF-16 log starts again with a full read), and the poll never waits for it. `TelemetryService` keeps a bounded in-memory
  history of balance changes for it (no tool returns it). Without the game log the panel says so and points to
  `sc_log_status`. Steps are ticked from the count of objective notices (an estimate) and the balance is read 10 s
  after a contract ends (an assumption); neither has been measured with the real game.
- **Connection state from `Game.log`.** The stream does not signal a disconnection (a player kicked for inactivity
  still saw a calm dashboard). A small state machine reads the game's own lines (joined a server, channel cut by the
  server with its code, back in the menu, quit) and reports `online`, `menu`, `disconnected` (30028 = inactivity) or
  `closed`: `sc_live_status` and `sc_live_state` carry `connection` with its meaning, `conditions` are emptied, and the
  dashboard shows a red "Déconnecté du serveur" banner at once, greys the values, feeds no curve and never says "no
  alert". Checked against a real log: both kicks of the session were found, with the menu and rejoin in between.
  One `stat` per poll, incremental read, no personal data kept; absent when the log is not configured.
- **Dashboard v2.** A cockpit for the live dashboard: compact view with three dials, the ship banner, conditions and
  a one-line verdict; full screen with a speed dial (deduced, labelled scale), a G dial, altitude, vertical speed bar,
  compass (only when the heading is valid), 60 second curves, hydrogen with an estimated range, boost, power diagram,
  warning-light panel, weapons summary, countermeasures against the highest count seen, pilot dials, one chronology
  with filters, unverified values card. Pins go to a bar, confirmations to a toast next to the buttons, a switched-off
  ship gets a calm view. One set of tokens, light and dark through the host variables, 360 to 2000 px.
- **State alerts (`conditions`).** `sc_live_poll` and `sc_live_state` carry what is true now: shields off (info in
  quantum mode, warning otherwise), shields down, powerplant off, engines, weapons, hostile lock, hits, proximity,
  hydrogen, boost, countermeasures, health, hunger, thirst, breathing, quantum, jump. Events `shields_powered_off` and
  `shields_powered_on` (measured on a real Harbinger; the first with the quantum context).
- **Coverage table.** `coverage.ts` decides what becomes of every field of the stream; a test fails when a schema field
  has no decision; the Coverage section of docs/TELEMETRY.md and .fr.md is generated from it (`npm run docs:coverage`).
  The unverified values travel under `unverified` in the poll and are labelled in the page.
- `sc_live_dashboard` returns a `hint` (and says in its description) not to open a second dashboard when one is open.
- **Dashboard gauges against the ship's real limits.** The flown ship (class name of the stream, for example
  `AEGS_Vanguard_Harbinger`) is matched in the background to its Star Citizen Wiki sheet: one search per ship and per
  session, never in the poll's hot path, never while telemetry is off, retried at most every five minutes after a
  failure, no new host. Only one candidate is accepted (the row carrying the very class name, or a single match by
  words); several candidates give `ambiguous` with their names, none gives `unknown`. `sc_live_poll` carries the
  optional `specs` field (status, name, SCM and maximum speed, cargo SCU, shield and hull points, age, candidates) as
  a fourth section of the delta protocol (`have.specs`, `hash.specs`, `unchanged`): it is sent once, then left out
  while it is the same. The speed dial gets SCM and maximum marks on its arc and a value in percent of the SCM speed,
  says when the speed is beyond the frame (above the sheet's maximum, quantum jump), and its scale line reads "d'après
  la fiche (wiki)"; without a usable sheet it keeps the scale deduced from the speeds seen and says why. Values of 0 are
  not provided. The hydrogen tank capacity is not confirmed in the wiki data and is not shown: the hydrogen endurance
  stays the labelled estimate. Documented in `docs/TELEMETRY.md` and `docs/TELEMETRY.fr.md`.
- **Optional live telemetry, off by default.** The game has an undocumented local telemetry server; with two explicit
  switches (`SC_TELEMETRY=on` on the server, `GRPC_CLIENT_SERVER_ENABLED=true` in the RSI Launcher's environment) the
  server reads it on `127.0.0.1:2942` and nothing else. No new dependency: a hand-written protobuf decoder and
  `node:http2`. Without `SC_TELEMETRY=on` no HTTP/2 code is loaded and no connection is made
  (`npm run check:telemetry-silence` proves it).
  - Tools `sc_live_status` (always listed), `sc_live_state` and `sc_live_events` (listed only when telemetry is on);
    kind `local_telemetry`. The aUEC balance is withheld unless `include_balance` is true.
  - States `off`, `waiting`, `game_without_telemetry`, `connected`, `live`, `incompatible`; derived events with a
    `confirmed` / `unverified` flag; a source line in `sc_data_status`.
  - `npm run telemetry -- status | enable | disable` (dry run unless `--apply`; a byte-faithful, backed-up edit of one
    key of the Claude Desktop configuration; `--session` for one launch only), and a section in `npm run doctor`.
  - [docs/TELEMETRY.md](docs/TELEMETRY.md): what the stream contains and does not, privacy, troubleshooting, and the
    risks of using an undocumented game feature. The schema file comes from Wingman AI (GPLv3), see THIRD_PARTY.md.
- **[docs/CAPABILITIES.md](docs/CAPABILITIES.md)**: every capability by need, checked against the code by a test.
- **Contribution policy** in CONTRIBUTING.md (automated and AI-assisted contributions welcome; the project pays
  nothing) and `npm run check:docs`, run by the tests and by CI: it refuses invisible characters, HTML comments,
  unreviewed link hosts and translation drift in the files Claude reads.
- French README and Claude block (`README.fr.md`, `docs/USING_WITH_CLAUDE.fr.md`), contributed by an external author.
- `ToolDefinition.advertised`: a tool can be left out of `tools/list` while its feature is off.
- **Live dashboard (an MCP App), optional.** With live telemetry on, Claude Desktop can show a live dashboard in the
  conversation: ship, speed, hydrogen, health, state of the stream and recent alerts inline; instruments, warning
  lights, power flags, weapons, countermeasures, vitals, events, session timeline, pace and estimates in full screen.
  Every value shows its age and greys out when the stream is not live; nothing is invented.
  - Tools `sc_live_dashboard` (opens it; optional `plan` of a trade route, compared with the measured balance change),
    `sc_live_poll` and `sc_live_mark` (reserved to the page). Listed only when `SC_TELEMETRY=on` and the client
    declared the MCP Apps extension: Claude Code never sees them. Without telemetry the server announces no
    `resources` capability and serves no resource.
  - The aUEC balance is hidden until the player clicks; the poll carries it only on request, and it never enters
    `ui/update-model-context`. Only the button "Route avec mon solde et ce vaisseau" sends it, saying so.
  - Polling about once a second, suspended when hidden, off screen or torn down, slowed when the stream is cut, shared
    for 500 ms between all the dashboards of a conversation.
  - `tools/list` entries carry `_meta` (frozen in the golden file) and `registry.list(context)` takes the client
    context; `scripts/dashboard-preview.mjs` previews the page against a fake host.
  - Documentation: the "Live dashboard" section of [docs/TELEMETRY.md](docs/TELEMETRY.md), a rule in the Claude block,
    troubleshooting, architecture and the threat model.

- **French translation of the live telemetry page**, [docs/TELEMETRY.fr.md](docs/TELEMETRY.fr.md), linked from
  `README.fr.md` and from the English page; `npm run check:docs` compares the pair.

### Changed
- **Only one dashboard polls.** The Views of one conversation elect a leader over a `BroadcastChannel` (the most recent
  visible one); the others stop calling the server, show a banner with a take-over button and follow the leader's
  answer (no balance, no wallet event on the channel). Before: 1, 3 and 5 open dashboards made 1, 3 and 5 calls per
  second to the host; now always 1 (measured against the fake host). Without `BroadcastChannel` the old behaviour
  applies and a View away for 30 seconds retires.
- **Lighter polls.** `sc_live_poll` takes `since_seq`, `have` (section hashes) and `include_static`: events already
  held, unchanged sections and the static list are not sent again (3810 to 2185 bytes a second on the made-up flight).
  The shared cache is unchanged; the answer is cut per request after it. The input schema of `sc_live_poll` changed
  (golden and docs/TOOLS.md regenerated). Curves keep 62 seconds (estimates 2 to 5 minutes) with a hard ceiling, and a
  View that is torn down releases every listener, observer, timer and channel.
- The pins of the compact view are replaced by a pin bar fed from icons on the cards.
- **`provenance.data_age` is now the age of the data itself**, from dates the source gives (UEX `date_modified` of the
  rows returned, the SCMDB channel's `generated_at`); `null` with `data_age_note` when the source gives none. The old
  meaning (age of the fetch or cache) is the new `provenance.cache_age`, also used by `sc_data_status`.
- `uex_get_commodity_prices` answers `buy_locations` and `sell_locations` (cheapest / best first, `limit` default 15,
  max 50, with totals; `side` keeps one), leaves out rows of an older game version than LIVE and counts them
  (`excluded_older_version`, `include_older_versions` to keep them), and adds `updated_at` to each row. Rows of a
  version newer than LIVE are kept and counted (`newer_than_live`); without a known LIVE version nothing is excluded.
  Rows reported by players come before UEX estimates (`is_estimate`, `estimates` count per list).
- `uex_get_trade_routes` ranks routes with a UEX estimate (`is_estimate`, 0 reports at an end) after reported ones;
  new `min_reports` drops them. UEX dates no route price (its `date_added` is the recalculation time), so route
  answers have `data_age: null`. Only `date_modified` is read as a date; ship price rows carry `updated_at`.
- The SCMDB tools are now `untrusted_text` (they return free text written by others) and `sc_fleet_get` too (wiki
  text). Their searches ignore case, accents and punctuation and fall back to close spellings with a "did you mean"
  note, so `quantanium` finds Quantainium; a filter that matches nothing says so. The unit of `time_to_complete` is
  stated as unknown, because no source proves one.
- `sc_fleet_get` shows disagreeing UEX and wiki values side by side (`conflict`, crew and cargo) instead of choosing
  one, and treats a wiki speed of 0 as not provided.
- `sct_search` returns a readable list (title, excerpt, URL); a MediaWiki error is an error, not "no result".
- The server announces itself as `sc-copilot-mcp` (it said `star-citizen-mcp`).
- `sc_data_status` and the error paths of the SCMDB tools clean the strings they pass on; the untrusted-text fence is
  also neutralised inside JSON values.

### Security
Fixes for the findings of an independent security audit (each checked by a test that builds its attack from code
points and uses no network).
- **Invisible characters are removed by Unicode category**, not from a list of ranges: format, private-use,
  surrogate, unassigned and control characters, and variation selectors. The tag block U+E0000-E007F ("ASCII
  smuggling"), U+FE00-FE0F, U+E0100-E01EF, U+061C, U+206A-206F, soft hyphen, the Hangul, Khmer and braille blanks and
  the combining grapheme joiner no longer get through; NEL, U+2028 and U+2029 become a newline.
- **Errors are no longer outside the envelope.** What a remote server says in an error (the UEX `status` and
  `message`, the starcitizen.tools error text, a remote error body) is cleaned, cut at 300 characters and fenced
  like untrusted text; names quoted in "fits several ships" errors are fenced; no error message, including one a
  tool builds itself, keeps an invisible character or grows without bound. Our own wording stays readable.
- **Third-party text under `structured` trust.** Game and build versions from UEX, the wiki, the game log, local
  files and the dump repository are cleaned and cut at 80 characters where they enter, so `provenance.game_version`
  and `sc_data_status` cannot carry a sentence; the per-row versions of `uex_get_trade_routes` and
  `uex_get_terminal_inventory` get the same treatment. A patch-dump tag that is not a plain build string (a sentence)
  is dropped, and the collection names a dump lists are fenced in the errors that quote them. **Trust changes you
  will see (nine tools now `untrusted_text`, with the notice and cleaned, bounded strings):** `sc_list_builds` and
  `sc_diff_versions` (the dump repository is configurable), `scw_get_filters`, and the UEX tools that hand rows back
  unprojected: `uex_get_commodity_prices` and `uex_get_ship_prices` (both in the `core` profile),
  `uex_get_commodities`, `uex_get_commodity_averages`, `uex_get_commodity_ranking`, `uex_get_terminals`. New guard
  tests fail if free text from UEX, the wiki or the dump repository reaches a `structured` tool, as one already did
  for SCMDB.
- **The installer no longer rewrites the whole Claude Desktop config.** `npm run install:claude` inserts or replaces
  only the `sc-copilot` entry, as text (CRLF, indentation, BOM, `1.0` and integers above 2^53 of the other servers are
  kept); when the result is not exactly what was expected it writes nothing and prints the entry to add by hand.
- **The installer preview no longer prints a secret** already in the file: for an entry it replaces it shows the
  names of its `env` keys, never the values (other keys and arguments that name a secret are hidden too).
- **A collection name could leave the build cache folder** (`ships__../../../x` in `sc_diff_versions`). It is now
  restricted to letters, digits, `_`, `-` and `.` without `..`, and the resolved path must stay inside the cache;
  the dataset name of `collectLabels` gets the same check as the other local readers.
- **`npm run check:docs` hardened** after an independent audit executed bypasses that the check accepted:
  - Invisible Markdown: a link definition (`[//]: # (text)`, `[x]: <>`) must be used, point to a reviewed URL or a
    file of the repository, and carry no title; links and images with a title are refused.
  - Every link target is judged: bare `www.` addresses, e-mail addresses, `<...>` links, images, `srcset`, and URLs
    in HTML attributes; a relative link must name a file or folder that exists.
  - A lone carriage return (it hides text in a terminal) is refused; CRLF stays allowed.
  - Look-alike letters: any letter outside the Latin script (whole words included), any character that NFKC folds
    into another (fullwidth, mathematical, circled...), Latin look-alike blocks, non-ASCII digits and slash-like
    punctuation are refused in every tracked text file (the ellipsis is tolerated). No file needs an exception.
  - Extensions are compared without regard to case and cover `.markdown`, `.mdx`, `.mdc` and other prose formats;
    translations too.
  - github.com is allowed under reviewed project prefixes only (`ALLOWED_PATH_PREFIXES`), not for any path.
    Credentials in a URL, ports, punycode hosts and non-https schemes are refused; hosts are compared in lower case.
  - YAML and JSON files, `.claude/` and all of `src/` (tests and `testing/` helpers aside) are now checked for link
    hosts and look-alikes; prompts, tools and configuration also for comments and tags. The lock file is checked for
    entries that do not come from the npm registry over https.
  - `package.json` scripts with a URL, a network command or an npm lifecycle hook, and any hook, script or
    setting under `.claude/`, are reported for review.
  - CONTRIBUTING.md lists what the check does not detect, and no longer says "no native code" without nuance:
    production dependencies have none, development tools ship prebuilt native binaries.
- **Live telemetry reader hardened against a local program that pretends to be the game** (port 2942 has no
  authentication). Found by an independent audit that ran the attacks:
  - A 1 MiB frame of empty weapons gave 500 000 entries (250 ms, 65 MB of heap) and a 21 MB `sc_live_state` answer.
    Now at most 64 weapons, 16 countermeasure entries and 32 game events are decoded per frame (the surplus is
    ignored and noted as an anomaly), a frame with more than 5 000 fields is refused, and `sc_live_state` /
    `sc_live_events` cut their lists under 40 000 characters and say so. The 1 MiB message limit is kept.
  - A flood of empty messages used about half a core. Frames are now decoded at most about 33 times a second: the
    newest frame of a burst is kept and handled in the next slot, all frames are still counted in
    `frames_received`. The game's ~17 frames a second are unaffected.
  - The gRPC framer copied the whole buffer on every chunk. It now keeps a list of chunks and joins them once per
    message (100 000 one-byte chunks: well under a second).
  - Event data is cut to 80 characters per value (the ring already held 200 events and names are filtered).
  - The handler tracks 8 countermeasure kinds at most (a program could invent a new one per frame).
  - Limits are documented in `docs/TELEMETRY.md` and `SECURITY.md`.

### Fixed
- **Telemetry no longer says the game is off when it is not.** Measured with the real game: the first
  `sc_live_status` or `sc_live_state` call started the reader and answered `waiting` before the first connection
  attempt had finished, and the model told the player the game was not running. Now the first request waits (at most
  1.5 s) for the first outcome of the first attempt; a peek (`status(false)`) still never starts or waits.
- `connected` is reached as soon as the HTTP/2 session is open, the server's SETTINGS are received and the call is
  open, even when the game sends its response headers only with the first frame (menus). A refusal that follows
  (UNIMPLEMENTED, another content type) still gives `incompatible`.
- The causes no longer claim the game is not running, which this server cannot know. `waiting` now means "no
  telemetry for now", normal in menus, loading screens and before the character has appeared. The tool
  descriptions, the `limits` field, the dashboard View, `docs/USING_WITH_CLAUDE.md`, `docs/TELEMETRY.md` and
  `docs/TROUBLESHOOTING.md` (English and French) tell the model not to say the game is off and to offer no
  troubleshooting unless the state is `game_without_telemetry` or `incompatible`, and explain that on foot only
  character data exists while ship data needs the player seated in a ship.
- `jump_finished` came about 9 seconds after the end of a quantum jump on a real ship: the quantum-drive light went
  off at the end, but the event waited for the 8 s rule that exists for ships whose thrust light drops to nominal in
  the middle of a jump. The jump now ends when the drive light goes off; a ship that never reports it keeps the slow
  rule, and a thrust light still "major" right after the end does not start a second jump. Measured on a real Aegis
  Harbinger with 4.10.2.
- Stopping the telemetry reader while it was connecting could throw `ERR_HTTP2_INVALID_SESSION` from an event handler.
- The test suite no longer reaches the network. A status test ran the dump-repository probe against GitHub and timed
  out on a loaded CI; probes now take their sources as an argument, and `vitest.setup.ts` makes any test that opens a
  socket to another host fail, even if the code under test swallows the error. This found and fixed a second test that
  called a GitHub-backed tool for real.
- Tools no longer show full local paths (they hold the Windows user name): `scw_snapshot_save`, `scw_snapshot_list`,
  `sc_local_datasets` and the vocabulary source show the last three parts, as the log tools do; an unknown snapshot
  label no longer puts the full path in its error. `shortPath` moved to `core/paths.ts` (still re-exported by the log
  reader).

## [2.0.0] - 2026-11-03

First release of the fork. Licence treated as GPLv3 (see THIRD_PARTY.md).

### Added
- **Provenance on every answer** (`source`, `channel`, `game_version`, `fetched_at`, `data_age`, `kind`, `trust`,
  `stale`) and `sc_data_status`, which shows each source's version, age, disagreements and outages.
- **SCMDB tools**: `scmdb_search_missions`, `scmdb_search_crafting`, `scmdb_search_mining`, `scmdb_changes`.
- **Game log tools** (off by default, read-only): `sc_log_status`, `sc_log_recent_events`, `sc_log_context`,
  `sc_log_sessions`; events verified on real logs across patches 4.0 to 4.10.
- **Fleet**: `sc_fleet_get`, `sc_fleet_upsert`, `sc_fleet_remove` on a local file; names matched by words with
  candidates when ambiguous.
- **`sc_patch_notes`**: the notes of an update from starcitizen.tools, by section or keyword. No RSI scraping.
- **Ship-sized trade routes** (`ship_name`), profit for the cargo that fits, player reports behind each price.
- **MCP prompts**: `haul_plan`, `patch_briefing`, `session_debrief`, `mining_prep`, `mission_hunt`.
- **Tool profiles** (`SCMCP_PROFILES`: core, trade, data, local) and explicit scoping (`SCMCP_TOOLS`).
- **Resilience**: retries on transient failures, rate limiting under each source's limit, disk cache served (flagged
  stale) only when a source is unreachable.
- **Tooling**: `npm run doctor`, `npm run check:sources`, `npm run install:claude` (minimal, backed-up merge of the
  Claude Desktop config), generated `docs/TOOLS.md`, `npm run golden:update`.
- Documentation, security model, third-party licence table, contribution guides, issue and PR templates, CI
  (lint, format, types, tests on Linux and Windows, production audit, signatures) and CodeQL.

### Changed
- Source split into `core`, `providers` and `tools`; every outbound request goes through a host-allowlisted client
  that attaches the UEX token only to UEX hosts and checks redirects.
- Default UEX host is the documented `api.uexcorp.uk`.
- Cache, snapshot and config folders are per-user instead of the working directory; the GitHub token is the
  dedicated `SCMCP_GITHUB_TOKEN`; `.env` is read from the package folder only.
- Descriptions of the tools rewritten for model selection.

### Fixed
- `uex_get_trade_routes` always failed (UEX requires an origin) and its profit was UEX's figure for the route's
  maximum volume (for example 100,000 SCU), not the player's cargo.
- `scw_get_vehicle`, `scw_get_item` and `scw_get_ship_comparison` returned "Result too large" for most ships.
- Dataset names with `:` (Windows drive letters, alternate data streams) are refused.
- Repository names accepted `../x`; a dump commit id is validated before it enters a path.

### Removed
- Docker image publishing, semantic-release, `Dockerfile`, `install.sh`, `Makefile` (nothing is published).

### Security
- 0 advisories (production and development), CodeQL on every push, secret scanning and push protection enabled.
