#!/usr/bin/env python3
"""
scrape_rotowire_injuries.py — Infirmerie par championnat depuis RotoWire.

Source : https://www.rotowire.com/soccer/tables/injury-report.php?league=XXX
(JSON brut, sans anti-bot — module https/node-like via requests suffit).

Couverture : 5 grands championnats (EPL, LIGA, SERI, FRAN, BUND).
Les championnats sans endpoint RotoWire restent absents du JSON final
(l'API répond alors "indisponible" au lieu d'inventer des données).

Limite connue : la date de retour est réservée aux abonnés RotoWire
(champ rDate = "Subscribers Only" pour 100 % des cas publics) — on stocke
le statut (OUT/GTD/SUS), le type de blessure et le poste, jamais de date.

USAGE:
    python scripts/scrape_rotowire_injuries.py --all --output-dir public/data/injuries
    python scripts/scrape_rotowire_injuries.py --league epl --output-dir public/data/injuries
"""

import sys
import os
import json
import argparse
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
BASE = "https://www.rotowire.com/soccer/tables/injury-report.php"

# slug interne -> code ligue RotoWire
LEAGUES = {
    "epl": "EPL",
    "laliga": "LIGA",
    "seriea": "SERI",
    "ligue1": "FRAN",
    "bundesliga": "BUND",
}

# Abbréviation RotoWire -> nom équipe football-data.co.uk (jointure avec fd/*.json).
TEAM_MAP = {
    "epl": {
        "ARS": "Arsenal", "AVL": "Aston Villa", "BHA": "Brighton",
        "BOU": "Bournemouth", "BRE": "Brentford", "CHE": "Chelsea",
        "COV": "Coventry", "CRY": "Crystal Palace", "EVE": "Everton",
        "FUL": "Fulham", "HUL": "Hull", "IPS": "Ipswich", "LEE": "Leeds",
        "LIV": "Liverpool", "MCI": "Man City", "MUN": "Man United",
        "NEW": "Newcastle", "NFO": "Nott'm Forest", "SUN": "Sunderland",
        "TOT": "Tottenham",
    },
    "laliga": {
        "ALA": "Alaves", "ATH": "Ath Bilbao", "ATM": "Ath Madrid",
        "BAR": "Barcelona", "BET": "Betis", "CEL": "Celta",
        "DEP": "La Coruna", "ELC": "Elche", "ESP": "Espanol",
        "GET": "Getafe", "LEV": "Levante", "MAL": "Malaga",
        "OSA": "Osasuna", "RAC": "Santander", "RAY": "Vallecano",
        "RMA": "Real Madrid", "RSO": "Sociedad", "SEV": "Sevilla",
        "VAL": "Valencia", "VIL": "Villarreal",
    },
    "seriea": {
        "ATA": "Atalanta", "BOL": "Bologna", "CAG": "Cagliari",
        "COM": "Como", "FIO": "Fiorentina", "FRO": "Frosinone",
        "GEN": "Genoa", "INT": "Inter", "JUV": "Juventus",
        "LAZ": "Lazio", "LEC": "Lecce", "MIL": "Milan",
        "MON": "Monza", "NAP": "Napoli", "PAR": "Parma",
        "ROM": "Roma", "SAS": "Sassuolo", "TOR": "Torino",
        "UDI": "Udinese", "VEN": "Venezia",
    },
    "ligue1": {
        "AJA": "Auxerre", "ASM": "Monaco", "ANG": "Angers",
        "BRE": "Brest", "FCL": "Lorient", "HAC": "Le Havre",
        "LEM": "Le Mans", "LIL": "Lille", "NIC": "Nice",
        "OL": "Lyon", "OM": "Marseille", "PAR": "Paris FC",
        "PSG": "Paris SG", "RCL": "Lens", "REN": "Rennes",
        "STR": "Strasbourg", "TFC": "Toulouse", "TRO": "Troyes",
    },
    "bundesliga": {
        "BMG": "M'gladbach", "BVB": "Dortmund", "ELV": "Elversberg",
        "FCA": "Augsburg", "FCB": "Bayern Munich", "FCU": "Union Berlin",
        "HOF": "Hoffenheim", "HSV": "Hamburg", "KOE": "FC Koln",
        "LEV": "Leverkusen", "M05": "Mainz", "PAD": "Paderborn",
        "RBL": "RB Leipzig", "S04": "Schalke 04", "SCF": "Freiburg",
        "SGE": "Ein Frankfurt", "SVW": "Werder Bremen",
        "VFB": "Stuttgart",
    },
}


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=30))
def _fetch_league(code: str) -> Optional[list]:
    """Récupère le JSON brut d'une ligue (None si code invalide)."""
    resp = requests.get(f"{BASE}?league={code}", headers=HEADERS, timeout=30)
    if resp.status_code != 200:
        return None
    try:
        data = resp.json()
    except ValueError:
        return None
    if isinstance(data, dict) and "error" in data:
        return None
    return data if isinstance(data, list) else None


