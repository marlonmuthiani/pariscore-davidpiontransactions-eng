import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { FootballAIReport } from "@/lib/football-match-report";
import type { FootballAIReportV2 } from "@/lib/football-match-report-v2";

/**
 * Cache disque des rapports IA — `.cache/ai-report/{matchId}.json`, TTL 12 h.
 *
 * Pourquoi le disque et pas le mémoire seul : `gemini-cache` vit dans la Map
 * du process, elle disparaît à chaque redéploiement/restart pm2 — un match
 * déjà analysé repartirait de zéro en plein pic d'ouverture de modal.
 *
 * Règles :
 * - un rapport `degraded` n'est **jamais** persisté (il empoisonnerait 12 h) ;
 * - le `matchId` est **re-saififié** avant d'être écrit : il vient du client,
 *   un `../` partirait écrire hors du dossier cache ;
 * - mémo `globalThis` en amont du disque (lecture ≈ 1 ms, mémo ≈ 0 ms).
 *
 * ponytail: fichiers plats un par match ; si le nombre de matchs couverts
 * rend le `readdir`/`prune` coûteux, passer à un index unique + garbage
 * collect périodique.
 */

export const AI_REPORT_TTL_MS = 12 * 60 * 60_000;

export type StoredAiReport = {
  v2: FootballAIReportV2;
  legacy: FootballAIReport;
  provider: string;
  degraded: boolean;
  /** Horodatage d'écriture (ms) — base du TTL. */
  at: number;
};

type MemoEntry = { data: StoredAiReport; at: number };

// Partagé sur globalThis : le cache survit au HMR de dev et aux workers d'un
// même process, sans polluer l'espace de noms des autres modules.
const g = globalThis as unknown as { __aiReport?: Record<string, MemoEntry> };

function memo(): Record<string, MemoEntry> {
  g.__aiReport = g.__aiReport ?? {};
  return g.__aiReport;
}

export function aiReportCacheDir(): string {
  // Surchargé en test : le cache de production vit dans `.cache/ai-report/`
  // (gitignoré), un test écrit dans son propre dossier temporaire.
  return process.env.AI_REPORT_CACHE_DIR || join(process.cwd(), ".cache", "ai-report");
}

/**
 * `matchId` client → nom de fichier sûr. Tout ce qui n'est pas
 * alphanumérique, `_` ou `-` part en `_` : il ne reste donc **aucun**
 * séparateur de chemin (`../` → `___`), et la longueur est bornée à 80.
 */
export function safeReportId(matchId: string): string {
  const clean = String(matchId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return clean.slice(0, 80) || "unknown";
}

export function aiReportCachePath(matchId: string): string {
  return join(aiReportCacheDir(), safeReportId(matchId) + ".json");
}

function fresh(entry: MemoEntry | StoredAiReport | undefined, nowMs: number): boolean {
  if (!entry) return false;
  return nowMs - entry.at < AI_REPORT_TTL_MS;
}

/** Lit un rapport : mémo d'abord, disque ensuite. `null` si absent ou périmé. */
export async function readAiReport(matchId: string): Promise<StoredAiReport | null> {
  const now = Date.now();
  const m = memo()[matchId];
  if (fresh(m, now)) return m!.data;

  try {
    const raw = await fs.readFile(aiReportCachePath(matchId), "utf8");
    const entry = JSON.parse(raw) as StoredAiReport;
    if (!fresh(entry, now)) return null;
    // Fichier frais mais mémo absente/périmée : on ré-alimente la mémo.
    memo()[matchId] = { data: entry, at: entry.at };
    return entry;
  } catch {
    // Fichier absent, illisible ou JSON corrompu → cache miss, pas d'erreur.
    return null;
  }
}

/**
 * Persiste un rapport. Retourne `false` sans rien écrire si le rapport est
 * dégradé : on préfère un cache miss (regénération prochaine) à 12 h de
 * rapport vide en entrée de file.
 */
export async function writeAiReport(matchId: string, entry: StoredAiReport): Promise<boolean> {
  if (entry.degraded) return false;
  memo()[matchId] = { data: entry, at: entry.at };
  try {
    await fs.mkdir(aiReportCacheDir(), { recursive: true });
    await fs.writeFile(aiReportCachePath(matchId), JSON.stringify(entry), "utf8");
    return true;
  } catch {
    // Le mémo tient la route en vie : l'écriture disque reste best-effort.
    return true;
  }
}

/**
 * Purge la mémo seule (le disque reste). Sert à prouver, en test, qu'une
 * lecture repart bien du fichier et pas de la Map.
 */
export function clearAiReportMemo(matchId?: string): void {
  const m = memo();
  if (matchId) delete m[matchId];
  else for (const k of Object.keys(m)) delete m[k];
}

/** Purge. `matchId` omis → tout le dossier (tests). Nombre de fichiers retirés. */
export async function clearAiReportCache(matchId?: string): Promise<number> {
  if (matchId) {
    delete memo()[matchId];
    try {
      await fs.unlink(aiReportCachePath(matchId));
      return 1;
    } catch {
      return 0;
    }
  }
  clearAiReportMemo();
  try {
    await fs.rm(aiReportCacheDir(), { recursive: true, force: true });
    return 1;
  } catch {
    return 0;
  }
}
