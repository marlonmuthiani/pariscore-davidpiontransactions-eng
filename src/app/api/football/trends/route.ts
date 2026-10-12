import { NextResponse } from "next/server";
import { getFootballTrends } from "@/lib/stats/football-trends-service";

/**
 * GET /api/football/trends[?category=resultats|buts|corners|cartons]
 *
 * Tendances football (modèle OddAlerts /trends) : hit rates saison par ligue
 * et par marché, croisées avec le prochain fixture + cotes 1X2 de la ligue.
 * Cache serveur 30 min (les stats OddAlerts sont re-scrapées toutes les 6 h).
 */
const CACHE_TTL = 30 * 60_000;

let _cache: { at: number; data: ReturnType<typeof getFootballTrends> } | null = null;

const VALID_CATEGORIES = new Set(["all", "resultats", "buts", "corners", "cartons"]);

export async function GET(request: Request) {
  if (!_cache || Date.now() - _cache.at > CACHE_TTL) {
    _cache = { at: Date.now(), data: getFootballTrends({ category: "all" }) };
  }

  const url = new URL(request.url);
  const category = url.searchParams.get("category");
  const markets = VALID_CATEGORIES.has(category ?? "")
    ? _cache.data.markets.filter((m) => category === "all" || m.category === category)
    : _cache.data.markets;

  return NextResponse.json(
    {
      generatedAt: _cache.data.generatedAt,
      leaguesScanned: _cache.data.leaguesScanned,
      markets,
    },
    { headers: { "Cache-Control": "public, max-age=1800, stale-while-revalidate=3600" } },
  );
}
