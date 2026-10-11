#!/usr/bin/env python3
"""
compute_football_elo.py — Classement Elo interne par championnat.

Source : mêmes CSV gratuits football-data.co.uk que scrape_footballdata.py
(lignes par match : HomeTeam, AwayTeam, FTHG, FTAG, FTR, Date), traités en
ordre chronologique sur 4 saisons pour une base stable.

Paramètres (documentés, stables) :
  - Elo initial : 1500 (promus / nouveaux noms).
  - K = 22, avantage domicile HFA = +55 Elo.
  - Régression inter-saisons : elo = 1500 + (elo - 1500) * 0.7.

Sortie : public/data/elo-football.json
  { meta, leagues: { slug: { season, teams: [{ team, elo, rank, matches }] } } }

USAGE:
    python scripts/compute_football_elo.py --all --output-dir public/data
    python scripts/compute_football_elo.py --league epl --output-dir public/data
"""

import sys
import os
import json
import csv
import io
import argparse
import math
import time
from datetime import datetime, timezone
from typing import Optional

try:
    import requests
    from tenacity import retry, stop_after_attempt, wait_exponential
except ImportError as e:
    print(f"Deps missing: {e} — pip install -r scripts/requirements-rankings.txt", file=sys.stderr)
    sys.exit(1)

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
BASE = "https://www.football-data.co.uk/mmz4281"

# slug interne -> codes division football-data.co.uk (miroir scrape_footballdata.py).
LEAGUES = {
    "epl": ["E0"],
    "championship": ["E1"],
    "ligue1": ["F1"],
    "ligue2": ["F2"],
    "bundesliga": ["D1"],
    "bundesliga2": ["D2"],
    "laliga": ["SP1"],
    "laliga2": ["SP2"],
    "seriea": ["I1"],
    "serieb": ["I2"],
    "eredivisie": ["N1"],
    "primeira_liga": ["P1"],
    "jupiler": ["B1"],
    "super_lig": ["T1"],
    "superleague_greece": ["G1"],
    "scot_prem": ["SC0"],
}

# Saisons traitées (code, label) — ordre chronologique pour l'Elo.
SEASONS = [("2324", "2023/24"), ("2425", "2024/25"), ("2526", "2025/26"), ("2627", "2026/27")]

BASE_ELO = 1500.0
K_FACTOR = 22.0
HOME_ADVANTAGE = 55.0
SEASON_CARRYOVER = 0.7


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=30))
def _fetch_csv(season_code: str, division: str) -> Optional[str]:
    url = f"{BASE}/{season_code}/{division}.csv"
    resp = requests.get(url, headers=HEADERS, timeout=30)
    if resp.status_code != 200 or len(resp.content) < 500:
        return None
    return resp.text


def _parse_date(raw: str, season_code: str) -> tuple:
    """Date CSV -> clé triable (année, mois, jour). Formats dd/mm/yy ou yyyy-mm-dd."""
    raw = (raw or "").strip()
    try:
        if "/" in raw:
            d, m, y = raw.split("/")
            year = int(y) + 2000 if len(y) == 2 else int(y)
            return (year, int(m), int(d))
        if "-" in raw:
            y, m, d = raw.split("-")
            return (int(y), int(m), int(d))
    except ValueError:
        pass
    # Ligne sans date valide : fin de saison (triée en dernier).
    return (2000 + int(season_code[:2]) + 1, 12, 31)


def _expected(home_elo: float, away_elo: float) -> float:
    return 1.0 / (1.0 + 10 ** ((away_elo - home_elo - HOME_ADVANTAGE) / 400.0))


