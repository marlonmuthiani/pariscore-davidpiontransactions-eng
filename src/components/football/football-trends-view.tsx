"use client";

// Sous-onglet « Tendances » football (modèle OddAlerts /trends, réplique FR).
//
// Pour chaque marché (Résultats / Buts / Corners / Cartons), cartes des
// ligues dont le hit rate saison dépasse 55 % — avec prochain fixture,
// cote 1X2 et edge (hit rate − probabilité implicite). Source :
// league_season_stats (cron OddAlerts quotidien) via /api/football/trends.
// Granularité ligue : ponytail: pas d'historique football par équipe en
// base — cf. .context/RAPPORT-ODDALERTS-TRENDS.md §6 pour la suite équipe.

import { useMemo, useState } from "react";
import { AlertCircle, Flame, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFootballTrends } from "@/hooks/use-football-trends";
import {
  TREND_CATEGORIES,
  type TrendCategory,
  type TrendEntry,
  type TrendsMarketGroup,
} from "@/lib/stats/football-trends-shared";
import { CountryFlag } from "@/components/ui/country-flag";
import { FOTMOB } from "@/components/football/fotmob-tokens";

const C = {
  card: FOTMOB.card,
  cardBorder: FOTMOB.cardBorder,
  rowSep: FOTMOB.rowSep,
  headerBg: FOTMOB.headerBg,
  headerText: FOTMOB.headerText,
  team: FOTMOB.team,
  time: FOTMOB.time,
  accent: FOTMOB.accent,
  score: FOTMOB.score,
} as const;

/** Badge edge : vert si positif, neutre sinon (OddAlerts n'affiche que +N). */
function EdgeBadge({ edge }: { edge: number | null }) {
  if (edge == null) return null;
  const positive = edge > 0;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-bold tabular-nums",
        positive
          ? "bg-[#00985f]/10 text-[#00985f] border-[#00985f]/25"
          : "bg-[#f0f0f0] text-[#717171] border-[#e0e0e0]",
      )}
    >
      {positive ? <TrendingUp className="mr-0.5 h-3 w-3" aria-hidden /> : <TrendingDown className="mr-0.5 h-3 w-3" aria-hidden />}
      {edge > 0 ? "+" : ""}
      {edge}
    </span>
  );
}

function TeamBadge({ name, badge }: { name: string; badge: string | null }) {
  if (!badge) return <span className="h-4 w-4 shrink-0 rounded-sm bg-muted" aria-hidden />;
  return (
    <img src={badge} alt="" loading="lazy" width={16} height={16} className="h-4 w-4 shrink-0 object-contain" aria-hidden />
  );
}

function TrendRow({ entry }: { entry: TrendEntry }) {
  const f = entry.fixture;
  return (
    <div className="px-3 py-2.5" style={{ borderTop: `1px solid ${C.rowSep}` }}>
      {/* Ligue + hit rate + cote + edge */}
      <div className="flex items-center gap-2">
        <CountryFlag country={entry.country} size={14} />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" style={{ color: C.team }}>
          {entry.leagueName}
          <span className="ml-1.5 text-[11px] font-normal" style={{ color: C.time }}>
            · {entry.country}
          </span>
        </span>
        <span className="shrink-0 font-mono text-[11px] tabular-nums" style={{ color: C.time }}>
          {entry.hits}/{entry.gamesPlayed}
        </span>
        <span
          className="shrink-0 font-mono text-[15px] font-bold tabular-nums"
          style={{ color: entry.hitPct >= 70 ? C.accent : C.score }}
        >
          {entry.hitPct}%
        </span>
        {entry.odds != null && (
          <span className="shrink-0 font-mono text-[12px] tabular-nums" style={{ color: C.score }}>
            {entry.odds.toFixed(2)}
          </span>
        )}
        <EdgeBadge edge={entry.edge} />
      </div>
      {/* Prochain match de la ligue */}
      {f && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[12px]" style={{ color: C.time }}>
          {f.kickoff && <span className="shrink-0 font-medium">{f.kickoff}</span>}
          <TeamBadge name={f.homeName} badge={f.homeBadge} />
          <span className="min-w-0 truncate" style={{ color: C.team }}>{f.homeName}</span>
          <span aria-hidden>–</span>
          <TeamBadge name={f.awayName} badge={f.awayBadge} />
          <span className="min-w-0 truncate" style={{ color: C.team }}>{f.awayName}</span>
        </div>
      )}
    </div>
  );
}

