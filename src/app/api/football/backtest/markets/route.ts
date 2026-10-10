import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fetchBSDFootballFinishedRange } from "@/lib/bsd-football-fetcher";
import { runMarketBacktest } from "@/lib/football-backtest/market-engine";
import { parseWindow } from "@/lib/football-results";
import { loadTop5Entries } from "@/lib/top5-backtest/store";
import { createTtlCache, isFresh, type TtlCacheEntry } from "@/lib/cached-route";
import { runCornersBacktest } from "@/lib/backtest/corners-backtest";
import type { BetminesFixtureInput } from "@/lib/backtest/corner-outcomes-join";

/**
 * GET /api/football/backtest/markets?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Backtest WALK-FORWARD des marchés football (vague 3, phase 1) :
 *  - picks prospectifs du journal top5 (cron 05:15 UTC / backfill) sur la
 *    fenêtre, mappés aux marchés du registre `football-backtest/markets.ts` ;
 *  - règlement via `settleFootballPick` (moteur unique, réutilisé) ;
 *  - cotes réelles BSD uniquement, Double Chance dérivée du dé-vig 1X2 ;
 *  - sorties : ROI, taux de réussite, drawdown par marché + cartes bloquées.
 *
 * Fenêtre par défaut : 30 jours (plafond 31). TTL 10 min.
 */

const TTL_MS = 10 * 60_000;
const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const { from, to } = parseWindow(searchParams.get("from"), searchParams.get("to"), 30);
  // Filtre ligue (optionnel) : alimente le sélecteur de championnat du widget Top 10,
  // qui affiche les 2 meilleurs marchés backtestés DE CE championnat. Filtrer les
  // `entries` AVANT `runMarketBacktest` plutôt que d'agréger côté client : le moteur
  // reste l'unique source du règlement (wins/losses/pnl/roiPct/sampleOk), donc aucune
  // règle de règlement n'est dupliquée dans l'UI.
  const league = (searchParams.get("league") ?? "").trim();

  const cache = createTtlCache<Record<string, unknown>>(
    `__footballBacktestMarkets:${from}:${to}:${league || "*"}`,
  );
  const hit = cache.getEntry() as TtlCacheEntry<Record<string, unknown>> | null;
  if (isFresh(hit, TTL_MS) && hit) {
    return NextResponse.json(hit.data, { headers: CACHE_HEADERS });
  }

  // 1. Picks prospectifs du journal sur la fenêtre (+ ligue si demandé).
  const inWindow = loadTop5Entries("football").filter((e) => {
    const day = e.kickoff.slice(0, 10);
    return day >= from && day <= to;
  });

  // Liste des ligues disponibles, calculée AVANT le filtre `league`.
  //
  // Sans cela, le sélecteur de l'IHM se reduce a l'unique option filtree : choisir
  // « Premier League » ferait disparaitre les 19 autres, et revenir a « tous » serait
  // impossible. Le filtre change les DONNEES, jamais la liste des CHOIX.
  const leagues = [...new Set(inWindow.map((e) => e.league).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "fr"),
  );

  const entries = league ? inWindow.filter((e) => e.league === league) : inWindow;

  // 2. Fixtures réelles — cotes BSD (dont dé-rive DC) + scores.
  const matchesById = new Map<
    string,
    Awaited<ReturnType<typeof fetchBSDFootballFinishedRange>>[number]
  >();
  const warnings: string[] = [];
  try {
    const matches = await fetchBSDFootballFinishedRange(from, to);
    for (const m of matches) matchesById.set(String(m.id), m);
  } catch (err) {
    warnings.push(`BSD : ${(err as Error).message}`);
  }

  // 3. Rejeu walk-forward par marché.
  const payload = runMarketBacktest({ entries, matchesById, from, to });

  // 4. Marchés corners — chemin DIFFÉRENT : les archives BetMines (cotes
  //    d'avant-match) jointes aux issues réelles. Ils ne passent pas par le
  //    journal Top 5, qui n'a produit aucun pick sur ces marchés (ils étaient
  //    bloqués) : `runMarketBacktest` y afficherait 0 pari.
  let corners: ReturnType<typeof runCornersBacktest> | null = null;
  try {
    corners = runCornersBacktest(loadBetminesFixtures());
  } catch (err) {
    warnings.push(`BetMines : ${(err as Error).message}`);
  }

  // `league` demandé par le client : la liste des ligues reste celle de la fenêtre
  // entière, sinon le sélecteur perdrait ses options (voir commentaire plus haut).
  const body = { ...payload, warnings, leagues, corners };
  cache.set(body);
  return NextResponse.json(body, { headers: CACHE_HEADERS });
}

/**
 * Charge les fixtures BetMines depuis `public/data/betmines/{leagueId}.json`.
 *
 * Lecture tolérante : un fichier illisible ou absent est ignoré plutôt que de
 * faire échouer l'onglet entier. Le backtest corners affiche alors un
 * échantillon plus faible — visible, jamais silencieux.
 */
function loadBetminesFixtures(): Map<number, BetminesFixtureInput[]> {
  const dir = path.join(process.cwd(), "public", "data", "betmines");
  const out = new Map<number, BetminesFixtureInput[]>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json") || name === "catalog.json") continue;
    const id = Number(name.replace(".json", ""));
    if (!Number.isFinite(id)) continue;
    try {
      const data = JSON.parse(readFileSync(path.join(dir, name), "utf-8")) as {
        fixtures?: BetminesFixtureInput[];
      };
      if (Array.isArray(data.fixtures) && data.fixtures.length > 0) {
        out.set(id, data.fixtures);
      }
    } catch {
      /* fichier illisible : ignore */
    }
  }
  return out;
}
