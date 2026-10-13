"use client";

// Hook SWR — tendances football (modèle OddAlerts /trends).
// Charge TOUT le payload une fois ; le filtre par catégorie est client.
// Cache 30 min : les stats ligues sont re-scrapées toutes les 6 h (cron),
// et la route serveur cache déjà 30 min.

import useSWR from "swr";
import type {
  FootballTrendsPayload,
  TrendCategory,
} from "@/lib/stats/football-trends-shared";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export type { FootballTrendsPayload, TrendCategory };

export function useFootballTrends() {
  const { data, error, isLoading } = useSWR<FootballTrendsPayload>(
    "/api/football/trends",
    fetcher,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 30 * 60_000,
    },
  );
  return { data, error, isLoading };
}
