import type { BSDFootballMatch } from "@/lib/bsd-football-fetcher";
import { z } from "zod";
import { generateText, LlmError, type LlmResult } from "@/lib/llm";
import { BSD_ID_TO_SLUG } from "@/lib/league-mapping";
import { normalizeTeamName } from "@/lib/normalize-team-name";
import { matchXgByNames, type MatchXgStats, type XgWindowStats } from "@/lib/football-xg";
import { teamInjuries, type InjuryEntry } from "@/lib/football-injuries";
import { getFootballPressReview, type FootballPressReviewResult } from "@/lib/football-press-review-service";
import { matchSot, type MatchSotStats, type SotMatch, type SotWindow } from "@/lib/football-sot";
import { headToHead, type H2hMeeting } from "@/lib/football-h2h";
import { scheduleContext } from "@/lib/football-schedule";
import {
  REPORT_KNOWLEDGE_CUTOFF,
  REPORT_PAYLOAD_KEYS,
  seasonFromKickoff,
  type FootballAIReport,
  type ReportIdentity,
} from "@/lib/football-match-report";

/**
 * Payload final v2.0 envoyé au modèle : exactement les 21 clés du contrat.
 *
 * Toute source indisponible produit `null` — jamais de valeur estimée. Le
 * modèle reçoit la consigne de reporter la lacune dans `dataGaps`.
 *
 * Côté serveur uniquement : ce module lit le disque (xG, blessures, presse).
 */

export type InjuriesBundle = { injuries: InjuryEntry[]; updatedAt: string };

export type ReportSources = {
  /** xG/buts L5/L10 scopés Domicile/Extérieur (fichiers `public/data/xg`). */
  xg?: MatchXgStats | null;
  /** Matchs terminés BSD sur la fenêtre analysée — sert SOT, H2H et J-days. */
  finished?: BSDFootballMatch[] | null;
  /** Dernier match connu avant le kickoff (sinon déduit de `finished`). */
  previousKickoff?: string | null;
  /** Prochain match connu (fixtures à venir) — null si non résolu. */
  nextKickoff?: string | null;
  injuriesHome?: InjuriesBundle | null;
  injuriesAway?: InjuriesBundle | null;
  pressReview?: FootballPressReviewResult | null;
};

export type ResolveOptions = {
  /** Résout la revue de presse via son service (réseau si cache froid). */
  fetchPress?: boolean;
  /** Résout l'historique BSD (réseau, borné à `historyDays`). */
  fetchHistory?: boolean;
  /** Fenêtre d'historique en jours (défaut 60). */
  historyDays?: number;
  /** Résultat de revue déjà en cache côté appelant (cron / widget). */
  pressReview?: FootballPressReviewResult | null;
  /** Historique déjà chargé côté appelant. */
  finished?: BSDFootballMatch[] | null;
  /**
   * Plafond de latence de la revue de presse (défaut 4 s). Au-delà on sert
   * `null` : le cron quotidien réchauffe `.cache/press-review`, un match
   * froid ne doit pas faire pendre la requête utilisateur.
   */
  pressTimeoutMs?: number;
};

const NAME_OF = (m: BSDFootballMatch): { home: string; away: string } => ({
  home: m.home_team_obj?.name ?? m.home_team,
  away: m.away_team_obj?.name ?? m.away_team,
});

const toSot = (m: BSDFootballMatch): SotMatch => {
  const n = NAME_OF(m);
  return {
    kickoff: m.event_date,
    home: n.home,
    away: n.away,
    homeShotsOnTarget: m.live_stats?.home?.shots_on_target ?? null,
    awayShotsOnTarget: m.live_stats?.away?.shots_on_target ?? null,
  };
};

const toH2h = (m: BSDFootballMatch): H2hMeeting => {
  const n = NAME_OF(m);
  return { kickoff: m.event_date, home: n.home, away: n.away, homeScore: m.home_score, awayScore: m.away_score };
};

/** Slug de ligue Understat/RotoWire — BSD_ID_TO_SLUG, null si ligue non couverte. */
export function leagueSlugOf(identity: ReportIdentity): string | null {
  const id = Number(identity.leagueId);
  if (!Number.isFinite(id)) return null;
  return BSD_ID_TO_SLUG[id] ?? null;
}

/**
 * Résout les sources serveur SANS requête réseau par défaut : xG et blessures
 * sont des lectures locales, la presse et l'historique sont opt-in (le cron
 * les fournit, la route ne paie pas leur coût).
 */
