import { z } from "zod";
import type { HttpClient } from "../core/http.js";
import { formatOutputRaw } from "../core/format.js";
import { addNote } from "../core/provenance.js";
import type { ParsedLog } from "../providers/gamelog/parser.js";
import type { GameLog } from "../providers/gamelog/reader.js";
import {
  buildTradeJournal,
  type CargoRun,
  type SessionJournal,
  type Transaction,
} from "../providers/gamelog/trade.js";
import { resolveCommodityNames } from "../providers/wiki/commodities.js";
import { noteProvenance } from "./gamelog.js";
import type { ToolDefinition, ToolResult } from "./types.js";

/**
 * The player's trade journal, from Game.log only (read-only, off unless the log is configured).
 * Commodity NAMES come from the wiki's public commodity list, matched locally on the GUID; the
 * player's log never goes over the network. No handle, id or balance is ever returned.
 */

const MAX_FILES = 10;
const MAX_ROWS_TOTAL = 120;
const MAX_RUNS_PER_SESSION = 30;
/** The `sessions` part of the answer, pretty-printed: leaves room for the rest under the 40 000-character limit. */
const MAX_SESSIONS_CHARS = 32_000;
const UNKNOWN = "unknown commodity";

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: formatOutputRaw(value) }],
});

type Row = Omit<Transaction, "resource"> & { commodity_name?: string };

export function tradeJournalTools({
  gameLog,
  scwClient,
}: {
  gameLog: GameLog;
  scwClient: HttpClient;
}): ToolDefinition[] {
  return [
    {
      name: "sc_trade_journal",
      description:
        "The player's trade journal, from Game.log only, per play session (newest first): each shop or cargo-kiosk purchase and sale with time, side, shop, quantity and unit (SCU for cargo), the TOTAL of the line in aUEC, unit price, outcome and confidence; spending by category (inferred from the item class name); cargo runs pairing purchases and sales of one commodity first-in first-out, with paired SCU, cost, revenue and GROSS margin (estimated); totals. Use it for 'what did I buy', 'how did my last cargo run go'. Tell the player: the log has NO wallet balance and no autoload fee, so there is no net result; cargo success is only inferred from the absence of an error; failed lines are listed, not counted; location_hint is a possibly stale hint, never a terminal; a commodity the wiki does not name is 'unknown commodity'. Read-only; needs the game log enabled.",
      inputSchema: {
        type: "object",
        properties: {
          sessions: {
            type: "number",
            description:
              "How many of the newest log files to scan (default 2, max 10). Files with no trade are left out.",
          },
          max_transactions: {
            type: "number",
            description:
              "Most recent transactions listed per session (default 40, max 120; at most 120 in all). Totals and runs always cover the whole session.",
          },
          resolve_names: {
            type: "boolean",
            description:
              "Look commodity names up in the wiki's public commodity list (default true). The list is the same for everyone: nothing from the log is sent. False keeps it fully local.",
          },
        },
      },
      handler: async (args: unknown): Promise<ToolResult> => {
        const input = z
          .object({
            sessions: z.number().optional(),
            max_transactions: z.number().optional(),
            resolve_names: z.boolean().optional(),
          })
          .parse(args || {});
        const files = Math.min(Math.max(Math.floor(input.sessions ?? 2), 1), MAX_FILES);
        const perSession = Math.min(Math.max(Math.floor(input.max_transactions ?? 40), 1), 120);
        const list = await gameLog.sessions(files);
        if (list[0]) noteProvenance(list[0].parsed.session, Date.now());

        const journals = list
          .map((s, i) => ({
            s,
            current: i === 0 && s.running,
            j: buildTradeJournal(s.parsed.commerce, s.parsed.span.last),
          }))
          .filter((x) => x.j.transactions.length > 0);

        // Names: the whole list is fetched (the same request for every user) and matched here.
        const guids = new Set<string>();
        for (const { j } of journals) {
          for (const t of j.transactions) if (t.resource) guids.add(t.resource);
        }
        const wantNames = input.resolve_names !== false && guids.size > 0;
        const resolved = wantNames
          ? await resolveCommodityNames(scwClient, [...guids])
          : { names: new Map<string, string>(), error: null, fetchedAt: null, stale: false };
        const nameOf = (resource: string) => resolved.names.get(resource) ?? UNKNOWN;
        if (wantNames && resolved.stale)
          addNote("Commodity names come from an old copy of the wiki list (the wiki was down).");

        const build = (rowsCap: number, runsCap: number) => {
          let budget = MAX_ROWS_TOTAL;
          return journals.map(({ s, current, j }) => {
            const take = Math.max(0, Math.min(rowsCap, budget));
            budget -= Math.min(take, j.transactions.length);
            return view(s, current, j, take, runsCap, nameOf);
          });
        };
        // The answer must stay under the output limit (formatOutputRaw would otherwise cut the
        // `sessions` array to nothing): lower the rows, then the runs, until it fits.
        let rowsCap = perSession;
        let runsCap = MAX_RUNS_PER_SESSION;
        let sessions = build(rowsCap, runsCap);
        while (
          JSON.stringify(sessions, null, 2).length > MAX_SESSIONS_CHARS &&
          (rowsCap > 0 || runsCap > 0)
        ) {
          if (rowsCap > 4) rowsCap = Math.floor(rowsCap / 2);
          else if (runsCap > 2) runsCap = Math.floor(runsCap / 2);
          else if (rowsCap > 0) rowsCap = 0;
          else runsCap = 0;
          sessions = build(rowsCap, runsCap);
        }
        const count = (
          key:
            "transactions_shown" | "transactions_total" | "cargo_runs_shown" | "cargo_runs_total",
        ) => sessions.reduce((n, x) => n + x[key], 0);
        const reduced = rowsCap < perSession || runsCap < MAX_RUNS_PER_SESSION;
        const truncated =
          reduced &&
          (count("transactions_shown") < count("transactions_total") ||
            count("cargo_runs_shown") < count("cargo_runs_total"))
            ? {
                reason: `The answer was cut to fit ${MAX_SESSIONS_CHARS} characters. The most recent rows are kept; totals and spending cover every session.`,
                transactions: `${count("transactions_shown")} of ${count("transactions_total")} shown`,
                cargo_runs: `${count("cargo_runs_shown")} of ${count("cargo_runs_total")} shown`,
                hint: "Ask for fewer sessions, or a smaller max_transactions, to see the rest.",
              }
            : null;

        return ok({
          log_files_scanned: list.length,
          sessions_with_trades: sessions.length,
          ...(truncated ? { truncated } : {}),
          sessions,
          commodity_names: {
            source: wantNames
              ? "star-citizen.wiki commodity list, matched on the game's resource GUID (checked on real log GUIDs; hauling-contract names in the log agree for the ones that appear there)"
              : "not looked up",
            asked: guids.size,
            found: resolved.names.size,
            ...(resolved.error ? { lookup_error: resolved.error } : {}),
            note: "A GUID with no match is shown as 'unknown commodity'. The id is the first 8 characters of the GUID.",
          },
          reading_notes: [
            "total_auec is the TOTAL of the line. There is no wallet balance in Game.log: no net result is computed; gross_margin_auec is revenue minus cost of the paired SCU only.",
            "Cargo success is inferred (no error line within 3 s); the game logs only failures. Item purchases and sales carry the game's own response.",
            "ShopUI lines state no currency (shown as 'not stated (assumed aUEC)'); the small-kiosk flow states it.",
            "The autoload fee, fuel, insurance and rewards are not in the log. auto_loading only says the service was used.",
            "An error line that followed several cargo requests within 3 s cannot be attributed: those lines are 'ambiguous', listed as unconfirmed and not counted.",
            "Category is inferred from the item class name. location_hint is the last location token logged before the line, not a terminal.",
          ],
        });
      },
    },
  ];
}

