import { describe, expect, test } from "bun:test";
import type { FootballMatch } from "@/lib/football-data";
import type { BSDFootballMatch } from "@/lib/bsd-football-fetcher";
import {
  REPORT_PAYLOAD_KEYS,
  buildReportPayload,
  identityFromPayload,
  seasonFromKickoff,
} from "@/lib/football-match-report";
import {
  buildDegradedReportV2,
  buildReportPayloadV2,
  buildReportPrompt,
  completeDataGaps,
  GAP_LABEL,
  hasAllPayloadKeys,
  hydrateFormFromPayload,
  hydrateFromPayload,
  parseReportV2,
  REPORT_SYSTEM_PROMPT,
  reportJsonSchema,
  toLegacyReport,
  type ReportSources,
} from "@/lib/football-match-report-v2";

const PSG = "Paris Saint-Germain";
const OM = "Olympique de Marseille";
const MAX_BYTES = 10_000;

const match: FootballMatch = {
  id: "bsd-1",
  league: { id: "8", name: "Ligue 1", country: "France", countryCode: "FR", logo: "", tier: "T1" },
  round: "J10",
  scheduledAt: "2026-10-10T19:00:00Z",
  home: { id: "1", name: PSG, shortName: "PSG", logo: "", color: "#004170", form: ["W", "W", "D"], rank: 2 },
  away: { id: "2", name: OM, shortName: "OM", logo: "", color: "#2faee0", form: ["L", "W", "D"], rank: 6 },
  prediction: {
    homeProb: 58,
    drawProb: 24,
    awayProb: 18,
    bttsProb: 61,
    over25Prob: 66,
    model: "test",
  },
  odds: { bookmaker: "test", home: 1.5, draw: 4.0, away: 6.0 },
};

const finished: BSDFootballMatch[] = [
  {
    id: 1,
    league: { id: 8, name: "Ligue 1", country: "France" },
    home_team: PSG,
    away_team: OM,
    event_date: "2026-09-20T19:00:00Z",
    status: "finished",
    home_score: 3,
    away_score: 1,
    odds_home: 1.5,
    odds_draw: 4,
    odds_away: 6,
    live_stats: { home: { shots_on_target: 7 }, away: { shots_on_target: 2 } },
  },
  {
    id: 2,
    league: { id: 8, name: "Ligue 1", country: "France" },
    home_team: OM,
    away_team: PSG,
    event_date: "2026-09-01T19:00:00Z",
    status: "finished",
    home_score: 0,
    away_score: 2,
    odds_home: 3.2,
    odds_draw: 3.4,
    odds_away: 2.2,
    live_stats: { home: { shots_on_target: 3 }, away: { shots_on_target: 5 } },
  },
];

const FULL_SOURCES: ReportSources = {
  xg: {
    home: { l5: { gp: 5, xgFor: 1.8, xgAgainst: 0.9, goalsFor: 2.1, goalsAgainst: 1 }, l10: null },
    away: { l5: { gp: 5, xgFor: 1.2, xgAgainst: 1.4, goalsFor: 1.4, goalsAgainst: 1.6 }, l10: null },
  },
  finished,
  nextKickoff: "2026-10-18T19:00:00Z",
  injuriesHome: { injuries: [{ player: "Saliba", position: "DEF", injury: "Suspension", status: null, returnDate: null }], updatedAt: "2026-10-05" },
  injuriesAway: null,
  pressReview: {
    status: "available",
    sources: [
      {
        name: "Forebet",
        domain: "forebet.com",
        icon: "📊",
        url: "https://forebet.test",
        expertSummary: "Le PSG domine à domicile sur les 5 dernières journées.",
        prediction: { text: "Victoire du PSG", type: "1X2", confidence: 3 },
      },
    ],
    consensus: { homeWinPct: 60, drawPct: 25, awayWinPct: 15, over25Pct: 55, bttsYesPct: 58, totalSources: 1, dominant: "home" },
    teams: { home: PSG, away: OM },
    fetchedAt: "2026-10-06T07:00:00Z",
  },
};

