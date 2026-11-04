# Changelog

All notable changes to this fork. The history of the original project (voidput/SCMCP, up to 1.5.0) is kept in
[docs/UPSTREAM_CHANGELOG.md](docs/UPSTREAM_CHANGELOG.md). Format: [Keep a Changelog](https://keepachangelog.com/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
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
