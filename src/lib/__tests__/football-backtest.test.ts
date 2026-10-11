import { describe, expect, test } from "bun:test";
import type { FootballMatch } from "@/lib/football-data";
import { countFinishedMatches, runBacktest } from "@/lib/football-backtest";

/** Fixture minimale : seuls les champs consommés par runBacktest sont remplis. */
function mkMatch(over: {
  id: string;
  homeProb: number;
  drawProb: number;
  awayProb: number;
  odds?: { home: number; draw: number; away: number } | null;
  status?: string;
  hs?: number;
  as?: number;
  scheduledAt?: string;
  league?: string;
}): FootballMatch {
  return {
    id: over.id,
    league: { name: over.league ?? "Ligue Test" },
    scheduledAt: over.scheduledAt ?? "2026-09-28T20:00:00Z",
    prediction: {
      homeProb: over.homeProb,
      drawProb: over.drawProb,
      awayProb: over.awayProb,
    },
    odds: over.odds === undefined ? { home: 2, draw: 3.4, away: 3.8 } : over.odds,
    live:
      over.status === undefined || over.status === "FT"
        ? {
            status: "FT",
            homeScore: over.hs ?? 1,
            awayScore: over.as ?? 0,
            minute: 90,
            period: "FT",
            homePossession: 50,
            homeShots: 0,
            awayShots: 0,
            homeShotsOnTarget: 0,
            awayShotsOnTarget: 0,
            homeCorners: 0,
            awayCorners: 0,
            homeAttacks: 0,
            awayAttacks: 0,
            homeDangerousAttacks: 0,
            awayDangerousAttacks: 0,
            homeFouls: 0,
            awayFouls: 0,
            homeYellowCards: 0,
            awayYellowCards: 0,
            homeRedCards: 0,
            awayRedCards: 0,
            homeXg: 0,
            awayXg: 0,
          }
        : null,
  } as unknown as FootballMatch;
}