function MarketCard({ group }: { group: TrendsMarketGroup }) {
  return (
    <section
      className="overflow-hidden rounded-xl border"
      style={{ background: C.card, borderColor: C.cardBorder }}
      aria-label={group.label}
    >
      <header
        className="flex items-center gap-2 px-3 py-2"
        style={{ background: C.headerBg, borderBottom: `1px solid ${C.rowSep}` }}
      >
        <Flame className="h-3.5 w-3.5" style={{ color: C.accent }} aria-hidden />
        <h3 className="text-[13px] font-bold" style={{ color: C.headerText }}>
          {group.label}
        </h3>
        <span
          className="ml-auto rounded-full px-2 py-0.5 text-[11px] font-bold"
          style={{ background: `${C.accent}15`, color: C.accent }}
        >
          {group.entries.length}
        </span>
      </header>
      {group.entries.map((entry) => (
        <TrendRow key={`${entry.marketId}-${entry.leagueId}`} entry={entry} />
      ))}
    </section>
  );
}

export function FootballTrendsView() {
  const { data, error, isLoading } = useFootballTrends();
  const [category, setCategory] = useState<TrendCategory | "all">("all");

  const groups = useMemo(() => {
    const all = data?.markets ?? [];
    return category === "all" ? all : all.filter((m) => m.category === category);
  }, [data, category]);

  return (
    <div className="w-full" role="region" aria-label="Tendances football">
      {/* Filtres par catégorie (Buts / Corners / Résultats / Cartons) */}
      <div
        role="group"
        aria-label="Filtrer par catégorie"
        className="mb-3 flex w-full gap-1 overflow-x-auto rounded-lg border p-1"
        style={{ borderColor: C.cardBorder, background: C.headerBg }}
      >
        {TREND_CATEGORIES.map((c) => {
          const active = category === c.id;
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={active}
              onClick={() => setCategory(c.id)}
              className={cn(
                "flex-1 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      {/* Pied explicatif : source + fraîcheur */}
      <p className="mb-3 text-[11px]" style={{ color: C.time }}>
        Hit rates saison par ligue (source OddAlerts, cron 04:30) ·{" "}
        {data ? `${data.leaguesScanned} ligues scannées` : "chargement…"} · seuil 55 % sur ≥ 6 matchs
      </p>

      {error && (
        <div
          className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/5 p-3 text-sm text-rose-700 dark:text-rose-300"
          role="alert"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Tendances indisponibles : {error.message}</p>
        </div>
      )}

      {isLoading && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-40 animate-pulse rounded-xl border"
              style={{ background: C.headerBg, borderColor: C.cardBorder }}
            />
          ))}
        </div>
      )}

      {!isLoading && !error && groups.length === 0 && (
        <div
          className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center"
          style={{ borderColor: C.cardBorder }}
        >
          <Flame className="h-5 w-5 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">Aucune tendance active</p>
          <p className="max-w-md text-xs text-muted-foreground">
            Aucune ligue ne dépasse le seuil de hit rate sur cette catégorie —
            revenez après le prochain scrape (04:30 UTC).
          </p>
        </div>
      )}

      {!isLoading && groups.length > 0 && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {groups.map((g) => (
            <MarketCard key={g.marketId} group={g} />
          ))}
        </div>
      )}
    </div>
  );
}
