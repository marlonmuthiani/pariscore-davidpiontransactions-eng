// GET /api/football/matches/{id}/timing — statistiques de timing des buts
// des deux équipes (N derniers matchs terminés) + proba « premier à marquer ».
// Le service cache 1 h en mémoire (historique terminé immuable côté données).

import { NextResponse } from "next/server";
import { getMatchTimingStats } from "@/lib/stats/goal-timing-service";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Validation stricte (MEDIUM AUDIT-2026-09-09) : id interpolé en URL BSD.
  if (!/^\d+$/.test(id)) {
    return NextResponse.json({ error: "identifiant match invalide" }, { status: 400 });
  }
  try {
    const data = await getMatchTimingStats(id);
    if (!data) {
      return NextResponse.json(
        { error: "statistiques de timing indisponibles pour ce match" },
        { status: 404 },
      );
    }
    return NextResponse.json(data, {
      headers: { "Cache-Control": "public, max-age=1800, stale-while-revalidate=3600" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `échec timing stats: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
