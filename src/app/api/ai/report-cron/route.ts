/**
 * AI Report Cron — pré-génération des rapports IA des matchs à venir.
 *
 * GET /api/ai/report-cron?token=CRON_SECRET
 *
 * Appelé par pm2 (`pariscore-cron-report`, 08:00 UTC — après le réchauffage
 * de la revue de presse à 07:00, donc `press_review_json` servi depuis le
 * disque et non refetché). Pour chaque match, si aucun rapport frais n'existe
 * déjà, on exécute `generateReportV2()` et on persiste dans
 * `.cache/ai-report/` : la modal affiche alors en < 50 ms au lieu de payer
 * les 2-4 s d'appel LLM à l'ouverture.
 *
 * Un rapport dégradé n'est pas persisté (le run suivant retentera).
 *
 * Réponse : { ok, attempted, generated, cached, degraded, skipped, errors }
 */
import { NextResponse } from "next/server";
import type { FootballMatch } from "@/lib/football-data";
import { buildReportPayload, identityFromPayload } from "@/lib/football-match-report";
import {
  buildReportPayloadV2,
  generateReportV2,
  resolveReportSources,
} from "@/lib/football-match-report-v2";
import { readAiReport, writeAiReport } from "@/lib/ai-report-cache";

const CRON_SECRET = process.env.CRON_SECRET;
/** Matchs traités par run — borné pour rester dans le budget LLM quotidien. */
const MAX_MATCHES = 20;
/** Throttle entre deux générations : courtoisie envers le provider. */
const DELAY_MS = 1_000;
const MAX_PAYLOAD_BYTES = 10_000;
/** Fenêtre d'historique BSD pour SOT / H2H / J-days, chargée une seule fois. */
const HISTORY_DAYS = 60;

const baseUrl = () => process.env.PRESS_CRON_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3005";

async function fetchTodayMatches(): Promise<FootballMatch[]> {
  const res = await fetch(`${baseUrl()}/api/football/matches`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`football/matches ${res.status}`);
  const json = (await res.json()) as { matches?: FootballMatch[] };
  return json.matches ?? [];
}

/** Historique terminé BSD sur `HISTORY_DAYS` — 1 seul appel pour tout le run. */
async function fetchHistory() {
  try {
    const { fetchBSDFootballFinishedRange } = await import("@/lib/bsd-football-fetcher");
    const to = new Date();
    const from = new Date(to.getTime() - HISTORY_DAYS * 86_400_000);
    return await fetchBSDFootballFinishedRange(from.toISOString(), to.toISOString());
  } catch (err) {
    console.warn("[report-cron] historique BSD indisponible, SOT/H2H/J-days absents :", (err as Error).message);
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  if (!CRON_SECRET || searchParams.get("token") !== CRON_SECRET) {
    return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  }

  const errors: string[] = [];
  let attempted = 0;
  let generated = 0;
  let cached = 0;
  let degraded = 0;
  let skipped = 0;

  try {
    const matches = await fetchTodayMatches();
    // Les matchs les plus proches d'abord : budget LLM borné, on sert ceux
    // qui vont être ouverts en premier.
    const upcoming = matches
      .filter((m) => Number.isFinite(Date.parse(m.scheduledAt)))
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
      .slice(0, MAX_MATCHES);

    const finished = await fetchHistory();

    for (const match of upcoming) {
      attempted++;

      const base = buildReportPayload(match);
      const fromPayload = identityFromPayload(base);
      if (!fromPayload) {
        skipped++;
        continue;
      }

      if (await readAiReport(match.id)) {
        cached++;
        continue;
      }

      try {
        const identity = { ...fromPayload, matchId: match.id };
        const sources = await resolveReportSources(identity, { fetchPress: true, finished });
        const payload = buildReportPayloadV2({ identity, base, sources });
        if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
          skipped++;
          continue;
        }

        const out = await generateReportV2(payload);
        if (out.degraded) {
          degraded++;
          errors.push(...out.errors.slice(0, 2));
        } else {
          const written = await writeAiReport(match.id, {
            v2: out.report,
            legacy: out.legacy,
            provider: out.provider,
            degraded: out.degraded,
            at: Date.now(),
          });
          if (written) generated++;
        }
      } catch (err) {
        // Un match en échec ne doit pas faire tomber tout le run.
        skipped++;
        errors.push(`${match.id}: ${err instanceof Error ? err.message : String(err)}`);
      }

      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    return NextResponse.json({
      ok: true,
      attempted,
      generated,
      cached,
      degraded,
      skipped,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message, attempted, generated, cached, degraded, skipped, errors },
      { status: 500 },
    );
  }
}
