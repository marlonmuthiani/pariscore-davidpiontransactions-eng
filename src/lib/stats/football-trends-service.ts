// Service « Tendances » football — hit rates par marché et par ligue.
//
// Source : table `league_season_stats` de pariscore.db (peuplée par
// scripts/scrape-oddalerts.js, cron quotidien). Chaque ligne porte `statsJson`
// (sections general/over_under/halves/cards/btts/corners avec `pct` par
// marché = hit rate saison de la ligue, exactement la donnée des cartes
// OddAlerts /trends) et `fixturesJson` (prochains matchs + cotes 1X2).
//
// Granularité LIGUE (pas équipe) : pariscore.db n'a pas d'historique football
// par équipe. ponytail: brancher football_match_history (cf. rapport
// .context/RAPPORT-ODDALERTS-TRENDS.md §6) pour passer en granularité équipe.
//
// Lecture readonly (bun:sqlite → better-sqlite3 fallback), même pattern que
// src/lib/leagues-stats/db.ts — jamais de concurrence avec les writers.

import path from "node:path";

/* ─── Types publics ─── */

export type TrendCategory = "resultats" | "buts" | "corners" | "cartons";

export type TrendFixture = {
  kickoff: string | null;
  homeName: string;
  homeBadge: string | null;
  awayName: string;
  awayBadge: string | null;
  oddsHome: number | null;
  oddsDraw: number | null;
  oddsAway: number | null;
};

export type TrendEntry = {
  marketId: string;
  label: string;
  category: TrendCategory;
  leagueId: string;
  leagueName: string;
  country: string;
  logoUrl: string | null;
  seasonLabel: string | null;
  /** Hit rate saison de la ligue sur le marché (%, = champ pct d'OddAlerts). */
  hitPct: number;
  /** Matchs satisfaisant le marché / matchs joués. */
  hits: number;
  gamesPlayed: number;
  /** Cote 1X2 mappée au marché (uniquement marchés Résultats). */
  odds: number | null;
  /** hitPct − 100/cote, en points. Null sans cote mappée. */
  edge: number | null;
  fixture: TrendFixture | null;
};

export type TrendsMarketGroup = {
  marketId: string;
  label: string;
  category: TrendCategory;
  entries: TrendEntry[];
};

export type FootballTrendsPayload = {
  generatedAt: string;
  leaguesScanned: number;
  markets: TrendsMarketGroup[];
};

export type TrendsQuery = {
  category?: TrendCategory | "all";
  /** Matchs joués minimum pour qu'une ligue soit éligible. */
  minGames?: number;
  /** Hit rate minimum (%) pour qu'une ligue soit une « tendance ». */
  minHitPct?: number;
  /** Nombre max de ligues retournées par marché. */
  limitPerMarket?: number;
};

/* ─── Catalogue des marchés ─── */

type MarketDef = {
  /** Clé de l'item dans statsJson (ex: "over_2_5_goals"). */
  key: string;
  marketId: string;
  label: string;
  category: TrendCategory;
  /** Côté 1X2 mappé au marché (permet le calcul d'edge). */
  oddsSide?: "home" | "draw" | "away";
};

const MARKETS: MarketDef[] = [
  // Résultats (edge calculable via cotes 1X2 des fixtures)
  { key: "home_wins", marketId: "home-wins", label: "Victoires à domicile", category: "resultats", oddsSide: "home" },
  { key: "draws", marketId: "draws", label: "Matchs nuls", category: "resultats", oddsSide: "draw" },
  { key: "away_wins", marketId: "away-wins", label: "Victoires à l'extérieur", category: "resultats", oddsSide: "away" },
  // Buts
  { key: "over_1_5_goals", marketId: "over-1-5", label: "Over 1.5 buts", category: "buts" },
  { key: "over_2_5_goals", marketId: "over-2-5", label: "Over 2.5 buts", category: "buts" },
  { key: "over_3_5_goals", marketId: "over-3-5", label: "Over 3.5 buts", category: "buts" },
  { key: "btts", marketId: "btts", label: "BTTS (les deux marquent)", category: "buts" },
  { key: "btts_2_5_goals", marketId: "btts-2-5", label: "BTTS & 2.5+ buts", category: "buts" },
  { key: "over_0_5_1h_goals", marketId: "over-0-5-1h", label: "But en 1ère mi-temps", category: "buts" },
  { key: "over_1_5_1h_goals", marketId: "over-1-5-1h", label: "Over 1.5 buts 1ère MT", category: "buts" },
  // Corners
  { key: "over_7_5_corners", marketId: "over-7-5-corners", label: "Over 7.5 corners", category: "corners" },
  { key: "over_8_5_corners", marketId: "over-8-5-corners", label: "Over 8.5 corners", category: "corners" },
  { key: "over_9_5_corners", marketId: "over-9-5-corners", label: "Over 9.5 corners", category: "corners" },
  // Cartons
  { key: "over_3_5_cards", marketId: "over-3-5-cards", label: "Over 3.5 cartons", category: "cartons" },
  { key: "over_4_5_cards", marketId: "over-4-5-cards", label: "Over 4.5 cartons", category: "cartons" },
];

