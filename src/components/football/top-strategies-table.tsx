import { useState } from "react";
import { cn } from "@/lib/utils";
import { FOTMOB } from "@/components/football/fotmob-tokens";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import type { StrategyTop5Key } from "@/lib/football-strategy-top5";
import { parisDateShort, parisKickoff } from "@/lib/football-time";

export type StrategyTableRow = {
  matchId: string;
  league?: string | null;
  leagueLogo?: string | null;
  kickoff: string;
  home: { teamName: string; logo?: string };
  away: { teamName: string; logo?: string };
  /** Valeur brute scorée par le moteur (unité = stratégie). */
  value: number;
  /** Valeur formatée par la stratégie (ex. "78%", "2,8 buts", "0,9 enc"). */
  display: string;
  /** Probabilité 0-100 pour le badge, null si la stratégie n'est pas une proba. */
  probPct: number | null;
  /** Cote BSD pertinente pour la stratégie (null si absente). */
  odds?: number | null;
  /** Libellé de la cote (ex. "1", "N", "Over 1,5"). */
  oddsLabel?: string | null;
  /** Badge de source (ex. "forme"/"cotes" sur bestTeam). */
  sourceLabel?: string | null;
  /** Ligne atténuée (repli « Nul probable »). */
  muted?: boolean;
  /** Mention affichée sur les lignes atténuées. */
  note?: string | null;
  /** Meilleur bet Over (ex. "Over 21,5 68 %", tennis, proba ≥ 60 %). */
  overPick?: string | null;
  /** Meilleur serveur / receveur (ex. "S Tiafoe 82 % · R Shelton 38 %"). */
  serveEdge?: string | null;
  trend?: "up" | "down" | "flat";
};

type Props = {
  rows: StrategyTableRow[];
  strategy: StrategyTop5Key;
  /** Ligne à surligner (match ciblé depuis une pill calendrier). */
  highlightId?: string | null;
  /** Libellé de la fenêtre temporelle active (« Jour », « 48h », « Sem. »…). */
  windowLabel?: string;
  /**
   * Ouverture de la fiche détaillée du match (comparatif Domicile/Extérieur).
   *
   * Absent = tableau non cliquable (football n'était pas concerné au départ) : le clic
   * ne fait alors rien et la ligne reste un simple affichage. Présent = chaque ligne est
   * un vrai bouton, donc atteignable au clavier — condition d'accessibilité qui n'est
   * pas négociable pour une action.
   */
  onOpenMatch?: (matchId: string) => void;
};

/* Palette FotMob clair — source unique dans fotmob-tokens.ts, partagée avec
   fotmob-calendar-table.tsx. Les deux tables affichent désormais les mêmes teintes,
   le même rythme de ligne et le même style de badge. */
const C = FOTMOB;

/**
 * Logo de club 20×20 avec repli sur initiales.
 *
 * `logo` est déjà transporté par la conversion `StrategyMatchEntry → StrategyTableRow`
 * (football-top10-widget.tsx:104-105) mais n'était **pas rendu** : la donnée existait,
 * l'affichage manquait. L'image est masquée sur erreur (URL morte de seed périmé) au
 * profit des initiales — une initiale lisible vaut mieux qu'un cadre vide, et les
 * classes sont sans bord pour ne pas doubler la place en cas d'URL morte.
 */
