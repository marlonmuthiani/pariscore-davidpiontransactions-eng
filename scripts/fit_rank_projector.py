#!/usr/bin/env python3
"""
fit_rank_projector.py — Projection de classement fin de saison (ExtraTrees).

Réplication du volet régression du papier JISTA 2026
(doi:10.38016/jista.2000399) : AutoML/ExtraTreesRegressor sur features de
saison agrégées, walk-forward out-of-sample par saison, éval Spearman +
MAE points, baseline naive (extrapolation points) exigée.

Anti-leakage (papier) : aucun point final en entrée — features calculées à
frac de la saison, cible = points finaux.

Sorties :
  - public/data/rank-projector/{slug}.json  — projection courante par ligue
    (consommée par use-rank-projector + ProjectedStandingsCard)
  - data/rank-projector-report.json         — métriques walk-forward (faîtes foi)

Gate ship UI : Spearman moyen walk-forward @ frac 0.6 >= 0.85.

USAGE:
    python scripts/fit_rank_projector.py
"""

import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
from scipy.stats import spearmanr
from sklearn.ensemble import ExtraTreesRegressor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fit_powerscore_weights import (  # noqa: E402
    LEAGUES, PILOT_CODES, SEASONS, final_table, load_season, snapshot_features,
)

# ─── Config (documentée, stable) ──────────────────────────────────────────────
TRAIN_FRACS = [0.12, 0.2, 0.3, 0.45, 0.6, 0.75, 0.9]  # checkpoints de saison
GATE_FRAC = 0.6  # frac du walk-forward gate (milieu/fin de saison, papier)
FIRST_TEST_SEASON = 2022  # >= 4 saisons d'entraînement (2018-2021)
GATE_SPEARMAN = 0.85
CURRENT_SEASON = 2026  # saison en cours à projeter (2026/27)
EMISSION_MIN_FRAC = 0.10  # < 10 % de la saison jouée → status too_early
N_ESTIMATORS = 300
RANDOM_STATE = 42

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "public", "data", "rank-projector")
REPORT_PATH = os.path.join(ROOT, "data", "rank-projector-report.json")

# Features du modèle (extras issus de snapshot_features + avancement saison)
FEATURE_KEYS = [
    "form", "venue", "attack", "defense",       # socle PowerScore
    "ppg", "gd_pg", "win_pct", "away_ppg",      # état de la saison
    "cards_pg", "shots_pg",                     # discipline / domination
    "played", "frac",                           # contexte temporal
]


def row_vector(feats: dict, frac: float) -> list[float]:
    """Vecteur feature : None → NaN (imputation médiane côté fit)."""
    v = []
    for k in FEATURE_KEYS:
        if k == "frac":
            v.append(frac)
        else:
            val = feats.get(k)
            v.append(float(val) if val is not None else float("nan"))
    return v


# ─── Dataset ─────────────────────────────────────────────────────────────────

def build_dataset() -> tuple[list[dict], dict]:
    """Rows = {league, season, frac, team, X[12], y=pts_finaux, rank}."""
    rows: list[dict] = []
    hist_matches: dict[str, list[int]] = {}
    for code in PILOT_CODES:
        slug = LEAGUES[code]
        for season in SEASONS:
            matches = load_season(code, season)
            if not matches:
                continue
            hist_matches.setdefault(slug, []).append(len(matches))
            table = final_table(matches)
            for frac in TRAIN_FRACS:
                feats = snapshot_features(matches, frac)
                for team, f in feats.items():
                    fin = table.get(team)
                    if fin is None:
                        continue
                    rows.append({
                        "league": slug, "season": season, "frac": frac,
                        "team": team, "X": row_vector(f, frac),
                        "y": float(fin["pts"]), "rank": fin["rank"],
                    })
            print(f"  [ok] {slug} {season}")
    # Taille typique de saison (médiane) → calcul frac de la saison courante
    expected = {s: float(np.median(v)) for s, v in hist_matches.items()}
    return rows, expected


def impute_fit(X: np.ndarray) -> np.ndarray:
    """Imputation médiane par colonne (NaN → médiane d'entraînement)."""
    X = X.copy()
    for j in range(X.shape[1]):
        col = X[:, j]
        mask = np.isnan(col)
        if mask.any() and not mask.all():
            col[mask] = np.nanmedian(col)
        elif mask.all():
            col[:] = 0.0
        X[:, j] = col
    return X


def train_model(rows: list[dict]) -> tuple[ExtraTreesRegressor, np.ndarray]:
    X = impute_fit(np.array([r["X"] for r in rows], dtype=float))
    y = np.array([r["y"] for r in rows], dtype=float)
    model = ExtraTreesRegressor(
        n_estimators=N_ESTIMATORS, random_state=RANDOM_STATE, n_jobs=-1)
    model.fit(X, y)
    medians = np.array([np.nanmedian(np.array([r["X"][j] for r in rows], dtype=float))
                        for j in range(len(FEATURE_KEYS))])
    return model, medians


