// Tests — football-trends-service (logique pure, sans DB).
// Convention : import explicite depuis "bun:test" (les globals nus cassent le
// typecheck strict de next build sur le VPS — TS2593).

import { describe, expect, test } from "bun:test";
import { computeEdge } from "../football-trends-service";

describe("computeEdge — formule OddAlerts (hit rate − probabilité implicite)", () => {
  test("OddAlerts reference : 91 % vs cote 1.25 → +11", () => {
    // 1.25 → 80 % implicite ; 91 − 80 = 11 (exemple réel observé sur /trends).
    expect(computeEdge(91, 1.25)).toBe(11);
  });

  test("Draws : 50 % vs cote 3.65 → +23", () => {
    // 3.65 → ~27 % implicite ; 50 − 27 = 23 (round(100/3.65) = 27).
    expect(computeEdge(50, 3.65)).toBe(23);
  });

  test("Edge nul quand le marché cote exactement le hit rate", () => {
    // 2.0 → 50 % implicite ; 50 − 50 = 0 : pas de valeur.
    expect(computeEdge(50, 2.0)).toBe(0);
  });

  test("Edge négatif conservé (cote trop courte vs hit rate)", () => {
    // 1.16 → 86 % implicite ; 70 − 86 = −16 : signal « pas de valeur ».
    expect(computeEdge(70, 1.16)).toBe(-16);
  });

  test("Cote absente ou aberrante (≤ 1) → null, jamais de faux edge", () => {
    expect(computeEdge(83, null)).toBeNull();
    expect(computeEdge(83, 1)).toBeNull();
    expect(computeEdge(83, 0.5)).toBeNull();
  });
});
