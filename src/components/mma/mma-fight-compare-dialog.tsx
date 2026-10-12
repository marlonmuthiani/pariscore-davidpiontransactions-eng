"use client";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PlayerAvatar } from "@/components/ui/player-avatar";
import { MmaRadarChart, type MmaRadarData } from "./mma-radar-chart";
import { buildFightVerdict } from "@/lib/prediction/mma/verdict";
import { kellyForSide } from "@/lib/prediction/mma/moneyline";
import { formatFrenchFightTime } from "@/lib/mma-time";
import { Crown, TrendingUp, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type MmaCompareFight = {
  fighter_a: string;
  fighter_b: string;
  commence_time: string;
  weight_class?: string;
  event_name?: string;
  photo_a?: string | null;
  photo_b?: string | null;
  photo3d_a?: string | null;
  photo3d_b?: string | null;
  prob_a?: number;
  prob_b?: number;
  dr_prob_a?: number;
  dr_prob_b?: number;
  model_prob_a?: number;
  model_prob_b?: number;
  ps_prob_a?: number;
  ps_prob_b?: number;
  best_odds_a?: number;
  best_odds_b?: number;
  draw_odds?: number;
  mv_ev_a_pct?: number;
  mv_ev_b_pct?: number;
  bet_a?: boolean;
  bet_b?: boolean;
  stats_a?: MmaRadarData;
  stats_b?: MmaRadarData;
};

type Props = {
  fight: MmaCompareFight | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function fmtPct(v: number | undefined | null): string {
  return typeof v === "number" && Number.isFinite(v) ? `${Math.round(v * 100)}%` : "—";
}

function ProbBar({ label, a, b, highlightA, highlightB }: {
  label: string;
  a?: number;
  b?: number;
  highlightA?: boolean;
  highlightB?: boolean;
}) {
  if (typeof a !== "number" || typeof b !== "number") return null;
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 text-sm">
      <span
        className={cn(
          "w-16 tabular-nums font-semibold",
          highlightA ? "text-[var(--sport-mma)]" : "text-foreground"
        )}
      >
        {fmtPct(a)}
      </span>
      <span className="flex-1 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "w-16 text-right tabular-nums font-semibold",
          highlightB ? "text-sky-500" : "text-foreground"
        )}
      >
        {fmtPct(b)}
      </span>
    </div>
  );
}

/** Mise conseillée Kelly (% bankroll) pour un côté, 0 si EV ≤ 0 ou cote absente. */
function kellyPct(psA: number | undefined, side: 1 | 2, odds: number | undefined): {
  pct: number;
  capped: boolean;
} | null {
  if (typeof psA !== "number" || typeof odds !== "number" || !(odds > 1)) return null;
  return kellyForSide(psA, side, odds);
}

