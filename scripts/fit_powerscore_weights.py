#!/usr/bin/env python3
"""
fit_powerscore_weights.py — Apprend les poids du PowerScore foot (offline).

Inspiré de : "An AutoML-Based Framework for Season-Level League Ranking
Prediction in Professional Football" (JISTA, 15/09/2026, doi:10.38016/jista.2000399)
— walk-forward par saison, features sans leakage cible, éval Spearman.

Objectif : remplacer les poids hardcodés de footballPowerScore
(src/lib/power-score.ts : form 30 / venue 20 / attack 20 / defense 15)
par des poids appris, SI le gate est passé :
    Spearman_appris >= Spearman_mains + 0.02 (moyenne walk-forward).

Méthode :
  - Snapshot à SNAPSHOT_FRACTION des matchs de la saison (anti-leakage :
    aucun point final en entrée).
  - Features PowerScore foot (mêmes transforms 0-100 que le TS :
    attackScore/defenseScore/clamp100) — H2H exclu (pairwise, non
    calculable au niveau équipe → exclu des deux côtés, comparaison équitable).
  - Cible : points finaux (Spearman) — le rang est monotonique dedans.
  - Fit : SLSQP, poids >= 0, somme = 100 (scipy).
  - Walk-forward : pour chaque saison test t, fit sur toutes les saisons < t.

Sorties : data/powerscore_weights.json (+ écho en console, non capturé par
certains hâcheurs Windows — le JSON fait foi).

USAGE:
    python scripts/fit_powerscore_weights.py
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

import numpy as np
from scipy.optimize import minimize
from scipy.stats import spearmanr

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from scrape_football_data import LEAGUES, fetch_csv, parse_csv, season_two_digits  # noqa: E402

# ─── Config (documentée, stable) ──────────────────────────────────────────────
PILOT_CODES = ["E0", "F1", "SP1", "D1", "I1"]  # epl, ligue1, laliga, bundesliga, seriea
SEASONS = list(range(2018, 2026))  # 2018/19 → 2025/26 (saisons complètes)
SNAPSHOT_FRACTION = 0.65  # état de l'équipe après ~65 % de la saison
MIN_MATCHES = 150  # seuil de complétude d'une saison
GATE_DELTA = 0.02  # gain Spearman minimum pour remplacer les poids mains
FIRST_TEST_SEASON = 2021  # walk-forward : >= 3 saisons d'entraînement avant
LAMBDA_SWEEP = [0.0, 0.5, 1.0, 2.0, 5.0]  # ridge vers poids mains (0 = sans régul.)

# Poids mains actuels (TS) — H2H (15) exclu comme feature : comparaison équitable
HAND_W = {"form": 30.0, "venue": 20.0, "attack": 20.0, "defense": 15.0}
FEATURE_KEYS = ["form", "venue", "attack", "defense"]

OUT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "data", "powerscore_weights.json")
# Cache CSV (évite de re-télécharger à chaque run ; partagé avec fit_rank_projector.py)
CACHE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         "data", ".fd-cache")

# ─── Transforms (ports exacts de src/lib/power-score.ts) ─────────────────────

def clamp100(v: float) -> float:
    return min(95.0, max(5.0, v))


def attack_score(scored_pg: float) -> float:
    return clamp100(20.0 + scored_pg * 22.0)


def defense_score(conceded_pg: float, league_avg: float | None) -> float:
    base = 90.0 - conceded_pg * 22.0
    if league_avg is None:
        return clamp100(base)
    return clamp100(base + (league_avg - conceded_pg) * 8.0)


# ─── Chargement données ──────────────────────────────────────────────────────

def load_season(code: str, season: int, min_matches: int = MIN_MATCHES) -> list[dict]:
    """Télécharge + parse une saison football-data.co.uk (None si KO/incomplet)."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache = os.path.join(CACHE_DIR, f"{code}-{season}.csv")
    try:
        if os.path.exists(cache):
            text = open(cache, encoding="utf-8", errors="replace").read()
        else:
            url = f"https://www.football-data.co.uk/mmz4281/{season_two_digits(season)}/{code}.csv"
            text = fetch_csv(url)
            open(cache, "w", encoding="utf-8").write(text)
            time.sleep(0.4)  # politesse envers la source
    except Exception as e:  # noqa: BLE001
        print(f"  [!!] {code} {season}: {str(e)[:120]}", file=sys.stderr)
        return []
    matches = parse_csv(text, code, season)
    if len(matches) < min_matches:
        return []
    # Tri chronologique (dates ISO, None en fin)
    matches.sort(key=lambda m: m.get("date") or "9999-99-99")
    return matches