describe("football-match-report — payload client (étape 4)", () => {
  test("buildReportPayload porte l'identité attendue par la route", () => {
    const base = buildReportPayload(match);
    const id = identityFromPayload(base);
    expect(id).not.toBeNull();
    expect(id!.matchId).toBe("bsd-1");
    expect(id!.homeTeam).toBe(PSG);
    expect(id!.awayTeam).toBe(OM);
    expect(id!.leagueId).toBe("8");
    expect(id!.kickoffIso).toBe("2026-10-10T19:00:00Z");
  });

  test("les cotes dévigées sont fournies à côté des cotes brutes (limite L7)", () => {
    const base = buildReportPayload(match);
    expect(base.odds_json).toEqual(match.odds);
    expect(base.odds_devig_json).toEqual({ home: 61.54, draw: 23.08, away: 15.38 });
  });

  test("un matchData sans identité est refusé, pas deviné", () => {
    expect(identityFromPayload({ match: "PSG vs OM" })).toBeNull();
    expect(identityFromPayload({})).toBeNull();
  });

  test("saison footballière dérivée du kickoff", () => {
    expect(seasonFromKickoff("2026-01-15T12:00:00Z")).toBe("2025/26");
    expect(seasonFromKickoff("2026-09-15T12:00:00Z")).toBe("2026/27");
    expect(seasonFromKickoff("illisible")).toBeNull();
  });
});

describe("football-match-report-v2 — payload final 21 clés", () => {
  const identity = identityFromPayload(buildReportPayload(match))!;

  test("exactement les 21 clés du contrat, aucune en plus ni en moins", () => {
    const payload = buildReportPayloadV2({ identity, base: buildReportPayload(match), sources: FULL_SOURCES });
    expect(hasAllPayloadKeys(payload)).toBe(true);
    expect(REPORT_PAYLOAD_KEYS).toHaveLength(21);
    expect(Object.keys(payload).sort()).toEqual([...REPORT_PAYLOAD_KEYS].sort());
  });

  test("la taille reste sous le seuil des 10 KB (MAX_MATCHDATA_BYTES)", () => {
    const payload = buildReportPayloadV2({ identity, base: buildReportPayload(match), sources: FULL_SOURCES });
    expect(JSON.stringify(payload).length).toBeLessThan(MAX_BYTES);
  });

  test("les sources raccordées alimentent bien les clés", () => {
    const payload = buildReportPayloadV2({ identity, base: buildReportPayload(match), sources: FULL_SOURCES });

    const sot = payload.sot_json as { home: { l5: { gp: number; for: number } } };
    expect(sot.home.l5.gp).toBe(1); // 1 seul match PSG à domicile dans la fenêtre
    expect(sot.home.l5.for).toBe(7);

    const h2h = payload.h2h_json as { sampleSize: number; teamAWins: number };
    expect(h2h.sampleSize).toBe(2);
    expect(h2h.teamAWins).toBe(2); // 3-1 à domicile + 0-2 à l'extérieur

    const schedule = payload.schedule_json as { daysSinceLast: number | null; nextInDays: number | null };
    expect(schedule.daysSinceLast).toBe(20); // 2026-09-20 → 2026-10-10
    expect(schedule.nextInDays).toBe(8);

    expect(payload.xg_json).not.toBeNull();
    expect(payload.injuries_home_json).not.toBeNull();
    expect(payload.press_review_json).not.toBeNull();
  });

  test("sources absentes → null explicite, jamais de valeur inventée", () => {
    const empty: ReportSources = { xg: null, finished: null, injuriesHome: null, injuriesAway: null, pressReview: null };
    const payload = buildReportPayloadV2({ identity, base: buildReportPayload(match), sources: empty });

    expect(payload.sot_json).toBeNull();
    expect(payload.h2h_json).toBeNull();
    expect(payload.xg_json).toBeNull();
    expect(payload.injuries_home_json).toBeNull();
    expect(payload.press_review_json).toBeNull();

    const schedule = payload.schedule_json as { daysSinceLast: number | null; certainty: string };
    expect(schedule.daysSinceLast).toBeNull();
    expect(schedule.certainty).toBe("non_confirmé");
    expect(JSON.stringify(payload).length).toBeLessThan(MAX_BYTES);
  });
});