export function MmaFightCompareDialog({ fight, open, onOpenChange }: Props) {
  if (!fight) return null;

  const verdict = buildFightVerdict(fight);
  const kA = kellyPct(fight.ps_prob_a, 1, fight.best_odds_a);
  const kB = kellyPct(fight.ps_prob_a, 2, fight.best_odds_b);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:right-0 max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-t-2xl max-sm:rounded-b-none max-sm:mt-auto max-sm:w-full">
        <DialogHeader>
          <DialogTitle className="pr-8 text-center">
            {fight.event_name ? `${fight.event_name} — ` : ""}
            {fight.weight_class ? (
              <span className="text-sm font-normal text-muted-foreground">
                {fight.weight_class}
              </span>
            ) : null}
          </DialogTitle>
        </DialogHeader>
        <button
          onClick={() => onOpenChange(false)}
          aria-label="Fermer"
          className="absolute right-4 top-4 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>

        {/* ── Face-off : photos côte à côte ─────────────────────────── */}
        <div className="flex items-center justify-between gap-3 px-1">
          <div className="flex flex-1 flex-col items-center gap-1.5 text-center">
            <PlayerAvatar
              name={fight.fighter_a}
              photoUrl={fight.photo3d_a ?? fight.photo_a}
              size="xl"
              sport="mma"
            />
            <span className="text-sm font-bold leading-tight">{fight.fighter_a}</span>
          </div>
          <span className="shrink-0 text-lg font-black text-muted-foreground">VS</span>
          <div className="flex flex-1 flex-col items-center gap-1.5 text-center">
            <PlayerAvatar
              name={fight.fighter_b}
              photoUrl={fight.photo3d_b ?? fight.photo_b}
              size="xl"
              sport="mma"
            />
            <span className="text-sm font-bold leading-tight">{fight.fighter_b}</span>
          </div>
        </div>

        {/* ── Verdict : gagnant prédit (surligné si ≥ 65 %) ─────────── */}
        {verdict && (
          <div
            className={cn(
              "rounded-xl border px-4 py-3",
              verdict.isStrong
                ? "border-[var(--sport-mma)]/50 bg-[var(--sport-mma)]/10"
                : "border-border bg-muted/40"
            )}
            role="status"
            aria-label={`Gagnant prédit : ${verdict.winnerName}`}
          >
            <div className="flex items-center gap-2">
              <Crown
                className={cn(
                  "h-5 w-5 shrink-0",
                  verdict.isStrong ? "text-yellow-500" : "text-muted-foreground"
                )}
              />
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Gagnant prédit
              </p>
            </div>
            <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
              <span className="text-lg font-black text-foreground">{verdict.winnerName}</span>
              <span
                className={cn(
                  "text-lg font-black tabular-nums",
                  verdict.isStrong ? "text-[var(--sport-mma)]" : "text-foreground"
                )}
              >
                {Math.round(verdict.prob * 100)}%
              </span>
              {verdict.isStrong && (
                <span className="rounded-full bg-[var(--sport-mma)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                  Confiance forte ≥ 65%
                </span>
              )}
            </p>

            {/* Raisons : pourquoi le favori va gagner */}
            <ul className="mt-2 space-y-1">
              {verdict.reasons.map((r, i) => (
                <li key={i} className="flex gap-1.5 text-xs text-muted-foreground">
                  <span aria-hidden className="mt-0.5 shrink-0 text-[var(--sport-mma)]">
                    ▸
                  </span>
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── Probas par source ─────────────────────────────────────── */}
        <div className="divide-y divide-border rounded-xl border border-border px-3 py-1">
          <ProbBar
            label="Marché"
            a={fight.prob_a}
            b={fight.prob_b}
            highlightA={verdict?.winner === "a"}
            highlightB={verdict?.winner === "b"}
          />
          <ProbBar
            label="DRatings"
            a={fight.dr_prob_a}
            b={fight.dr_prob_b}
            highlightA={verdict?.winner === "a"}
            highlightB={verdict?.winner === "b"}
          />
          <ProbBar
            label="Modèle"
            a={fight.model_prob_a}
            b={fight.model_prob_b}
            highlightA={verdict?.winner === "a"}
            highlightB={verdict?.winner === "b"}
          />
          <ProbBar
            label="PariScore"
            a={fight.ps_prob_a}
            b={fight.ps_prob_b}
            highlightA={verdict?.winner === "a"}
            highlightB={verdict?.winner === "b"}
          />
        </div>

        {/* ── Bets prédictifs : cotes, EV, Kelly ────────────────────── */}
        {(fight.best_odds_a != null || fight.best_odds_b != null) && (
          <div className="rounded-xl border border-border">
            <p className="border-b border-border px-3 py-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Bets prédictifs
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-1.5 text-left font-semibold">Indicateur</th>
                  <th className="px-3 py-1.5 text-right font-semibold">{fight.fighter_a}</th>
                  <th className="px-3 py-1.5 text-right font-semibold">{fight.fighter_b}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                <tr>
                  <td className="px-3 py-1.5 text-muted-foreground">Proba PariScore</td>
                  <td className="px-3 py-1.5 text-right font-bold tabular-nums">
                    {fmtPct(fight.ps_prob_a)}
                  </td>
                  <td className="px-3 py-1.5 text-right font-bold tabular-nums">
                    {fmtPct(fight.ps_prob_b)}
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-1.5 text-muted-foreground">Cote 1xBet</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {fight.best_odds_a?.toFixed(2) ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums">
                    {fight.best_odds_b?.toFixed(2) ?? "—"}
                    {fight.draw_odds != null && (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        (X {fight.draw_odds})
                      </span>
                    )}
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-1.5 text-muted-foreground">EV modèle</td>
                  <td
                    className={cn(
                      "px-3 py-1.5 text-right font-semibold tabular-nums",
                      (fight.mv_ev_a_pct ?? 0) > 0 && "text-emerald-500"
                    )}
                  >
                    {fight.mv_ev_a_pct != null ? `${fight.mv_ev_a_pct.toFixed(1)}%` : "—"}
                  </td>
                  <td
                    className={cn(
                      "px-3 py-1.5 text-right font-semibold tabular-nums",
                      (fight.mv_ev_b_pct ?? 0) > 0 && "text-emerald-500"
                    )}
                  >
                    {fight.mv_ev_b_pct != null ? `${fight.mv_ev_b_pct.toFixed(1)}%` : "—"}
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-1.5 text-muted-foreground">Mise Kelly conseillée</td>
                  <td className="px-3 py-1.5 text-right font-bold tabular-nums">
                    {kA ? (
                      <span className="inline-flex items-center gap-1">
                        {kA.pct > 0 ? `${kA.pct.toFixed(1)}%` : "—"}
                        {kA.capped && <span className="text-[10px] text-amber-500">*</span>}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right font-bold tabular-nums">
                    {kB ? (
                      <span className="inline-flex items-center gap-1">
                        {kB.pct > 0 ? `${kB.pct.toFixed(1)}%` : "—"}
                        {kB.capped && <span className="text-[10px] text-amber-500">*</span>}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
                {(fight.bet_a || fight.bet_b) && (
                  <tr>
                    <td className="px-3 py-1.5 text-muted-foreground">Value bet</td>
                    <td className="px-3 py-1.5 text-right">
                      {fight.bet_a && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-600 dark:text-emerald-400">
                          <TrendingUp className="h-3 w-3" />
                          Value
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {fight.bet_b && (
                        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-600 dark:text-emerald-400">
                          <TrendingUp className="h-3 w-3" />
                          Value
                        </span>
                      )}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {(kA?.capped || kB?.capped) && (
              <p className="px-3 pb-2 pt-1 text-[10px] text-muted-foreground">
                * Mise plafonnée (fractional Kelly, cap 25 % de la bankroll).
              </p>
            )}
          </div>
        )}

        {/* ── Radar stats ───────────────────────────────────────────── */}
        {(fight.stats_a || fight.stats_b) && (
          <div>
            <p className="mb-1 text-center text-xs font-bold uppercase tracking-wider text-muted-foreground">
              Stats EWMA comparées
            </p>
            <MmaRadarChart
              dataA={fight.stats_a ?? { striking: 0, takedowns: 0, ground: 0, damage: 0 }}
              dataB={fight.stats_b}
              fighterA={fight.fighter_a}
              fighterB={fight.fighter_b}
            />
          </div>
        )}

        {/* ── Heure Paris ───────────────────────────────────────────── */}
        <p className="text-center text-xs text-muted-foreground">
          Combat prévu le {formatFrenchFightTime(fight.commence_time)} (heure de Paris)
        </p>
      </DialogContent>
    </Dialog>
  );
}
