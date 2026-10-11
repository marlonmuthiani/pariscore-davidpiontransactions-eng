import type { FootballMatch } from "@/lib/football-data";
import { devig1x2 } from "@/lib/football-devig";

/**
 * Rapport de match IA — Phase 2 de la suite AI Pricing.
 *
 * Le rapport est généré par Gemini à partir d'un payload structuré construit
 * depuis le modèle PariScore (prédictions, classement, forme, xG, cotes). Il
 * produit une synthèse narrative, 3 faits marquants et une suggestion de combiné.
 *
 * Ce module reste PUR (aucun import `node:fs`) : il est importé par le hook
 * client `use-football-ai-report.ts` — y ajouter un lecteur disque ferait entrer
 * `fs` dans le bundle client. La résolution serveur vit dans
 * `football-match-report-v2.ts`.
 *
 * Le payload client porte l'IDENTITÉ du match + les données résolues côté
 * client : la route v2 et le cron (`api/ai/report-cron`) y relisent l'identité
 * via `identityFromPayload()` sans jamais la deviner.
 */

export type AIPredictiveBet = {
  /** Label du pari (ex: "Double Chance 1X", "Over 2.5 Buts"). */
  label: string;
  /** Probabilité estimée par l'IA [0-100]. */
  prob: number;
  /** Cote décimale indicative (null si non estimable). */
  odds: number | null;
  /** Niveau de confiance du pari [1-5]. */
  confidence: number;
  /** Rationale courte (1 phrase). */
  rationale: string;
};

export type FootballAIReport = {
  /** Synthèse narrative (2-3 phrases) sur la physionomie attendue du match. */
  synthesis: string;
  /** 3 faits statistiques marquants. */
  keyFacts: string[];
  /** 3 paris prédictifs générés par l'IA. */
  predictiveBets: AIPredictiveBet[];
  /** Suggestion de combiné (null si aucun ne se détache). */
  combo: { label: string; rationale: string } | null;
  /** Confiance 1-5. */
  confidence: number;
  // ── Métadonnées de traçabilité (pont v2 → UI v1, `toLegacyReport`) ──
  /** Absentes sur les rapports v1 purs : la UI ne doit pas les exiger. */
  generatedAt?: string;
  model?: string;
  groundingUsed?: boolean;
  dataSources?: string[];
};

/** Identité du match, extraite du payload client — jamais devinée côté serveur. */
export type ReportIdentity = {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  leagueId: string;
  leagueName: string;
  round: string | null;
  kickoffIso: string;
};

/**
 * Limite L8 (audit mission 2) : borne la connaissance du modèle à une date
 * explicite — sans elle, le LLM affirme des faits postérieurs à sa coupure
 * d'entraînement comme s'il les connaissait.
 *
 * ponytail: valeur statique conservative (un cutoff trop tôt ne fait que
 * restreindre le modèle ; trop tardif, il l'invite à affirmer des faits
 * qu'il ne connaît pas) — lire le cutoff documenté du modèle actif
 * (GEMINI_MODEL, défaut gemini-3.6-flash) quand l'API l'expose.
 */
export const REPORT_KNOWLEDGE_CUTOFF = "2026-01-31";

/** Les 21 clés du contrat v2 — `hasAllPayloadKeys()` les vérifie une à une. */
export const REPORT_PAYLOAD_KEYS: readonly string[] = [
  "match_id",
  "team_home",
  "team_away",
  "league",
  "round",
  "kickoff_iso",
  "generated_at_iso",
  "knowledge_cutoff_iso",
  "season",
  "probabilities_json",
  "xg_json",
  "form_json",
  "standings_json",
  "sot_json",
  "odds_json",
  "odds_devig_json",
  "injuries_home_json",
  "injuries_away_json",
  "press_review_json",
  "h2h_json",
  "schedule_json",
];

/** Saison footballière dérivée du kickoff ("2026-09-15" → "2026/27") ; null si illisible. */
export function seasonFromKickoff(kickoffIso: string): string | null {
  const y = Number(kickoffIso?.slice(0, 4));
  if (!Number.isFinite(y)) return null;
  const startYear = Number(kickoffIso.slice(5, 7)) >= 7 ? y : y - 1;
  return `${startYear}/${String(startYear + 1).slice(2).padStart(2, "0")}`;
}

/**
 * Construit le payload client (17 clés) envoyé à la route v1 et consommé par
 * la route v2/cron. L'identité (`match_id`, `team_home`… `kickoff_iso`) et les
 * cotes dévigées (`odds_devig_json`, limite L7) y sont résolues une seule fois.
 */
export function buildReportPayload(match: FootballMatch): Record<string, unknown> {
  const p = match.prediction;
  const st = p.standingStats;
  return {
    match_id: match.id,
    team_home: match.home.name,
    team_away: match.away.name,
    league: match.league.name,
    league_id: match.league.id,
    round: match.round,
    kickoff_iso: match.scheduledAt,
    season: seasonFromKickoff(match.scheduledAt),
    generated_at_iso: new Date().toISOString(),
    knowledge_cutoff_iso: REPORT_KNOWLEDGE_CUTOFF,
    probabilities_json: {
      home: p.homeProb,
      draw: p.drawProb,
      away: p.awayProb,
      btts: p.bttsProb,
      over25: p.over25Prob,
      over15: p.over15Prob ?? null,
      under35: p.under35Prob ?? null,
      doubleChance: p.doubleChance ?? null,
    },
    form_json: { home: match.home.form, away: match.away.form },
    standings_json: st
      ? {
          home: { ppg: st.home.ppg, rank: st.home.rank, played: st.home.played, goalDiff: st.home.goalDiff },
          away: { ppg: st.away.ppg, rank: st.away.rank, played: st.away.played, goalDiff: st.away.goalDiff },
        }
      : null,
    odds_json: match.odds ?? null,
    odds_devig_json: devig1x2(match.odds ?? null),
    xG: p.xGa ?? null,
    momentum: p.formMomentum ?? null,
  };
}

/**
 * Relit l'identité d'un payload construit par `buildReportPayload`.
 * Retourne `null` dès qu'un champ d'identité manque — un matchData sans
 * identité est refusé, jamais deviné (le cron skippe proprement).
 */
export function identityFromPayload(base: Record<string, unknown>): ReportIdentity | null {
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
  const matchId = str(base.match_id);
  const homeTeam = str(base.team_home);
  const awayTeam = str(base.team_away);
  const leagueId = str(base.league_id);
  const leagueName = str(base.league);
  const kickoffIso = str(base.kickoff_iso);
  if (!matchId || !homeTeam || !awayTeam || !leagueId || !leagueName || !kickoffIso) {
    return null;
  }
  return {
    matchId,
    homeTeam,
    awayTeam,
    leagueId,
    leagueName,
    round: typeof base.round === "string" ? base.round : null,
    kickoffIso,
  };
}
