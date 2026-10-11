// Goal Timing Service — statistiques de timing des buts façon OddAlerts.
//
// Deux parties :
//  1. Calcul pur (testé) : `computeTeamGoalTiming` / `computeFirstToScore` —
//     aucune dépendance réseau, consomme des timelines de buts par match.
//  2. Orchestration BSD : `getMatchTimingStats(matchId)` — résout les deux
//     équipes, récupère leurs N derniers matchs terminés (`/v2/teams/{id}/matches/`)
//     puis les minutes de buts par match (`/v2/events/{id}/stats/`, shotmap),
//     avec caches mémoire longs (l'historique terminé ne change jamais).

import {
  fetchBSDFootballMatchMeta,
  fetchBSDTeamRecentMatches,
  fetchBSDMatchStats,
  type BSDTeamMatchLite,
} from "../bsd-football-fetcher";

// ─── Contrat de données (pur) ────────────────────────────────────────────────

/** Fenêtre de 5' → la moins fine que la source BSD shotmap nous garantit. */
export type TeamMatchContext = "home" | "away";

/** Buts d'un match terminé, vus du point de vue d'une équipe. */
export interface TeamMatchGoalTimeline {
  /** Contexte du match pour l'équipe suivie. */
  context: TeamMatchContext;
  /** Minutes des buts marqués par l'équipe (ordre libre). */
  goalsFor: number[];
  /** Minutes des buts encaissés par l'équipe. */
  goalsAgainst: number[];
}

/** Profil de timing d'une équipe sur un échantillon de matchs terminés. */
export interface TeamGoalTimingStats {
  /** Matchs analysés (échantillon total, y compris 0-0). */
  matches: number;
  /** Matchs avec au moins un but connu. */
  matchesWithGoals: number;
  /** Minute moyenne du premier but du match (toutes équipes confondues). */
  avgFirstGoalMatch: number | null;
  /** Minute moyenne du premier but MARQUÉ par l'équipe. */
  avgFirstGoalScored: number | null;
  /** Minute moyenne du premier but ENCAISSÉ par l'équipe. */
  avgFirstGoalConceded: number | null;
  /** % de matchs avec un but (pour ou contre) entre la 0' et la 15'. */
  pctGoal0to15: number | null;
  /** % de matchs avec un but entre la 35' et la 45'. */
  pctGoal35to45: number | null;
  /** % de matchs avec un but après la 70'. */
  pctGoalAfter70: number | null;
  /** % de matchs (avec but) où l'équipe marque avant l'adversaire. */
  scoresFirstPct: number | null;
  /** % de matchs (avec but) où l'équipe encaisse avant de marquer. */
  concedesFirstPct: number | null;
}

// ─── Calcul pur ──────────────────────────────────────────────────────────────

const avg = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

const pct = (n: number, d: number): number | null => (d <= 0 ? null : Math.round((n / d) * 100));

/** Premier but d'un camp : minute la plus petite, null si le camp n'a pas marqué. */
const firstMinute = (xs: number[]): number | null =>
  xs.length === 0 ? null : Math.min(...xs);

/**
 * Agrège un échantillon de matchs terminés en profil de timing.
 * Un match sans but connu (0-0 ou shotmap vide) compte dans les
 * dénominateurs de pourcentages mais jamais dans les moyennes de première minute.
 */
