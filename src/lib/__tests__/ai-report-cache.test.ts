import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AI_REPORT_TTL_MS,
  aiReportCachePath,
  clearAiReportCache,
  clearAiReportMemo,
  readAiReport,
  safeReportId,
  writeAiReport,
  type StoredAiReport,
} from "@/lib/ai-report-cache";
import { buildDegradedReportV2, toLegacyReport } from "@/lib/football-match-report-v2";

function entry(overrides: Partial<StoredAiReport> = {}): StoredAiReport {
  const v2 = buildDegradedReportV2({ match_id: "bsd-42" }, []);
  return {
    v2,
    legacy: toLegacyReport(v2),
    provider: "gemini",
    degraded: false,
    at: Date.now(),
    ...overrides,
  };
}

describe("ai-report-cache — cache disque TTL 12 h", () => {
  beforeEach(() => {
    process.env.AI_REPORT_CACHE_DIR = mkdtempSync(join(tmpdir(), "ai-report-"));
  });

  afterEach(async () => {
    await clearAiReportCache();
    delete process.env.AI_REPORT_CACHE_DIR;
  });

  test("aller-retour disque : ce qu'on écrit est ce qu'on lit", async () => {
    const e = entry();
    expect(await writeAiReport("bsd-42", e)).toBe(true);
    expect(existsSync(aiReportCachePath("bsd-42"))).toBe(true);

    await clearAiReportMemo(); // vide la mémo pour forcer la lecture disque
    const read = await readAiReport("bsd-42");
    expect(read).not.toBeNull();
    expect(read!.v2.meta.matchId).toBe("bsd-42");
    expect(read!.provider).toBe("gemini");
    expect(read!.at).toBe(e.at);
  });

  test("un rapport dégradé n'est JAMAIS persisté", async () => {
    const e = entry({ degraded: true });
    expect(await writeAiReport("bsd-degraded", e)).toBe(false);
    expect(existsSync(aiReportCachePath("bsd-degraded"))).toBe(false);
    expect(await readAiReport("bsd-degraded")).toBeNull();
  });

  test("expiration TTL : au-delà de 12 h, le rapport n'est plus servi", async () => {
    const stale = entry({ at: Date.now() - AI_REPORT_TTL_MS - 1_000 });
    expect(await writeAiReport("bsd-stale", stale)).toBe(true);
    expect(await readAiReport("bsd-stale")).toBeNull();
  });

  test("juste en dessous du TTL : toujours servi", async () => {
    const almost = entry({ at: Date.now() - AI_REPORT_TTL_MS + 60_000 });
    expect(await writeAiReport("bsd-almost", almost)).toBe(true);
    expect(await readAiReport("bsd-almost")).not.toBeNull();
  });

  test("matchId malveillant : aucun séparateur de chemin ne survit", async () => {
    const evil = "../../etc/passwd";
    const id = safeReportId(evil);
    expect(id).not.toMatch(/[./\\]/);
    expect(id).toBe("______etc_passwd");

    const e = entry();
    expect(await writeAiReport(evil, e)).toBe(true);
    expect(existsSync(aiReportCachePath(evil))).toBe(true);
    // Écrit bien dans le dossier cache, jamais au-dessus.
    expect(aiReportCachePath(evil).startsWith(String(process.env.AI_REPORT_CACHE_DIR))).toBe(true);
    expect(await readAiReport(evil)).not.toBeNull();
  });

  test("fichier corrompu → cache miss silencieux, jamais d'exception", async () => {
    writeFileSync(aiReportCachePath("bsd-corrupt"), "{ pas du json", "utf8");
    expect(await readAiReport("bsd-corrupt")).toBeNull();
  });

  test("lecture d'un fichier présent mais périmé sur disque → miss", async () => {
    const stale = entry({ at: Date.now() - AI_REPORT_TTL_MS - 5_000 });
    writeFileSync(aiReportCachePath("bsd-old"), JSON.stringify(stale), "utf8");
    expect(await readAiReport("bsd-old")).toBeNull();
    // Et le fichier reste tel quel : on ne sert pas, on ne réécrit pas non plus.
    expect(JSON.parse(readFileSync(aiReportCachePath("bsd-old"), "utf8")).at).toBe(stale.at);
  });

  test("purge totale : le dossier cache est vidé", async () => {
    await writeAiReport("bsd-a", entry());
    await writeAiReport("bsd-b", entry());
    expect(await clearAiReportCache()).toBe(1);
    expect(await readAiReport("bsd-a")).toBeNull();
    expect(await readAiReport("bsd-b")).toBeNull();
  });
});
