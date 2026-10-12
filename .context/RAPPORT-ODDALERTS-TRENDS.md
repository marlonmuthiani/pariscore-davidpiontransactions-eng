# RAPPORT — OddAlerts Trends & Architecture du Sous-Onglet « Tendances » (Football)

> Mission du 2026-10-12 · Source analysée : `https://www.oddalerts.com/trends`
> (page « Football Betting Stats & Trends », fetch local direct, contenu intégral
> de 778+ lignes analysé).

## 1. Ce que fait la page OddAlerts `/trends`

- **Couverture annoncée** : 50 000+ matchs/an, 100+ ligues mondiales, stats
  recalculées **toutes les 6 h** ; liste des fixtures reconstruite toutes les
  10 min (cotes live + coup d'envoi).
- **Principe** : pour chaque marché (BTTS, Over/Under buts, 1X2, corners,
  cartons, mi-temps…), la page liste les **fixtures à venir** dont l'équipe /
  la ligue satisfait le marché à un taux élevé sur la saison en cours.
- **Monétisation** : 5 fixtures visibles par carte, le reste derrière Pro
  (£19.99/mo) — noms d'équipes masqués sur la version gratuite, « Edge »
  réservé, streak badges réservés, alertes bulk réservées.

### 1.1 Vues exposées

| Onglet | Contenu |
|---|---|
| **All trends** | Grille de cartes par marché (Home Wins, Draws, Away Wins, BTTS, O/U 1.5/2.5/3.5, 1H Goals, O8.5 corners, U10 corners, 2+ Team Cards…) |
| **Trend Stacker** | Combinaison de plusieurs tendances sur un même match (rendu client-side / Pro) |
| **Hot Streaks** | Séries en cours (momentum arrows & streak badges — fenêtre 7 jours, Pro) |
| **By league** | Groupement par championnat |

### 1.2 Catalogue des marchés (menu « Browse trends », regroupé)

- **Résultats** : Home Wins · Draws · Away Wins · PPG · Won/Draw/Lost at HT ·
  HT Result Home/Away
- **Buts (match)** : BTTS · BTTS (No) · BTTS & 2.5+ · BTTS or 2.5+ · BTTS 1H/2H ·
  Bore Draw · 1.5+ / 2.5+ / 3.5+ Goals · −2.5 / −3.5 Goals · 1.5+ Team Goals ·
  0.5+ Team Goals · 1.5+ Conceded · Late Goals · Failed to Score · Clean Sheet ·
  Half with Most Goals
- **Buts (mi-temps)** : 1H Goals · 1.5+ 1H Goals · −0.5 1H Goals · 2H Goals ·
  1.5+ 2H Goals · 1H Highest Scoring
- **Corners** : 1H Corners · 8+ Corners · −10 Corners · 11+ Corners
- **Cartons** : 2+ Team Cards · 4+ Cards · 5+ Cards

### 1.3 Structure d'une carte de tendance (anatomie d'une ligne)

Colonnes par marché : **`%` | `Odds` | `Edge`** (certains marchés n'exposent
que `% | Odds`, d'autres que `%`).

| Champ | Format observé | Sémantique |
|---|---|---|
| Date/heure | `Wed, 17:00` / `20:00` / live `2-0 18'` | Coup d'envoi (ou score live) |
| Compétition | `Germany · Regionalliga: Bayern` | Pays · Ligue (noms d'équipes masqués en gratuit) |
| Stat | `5+ 10/11` ou `12/16` | `N+` = seuil du marché ; `X/Y` = X matchs satisfaisant le marché sur Y joués (saison) |
| **%** | `91` | Hit rate = X/Y arrondi — la statistique mise en avant |
| **Odds** | `1.25` | Cote bookmaker actuelle du marché |
| **Edge** | `+11` | `hit rate − probabilité implicite de la cote` (1.25 → 80 % implicite ; 91 − 80 = +11) |

Règle FAQ OddAlerts : « matchs terminés satisfaisant la condition du marché
cette saison, divisés par le total de matchs joués », avec splits
domicile/extérieur/général.

### 1.4 Filtres & fraîcheur

- Favoris (étoile sur chaque marché pour personnaliser la page).
- Alertes bulk : hit rate minimum (%), cote maximum, cote cible (notification).
- Fraîcheur : stats 6 h, fixtures 10 min.

## 2. État de nos données locales (audit pariscore.db, 2026-10-12)

| Source | Contenu | Granularité | Verdict |
|---|---|---|---|
| `league_season_stats` (1 582 ligues, dont 144 avec `gamesPlayed > 10` et sections complètes) | `statsJson` : sections `general`, `over_under`, `halves`, `cards`, `btts`, `corners` avec `value`/`pct`/`avg` par marché — **exactement les hit rates OddAlerts par ligue** | Ligue / saison | ✅ source principale |
| `league_season_stats.fixturesJson` | 1 à 5 fixtures à venir par ligue : équipes, badges, cotes 1X2 | Match | ✅ jointure « prochain match » |
| `public/data/form/*.json` (8 ligues, soccerstats) | W/D/L, GF/GA par équipe (domicile/extérieur, agrégats saison) | Équipe | complément partiel, pas de séquences |
| `match_stats_history`, `corner_history` | 0 lignes — schéma prêt, non peuplé | Match | ❌ vide |
| `vitibet_tips` | handball uniquement (`sport = 'hazena'`), 10 j de profondeur | — | ❌ hors football |
| `basketball/handball_match_history` | historiques basket/handball seulement | — | ❌ hors football |

**Conclusion** : pariscore.db ne contient **aucun historique de matchs football
par équipe** → les séries « N derniers matchs » par équipe (pattern
`10/11` d'OddAlerts) ne sont pas calculables localement aujourd'hui. La
granularité fiable disponible est **la ligue** : hit rate saison par marché,
exactement la donnée qui alimente les cartes OddAlerts.

## 3. Architecture retenue pour PariScore

### 3.1 Modèle (granularité ligue, honnête et documentée)

Pour chaque **marché du catalogue** et chaque **ligue** :

```
hitRate = round(100 × value / gamesPlayed)        // = champ `pct` d'OddAlerts
edge    = hitRate − round(100 / cote_1X2)         // uniquement marchés résultats
          (mapping : home_wins → odds.home, draws → odds.draw, away_wins → odds.away)
```

Une « tendance » = ligue dont `hitRate ≥ 55 %` sur `gamesPlayed ≥ 6`, triée par
hit rate décroissant. Chaque tendance embarque le **prochain fixture** de la
ligue (équipes, badges, coup d'envoi, cotes 1X2) pour reproduire la carte
OddAlerts « ligue + % + prochain match ».

### 3.2 Catalogue des marchés implémentés (v1)

| Catégorie UI | Marchés (`statsJson` keys) |
|---|---|
| **Résultats** | `home_wins`, `draws`, `away_wins` (edge calculable) |
| **Buts** | `over_1_5_goals`, `over_2_5_goals`, `over_3_5_goals`, `btts`, `btts_2_5_goals`, `over_0_5_1h_goals`, `over_1_5_1h_goals` |
| **Corners** | `over_7_5_corners`, `over_8_5_corners`, `over_9_5_corners` |
| **Cartons** | `over_3_5_cards`, `over_4_5_cards` |

### 3.3 Chaîne technique

```
pariscore.db (readonly, bun:sqlite → better-sqlite3 fallback)
  └─ src/lib/stats/football-trends-service.ts   (calcul hit rates + edge + fixture)
      └─ GET /api/football/trends?category=…   (cache 30 min, max-age public)
          └─ src/hooks/use-football-trends.ts   (SWR, dedup 30 min)
              └─ src/components/football/football-trends-view.tsx
                  (filtres par catégorie, cartes ligue + % + prochain match + edge)
```

Câblage navigation : `trends` ajouté à `FootballSubTab` +
`FOOTBALL_SUB_TABS` (rangée interne) + `SPORT_SUB_TABS.football` (rangée
header Flashscore) + rendu dans `football-tab-content.tsx` via
`FootballSubTabPanel sub="trends"`.

### 3.4 UI recommandée (implémentée)

- **Boutons de filtre** : Tous / Résultats / Buts / Corners / Cartons.
- **Carte par marché** : header marché, puis lignes ligue :
  drapeau pays (`CountryFlag` SVG local) + logo ligue + nom, `X/Y · P %`
  (série saison), cote 1X2 mappée, **badge edge** (vert si > 0, neutre sinon),
  prochain match (badges équipes + kickoff).
- Responsive mobile-first : 1 colonne mobile, 2 desktop ; scroll-x du filtre.
- Style FotMob light (`fotmob-tokens`), cohérent avec les autres sous-onglets.

## 4. Formules de probabilité / série (spécification)

1. **Hit rate ligue** : `pct = round(100 · matchs_satisfaisants / matchs_joués)`
   — identique à OddAlerts (FAQ : « completed matches that satisfied each
   market's condition this season, divided by total games played »).
2. **Probabilité implicite** : `pImp = 100 / cote` (non dévigée, comme OddAlerts).
3. **Edge** : `edge = pct − pImp` — affiché en points, préfixé `+`.
4. **Seuil de tendance** : `pct ≥ 55` et `gamesPlayed ≥ 6` (évite le bruit
   des saisons à 2-3 journées ; recalibrable en paramètre du service).
5. **Série par équipe (route future)** : quand une table
   `football_match_history` sera peuplée, la formule OddAlerts « série active »
   devient : compter depuis le match le plus récent le nombre consécutif de
   matchs satisfaisant le marché (streak), et le hit rate `X/Y` reste le
   taux saison. → Voir §6 roadmap.

## 5. Différences assumées vs OddAlerts (ponytail)

- **Granularité ligue, pas équipe** : nos cartes portent le hit rate de la
  LIGUE, pas de l'équipe — OddAlerts fait pareil sur ses cartes par défaut
  (« 12/16 » = forme de l'équipe, mais les noms sont masqués en gratuit).
  `ponytail: pas d'historique football par équipe en base — brancher
  football_match_history (§6) pour passer en granularité équipe.`
- **Pas de cotes corners/cartons/buts** : `fixturesJson` ne porte que le 1X2 →
  l'edge n'est calculé que sur les marchés Résultats.
- **Pas de streak badges 7 jours** : réservé Pro chez OddAlerts, et dépend de
  l'historique équipe (§6).

## 6. Roadmap data (pour passer en granularité équipe)

1. Créer/nourrir `football_match_history` dans pariscore.db (pattern exact de
   `handball_match_history` : cron quotidien, clé `league|home|away|date`,
   scores FT + HT, corners/cartons si dispo BSD).
2. Étendre le service : `teamStreak(équipe, marché, N)` = série consécutive
   en partant du dernier match ; `hitRate(équipe, marché, saison)`.
3. Ajouter les cotes par marché (O/U, BTTS, corners) dans le scrape fixtures
   pour généraliser l'edge.
4. Mapper les noms d'équipes BSD ↔ OddAlerts (réutiliser `formKey()` de
   `src/lib/football-form.ts`).

---
*Généré par la mission « Tendances OddAlerts » — implémentation : service +
route API + hook + vue + câblage sous-onglet, voir git log du 2026-10-12.*
