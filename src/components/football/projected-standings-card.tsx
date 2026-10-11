"use client";

import { cn } from "@/lib/utils";
import { Minus, Sparkles, TrendingDown, TrendingUp } from "lucide-react";
import { useRankProjector } from "@/hooks/use-rank-projector";

type Props = {
  /** Slug PariScore de la ligue (ex: "epl") — même clé que le picker Rankings. */
  league: string;
};

const PHASE_LABEL: Record<string, string> = {
  early: "Début de saison",
  mid: "Milieu de saison",
  late: "Fin de saison",
};

/**
 * ProjectedStandingsCard — « Classement projeté fin de saison ».
 *
 * Modèle ExtraTrees hors-ligne entraîné walk-forward sur football-data.co.uk
 * (scripts/fit_rank_projector.py), réplique du volet régression du papier
 * JISTA 2026 AutoML (doi:10.38016/jista.2000399) :
 *   Spearman walk-forward @60 % = 0.90, MAE ≈ 4.9 pts (papier : 0.95 / 5-6 pts).
 * Masquée si la ligue n'est pas couverte ou si la saison est trop jeune.
 */
export function ProjectedStandingsCard({ league }: Props) {
  const { projection, isLoading } = useRankProjector(league);

  if (isLoading) {
    return (
      <div className="animate-pulse rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
        <div className="h-4 w-48 rounded bg-white/[0.06]" />
        <div className="mt-3 h-3 w-full rounded bg-white/[0.04]" />
        <div className="mt-2 h-3 w-3/4 rounded bg-white/[0.04]" />
      </div>
    );
  }

  if (!projection) return null;

  const { meta, teams } = projection;
  const wf = meta.walkforward;
  const isEarly = meta.phase === "early";

  return (
    <section
      aria-label="Classement projeté fin de saison"
      className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4"
    >
      {/* En-tête */}
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="h-4 w-4 text-emerald-400" aria-hidden />
        <h4 className="text-sm font-bold text-zinc-100">Classement projeté</h4>
        {meta.season && (
          <span className="text-[10px] text-zinc-500">{meta.season}</span>
        )}
        {meta.phase && (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
              isEarly
                ? "bg-amber-500/15 text-amber-400"
                : "bg-emerald-500/15 text-emerald-400",
            )}
          >
            {PHASE_LABEL[meta.phase] ?? meta.phase}
          </span>
        )}
        {wf && (
          <span className="ml-auto text-[10px] text-zinc-500">
            Spearman {wf.spearman_gate.toFixed(2)} ·{" "}
            {Math.round((wf.gate_frac ?? 0.6) * 100)} % de saison
          </span>
        )}
      </div>

      {/* Avertissement début de saison */}
      {isEarly && meta.snapshot_matches != null && (
        <p className="mt-2 text-[10px] leading-relaxed text-amber-400/80">
          Projection précoce : seulement {meta.snapshot_matches} matchs joués —
          les places restent volatiles jusqu&apos;à la 10e journée.
        </p>
      )}

      {/* Tableau projection */}
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/[0.06] text-[10px] uppercase tracking-wide text-zinc-500">
              <th className="w-10 px-2 py-1.5 text-left font-semibold">#</th>
              <th className="px-2 py-1.5 text-left font-semibold">Équipe</th>
              <th className="w-14 px-2 py-1.5 text-center font-semibold">Actuel</th>
              <th className="w-14 px-2 py-1.5 text-center font-semibold">Projeté</th>
              <th className="w-16 px-2 py-1.5 text-center font-semibold">Pts proj.</th>
              <th className="w-12 px-2 py-1.5 text-center font-semibold">Δ</th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr
                key={t.team}
                className="border-b border-white/[0.03] transition-colors hover:bg-white/[0.03]"
              >
                <td className="px-2 py-1.5">
                  <span
                    className={cn(
                      "inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold",
                      t.projectedRank === 1 && "bg-amber-500/20 text-amber-400",
                      t.projectedRank === 2 && "bg-zinc-400/20 text-zinc-300",
                      t.projectedRank === 3 && "bg-amber-700/20 text-amber-600",
                      t.projectedRank > 3 && "text-zinc-500",
                    )}
                  >
                    {t.projectedRank}
                  </span>
                </td>
                <td className="max-w-[10rem] truncate px-2 py-1.5 font-medium text-zinc-200">
                  {t.team}
                </td>
                <td className="px-2 py-1.5 text-center tabular-nums text-zinc-500">
                  {t.currentRank}
                </td>
                <td className="px-2 py-1.5 text-center tabular-nums text-zinc-300">
                  {t.projectedRank}
                </td>
                <td className="px-2 py-1.5 text-center tabular-nums text-zinc-300">
                  {t.projectedPts.toFixed(0)}
                </td>
                <td className="px-2 py-1.5 text-center">
                  <DeltaBadge delta={t.delta} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Méta / provenance */}
      <p className="mt-2 text-[9px] leading-relaxed text-zinc-600">
        {meta.model ?? "ExtraTrees"} · entraîné walk-forward sur 8 saisons
        football-data.co.uk · papier JISTA 2026 AutoML — re-ranking précoce sans
        leakage (aucun point final en entrée du modèle).
      </p>
    </section>
  );
}

/** Flèche de variation de rang : vert = montera, rouge = descendra. */
function DeltaBadge({ delta }: { delta: number }) {
  if (delta > 0) {
    return (
      <span
        className="inline-flex items-center gap-0.5 font-semibold text-emerald-400"
        aria-label={`Montera de ${delta} place${delta > 1 ? "s" : ""}`}
      >
        <TrendingUp className="h-3 w-3" aria-hidden />+{delta}
      </span>
    );
  }
  if (delta < 0) {
    return (
      <span
        className="inline-flex items-center gap-0.5 font-semibold text-rose-400"
        aria-label={`Descendra de ${-delta} place${delta < -1 ? "s" : ""}`}
      >
        <TrendingDown className="h-3 w-3" aria-hidden />
        {delta}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center text-zinc-600" aria-label="Stable">
      <Minus className="h-3 w-3" aria-hidden />
    </span>
  );
}