def apply_medians(X: np.ndarray, medians: np.ndarray) -> np.ndarray:
    X = X.copy()
    for j in range(X.shape[1]):
        X[np.isnan(X[:, j]), j] = medians[j] if np.isfinite(medians[j]) else 0.0
    return X


def eval_split(test_rows: list[dict], model, medians) -> dict:
    """Spearman (rang prédit vs rang réel) + MAE points + baseline naive."""
    X = apply_medians(np.array([r["X"] for r in test_rows], dtype=float), medians)
    pred = model.predict(X)
    true_pts = np.array([r["y"] for r in test_rows], dtype=float)
    true_rank = np.array([r["rank"] for r in test_rows], dtype=float)
    # Rang prédit : tri des points prédits (désordes → même tie-break GD implicite)
    order = np.argsort(-pred, kind="stable")
    pred_rank = np.empty_like(order, dtype=float)
    pred_rank[order] = np.arange(1, len(order) + 1)
    rho_rank, _ = spearmanr(-pred_rank, -true_rank)  # positif = bon
    rho_pts, _ = spearmanr(pred, true_pts)
    # Naive : points extrapolés points_si_frac / frac (meilleur repost précoce)
    naive = np.array([r["y"] / max(r["frac"], 1e-6) * r["frac"] for r in test_rows])
    # équivalent : y lui-même → naive = snapshot pts. Extrapolation linéaire :
    naive = np.array([r["X"][FEATURE_KEYS.index("ppg")] * r["X"][FEATURE_KEYS.index("played")]
                      / max(r["frac"], 1e-6) for r in test_rows], dtype=float)
    naive = np.nan_to_num(naive, nan=float(np.mean(true_pts)))
    rho_naive, _ = spearmanr(naive, true_pts)
    return {
        "n": len(test_rows),
        "spearman_rank": round(float(rho_rank), 4),
        "spearman_pts": round(float(rho_pts), 4),
        "mae_pts": round(float(np.mean(np.abs(pred - true_pts))), 2),
        "naive_spearman_pts": round(float(rho_naive), 4),
        "naive_mae_pts": round(float(np.mean(np.abs(naive - true_pts))), 2),
        "_pred_rank": pred_rank,  #stri avant écriture JSON
    }


# ─── Walk-forward ────────────────────────────────────────────────────────────

def walk_forward(rows: list[dict]) -> dict:
    per_season = []
    for test in range(FIRST_TEST_SEASON, max(SEASONS) + 1):
        train = [r for r in rows if r["season"] < test]
        test_rows = [r for r in rows if r["season"] == test]
        if not train or not test_rows:
            continue
        model, medians = train_model(train)
        entry: dict = {"test_season": f"{test}/{str(test + 1)[2:]}",
                       "train_seasons": len({r["season"] for r in train}),
                       "by_frac": {}}
        for frac in TRAIN_FRACS:
            sub = [r for r in test_rows if r["frac"] == frac]
            if not sub:
                continue
            m = eval_split(sub, model, medians)
            m.pop("_pred_rank", None)
            entry["by_frac"][str(frac)] = m
        per_season.append(entry)
        g = entry["by_frac"].get(str(GATE_FRAC), {})
        print(f"  [wf] {entry['test_season']}: spearman@{GATE_FRAC}="
              f"{g.get('spearman_rank', '?')} mae={g.get('mae_pts', '?')}")

    # Agrégats par frac
    by_frac: dict[str, dict] = {}
    for frac in TRAIN_FRACS:
        key = str(frac)
        vals = [e["by_frac"][key] for e in per_season if key in e["by_frac"]]
        if not vals:
            continue
        by_frac[key] = {
            "spearman_rank_mean": round(float(np.mean([v["spearman_rank"] for v in vals])), 4),
            "mae_pts_mean": round(float(np.mean([v["mae_pts"] for v in vals])), 2),
            "naive_spearman_mean": round(float(np.mean([v["naive_spearman_pts"] for v in vals])), 4),
            "naive_mae_mean": round(float(np.mean([v["naive_mae_pts"] for v in vals])), 2),
        }
    gate_val = by_frac.get(str(GATE_FRAC), {}).get("spearman_rank_mean", 0.0)
    return {"per_season": per_season, "by_frac": by_frac,
            "gate": {"frac": GATE_FRAC, "spearman_mean": gate_val,
                     "threshold": GATE_SPEARMAN, "passed": gate_val >= GATE_SPEARMAN}}


# ─── Émission saison courante ────────────────────────────────────────────────

