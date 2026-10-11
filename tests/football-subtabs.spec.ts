import { test, expect, type Locator, type Page } from "@playwright/test";

/**
 * Vague 0 — fondation des 4 sous-onglets football.
 *
 * Couvre les 3 garanties de la vague :
 *  1. la rangée Flashscore du header expose les 4 onglets (SPORT_SUB_TABS.football) ;
 *  2. la rangée interne (FootballSubTabs) EST un miroir : même clé store,
 *     un clic dans l'une met l'autre à jour ;
 *  3. l'URL (?sub=) fait foi au montage et est réfléchie quand on change d'onglet.
 */

const FOOTBALL_TABS = ["Calendrier", "Top stratégies", "Back Testing", "Résultats"] as const;

/** Rangée Flashscore du header (sport-sub-tabs.tsx). */
const headerRow = (page: Page) => page.getByRole("tablist", { name: "Sous-sections football" });
/** Rangée interne dans le contenu de l'onglet (football-sub-tabs.tsx). */
const innerRow = (page: Page) => page.getByRole("tablist", { name: "Sections de l'onglet football" });

async function gotoFootball(page: Page, search = "/?sport=football") {
  const logs: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) =>
    logs.push(`[reqfailed] ${r.url()} ${r.failure()?.errorText ?? ""}`),
  );

  // domcontentloaded : en dev, `load` attend la compilation Turbopack complète
  // de la page (cassure de timeout en cache froid) — c'est l'attente d'innerRow
  // ci-dessous qui porte la garantie de rendu.
  await page.goto(search, { waitUntil: "domcontentloaded", timeout: 120_000 });
  try {
    // Timeout généreux : en dev, le chunk lazy de FootballTabContent se compile
    // à la demande — 24 s mesurés au calme, >120 s sous charge machine partagée.
    await expect(innerRow(page)).toBeVisible({ timeout: 180_000 });
  } catch (err) {
    const html = await page.content();
    throw new Error(
      [
        `innerRow introuvable après 120s sur ${search}`,
        `fallbackSuspense=${(html.match(/Chargement\.\.\./g) || []).length}`,
        `headerRow=${html.includes("Sous-sections football")}`,
        ...logs.slice(-25),
        String(err),
      ].join("\n"),
    );
  }
}

