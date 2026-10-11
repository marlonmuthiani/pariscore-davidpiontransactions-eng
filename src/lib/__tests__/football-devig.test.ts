import { describe, expect, test } from "bun:test";
import { devig1x2 } from "@/lib/football-devig";

describe("football-devig — dévig proportionnel 1X2", () => {
  test("retire la marge bookmaker", () => {
    // Implicites : 0.6667 + 0.25 + 0.1667 = 1.0833 → marge 8.33 %
    const p = devig1x2({ home: 1.5, draw: 4.0, away: 6.0 });
    expect(p).toEqual({ home: 61.54, draw: 23.08, away: 15.38 });
  });

  test("la somme vaut toujours exactement 100 (arrondi absorbé par le 3e tirage)", () => {
    const p = devig1x2({ home: 3.0, draw: 3.0, away: 3.0 })!;
    expect(p.home + p.draw + p.away).toBe(100);
  });

  test("un favori très cort sain reste borné", () => {
    const p = devig1x2({ home: 1.05, draw: 12.0, away: 25.0 })!;
    expect(p.home).toBeGreaterThan(80);
    expect(p.home + p.draw + p.away).toBe(100);
  });

  test("retourne null si une cote est absente — jamais de valeur inventée", () => {
    expect(devig1x2(null)).toBeNull();
    expect(devig1x2(undefined)).toBeNull();
    expect(devig1x2({ home: 1.9, draw: 3.5, away: Number.NaN })).toBeNull();
  });

  test("retourne null si une cote est hors bornes (<= 1)", () => {
    expect(devig1x2({ home: 1.0, draw: 3.5, away: 4.0 })).toBeNull();
    expect(devig1x2({ home: 0.5, draw: 3.5, away: 4.0 })).toBeNull();
    expect(devig1x2({ home: -2, draw: 3.5, away: 4.0 })).toBeNull();
  });
});