def final_table(matches: list[dict]) -> dict[str, dict]:
    """Classement final : points, diff, rang (tie-break GD puis buts marqués)."""
    teams: dict[str, dict] = {}
    for m in matches:
        h, a = m["homeTeam"], m["awayTeam"]
        for t in (h, a):
            teams.setdefault(t, {"team": t, "pts": 0, "gf": 0, "ga": 0, "pl": 0})
        hg, ag = m["fthg"], m["ftag"]
        teams[h]["gf"] += hg; teams[h]["ga"] += ag; teams[h]["pl"] += 1
        teams[a]["gf"] += ag; teams[a]["ga"] += hg; teams[a]["pl"] += 1
        if hg > ag:
            teams[h]["pts"] += 3
        elif hg < ag:
            teams[a]["pts"] += 3
        else:
            teams[h]["pts"] += 1; teams[a]["pts"] += 1
    ranked = sorted(teams.values(), key=lambda t: (t["pts"], t["gf"] - t["ga"], t["gf"]),
                    reverse=True)
    n = len(ranked)
    for i, t in enumerate(ranked):
        t["rank"] = i + 1
        # Cible percentile 0-100 (1er = 100) — Spearman invariant, lecture plus simple
        t["y"] = (n - t["rank"]) / (n - 1) * 100.0 if n > 1 else 50.0
    return {t["team"]: t for t in ranked}


