/**
 * TEST SUPPORT: wait for something that happens on a real socket or a real file, without guessing how long it takes.
 *
 * The limit is a hang detector, not a performance claim: it is generous (20 s) so that a loaded machine (a busy CI
 * runner, a laptop running other work, `npm run test:stress`) does not turn a slow step into a failure. A check that
 * is true stays true quickly, so the generous limit costs nothing when everything is fine. Never use a wait to prove
 * that something did NOT happen, and never assert on how long it took (see CONTRIBUTING.md, "Time in tests").
 */
export const WAIT_LIMIT_MS = 20_000;

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  what: string,
  ms = WAIT_LIMIT_MS,
  pollMs = 10,
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`timed out waiting for: ${what}`);
}