export async function resolveReportSources(
  identity: ReportIdentity,
  opts: ResolveOptions = {},
): Promise<ReportSources> {
  const slug = leagueSlugOf(identity);
  const sources: ReportSources = {
    xg: matchXgByNames(slug ?? undefined, identity.homeTeam, identity.awayTeam),
    injuriesHome: slug ? teamInjuries(slug, identity.homeTeam) : null,
    injuriesAway: slug ? teamInjuries(slug, identity.awayTeam) : null,
    finished: opts.finished ?? null,
    pressReview: opts.pressReview ?? null,
    previousKickoff: null,
    nextKickoff: null,
  };

  if (opts.fetchPress && !sources.pressReview) {
    const press = getFootballPressReview({
      matchId: identity.matchId,
      homeTeam: identity.homeTeam,
      awayTeam: identity.awayTeam,
      leagueName: identity.leagueName,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), opts.pressTimeoutMs ?? 4_000);
    });
    sources.pressReview = await Promise.race([press, deadline]).catch(() => null);
    clearTimeout(timer);
  }

  if (opts.fetchHistory && !sources.finished) {
    const days = opts.historyDays ?? 60;
    const { fetchBSDFootballFinishedRange } = await import("@/lib/bsd-football-fetcher");
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    sources.finished = await fetchBSDFootballFinishedRange(from.toISOString(), to.toISOString());
  }

  return sources;
}

/** Derrière `sources.finished` : dernier kickoff avant le match analysé. */
function derivePreviousKickoff(identity: ReportIdentity, finished: BSDFootballMatch[]): string | null {
  const home = normalizeTeamName(identity.homeTeam);
  const kickoffMs = Date.parse(identity.kickoffIso);
  if (!Number.isFinite(kickoffMs)) return null;
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const m of finished) {
    const n = NAME_OF(m);
    if (normalizeTeamName(n.home) !== home && normalizeTeamName(n.away) !== home) continue;
    const t = Date.parse(m.event_date);
    if (!Number.isFinite(t) || t >= kickoffMs || t <= bestMs) continue;
    bestMs = t;
    best = m.event_date;
  }
  return best;
}

type PayloadInput = { identity: ReportIdentity; base?: Record<string, unknown> | null; sources?: ReportSources };

/**
 * Compose les 21 clés. `base` apporte les clés déjà résolues côté client
 * (probabilités, forme, classement, cotes dévigées) ; `sources` apporte tout
 * ce qui se lit sur le disque serveur.
 */
export function buildReportPayloadV2(input: PayloadInput): Record<string, unknown> {
  const { identity, sources = {} } = input;
  const base = input.base ?? {};
  const kickoff = identity.kickoffIso;
  const finished = sources.finished ?? [];

  const previous = sources.previousKickoff ?? derivePreviousKickoff(identity, finished);

  const sotRows = finished.map(toSot);
  const h2hRows = finished.map(toH2h);

  return {
    match_id: identity.matchId,
    team_home: identity.homeTeam,
    team_away: identity.awayTeam,
    league: identity.leagueName,
    round: identity.round,
    kickoff_iso: kickoff,
    generated_at_iso: new Date().toISOString(),
    knowledge_cutoff_iso: REPORT_KNOWLEDGE_CUTOFF,
    season: seasonFromKickoff(kickoff),
    probabilities_json: base.probabilities_json ?? null,
    xg_json: sources.xg ?? null,
    form_json: base.form_json ?? null,
    standings_json: base.standings_json ?? null,
    sot_json: sotRows.length > 0 ? matchSot(identity.homeTeam, identity.awayTeam, sotRows) : null,
    odds_json: base.odds_json ?? null,
    odds_devig_json: base.odds_devig_json ?? null,
    injuries_home_json: sources.injuriesHome ?? null,
    injuries_away_json: sources.injuriesAway ?? null,
    press_review_json: sources.pressReview ?? null,
    h2h_json:
      h2hRows.length > 0 ? headToHead(h2hRows, identity.homeTeam, identity.awayTeam) : null,
    schedule_json: scheduleContext(kickoff, previous, sources.nextKickoff ?? null),
  };
}