function TeamLogo({ src, name }: { src?: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  if (!src || failed) {
    return (
      <span
        aria-hidden
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[#e9e9f2] text-[9px] font-bold text-[#6b6b80]"
      >
        {initials || "?"}
      </span>
    );
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      width={20}
      height={20}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-5 w-5 shrink-0 rounded object-contain"
    />
  );
}

function confidenceBand(probPct: number): { label: string; cls: string } {
  if (probPct >= 70) return { label: "Élevée", cls: "bg-[#00985f]/10 text-[#00985f] border-[#00985f]/20" };
  if (probPct >= 60) return { label: "Moyenne", cls: "bg-[#FF6D00]/10 text-[#FF6D00] border-[#FF6D00]/20" };
  return { label: "Faible", cls: "bg-[#f0f0f0] text-[#717171] border-[#e0e0e0]" };
}

function TrendIcon({ trend }: { trend?: "up" | "down" | "flat" }) {
  if (trend === "up") return <ArrowUp className="h-3 w-3 text-[#00985f]" />;
  if (trend === "down") return <ArrowDown className="h-3 w-3 text-[#EF4444]" />;
  return <Minus className="h-3 w-3 text-[#717171]" />;
}

function kickoffLabel(iso: string): string {
  const d = parisDateShort(iso);
  const h = parisKickoff(iso);
  if (!d && (!h || h === "--:--")) return iso;
  return `${d} · ${h}`;
}

export function TopStrategiesTable({
  rows,
  strategy,
  highlightId,
  windowLabel,
  onOpenMatch,
}: Props) {
  if (rows.length === 0) {
    const span = windowLabel ? ` sur « ${windowLabel} »` : "";
    return (
      <div
        className="rounded-2xl p-6 text-center text-sm"
        style={{ background: C.card, border: `1px solid ${C.cardBorder}`, color: C.time }}
      >
        <p>Aucun match ne satisfait cette stratégie{span}.</p>
        <p className="mt-1 text-xs opacity-80">
          Élargissez la période (Sem.) ou changez de championnat.
        </p>
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden rounded-2xl"
      style={{ background: C.card, border: `1px solid ${C.cardBorder}` }}
    >
      {/* Header — même style que FotmobLeagueSection header */}
      <div
        className="flex h-10 items-center px-4"
        style={{ background: C.headerBg, borderBottom: `1px solid ${C.cardBorder}` }}
      >
        <span className="text-[13px] font-semibold" style={{ color: C.headerText }}>
          Matchs par stratégie
        </span>
        <span
          className="ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{ background: `${C.accent}15`, color: C.accent }}
        >
          {rows.length}
        </span>
      </div>

      <div className="w-full text-[13px]">
        {rows.map((row) => {
          const band = row.probPct != null ? confidenceBand(row.probPct) : null;
          const highlighted = highlightId != null && row.matchId === highlightId;
          const clickable = onOpenMatch != null;
          const label = `${row.home.teamName} contre ${row.away.teamName}${row.league ? `, ${row.league}` : ""}`;
          const interactiveProps = clickable
            ? {
                role: "button" as const,
                tabIndex: 0,
                "aria-label": `Ouvrir l'analyse de ${label}`,
                onClick: () => onOpenMatch(row.matchId),
                onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
                  // Enter + Espace, comme un vrai bouton. Le `<div>` n'en a pas par
                  // défaut : sans ce bloc, la ligne serait atteignable mais pas actionnable.
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenMatch(row.matchId);
                  }
                },
              }
            : {};
          // Carte isolée — même structure que les cartes du calendrier
          // (fotmob-calendar-table.tsx) : en-tête ligue/heure, équipes empilées,
          // séparateur vertical, pavé de cote à droite. Données inchangées.
          return (
            <div
              key={`${strategy}-${row.matchId}`}
              data-match-id={row.matchId}
              {...interactiveProps}
              className={cn(
                "mb-2 rounded-xl border p-3 shadow-sm transition-all duration-200 hover:border-[#c8c8c8]",
                clickable && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00985f]",
                row.muted && "opacity-60",
              )}
              style={{
                borderColor: C.cardBorder,
                backgroundColor: highlighted ? `${C.accent}14` : C.card,
              }}
            >
              {/* En-tête : ligue · horodatage, tendance à droite. */}
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 truncate text-[11px] font-medium" style={{ color: C.time }}>
                  {row.leagueLogo && (
                    <img
                      src={row.leagueLogo}
                      alt=""
                      width={14}
                      height={14}
                      loading="lazy"
                      className="h-3.5 w-3.5 shrink-0 rounded object-contain"
                      onError={(e) => {
                        // URL morte (seed périmé) : masquer plutôt qu'icône cassée.
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  )}
                  <span className="truncate">
                    {row.league} · {kickoffLabel(row.kickoff)}
                  </span>
                </span>
                <TrendIcon trend={row.trend} />
              </div>

              {/* Corps : équipes empilées | séparateur | valeur + pavé cote. */}
              <div className="flex items-stretch gap-3">
                <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <TeamLogo src={row.home.logo} name={row.home.teamName} />
                    <span className="truncate text-[14px] font-semibold" style={{ color: C.team }}>
                      {row.home.teamName}
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center gap-2">
                    <TeamLogo src={row.away.logo} name={row.away.teamName} />
                    <span className="truncate text-[14px] font-semibold" style={{ color: C.team }}>
                      {row.away.teamName}
                    </span>
                  </div>
                </div>

                {/* Séparateur vertical de la maquette. */}
                <div aria-hidden className="w-px shrink-0" style={{ backgroundColor: C.cardBorder }} />

                <div className="flex shrink-0 items-center gap-2">
                  {/* Valeur — vraie valeur moteur, jamais un λ figé */}
                  {band ? (
                    <span
                      title={`Confiance ${band.label}`}
                      className={cn(
                        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums",
                        band.cls,
                      )}
                    >
                      {row.display}
                    </span>
                  ) : (
                    <span
                      className="inline-flex items-center rounded-full border border-[#e0e0e0] bg-[#f5f5f5] px-2 py-0.5 text-[11px] font-semibold tabular-nums"
                      style={{ color: C.team }}
                    >
                      {row.display}
                    </span>
                  )}
                  {/* Pavé cote — même style que les pavés 1N2 du calendrier. */}
                  {row.odds != null ? (
                    <div
                      className="flex min-w-[58px] flex-col items-center rounded-lg bg-[#f2f2f2] px-3 py-1.5 text-center transition-colors hover:bg-[#e8f5ef]"
                      title={row.oddsLabel ? `${row.oddsLabel} — cote réelle` : "Cote réelle"}
                    >
                      <span className="text-[9px] font-medium uppercase tracking-wide" style={{ color: C.time }}>
                        {row.oddsLabel ?? "Cote"}
                      </span>
                      <span className="font-mono text-[13px] font-bold tabular-nums" style={{ color: C.score }}>
                        {row.odds.toFixed(2)}
                      </span>
                    </div>
                  ) : (
                    <span className="min-w-[58px] px-3 text-center text-[12px]" style={{ color: C.time }}>—</span>
                  )}
                </div>
              </div>

              {/* Tags secondaires — sous le corps, comme les pills du calendrier. */}
              {(row.sourceLabel || row.note || row.overPick || row.serveEdge) && (
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  {row.sourceLabel && (
                    <span
                      title={row.sourceLabel === "cotes" ? "Valeur dérivée des cotes (pas de forme L5)" : "Valeur dérivée de la forme L5"}
                      className="inline-flex items-center rounded-full bg-[#f5f5f5] px-1.5 py-px text-[9px] font-medium"
                      style={{ color: C.time }}
                    >
                      {row.sourceLabel}
                    </span>
                  )}
                  {row.note && (
                    <span
                      className="inline-flex items-center rounded-full bg-[#f0f0f0] px-1.5 py-px text-[9px] font-medium"
                      style={{ color: C.time }}
                    >
                      {row.note}
                    </span>
                  )}
                  {row.overPick && (
                    <span
                      title="Over 21,5 jeux — probabilité Markov ≥ 60 %"
                      className="inline-flex items-center rounded-full bg-[#00985f]/10 px-1.5 py-px text-[9px] font-bold"
                      style={{ color: "#00985f" }}
                    >
                      {row.overPick}
                    </span>
                  )}
                  {row.serveEdge && (
                    <span
                      title="Meilleur serveur (hold %) et receveur (retour %)"
                      className="inline-flex items-center rounded-full bg-[#f0f0f0] px-1.5 py-px text-[9px] font-medium tabular-nums"
                      style={{ color: C.time }}
                    >
                      {row.serveEdge}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
