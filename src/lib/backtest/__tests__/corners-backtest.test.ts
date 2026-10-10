import { describe, expect, test } from "bun:test";
import {
  MIN_SAMPLE_JOINED,
  fairOddsForLine,
  lambdaFromOdds,
  runCornersBacktest,
} from "../corners-backtest";
import type { BetminesFixtureInput } from "../corner-outcomes-join";

function fx(
  id: number,
  day: string,
  home: string,
  away: string,
  over: string,
  under: string,
): BetminesFixtureInput {
  return {
    id,
    dateTime: `${day}T18:00:00Z`,
    home: { name: home },
    away: { name: away },
    odds: { cornerOver75: over, cornerUnder75: under, cornerOver95: "1.40", cornerUnder95: "2.60" },
  };
}

describe("lambdaFromOdds", () => {
  test("déduit un lambda plausible a partir d'une paire O/U equilibrée", () => {
    // P(Over 7.5) ~ 0.50 -> lambda ~ 8.0
    const l = lambdaFromOdds({ over75: 2.0, under75: 2.0 });
    expect(l).not.toBeNull();
    expect(l!).toBeGreaterThan(6);
    expect(l!).toBeLessThan(10);
  });

  test("cote Over basse -> lambda plus elevee", () => {
    const bas = lambdaFromOdds({ over75: 1.3, under75: 4.0 })!;
    const haut = lambdaFromOdds({ over75: 3.0, under75: 1.4 })!;
    expect(bas).toBeGreaterThan(haut);
  });

  test("retourne null sans paire utilisable", () => {
    expect(lambdaFromOdds({})).toBeNull();
    expect(lambdaFromOdds({ over75: 2 })).toBeNull();
    expect(lambdaFromOdds({ over75: 1, under75: 1 })).toBeNull();
    expect(lambdaFromOdds({ over75: Number.NaN, under75: 2 })).toBeNull();
  });
});

describe("fairOddsForLine — invariant 1/cote = probabilite de gain", () => {
  // Regression : le calcul prenait P(X > line) pour LES DEUX sens, donc le
  // Under etait parie au prix du Over. Constat le 2026-10-10 : Under 11,5
  // derive a 3,57 au lieu de 1,39, et un ROI fantaisiste de +175 %.
  test("Over et Under sur la MEME ligne donnent des cotes complementaires", () => {
    for (const line of [6.5, 11.5]) {
      const o = fairOddsForLine(9.8, line, "over");
      const u = fairOddsForLine(9.8, line, "under");
      // 1/o et 1/u sont des probabilites : leur somme vaut exactement 1.
      expect(1 / o + 1 / u).toBeCloseTo(1, 10);
    }
  });

  test("la cote Under n'est PAS celle du Over", () => {
    // lambda 9.8, ligne 11.5 -> P(X>=12) ~ 0.28 : Over ~ 3.5, Under ~ 1.39.
    const under = fairOddsForLine(9.8, 11.5, "under");
    const over = fairOddsForLine(9.8, 11.5, "over");
    expect(under).toBeLessThan(2);
    expect(under).toBeLessThan(over);
  });

  test("les deux cotes sont strictement > 1 (aucun pari sans valeur)", () => {
    for (const line of [6.5, 11.5]) {
      for (const side of ["over", "under"] as const) {
        const o = fairOddsForLine(9.8, line, side);
        expect(o).toBeGreaterThan(1);
        expect(Number.isFinite(o)).toBe(true);
      }
    }
  });

  test("lambda elevee favorise l'Over, lambda basse favorise l'Under", () => {
    // lambda 20 sur une ligne 11.5 : beaucoup de corners attendus, le Over est
    // quasi certain (cote ~1.02) et le Under improbable (cote elevee).
    expect(fairOddsForLine(20, 11.5, "over")).toBeLessThan(1.05);
    expect(fairOddsForLine(20, 11.5, "under")).toBeGreaterThan(5);
    // Symetrique : lambda 2 sur 6.5, tres peu de corners, l'Under est quasi certain.
    expect(fairOddsForLine(2, 6.5, "under")).toBeLessThan(1.05);
    expect(fairOddsForLine(2, 6.5, "over")).toBeGreaterThan(5);
  });
});

describe("runCornersBacktest", () => {
  test("bloque sous le seuil et affiche X/100", () => {
    const fixtures: BetminesFixtureInput[] = [];
    for (let i = 0; i < 10; i++) {
      fixtures.push(fx(i, "2026-08-2" + (i % 3), `Club A${i}`, `Club B${i}`, "2.00", "2.00"));
    }
    const { markets } = runCornersBacktest(new Map([[384, fixtures]]));
    const over = markets.over65Corners;
    // Aucune issue en base locale -> 0 pari -> bloque.
    expect(over.availability).toBe("blocked");
    expect(over.n).toBe(0);
    expect(over.roiPct).toBeNull();
  });

  test("le seuil vaut bien 100", () => {
    expect(MIN_SAMPLE_JOINED).toBe(100);
  });

  test("expose la provenance de l'echantillon", () => {
    const { markets } = runCornersBacktest(new Map());
    const over = markets.over65Corners;
    expect(over.sample).toBeDefined();
    expect(over.sample.joined).toBe(0);
    expect(over.sample.from).toBeNull();
  });

  test("les deux marches corners sont toujours presents", () => {
    const { markets } = runCornersBacktest(new Map());
    expect(markets.over65Corners.key).toBe("over65Corners");
    expect(markets.over65Corners.line).toBe(6.5);
    expect(markets.under115Corners.key).toBe("under115Corners");
    expect(markets.under115Corners.line).toBe(11.5);
  });

  test("wins + losses = n, et la courbe a n points", () => {
    const { markets } = runCornersBacktest(new Map());
    for (const m of [markets.over65Corners, markets.under115Corners]) {
      expect(m.wins + m.losses).toBe(m.n);
      expect(m.curve.length).toBe(m.n);
      expect(m.maxDrawdown).toBeGreaterThanOrEqual(0);
    }
  });
});