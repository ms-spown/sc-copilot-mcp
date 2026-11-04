# Third-party sources, licences and what they forbid

Checked 3 November 2026. "Not found" means we looked and saw none, which is **not** permission.
Re-check a source before relying on it for anything beyond personal use.

The rule that follows from the table: **as long as any source below is non-commercial or has no licence,
this project must stay free, with no donations, sponsorship, ads, subscription or paid hosting.** Taking
donations needs each of these to be resolved first (see "Before accepting donations").

| Source                                                  | Used for                              | Licence / terms                                                                                                                                                           | What that forbids or requires                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **This repository and upstream SCMCP**                  | The code                              | `LICENSE` is GPLv3 (since the upstream first commit). Upstream's `package.json` and README said ISC. Treated as **GPLv3**; `package.json` says `GPL-3.0-only`             | Derivatives stay GPLv3 with source. Not relicensed here. Open question for the upstream author: which was intended, and "only" or "or later"?                                     |
| **UEX Corp API** (`api.uexcorp.uk`)                     | Prices, terminals, routes, ships      | Documented API with a per-user bearer token; 120 requests/minute; attribution ("Powered by UEX")                                                                          | Use your own token. Never use the separate data-submission key. Do not redistribute the data as a service. Keep the attribution                                                   |
| **Star Citizen Wiki API** (`api.star-citizen.wiki`)     | Ship and item records, and the commodity list (names matched on the game's GUID) | Content CC BY-NC-SA 4.0; API terms: **no commercial use**, credit required, search limited to 60 requests/minute                                                          | Non-commercial only; attribute; share alike for reproduced text                                                                                                                   |
| **Star Citizen Tools** (`starcitizen.tools`)            | Article text; one of the sources of the default keys of the dashboard's shortcuts zone (facts only: a key name per action, the page of its controls, revision of 13 July 2026, read by hand, never at run time; the other sources, listed in `src/dashboard/shortcutsSources.ts`, are a keybinds page of starcitizenhelp.com, a Cheatography sheet and a GitBook beginner's guide, used the same way, with no text copied) | Content CC BY-SA 4.0                                                                                                                                                      | Attribute; share alike. No text of the page is copied: the labels are our own short wording, and a key name is a fact. Where it is the only source the key stays unverified in the game |
| **SCMDB_DATA** (`KrovaxCode/SCMDB_DATA`)                | Missions, crafting, mining, updates   | **No licence found.** The repository is an automatic mirror                                                                                                               | Default copyright applies: do not redistribute or bundle it. We read it on demand into the user's own cache and answer in small pieces. Ask the maintainer before any broader use |
| **sc-gamedata-dumps** (`voidput/sc-gamedata-dumps`)     | Patch dump history (now almost empty) | No licence; its NOTICE states a **non-commercial** basis and no compensation "against it or against anything that reads it"; publishes numeric values, ids and names only | Anything that reads it must stay non-commercial. Tags are republished: always address by commit SHA                                                                               |
| **scunpacked-data** (`StarCitizenWiki/scunpacked-data`) | **Not used**                          | No licence found; files are large (items.json about 68 MB)                                                                                                                | Evaluated, not integrated. Would only be considered with per-file extraction and the maintainers' agreement                                                                       |
| **Wingman AI** (`ShipBit/wingman-ai`) and the Star Citizen telemetry field test by Mallachi (Diftic) | `src/providers/telemetry/sc_telemetry.proto` (copied unchanged, with attribution) and the quirk rules behind `normalize.ts` / `handler.ts` (ported in spirit) | Wingman is **GPLv3**. The field-test report (`Diftic/wingman-skills`) has a licence we have not verified: read only, no code copied from it | Keep the GPLv3 notice and attribution. The `.proto` was rebuilt by a third party from descriptor data inside the game binary; we never repeat that extraction. Game content and the telemetry service belong to Cloud Imperium Games |
| **Local `Game.log`**                                    | The player's own session              | The player's own file on their PC                                                                                                                                         | Never committed, never sent anywhere. Fixtures in tests are hand-made                                                                                                             |
| **Fleet file**                                          | The player's own list                 | The player's own data                                                                                                                                                     | Stays on the PC                                                                                                                                                                   |
| **Model Context Protocol SDK**, axios, zod, dotenv      | Runtime libraries                     | MIT / similar                                                                                                                                                             | Keep their notices; see `package-lock.json` for the full list                                                                                                                     |

Game content (names, data) remains the property of Cloud Imperium; see [NOTICE](NOTICE).

The live telemetry adds no dependency. It adds a licence fact (the `.proto` is GPLv3, like this project, so it
changes nothing about the licence) and a terms question that is not ours to settle: it reads an undocumented game
feature (see `docs/TELEMETRY.md`, Risks). Taking money for a tool whose optional feature may be against the game's
terms is a reason to settle that point with RSI first, on top of the list below.

## Before accepting donations

1. Settle the repository licence with the upstream author (GPLv3 vs ISC, "only" vs "or later").
2. Remove or replace every source that forbids commercial use or has no licence, or obtain written permission:
   the Star Citizen Wiki API, the community dumps, SCMDB_DATA.
3. Confirm UEX's terms for a donation-funded tool.
4. Re-read CIG's fan-project guidelines for the donation wording they require.
5. Ask RSI whether a tool that reads the game's undocumented local telemetry (even optional and off by default) is
   acceptable before any money is taken for the project.

## Questions for others (not yet asked: nothing is sent to anyone without the maintainer's say-so)

- **Upstream author (voidput):** which licence is intended, ISC or GPLv3? "Only" or "or later"?
- **SCMDB_DATA maintainer:** is on-demand reading by a local tool fine, and under what licence is the data?
- **Dumps maintainer:** is the thin tag history intentional (history was rewritten on 2026-11-01)?