export function computeTeamGoalTiming(timelines: TeamMatchGoalTimeline[]): TeamGoalTimingStats {
  const all = timelines.filter(
    (t) => t && Array.isArray(t.goalsFor) && Array.isArray(t.goalsAgainst),
  );
  const matchesWithGoals = all.filter(
    (t) => t.goalsFor.length + t.goalsAgainst.length > 0,
  );

  // Premier but du match = min sur toutes les minutes du match.
  const firstGoalMatch = matchesWithGoals.map((t) =>
    Math.min(firstMinute(t.goalsFor) ?? Infinity, firstMinute(t.goalsAgainst) ?? Infinity),
  );
  const firstGoalFor = all.map((t) => firstMinute(t.goalsFor)).filter((m): m is number => m != null);
  const firstGoalAgainst = all.map((t) => firstMinute(t.goalsAgainst)).filter((m): m is number => m != null);

  const hasGoalIn = (t: TeamMatchGoalTimeline, lo: number, hi: number) =>
    [...t.goalsFor, ...t.goalsAgainst].some((m) => m >= lo && m <= hi);
  const countIn = (lo: number, hi: number) => all.filter((t) => hasGoalIn(t, lo, hi)).length;

  // Premier à marquer : minute stricte (égalité de minute = personne).
  let scoresFirst = 0;
  let concedesFirst = 0;
  for (const t of matchesWithGoals) {
    const mine = firstMinute(t.goalsFor);
    const theirs = firstMinute(t.goalsAgainst);
    if (mine == null && theirs == null) continue;
    if (theirs == null || (mine != null && mine < theirs)) scoresFirst += 1;
    else if (mine == null || (theirs != null && theirs < mine)) concedesFirst += 1;
  }

  return {
    matches: all.length,
    matchesWithGoals: matchesWithGoals.length,
    avgFirstGoalMatch: avg(firstGoalMatch.map((m) => (Number.isFinite(m) ? m : NaN)).filter(Number.isFinite)),
    avgFirstGoalScored: avg(firstGoalFor),
    avgFirstGoalConceded: avg(firstGoalAgainst),
    pctGoal0to15: pct(countIn(0, 15), all.length),
    pctGoal35to45: pct(countIn(35, 45), all.length),
    pctGoalAfter70: pct(all.filter((t) => [...t.goalsFor, ...t.goalsAgainst].some((m) => m > 70)).length, all.length),
    scoresFirstPct: pct(scoresFirst, matchesWithGoals.length),
    concedesFirstPct: pct(concedesFirst, matchesWithGoals.length),
  };
}

/**
 * Modèle « Premier à marquer » : croise l'attaque précoce de l'équipe à
 * domicile avec la vulnérabilité précoce de l'équipe à l'extérieur (et vice
 * versa), puis normalise. Retourne des % entiers sommant à 100, ou null si
 * les deux profils sont inexploitables (aucun match avec but).
 */
export function computeFirstToScore(
  home: TeamGoalTimingStats,
  away: TeamGoalTimingStats,
): { home: number; away: number } | null {
  const hs = home.scoresFirstPct;
  const hc = home.concedesFirstPct;
  const as = away.scoresFirstPct;
  const ac = away.concedesFirstPct;
  if (hs == null || hc == null || as == null || ac == null) return null;
  const wHome = (hs / 100) * (ac / 100);
  const wAway = (as / 100) * (hc / 100);
  const sum = wHome + wAway;
  if (sum <= 0) return null;
  const homePct = Math.round((wHome / sum) * 100);
  return { home: homePct, away: 100 - homePct };
}

// ─── Orchestration BSD ───────────────────────────────────────────────────────

/** Nombre de matchs terminés analysés par équipe. */
const RECENT_MATCHES = 10;
/** Cache listes matchs d'équipe : un match terminé n'entre plus dans l'historique. */
const TEAM_MATCHES_TTL = 6 * 60 * 60_000;
/** Cache minutes de buts d'un match terminé : immuable. */
const GOALS_TTL = 24 * 60 * 60_000;
/** Cache payload complet par fixture (les matchs passés ne changent plus). */
const PAYLOAD_TTL = 60 * 60_000;

type Cached<T> = { at: number; data: T };
const g = globalThis as unknown as {
  __goalTimingTeamMatches?: Map<number, Cached<BSDTeamMatchLite[]>>;
  __goalTimingMatchGoals?: Map<number, Cached<{ minute: number; home: boolean }[]>>;
  __goalTimingPayload?: Map<string, Cached<MatchTimingStatsPayload | null>>;
};
g.__goalTimingTeamMatches ??= new Map();
g.__goalTimingMatchGoals ??= new Map();
g.__goalTimingPayload ??= new Map();