describe("runBacktest — règlement et mise", () => {
  // prediction.* est en POURCENTAGES (0-100) — stakeFraction divise par 100.
  test("favori 1X2 gagné : P&L = stake × (odds-1), ROI cohérent", () => {
    const matches = [
      // favori domicile (prob max = 60 %), cote 2.0, gagné 2-0
      mkMatch({ id: "1", homeProb: 60, drawProb: 25, awayProb: 15, hs: 2, as: 0 }),
    ];
    const r = runBacktest(matches, "flat1");
    expect(r.totalBets).toBe(1);
    expect(r.wins).toBe(1);
    expect(r.winRate).toBe(100);
    // flat1 = 1% de la bankroll de départ (100) → mise 1u, gain 1u
    expect(r.bets[0].stake).toBeCloseTo(1, 5);
    expect(r.unitsProfit).toBeCloseTo(1, 5);
    expect(r.roi).toBeCloseTo(100, 5);
    expect(r.pnlCurve).toEqual([1]);
  });

  test("favori perdu : P&L = -stake", () => {
    const matches = [
      mkMatch({ id: "1", homeProb: 60, drawProb: 25, awayProb: 15, hs: 0, as: 2 }),
    ];
    const r = runBacktest(matches, "flat1");
    expect(r.wins).toBe(0);
    expect(r.unitsProfit).toBeCloseTo(-1, 5);
    expect(r.longestLosingStreak).toBe(1);
    expect(r.maxDrawdown).toBeCloseTo(1, 5);
  });

  test("match nul : le pick X l'emporte, sinon perd", () => {
    const drawMatch = mkMatch({
      id: "1",
      homeProb: 30,
      drawProb: 45,
      awayProb: 25,
      hs: 1,
      as: 1,
    });
    expect(runBacktest([drawMatch], "flat1").wins).toBe(1);
    // même pick X mais match non nul → perdu
    const notDraw = mkMatch({
      id: "2",
      homeProb: 30,
      drawProb: 45,
      awayProb: 25,
      hs: 2,
      as: 1,
    });
    expect(runBacktest([notDraw], "flat1").wins).toBe(0);
  });

  test("exclusions : sans FT, sans cote ou cote ≤ 1 → pas de pari", () => {
    const matches = [
      mkMatch({ id: "1", homeProb: 60, drawProb: 25, awayProb: 15, status: "LIVE" }),
      mkMatch({ id: "2", homeProb: 60, drawProb: 25, awayProb: 15, odds: null }),
      mkMatch({
        id: "3",
        homeProb: 60,
        drawProb: 25,
        awayProb: 15,
        odds: { home: 1, draw: 3, away: 4 },
      }),
    ];
    const r = runBacktest(matches, "flat1");
    expect(r.totalBets).toBe(0);
    expect(r.roi).toBe(0);
    expect(r.pnlCurve).toEqual([]);
    expect(countFinishedMatches(matches)).toBe(2); // celui en LIVE n'est pas FT
  });

  test("fenêtre windowDays : les matchs trop vieux sont ignorés", () => {
    const recent = mkMatch({
      id: "1",
      homeProb: 60,
      drawProb: 25,
      awayProb: 15,
      scheduledAt: new Date().toISOString(),
    });
    const old = mkMatch({
      id: "2",
      homeProb: 60,
      drawProb: 25,
      awayProb: 15,
      scheduledAt: "2020-01-01T00:00:00Z",
    });
    expect(runBacktest([recent, old], "flat1", 30).totalBets).toBe(1);
    expect(runBacktest([recent, old], "flat1", 0).totalBets).toBe(2);
  });

  test("séries : longestLosingStreak suit les défaites consécutives", () => {
    const mk = (id: string, hs: number, as: number) =>
      mkMatch({ id, homeProb: 60, drawProb: 25, awayProb: 15, hs, as });
    // V, N, N, V, N → pire série = 2
    const r = runBacktest(
      [mk("1", 1, 0), mk("2", 0, 1), mk("3", 0, 1), mk("4", 1, 0), mk("5", 0, 1)],
      "flat1",
    );
    expect(r.totalBets).toBe(5);
    expect(r.wins).toBe(2);
    expect(r.longestLosingStreak).toBe(2);
    expect(r.pnlCurve.length).toBe(5);
  });

  test("kelly : fraction = (p·o−1)/(o−1) plafonnée à 0.1, half-Kelly divisé par 2", () => {
    const matches = [
      // p = 0.60, odds 2.0 → f = 0.2 → cap 0.1 → mise 10 ; half → 5
      mkMatch({ id: "1", homeProb: 60, drawProb: 25, awayProb: 15, hs: 1, as: 0 }),
    ];
    const full = runBacktest(matches, "kelly");
    expect(full.bets[0].stake).toBeCloseTo(10, 5);
    const half = runBacktest(matches, "halfKelly");
    expect(half.bets[0].stake).toBeCloseTo(5, 5);
  });

  test("kelly : EV négatif → fraction 0 → pari sauté", () => {
    const matches = [
      // p = 0.40, odds 2.0 → f = (0.8-1)/1 = -0.2 → max(0, …) = 0
      mkMatch({ id: "1", homeProb: 40, drawProb: 35, awayProb: 25, hs: 1, as: 0 }),
    ];
    expect(runBacktest(matches, "kelly").totalBets).toBe(0);
    // flat1 parie quand même (fraction fixe)
    expect(runBacktest(matches, "flat1").totalBets).toBe(1);
  });

  test("drawdown : creux max depuis le pic de bankroll (mises composées)", () => {
    const mk = (id: string, hs: number, as: number) =>
      mkMatch({ id, homeProb: 60, drawProb: 25, awayProb: 15, hs, as });
    // flat2 = 2% de la bankroll courante : mises 2 / 2.04 / 1.9992.
    // V (+2) puis N (−2.04) puis N (−1.9992) → pic 102, creux 97.9608.
    const r = runBacktest([mk("1", 1, 0), mk("2", 0, 1), mk("3", 0, 1)], "flat2");
    expect(r.unitsProfit).toBeCloseTo(-2.0392, 3);
    expect(r.maxDrawdown).toBeCloseTo(4.0392, 3);
    expect(r.pnlCurve.map((v) => Math.round(v * 10000) / 10000)).toEqual([2, -0.04, -2.0392]);
  });
});