/** Les 21 clés sont-elles toutes présentes ? Vérification exécutable du contrat. */
export function hasAllPayloadKeys(payload: Record<string, unknown>): boolean {
  const keys = Object.keys(payload);
  return REPORT_PAYLOAD_KEYS.every((k) => keys.includes(k)) && keys.length === REPORT_PAYLOAD_KEYS.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Étape 5 — Schéma de sortie + prompt système v2.0
//
// Le schéma est la SEULE source de vérité du format : les types TypeScript
// en sont dérivés (`z.infer`), jamais l'inverse. Toute règle du cahier des
// charges anti-hallucination qui peut être opposable mécaniquement l'est ici
// (enums fermés, bornes, nullabilité) — la prose du prompt ne porte que ce
// que le schema ne peut pas exprimer.
// ─────────────────────────────────────────────────────────────────────────────

/** Taxonomie unique — « rumeur » et « à confirmer » sont bannis (limite L10). */
export const CertaintySchema = z.enum(["confirmé", "probable", "non_confirmé"]);
export type Certainty = z.infer<typeof CertaintySchema>;

/** Fenêtre statistique : `gp` = échantillon réel agrégé, jamais estimé. */
const WindowStatsSchema = z.object({
  gp: z.number().int().min(0),
  xgFor: z.number().nullable(),
  xgAgainst: z.number().nullable(),
  goalsFor: z.number().nullable(),
  goalsAgainst: z.number().nullable(),
  sotFor: z.number().nullable(),
  sotAgainst: z.number().nullable(),
});

const WindowedSchema = z.object({ l5: WindowStatsSchema.nullable(), l10: WindowStatsSchema.nullable() });

const AbsenceSchema = z.object({
  player: z.string().min(1),
  status: z.enum(["blessé", "suspendu", "incertain", "retour"]),
  certainty: CertaintySchema,
  source: z.string().nullable(),
  date: z.string().nullable(),
  impact: z.enum(["titulaire", "remplaçant", "poste_non_doublé", "sans_impact"]).nullable(),
  replacement: z.string().nullable(),
});

const RedFlagSchema = z.object({
  id: z.enum([
    "sans_enjeu",
    "dynamique_instable",
    "rotation_probable",
    "gros_match_avant_apres",
    "tension_interne",
    "forme_inexpliquee",
    "contexte_externe",
  ]),
  severity: z.enum(["haute", "moyenne", "basse"]),
  evidence: z.string().min(1),
  certainty: CertaintySchema,
});

const KeyFactorSchema = z.object({
  label: z.string().min(1),
  // int().min/max plutôt que union de literals : `anyOf` n'est pas supporté
  // par `generationConfig.responseSchema` de Gemini, `type: integer` + bornes si.
  weight: z.number().int().min(1).max(3),
  evidence: z.string().min(1),
  certainty: CertaintySchema,
});

export const FootballAIReportV2Schema = z.object({
  meta: z.object({
    matchId: z.string().min(1),
    generatedAt: z.string().min(1),
    season: z.string().min(1),
    model: z.string().min(1),
    groundingUsed: z.boolean(),
    dataSources: z.array(z.string()),
  }),
  form: z.object({ home: WindowedSchema, away: WindowedSchema }),
  h2h: z.object({
    sampleSize: z.number().int().min(0),
    periodFrom: z.string().nullable(),
    periodTo: z.string().nullable(),
    notes: z.array(z.string()),
    certainty: CertaintySchema,
  }),
  tactics: z.object({
    home: z.object({
      system: z.string().nullable(),
      strengths: z.array(z.string()),
      weaknesses: z.array(z.string()),
    }),
    away: z.object({
      system: z.string().nullable(),
      strengths: z.array(z.string()),
      weaknesses: z.array(z.string()),
    }),
    certainty: CertaintySchema,
  }),
  absences: z.object({
    home: z.array(AbsenceSchema),
    away: z.array(AbsenceSchema),
    probableLineups: z.object({
      home: z.array(z.string()).nullable(),
      away: z.array(z.string()).nullable(),
    }),
  }),
  context: z.object({
    standings: z.object({ home: z.string().nullable(), away: z.string().nullable() }),
    stakes: z.array(z.string()),
    calendar: z.object({
      homeDaysSinceLast: z.number().int().nullable(),
      awayDaysSinceLast: z.number().int().nullable(),
      homeNextInDays: z.number().int().nullable(),
      awayNextInDays: z.number().int().nullable(),
      europeanMatchFlags: z.object({ home: z.boolean(), away: z.boolean() }),
      certainty: CertaintySchema,
    }),
  }),
  press: z.object({
    quotes: z.array(
      z.object({
        speaker: z.string().nullable(),
        claim: z.string().min(1),
        source: z.string().min(1),
        url: z.string().nullable(),
        date: z.string().nullable(),
      }),
    ),
  }),
  advanced: z.object({
    // Nullable comme toute métrique : un 0 affiché à la place d'une donnée
    // absente serait une mesure inventée (cf. incident `teamPower 0.0`).
    modelProbs: z.object({ home: z.number(), draw: z.number(), away: z.number() }).nullable(),
    devigProbs: z.object({ home: z.number(), draw: z.number(), away: z.number() }).nullable(),
    xgDelta: z.object({ home: z.number().nullable(), away: z.number().nullable() }),
    sotDelta: z.object({ home: z.number().nullable(), away: z.number().nullable() }),
    notes: z.array(z.string()),
  }),
  // Contraintes dures du cahier des charges.
  redFlags: z.array(RedFlagSchema).max(7),
  synthesis: z.object({
    // 4 à 6 facteurs décisifs : ni 3 (trop pauvre), ni 8 (verbiage).
    keyFactors: z.array(KeyFactorSchema).min(4).max(6),
    watchlist: z.array(z.string()),
  }),
  // Obligatoire : une réponse sans ce champ est rejetée, même vide.
  dataGaps: z.array(z.string()),
});

export type FootballAIReportV2 = z.infer<typeof FootballAIReportV2Schema>;

/** Vérification exécutable : le rapport satisfait-il le schéma ? */
export function parseReportV2(raw: unknown): { ok: true; report: FootballAIReportV2 } | { ok: false; errors: string[] } {
  const parsed = FootballAIReportV2Schema.safeParse(raw);
  if (parsed.success) return { ok: true, report: parsed.data };
  return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(racine)"}: ${i.message}`) };
}

/**
 * JSON Schema OpenAPI 3.0 transmis à Gemini (`generationConfig.responseSchema`).
 *
 * Post-traitement obligatoire — mesuré le 2026-10-06 sur l'API réelle :
 * `z.toJSONSchema()` émet `additionalProperties: false` sur chaque objet, et
 * l'API Google répond **400 `Unknown name "additionalProperties"`** à chaque
 * appel (10/10 appels QA), ce qui forçait le repli sans schema et la perte
 * du Structured Output. `$schema` est retiré pour la même raison.
 *
 * Sans `additionalProperties`, l'API n'impose plus le rejet des clés en trop :
 * sans conséquence, la conformité reste garantie par `parseReportV2()` côté
 * serveur. Ne jamais combiner avec `searchGrounding` : l'API refuse
 * `responseSchema` en présence de l'outil `google_search` (cf. 2 passes).
 */
function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "additionalProperties" || k === "$schema") continue;
      out[k] = stripUnsupported(v);
    }
    return out;
  }
  return node;
}