function cached<T>(m: Map<string | number, Cached<T>>, key: string | number, ttl: number, build: () => Promise<T>): Promise<T> {
  const hit = m.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.data);
  return build().then((data) => {
    // Un échec (null) n'est jamais mis en cache : retry possible au prochain hit.
    if (data != null) m.set(key, { at: Date.now(), data });
    return data;
  });
}

/** Minutes de buts d'un match terminé (BSD shotmap, via fetchBSDMatchStats). */
function fetchMatchGoals(matchId: number): Promise<{ minute: number; home: boolean }[]> {
  return cached(g.__goalTimingMatchGoals!, matchId, GOALS_TTL, async () => {
    try {
      const stats = await fetchBSDMatchStats(String(matchId));
      return stats.goals.filter((x) => Number.isFinite(x.minute));
    } catch {
      return []; // 402/429/réseau → match sans données, dégradé silencieux
    }
  });
}

/** Construit les timelines de buts d'une équipe sur ses N derniers matchs terminés. */
async function buildTeamTimelines(teamId: number): Promise<TeamMatchGoalTimeline[]> {
  const matches = await cached(g.__goalTimingTeamMatches!, teamId, TEAM_MATCHES_TTL, () =>
    fetchBSDTeamRecentMatches(teamId, RECENT_MATCHES * 2),
  );
  const finished = matches
    .filter((m) => m.status.trim().toLowerCase() === "finished")
    .slice(0, RECENT_MATCHES);
  const goals = await Promise.all(finished.map((m) => fetchMatchGoals(m.id)));
  return finished.map((m, i) => {
    const isHome = m.homeTeamId === teamId;
    const gs = goals[i];
    return {
      context: (isHome ? "home" : "away") as TeamMatchContext,
      goalsFor: gs.filter((x) => x.home === isHome).map((x) => x.minute),
      goalsAgainst: gs.filter((x) => x.home !== isHome).map((x) => x.minute),
    };
  });
}

/** Profil par contexte (global / matchs à domicile / matchs à l'extérieur). */
export interface TeamTimingContexts {
  all: TeamGoalTimingStats;
  home: TeamGoalTimingStats;
  away: TeamGoalTimingStats;
}

/** Payload complet servi par la route /api/football/matches/{id}/timing. */
export interface MatchTimingStatsPayload {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  /** Taille des échantillons réellement analysés (matchs avec ou sans but). */
  sample: { home: number; away: number };
  home: TeamTimingContexts;
  away: TeamTimingContexts;
  /** Modèle « premier à marquer » (% normalisés) — null si inexploitable. */
  firstToScore: { home: number; away: number } | null;
}

/**
 * Statistiques de timing des buts pour une fixture BSD (match pas encore
 * commencé ou live) : profils des deux équipes sur leurs N derniers matchs
 * terminés + proba « premier à marquer ». Retourne null si les ids d'équipe
 * BSD sont introuvables (fixture non résolue).
 */
export async function getMatchTimingStats(matchId: string): Promise<MatchTimingStatsPayload | null> {
  return cached(g.__goalTimingPayload!, matchId, PAYLOAD_TTL, async () => {
    const meta = await fetchBSDFootballMatchMeta(matchId);
    if (!meta || meta.homeTeamId == null || meta.awayTeamId == null) return null as MatchTimingStatsPayload | null;

    const [homeTimelines, awayTimelines] = await Promise.all([
      buildTeamTimelines(meta.homeTeamId),
      buildTeamTimelines(meta.awayTeamId),
    ]);

    const contexts = (ts: TeamMatchGoalTimeline[]): TeamTimingContexts => ({
      all: computeTeamGoalTiming(ts),
      home: computeTeamGoalTiming(ts.filter((t) => t.context === "home")),
      away: computeTeamGoalTiming(ts.filter((t) => t.context === "away")),
    });

    const home = contexts(homeTimelines);
    const away = contexts(awayTimelines);

    return {
      matchId,
      homeTeam: meta.homeTeam,
      awayTeam: meta.awayTeam,
      sample: { home: home.all.matches, away: away.all.matches },
      home,
      away,
      firstToScore: computeFirstToScore(home.all, away.all),
    } satisfies MatchTimingStatsPayload;
  });
}