/** Catégories exposées à l'UI (filtres). */
export const TREND_CATEGORIES: { id: TrendCategory | "all"; label: string }[] = [
  { id: "all", label: "Tous" },
  { id: "resultats", label: "Résultats" },
  { id: "buts", label: "Buts" },
  { id: "corners", label: "Corners" },
  { id: "cartons", label: "Cartons" },
];

/* ─── Accès SQLite readonly (pattern leagues-stats/db.ts) ─── */

type BSD = {
  prepare: (sql: string) => { all: (...params: unknown[]) => unknown[]; get: (...params: unknown[]) => unknown };
  close: () => void;
};

const SQLITE_FILE =
  process.env.DATABASE_PATH || path.join(process.cwd(), "pariscore.db");

let _db: BSD | null = null;
let _dbUnavailable = false;

function getDb(): BSD | null {
  if (_dbUnavailable) return null;
  if (_db) return _db;
  try {
    // `eval("require")` : évite que le bundler réécrive `require("bun:sqlite")`
    // en résolution Node (échec constaté en bundle standalone, cf.
    // handball-history-db.ts). Le runtime sait charger bun:sqlite.
    const req = eval("require") as NodeRequire;
    const { Database } = req("bun:sqlite") as { Database: new (file: string, opts?: object) => BSD };
    _db = new Database(SQLITE_FILE, { readonly: true });
    return _db;
  } catch (bunErr) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require("better-sqlite3") as unknown as {
        new (file: string, opts?: { readonly?: boolean; fileMustExist?: boolean }): BSD;
      };
      _db = new Database(SQLITE_FILE, { readonly: true, fileMustExist: true });
      return _db;
    } catch (nodeErr) {
      _dbUnavailable = true;
      console.warn(
        `[football-trends] Aucun pilote SQLite n'a pu ouvrir ${SQLITE_FILE} — ` +
          `bun:sqlite: ${String(bunErr).split("\n")[0]} · better-sqlite3: ${String(nodeErr).split("\n")[0]}. ` +
          "Tendances football désactivées."
      );
      return null;
    }
  }
}

/* ─── Parsing statsJson / fixturesJson ─── */

type StatsItem = { key: string; value: number | null; pct: number | null; avg: number | null };
type StatsSection = { id: string; title: string; items: StatsItem[] };
type RawFixture = {
  kickoffText?: string;
  home?: { name?: string; badge?: string };
  away?: { name?: string; badge?: string };
  odds?: { home?: number; draw?: number; away?: number };
};

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/* ─── Calcul ─── */

/**
 * Edge (points) : hit rate − probabilité implicite de la cote.
 * Formule OddAlerts (« Edge column: hit rate vs the bookmaker's implied odds »),
 * cote non dévigée. Retourne null si la cote est absente ou aberrante (≤ 1).
 */
export function computeEdge(hitPct: number, odds: number | null): number | null {
  if (odds == null || odds <= 1) return null;
  return Math.round(hitPct - 100 / odds);
}

/**
 * Tendances football : pour chaque marché du catalogue, les ligues dont le hit
 * rate saison dépasse `minHitPct` (tri décroissant, top `limitPerMarket`).
 * Chaque entrée embarque le prochain fixture de la ligue et l'edge (marchés
 * Résultats uniquement — fixturesJson ne porte que les cotes 1X2).
 */
