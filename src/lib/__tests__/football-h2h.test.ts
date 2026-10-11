import { describe, expect, test } from "bun:test";
import { headToHead, type H2hMeeting } from "@/lib/football-h2h";

const PSG = "Paris Saint-Germain";
const OM = "Olympique de Marseille";

const mtg = (
  kickoff: string,
  home: string,
  away: string,
  homeScore: number | null,
  awayScore: number | null,
): H2hMeeting => ({ kickoff, home, away, homeScore, awayScore });

const MEETINGS: H2hMeeting[] = [
  mtg("2023-01-10T20:00:00Z", PSG, OM, 3, 0),
  mtg("2023-09-05T20:00:00Z", OM, PSG, 1, 2),
  mtg("2024-02-12T20:00:00Z", PSG, OM, 1, 1),
  mtg("2024-10-01T20:00:00Z", OM, PSG, 0, 2),
  mtg("2025-05-03T20:00:00Z", PSG, OM, null, 2), // non terminé → écarté
  mtg("2025-12-10T20:00:00Z", OM, PSG, 3, 1),
];

describe("football-h2h — confrontations directes", () => {
  test("échantillon, période et bilan du point de vue de teamA", () => {
    const r = headToHead(MEETINGS, PSG, OM);
    expect(r.sampleSize).toBe(5); // le match sans score est exclu
    expect(r.periodFrom).toBe("2023-01-10T20:00:00Z");
    expect(r.periodTo).toBe("2025-12-10T20:00:00Z");
    expect(r.teamAWins).toBe(3);
    expect(r.draws).toBe(1);
    expect(r.teamBWins).toBe(1);
    expect(r.notes).toEqual([]);
  });

  test("le bilan est indépendant du côté où joue teamA", () => {
    const a = headToHead(MEETINGS, PSG, OM);
    const b = headToHead(MEETINGS, OM, PSG);
    expect(b.teamAWins).toBe(a.teamBWins);
    expect(b.teamBWins).toBe(a.teamAWins);
    expect(b.draws).toBe(a.draws);
  });

  test("la limite ne garde que les rencontres les plus récentes", () => {
    const r = headToHead(MEETINGS, PSG, OM, 2);
    expect(r.sampleSize).toBe(2);
    expect(r.periodTo).toBe("2025-12-10T20:00:00Z");
    expect(r.teamAWins).toBe(1);
    expect(r.teamBWins).toBe(1);
    expect(r.draws).toBe(0);
    expect(r.notes.join(" ")).toContain("insuffisant");
  });

  test("aucune rencontre → note explicite, aucun chiffre inventé", () => {
    const r = headToHead([], PSG, OM);
    expect(r.sampleSize).toBe(0);
    expect(r.periodFrom).toBeNull();
    expect(r.periodTo).toBeNull();
    expect(r.teamAWins).toBe(0);
    expect(r.notes.length).toBe(1);
  });

  test("noms normalisés et équipes identiques refusés", () => {
    expect(headToHead(MEETINGS, "PARIS SAINT GERMAIN", OM).sampleSize).toBe(5);
    expect(headToHead(MEETINGS, PSG, PSG).sampleSize).toBe(0);
    expect(headToHead(MEETINGS, "", OM).sampleSize).toBe(0);
  });
});