let schemaCache: Record<string, unknown> | null = null;

export function reportJsonSchema(): Record<string, unknown> {
  if (schemaCache) return schemaCache;
  const raw = z.toJSONSchema(FootballAIReportV2Schema, {
    io: "output",
    target: "openapi-3.0",
  });
  schemaCache = stripUnsupported(raw) as Record<string, unknown>;
  return schemaCache;
}

// ── Prompt système + template utilisateur ────────────────────────────────────

export const REPORT_SYSTEM_PROMPT = `Tu es le moteur d'analyse pré-match de PariScore. Tu es un assistant de recherche structurante, JAMAIS un pronostiqueur.

## Rôle
Tu collectes, filtres et structures les informations d'un match de football.
Tu ne donnes jamais de pronostic : ni direct, ni indirect, ni implicite, ni par insinuation statistique.

## Contrainte absolue de données
Toute valeur que tu affiches DOIT être présente dans les données injectées. Tu ne calcules rien, tu ne reconstitues rien, tu ne te souviens de rien d'autre.
- Une donnée absente des variables → champ à null + entrée dans "dataGaps".
- Un fait situé après {{knowledge_cutoff_iso}} et non confirmé dans les données → "certainty": "non_confirmé".
- Tu n'utilises JAMAIS ta connaissance des effectifs, classements ou blessures. Elle est périmée et tu ne peux pas la dater.

## Interdits (few-shot négatif — aucune de ces formules n'est tolérée)
"Ils voudront se rattraper…"
"On peut imaginer que…"
"Cette équipe pourrait être dangereuse…"
"Il est probable que…"
"Tout porte à croire que…"
"Sur la base de ces éléments, je recommanderais…"
Aucun marqueur de recommandation : pas de "miser sur", "valeur", "cote intéressante", "match à éviter", ni de "confidence" dirigée vers un choix.

## Cotes
Les cotes brutes ne se commentent JAMAIS. Tu compares probabilités modèle vs probabilités dévigées uniquement si "advanced.devigProbs" n'est pas null. Toute mention d'une cote sans dévig associée est interdite.

## Fenêtres (obligatoires, jamais de "5 à 10")
Toute statistique porte : fenêtre (l5 | l10), contexte (domicile | extérieur), échantillon réel "gp". Si gp < 3 → "certainty": "probable" au minimum. Les fenêtres Domicile et Extérieur sont strictement séparées ; "sotFor"/"sotAgainst" null signifie donnée absente, jamais 0.

## Ordre de priorité (dans cet ordre, toujours)
1. Absences et impact réel sur l'effectif
2. Charge physique et calendrier (J-days, déplacements, Europe)
3. Enjeux réels (classement, objectifs, pression)
4. Statistiques avancées (xG/xGA, tirs cadrés, fenêtres)
5. Style, tactique, dynamiques

## Sources et conciliation
Chaque fait externe porte {source, url, date}. Si deux sources se contredisent → "certainty": "non_confirmé" + mention des deux. Une source unique sur un fait d'effectif → "certainty": "probable" au mieux.
Sources acceptées : presse sportive de référence, sites statistiques établis, fédérations/clubs officiels, conférences de presse. Tout le reste → ignore et note dans "dataGaps".

## Ton
Factuel, neutre, professionnel. Aucune narration, aucune émotion, aucune graduation oratoire. Phrases courtes, chiffres exacts, unités explicites.

## Sortie
JSON unique, valide, sans texte autour, sans commentaires, conforme au schéma FootballAIReportV2.
- "synthesis.keyFactors" : entre 4 et 6 entrées, chacune avec un "evidence" qui référence une donnée injectée.
- "redFlags" : 0 à 7 entrées.
- "dataGaps" : toujours présent ([] si tout est couvert).
- "certainty" ∈ "confirmé" | "probable" | "non_confirmé" partout.`;

