"use client";

// MatchTimingStatsView — « Timing des buts » façon OddAlerts : minutes moyennes
// du premier but (match / marqué / encaissé), % de matchs avec but par fenêtre
// (0-15', 35-45', après 70') et modèle « premier à marquer ».
// Îlot clair FotMob (FOT) — même charte que ShotQualityPanel / ExgForecast du popup.

import useSWR from "swr";
import { Timer, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOT } from "./fotmob-theme";
import type { MatchTimingStatsPayload } from "@/lib/stats/goal-timing-service";

const fetcher = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(15000) }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (res.json()) as Promise<MatchTimingStatsPayload>;
  });

/** Minute affichée : arrondie + apostrophe, ou « — » si indisponible. */
const fmtMinute = (v: number | null) => (v == null ? "—" : `${Math.round(v)}'`);
const fmtPct = (v: number | null) => (v == null ? "—" : `${v}%`);

/**
 * Barre miroir pour une minute moyenne : chaque camp part du centre vers
 * l'extérieur, largeur ∝ minute / 95 — la barre courte marque tôt.
 */
function MinuteBar({ home, away }: { home: number | null; away: number | null }) {
  const norm = (v: number | null) =>
    v == null ? 0 : Math.max(5, Math.round((Math.min(v, 95) / 95) * 100));
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: FOT.border }} aria-hidden="true">
      <div className="flex flex-1 justify-end">
        {home != null && (
          <div className="h-full rounded-l-full" style={{ width: `${norm(home)}%`, backgroundColor: FOT.home }} />
        )}
      </div>
      <div className="flex flex-1">
        {away != null && (
          <div className="h-full rounded-r-full" style={{ width: `${norm(away)}%`, backgroundColor: FOT.away }} />
        )}
      </div>
    </div>
  );
}

/** Barre partagée pour un % : répartition domicile vs extérieur (min 2%). */
function SplitBar({ home, away }: { home: number | null; away: number | null }) {
  if (home == null || away == null) {
    return <div className="h-1.5 w-full rounded-full" style={{ backgroundColor: FOT.border }} />;
  }
  const hp = Math.max(2, Math.round((home / Math.max(home + away, 1)) * 100));
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: FOT.border }} aria-hidden="true">
      <div className="h-full" style={{ width: `${hp}%`, backgroundColor: FOT.home }} />
      <div className="h-full flex-1" style={{ backgroundColor: FOT.away }} />
    </div>
  );
}

/** Ligne comparative : valeur home | libellé | valeur away, barre en dessous. */
function TimingRow({
  label,
  home,
  away,
  bar,
  hint,
}: {
  label: string;
  home: string;
  away: string;
  bar: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="py-1">
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[12px] font-bold tabular-nums" style={{ color: FOT.ink }}>
        <span className="text-right">{home}</span>
        <span
          className="text-center text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: FOT.muted }}
          title={hint}
        >
          {label}
        </span>
        <span>{away}</span>
      </div>
      <div className="mt-0.5">{bar}</div>
    </div>
  );
}

