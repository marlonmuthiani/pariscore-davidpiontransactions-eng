/**
 * corners-backtest.ts — ROI / P&L réels sur les marchés de corners, à partir de la
 * jointure cotes BetMines x issues réelles.
 *
 * ## Ce qui le distingue du backtest par marchés classique
 *
 * `runMarketBacktest` rejoue les picks du journal Top 5. Les marchés corners
 * étaient bloqués, donc le journal n'a produit AUCUN pick dessus : les router
 * dans ce moteur afficherait 0 pari, quel que soit l'échantillon disponible.
 *
 * Ici le pari est construit directement depuis la jointure : on dérive λ des
 * cotes BetMines (dé-vig + inversion de Poisson, même logique que
 * `betminesCornerMarket`), on en déduit les lignes 6.5 et 11.5 absentes du
 * marché BetMines, puis on règle contre le total de corners réellement joué.
 *
 * ## Honnêteté de l'échantillon
 *
 * L'UI affiche la taille ET la fenêtre couverte. Au 2026-10-10 : 158 matchs
 * joints, tous issus d'un unique mois d'août 2026 (le scraper BetMines n'a
 * tourné qu'une fois, le 2026-08-22). Un ROI sur 158 paris d'une seule semaine
 * n'est pas une mesure exploitable — d'où l'affichage explicite plutôt qu'un
 * pourcentage nu. Le seuil sert à interdire l'affichage sur un échantillon
 * trop petit, PAS à garantir qu'un échantillon suffisant est représentatif.
 */

import { joinCornerOutcomes, normalizeTeamName, type BetminesFixtureInput } from "./corner-outcomes-join";
import type { MarketKey } from "@/lib/football-backtest/markets";

/**
 * Nombre de matchs joints minimum pour afficher un ROI.
 *
 * 100 = enough pour que le taux de réussite ne soit pas un simple bruit de
 * quelques paris. En dessous, le marché reste bloqué et l'UI affiche
 * « X/100 » plutot qu'un pourcentage trompeur.
 */
export const MIN_SAMPLE_JOINED = 100;

/** Mise plate : 1 unité par pari, comme le reste du backtest. */
const STAKE = 1;

export type CornersMarketKey = Extract<MarketKey, "over65Corners" | "under115Corners">;

export type CornersMarketBacktest = {
  key: CornersMarketKey;
  label: string;
  /** Ligne du marché (6.5 ou 11.5 corners). */
  line: number;
  availability: "available" | "blocked";
  /** true quand la cote Over ET Under a pu être dérivée sur ce match. */
  available: boolean;
  n: number;
  wins: number;
  losses: number;
  pnl: number;
  roiPct: number | null;
  maxDrawdown: number;
  curve: number[];
  sampleOk: boolean;
  blockedReason: string | null;
  /** Provenance de l'échantillon — l'UI l'affiche, un pourcentage seul trompe. */
  sample: { joined: number; withPairedOdds: number; from: string | null; to: string | null };
};

/** Dé-vig une paire de cotes décimales → probabilité juste P(Over). */
function fairPair(over: unknown, under: unknown): number | null {
  const o = Number(over);
  const u = Number(under);
  if (!Number.isFinite(o) || !Number.isFinite(u) || o <= 1 || u <= 1) return null;
  const io = 1 / o;
  const iu = 1 / u;
  const vig = io + iu;
  if (vig <= 0) return null;
  return io / vig;
}

/** P(X >= k) pour X ~ Poisson(λ). */
function poissonTail(lambda: number, k: number): number {
  let cdf = 0;
  let pmf = Math.exp(-lambda);
  for (let i = 0; i < k; i++) {
    cdf += pmf;
    pmf *= lambda / (i + 1);
  }
  return Math.min(1, Math.max(0, 1 - cdf));
}