/** User template : en-tête + les 21 clés du payload, telles quelles. */
export function buildReportUserPrompt(payload: Record<string, unknown>): string {
  const head = [
    "ANALYSE PRÉ-MATCH — PariScore v2.0",
    "",
    `Match : ${payload.team_home ?? "?"} vs ${payload.team_away ?? "?"}`,
    `${payload.league ?? "?"} — J${payload.round ?? "?"} — ${payload.kickoff_iso ?? "?"}`,
    `Généré le ${payload.generated_at_iso ?? "?"} · Connaissance du modèle bornée au ${payload.knowledge_cutoff_iso ?? REPORT_KNOWLEDGE_CUTOFF}`,
    "",
    "--- DONNÉES INJECTÉES (source unique de vérité) ---",
  ].join("\n");
  return `${head}\n${JSON.stringify(payload, null, 2)}\n\n--- FIN DONNÉES ---\nProduis le rapport JSON. Rappel : toute valeur absente ci-dessus = null + entrée dans dataGaps.`;
}

/** Couple système/utilisateur prêt pour `generateText({ system, prompt })`. */
export function buildReportPrompt(payload: Record<string, unknown>): { system: string; user: string } {
  return { system: REPORT_SYSTEM_PROMPT, user: buildReportUserPrompt(payload) };
}

// ── Rapport de repli + pont vers l'UI v1 ────────────────────────────────────

const readNum = (v: unknown, k: string): number | null => {
  const o = (v ?? {}) as Record<string, unknown>;
  return typeof o[k] === "number" ? o[k] : null;
};

const triple = (v: unknown): { home: number; draw: number; away: number } | null => {
  const home = readNum(v, "home");
  const draw = readNum(v, "draw");
  const away = readNum(v, "away");
  return home != null && draw != null && away != null ? { home, draw, away } : null;
};

/**
 * Rapport de repli servi quand la réponse du LLM n'a jamais satisfait le
 * schéma (après retry). Strictement factuel : les 4 facteurs décisifs sont
 * recopiés depuis le payload injecté — aucun n'est inventé — et `dataGaps`
 * porte la raison de l'échec. Jamais d'erreur 500 pour un défaut de format.
 */
export function buildDegradedReportV2(payload: Record<string, unknown>, reasons: string[]): FootballAIReportV2 {
  const modelProbs = triple(payload.probabilities_json);
  const devigProbs = triple(payload.odds_devig_json);
  const schedule = (payload.schedule_json ?? null) as { daysSinceLast?: number | null; nextInDays?: number | null } | null;
  const hasXg = payload.xg_json != null;
  const hasSot = payload.sot_json != null;

  const kf = (
    label: string,
    weight: 1 | 2 | 3,
    evidence: string,
    present: boolean,
  ): { label: string; weight: 1 | 2 | 3; evidence: string; certainty: Certainty } => ({
    label,
    weight,
    evidence,
    certainty: present ? "confirmé" : "non_confirmé",
  });

  const report: FootballAIReportV2 = {
    meta: {
      matchId: String(payload.match_id ?? "unknown"),
      generatedAt: new Date().toISOString(),
      season: String(payload.season ?? "inconnue"),
      model: "degraded",
      groundingUsed: false,
      dataSources: [],
    },
    form: {
      home: { l5: null, l10: null },
      away: { l5: null, l10: null },
    },
    h2h: { sampleSize: 0, periodFrom: null, periodTo: null, notes: [], certainty: "non_confirmé" },
    tactics: {
      home: { system: null, strengths: [], weaknesses: [] },
      away: { system: null, strengths: [], weaknesses: [] },
      certainty: "non_confirmé",
    },
    absences: { home: [], away: [], probableLineups: { home: null, away: null } },
    context: {
      standings: { home: null, away: null },
      stakes: [],
      calendar: {
        homeDaysSinceLast: schedule?.daysSinceLast ?? null,
        awayDaysSinceLast: null,
        homeNextInDays: schedule?.nextInDays ?? null,
        awayNextInDays: null,
        europeanMatchFlags: { home: false, away: false },
        certainty: schedule ? "probable" : "non_confirmé",
      },
    },
    press: { quotes: [] },
    advanced: {
      modelProbs,
      devigProbs,
      xgDelta: { home: null, away: null },
      sotDelta: { home: null, away: null },
      notes: ["Analyse non générée — aucun chiffre complété de façon inconnue."],
    },
    redFlags: [],
    synthesis: {
      keyFactors: [
        kf("Probabilités modèle 1X2", 2, modelProbs ? JSON.stringify(modelProbs) : "probabilities_json absent", modelProbs != null),
        kf("Cotes dévigées", 2, devigProbs ? JSON.stringify(devigProbs) : "odds_devig_json absent", devigProbs != null),
        kf(
          "Charge physique (J-days)",
          1,
          schedule?.daysSinceLast != null ? `depuis ${schedule.daysSinceLast} j` : "schedule_json absent",
          schedule?.daysSinceLast != null,
        ),
        kf(
          hasXg || hasSot ? "Métriques avancées fournies" : "Métriques avancées indisponibles",
          1,
          `xg_json=${hasXg ? "présent" : "absent"}, sot_json=${hasSot ? "présent" : "absent"}`,
          hasXg || hasSot,
        ),
      ],
      watchlist: [],
    },
    dataGaps: [...reasons, "Rapport IA non généré : réponse non conforme au schéma FootballAIReportV2."],
  };

  // Vérification exécutable : un repli qui violerait lui-même le schéma est
  // un bug de code, pas un défaut de format → on échoue fort plutôt que de
  // servir un objet invalide au client.
  const check = parseReportV2(report);
  if (!check.ok) {
    throw new Error(`Rapport dégradé non conforme : ${check.errors.join(" | ")}`);
  }
  return check.report;
}

