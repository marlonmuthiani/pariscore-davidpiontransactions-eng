/**
 * Verdict MMA — qui va gagner et pourquoi.
 *
 * Logique pure (aucune dépendance React/UI), testée dans tests/mma-verdict.spec.ts.
 *
 * Gagnant prédit = côté le plus probable de l'ensemble PariScore (ps_prob,
 * blend devig 55 % + DRatings 30 % + modèle logistique 15 % — cf. mmaService).
 * Repli ordonné : ps_prob → proba marché dévigée (prob_a) → aucun verdict.
 *
 * Les RAISONS listent les signaux indépendants alignés sur le favori :
 *   - marché 1xBet dévigé (prob_a/prob_b)
 *   - DRatings.com (dr_prob_*)
 *   - modèle logistique maison (model_prob_*)
 *   - supériorité sur les axes radar EWMA (striking / takedowns / ground /
 *     damage), seuil delta >= 8 pts pour éviter le bruit
 */

/** Seuil au-delà duquel le verdict est « fort » (affichage dédié en UI). */
export const STRONG_WIN_THRESHOLD = 0.65;

/** Delta radar minimal (points 0-100) pour qu'un axe devienne une raison. */
export const RADAR_REASON_DELTA = 8;

export type VerdictSide = "a" | "b";

/** Sous-ensemble radar attendu (structurellement compatible avec MmaRadarData). */
export type VerdictRadarStats = {
  striking: number;
  takedowns: number;
  ground: number;
  damage: number;
};

export type VerdictFight = {
  fighter_a: string;
  fighter_b: string;
  /** Proba marché 1X2 dévigée [0..1]. */
  prob_a?: number | null;
  prob_b?: number | null;
  /** DRatings.com [0..1]. */
  dr_prob_a?: number | null;
  dr_prob_b?: number | null;
  /** Modèle logistique maison [0..1]. */
  model_prob_a?: number | null;
  model_prob_b?: number | null;
  /** Ensemble PariScore [0..1] — source principale du verdict. */
  ps_prob_a?: number | null;
  ps_prob_b?: number | null;
  stats_a?: VerdictRadarStats | null;
  stats_b?: VerdictRadarStats | null;
};

export type VerdictSignal = {
  /** Nom de la source affichable. */
  source: string;
  /** Proba du gagnant selon ce signal [0..1]. */
  prob: number;
  /** Proba de l'adversaire selon le même signal [0..1]. */
  probOpponent: number;
};

export type FightVerdict = {
  winner: VerdictSide;
  winnerName: string;
  loserName: string;
  /** Proba du gagnant selon la source de référence (ps_prob ou repli). */
  prob: number;
  /** Vrai si prob >= STRONG_WIN_THRESHOLD (0.65). */
  isStrong: boolean;
  /** Signaux dont l'arbitrage donne le gagnant comme favori. */
  signals: VerdictSignal[];
  /** Signaux consultés au total (alignés ou non). */
  signalCount: number;
  /** Raisons textuelles « pourquoi le favori va gagner ». */
  reasons: string[];
};

const AXES: { key: keyof VerdictRadarStats; label: string }[] = [
  { key: "striking", label: "frappes significatives" },
  { key: "takedowns", label: "takedowns" },
  { key: "ground", label: "contrôle au sol" },
  { key: "damage", label: "dégâts infligés" },
];

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/**
 * Construit le verdict d'un combat. Retourne null si aucune proba n'est
 * disponible (aucun signal → pas de verdict inventé).
 */
export function buildFightVerdict(fight: VerdictFight): FightVerdict | null {
  const { fighter_a: a, fighter_b: b } = fight;

  // Source de référence : ensemble PariScore, repli marché dévigé.
  const psA = finiteOrNull(fight.ps_prob_a);
  const psB = finiteOrNull(fight.ps_prob_b);
  const mktA = finiteOrNull(fight.prob_a);
  const mktB = finiteOrNull(fight.prob_b);

  let refA: number | null = null;
  let refB: number | null = null;
  if (psA != null && psB != null) {
    refA = psA;
    refB = psB;
  } else if (mktA != null && mktB != null) {
    refA = mktA;
    refB = mktB;
  }
  if (refA == null || refB == null) return null;

  const winner: VerdictSide = refA >= refB ? "a" : "b";
  const prob = winner === "a" ? refA : refB;
  const winnerName = winner === "a" ? a : b;
  const loserName = winner === "a" ? b : a;

  // Signaux indépendants : (source, proba A, proba B).
  const candidates: VerdictSignal[] = [];
  if (mktA != null && mktB != null) {
    candidates.push({ source: "Marché 1xBet (dévigé)", prob: mktA, probOpponent: mktB });
  }
  const drA = finiteOrNull(fight.dr_prob_a);
  const drB = finiteOrNull(fight.dr_prob_b);
  if (drA != null && drB != null) {
    candidates.push({ source: "Modèle DRatings", prob: drA, probOpponent: drB });
  }
  const mdA = finiteOrNull(fight.model_prob_a);
  const mdB = finiteOrNull(fight.model_prob_b);
  if (mdA != null && mdB != null) {
    candidates.push({ source: "Modèle PariScore (logistique)", prob: mdA, probOpponent: mdB });
  }

  const signals = candidates.filter((s) =>
    winner === "a" ? s.prob >= s.probOpponent : s.probOpponent >= s.prob
  );

  // Raisons : signaux alignés + axes radar dominés.
  const reasons: string[] = [];
  for (const s of candidates) {
    const pWin = winner === "a" ? s.prob : s.probOpponent;
    const pLose = winner === "a" ? s.probOpponent : s.prob;
    if (pWin >= pLose) {
      reasons.push(`${s.source} : ${pct(pWin)} pour ${winnerName} contre ${pct(pLose)}.`);
    }
  }

  const sa = fight.stats_a;
  const sb = fight.stats_b;
  if (sa && sb) {
    for (const axis of AXES) {
      const vWin = winner === "a" ? sa[axis.key] : sb[axis.key];
      const vLose = winner === "a" ? sb[axis.key] : sa[axis.key];
      if (typeof vWin === "number" && typeof vLose === "number" && vWin - vLose >= RADAR_REASON_DELTA) {
        reasons.push(
          `Supériorité ${axis.label} : ${Math.round(vWin)} contre ${Math.round(vLose)} ( EWMA).`
        );
      }
    }
  }

  if (reasons.length === 0) {
    reasons.push(
      `Probabilité ensembliste la plus élevée : ${winnerName} à ${pct(prob)} contre ${pct(1 - prob)}.`
    );
  }

  return {
    winner,
    winnerName,
    loserName,
    prob,
    isStrong: prob >= STRONG_WIN_THRESHOLD,
    signals,
    signalCount: candidates.length,
    reasons,
  };
}

function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