// ── Étape 5 : schéma de sortie + prompt ──────────────────────────────────────

const WINDOW = { gp: 5, xgFor: 1.8, xgAgainst: 0.9, goalsFor: 2.1, goalsAgainst: 1, sotFor: 7, sotAgainst: 3 };

const validReport = () => ({
  meta: {
    matchId: "bsd-1",
    generatedAt: "2026-10-06T10:00:00Z",
    season: "2026/27",
    model: "gemini-flash",
    groundingUsed: false,
    dataSources: ["PariScore"],
  },
  form: { home: { l5: WINDOW, l10: null }, away: { l5: WINDOW, l10: null } },
  h2h: { sampleSize: 2, periodFrom: "2026-09-01T19:00:00Z", periodTo: "2026-09-20T19:00:00Z", notes: [], certainty: "confirmé" },
  tactics: {
    home: { system: "4-3-3", strengths: ["Transition rapide"], weaknesses: ["Dos aux remplacements"] },
    away: { system: null, strengths: [], weaknesses: [] },
    certainty: "probable",
  },
  absences: {
    home: [
      {
        player: "Saliba",
        status: "suspendu",
        certainty: "confirmé",
        source: "LFP",
        date: "2026-10-04",
        impact: "poste_non_doublé",
        replacement: "Kabore",
      },
    ],
    away: [],
    probableLineups: { home: null, away: null },
  },
  context: {
    standings: { home: "2e", away: "6e" },
    stakes: ["Duel pour le podium"],
    calendar: {
      homeDaysSinceLast: 20,
      awayDaysSinceLast: 9,
      homeNextInDays: 8,
      awayNextInDays: 5,
      europeanMatchFlags: { home: false, away: true },
      certainty: "confirmé",
    },
  },
  press: { quotes: [] },
  advanced: {
    modelProbs: { home: 58, draw: 24, away: 18 },
    devigProbs: { home: 61.54, draw: 23.08, away: 15.38 },
    xgDelta: { home: 0.6, away: null },
    sotDelta: { home: 4, away: null },
    notes: [],
  },
  redFlags: [
    { id: "rotation_probable", severity: "haute", evidence: "Europe jeudi, J2 après", certainty: "confirmé" },
    { id: "sans_enjeu", severity: "moyenne", evidence: "2e vs 6e, ni titre ni relégation", certainty: "probable" },
  ],
  synthesis: {
    keyFactors: [
      { label: "SOT concédés à l'extérieur", weight: 3, evidence: "sot_json.home.l5.against = 4.9", certainty: "probable" },
      { label: "Absence latéral gauche", weight: 3, evidence: "injuries_home_json", certainty: "confirmé" },
      { label: "Rotation probable", weight: 2, evidence: "schedule_json.nextInDays = 3", certainty: "confirmé" },
      { label: "xG domicile supérieur", weight: 1, evidence: "xg_json.home.l5.xgFor", certainty: "probable" },
    ],
    watchlist: ["Composition annoncée en conférence"],
  },
  dataGaps: ["Composition probable non confirmée (2 sources)"],
});