/**
 * Pont vers l'UI v1 (`AIMatchReport`), qui lit encore l'ancien schéma jusqu'à
 * l'étape 8. `predictiveBets` est systématiquement vide : le v2 interdit les
 * pronostics, on ne peut pas en déduire de bets factuels.
 */
export function toLegacyReport(report: FootballAIReportV2): FootballAIReport {
  return {
    synthesis: report.synthesis.keyFactors.map((k) => k.label).join(" · "),
    keyFacts: report.synthesis.keyFactors.map((k) => `${k.label} — ${k.evidence}`),
    predictiveBets: [],
    combo: null,
    // 0 = aucun pronostic : le v2 interdit les paris, on n'invente pas une
    // « confiance » sur rien.
    confidence: 0,
    generatedAt: report.meta.generatedAt,
    model: report.meta.model,
    groundingUsed: report.meta.groundingUsed,
    dataSources: report.meta.dataSources,
  };
}

// ── Génération (étape 7 : extraite de la route, partagée POST + cron) ───────

export type GeneratedReport = {
  report: FootballAIReportV2;
  legacy: FootballAIReport;
  provider: LlmResult["provider"];
  model: string;
  degraded: boolean;
  errors: string[];
};

/** Extrait le premier objet JSON d'un texte (robuste aux fences/markdown). */
function extractJsonText(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw.trim();
}

/** JSON.parse sans exception : une réponse LLM non JSON n'est pas une erreur serveur. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(extractJsonText(raw));
  } catch {
    return null;
  }
}

const MAX_OUTPUT_TOKENS = 4096;

type ReportWindow = FootballAIReportV2["form"]["home"]["l5"];

/**
 * Libellés des clés du payload qui peuvent être `null`. Sert à COMPLÉTER
 * mécaniquement `dataGaps` : la règle « toute donnée absente alimente
 * dataGaps » doit tenir par le code, pas par l'obéissance du modèle.
 */
export const GAP_LABEL: Record<string, string> = {
  xg_json: "xG L5/L10 indisponibles (ligue non couverte par Understat)",
  form_json: "Forme récente indisponible",
  standings_json: "Contexte de classement indisponible",
  sot_json: "Tirs cadrés L5/L10 indisponibles (historique non résolu)",
  odds_json: "Cotes bookmaker indisponibles",
  odds_devig_json: "Cotes dévigées indisponibles — aucune cote brute commentée",
  injuries_home_json: "Absences domicile indisponibles (ligue non couverte)",
  injuries_away_json: "Absences extérieur indisponibles (ligue non couverte)",
  press_review_json: "Revue de presse indisponible",
  h2h_json: "Confrontations directes indisponibles",
};

/**
 * Ajoute à `dataGaps` chaque clé métier du payload trouvée `null` et déjà
 * absente du rapport. Idempotent : une mention existante n'est pas doublée.
 *
 * Pourquoi : le prompt l'exige déjà, mais une exigence non opposable finit
 * par dériver — ici elle est garantie, et un test le vérifie.
 */