export function MatchTimingStatsView({
  matchId,
  homeName = "Domicile",
  awayName = "Extérieur",
  className,
}: {
  /** Id BSD numérique du match (sans préfixe « bsd- »). */
  matchId: string;
  homeName?: string;
  awayName?: string;
  className?: string;
}) {
  const { data, isLoading } = useSWR(
    /^\d+$/.test(matchId) ? `/api/football/matches/${matchId}/timing` : null,
    fetcher,
    { revalidateOnFocus: false, keepPreviousData: true },
  );

  const usable = data != null && (data.sample.home > 0 || data.sample.away > 0);
  const fts = usable ? data.firstToScore : null;
  const favoriteHome = fts != null && fts.home > fts.away;
  const favoriteAway = fts != null && fts.away > fts.home;

  return (
    <div
      className={cn("rounded-2xl border p-3", className)}
      style={{ backgroundColor: FOT.card, borderColor: FOT.border }}
    >
      <header className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider" style={{ color: FOT.muted }}>
          <Timer className="h-3.5 w-3.5" aria-hidden="true" />
          Timing des buts
        </h3>
        {usable && (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: FOT.muted, backgroundColor: FOT.border }}
          >
            {Math.max(data.sample.home, data.sample.away)} derniers matchs
          </span>
        )}
      </header>

      {!usable ? (
        <p className="py-3 text-center text-xs" style={{ color: FOT.muted }}>
          {isLoading
            ? "Chargement du timing des buts…"
            : "Statistiques de timing indisponibles pour ce match"}
        </p>
      ) : (
        <div className="space-y-1">
          {/* En-têtes des deux colonnes */}
          <div
            className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[11px] font-bold uppercase tracking-wider"
            style={{ color: FOT.ink }}
          >
            <span className="truncate text-right">{homeName}</span>
            <span style={{ color: FOT.muted }}>vs</span>
            <span className="truncate">{awayName}</span>
          </div>

          <TimingRow
            label="1er but (moy.)"
            home={fmtMinute(data.home.all.avgFirstGoalMatch)}
            away={fmtMinute(data.away.all.avgFirstGoalMatch)}
            bar={<MinuteBar home={data.home.all.avgFirstGoalMatch} away={data.away.all.avgFirstGoalMatch} />}
            hint="Minute moyenne du premier but du match (toutes équipes)"
          />
          <TimingRow
            label="1er but marqué (moy.)"
            home={fmtMinute(data.home.all.avgFirstGoalScored)}
            away={fmtMinute(data.away.all.avgFirstGoalScored)}
            bar={<MinuteBar home={data.home.all.avgFirstGoalScored} away={data.away.all.avgFirstGoalScored} />}
            hint="Minute moyenne à laquelle l'équipe inscrit son premier but"
          />
          <TimingRow
            label="1er but encaissé (moy.)"
            home={fmtMinute(data.home.all.avgFirstGoalConceded)}
            away={fmtMinute(data.away.all.avgFirstGoalConceded)}
            bar={<MinuteBar home={data.home.all.avgFirstGoalConceded} away={data.away.all.avgFirstGoalConceded} />}
            hint="Minute moyenne à laquelle l'équipe encaisse son premier but"
          />

          <div className="my-1 border-t" style={{ borderColor: FOT.border }} />

          <TimingRow
            label="But 0-15' %"
            home={fmtPct(data.home.all.pctGoal0to15)}
            away={fmtPct(data.away.all.pctGoal0to15)}
            bar={<SplitBar home={data.home.all.pctGoal0to15} away={data.away.all.pctGoal0to15} />}
            hint="Matchs avec un but entre la 0' et la 15'"
          />
          <TimingRow
            label="But 35-45' %"
            home={fmtPct(data.home.all.pctGoal35to45)}
            away={fmtPct(data.away.all.pctGoal35to45)}
            bar={<SplitBar home={data.home.all.pctGoal35to45} away={data.away.all.pctGoal35to45} />}
            hint="Matchs avec un but entre la 35' et la 45'"
          />
          <TimingRow
            label="Buts après 70' %"
            home={fmtPct(data.home.all.pctGoalAfter70)}
            away={fmtPct(data.away.all.pctGoalAfter70)}
            bar={<SplitBar home={data.home.all.pctGoalAfter70} away={data.away.all.pctGoalAfter70} />}
            hint="Matchs avec un but après la 70'"
          />

          {/* Premier à marquer : crossing attaque précoce × vulnérabilité précoce */}
          {fts && (
            <div className="mt-2 rounded-xl p-2.5" style={{ backgroundColor: FOT.border }}>
              <p className="mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: FOT.muted }}>
                <Zap className="h-3 w-3" aria-hidden="true" />
                Premier à marquer
              </p>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                <span
                  className="text-right text-lg font-black tabular-nums"
                  style={{ color: favoriteHome ? FOT.live : FOT.ink }}
                >
                  {fts.home}%
                  {favoriteHome && <span className="ml-1 text-xs" style={{ color: FOT.live }}>▲</span>}
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: FOT.muted }}>
                  proba
                </span>
                <span
                  className="text-lg font-black tabular-nums"
                  style={{ color: favoriteAway ? FOT.live : FOT.ink }}
                >
                  {favoriteAway && <span className="mr-1 text-xs" style={{ color: FOT.live }}>▲</span>}
                  {fts.away}%
                </span>
              </div>
              <div className="mt-1.5">
                <SplitBar home={fts.home} away={fts.away} />
              </div>
              <p className="mt-1.5 text-[9px] leading-snug" style={{ color: FOT.muted }}>
                Attaque précoce de chaque équipe croisée avec la vulnérabilité précoce de l'adversaire.
              </p>
            </div>
          )}

          <p className="pt-1 text-[9px]" style={{ color: FOT.muted }}>
            Échantillon : {data.sample.home} matchs {homeName} · {data.sample.away} matchs {awayName} (terminés, source BSD).
          </p>
        </div>
      )}
    </div>
  );
}
