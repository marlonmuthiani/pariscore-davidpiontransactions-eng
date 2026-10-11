/**
 * Dévigging proportionnel (multiplicatif) des cotes 1X2 en probabilités
 * justes, marge bookmaker retirée.
 *
 * Pourquoi : le prompt d'analyse interdit de commenter une cote brute — elle
 * intègre la marge du bookmaker et fausse toute lecture de valeur. Le payload
 * injecte donc `devigProbs` à côté des cotes brutes.
 *
 * ponytail: dévig proportionnel uniquement ; passer en Shin / Power pour les
 * cotes extrêmes (< 1.50 ou > 6.0) si un biais résiduel est mesuré en backtest.
 */

export type Odds1x2 = {
  /** Cote décimale 1 (victoire domicile). */
  home: number;
  /** Cote décimale N (nul). */
  draw: number;
  /** Cote décimale 2 (victoire extérieur). */
  away: number;
};

export type Probs1x2 = {
  home: number;
  draw: number;
  away: number;
};

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Une cote décimale exploitable doit être strictement supérieure à 1. */
function validOdd(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 1;
}

/**
 * Convertit trois cotes 1X2 en probabilités dévigées (somme = 100).
 * Retourne `null` si une cote est absente ou hors bornes — jamais de valeur
 * inventée.
 */
export function devig1x2(odds: Odds1x2 | null | undefined): Probs1x2 | null {
  if (!odds) return null;
  const { home, draw, away } = odds;
  if (!validOdd(home) || !validOdd(draw) || !validOdd(away)) return null;

  const implied = [1 / home, 1 / draw, 1 / away];
  const sum = implied[0] + implied[1] + implied[2];
  if (!(sum > 0)) return null;

  const homeP = r2((implied[0] / sum) * 100);
  const drawP = r2((implied[1] / sum) * 100);
  // Le reste est affecté au 3e tirage pour garantir une somme exacte de 100.
  const awayP = r2(100 - homeP - drawP);
  return { home: homeP, draw: drawP, away: awayP };
}
