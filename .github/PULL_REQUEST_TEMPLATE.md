## What and why

<!-- What does this change, and what problem does it solve for a player or a maintainer? -->

## How it was checked

- [ ] `npm run lint && npm run typecheck && npm test && npm run build && npm run audit:prod`
- [ ] Behaviour is covered by Given/When/Then scenarios (no network, no real game data)
- [ ] If a source was touched: `npm run check:sources` output pasted below

## Checklist

- [ ] New or changed tool: catalog entry, `npm run golden:update`, `npm run docs:tools`, README theme table
- [ ] No new host outside `ALLOWED_HOSTS`, no scraping, no remote write, no secret or real log committed
- [ ] Text written by players or website editors is marked `untrusted_text`
- [ ] Docs updated where behaviour changed

<!-- Please keep the pull request small and focused. -->
