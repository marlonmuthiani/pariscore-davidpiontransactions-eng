// Tests du calcul pur du goal-timing-service (bun:test, convention src/lib/__tests__).
// L'orchestration BSD n'est PAS testée ici : réseau + caches, couverte par la QA visuelle.

import { describe, test, expect } from "bun:test";
import {
  computeTeamGoalTiming,
  computeFirstToScore,
  type TeamMatchGoalTimeline,
} from "../stats/goal-timing-service";

const m = (
  context: "home" | "away",
  goalsFor: number[],
  goalsAgainst: number[],
): TeamMatchGoalTimeline => ({ context, goalsFor, goalsAgainst });

describe("computeTeamGoalTiming", () => {
  test("profil nominal : moyennes, fenêtres, premier à marquer", () => {
    const stats = computeTeamGoalTiming([
      m("home", [12, 80], [45]),   // but 12' (0-15) + 45' (35-45) + 80' (>70) ; marque 1er
      m("away", [50], [8, 72]),    // encaisse 1er ; 8' (0-15), 72' (>70)
      m("home", [90], []),         // marque 1er ; >70
      m("away", [], []),           // 0-0 : compte au dénominateur, pas dans les moyennes
    ]);
    expect(stats.matches).toBe(4);
    expect(stats.matchesWithGoals).toBe(3);
    // 1er but du match : 12, 8, 90 → 110/3
    expect(stats.avgFirstGoalMatch).toBeCloseTo(110 / 3, 5);
    // 1er but marqué : 12, 50, 90 → 152/3
    expect(stats.avgFirstGoalScored).toBeCloseTo(152 / 3, 5);
    // 1er but encaissé : 45, 8 → 26.5
    expect(stats.avgFirstGoalConceded).toBeCloseTo(26.5, 5);
    // fenêtres sur 4 matchs : 0-15 = matchs 1 et 2 ; 35-45 = match 1 ; >70 = matchs 1, 2, 3
    expect(stats.pctGoal0to15).toBe(50);
    expect(stats.pctGoal35to45).toBe(25);
    expect(stats.pctGoalAfter70).toBe(75);
    // marque 1er : matchs 1 et 3 sur 3 avec but → 67% ; encaisse 1er : match 2 → 33%
    expect(stats.scoresFirstPct).toBe(67);
    expect(stats.concedesFirstPct).toBe(33);
  });

  test("échantillon vide → tout null, jamais de NaN", () => {
    const stats = computeTeamGoalTiming([]);
    expect(stats.matches).toBe(0);
    expect(stats.avgFirstGoalMatch).toBeNull();
    expect(stats.avgFirstGoalScored).toBeNull();
    expect(stats.avgFirstGoalConceded).toBeNull();
    expect(stats.pctGoal0to15).toBeNull();
    expect(stats.scoresFirstPct).toBeNull();
    expect(stats.concedesFirstPct).toBeNull();
  });

  test("matchs 0-0 uniquement : % à 0, moyennes null, premier à marquer null", () => {
    const stats = computeTeamGoalTiming([m("home", [], []), m("away", [], [])]);
    expect(stats.matches).toBe(2);
    expect(stats.pctGoal0to15).toBe(0);
    expect(stats.avgFirstGoalMatch).toBeNull();
    expect(stats.scoresFirstPct).toBeNull();
  });

  test("minutes égales au premier but : personne ne marque « premier »", () => {
    const stats = computeTeamGoalTiming([m("home", [30], [30])]);
    expect(stats.scoresFirstPct).toBe(0);
    expect(stats.concedesFirstPct).toBe(0);
  });

  test("bornes de fenêtres incluses : 15' compte en 0-15, 70' PAS après 70", () => {
    const stats = computeTeamGoalTiming([m("home", [15], [70])]);
    expect(stats.pctGoal0to15).toBe(100);
    expect(stats.pctGoalAfter70).toBe(0);
  });
});

describe("computeFirstToScore", () => {
  test("croisement attaque précoce A × vulnérabilité précoce B", () => {
    const strong = computeTeamGoalTiming([
      m("home", [10], []),
      m("away", [15], []),
      m("home", [20], [60]),
    ]);
    // scoresFirst 100, concedesFirst 0
    const weak = computeTeamGoalTiming([
      m("home", [60], [5]),
      m("away", [80], [12]),
    ]);
    // scoresFirst 0, concedesFirst 100
    const r = computeFirstToScore(strong, weak);
    expect(r).not.toBeNull();
    expect(r!.home).toBe(100);
    expect(r!.away).toBe(0);
    expect(r!.home + r!.away).toBe(100);
  });

  test("profils symétriques → 50/50", () => {
    const p = computeTeamGoalTiming([m("home", [10], [20]), m("away", [30], [5])]);
    const q = computeTeamGoalTiming([m("home", [10], [20]), m("away", [30], [5])]);
    expect(p.scoresFirstPct).toBe(50);
    expect(p.concedesFirstPct).toBe(50);
    const r = computeFirstToScore(p, q);
    expect(r).not.toBeNull();
    expect(r!.home).toBe(50);
    expect(r!.away).toBe(50);
  });

  test("données manquantes (null) ou les deux poids nuls → null", () => {
    const empty = computeTeamGoalTiming([]);
    const zeros = computeTeamGoalTiming([m("home", [30], [30])]);
    expect(computeFirstToScore(empty, empty)).toBeNull();
    expect(computeFirstToScore(zeros, zeros)).toBeNull();
  });
});
