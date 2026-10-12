"use client";

import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { modelEdge, kellyForSide } from "@/lib/prediction/mma/moneyline";

type Props = {
  bestOddsA?: number | null;
  bestOddsB?: number | null;
  aiOddsA?: number | null;
  aiOddsB?: number | null;
  evA?: number | null;
  evB?: number | null;
  /** Proba ensembliste PariScore (blend marché 55% / DRatings 30% / modèle 15%). */
  psProbA?: number | null;
  /** Cote X (1X2) — requise avec psProbA pour l'edge (marché 3 voies). */
  drawOdds?: number | null;
  fighterA: string;
  fighterB: string;
};

export function MmaOddsDisplay({
  bestOddsA,
  bestOddsB,
  aiOddsA,
  aiOddsB,
  evA,
  evB,
  psProbA,
  drawOdds,
  fighterA,
  fighterB,
}: Props) {
  if (bestOddsA == null && bestOddsB == null) return null;

  const formatOdds = (v: number | null | undefined) =>
    v != null ? v.toFixed(2) : "—";

  const formatEv = (v: number | null | undefined) => {
    if (v == null) return null;
    const sign = v > 0 ? "+" : "";
    return `${sign}${v.toFixed(1)}%`;
  };

  const evColor = (v: number | null | undefined) => {
    if (v == null) return "text-muted-foreground";
    if (v > 3) return "text-emerald-600 dark:text-emerald-400";
    if (v > 0) return "text-emerald-500 dark:text-emerald-400";
    if (v < -3) return "text-red-500 dark:text-red-400";
    return "text-muted-foreground";
  };

  const renderEvIcon = (v: number | null | undefined) => {
    if (v == null) return <Minus className="h-3 w-3" />;
    if (v > 0) return <TrendingUp className="h-3 w-3" />;
    return <TrendingDown className="h-3 w-3" />;
  };

  // Edge PariScore + mise Kelly : edge_i = p×(cote−1) − (1−p) avec p = ps_prob
  // (nul = défaite), Kelly fractional capé 25 % du côté le plus intéressant.
  // Même math que la grille 1xBet (lib moneyline) — une seule source de vérité.
  const edge =
    psProbA != null && bestOddsA != null && bestOddsB != null
      ? modelEdge(psProbA, bestOddsA, drawOdds, bestOddsB)
      : null;
  const kelly =
    edge?.best != null && psProbA != null
      ? kellyForSide(
          psProbA,
          edge.best.side,
          edge.best.side === 1 ? (bestOddsA as number) : (bestOddsB as number),
        )
      : null;

  const sideCell = (side: 1 | 2, content: React.ReactNode) => (
    <div
      className={cn(
        "flex items-center justify-center gap-0.5 tabular-nums font-semibold",
        content === null || content === "—" ? "text-muted-foreground/60" : "text-emerald-600 dark:text-emerald-400",
      )}
    >
      {content ?? "—"}
    </div>
  );

  return (
    <div className="mt-3 rounded-xl bg-muted/20 px-3 py-2.5">
      <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-[11px]">
        {/* Best odds */}
        <div className="text-muted-foreground">Cotes 1xBet</div>
        <div className="text-center font-bold tabular-nums text-foreground">
          {formatOdds(bestOddsA)}
        </div>
        <div className="text-center font-bold tabular-nums text-foreground">
          {formatOdds(bestOddsB)}
        </div>

        {/* AI odds */}
        {aiOddsA != null && aiOddsB != null && (
          <>
            <div className="text-muted-foreground">Modèle</div>
            <div className="text-center tabular-nums text-foreground">
              {formatOdds(aiOddsA)}
            </div>
            <div className="text-center tabular-nums text-foreground">
              {formatOdds(aiOddsB)}
            </div>
          </>
        )}

        {/* EV */}
        {(evA != null || evB != null) && (
          <>
            <div className="text-muted-foreground">EV</div>
            <div className={cn("flex items-center justify-center gap-0.5 tabular-nums font-semibold", evColor(evA))}>
              {renderEvIcon(evA)}
              {formatEv(evA) ?? "—"}
            </div>
            <div className={cn("flex items-center justify-center gap-0.5 tabular-nums font-semibold", evColor(evB))}>
              {renderEvIcon(evB)}
              {formatEv(evB) ?? "—"}
            </div>
          </>
        )}

        {/* Edge PariScore du modèle vs cotes 1xBet */}
        {edge && (
          <>
            <div className="text-muted-foreground">Edge</div>
            {sideCell(
              1,
              edge.best?.side === 1 ? `+${(edge.best.edge * 100).toFixed(1)}%` : null,
            )}
            {sideCell(
              2,
              edge.best?.side === 2 ? `+${(edge.best.edge * 100).toFixed(1)}%` : null,
            )}
          </>
        )}

        {/* Mise conseillée : Kelly fractional du côté à edge positif */}
        {kelly && kelly.pct > 0 && (
          <>
            <div className="text-muted-foreground">Kelly</div>
            {sideCell(
              1,
              edge?.best?.side === 1 ? `${kelly.pct.toFixed(1)}%${kelly.capped ? "*" : ""}` : null,
            )}
            {sideCell(
              2,
              edge?.best?.side === 2 ? `${kelly.pct.toFixed(1)}%${kelly.capped ? "*" : ""}` : null,
            )}
          </>
        )}
      </div>
      {kelly?.capped && (
        <p className="mt-1 text-[10px] text-muted-foreground/70">
          * Mise Kelly plafonnée à 25 % de la bankroll.
        </p>
      )}
    </div>
  );
}
