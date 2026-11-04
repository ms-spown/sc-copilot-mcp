# Contributing

## Welcome

Contributions are welcome from people and from automated or AI-assisted tools and agents, on the same footing:
the same rules, the same review, the same bar. Who or what wrote a change does not make it more or less
acceptable. What matters is that it is correct, small, tested and safe.

Start here:

- **Architecture and rules:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Adding a tool, step by step:** [docs/ADDING_A_TOOL.md](docs/ADDING_A_TOOL.md).
- **Conduct:** [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Before touching anything that reaches the network or
  handles text from players, read [SECURITY.md](SECURITY.md) and [THIRD_PARTY.md](THIRD_PARTY.md).
- **Style:** behaviour is specified as Given/When/Then scenarios in `*.behaviour.test.ts` files; commits are
  small, with a message that says why. Formatting is Prettier (`npm run format`), checked in CI.

## Cost

This project pays nothing and owes nothing. It accepts no bounty, prize, reward or payment claim, and it creates
no obligation of any kind towards a contributor, a platform or a client of a platform.

- Do not put a wallet address, a claim or payout identifier, a link to a platform "job" or task, or an unfilled
  template placeholder such as `0x{hash}` in a commit message, a file or a pull request description. Such a pull
  request will be asked to remove it, or closed.
- Any arrangement between a contributor and a bounty or task platform is between the two of them. The
  maintainers are not a party to it and do not confirm, sign or acknowledge anything for it.
- Maintainers commit to no response time and to no merge. A pull request may wait, be asked to change, or be
  declined without detailed reasons.

## Review

A human reads every change before it is merged, including changes made by tools. Pull requests are merged by
squash, which keeps the author of the change. What is checked:

- the change does what the description says, and only that;
- tests exist, and use no network and no real game data;
- the security rules below, including everything Claude will read (see the next section);
- licences and dependencies ([THIRD_PARTY.md](THIRD_PARTY.md)).

Changes to the check itself (`src/docs/docsSafety.ts`, `scripts/check-docs-safety.mjs`), to `.github/` or to
`package.json` scripts get extra scrutiny: they are what protects everything else.

## Security rules for contributions

**Files that Claude reads are an instruction channel.** The paste-in block of `docs/USING_WITH_CLAUDE*.md`, the
tool descriptions in `src/tools/`, the prompts in `src/prompts.ts`, the server instructions in `src/instructions.ts`, `CLAUDE.md` and the README tell the model
what to do. A booby-trapped contribution there would be executed by the model of every user. Therefore:

- No invisible or look-alike characters, in any tracked text file: no zero-width, bidirectional-control, Unicode
  tag or variation-selector characters, no control characters other than tab and line breaks, no carriage
  return without a line feed (CRLF line endings are fine). No letter outside the Latin script (Cyrillic, Greek,
  Armenian, Cherokee, Han...), whether a word mixes scripts or is entirely made of them, and no character that
  Unicode compatibility folding (NFKC) turns into another one: fullwidth and mathematical letters, circled
  letters, a no-break space... Only the ellipsis is tolerated. A test that needs such a sample builds it from
  code points (`String.fromCodePoint`). A file that truly needs another script is registered with a reason in
  `ALLOWED_NON_LATIN_FILES` (none today).
- No HTML comments and no active HTML in Markdown (script, iframe, object, embed, style, form, input, meta,
  link, base, svg, event-handler, `style` and `hidden` attributes, `javascript:`, `data:` or `vbscript:` links).
  Say it in plain, visible text. The centred paragraph, link and image of the README are the only HTML in use.
  The same goes for every extension that is read as prose (`.md`, `.markdown`, `.mdx`, `.mdc`, `.txt`, `.html`...,
  in any case), for prompts and tool descriptions under `src/tools/`, and for YAML and JSON files.
- No invisible Markdown either: a link definition (`[label]: target`) must be used, must point to a URL or a
  file of the repository, and carries no title; a link has no title (`[x](url "text")`). That is how a Markdown
  comment is written.
- A link or image to a host that is not already used needs a review. Hosts are listed in
  `ALLOWED_LINK_HOSTS` in `src/docs/docsSafety.ts`; justify the new link in the pull request, and add the host
  there in the same change. github.com is allowed under reviewed projects only (`ALLOWED_PATH_PREFIXES`:
  this repository, upstream, the data and credit projects). A relative link must name a file or folder that
  exists. Credentials in a URL, a port, a punycode (`xn--`) host and any scheme but https are refused, and every
  host is compared in lower case. Bare `www.` addresses, e-mail addresses and `mailto:` are links too: put them
  in a code span. All of this applies to the URLs in code under `src/`, where the hosts the server talks to
  (`ALLOWED_API_HOSTS`) are also accepted, except in prompts and tool descriptions.
- `package.json` scripts and `.claude/` (hooks, settings, commands) are reviewed by a human: the check reports a
  script that contains a URL or a network command (`curl`, `wget`, `Invoke-WebRequest`, `http`...), an npm
  lifecycle script (`postinstall`, `prepare`, `pre*`/`post*` of another script), any script or hook setting
  under `.claude/`, and any lock file entry that does not come from the npm registry over https. A pull
  request that adds a hook edits the check, which puts it in front of a maintainer.
- No new dependency without a written justification, never one that needs an install script or ships native
  code **in production**. The production dependencies (`dependencies` in `package.json`) contain no native code
  and no install script. The development tools do: `@rolldown/binding-*` (Vite's bundler, used by Vitest),
  `lightningcss-*` and, on macOS, `fsevents` (the only one with an install script, which `--ignore-scripts`
  skips). They are prebuilt binaries published as optional packages per platform (see `package-lock.json`,
  entries marked `dev`); they are never part of what users install, but the bundler binary does run on a
  developer's machine and in CI when the tests start. The project installs with `npm ci --ignore-scripts` and
  that must keep working.
- No new network host outside `ALLOWED_HOSTS` (`src/core/http.ts`), no scraping, no remote write.
- No secret, token, personal data or real game data (never a real `Game.log`). Fixtures are tiny and hand-made.
- Third-party text shown to the model is marked `untrusted_text` (see SECURITY.md).

`npm run check:docs` enforces the mechanical part of these rules. It runs in the tests and in CI. It narrows the
hiding places; it does not replace the review.

### What `check:docs` does NOT detect

Be honest about its reach: it looks for places where text hides, not for hostile text.

- **Hostile text written in plain sight.** A sentence in the README, in the Claude block or in a tool
  description that tells the model to do something harmful, in clear and correctly spelled words, passes. Only a
  human reading the diff catches it. The same goes for a misleading but visible link text or a plausible lie
  in the documentation.
- **A reviewed host used badly.** A link to an allowed host, or to a path under an allowed GitHub project, can
  still point to content that someone else controls there (an issue, a wiki page, a release asset).
- **URLs assembled at run time or by concatenation**, and content fetched at run time (UEX, wiki, SCMDB, patch
  dumps): that is what `untrusted_text` and the host allowlist in `src/core/http.ts` are for, not this check.
- **Files with no extension** (`LICENSE`, `NOTICE`): they get the character rules only, no link or comment
  rules. The same goes for `scripts/*.mjs` and other root JavaScript, `vitest.config.ts` and `eslint.config.mjs`:
  their strings are not link-checked, and `npm run` scripts that call them are not read for what they do.
- **Test files and test helpers** (`*.test.ts`, `testing/` folders): they hold hostile samples on purpose and are
  exempt from the link, comment and tag rules (the character rules apply to them).
- **Markup in code that is not model-facing.** Providers, core and install code are checked for link hosts,
  schemes and look-alikes, not for HTML comments or tags.
- **Look-alikes that are really Latin or Common**, outside the blocks it knows (IPA, phonetic and extended Latin
  blocks): the Latin script allows thousands of letters.
- **Binary content** inside the known image formats, and anything in a file the repository does not track.
- **Behaviour.** It does not run code, and does not judge whether a dependency, a hook or a script does what
  it claims.

## Translations

A translation is a file `NAME.fr.md` next to the original `NAME.md` (for example `README.fr.md`).

- Identifiers are copied unchanged: tool names, parameter and field names, environment variables, file names,
  commands, code and URLs. Only the prose is translated.
- A translation adds nothing the original does not say. In particular its code block never gets an identifier
  or URL that the original lacks.
- Maintainers update a translation together with its original. If you change an original, say so in the pull
  request; you may update the translation in the same change.
- `npm run check:docs` compares each pair (code spans, URLs, UPPER_CASE variable names, identifiers in code
  blocks) and fails on drift.

## Labels

- `good first issue`: small, self-contained and well described; no knowledge of the game data format needed.
- `help wanted`: wanted and accepted in principle; nobody is working on it. Say in the issue that you take it.

Neither label offers a reward or promises that a pull request will be merged.

## Licence

The project is GPL-3.0-only. There is no CLA. By opening a pull request you make your contribution under the
project's licence and confirm that you have the right to do so.

## How to open a good PR

1. Open or find an issue, and reference it in the description.
2. Keep the change small and focused: one subject per pull request.
3. Add or update tests (Given/When/Then) and the docs that the change makes wrong.
4. Fill in the pull request template, including whether the contribution is automated or AI-assisted.
5. Run the checks below and paste anything unusual.

### Before you commit

```bash
npm ci --ignore-scripts
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build && npm run check:docs && npm run check:page-size && npm run audit:prod
```

Generated files: after changing a tool run `npm run golden:update` and `npm run docs:tools` (tests fail if you
forget).

Tests must not use the network or real game data, and the suite fails a test that tries (`vitest.setup.ts`). Use fake clients, temp folders and hand-made fixtures. A new
tool needs: its definition and handler in `src/tools/`, an entry in `src/tools/catalog.ts` (source, kind, trust,
channel, profiles), tests, and a refreshed `src/tools/tools-surface.golden.json` (see CLAUDE.md). Never add a
host except in `ALLOWED_HOSTS`, never a remote write, and read `SECURITY.md` and `THIRD_PARTY.md` first.

## Time in tests, and running the suite under load

A test that passes on an idle machine and fails on a busy one is a bug in the test. The suite is meant to pass
whatever else the machine is doing (a CI runner with other jobs, a laptop compiling, several worktrees testing at
once). The rules:

- **No real clock in an assertion.** Never `expect(Date.now() - started).toBeLessThan(...)`. Say what the code does
  instead: inject the clock the code already takes (`now: () => clock.t`, a manual clock moved with `clock.t += ...`),
  count what it did (bytes copied, calls made, connections opened), or freeze the timers (`vi.useFakeTimers` with
  `toFake` limited to the timers, the sockets stay real) so that code which waited for a timer would never finish.
- **No sleep to wait for something to happen.** Wait for the event or the condition: `waitFor` from
  `src/testing/waitFor.ts`, a counter the fake exposes (`g.connections()`, `g.closedConnections()`), or the promise of
  the work itself. A fixed `setTimeout` is accepted only to check that something does NOT happen (it can then pass
  too early, but never fail), or as the delay a fake itself needs.
- **Real I/O is allowed where it is the point** (the session store's lock files, the fake game's loopback socket).
  Bound it by a generous hang detector (20 s for a wait, 30 s per test by default in `vitest.config.ts`), not by what
  an idle machine needs. A lower bound on elapsed time is safe (a timer never fires early); an upper bound is not.
- **No shared ports or folders.** Use port 0 and `mkdtemp`. For "nothing listens here", use `UNUSED_PORT` from
  `src/providers/telemetry/testing/fakeServer.ts`, never a port you just closed: another test file can be handed it.
- **A fake must not lose what it is given.** The fake game queues frames sent before its stream is registered; keep it
  that way if you extend it.

To check a change, run the whole suite under CPU load with `npm run test:stress` (local only, not in CI). It starts
several complete runs at once, each with its own temp folder, next to busy-loop processes, and lists every test that
failed with the number of runs it failed in:

```bash
npm run test:stress                                       # 3 rounds, 4 suites at once, one burner per core
npm run test:stress -- --rounds 10 --parallel 3 --burners 16   # the setting used to validate the suite
```

A run takes about ten times longer than an idle one. A test that fails there and passes alone is flaky: fix its
cause (above) rather than raising a bound.

## Reporting a security problem

Do not open a public issue. Follow [SECURITY.md](SECURITY.md) (private security advisory on this repository).

## New patch procedure (target: well under an evening)

Run this when a new LIVE or PTU build appears. Everything is read-only. Good first issues often start here:
after a patch, run `npm run check:sources` and fix what it flags.

1. **Pull and build.** `git pull && npm ci --ignore-scripts && npm run build`.
2. **Check every source.** `npm run check:sources` (first run downloads the SCMDB files into your cache, a
   minute or two; later runs take seconds). It prints each source's version and re-validates the shape of every
   file and endpoint the tools rely on. Exit code 1 means something to look at.
3. **Read the notes.** Differences between sources are expected for hours or days after a patch. A source on an
   older build is not a bug; one that is _down_ or whose _shape changed_ is.
4. **If a shape check fails.** The error names the file and field ("unexpected shape at …"). Open that source's
   files, adapt the validator in `src/providers/scmdb/store.ts` (or the client) and the query in
   `queries.ts`, add a small synthetic fixture for the new shape, run the suite.
5. **If you have the game installed:** set `SC_INSTALL_DIR`, run the game once, then `npm run check:sources`
   again: the `game-log` line must show the new version and build. If the header stops parsing, update
   `src/providers/gamelog/parser.ts` and add a hand-made line to the fixture in
   `src/providers/gamelog/gamelog.test.ts`. Do not commit a real log.
6. **UEX specifics.** `check:sources` calls the five endpoints the tools use. A new required parameter shows as
   an HTTP 400 with UEX's own message.
7. **Spot-check in Claude** with `sc_data_status`, one trade route (`uex_get_trade_routes` with a cargo size),
   one `scmdb_changes` and one `sc_log_recent_events`.
8. **Commit** with what changed and the build numbers seen.

Source-specific places to look when something moves:

| Source                | Verification                                                   | Where the code is                                 |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| UEX                   | `check:sources` (UEX section), `sc_data_status`                | `src/providers/uex/client.ts`, `src/tools/uex.ts` |
| Star Citizen Wiki API | `sc_data_status`, `scw_get_vehicle` on a big ship              | `src/providers/wiki/`, `src/tools/wiki.ts`        |
| starcitizen.tools     | `sc_data_status` (reachability only)                           | `src/tools/sctools.ts`                            |
| SCMDB                 | `check:sources` (SCMDB section: every file kind, LIVE and PTU) | `src/providers/scmdb/`                            |
| Patch dumps           | `sc_list_builds` (history is nearly empty)                     | `src/providers/dumps/`                            |
| Game.log              | `check:sources` (Game.log section), `sc_log_status`            | `src/providers/gamelog/`                          |

## About `scripts/mcp-probe.mjs`

Inherited from upstream and stale: it calls a dataset name that no longer exists and expects builds that are no
longer published, so 4 of its 14 checks fail for reasons unrelated to the code. `check:sources` replaces it.
