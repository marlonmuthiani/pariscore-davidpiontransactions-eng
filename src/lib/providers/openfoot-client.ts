/**
 * Client OpenFoot API (openfootapi.com) — fixtures, standings, xG.
 *
 * Auth: Authorization: Bearer <OPENFOOT_API_KEY>
 * Fallback: la clé démo `of_demo_openfootapi_docs` est PUBLIQUE PAR CONCEPTION
 * (publiée dans leur docs, limite 30 req/min) — elle n'est PAS un secret.
 * Plafond démo : preview_limit 5 par réponse + xG/context/odds en 403
 * (`plan_upgrade_required`, Developer $14/mo). Mettre OPENFOOT_API_KEY dans
 * .env dès qu'on raccorde le client aux fiches de matchs.
 *
 * Contrat de réponse : { data, meta } ou { error: { code, message } }.
 * IDs canoniques : match_fmb_{league}_{season}_{date}_{home}_{away} (migration Sep 2026).
 * Source : FotMob "Unlicensed-Beta (owner-approved factual data)" — vérifier la
 * licence avant tout usage commercial.
 */

const OPENFOOT_BASE = "https://openfootapi.com";
const TIMEOUT_MS = 15_000;
const DEMO_KEY = "of_demo_openfootapi_docs";

function getApiKey(): string {
  return process.env.OPENFOOT_API_KEY || DEMO_KEY;
}

// ─── Erreurs typées ───────────────────────────────────────────────────────

export type OpenFootErrorCode =
  | "invalid_api_key"
  | "api_key_required"
  | "plan_upgrade_required"
  | "monthly_quota_exceeded"
  | "match_not_found"
  | "match_not_played"
  | "feature_not_available"
  | "endpoint_not_found"
  | "http_error"
  | "network_error";

export class OpenFootApiError extends Error {
  readonly code: OpenFootErrorCode;
  readonly status: number;
  constructor(code: OpenFootErrorCode, status: number, message: string) {
    super(message);
    this.name = "OpenFootApiError";
    this.code = code;
    this.status = status;
  }
}

// ─── Types (payload observé le 2026-10-08) ───────────────────────────────

export type OpenFootTeam = {
  id: string;
  name: string;
  shortName?: string;
  code?: string;
  logoUrl?: string | null;
  country?: string;
  competitionId?: string;
  sourceRefs?: Array<{ source: string; id: string }>;
};

export type OpenFootMatch = {
  id: string;
  competitionId: string;
  season: string;
  round?: string;
  kickoffAt: string;
  kickoffTimeKnown?: boolean;
  status: "scheduled" | "live" | "finished" | "postponed" | "cancelled" | "unknown";
  venue?: string | null;
  homeTeam: OpenFootTeam;
  awayTeam: OpenFootTeam;
  score?: { home: number | null; away: number | null };
  minute?: number | null;
  addedTime?: number | null;
  period?: string | null;
  updatedAt?: string;
  sourceRefs?: Array<{ source: string; id: string }>;
};

export type OpenFootMatchesMeta = {
  request_id?: string;
  generated_at?: string;
  environment?: string;
  count?: number;
  total_count?: number;
  preview_limit?: number;
  pagination?: { limit: number; next_cursor: string | null };
  scope?: { mode: string; partial: boolean; competitions_total: number };
  unavailable?: Array<{
    competition_id: string;
    reason: string;
    message: string;
  }>;
};

export type OpenFootMatchesResponse = {
  data: OpenFootMatch[];
  meta: OpenFootMatchesMeta;
};

/** xG au niveau tir (endpoint /v1/matches/{id}/xg — Developer). */
export type OpenFootShot = {
  x: number;
  y: number;
  type?: string;
  situation?: string;
  xg: number;
  team?: string;
  player?: string;
  minute?: number;
};

export type OpenFootMatchXg = {
  matchId: string;
  shots: OpenFootShot[];
  totals: { home: number; away: number };
  meta?: { request_id?: string; generated_at?: string };
};

// ─── Enveloppe interne ───────────────────────────────────────────────────

type Envelope<T> = { data?: T; meta?: Record<string, unknown> };

type EnvelopeError = { error?: { code?: string; message?: string } };

// ponytail: pas de cache — un cache edge 5s comme bzzoiro-client quand le
// client est raccordé aux fiches de matchs et que le throughput devient un sujet
async function openfootFetch<T>(
  path: string,
  opts?: { signal?: AbortSignal },
): Promise<{ body: T; status: number }> {
  const url = OPENFOOT_BASE + path;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        Accept: "application/json",
      },
      signal: opts?.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new OpenFootApiError(
      "network_error",
      -1,
      `OpenFoot fetch failed: ${url} — ${(err as Error).message}`,
    );
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // corps non JSON : traité comme erreur HTTP
  }

  if (!res.ok) {
    const errBody = (body as EnvelopeError | null)?.error;
    const code = (errBody?.code ?? "http_error") as OpenFootErrorCode;
    throw new OpenFootApiError(
      code,
      res.status,
      errBody?.message ?? `OpenFoot HTTP ${res.status}: ${url}`,
    );
  }

  return { body: body as T, status: res.status };
}

// ─── API publique ────────────────────────────────────────────────────────

/**
 * Matchs d'une date (YYYY-MM-DD, interprétée en UTC côté API).
 * Retourne la 1re page (la démo plafonne à 5 via preview_limit) + meta.
 */
export async function getMatchesByDate(
  date: string,
  opts?: { signal?: AbortSignal },
): Promise<OpenFootMatchesResponse> {
  const { body } = await openfootFetch<Envelope<OpenFootMatch[]>>(
    `/v1/matches?date=${encodeURIComponent(date)}`,
    opts,
  );
  return {
    data: body.data ?? [],
    meta: (body.meta ?? {}) as OpenFootMatchesMeta,
  };
}

/**
 * xG au niveau tir d'un match (coordonnées x/y, xG individuel, totaux équipe).
 * Nécessite une clé Developer — sinon OpenFootApiError("plan_upgrade_required", 403).
 */
export async function getMatchXg(
  matchId: string,
  opts?: { signal?: AbortSignal },
): Promise<OpenFootMatchXg> {
  const { body } = await openfootFetch<Envelope<Record<string, unknown>>>(
    `/v1/matches/${encodeURIComponent(matchId)}/xg`,
    opts,
  );
  const data = body.data ?? {};
  const shots = Array.isArray((data as { shots?: unknown }).shots)
    ? ((data as { shots: OpenFootShot[] }).shots)
    : [];
  const totals = (data as { totals?: { home?: number; away?: number } }).totals ?? {};
  return {
    matchId,
    shots,
    totals: { home: totals.home ?? 0, away: totals.away ?? 0 },
    meta: body.meta as OpenFootMatchXg["meta"],
  };
}
