import { describe, expect, it } from "bun:test";
import {
  buildFightVerdict,
  STRONG_WIN_THRESHOLD,
  type VerdictFight,
} from "@/lib/prediction/mma/verdict";

const base: VerdictFight = {
  fighter_a: "Alex Volkanovski",
  fighter_b: "Movsar Evloev",
};

describe("buildFightVerdict — gagnant prédit", () => {
  it("désigne le favori ps_prob côté A", () => {
    const v = buildFightVerdict({ ...base, ps_prob_a: 0.62, ps_prob_b: 0.38 });
    expect(v).not.toBeNull();
    expect(v!.winner).toBe("a");
    expect(v!.winnerName).toBe("Alex Volkanovski");
    expect(v!.prob).toBeCloseTo(0.62);
  });

  it("désigne le favori ps_prob côté B", () => {
    const v = buildFightVerdict({ ...base, ps_prob_a: 0.41, ps_prob_b: 0.59 });
    expect(v!.winner).toBe("b");
    expect(v!.winnerName).toBe("Movsar Evloev");
  });

  it("repli sur le marché dévigé si ps_prob absent", () => {
    const v = buildFightVerdict({ ...base, prob_a: 0.33, prob_b: 0.67 });
    expect(v!.winner).toBe("b");
    expect(v!.prob).toBeCloseTo(0.67);
  });

  it("null si aucune proba disponible", () => {
    expect(buildFightVerdict(base)).toBeNull();
    expect(buildFightVerdict({ ...base, ps_prob_a: 0.6 })).toBeNull();
  });

  it("ignore les NaN (pas de verdict inventé sur donnée corrompue)", () => {
    expect(buildFightVerdict({ ...base, ps_prob_a: NaN, ps_prob_b: NaN })).toBeNull();
  });
});

describe("buildFightVerdict — seuil fort 65 %", () => {
  it("isStrong faux juste sous le seuil", () => {
    const v = buildFightVerdict({ ...base, ps_prob_a: 0.64, ps_prob_b: 0.36 });
    expect(v!.isStrong).toBe(false);
  });

  it("isStrong vrai au seuil exact 65 %", () => {
    const v = buildFightVerdict({
      ...base,
      ps_prob_a: STRONG_WIN_THRESHOLD,
      ps_prob_b: 1 - STRONG_WIN_THRESHOLD,
    });
    expect(v!.isStrong).toBe(true);
  });

  it("isStrong vrai au-dessus du seuil", () => {
    const v = buildFightVerdict({ ...base, ps_prob_a: 0.72, ps_prob_b: 0.28 });
    expect(v!.isStrong).toBe(true);
  });
});

describe("buildFightVerdict — raisons", () => {
  it("liste les signaux alignés sur le favori", () => {
    const v = buildFightVerdict({
      ...base,
      ps_prob_a: 0.7,
      ps_prob_b: 0.3,
      prob_a: 0.66,
      prob_b: 0.34,
      dr_prob_a: 0.61,
      dr_prob_b: 0.39,
      model_prob_a: 0.75,
      model_prob_b: 0.25,
    });
    expect(v!.signalCount).toBe(3);
    expect(v!.signals.length).toBe(3);
    expect(v!.reasons.length).toBeGreaterThanOrEqual(3);
    expect(v!.reasons.some((r) => r.includes("DRatings"))).toBe(true);
  });

  it("ne liste pas un signal dissident comme raison", () => {
    const v = buildFightVerdict({
      ...base,
      ps_prob_a: 0.6,
      ps_prob_b: 0.4,
      dr_prob_a: 0.42, // DRatings préfère B
      dr_prob_b: 0.58,
    });
    expect(v!.signals.length).toBe(0);
    expect(v!.reasons.some((r) => r.includes("DRatings"))).toBe(false);
  });

  it("produit une raison radar seulement si delta >= 8", () => {
    const v = buildFightVerdict({
      ...base,
      ps_prob_a: 0.6,
      ps_prob_b: 0.4,
      stats_a: { striking: 80, takedowns: 50, ground: 40, damage: 70 },
      stats_b: { striking: 74, takedowns: 55, ground: 45, damage: 60 },
    });
    // striking +6 < 8 : pas de raison radar ; damage +10 : raison
    expect(v!.reasons.some((r) => r.includes("frappes"))).toBe(false);
    expect(v!.reasons.some((r) => r.includes("dégâts"))).toBe(true);
  });

  it("raison de repli quand aucun signal n'est disponible", () => {
    const v = buildFightVerdict({ ...base, ps_prob_a: 0.58, ps_prob_b: 0.42 });
    expect(v!.reasons.length).toBe(1);
    expect(v!.reasons[0]).toContain("Probabilité ensembliste");
  });
});