describe("football-match-report-v2 — schéma zod de sortie", () => {
  test("une payload conforme passe le parsing", () => {
    const r = parseReportV2(validReport());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.report.synthesis.keyFactors).toHaveLength(4);
  });

  test("3 keyFactors au lieu de 4 → rejet propre avec le chemin fautif", () => {
    const bad = validReport();
    bad.synthesis.keyFactors = bad.synthesis.keyFactors.slice(0, 3);
    const r = parseReportV2(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("synthesis.keyFactors");
  });

  test("7 keyFactors au lieu de 6 → rejeté (anti-verbiage)", () => {
    const bad = validReport();
    const k = bad.synthesis.keyFactors[0];
    bad.synthesis.keyFactors = [...bad.synthesis.keyFactors, k, k, k];
    expect(parseReportV2(bad).ok).toBe(false);
  });

  test("la taxonomie de certitude est fermée : « rumeur » rejeté", () => {
    const bad = validReport();
    bad.h2h.certainty = "rumeur";
    const r = parseReportV2(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("h2h.certainty");
  });

  test("8 redFlags dépassent le plafond de 7", () => {
    const bad = validReport();
    const f = bad.redFlags[0];
    bad.redFlags = [...bad.redFlags, f, f, f, f, f, f, f];
    expect(parseReportV2(bad).ok).toBe(false);
  });

  test("dataGaps absent → rejeté (le champ est obligatoire, même vide)", () => {
    const bad = validReport() as Record<string, unknown>;
    delete bad.dataGaps;
    const r = parseReportV2(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("dataGaps");
    expect(parseReportV2({ ...validReport(), dataGaps: [] }).ok).toBe(true);
  });

  test("nullabilité stricte : une métrique d'échantillon omise est rejetée", () => {
    const bad = validReport();
    const window = { ...WINDOW } as Record<string, unknown>;
    delete window.sotFor;
    bad.form.home.l5 = window as unknown as typeof WINDOW;
    const r = parseReportV2(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("form.home.l5");
  });

  test("un rapport invalidé retourne des erreurs lisibles, jamais d'exception", () => {
    const r = parseReportV2({ nada: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
    expect(parseReportV2(null).ok).toBe(false);
  });
});

describe("football-match-report-v2 — prompt v2.0", () => {
  test("le prompt système porte les interdits few-shot négatifs", () => {
    expect(REPORT_SYSTEM_PROMPT).toContain("Ils voudront se rattraper");
    expect(REPORT_SYSTEM_PROMPT).toContain("On peut imaginer que");
    expect(REPORT_SYSTEM_PROMPT).toContain("Sur la base de ces éléments, je recommanderais");
  });

  test("les garde-fous cotes, fenêtres et priorités sont présents", () => {
    expect(REPORT_SYSTEM_PROMPT).toContain("Les cotes brutes ne se commentent JAMAIS");
    expect(REPORT_SYSTEM_PROMPT).toContain("jamais de \"5 à 10\"");
    expect(REPORT_SYSTEM_PROMPT).toContain("Domicile et Extérieur sont strictement séparées");
    expect(REPORT_SYSTEM_PROMPT.indexOf("Absences et impact")).toBeLessThan(
      REPORT_SYSTEM_PROMPT.indexOf("Style, tactique"),
    );
  });

  test("l'anti-hallucination et la taxonomie unique y sont imposées", () => {
    expect(REPORT_SYSTEM_PROMPT).toContain("Tu n'utilises JAMAIS ta connaissance des effectifs");
    expect(REPORT_SYSTEM_PROMPT).toContain('"confirmé" | "probable" | "non_confirmé"');
    expect(REPORT_SYSTEM_PROMPT).not.toContain("rumeur");
    expect(REPORT_SYSTEM_PROMPT).toContain("toujours présent ([] si tout est couvert)");
  });

  test("le template injecte les 21 clés du payload", () => {
    const payload = buildReportPayloadV2({
      identity: identityFromPayload(buildReportPayload(match))!,
      base: buildReportPayload(match),
      sources: FULL_SOURCES,
    });
    const { system, user } = buildReportPrompt(payload);
    expect(system).toBe(REPORT_SYSTEM_PROMPT);
    for (const k of REPORT_PAYLOAD_KEYS) expect(user).toContain(`"${k}"`);
    expect(user).toContain("source unique de vérité");
    expect(user).toContain("toute valeur absente ci-dessus = null");
  });
});

describe("football-match-report-v2 — JSON Schema Gemini + repli", () => {
  const payload = () =>
    buildReportPayloadV2({
      identity: identityFromPayload(buildReportPayload(match))!,
      base: buildReportPayload(match),
      sources: FULL_SOURCES,
    });

  test("reportJsonSchema produit un objet OpenAPI sans $ref (Gemini ne les résout pas)", () => {
    const schema = reportJsonSchema();
    expect(schema.type).toBe("object");
    const raw = JSON.stringify(schema);
    expect(raw).not.toContain("$ref");
    // Rejet 400 de l'API Google réelle : ces deux clés ne sont pas supportées.
    expect(raw).not.toContain("additionalProperties");
    expect(raw).not.toContain("$schema");
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(
      ["absences", "advanced", "context", "dataGaps", "form", "h2h", "meta", "press", "redFlags", "synthesis", "tactics"].sort(),
    );
    expect(props.dataGaps).toBeDefined();
    expect((props.redFlags as { maxItems?: number }).maxItems).toBe(7);
    expect((props.synthesis as { properties: Record<string, { minItems?: number; maxItems?: number }> }).properties.keyFactors.minItems).toBe(4);
  });

  test("le rapport dégradé satisfait lui-même le schéma et porte la raison dans dataGaps", () => {
    const reasons = ["LLM_ALL_PROVIDERS_FAILED : quota", "synthesis.keyFactors: Too small"];
    const degraded = buildDegradedReportV2(payload(), reasons);
    expect(parseReportV2(degraded).ok).toBe(true);
    expect(degraded.dataGaps[0]).toBe(reasons[0]);
    expect(degraded.dataGaps.join(" ")).toContain("non conforme au schéma");
    expect(degraded.synthesis.keyFactors).toHaveLength(4);
    expect(degraded.meta.model).toBe("degraded");
    // Les facteurs sont recopiés du payload, jamais inventés.
    expect(degraded.advanced.modelProbs).not.toBeNull();
    expect(degraded.redFlags).toHaveLength(0);
  });

  test("le repli ne fabrique aucune valeur absente du payload", () => {
    const bare = buildReportPayloadV2({
      identity: identityFromPayload(buildReportPayload(match))!,
      base: null,
    });
    const degraded = buildDegradedReportV2(bare, ["aucune source"]);
    expect(degraded.advanced.modelProbs).toBeNull();
    expect(degraded.advanced.devigProbs).toBeNull();
    expect(degraded.context.calendar.homeDaysSinceLast).toBeNull();
    expect(degraded.dataGaps).toContain("aucune source");
  });

  test("le pont UI v1 ne produit aucun pronostic", () => {
    const v2 = buildDegradedReportV2(payload(), ["test"]);
    const legacy = toLegacyReport(v2);
    expect(legacy.predictiveBets).toEqual([]);
    expect(legacy.confidence).toBe(0);
    expect(legacy.combo).toBeNull();
    expect(legacy.dataSources).toEqual(v2.meta.dataSources);
    expect(legacy.keyFacts.length).toBeGreaterThan(0);
    expect(legacy.generatedAt).toBe(v2.meta.generatedAt);
  });
});

describe("football-match-report-v2 — hydratation des fenêtres", () => {
  const payload = () =>
    buildReportPayloadV2({
      identity: identityFromPayload(buildReportPayload(match))!,
      base: buildReportPayload(match),
      sources: FULL_SOURCES,
    });

  test("les mesures viennent du payload, pas du modèle", () => {
    const p = payload();
    const h = hydrateFormFromPayload(buildDegradedReportV2(p, ["test"]), p);

    expect(h.form.home.l5).not.toBeNull();
    expect(h.form.home.l5!.gp).toBe(5); // gp prioritaire côté xG
    expect(h.form.home.l5!.xgFor).toBe(1.8);
    expect(h.form.home.l5!.sotFor).toBe(7); // SOT domicile du match de la fenêtre
    expect(h.form.home.l5!.sotAgainst).toBe(2);

    expect(h.form.away.l5!.xgFor).toBe(1.2);
    expect(h.form.away.l5!.sotFor).toBe(2); // OM à l'extérieur (7-2 inversé)
    expect(h.form.away.l5!.sotAgainst).toBe(7);
  });

  test("une fenêtre sans xG mais avec SOT est tout de même servie", () => {
    const p = payload();
    const h = hydrateFormFromPayload(buildDegradedReportV2(p, ["test"]), p);
    // FULL_SOURCES : l10 est null côté xG, mais le SOT L10 existe (1 match).
    expect(h.form.home.l10).not.toBeNull();
    expect(h.form.home.l10!.xgFor).toBeNull(); // jamais 0
    expect(h.form.home.l10!.gp).toBe(1);
    expect(h.form.home.l10!.sotFor).toBe(7);
  });

  test("ni xG ni SOT → le rapport n'est pas touché", () => {
    const bare = buildReportPayloadV2({
      identity: identityFromPayload(buildReportPayload(match))!,
      base: buildReportPayload(match),
    });
    const report = buildDegradedReportV2(bare, ["test"]);
    expect(hydrateFormFromPayload(report, bare)).toBe(report);
  });

  test("le résultat hydraté reste conforme au schéma", () => {
    const p = payload();
    const h = hydrateFormFromPayload(buildDegradedReportV2(p, ["test"]), p);
    expect(parseReportV2(h).ok).toBe(true);
  });

  test("devig, probabilités modèle et J-days viennent aussi du payload", () => {
    const p = payload();
    const h = hydrateFromPayload(buildDegradedReportV2(p, ["test"]), p);

    expect(h.advanced.devigProbs).toEqual({ home: 61.54, draw: 23.08, away: 15.38 });
    expect(h.advanced.modelProbs).toEqual({ home: 58, draw: 24, away: 18 });
    expect(h.context.calendar.homeDaysSinceLast).toBe(20);
    expect(h.context.calendar.homeNextInDays).toBe(8);
    expect(h.context.calendar.certainty).toBe("confirmé");
    expect(parseReportV2(h).ok).toBe(true);
  });

  test("payload sans cotes ni schedule → les valeurs du modèle sont conservées", () => {
    const bare = buildReportPayloadV2({ identity: identityFromPayload(buildReportPayload(match))! });
    const report = buildDegradedReportV2(bare, ["test"]);
    const h = hydrateFromPayload(report, bare);
    expect(h.advanced.devigProbs).toBeNull();
    expect(h.context.calendar.homeDaysSinceLast).toBeNull();
  });
});

describe("football-match-report-v2 — dataGaps opposable", () => {
  const identity = identityFromPayload(buildReportPayload(match))!;

  test("toute clé métier nulle du payload finit dans dataGaps", () => {
    // base seule, aucune source : xG, SOT, H2H, presse, absences sont nuls.
    const p = buildReportPayloadV2({ identity, base: buildReportPayload(match) });
    const done = completeDataGaps(buildDegradedReportV2(p, []), p);

    expect(p.xg_json).toBeNull();
    for (const key of [
      "xg_json",
      "sot_json",
      "h2h_json",
      "press_review_json",
      "injuries_home_json",
      "injuries_away_json",
    ]) {
      const label = GAP_LABEL[key];
      expect(done.dataGaps.some((g) => g.includes(label))).toBe(true);
    }
    // Le fixture porte des cotes dévigées → aucune entrée « cotes absentes ».
    expect(done.dataGaps.some((g) => g.includes(GAP_LABEL.odds_devig_json))).toBe(false);
    expect(parseReportV2(done).ok).toBe(true);
  });

  test("une clé résolue n'ajoute aucune entrée", () => {
    const p = buildReportPayloadV2({
      identity,
      base: buildReportPayload(match),
      sources: FULL_SOURCES,
    });
    const done = completeDataGaps(buildDegradedReportV2(p, []), p);
    expect(done.dataGaps.some((g) => g.includes(GAP_LABEL.xg_json))).toBe(false);
    expect(done.dataGaps.some((g) => g.includes(GAP_LABEL.injuries_home_json))).toBe(false);
    // press_review est fourni dans FULL_SOURCES → pas de message d'absence.
    expect(done.dataGaps.some((g) => g.includes(GAP_LABEL.press_review_json))).toBe(false);
  });

  test("idempotent : deux passes ne doublent aucune entrée", () => {
    const p = buildReportPayloadV2({ identity, base: buildReportPayload(match) });
    const once = completeDataGaps(buildDegradedReportV2(p, []), p);
    const twice = completeDataGaps(once, p);
    expect(twice.dataGaps).toEqual(once.dataGaps);
  });

  test("les clés toujours présentes ne créent jamais de gap", () => {
    const p = buildReportPayloadV2({ identity, base: buildReportPayload(match) });
    const done = completeDataGaps(buildDegradedReportV2(p, []), p);
    expect(done.dataGaps.some((g) => g.includes("match_id"))).toBe(false);
    expect(done.dataGaps.some((g) => g.includes("team_home"))).toBe(false);
  });
});