test.describe("Vague 0 — sous-onglets football", () => {
  // 180s : couvre la compilation à la demande du chunk lazy en dev.
  test.describe.configure({ timeout: 300_000 });

  test("aucune rangée de sous-onglets sur l'accueil sans sport explicite", async ({ page }) => {
    // Régression que l'ajout de `football` à SPORT_SUB_TABS aurait introduite :
    // le repli `selectedSportId ?? "football"` affichait la rangée sur l'accueil,
    // où cliquer ne montait aucun contenu.
    await page.goto("/");
    await expect(page.getByRole("tablist", { name: "Navigation par sport" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(headerRow(page)).toHaveCount(0);
    await expect(innerRow(page)).toHaveCount(0);
  });

  test("le header expose les 4 onglets, Calendrier actif par défaut", async ({ page }) => {
    await gotoFootball(page);
    const header = headerRow(page);
    for (const label of FOOTBALL_TABS) {
      await expect(header.getByRole("tab", { name: label, exact: true })).toBeVisible();
    }
    await expect(header.getByRole("tab", { selected: true })).toHaveText("Calendrier");
    await expect(innerRow(page).getByRole("tab", { selected: true })).toHaveText("Calendrier");
  });

  test("clic sur l'onglet interne : le header suit (miroir store)", async ({ page }) => {
    await gotoFootball(page);
    await innerRow(page).getByRole("tab", { name: "Back Testing", exact: true }).click();
    await expect(headerRow(page).getByRole("tab", { selected: true })).toHaveText("Back Testing");
    await expect(innerRow(page).getByRole("tab", { selected: true })).toHaveText("Back Testing");
  });

  test("clic sur le header : l'onglet interne suit", async ({ page }) => {
    await gotoFootball(page);
    await headerRow(page).getByRole("tab", { name: "Résultats", exact: true }).click();
    await expect(innerRow(page).getByRole("tab", { selected: true })).toHaveText("Résultats");
    await expect(headerRow(page).getByRole("tab", { selected: true })).toHaveText("Résultats");
  });

  test("l'URL ?sub= fait foi au montage", async ({ page }) => {
    await gotoFootball(page, "/?sport=football&sub=backtesting");
    await expect(innerRow(page).getByRole("tab", { selected: true })).toHaveText("Back Testing");
    await expect(headerRow(page).getByRole("tab", { selected: true })).toHaveText("Back Testing");
  });

  test("le changement d'onglet réfléchit ?sub= dans l'URL", async ({ page }) => {
    await gotoFootball(page);
    await innerRow(page).getByRole("tab", { name: "Top stratégies", exact: true }).click();
    await expect(page).toHaveURL(/sub=top-strategies/);
    // Le défaut (calendrier) ne salit jamais l'URL.
    await innerRow(page).getByRole("tab", { name: "Calendrier", exact: true }).click();
    await expect(page).not.toHaveURL(/sub=/);
  });

  test("Live | Pre-match | Classements n'apparaissent que sur Calendrier", async ({ page }) => {
    await gotoFootball(page);
    // MatchViewTabs porte l'aria-label FR `tabsAriaLabel` (src/messages/fr.json).
    const modeTabs = page.getByRole("tablist", { name: "Filtrer par statut de match" });
    await expect(modeTabs).toBeVisible();

    await innerRow(page).getByRole("tab", { name: "Back Testing", exact: true }).click();
    await expect(modeTabs).toBeHidden();

    await innerRow(page).getByRole("tab", { name: "Calendrier", exact: true }).click();
    await expect(modeTabs).toBeVisible();
  });

  test("Back Testing affiche sa vue marchés, pas un blanc", async ({ page }) => {
    // Vague 3 : le sous-onglet est câblé sur FootballBacktestingView — l'état
    // vide nu (FootballSubTabPanel sans children) n'est plus le rendu par défaut.
    await gotoFootball(page);
    await innerRow(page).getByRole("tab", { name: "Back Testing", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Back Testing" });
    await expect(panel).toBeVisible();
    // Timeout réel : le panneau peut arriver pendant une recompilation HMR.
    await expect(panel.getByRole("heading", { name: "Back Testing — marchés" })).toBeVisible({
      timeout: 30_000,
    });
  });
});

test.describe("Vague 1 — migration des contenus dans les sous-onglets", () => {
  test.describe.configure({ timeout: 300_000 });

  /** Le tableau « Calendrier des matchs » (TopMultiSport). */
  const calendar = (page: Page) => page.getByRole("heading", { name: "Calendrier des matchs" });
  /** Le widget Top 10 — <section aria-label="Top 10 matchs par stratégie">. */
  const top10 = (page: Page) => page.getByRole("region", { name: "Top 10 matchs par stratégie" });

  test("Calendrier : le tableau est monté dans l'onglet, et il est unique", async ({ page }) => {
    await gotoFootball(page);
    await expect(calendar(page)).toHaveCount(1);
    await expect(calendar(page)).toBeVisible();
  });

  test("le calendrier ne fuit pas dans les autres sous-onglets", async ({ page }) => {
    await gotoFootball(page);
    await innerRow(page).getByRole("tab", { name: "Back Testing", exact: true }).click();
    await expect(calendar(page)).toHaveCount(0);
    await innerRow(page).getByRole("tab", { name: "Résultats", exact: true }).click();
    await expect(calendar(page)).toHaveCount(0);
  });

  test("Top stratégies : le tableau Top 10 est rendu, et il est unique", async ({ page }) => {
    await gotoFootball(page);
    await innerRow(page).getByRole("tab", { name: "Top stratégies", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "Top stratégies" })).toBeVisible();
    await expect(top10(page)).toHaveCount(1);
  });

  test("la home ne rend plus le Top 10 football", async ({ page }) => {
    // Avant la Vague 1 : page.tsx rendait FootballTop10Widget en plus de
    // football-tab-content → 2 points de rendu. Il ne doit en rester qu'un,
    // dans le sous-onglet.
    await page.goto("/");
    await expect(page.getByRole("tablist", { name: "Navigation par sport" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(top10(page)).toHaveCount(0);
  });
});

test.describe("Vague 2 — onglet Résultats (verdicts stratégies + P&L)", () => {
  test.describe.configure({ timeout: 300_000 });

  /** Issue data-dépendante : picks réglés OU état vide explicite. */
  const resultsOutcome = (scope: Page | Locator) =>
    scope
      .getByTestId("results-pnl-global")
      .or(scope.getByText("Aucun pick réglé sur la période"));

  test("le panneau Résultats monte FootballResultsView (plus l'état vide nu)", async ({ page }) => {
    await gotoFootball(page);
    await innerRow(page).getByRole("tab", { name: "Résultats", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Résultats" });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Résultats" })).toBeVisible();
    await expect(resultsOutcome(panel)).toBeVisible({ timeout: 30_000 });
  });

  test("la page /results réutilise la même implémentation (fusion)", async ({ page }) => {
    await page.goto("/results");
    await expect(resultsOutcome(page)).toBeVisible({ timeout: 60_000 });
  });

  test("API settled : payload complet (13 stratégies + P&L)", async ({ request }) => {
    const res = await request.get("/api/football/results/settled");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.matches)).toBe(true);
    expect(typeof body.summary.pnl).toBe("number");
    expect(Array.isArray(body.summary.byStrategy)).toBe(true);
    expect(body.summary.byStrategy.length).toBe(13);
  });

  test("multi-matches ?from=&to= : fenêtre acceptée et reflétée", async ({ request }) => {
    const res = await request.get(
      "/api/v1/multi-matches?sport=football&from=2026-09-25&to=2026-10-01",
    );
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.from).toBe("2026-09-25");
    expect(body.to).toBe("2026-10-01");
    expect(Array.isArray(body.matches)).toBe(true);
  });
});

test.describe("Vague 3 — Back Testing marchés (cotes réelles + cartes bloquées)", () => {
  test.describe.configure({ timeout: 300_000 });

  test("cartes marchés ET cartes bloquées visibles (la carte bloquée est le livrable)", async ({ page }) => {
    await gotoFootball(page);
    await innerRow(page).getByRole("tab", { name: "Back Testing", exact: true }).click();
    const panel = page.getByRole("tabpanel", { name: "Back Testing" });
    await expect(panel.getByTestId("markets-totals")).toBeVisible({ timeout: 30_000 });

    // 7 marchés backtestables + 4 bloqués (corners, tirs cadrés, but tardif)
    await expect(panel.locator('[data-testid^="market-card-"]')).toHaveCount(7, { timeout: 30_000 });
    await expect(panel.locator('[data-testid^="market-blocked-"]')).toHaveCount(4, { timeout: 30_000 });

    const blocked = panel.getByTestId("market-blocked-over65Corners");
    await expect(blocked).toBeVisible({ timeout: 30_000 });
    await expect(blocked).toContainText("BetMines", { timeout: 30_000 });
    await expect(panel.getByTestId("market-blocked-lateGoal")).toContainText("vague 4", {
      timeout: 30_000,
    });
  });

  test("API backtest marchés : 7 dispo + 4 bloqués motivés, zéro cote synthétique", async ({ request }) => {
    const res = await request.get("/api/football/backtest/markets");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.markets.length).toBe(7);
    expect(body.blocked.length).toBe(4);
    for (const m of body.markets) {
      // sources autorisées : cote BSD réelle ou dérivée du dé-vig 1X2
      expect(["bsd", "derived-devig"]).toContain(m.oddsSource);
    }
    for (const b of body.blocked) {
      expect(b.blockedReason).toBeTruthy();
      expect(b.oddsSource === "betmines" || b.oddsSource === "none").toBe(true);
    }
  });
});
