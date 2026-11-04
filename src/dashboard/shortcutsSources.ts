/**
 * Where the default keys of the shortcuts zone come from. SERVER SIDE ONLY: this file is not shipped in the page (page.ts
 * does not import it), the tests and the documents read it. The page's own table, `shortcutsTable()` in
 * shortcutsPanel.ts, carries for each key only the letters of the sources below that confirm it (`src`).
 *
 * The rule: a key is shown only when at least TWO independent sources give it and none gives another one. Otherwise the
 * action is shown without a key. A test enforces it (two distinct letters in `src`, each defined here). The wiki, a guide
 * that copies it and a page of the same site count as one source.
 *
 * Read by hand on 2026-11-04, nothing is fetched at run time and no text of a source is copied: a key name is a fact, the
 * labels are our own short wording.
 */
export const SHORTCUTS_SOURCES = {
  /** The format of the table and of this file. */
  version: 1,
  /** The day the sources were read. */
  checked: "2026-11-04",
  /** The game version the keys are meant for. */
  game: "4.10",
  /**
   * The ids of the actions whose key somebody saw working in the game on `game`. Empty: nobody has yet, so every key
   * shown is a default taken from public sources, and the page says "défaut" and to check it in the player's settings.
   */
  verified: [] as string[],
  sources: {
    w: "Star Citizen Tools wiki, page Guide:Controls, revision of 13 July 2026",
    s: "starcitizenhelp.com, page of keybinds, default keys of Alpha 4.10.2",
    c: "Cheatography sheet Star Citizen Controls, version 3.22.0 (2023)",
    n: "Star Citizen beginner's guide on GitBook (star-netrunners), appendix A, undated",
  } as Record<string, string>,
  /**
   * Keys the sources DISAGREE on or that fewer than two give, which therefore stay without a key, and why (for the next
   * person who is tempted to add one).
   */
  withheld: {
    qt: "B is the SCM/NAV toggle in Master Modes; the quantum jump is a hold of the left mouse button",
    cruise: "a 4.10.2 guide has cruise on Alt+C and decoupled on C, the opposite of the wiki",
    decoupled: "see cruise",
    ready: "a 4.10.2 guide says right Alt + R; other sources say R",
    lights: "one source (L), another era had T",
    gear: "N or V, depending on the source",
    land_auto: "hold Ctrl, hold N or T, depending on the source",
    land_req: "one source (Alt+N)",
    takeoff: "one source",
    shield_pw: "O, or U/I/P of an older power system",
    exit: "one source (hold Y)",
  } as Record<string, string>,
};