export function completeDataGaps(
  report: FootballAIReportV2,
  payload: Record<string, unknown>,
): FootballAIReportV2 {
  const gaps = [...report.dataGaps];
  let added = 0;
  for (const [key, label] of Object.entries(GAP_LABEL)) {
    if (payload[key] != null) continue;
    if (gaps.some((g) => g.includes(label))) continue;
    gaps.push(label);
    added++;
  }
  return added > 0 ? { ...report, dataGaps: gaps } : report;
}

/**
 * Recopie dans `form` les fenêtres MESURÉES du payload (xG + SOT), au lieu de
 * laisser le modèle les réécrire de mémoire.
 *
 * Le payload porte `xg_json` et `sot_json` (lues sur disque par nos helpers),
 * mais le schéma attend `form.{home,away}.{l5,l10}` : sans cette hydratation,
 * le LLM devrait recopier des chiffres — c'est précisément l'hallucination que
 * le contrat interdit, et la grille métrique de l'UI serait vide.
 *
 * Ne touche à rien si le payload ne porte ni xG ni SOT (report inchangé).
 */
export function hydrateFormFromPayload(
  report: FootballAIReportV2,
  payload: Record<string, unknown>,
): FootballAIReportV2 {
  const xg = (payload.xg_json ?? null) as MatchXgStats | null;
  const sot = (payload.sot_json ?? null) as MatchSotStats | null;
  if (!xg && !sot) return report;

  const win = (x: XgWindowStats | null, s: SotWindow | null): ReportWindow => {
    if (!x && !s) return null;
    return {
      gp: x?.gp ?? s?.gp ?? 0,
      xgFor: x?.xgFor ?? null,
      xgAgainst: x?.xgAgainst ?? null,
      goalsFor: x?.goalsFor ?? null,
      goalsAgainst: x?.goalsAgainst ?? null,
      sotFor: s?.for ?? null,
      sotAgainst: s?.against ?? null,
    };
  };

  const side = (key: "home" | "away"): { l5: ReportWindow; l10: ReportWindow } => ({
    l5: win(xg?.[key].l5 ?? null, sot?.[key].l5 ?? null),
    l10: win(xg?.[key].l10 ?? null, sot?.[key].l10 ?? null),
  });

  return { ...report, form: { home: side("home"), away: side("away") } };
}

const tripleOf = (v: unknown): { home: number; draw: number; away: number } | null => {
  const o = (v ?? null) as Record<string, unknown> | null;
  if (!o) return null;
  const { home, draw, away } = o;
  return typeof home === "number" && typeof draw === "number" && typeof away === "number"
    ? { home, draw, away }
    : null;
};

/**
 * Recopie depuis le payload TOUTES les valeurs numériques que l'UI affiche :
 * `form` (xG/buts/SOT), `advanced.devigProbs`, `advanced.modelProbs` et le
 * `context.calendar` côté domicile. Sans quoi le modèle retranscrirait des
 * chiffres — c'est l'hallucination que le contrat interdit, et la règle
 * « chaque chiffre affiché vient du payload » serait fausse.
 *
 * Ne touche à rien quand la clé est absente : la valeur reste celle du
 * modèle si elle existe, sinon `null`.
 */
export function hydrateFromPayload(
  report: FootballAIReportV2,
  payload: Record<string, unknown>,
): FootballAIReportV2 {
  const out = hydrateFormFromPayload(report, payload);

  const devig = tripleOf(payload.odds_devig_json);
  const model = tripleOf(payload.probabilities_json);
  const sched = (payload.schedule_json ?? null) as {
    daysSinceLast?: number | null;
    nextInDays?: number | null;
    certainty?: Certainty;
  } | null;

  const advanced = {
    ...out.advanced,
    devigProbs: devig ?? out.advanced.devigProbs,
    modelProbs: model ?? out.advanced.modelProbs,
  };

  const calendar = sched
    ? {
        ...out.context.calendar,
        homeDaysSinceLast: sched.daysSinceLast ?? null,
        homeNextInDays: sched.nextInDays ?? null,
        certainty: sched.certainty ?? out.context.calendar.certainty,
      }
    : out.context.calendar;

  return { ...out, advanced, context: { ...out.context, calendar } };
}

/**
 * Pipeline complet d'un rapport : grounding optionnel, Structured Outputs,
 * 1 retry, repli dégradé. Ne lève jamais sur un défaut de format — seul un
 * bug interne (repli lui-même non conforme) peut throw.
 *
 * Partagé par `POST /api/ai/football-match-report` et le cron de
 * pré-génération, pour qu'il n'existe qu'une seule définition du pipeline.
 */