function view(
  s: { file: string; truncated: boolean; running: boolean; parsed: ParsedLog },
  current: boolean,
  j: SessionJournal,
  take: number,
  runsCap: number,
  nameOf: (resource: string) => string,
) {
  const shown: Row[] = (take > 0 ? j.transactions.slice(-take) : []).map((t) => {
    const { resource, ...rest } = t;
    return resource ? { ...rest, commodity_name: nameOf(resource) } : rest;
  });
  const runs = (runsCap > 0 ? j.cargo_runs.slice(-runsCap) : []).map((r: CargoRun) => {
    const { resource, ...rest } = r;
    return { ...rest, commodity_name: nameOf(resource) };
  });
  const p = s.parsed;
  return {
    file: s.file.split(/[\\/]/).pop(),
    current,
    game_version: p.session.game_version,
    build: p.session.build,
    channel: p.session.channel,
    started_local: p.session.started_local,
    span: p.span,
    ...(s.truncated
      ? { note: "Large log: only the end of the file was read, earlier trades may be missing." }
      : {}),
    totals: j.totals,
    spending_by_category: j.spending_by_category,
    cargo_runs: runs,
    cargo_runs_shown: runs.length,
    cargo_runs_total: j.cargo_runs.length,
    transactions_total: j.transactions.length,
    transactions_shown: shown.length,
    transactions: shown,
  };
}
