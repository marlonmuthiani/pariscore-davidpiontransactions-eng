import { describe, expect, test } from "bun:test";
import type { BSDFootballMatch } from "@/lib/bsd-football-fetcher";
import type {
  StrategyMatchEntry,
  StrategyTop5,
  StrategyTop5Key,
} from "@/lib/football-strategy-top5";
import { buildEntries, pickDesc } from "@/lib/top5-backtest/football";

function mkStrategyEntry(over: Partial<StrategyMatchEntry> = {}): StrategyMatchEntry {
  return {
    matchId: "777",
    league: "Ligue Test",
    leagueId: -1,
    leagueCountry: null,
    leagueLogo: null,
    kickoff: "2026-09-28T20:00:00Z",
    home: { teamId: "id:1", teamName: "Alpha FC", shortName: "ALP", logo: "" },
    away: { teamId: "id:2", teamName: "Beta FC", shortName: "BET", logo: "" },
    value: 72,
    pick: null,
    ...over,
  };
}

function emptyTop5(): StrategyTop5 {
  const strategies = {} as Record<StrategyTop5Key, StrategyMatchEntry[]>;
  for (const k of [
    "bestTeam",
    "bestTeam1x2",
    "gagnant",
    "bestAttack",
    "bestDefense",
    "doubleChance1X",
    "doubleChance2X",
    "doubleChance12",
    "over15",
    "under35",
    "bttsYes",
    "over65Corners",
    "dnb",
  ] as StrategyTop5Key[]) {
    strategies[k] = [];
  }
  return { window: 5, minPlayed: 2, strategies, drawModal: [] };
}

function mkRealMatch(over: Partial<BSDFootballMatch> = {}): BSDFootballMatch {
  return {
    id: 777,
    league: { id: -1, name: "Ligue Test" },
    home_team: "Alpha FC",
    away_team: "Beta FC",
    event_date: "2026-09-28T20:00:00Z",
    status: "finished",
    home_score: 2,
    away_score: 1,
    odds_home: 1.5,
    odds_draw: 4.2,
    odds_away: 6.5,
    odds_over_15: 1.28,
    ...over,
  } as unknown as BSDFootballMatch;
}

describe("pickDesc — 13 stratégies", () => {
  const e = mkStrategyEntry({ pick: "home" });

  test("côtés nommés (bestTeam/bestTeam1x2/gagnant/bestDefense/dnb)", () => {
    expect(pickDesc("bestTeam", e)).toBe("Alpha FC");
    expect(pickDesc("bestTeam1x2", e)).toBe("Alpha FC");
    expect(pickDesc("gagnant", e)).toBe("Alpha FC");
    expect(pickDesc("bestDefense", e)).toBe("Alpha FC ≤1 enc");
    expect(pickDesc("dnb", e)).toBe("DNB Alpha FC");
    expect(pickDesc("bestTeam", mkStrategyEntry({ pick: "away" }))).toBe("Beta FC");
    // pick null : comportement existant — le ternaire bascule côté away (jamais
    // produit en pratique, les stratégies côtées pickent toujours home|away).
    expect(pickDesc("bestTeam", mkStrategyEntry({ pick: null }))).toBe("Beta FC");
  });

  test("marchés : libellés fixes", () => {
    expect(pickDesc("doubleChance1X", e)).toBe("DC 1X Alpha FC");
    expect(pickDesc("doubleChance2X", e)).toBe("DC 2X Beta FC");
    expect(pickDesc("doubleChance12", e)).toBe("DC 12 (pas de nul)");
    expect(pickDesc("bestAttack", e)).toBe("Over 2,5 buts");
    expect(pickDesc("over15", e)).toBe("Over 1,5");
    expect(pickDesc("under35", e)).toBe("Under 3,5");
    expect(pickDesc("bttsYes", e)).toBe("BTTS oui");
    expect(pickDesc("over65Corners", e)).toBe("Over 6,5 corners");
  });
});

describe("buildEntries — journal settlé via resultMap", () => {
  test("match réel présent : entrée réglée, cote attachée si > 1", () => {
    const top5 = emptyTop5();
    top5.strategies.over15 = [mkStrategyEntry()];
    const entries = buildEntries(top5, new Map([["777", mkRealMatch()]]));
    expect(entries.length).toBe(1);
    const en = entries[0];
    expect(en.id).toBe("football:over15:777");
    expect(en.sport).toBe("football");
    expect(en.strategyKey).toBe("over15");
    expect(en.pickDesc).toBe("Over 1,5");
    expect(en.status).toBe("won"); // 3 buts ≥ 2
    expect(en.score).toBe("2-1");
    expect(en.odds).toBe(1.28); // odds_over_15 du match réel
    expect(en.closingOdds).toBe(1.28);
    expect(en.settledAt).toBeDefined();
  });

  test("match réel perdu : statut lost", () => {
    const top5 = emptyTop5();
    top5.strategies.bttsYes = [mkStrategyEntry()];
    const entries = buildEntries(
      top5,
      new Map([["777", mkRealMatch({ home_score: 2, away_score: 0 })]]),
    );
    expect(entries[0].status).toBe("lost"); // 2-0 → pas de BTTS
  });

  test("cote ≤ 1 ou absente : odds null (exclu du ROI) mais cote conservée sinon", () => {
    const top5 = emptyTop5();
    top5.strategies.bestTeam = [
      mkStrategyEntry({ pick: "home" }),
      mkStrategyEntry({ matchId: "888", pick: "home" }),
    ];
    // match 777 : cote home 1.5 → attachée ; match 888 : cote 1.0 (seuil > 1) → rejetée
    const entries = buildEntries(
      top5,
      new Map([
        ["777", mkRealMatch()],
        ["888", mkRealMatch({ id: 888, odds_home: 1 })],
      ]),
    );
    const e777 = entries.find((x) => x.matchId === "777")!;
    const e888 = entries.find((x) => x.matchId === "888")!;
    expect(e777.odds).toBe(1.5);
    expect(e888.odds).toBeNull();
  });

  test("match absent du resultMap : entrée pending, sans cote", () => {
    const top5 = emptyTop5();
    top5.strategies.over15 = [mkStrategyEntry()];
    const entries = buildEntries(top5, new Map());
    expect(entries[0].status).toBe("pending");
    expect(entries[0].odds).toBeNull();
    expect(entries[0].settledAt).toBeUndefined();
    expect(entries[0].score).toBeUndefined();
  });

  test("une entrée par match × stratégie, dans l'ordre STRATEGY_TOP5_KEYS", () => {
    const top5 = emptyTop5();
    top5.strategies.gagnant = [mkStrategyEntry({ pick: "home" })];
    top5.strategies.over15 = [mkStrategyEntry()];
    const entries = buildEntries(top5, new Map([["777", mkRealMatch()]]));
    expect(entries.length).toBe(2);
    expect(entries[0].strategyKey).toBe("gagnant");
    expect(entries[1].strategyKey).toBe("over15");
  });
});