export function getFootballTrends(query: TrendsQuery = {}): FootballTrendsPayload {
  const {
    category = "all",
    minGames = 6,
    minHitPct = 55,
    limitPerMarket = 5,
  } = query;

  const db = getDb();
  if (!db) return { generatedAt: new Date().toISOString(), leaguesScanned: 0, markets: [] };

  const rows = db
    .prepare(
      `SELECT id, country, leagueName, logoUrl, seasonLabel, gamesPlayed, statsJson, fixturesJson
       FROM league_season_stats
       WHERE gamesPlayed >= ?
         AND sport = 'football'
         AND statsJson IS NOT NULL
       ORDER BY leagueName ASC`
    )
    .all(minGames) as Record<string, unknown>[];

  const groups: TrendsMarketGroup[] = [];

  for (const market of MARKETS) {
    if (category !== "all" && market.category !== category) continue;

    const entries: TrendEntry[] = [];
    for (const row of rows) {
      const sections = parseJsonSafe<StatsSection[]>(row.statsJson as string, []);
      const section = sections.find((s) => s.id === sectionIdForKey(market.key));
      const item = section?.items.find((i) => i.key === market.key);
      if (!item || item.pct == null || item.value == null) continue;

      const gamesPlayed = Number(row.gamesPlayed || 0);
      if (gamesPlayed < minGames) continue;
      // Cohérence défensive : le pct scrapé doit rester plausible.
      const hitPct = Math.round(item.pct);
      if (hitPct < minHitPct) continue;

      const fixtures = parseJsonSafe<RawFixture[]>(row.fixturesJson as string, []);
      const raw = fixtures.find((f) => f.home?.name && f.away?.name) ?? null;

      let fixture: TrendFixture | null = null;
      if (raw) {
        fixture = {
          kickoff: raw.kickoffText ?? null,
          homeName: String(raw.home?.name ?? ""),
          homeBadge: raw.home?.badge ?? null,
          awayName: String(raw.away?.name ?? ""),
          awayBadge: raw.away?.badge ?? null,
          oddsHome: raw.odds?.home ?? null,
          oddsDraw: raw.odds?.draw ?? null,
          oddsAway: raw.odds?.away ?? null,
        };
      }

      // Edge : uniquement quand un côté 1X2 est mappé et coté.
      let odds: number | null = null;
      let edge: number | null = null;
      if (market.oddsSide && fixture) {
        odds =
          market.oddsSide === "home" ? fixture.oddsHome
          : market.oddsSide === "draw" ? fixture.oddsDraw
          : fixture.oddsAway;
        edge = computeEdge(hitPct, odds);
      }

      entries.push({
        marketId: market.marketId,
        label: market.label,
        category: market.category,
        leagueId: String(row.id),
        leagueName: String(row.leagueName),
        country: String(row.country ?? ""),
        logoUrl: (row.logoUrl as string) || null,
        seasonLabel: (row.seasonLabel as string) || null,
        hitPct,
        hits: Number(item.value),
        gamesPlayed,
        odds,
        edge,
        fixture,
      });
    }

    // Tri OddAlerts : hit rate décroissant, puis volume de preuve décroissant.
    entries.sort((a, b) => b.hitPct - a.hitPct || b.hits - a.hits);
    if (entries.length > 0) {
      groups.push({
        marketId: market.marketId,
        label: market.label,
        category: market.category,
        entries: entries.slice(0, limitPerMarket),
      });
    }
  }

  return { generatedAt: new Date().toISOString(), leaguesScanned: rows.length, markets: groups };
}

/** Section statsJson qui porte une clé de marché donnée. */
function sectionIdForKey(key: string): string {
  if (key.startsWith("over_") && key.endsWith("_corners")) return "corners";
  if (key.startsWith("over_") && key.endsWith("_cards")) return "cards";
  if (key.startsWith("btts")) return "btts";
  if (key.endsWith("_goals") && (key.includes("_1h_") || key.includes("_2h_"))) return "halves";
  if (key === "home_wins" || key === "draws" || key === "away_wins" || key === "games_played" || key === "total_goals") return "general";
  return "over_under";
}
