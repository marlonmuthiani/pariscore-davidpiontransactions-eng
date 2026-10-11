import { normalizeTeamName } from "@/lib/normalize-team-name";

/**
 * Confrontations directes (H2H) agrégées de façon déterministe.
 *
 * Répond à la limite L11 du audit : le prompt d'origine demandait des
 * « dynamiques réellement significatives » sans nombre de matchs ni période —
 * non vérifiable. Ici, l'échantillon et la période sont explicites.
 *
 * ponytail: bilan W/D/L brut ; une lecture des renversements de tendance
 * (ordre des résultats, séries) demande un second passage sur `notes`.
 */

export type H2hMeeting = {
  /** Kickoff ISO 8601. */
  kickoff: string;
  home: string;
  away: string;
  /** Null = match non terminé ou score non remonté. */
  homeScore: number | null;
  awayScore: number | null;
};

export type H2hStats = {
  /** Nombre de confrontations retenues (scores connus uniquement). */
  sampleSize: number;
  /** Kickoff ISO de la confrontation la plus ancienne de l'échantillon. */
  periodFrom: string | null;
  /** Kickoff ISO de la confrontation la plus récente de l'échantillon. */
  periodTo: string | null;
  /** Bilan du point de vue de `teamA` (premier argument). */
  teamAWins: number;
  draws: number;
  teamBWins: number;
  notes: string[];
};

/** Échantillon par défaut aligné sur la fenêtre L10 du reste du pipeline. */
export const DEFAULT_H2H_LIMIT = 10;

/**
 * Calcule le H2H entre `teamA` et `teamB`. Les rencontres sans score sont
 * écartées (jamais estimées). Tri du plus récent au plus ancien.
 */
export function headToHead(
  meetings: H2hMeeting[],
  teamA: string,
  teamB: string,
  limit = DEFAULT_H2H_LIMIT,
): H2hStats {
  const a = normalizeTeamName(teamA);
  const b = normalizeTeamName(teamB);
  const empty: H2hStats = {
    sampleSize: 0,
    periodFrom: null,
    periodTo: null,
    teamAWins: 0,
    draws: 0,
    teamBWins: 0,
    notes: ["Aucune confrontation terminée entre ces deux équipes."],
  };
  if (!a || !b || a === b || limit <= 0) return empty;

  const rows = meetings
    .filter((m) => {
      if (m.homeScore == null || m.awayScore == null) return false;
      const h = normalizeTeamName(m.home);
      const w = normalizeTeamName(m.away);
      return (h === a && w === b) || (h === b && w === a);
    })
    .sort((x, y) => (x.kickoff < y.kickoff ? 1 : x.kickoff > y.kickoff ? -1 : 0))
    .slice(0, limit);

  if (rows.length === 0) return empty;

  let teamAWins = 0;
  let draws = 0;
  let teamBWins = 0;
  for (const m of rows) {
    const h = normalizeTeamName(m.home);
    const isAHome = h === a;
    const aGoals = isAHome ? (m.homeScore as number) : (m.awayScore as number);
    const bGoals = isAHome ? (m.awayScore as number) : (m.homeScore as number);
    if (aGoals > bGoals) teamAWins++;
    else if (aGoals < bGoals) teamBWins++;
    else draws++;
  }

  const notes: string[] = [];
  if (rows.length < 3) notes.push("Échantillon insuffisant pour dégager une dynamique.");

  return {
    sampleSize: rows.length,
    periodFrom: rows[rows.length - 1].kickoff,
    periodTo: rows[0].kickoff,
    teamAWins,
    draws,
    teamBWins,
    notes,
  };
}