def snapshot_features(matches: list[dict], frac: float) -> dict[str, dict]:
    """Features à l'instant t = frac des matchs (anti-leakage).

    Chaque équipe porte les 4 features PowerScore (form/venue/attack/defense)
    + des extras scalaires exploités par fit_rank_projector.py (pts, w/d/l,
    split dom/ext, cartons, tirs) — B1 n'utilise que les 4 clés PS.
    """
    cut = max(1, int(len(matches) * frac))
    pre = matches[:cut]
    teams: dict[str, dict] = {}
    history: dict[str, list[int]] = {}  # forme : 1/0/0.5 par match rejoué, chronologique
    total_goals = 0.0

    def acc(t: str) -> dict:
        if t not in teams:
            teams[t] = {"team": t, "pts": 0, "gf": 0, "ga": 0, "pl": 0,
                        "hpts": 0, "hpl": 0, "apts": 0, "apl": 0,
                        "w": 0, "d": 0, "l": 0, "cards": 0.0, "shots": 0.0,
                        "shots_n": 0}
        return teams[t]

    for m in pre:
        h, a = m["homeTeam"], m["awayTeam"]
        hg, ag = m["fthg"], m["ftag"]
        total_goals += hg + ag
        th, ta = acc(h), acc(a)
        th["gf"] += hg; th["ga"] += ag; th["pl"] += 1
        ta["gf"] += ag; ta["ga"] += hg; ta["pl"] += 1
        th["hpl"] += 1
        ta["apl"] += 1
        if hg > ag:
            th["pts"] += 3; th["hpts"] += 3
            th["w"] += 1; ta["l"] += 1
            res_h, res_a = 1, 0
        elif hg < ag:
            ta["pts"] += 3; ta["apts"] += 3
            ta["w"] += 1; th["l"] += 1
            res_h, res_a = 0, 1
        else:
            th["pts"] += 1; th["hpts"] += 1
            ta["pts"] += 1; ta["apts"] += 1
            th["d"] += 1; ta["d"] += 1
            res_h, res_a = 0.5, 0.5
        # Extras (optionnels selon la saison source)
        cards = (m.get("hy") or 0) + (m.get("ay") or 0)
        th["cards"] += (m.get("hy") or 0)
        ta["cards"] += (m.get("ay") or 0)
        _ = cards
        if m.get("hs") is not None and m.get("as") is not None:
            th["shots"] += m["hs"]; ta["shots"] += m["as"]
            th["shots_n"] += 1; ta["shots_n"] += 1
        history.setdefault(h, []).append(res_h)
        history.setdefault(a, []).append(res_a)

    n_matches = len(pre)
    if n_matches == 0:
        return {}
    # Moyenne ligue buts/match/équipe (symétrie attaque=défense, comme le TS)
    league_avg = total_goals / n_matches if n_matches else None

    out: dict[str, dict] = {}
    for t, v in teams.items():
        if v["pl"] < 3:
            continue
        scored_pg = v["gf"] / v["pl"]
        conceded_pg = v["ga"] / v["pl"]
        last5 = (history.get(t) or [])[-5:]
        form_ppg = (sum(last5) / len(last5) * 3.0) if last5 else None  # 0-3
        venue_ppg = (v["hpts"] / v["hpl"]) if v["hpl"] else None
        atk = attack_score(
            (scored_pg / league_avg) * 1.5 if league_avg and league_avg > 0 else scored_pg
        )
        dfn = defense_score(conceded_pg, league_avg)
        out[t] = {
            "form": clamp100((form_ppg / 3.0) * 100.0) if form_ppg is not None else None,
            "venue": clamp100((venue_ppg / 3.0) * 100.0) if venue_ppg is not None else None,
            "attack": atk,
            "defense": dfn,
            "played": v["pl"],
            "ppg": v["pts"] / v["pl"],
            "gd_pg": (v["gf"] - v["ga"]) / v["pl"],
            # ── extras (projector) ──
            "pts": v["pts"],
            "win_pct": v["w"] / v["pl"],
            "away_ppg": (v["apts"] / v["apl"]) if v["apl"] else None,
            "cards_pg": v["cards"] / v["pl"],
            "shots_pg": (v["shots"] / v["shots_n"]) if v["shots_n"] else None,
        }
    return out


# ─── Dataset ─────────────────────────────────────────────────────────────────

def build_dataset() -> tuple[list[dict], dict]:
    """Rows = {league, season, team, feats{}, y, pts, rank} sur toutes les saisons."""
    rows: list[dict] = []
    meta_seasons: dict[str, list[int]] = {}
    for code in PILOT_CODES:
        slug = LEAGUES[code]
        got = []
        for season in SEASONS:
            matches = load_season(code, season)
            if not matches:
                continue
            feats = snapshot_features(matches, SNAPSHOT_FRACTION)
            table = final_table(matches)
            n_ok = 0
            for team, f in feats.items():
                fin = table.get(team)
                if fin is None:
                    continue
                rows.append({
                    "league": slug, "season": season, "team": team,
                    "feats": f, "y": fin["y"], "pts": fin["pts"], "rank": fin["rank"],
                })
                n_ok += 1
            if n_ok:
                got.append(season)
            print(f"  [ok] {slug} {season}: {n_ok} équipes")
        meta_seasons[slug] = got
    return rows, meta_seasons


def feature_matrix(rows: list[dict]) -> np.ndarray:
    return np.array([[r["feats"][k] for k in FEATURE_KEYS] for r in rows], dtype=float)