def project_current(model, medians, expected: dict) -> dict[str, dict]:
    """Projette la saison courante par ligue → JSON {meta, teams}."""
    out: dict[str, dict] = {}
    for code in PILOT_CODES:
        slug = LEAGUES[code]
        matches = load_season(code, CURRENT_SEASON, min_matches=15)
        if not matches:
            out[slug] = {"league": slug, "meta": {"status": "no_data"},
                         "teams": []}
            continue
        exp = expected.get(slug) or float(len(matches))
        frac_now = min(len(matches) / exp, 1.0)
        if frac_now < EMISSION_MIN_FRAC:
            out[slug] = {"league": slug,
                         "meta": {"status": "too_early",
                                  "snapshot_frac": round(frac_now, 3),
                                  "snapshot_matches": len(matches)},
                         "teams": []}
            continue
        table_now = final_table(matches)
        feats = snapshot_features(matches, 1.0)  # toute la saison jouée à ce jour
        rows_now = []
        for team, f in feats.items():
            if team not in table_now:
                continue
            rows_now.append({"team": team, "X": row_vector(f, frac_now),
                             "cur_pts": table_now[team]["pts"],
                             "cur_rank": table_now[team]["rank"]})
        X = apply_medians(np.array([r["X"] for r in rows_now], dtype=float), medians)
        pred = model.predict(X)
        order = np.argsort(-pred, kind="stable")
        proj_rank = {i: r + 1 for r, i in enumerate(order)}
        teams = []
        for i, r in enumerate(rows_now):
            teams.append({
                "team": r["team"],
                "currentRank": r["cur_rank"],
                "currentPts": r["cur_pts"],
                "projectedPts": round(float(pred[i]), 1),
                "projectedRank": int(proj_rank[i]),
                "delta": int(r["cur_rank"]) - int(proj_rank[i]),  # + = montera
            })
        teams.sort(key=lambda t: t["projectedRank"])
        phase = ("early" if frac_now < 0.3 else
                 "mid" if frac_now < 0.7 else "late")
        out[slug] = {
            "league": slug,
            "meta": {
                "status": "ok",
                "season": f"{CURRENT_SEASON}/{str(CURRENT_SEASON + 1)[2:]}",
                "model": f"ExtraTrees(n={N_ESTIMATORS})",
                "snapshot_frac": round(frac_now, 3),
                "snapshot_matches": len(matches),
                "expected_matches": int(exp),
                "phase": phase,
            },
            "teams": teams,
        }
    return out


# ─── Main ────────────────────────────────────────────────────────────────────

def main() -> int:
    print("Construction dataset (5 ligues x 8 saisons x 7 fracs)...")
    rows, expected = build_dataset()
    if not rows:
        open(REPORT_PATH, "w", encoding="utf-8").write(
            json.dumps({"error": "aucune donnée"}, ensure_ascii=False))
        return 1

    print("Walk-forward par saison...")
    wf = walk_forward(rows)

    print("Modèle final (tout l'historique) + émission saison courante...")
    model, medians = train_model(rows)
    projections = project_current(model, medians, expected)

    os.makedirs(OUT_DIR, exist_ok=True)
    for slug, payload in projections.items():
        # Métriques walk-forward globales attachées à chaque payload ligue
        payload["meta"]["walkforward"] = {
            "spearman_gate": wf["gate"]["spearman_mean"],
            "naive_spearman": wf["by_frac"].get(str(GATE_FRAC), {}).get("naive_spearman_mean"),
            "gate_frac": GATE_FRAC,
        }
        payload["meta"]["generated_at"] = datetime.now(timezone.utc).isoformat()
        payload["meta"]["paper"] = "JISTA 2026 AutoML (doi:10.38016/jista.2000399)"
        path = os.path.join(OUT_DIR, f"{slug}.json")
        open(path, "w", encoding="utf-8").write(
            json.dumps(payload, ensure_ascii=False, indent=1))

    report = {
        "meta": {
            "source": "football-data.co.uk",
            "paper": "JISTA 2026 AutoML season-level ranking (doi:10.38016/jista.2000399)",
            "model": f"ExtraTreesRegressor(n_estimators={N_ESTIMATORS})",
            "features": FEATURE_KEYS,
            "train_fracs": TRAIN_FRACS,
            "target": "points finaux",
            "anti_leakage": "features à frac de saison, aucun point final en entrée",
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
        "walkforward": wf,
        "emissions": {s: p["meta"].get("status") for s, p in projections.items()},
    }
    open(REPORT_PATH, "w", encoding="utf-8").write(
        json.dumps(report, ensure_ascii=False, indent=1))
    print(f"gate spearman@{GATE_FRAC}={wf['gate']['spearman_mean']} "
          f"({'PASS' if wf['gate']['passed'] else 'FAIL'}) -> {REPORT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