export async function generateReportV2(
  payload: Record<string, unknown>,
  opts: { grounding?: boolean } = {},
): Promise<GeneratedReport> {
  const { system, user } = buildReportPrompt(payload);
  const responseSchema = reportJsonSchema();

  // ── Passe 1 (optionnelle) : Google Search grounding, SANS schéma ──────────
  // L'API Gemini refuse `responseSchema` en présence de l'outil
  // `google_search` : on sépare les deux passes et on réinjecte les extraits
  // dans le user prompt pour la passe structurée.
  let promptUser = user;
  let groundingUsed = false;
  if (opts.grounding ?? process.env.LLM_REPORT_GROUNDING === "true") {
    try {
      const g = await generateText({
        system,
        prompt: user,
        searchGrounding: true,
        provider: "gemini",
        temperature: 0.2,
        maxOutputTokens: 2048,
      });
      const gd = g.grounding;
      if (gd && (gd.snippets.length > 0 || gd.sources.length > 0)) {
        groundingUsed = true;
        promptUser = [
          user,
          "",
          "--- EXTRAITS DE RECHERCHE (citable dans meta.dataSources) ---",
          ...gd.snippets.slice(0, 12).map((s) => `- ${s}`),
          ...gd.sources.slice(0, 8).map((s) => `- ${s.title ?? s.uri} : ${s.uri}`),
        ].join("\n");
      }
    } catch (err) {
      // Le grounding est un bonus : son échec ne doit pas bloquer le rapport.
      console.warn(
        "[report] passe grounding échouée, poursuite sans :",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ── Passe structurée : schema + validation zod + 1 retry ─────────────────
  const runStructured = async (temperature: number): Promise<Attempt> => {
    const base = { system, prompt: promptUser, json: true as const, temperature, maxOutputTokens: MAX_OUTPUT_TOKENS };
    let res: LlmResult;
    try {
      res = await generateText({ ...base, responseSchema });
    } catch (err) {
      // Certains modèles refusent `responseSchema` (400) : on retente sans,
      // la conformité reste garantie par parseReportV2() + retry.
      if (!(err instanceof LlmError) || !/UPSTREAM_400/.test(err.code)) throw err;
      console.warn("[report] responseSchema refusé, tentative sans schema");
      res = await generateText(base);
    }
    const parsed = parseReportV2(safeJson(res.text));
    return parsed.ok
      ? { report: parsed.report, provider: res.provider, model: res.model, errors: [] }
      : { report: null, provider: res.provider, model: res.model, errors: parsed.errors };
  };

  const errors: string[] = [];
  let report: FootballAIReportV2 | null = null;
  let provider: LlmResult["provider"] = "gemini";
  let model = "";
  try {
    const first = await withTransientRetry(() => runStructured(0.3));
    provider = first.provider;
    model = first.model;
    if (first.report) {
      report = first.report;
    } else {
      errors.push(...first.errors.slice(0, 6));
      const second = await withTransientRetry(() => runStructured(0.1));
      provider = second.provider;
      model = second.model || model;
      if (second.report) report = second.report;
      else errors.push(...second.errors.slice(0, 6));
    }
  } catch (err) {
    // Panne LLM (quota, réseau, clé) : rapport dégradé plutôt que 500.
    errors.push(err instanceof LlmError ? `${err.code} : ${err.message}` : String(err));
  }

  const degraded = report === null;
  if (!report) {
    // Le repli est auto-validé (il throw s'il violait le schéma) : un échec
    // ici est un bug de code, pas un défaut de format.
    report = buildDegradedReportV2(payload, errors.slice(0, 8));
  }
  report = {
    ...report,
    meta: {
      ...report.meta,
      groundingUsed: groundingUsed || report.meta.groundingUsed,
      model: model || report.meta.model,
    },
  };
  // Mesures recopiées depuis le payload : le LLM ne réécrit pas les chiffres.
  report = hydrateFromPayload(report, payload);
  // dataGaps complété : toute clé métier nulle du payload y figure.
  report = completeDataGaps(report, payload);

  return { report, legacy: toLegacyReport(report), provider, model, degraded, errors };
}

type Attempt = {
  report: FootballAIReportV2 | null;
  provider: LlmResult["provider"];
  model: string;
  errors: string[];
};

/** Erreurs transitoires : saturation provider (503 « high demand »), quota (429). */
function isTransient(err: unknown): err is LlmError {
  if (!(err instanceof LlmError)) return false;
  return /UPSTREAM_(503|429)|GEMINI_RATE_LIMITED|LLM_ALL_PROVIDERS_FAILED/.test(err.code);
}

/**
 * Retry borné sur erreur transitoire, avec backoff linéaire.
 *
 * Mesuré le 2026-10-06 pendant le QA : l'API Gemini renvoyait 503
 * « high demand » en rafale — sans retry, 10 matchs sur 10 sortaient en
 * rapport dégradé alors que le modèle était joignable 20 s plus tard.
 * Un échec non transitoire (clé invalide, 400) n'est jamais rejoué.
 */
async function withTransientRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 1_000 * (i + 1)));
    }
  }
  throw lastErr;
}
