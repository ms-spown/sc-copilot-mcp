# Roadmap

Where the project stands and what is next, in product order: what helps the player most first. It is a plan, not a
promise, and every item says what is verified and what is not. The history of what shipped is in
[CHANGELOG.md](../CHANGELOG.md); what each tool does is in [CAPABILITIES.md](CAPABILITIES.md).

## Where it stands (2.7.0)

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
- **Losses, shortcuts, the balance and a truthful trade line (2.6.0):**
  - *Ship losses.* A ship destroyed with the player aboard is shown in the dashboard's alert slot, marks the run it
    interrupted, is kept in the saved session and listed by the session debrief, with the cargo PRESUMED lost (SCU and
    the aUEC PAID, not the value). The value lost, the insurance and the killer are not in the log and are shown as
    "non journalisés". The cause is a collision only when the log says so, never guessed.
  - *Context shortcuts.* A "Raccourcis" zone under the ship banner reminds you of the actions that fit the moment
    (landing gear out, on foot, hostile lock...), read from states the stream and `Game.log` already carry; it presses
    nothing. Only FOUR default keys are printed (X, H, J, T, labelled "défaut"): a key is shown only when at least two
    independent public sources give it and none another, and none was checked in the game on 4.10. Every other action is
    shown without a key on purpose (for example B is the SCM/NAV toggle, not the quantum jump, and a 4.10.2 guide swaps cruise
    and decoupled mode against the wiki).
  - *The balance is shown by default* (a decision of the owner, 2026-11-04; it started hidden before). Hiding it is the
    opt-in and is sticky: "Masquer le solde" also hides the amounts from Claude's tools, an `include_balance: true` from
    the model is ignored while they are hidden, and lifting the mask needs a token of the server process that only the
    served page carries. The click lives in the memory of one server process only; `SC_BALANCE=hidden` is the durable
    way. If you pasted the Claude block of an earlier release, recopy the one of
    [USING_WITH_CLAUDE.md](USING_WITH_CLAUDE.md).
  - *A trade line that only says what the data gives.* A run under way reads "Trajet en cours · 696 SCU achetés · en
    route depuis 6 min": the SCU and the time come from the journal, the goods, route, estimate and target price from
    your plan, grouped after "d'après ton plan" and left out when something contradicts the plan. A run more than 3 hours
    old is "non terminé", the journal's 8-character id is never shown, and the names of goods come from the wiki's
    public commodity list (`SC_COMMODITY_NAMES=off` keeps it fully local).
  - *Accessibility.* Readings that were hover-only tooltips can be reached with the keyboard, and the lamps and power
    nodes carry their full name and state as an `aria-label`.
