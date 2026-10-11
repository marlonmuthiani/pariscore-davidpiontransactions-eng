import { describe, expect, test } from "bun:test";
import { matchSot, sotWindow, teamSot, type SotMatch } from "@/lib/football-sot";

const PSG = "Paris Saint-Germain";
const OM = "Olympique de Marseille";

/** PSG reçoit — journée `d`, tirs cadrés PSG `hs` / adversaire `as`. */
const home = (d: number, hs: number, as: number): SotMatch => ({
  kickoff: `2026-09-${String(d).padStart(2, "0")}T15:00:00Z`,
  home: PSG,
  away: OM,
  homeShotsOnTarget: hs,
  awayShotsOnTarget: as,
});

/** PSG visite — journée `d`, tirs cadrés adversaire `hs` / PSG `as`. */
const away = (d: number, hs: number, as: number): SotMatch => ({
  kickoff: `2026-10-${String(d).padStart(2, "0")}T15:00:00Z`,
  home: OM,
  away: PSG,
  homeShotsOnTarget: hs,
  awayShotsOnTarget: as,
});

describe("football-sot — fenêtres L5/L10", () => {
  test("L5 Domicile agrège les 5 matchs les plus récents", () => {
    // 7 matchs à domicile, tirs cadrés PSG croissants : 2, 4, 6, 8, 10, 12, 14
    const matches = [1, 2, 3, 4, 5, 6, 7].map((d) => home(d, d * 2, d));
    const w = sotWindow(matches, PSG, "home", 5);
    expect(w).not.toBeNull();
    expect(w!.gp).toBe(5);
    // 5 plus récents = 6, 8, 10, 12, 14 → 50 / 5
    expect(w!.for).toBe(10);
    // adversaires = 3, 4, 5, 6, 7 → 25 / 5
    expect(w!.against).toBe(5);
  });

  test("L10 retient tous les matchs disponibles quand il y en a moins de 10", () => {
    const matches = [1, 2, 3].map((d) => home(d, d, d));
    const w = sotWindow(matches, PSG, "home", 10);
    expect(w!.gp).toBe(3);
    expect(w!.for).toBe(2); // (1+2+3)/3
  });

  test("contexte Domicile et Extérieur strictement séparés", () => {
    const matches = [home(1, 4, 1), home(2, 6, 2), away(1, 1, 9), away(2, 3, 11)];

    const homeW = sotWindow(matches, PSG, "home", 5);
    expect(homeW!.gp).toBe(2);
    expect(homeW!.for).toBe(5); // (4+6)/2
    expect(homeW!.against).toBe(1.5); // (1+2)/2

    const awayW = sotWindow(matches, PSG, "away", 5);
    expect(awayW!.gp).toBe(2);
    expect(awayW!.for).toBe(10); // (9+11)/2 — PSG marque côté extérieur
    expect(awayW!.against).toBe(2); // (1+3)/2
  });

  test("l'ordre fourni n'a pas d'importance (tri interne du plus récent au plus ancien)", () => {
    const asc = [1, 2, 3, 4, 5].map((d) => home(d, d, d));
    const shuffled = [asc[3], asc[0], asc[4], asc[1], asc[2]];
    expect(sotWindow(shuffled, PSG, "home", 5)).toEqual(sotWindow(asc, PSG, "home", 5));
  });

  test("les matchs sans valeur SOT sont écartés, jamais estimés", () => {
    const matches: SotMatch[] = [
      home(1, 4, 1),
      home(2, 6, 2),
      { ...home(3, 6, 2), homeShotsOnTarget: null },
    ];
    const w = sotWindow(matches, PSG, "home", 5);
    expect(w!.gp).toBe(2);
    expect(w!.for).toBe(5); // (4+6)/2 — le null n'entre pas dans la moyenne
  });

  test("les deux côtés doivent être renseignés pour qu'un match compte", () => {
    const partial = { ...home(1, 4, 1), awayShotsOnTarget: null };
    expect(sotWindow([partial], PSG, "home", 5)).toBeNull();
  });

  test("aucun match → null (jamais de valeur inventée)", () => {
    expect(sotWindow([], PSG, "home", 5)).toBeNull();
    expect(sotWindow([home(1, 4, 1)], "Équipe absente", "home", 5)).toBeNull();
  });

  test("noms d'équipes normalisés (casse et espaces ignorés)", () => {
    const matches = [home(1, 4, 1)];
    expect(sotWindow(matches, "PARIS SAINT GERMAIN", "home", 5)!.gp).toBe(1);
  });

  test("matchSot renvoie { home, away } cohérents", () => {
    const matches = [home(1, 4, 1), away(1, 1, 9)];
    const r = matchSot(PSG, OM, matches);
    expect(r.home.l5!.for).toBe(4); // PSG reçoit
    expect(r.home.l5!.against).toBe(1);
    expect(r.away.l5!.for).toBe(1); // OM à l'extérieur (match où PSG reçoit)
    expect(r.away.l5!.against).toBe(4);
  });

  test("teamSot expose bien L5 et L10", () => {
    const r = teamSot([home(1, 4, 1)], PSG, "home");
    expect(r.l5).not.toBeNull();
    expect(r.l10).not.toBeNull();
    expect(r.l10!.gp).toBe(1);
  });
});