def scrape_league(slug: str) -> dict:
    """Scrape une ligue et normalise vers le schéma public."""
    code = LEAGUES[slug]
    raw = _fetch_league(code) or []
    mapping = TEAM_MAP.get(slug, {})
    teams: dict[str, list] = {}
    unknown_abbrs: set[str] = set()
    known_abbrs: set[str] = set()
    for row in raw:
        abbr = (row.get("team") or "").strip()
        team = mapping.get(abbr)
        if team is None:
            # Abréviation inconnue : conservée telle quelle, jamais perdue.
            unknown_abbrs.add(abbr)
            team = abbr or "Inconnu"
        else:
            known_abbrs.add(abbr)
        entry = {
            "player": row.get("player") or " ".join(
                p for p in [row.get("firstname"), row.get("lastname")] if p
            ).strip(),
            "position": row.get("position"),
            "injury": row.get("injury"),
            "status": row.get("status"),
            # Date de retour : réservée abonnés ("Subscribers Only" en public).
            "returnDate": None,
        }
        teams.setdefault(team, []).append(entry)
    if unknown_abbrs:
        print(f"[{slug}] abréviations inconnues : {sorted(unknown_abbrs)}")
    now = datetime.now(timezone.utc).isoformat()
    all_abbrs = known_abbrs | unknown_abbrs
    return {
        "meta": {
            "leagueId": slug,
            "source": "rotowire",
            "sourceUrl": f"{BASE}?league={code}",
            "updatedAt": now,
            "playerCount": sum(len(v) for v in teams.values()),
            # Pas de date de retour en accès public (paywall RotoWire).
            "hasReturnDates": False,
            # Monitoring (Q12) : fraîcheur, volume, couverture mapping.
            "fetchedAt": now,
            "rowCount": len(raw),
            "coveragePct": round(100 * len(known_abbrs) / len(all_abbrs)) if all_abbrs else 0,
        },
        "teams": teams,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Scrape RotoWire injury report")
    parser.add_argument("--all", action="store_true", help="Toutes les ligues")
    parser.add_argument("--league", default=None, help="Slug ligue (ex: epl)")
    parser.add_argument("--output-dir", default="public/data/injuries")
    args = parser.parse_args()

    slugs = list(LEAGUES.keys()) if args.all else [args.league or "epl"]
    os.makedirs(args.output_dir, exist_ok=True)
    for slug in slugs:
        if slug not in LEAGUES:
            print(f"Ligue inconnue : {slug} (choix: {list(LEAGUES)})", file=sys.stderr)
            return 1
        data = scrape_league(slug)
        out = os.path.join(args.output_dir, f"{slug}.json")
        with open(out, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        print(f"[{slug}] {data['meta']['playerCount']} absents -> {out}")
        time.sleep(1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
