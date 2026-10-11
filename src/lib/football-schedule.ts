/**
 * Charge physique : nombre de jours entre matchs (J-days), dérivé des
 * kickoffs injectés par le payload.
 *
 * Répond à la limite L13 du audit : le prompt d'origine demandait une « charge
 * de matchs » non chiffrée, donc non vérifiable et comblée par le modèle.
 *
 * `Certainty` est déclaré ici en attendant `football-match-report-v2.ts`
 * (étape 5 de la roadmap), qui unifiera le type à un seul endroit.
 */

export type Certainty = "confirmé" | "probable" | "non_confirmé";

export type ScheduleContext = {
  /** Jours entiers écoulés depuis le dernier match (null si kickoff/prev illisible). */
  daysSinceLast: number | null;
  /** Jours entiers avant le prochain match (null si kickoff/next illisible). */
  nextInDays: number | null;
  certainty: Certainty;
};

const DAY_MS = 86_400_000;

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * @param kickoffIso kickoff du match analysé
 * @param previousKickoffIso dernier match terminé de l'équipe (null si inconnu)
 * @param nextKickoffIso prochain match de l'équipe (null si inconnu)
 */
export function scheduleContext(
  kickoffIso: string | null | undefined,
  previousKickoffIso: string | null | undefined,
  nextKickoffIso: string | null | undefined,
): ScheduleContext {
  const kickoff = ms(kickoffIso);
  if (kickoff == null) {
    return { daysSinceLast: null, nextInDays: null, certainty: "non_confirmé" };
  }

  const prev = ms(previousKickoffIso);
  const next = ms(nextKickoffIso);

  const daysSinceLast = prev != null ? Math.round((kickoff - prev) / DAY_MS) : null;
  const nextInDays = next != null ? Math.round((next - kickoff) / DAY_MS) : null;

  const certainty: Certainty =
    daysSinceLast != null && nextInDays != null
      ? "confirmé"
      : daysSinceLast != null || nextInDays != null
        ? "probable"
        : "non_confirmé";

  return { daysSinceLast, nextInDays, certainty };
}
