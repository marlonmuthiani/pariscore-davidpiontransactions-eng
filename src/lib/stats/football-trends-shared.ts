// Module partagé « Tendances » football — types + catalogue + formule pure.
//
// CLIENT-SAFE : aucun import Node (ni node:path, ni eval/require/bun:sqlite).
// ⚠️ Ne JAMAIS importer football-trends-service.ts depuis un composant client :
// le service porte l'accès SQLite serveur, et son import dans le graphe
// navigateur casse le build Next.js (module-not-found, constaté au deploy du
// 2026-10-12). Ce module est la frontière : le client importe ICI, le serveur
// importe le service.

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

/** Catégories exposées à l'UI (filtres). */
export const TREND_CATEGORIES: { id: TrendCategory | "all"; label: string }[] = [
  { id: "all", label: "Tous" },
  { id: "resultats", label: "Résultats" },
  { id: "buts", label: "Buts" },
  { id: "corners", label: "Corners" },
  { id: "cartons", label: "Cartons" },
];

/**
 * Edge (points) : hit rate − probabilité implicite de la cote.
 * Formule OddAlerts (« Edge column: hit rate vs the bookmaker's implied odds »),
 * cote non dévigée. Retourne null si la cote est absente ou aberrante (≤ 1).
 */
export function computeEdge(hitPct: number, odds: number | null): number | null {
  if (odds == null || odds <= 1) return null;
  return Math.round(hitPct - 100 / odds);
}