def compute_league(slug: str, divisions: list[str]) -> Optional[dict]:
    """Calcule l'Elo courant d'une ligue (None si aucune donnée)."""
    elos: dict[str, float] = {}
    matches_count: dict[str, int] = {}
    last_season_label: Optional[str] = None
    current_teams: set[str] = set()

    for season_code, season_label in SEASONS:
        rows_all = []
        for division in divisions:
            text = _fetch_csv(season_code, division)
            if text:
                rows_all.extend(csv.DictReader(io.StringIO(text)))
            time.sleep(0.5)
        if not rows_all:
            continue
        last_season_label = season_label

        # Régression vers la moyenne en début de saison (sauf 1re saison).
        if elos:
            for team in elos:
                elos[team] = BASE_ELO + (elos[team] - BASE_ELO) * SEASON_CARRYOVER

        season_matches = 0
        season_teams: set[str] = set()
        dated = []
        for r in rows_all:
            try:
                hg = int(r.get("FTHG") or "")
                ag = int(r.get("FTAG") or "")
            except ValueError:
                continue
            home = (r.get("HomeTeam") or "").strip()
            away = (r.get("AwayTeam") or "").strip()
            if not home or not away:
                continue
            dated.append((_parse_date(r.get("Date") or "", season_code), home, away, hg, ag))
        dated.sort(key=lambda x: x[0])

        for _, home, away, hg, ag in dated:
            elos.setdefault(home, BASE_ELO)
            elos.setdefault(away, BASE_ELO)
            exp_home = _expected(elos[home], elos[away])
            score_home = 1.0 if hg > ag else 0.5 if hg == ag else 0.0
            elos[home] += K_FACTOR * (score_home - exp_home)
            elos[away] += K_FACTOR * ((1.0 - score_home) - (1.0 - exp_home))
            matches_count[home] = matches_count.get(home, 0) + 1
            matches_count[away] = matches_count.get(away, 0) + 1
            season_teams.add(home)
            season_teams.add(away)
            season_matches += 1

        if season_matches:
            current_teams = season_teams

    if not elos or not current_teams or last_season_label is None:
        return None

    ranked = sorted(
        ((t, elos[t]) for t in current_teams),
        key=lambda x: x[1],
        reverse=True,
    )
    return {
        "season": last_season_label,
        "teams": [
            {
                "team": team,
                "elo": round(elo),
                "rank": i + 1,
                "matches": matches_count.get(team, 0),
            }
            for i, (team, elo) in enumerate(ranked)
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Calcule l'Elo foot interne")
    parser.add_argument("--all", action="store_true", help="Toutes les ligues")
    parser.add_argument("--league", default=None, help="Slug ligue (ex: epl)")
    parser.add_argument("--output-dir", default="public/data")
    args = parser.parse_args()

    slugs = list(LEAGUES.keys()) if args.all else [args.league or "epl"]
    os.makedirs(args.output_dir, exist_ok=True)
    leagues_out = {}
    # En mode --league unique, on fusionne avec le JSON existant (pas d'écrasement).
    out_path = os.path.join(args.output_dir, "elo-football.json")
    if not args.all and os.path.exists(out_path):
        try:
            with open(out_path, encoding="utf-8") as f:
                leagues_out = json.load(f).get("leagues", {})
        except (ValueError, OSError):
            leagues_out = {}

    for slug in slugs:
        if slug not in LEAGUES:
            print(f"Ligue inconnue : {slug}", file=sys.stderr)
            return 1
        result = compute_league(slug, LEAGUES[slug])
        if result is None:
            print(f"[{slug}] aucune donnée — ignorée")
            continue
        leagues_out[slug] = result
        print(f"[{slug}] {len(result['teams'])} équipes Elo "
              f"({result['teams'][0]['team']} {result['teams'][0]['elo']})")

    with open(out_path, "w", encoding="utf-8") as f:
        now = datetime.now(timezone.utc).isoformat()
        ok_slugs = [s for s in slugs if s in leagues_out]
        json.dump({
            "meta": {
                "source": "football-data.co.uk (calcul interne)",
                "baseElo": BASE_ELO,
                "kFactor": K_FACTOR,
                "homeAdvantage": HOME_ADVANTAGE,
                "seasonCarryover": SEASON_CARRYOVER,
                "updatedAt": now,
                # Monitoring (Q12) : fraîcheur, volume, couverture ligues.
                "fetchedAt": now,
                "rowCount": sum(len(leagues_out[s]["teams"]) for s in ok_slugs),
                "coveragePct": round(100 * len(ok_slugs) / len(slugs)) if slugs else 0,
            },
            "leagues": leagues_out,
        }, f, ensure_ascii=False, indent=1)
    print(f"Elo écrit -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
