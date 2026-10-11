import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// DATABASE_PATH doit être posé AVANT l'import du lecteur : la base de test
// remplace pariscore.db pour la durée du fichier.
const dir = mkdtempSync(path.join(tmpdir(), "pariscore-foot-hist-"));
const dbFile = path.join(dir, "test.db");
process.env.DATABASE_PATH = dbFile;

const {
  clearFootballHistoryDbCache,
  footballHistoryMeta,
  loadCornerHistoryByEventIds,
  loadCornerHistoryRange,
  loadMatchStatsHistoryByEventIds,
  loadMatchStatsHistoryRange,
} = await import("@/lib/football-history-db");

function seed(): void {
  const db = new Database(dbFile);
  db.exec(`
    CREATE TABLE IF NOT EXISTS match_stats_history (
      bsd_event_id TEXT, bsd_league_id TEXT, season TEXT, match_date TEXT,
      home_team TEXT, away_team TEXT,
      home_score INTEGER, away_score INTEGER,
      home_sot INTEGER, away_sot INTEGER, home_shots INTEGER, away_shots INTEGER,
      home_corners INTEGER, away_corners INTEGER, home_xg REAL, away_xg REAL
    );
    CREATE TABLE IF NOT EXISTS corner_history (
      id INTEGER PRIMARY KEY, bsd_event_id TEXT, bsd_league_id TEXT,
      match_date TEXT, season TEXT, home_team TEXT, away_team TEXT,
      home_corners INTEGER, away_corners INTEGER, total_corners INTEGER,
      fetched_at INTEGER
    );
    INSERT INTO match_stats_history VALUES
      ('100','1','2026','2026-09-28','PSG','Lyon',2,1,6,3,12,7,7,4,1.9,0.8),
      ('101','1','2026','2026-09-29','Lille','Nice',0,0,2,2,8,6,5,3,0.7,0.6);
    INSERT INTO corner_history (bsd_event_id, bsd_league_id, match_date, season, home_team, away_team, home_corners, away_corners, total_corners, fetched_at)
      VALUES ('100','1','2026-09-28','2026','PSG','Lyon',7,4,11,1780000000),
             (NULL,'1','2026-09-30','2026','Nantes','Brest',6,6,12,1780000000);
  `);
  db.close();
}

beforeAll(() => {
  seed();
  clearFootballHistoryDbCache();
});

afterAll(() => {
  clearFootballHistoryDbCache();
  delete process.env.DATABASE_PATH;
  // Windows : le fichier sqlite peut rester verrouillé un court instant après
  // close() — retries puis abandon silencieux (le cleanup ne doit pas faire
  // échouer la suite).
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // laissé au nettoyage du TEMP système
  }
});

describe("match_stats_history", () => {
  test("lecture par ids BSD", () => {
    const map = loadMatchStatsHistoryByEventIds(["100", "404"]);
    expect(map.size).toBe(1);
    const row = map.get("100")!;
    expect(row.homeTeam).toBe("PSG");
    expect(row.homeScore).toBe(2);
    expect(row.homeSot).toBe(6);
    expect(row.awayCorners).toBe(4);
    expect(row.homeXg).toBeCloseTo(1.9, 5);
  });

  test("lecture par plage de dates (bornes incluses)", () => {
    const rows = loadMatchStatsHistoryRange("2026-09-28", "2026-09-28");
    expect(rows.length).toBe(1);
    expect(rows[0].bsdEventId).toBe("100");
    expect(loadMatchStatsHistoryRange("2026-09-01", "2026-09-30").length).toBe(2);
    expect(loadMatchStatsHistoryRange("2027-01-01", "2027-01-31").length).toBe(0);
  });
});

describe("corner_history", () => {
  test("lecture par ids — lignes sans bsd_event_id ignorées", () => {
    const map = loadCornerHistoryByEventIds(["100", "101"]);
    expect(map.size).toBe(1);
    expect(map.get("100")!.totalCorners).toBe(11);
  });

  test("lecture par plage de dates", () => {
    const rows = loadCornerHistoryRange("2026-09-28", "2026-09-30");
    expect(rows.length).toBe(2);
    // la ligne sans id BSD reste lisible en range
    expect(rows[1].bsdEventId).toBeNull();
    expect(rows[1].homeCorners).toBe(6);
  });
});

describe("footballHistoryMeta", () => {
  test("volume + couverture des deux tables", () => {
    const meta = footballHistoryMeta();
    expect(meta.matchStats?.n).toBe(2);
    expect(meta.matchStats?.minDate).toBe("2026-09-28");
    expect(meta.corners?.n).toBe(2);
    expect(meta.corners?.maxDate).toBe("2026-09-30");
  });
});

describe("base absente", () => {
  test("retour vide sans throw", () => {
    clearFootballHistoryDbCache();
    process.env.DATABASE_PATH = path.join(dir, "inexistant.db");
    clearFootballHistoryDbCache();
    expect(loadMatchStatsHistoryByEventIds(["100"]).size).toBe(0);
    expect(loadCornerHistoryRange("2020-01-01", "2030-01-01").length).toBe(0);
    const meta = footballHistoryMeta();
    expect(meta.matchStats).toBeNull();
  });
});
