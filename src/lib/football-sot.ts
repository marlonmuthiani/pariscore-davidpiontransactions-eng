import { normalizeTeamName } from "@/lib/normalize-team-name";

/**
 * Agrégation des tirs cadrés (SOT) par équipe, fenêtres L5 / L10, contexte
 * Domicile / Extérieur strictement séparés.
 *
 * Source amont : `homeShotsOnTarget` / `awayShotsOnTarget` de `FootballMatch`
 * (`src/lib/football-data.ts`), alimentés par `live_stats.*.shots_on_target`
 * de BSD (`src/lib/bsd-football-fetcher.ts:315-316`).
 *
 * ponytail: agrégat mémoire sur les matchs déjà chargés ; si le nombre de
 * ligues couvertes rend le tri/copy coûteux, pré-calculer un index par équipe
 * dans le cron quotidien.
 */

export type SotMatch = {
  /** Kickoff ISO 8601 — sert au tri interne (du plus récent au plus ancien). */
  kickoff: string;
  home: string;
  away: string;
  homeShotsOnTarget: number | null;
  awayShotsOnTarget: number | null;
};

export type SotWindow = {
  /** Nombre de matchs réellement agrégés (peut être < N en début de saison). */
  gp: number;
  /** Moyenne de tirs cadrés marqués. */
  for: number | null;
  /** Moyenne de tirs cadrés encaissés. */
  against: number | null;
};

export type TeamSotStats = { l5: SotWindow | null; l10: SotWindow | null };

export type MatchSotStats = { home: TeamSotStats; away: TeamSotStats };

export type SotSide = "home" | "away";

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Tri défensif : index 0 = match le plus récent, quoi que fournisse l'appelant. */
function newestFirst(matches: SotMatch[]): SotMatch[] {
  return [...matches].sort((a, b) => (a.kickoff < b.kickoff ? 1 : a.kickoff > b.kickoff ? -1 : 0));
}

/**
 * Fenêtre SOT pour `team` jouant côté `side`. Les matchs sans valeur SOT
 * (champ null) sont exclus de la fenêtre : on n'estime jamais une valeur
 * absente.
 */
export function sotWindow(matches: SotMatch[], team: string, side: SotSide, n: number): SotWindow | null {
  if (n <= 0) return null;
  const key = normalizeTeamName(team);
  if (!key) return null;

  const rows = newestFirst(matches).filter((m) => {
    // Les deux côtés doivent être renseignés : on calcule `for` ET `against`
    // sur le même match, jamais à moitié (sinon NaN).
    if (m.homeShotsOnTarget == null || m.awayShotsOnTarget == null) return false;
    const playsHere = side === "home" ? normalizeTeamName(m.home) : normalizeTeamName(m.away);
    return playsHere === key;
  });

  const slice = rows.slice(0, n);
  if (slice.length === 0) return null;

  let forSum = 0;
  let againstSum = 0;
  for (const m of slice) {
    if (side === "home") {
      forSum += m.homeShotsOnTarget as number;
      againstSum += m.awayShotsOnTarget as number;
    } else {
      forSum += m.awayShotsOnTarget as number;
      againstSum += m.homeShotsOnTarget as number;
    }
  }

  return {
    gp: slice.length,
    for: r2(forSum / slice.length),
    against: r2(againstSum / slice.length),
  };
}

/** Fenêtres L5 et L10 d'une équipe dans un contexte (Domicile / Extérieur). */
export function teamSot(matches: SotMatch[], team: string, side: SotSide): TeamSotStats {
  return { l5: sotWindow(matches, team, side, 5), l10: sotWindow(matches, team, side, 10) };
}

/**
 * Stats SOT du match : l'équipe reçoit (`home`), contexte Domicile ;
 * l'équipe visite (`away`), contexte Extérieur.
 */
export function matchSot(homeTeam: string, awayTeam: string, matches: SotMatch[]): MatchSotStats {
  return { home: teamSot(matches, homeTeam, "home"), away: teamSot(matches, awayTeam, "away") };
}