def fit_weights(rows: list[dict], lam: float) -> np.ndarray:
    """SLSQP : min MSE(X@w/100, y) + lam*||w - w_mains||^2, s.c. somme=100, w>=0.

    Le ridge vers les poids produit (définis produit, stables) évite la solution
    dégénée 100 % venue typique d'une fit sans régularisation sur features
    collinéaires (venue/attack/forme corrélés ~0.8+).
    """
    X = feature_matrix(rows)
    y = np.array([r["y"] for r in rows], dtype=float)
    w0 = np.array([HAND_W[k] for k in FEATURE_KEYS], dtype=float)
    w0 = w0 / w0.sum() * 100.0

    def loss(w: np.ndarray) -> float:
        mse = float(np.mean((X @ w / 100.0 - y) ** 2))
        return mse + lam * float(np.sum((w - w0) ** 2))

    res = minimize(loss, w0, method="SLSQP",
                   bounds=[(0.0, 100.0)] * len(FEATURE_KEYS),
                   constraints={"type": "eq", "fun": lambda w: w.sum() - 100.0},
                   options={"maxiter": 500, "ftol": 1e-10})
    w = res.x if res.success else w0
    return np.clip(w, 0.0, None) / max(np.clip(w, 0.0, None).sum(), 1e-9) * 100.0


def spearman_pred(rows: list[dict], w: np.ndarray) -> float:
    X = feature_matrix(rows)
    pts = np.array([r["pts"] for r in rows], dtype=float)
    rho, _ = spearmanr(X @ w / 100.0, pts)
    return float(rho)


def hand_vector() -> np.ndarray:
    w = np.array([HAND_W[k] for k in FEATURE_KEYS], dtype=float)
    return w / w.sum() * 100.0


# ─── Walk-forward + sortie ───────────────────────────────────────────────────

