import { describe, expect, test, afterEach } from "bun:test";

import {
  OpenFootApiError,
  getMatchXg,
  getMatchesByDate,
} from "../openfoot-client";

// Réponse réelle observée le 2026-10-08 (truncated) — structure canonique
const MATCHES_BODY = {
  data: [
    {
      id: "match_fmb_mne1_2026-27_20261008_otrant_ofk_mladost_donja_gorica",
      competitionId: "comp_1_cfl_mne",
      season: "2026/27",
      round: "Round 10",
      kickoffAt: "2026-10-08T12:00:00.000Z",
      kickoffTimeKnown: true,
      status: "finished",
      venue: null,
      homeTeam: {
        id: "team_otrant_mont",
        name: "Otrant",
        shortName: "Otrant",
        code: "OTR",
        logoUrl: null,
        country: "Montenegro",
      },
      awayTeam: {
        id: "team_ofk_mladost_donja_gorica_mont",
        name: "OFK Mladost Donja Gorica",
        code: "OMD",
        logoUrl: null,
      },
      score: { home: 2, away: 2 },
      period: "FT",
      updatedAt: "2026-10-08T18:26:59.322Z",
    },
  ],
  meta: {
    count: 5,
    total_count: 26,
    preview_limit: 5,
    environment: "beta",
    pagination: { limit: 5, next_cursor: "b2Zmc2V0OjU" },
    scope: { mode: "default_competitions", partial: true, competitions_total: 120 },
  },
};

const XG_BODY = {
  data: {
    shots: [
      { x: 88.2, y: 50.1, type: "right_foot", situation: "open_play", xg: 0.42, team: "home", player: "A", minute: 12 },
      { x: 91.0, y: 47.5, type: "header", situation: "corner", xg: 0.18, team: "away", player: "B", minute: 33 },
    ],
    totals: { home: 1.24, away: 0.61 },
  },
  meta: { request_id: "req_test" },
};

let fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];

function mockFetch(status: number, body: unknown) {
  // @ts-expect-error — stub volontaire de l'API fetch dans les tests
  globalThis.fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    fetchCalls.push({ url: String(url), headers: init?.headers ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
}

afterEach(() => {
  delete process.env.OPENFOOT_API_KEY;
  fetchCalls = [];
});

describe("OpenFootClient", () => {
  test("getMatchesByDate parse l'enveloppe { data, meta } et préserve la pagination", async () => {
    mockFetch(200, MATCHES_BODY);
    const res = await getMatchesByDate("2026-10-08");
    expect(res.data).toHaveLength(1);
    expect(res.data[0]?.id).toBe(
      "match_fmb_mne1_2026-27_20261008_otrant_ofk_mladost_donja_gorica",
    );
    expect(res.data[0]?.competitionId).toBe("comp_1_cfl_mne");
    expect(res.meta.total_count).toBe(26);
    expect(res.meta.preview_limit).toBe(5);
    expect(res.meta.pagination?.next_cursor).toBe("b2Zmc2V0OjU");
    expect(fetchCalls[0]?.url).toContain("/v1/matches?date=2026-10-08");
  });

  test("fallback clé démo quand OPENFOOT_API_KEY absente ; override quand présente", async () => {
    mockFetch(200, MATCHES_BODY);
    await getMatchesByDate("2026-10-08");
    expect(fetchCalls[0]?.headers.Authorization).toBe(
      "Bearer of_demo_openfootapi_docs",
    );

    process.env.OPENFOOT_API_KEY = "of_live_test_key";
    await getMatchesByDate("2026-10-08");
    expect(fetchCalls[1]?.headers.Authorization).toBe("Bearer of_live_test_key");
  });

  test("erreur 403 plan_upgrade_required levée comme OpenFootApiError typée", async () => {
    mockFetch(403, {
      error: {
        code: "plan_upgrade_required",
        message: "The demo key covers fixtures, competitions, standings and search.",
      },
    });
    try {
      await getMatchXg("match_fmb_test");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OpenFootApiError);
      const e = err as OpenFootApiError;
      expect(e.code).toBe("plan_upgrade_required");
      expect(e.status).toBe(403);
    }
  });

  test("erreur réseau levée comme network_error (pas de 500 silencieux)", async () => {
    // @ts-expect-error — stub volontaire qui échoue
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    try {
      await getMatchesByDate("2026-10-08");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OpenFootApiError);
      expect((err as OpenFootApiError).code).toBe("network_error");
    }
  });

  test("getMatchXg parse les tirs (x/y, xg individuel) et les totaux équipe", async () => {
    mockFetch(200, XG_BODY);
    const res = await getMatchXg("match_fmb_test");
    expect(res.matchId).toBe("match_fmb_test");
    expect(res.shots).toHaveLength(2);
    expect(res.shots[0]?.x).toBeCloseTo(88.2);
    expect(res.shots[0]?.xg).toBeCloseTo(0.42);
    expect(res.shots[1]?.team).toBe("away");
    expect(res.totals).toEqual({ home: 1.24, away: 0.61 });
  });

  test("getMatchXg tolère un payload sans shots ni totals (feature_not_available côté API)", async () => {
    mockFetch(200, { data: {} });
    const res = await getMatchXg("match_fmb_test");
    expect(res.shots).toHaveLength(0);
    expect(res.totals).toEqual({ home: 0, away: 0 });
  });
});