- **A dashboard that follows the situation (2.7.0).** Almost all in the page and its tests; no tool added, no input schema,
  host or file changed (the calibration groups of `sc_session_stats` gained four mean amounts, behind the balance guards).
  - *The ship loss is the gravest event.* A "fatal" tone (solid red, built on the existing danger colour) leads the header
    verdict and the alert box for 3 minutes, never over a red condition that began after the loss, and the box keeps it for
    15 minutes. It is two lines, the cautions are folded under "Pourquoi ce n'est pas certain ?", and "Et maintenant" states
    facts only. Still no value, insurance or culprit: the log has none.
  - *"Ask Claude" follows the situation.* "Analyser la perte", "Que faire maintenant ?", "Debrief du trajet" or the plain
    "Analyser": each sends a fixed message naming the tools to read, and reads the player's balance choice at the click.
  - *Route cards.* Under each route of "Chercher une route": ESTIMÉ (the planner's figure), MESURÉ (the mean of your own runs,
    their number) and RÉALISÉ ÷ PRÉVU (the ratio, with its confidence) side by side; under 3 runs only their number; the
    sentence "Si tu refais ce trajet" writes the honest decomposition ("prévu × ratio, moins les frais habituels"); the four
    mean amounts in aUEC stay behind the balance guards.
  - *Full screen adapts.* A flight order (verdict and alerts, banner, trip line, instruments first) and a commerce order (the
    page's old order), chosen from the stream and the ship's `landed` state, applied after 3 seconds, deferred while the focus
    is in a section that would move or the page is scrolled far down, with a grey stream keeping the order on screen. A button
    "Ordre : auto / commerce / vol" forces one. An unknown situation gets the commerce order and says so.
  - The dashboard page is 373.0 kB against our own internal budget of 392 kB (a guard of ours, not a limit of the host;
    nothing was removed to fit it).
- **The agent:** server `instructions`, refreshed prompts (`haul_plan`, `trade_copilot`, `trade_review`,
  `session_debrief`), a block to paste into a Claude project.

## Next, in order of value

1. **A test pass in the game, with the player (not started).** Nothing below is safe to build on before it. To look at: the
   dashboard itself in Claude Desktop (how the host sizes full screen and whether it keeps the scroll position when sections
   move); the four default keys X, H, J and T on 4.10; `is_landed` when the game omits it (a hangar, a respawn), which today
   can show the flight order on the ground; a ship loss with a purchase on a 4.10 session (the cargo attribution is verified
   on 2025-build logs only, and the 4.10 line of a ship shot down has no sample); a complete run with telemetry, the log and
   the dashboard open together.
2. **Trend of the trips (not started).** How your runs evolve over the sessions, with the number of runs behind it; the
   route cards and the calibration already hold the per-route numbers.
3. **Price alerts and watchlists (not started).** Follow a commodity or a route and say when its price moves. **The storage
   decision is open and comes first:** where the list lives (the saved-sessions file, a file of its own next to it, or the
   memory of the page only, which a restart would lose), and how an alert reaches the player without a new live region, a
   new host or a poll that UEX would throttle. Nothing is decided; no code exists.
4. **On foot, with the helmet (future, not started).** Vitals forecast, kill and death counters, an interface that
   adapts to ship, foot and EVA (the context shortcuts zone and the full-screen orders already adapt to ship, foot and EVA: see
   [TELEMETRY.md](TELEMETRY.md#context-shortcuts)), and the helmet state: `Game.log` writes an attachment line when the
   helmet goes on or onto its hook, which would allow "wipe the visor" and a "no helmet in a vacuum" alert. Reserves:
   seen in one session only (taken off to the hook, put back); never seen for taking it off into the inventory, for a
   respawn or for entering a ship; the line carries the player's handle, so a parser must keep only the port and the
   class name of the object, never the handle (a test with an invented handle must prove it); the signal has to be
   measured before anything relies on it. Also manual contexts for mining, salvage and scanning in the folded part
   of the shortcuts zone, since the stream has no signal for them.
5. **Your own key bindings in the shortcuts zone (future, not started).** Today only four default keys are
   shown, labelled "défaut", none checked in the game. Reading the player's `actionmaps.xml` would show their real keys
   in place of the defaults. Reserves, all measured or stated by the research behind it: the file holds only what the
   player CHANGED (on the reference install it has no binding at all), so it gives no default key and an action that is
   not bound must read "no key", never fall back to the default; its `options` element carries the name of a device
   and must never be read or sent; it would be opt-in (an environment variable, like the other readers), read-only,
   size-capped, parsed against a whitelist of actions, from a path derived from `SC_INSTALL_DIR`; how an unbound
   action is written, and how keyboard, joystick and mouse tokens translate on an AZERTY keyboard, are not verified
   (a joystick binding would be shown as "joystick (personnalisé)", never a guessed button name); the hand-made test
   fixtures only, never the real file. Not planned: an export of the full profile from the game, until its content is
   seen.

## Verified, and not verified

- **Verified:** the parser on real logs of 95 files; the planned versus real arithmetic on a real run; the sessions
  file under concurrent processes and a killed process (simulated); the privacy guarantees by tests and probes.
- **Not verified:** the ship loss tracker's cargo attribution on a build 4.10 session (it chains on three 2025 cases and
  by ship identity on the three 4.10 losses, none of which had a purchase); the sticky balance mask across several
  server processes or clients (it is held in the memory of one process, and only `SC_BALANCE=hidden` covers all); the
  default keys of the shortcuts zone (X, H, J and T: public sources only, none tried in the game on 4.10);
  the flight order of full screen when the game omits `is_landed` (a hangar, a respawn: the pilot may be on the ground
  while the page shows the flight order); the live dashboard itself inside Claude Desktop (never seen there, so neither is
  how the host sizes full screen or whether it keeps the scroll position when sections move; only a throwaway test page was
  displayed there, see [MCP_APP_SPIKE.md](MCP_APP_SPIKE.md), a historical note); a complete run with telemetry, log and dashboard open together (the windows that match a log
  transaction with a balance change are assumptions: 2 s before to 8 s after for fees, 3 s before to 20 s after for
  rewards); the voluntary quit to the menu; the behaviour inside Claude Desktop (whether it honours server
  `instructions`, the size limit for an MCP App page, clipboard and storage in its sandbox).
- **Impossible with the data we have:** the value of lost cargo, the insurance and the killer of a ship (not in the log),
  a stock level (not in the log), a unit sale price (only the total), the amount
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