def main() -> int:
    print("Chargement dataset (football-data.co.uk, 5 ligues x 8 saisons)...")
    rows, meta_seasons = build_dataset()
    if not rows:
        out = {"error": "aucune donnée chargée (réseau ?)"}
        open(OUT_PATH, "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False, indent=1))
        return 1

    # Sweep de régularisation : on garde le λ au meilleur Spearman walk-forward
    # (désintéressement : le choix de λ n'utilise pas le test final).
    sweep = []
    for lam in LAMBDA_SWEEP:
        sp = []
        for test in range(FIRST_TEST_SEASON, max(SEASONS) + 1):
            train = [r for r in rows if r["season"] < test]
            test_rows = [r for r in rows if r["season"] == test]
            if not train or not test_rows:
                continue
            sp.append(spearman_pred(test_rows, fit_weights(train, lam)))
        mean_sp = float(np.mean(sp)) if sp else -1.0
        w_all = fit_weights(rows, lam)
        sweep.append({
            "lambda": lam,
            "spearman_mean": round(mean_sp, 4),
            "weights": {k: round(float(v), 1) for k, v in zip(FEATURE_KEYS, w_all)},
        })
        print(f"  [sweep] lambda={lam}: spearman={mean_sp:.4f} "
              f"w={sweep[-1]['weights']}")
    best = max(sweep, key=lambda s: s["spearman_mean"])
    lam_best = float(best["lambda"])

    walk = []
    for test in range(FIRST_TEST_SEASON, max(SEASONS) + 1):
        train = [r for r in rows if r["season"] < test]
        test_rows = [r for r in rows if r["season"] == test]
        if not train or not test_rows:
            continue
        w_fit = fit_weights(train, lam_best)
        walk.append({
            "test_season": f"{test}/{str(test + 1)[2:]}",
            "train_seasons": len({r["season"] for r in train}),
            "n_test_teams": len(test_rows),
            "spearman_hand": round(spearman_pred(test_rows, hand_vector()), 4),
            "spearman_learned": round(spearman_pred(test_rows, w_fit), 4),
            "weights": {k: round(float(v), 1) for k, v in zip(FEATURE_KEYS, w_fit)},
        })
        print(f"  [wf] {test}: hand={walk[-1]['spearman_hand']:.3f} "
              f"learned={walk[-1]['spearman_learned']:.3f}")

    if not walk:
        out = {"error": "walk-forward vide", "seasons_loaded": meta_seasons}
        open(OUT_PATH, "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False, indent=1))
        return 1

    mean_hand = float(np.mean([w["spearman_hand"] for w in walk]))
    mean_learned = float(np.mean([w["spearman_learned"] for w in walk]))
    delta = mean_learned - mean_hand
    gate_passed = delta >= GATE_DELTA

    # Poids finaux : fit sur TOUT l'historique (ceux à baker si gate OK)
    w_final = fit_weights(rows, lam_best)
    final_weights = {k: round(float(v), 1) for k, v in zip(FEATURE_KEYS, w_final)}
    # Renormalisation d'affichage (somme exacte 100)
    s = sum(final_weights.values())
    final_weights = {k: round(v * 100.0 / s, 1) for k, v in final_weights.items()}

    # ─── Décision produit (règle déterministe) ────────────────────────────────
    # Un gate "PASS" obtenu uniquement avec une solution dégénée (poids à 0 sur
    # une métrique affichée en UI) n'est pas bakerable : on garde les poids
    # mains. Idem si la fit régularisée (non dégénérée) ne bat pas les mains.
    degenerate = any(w <= 0.0 for w in final_weights.values())
    reg_means = [s_["spearman_mean"] for s_ in sweep if s_["lambda"] > 0]
    best_reg = max(reg_means) if reg_means else -1.0
    if gate_passed and not degenerate:
        action = "bake_learned"
        reason = "gate PASS avec poids non dégénérés"
    elif degenerate and best_reg >= mean_hand + GATE_DELTA:
        action = "bake_regularized"
        reason = f"solution dégénérée écartée, fit régularisé passe le gate (lambda sweep)"
        final_weights = next(
            s_["weights"] for s_ in sweep
            if s_["lambda"] > 0 and s_["spearman_mean"] == best_reg)
    else:
        action = "keep_hand_weights"
        reason = (
            f"gate {'PASS' if gate_passed else 'FAIL'} mais solution "
            f"{'dégénérée (poids 0) ' if degenerate else ''}et fit régularisée "
            f"({best_reg:.4f}) ne gagne pas +{GATE_DELTA} vs mains ({mean_hand:.4f}) "
            "→ poids produit confirmés par les données"
        )
    decision = {"action": action, "reason": reason,
                "runtime_change": action != "keep_hand_weights"}

    report = {
        "meta": {
            "source": "football-data.co.uk",
            "paper": "JISTA 2026 AutoML season-level ranking (doi:10.38016/jista.2000399)",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "leagues": [LEAGUES[c] for c in PILOT_CODES],
            "seasons": meta_seasons,
            "snapshot_fraction": SNAPSHOT_FRACTION,
            "features": FEATURE_KEYS,
            "target": "points finaux (Spearman)",
            "note_h2h": "H2H exclu des deux côtés (feature pairwise, non comparable au niveau équipe)",
            "gate": f"learned >= hand + {GATE_DELTA} (Spearman moy. walk-forward)",
            "regularization": f"ridge vers poids mains, lambda_best={lam_best} (sweep)",
        },
        "lambda_sweep": sweep,
        "walkforward": walk,
        "summary": {
            "spearman_hand_mean": round(mean_hand, 4),
            "spearman_learned_mean": round(mean_learned, 4),
            "delta": round(delta, 4),
            "gate_passed": gate_passed,
        },
        "hand_weights": HAND_W,
        "final_weights": final_weights,
        "decision": decision,
        "ts_snippet": (
            "// Poids appris — scripts/fit_powerscore_weights.py\n"
            + "\n".join(
                f'    {{ key: "{k}", label: "{ {"form": "Forme (PPG)", "venue": "Dom./Ext.", "attack": "Attaque", "defense": "Défense"}[k] }", '
                f"weight: {final_weights[k]}, value: { {"form": "form", "venue": "venue", "attack": "atk", "defense": "def"}[k] } }},"
                for k in FEATURE_KEYS
            )
        ),
    }
    open(OUT_PATH, "w", encoding="utf-8").write(json.dumps(report, ensure_ascii=False, indent=1))
    print(f"hand={mean_hand:.4f} learned={mean_learned:.4f} delta={delta:+.4f} "
          f"gate={'PASS' if gate_passed else 'FAIL'} decision={action} -> {OUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