/** Inverse P(X >= k) = p pour retrouver λ (dichotomie, tail croissant en λ). */
function invertLambda(p: number, k: number): number | null {
  if (!(p > 0 && p < 1)) return null;
  let lo = 1;
  let hi = 30;
  for (let i = 0; i < 45; i++) {
    const mid = (lo + hi) / 2;
    if (poissonTail(mid, k) > p) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * λ (corners attendus) déduit des cotes BetMines, ou null si aucune paire O/U
 * exploitable. Même agrégation que betminesCornerMarket : λ par ligne, puis
 * médiane (robuste à une ligne aberrante).
 */
export function lambdaFromOdds(odds: {
  over75?: number;
  under75?: number;
  over85?: number;
  under85?: number;
  over95?: number;
  under95?: number;
  over105?: number;
  under105?: number;
}): number | null {
  const lines: [number, number | undefined, number | undefined][] = [
    [8, odds.over75, odds.under75],
    [9, odds.over85, odds.under85],
    [10, odds.over95, odds.under95],
    [11, odds.over105, odds.under105],
  ];
  const lambdas: number[] = [];
  for (const [k, over, under] of lines) {
    const p = fairPair(over, under);
    if (p == null) continue;
    const l = invertLambda(p, k);
    if (l != null) lambdas.push(l);
  }
  if (!lambdas.length) return null;
  lambdas.sort((a, b) => a - b);
  return lambdas.length % 2 === 1
    ? lambdas[(lambdas.length - 1) / 2]
    : (lambdas[lambdas.length / 2 - 1] + lambdas[lambdas.length / 2]) / 2;
}

/**
 * Cote équitable déduite de λ pour une ligne et un sens donnés.
 *
 * Invariant à faire respecter partout : **1 / cote = probabilité de gain**.
 * `poissonTail` ne calcule que P(X > line), donc le Under exige le complément.
 * Mélanger les deux fait parier le Under au prix du Over — bug qui a produit un
 * ROI de +175 % sur l'Under 11,5 avant correction (2026-10-10).
 */
export function fairOddsForLine(lambda: number, line: number, side: "over" | "under"): number {
  const pOver = poissonTail(lambda, Math.floor(line) + 1);
  return 1 / (side === "over" ? pOver : 1 - pOver);
}

const LINES: { key: CornersMarketKey; label: string; line: number }[] = [
  { key: "over65Corners", label: "Over 6,5 corners", line: 6.5 },
  { key: "under115Corners", label: "Under 11,5 corners", line: 11.5 },
];

const round2 = (n: number): number => Math.round(n * 100) / 100;

function settle(
  outcomes: ReturnType<typeof joinCornerOutcomes>,
): Record<CornersMarketKey, CornersMarketBacktest> {
  const { outcomes: rows, stats } = outcomes;

  const dates = rows.map((r) => r.kickoff).sort();
  const sample = {
    joined: stats.matchedWithCorners,
    withPairedOdds: stats.pairedOdds,
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
  };

  const out = {} as Record<CornersMarketKey, CornersMarketBacktest>;
  for (const def of LINES) {
    // Mise systématique : on parie la ligne à chaque match où la cote a pu être
    // dérivée. Le ROI mesure donc la valeur de la cote BetMines sur CETTE ligne,
    // pas le rendement d'une stratégie de sélection.
    const bets: { kickoff: string; won: boolean; pnl: number }[] = [];
    for (const r of rows) {
      const lambda = lambdaFromOdds(r.betminesOdds);
      if (lambda == null) continue;
      // `tail` calcule P(X > line) — c'est-à-dire la probabilité du OVER.
      // Pour un marché Under il faut le complément : prendre 1/tail ici
      // parierait le Under au prix du Over. Constaté le 2026-10-10 : cote
      // Under 11,5 dérivée à 3,57 (au lieu de 1,39) et ROI fantaisiste +175 %.
      const pOver = poissonTail(lambda, Math.floor(def.line) + 1);
      const p = def.key === "over65Corners" ? pOver : 1 - pOver;
      const odd = 1 / p;
      if (!Number.isFinite(odd) || odd <= 1) continue;
      // Over gagne si total > line ; Under gagne si total <= line.
      const won = def.key === "over65Corners" ? r.actualCorners! > def.line : r.actualCorners! <= def.line;
      bets.push({ kickoff: r.kickoff, won, pnl: won ? round2(odd - 1) : -STAKE });
    }
    bets.sort((a, b) => a.kickoff.localeCompare(b.kickoff));

    const wins = bets.filter((b) => b.won).length;
    const pnl = round2(bets.reduce((a, b) => a + b.pnl, 0));
    const curve: number[] = [];
    let cum = 0;
    let peak = 0;
    let dd = 0;
    for (const b of bets) {
      cum = round2(cum + b.pnl);
      curve.push(cum);
      peak = Math.max(peak, cum);
      dd = Math.max(dd, round2(peak - cum));
    }
    const sampleOk = bets.length >= MIN_SAMPLE_JOINED;

    out[def.key] = {
      key: def.key,
      label: def.label,
      line: def.line,
      availability: sampleOk ? "available" : "blocked",
      available: sampleOk,
      n: bets.length,
      wins,
      losses: bets.length - wins,
      pnl,
      roiPct: bets.length > 0 ? round2((pnl / (bets.length * STAKE)) * 100) : null,
      maxDrawdown: dd,
      curve,
      sampleOk,
      blockedReason: sampleOk
        ? null
        : `En cours d'accumulation : ${bets.length}/${MIN_SAMPLE_JOINED} matchs jointes. ` +
          `Les fixtures BetMines disponibles ne couvrent qu'une courte période — ` +
          `l'archive quotidienne s'étoffe avec le temps.`,
      sample,
    };
  }
  return out;
}

/**
 * Backtest corners complet.
 *
 * @param fixturesByLeague fixtures BetMines déjà chargées (par leagueId).
 */
export function runCornersBacktest(fixturesByLeague: Map<number, BetminesFixtureInput[]>) {
  const outcomes = joinCornerOutcomes(fixturesByLeague);
  return { markets: settle(outcomes), stats: outcomes.stats };
}

export { normalizeTeamName };
