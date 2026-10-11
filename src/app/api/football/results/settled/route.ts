import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { fetchBSDFootballFinishedRange } from "@/lib/bsd-football-fetcher";
import {
  loadCornerHistoryByEventIds,
  loadMatchStatsHistoryByEventIds,
} from "@/lib/football-history-db";
import { buildSettledResults, parseWindow } from "@/lib/football-results";
import { loadTop5Entries } from "@/lib/top5-backtest/store";
import { createTtlCache, isFresh, type TtlCacheEntry } from "@/lib/cached-route";

/**
 * GET /api/football/results/settled?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Résultats de l'onglet foot « Résultats » (vague 2) : les picks des 13
 * stratégies sur la fenêtre, réglés via `settleFootballPick` (moteur unique),
 * enrichis score / corners / tirs cadrés, avec P&L 1u fixe + agrégats.
 *
 *  - picks      : journal `data/top5-backtest/football.json` (cron 05:15 UTC,
 *                 rattrapage local : `bun scripts/backfill-top5-backtest.ts`)
 *  - matchs     : BSD `/matches/?status=finished` sur [from, to]
 *  - archives   : `match_stats_history` / `corner_history` (pariscore.db)
 *
 * Fenêtre par défaut : 7 derniers jours (plafond 31). TTL 10 min.
 */

const TTL_MS = 10 * 60_000;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const { from, to } = parseWindow(searchParams.get("from"), searchParams.get("to"));

  const cache = createTtlCache<Record<string, unknown>>(
    `__footballResultsSettled:${from}:${to}`,
  );
  const hit = cache.getEntry() as TtlCacheEntry<Record<string, unknown>> | null;
  if (isFresh(hit, TTL_MS) && hit) {
    return NextResponse.json(hit.data, {
      headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
    });
  }

  // 1. Picks du journal sur la fenêtre (kickoff dans [from, to]).
  const entries = loadTop5Entries("football").filter((e) => {
    const day = e.kickoff.slice(0, 10);
    return day >= from && day <= to;
  });

  // 2. Matchs terminés BSD — scores finaux, stats live (corners/SOT), cotes.
  const matchesById = new Map<string, Awaited<ReturnType<typeof fetchBSDFootballFinishedRange>>[number]>();
  const warnings: string[] = [];
  try {
    const matches = await fetchBSDFootballFinishedRange(from, to);
    for (const m of matches) matchesById.set(String(m.id), m);
  } catch (err) {
    // BSD indisponible → les verdicts déjà réglés restent affichables (score
    // journal), mais le rattrapage des pending et les stats live sont absents.
    warnings.push(`BSD : ${(err as Error).message}`);
  }

  // 3. Archives SQLite — corners / tirs cadrés quand live_stats manque.
  const ids = [...new Set(entries.map((e) => e.matchId))];
  const statsById = loadMatchStatsHistoryByEventIds(ids);
  const cornersById = loadCornerHistoryByEventIds(ids);

  // 4. Assemblage (règlement des pending via settleFootballPick).
  const payload = buildSettledResults({
    entries,
    matchesById,
    statsById,
    cornersById,
    from,
    to,
  });

  const body = { ...payload, warnings };
  cache.set(body);
  return NextResponse.json(body, {
    headers: { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" },
  });
}
