/**
 * scrape_tm_injuries.mjs — Dates de retour blessures depuis Transfermarkt.
 *
 * Complète RotoWire (dont les dates sont paywall) : même périmètre 5 ligues,
 * sortie public/data/injuries_tm/{slug}.json mergée dans football-injuries.ts.
 *
 * Accès : Playwright Chromium headless + UA réel (challenge Cloudflare passé
 * en résidentiel le 2026-09-18 ; 202 vide en https pur). Poli : 2 s entre pages.
 * Usage : node scripts/scrape_tm_injuries.mjs --all --output-dir public/data/injuries_tm
 */
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const LEAGUES = {
  epl: "https://www.transfermarkt.fr/premier-league/verletztespieler/wettbewerb/GB1/plus/1",
  laliga: "https://www.transfermarkt.fr/primera-division/verletztespieler/wettbewerb/ES1/plus/1",
  seriea: "https://www.transfermarkt.fr/serie-a/verletztespieler/wettbewerb/IT1/plus/1",
  ligue1: "https://www.transfermarkt.fr/ligue-1/verletztespieler/wettbewerb/FR1/plus/1",
  bundesliga: "https://www.transfermarkt.fr/bundesliga/verletztespieler/wettbewerb/L1/plus/1",
};

// TM (titre du blason) -> nom football-data. Complété par repli auto via fd/*.json.
const CLUB_MAP = {
  ligue1: {
    "Le Havre AC": "Le Havre",
    "Paris FC": "Paris FC",
    "Stade Brestois 29": "Brest",
    "Angers SCO": "Angers",
    "ESTAC Troyes": "Troyes",
    "LOSC Lille": "Lille",
    "RC Lens": "Lens",
    "RC Strasbourg Alsace": "Strasbourg",
    "AJ Auxerre": "Auxerre",
    "AS Monaco": "Monaco",
    "OGC Nice": "Nice",
    "Olympique de Marseille": "Marseille",
    "Paris Saint-Germain": "Paris SG",
  },
  epl: { "Nottingham Forest": "Nott'm Forest", "Manchester City": "Man City", "Manchester United": "Man United" },
  laliga: {
    "Atlético de Madrid": "Ath Madrid",
    "Deportivo La Corogne": "La Coruna",
    "Séville FC": "Sevilla",
    "Athletic Bilbao": "Ath Bilbao",
    "FC Barcelone": "Barcelona",
  },
  seriea: {},
  bundesliga: {
    "SV Werder Brême": "Werder Bremen",
    "Eintracht Francfort": "Ein Frankfurt",
    "Borussia Mönchengladbach": "M'gladbach",
    "SC Fribourg": "Freiburg",
  },
};

const MONTHS = {
  janv: "01", "févr": "02", "fév": "02", mars: "03", avr: "04", mai: "05",
  juin: "06", juil: "07", "août": "08", aout: "08", sept: "09", oct: "10",
  nov: "11", "déc": "12", dec: "12",
};

const norm = (s) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

/** "21 sept. 2026" -> "2026-09-21", null si non parsable (ex. "?" / vide). */
function parseDateFr(raw) {
  const m = /(\d{1,2})?\s*([a-zéû]+)\.?\s*(\d{4})/i.exec(raw || "");
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${String(m[1] || "01").padStart(2, "0")}`;
}

/** Noms FD de la ligue (repli de jointure si club absent de CLUB_MAP). */
function fdNames(slug) {
  try {
    const d = JSON.parse(readFileSync(join(ROOT, "public", "data", "fd", `${slug}.json`), "utf8"));
    const seasons = Object.keys(d.seasons).sort().reverse();
    return Object.keys(d.seasons[seasons[0]].teams);
  } catch {
    return [];
  }
}

function mapClub(slug, tmClub, fdList) {
  const manual = (CLUB_MAP[slug] || {})[tmClub];
  if (manual) return { name: manual, via: "map" };
  const k = norm(tmClub);
  const exact = fdList.find((n) => norm(n) === k);
  if (exact) return { name: exact, via: "exact" };
  const partial = fdList.find((n) => norm(n).includes(k) || k.includes(norm(n)));
  if (partial) return { name: partial, via: "partial" };
  return { name: tmClub, via: "UNMATCHED" };
}

async function scrapeLeague(ctx, slug, url) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector("table.items", { timeout: 30000 });
  await page.waitForTimeout(3000);
  const rows = await page.evaluate(() => {
    const out = [];
    for (const tr of document.querySelectorAll("table.items tbody tr")) {
      if (!tr.querySelector("table.inline-table")) continue;
      const tds = [...tr.querySelectorAll(":scope > td")];
      out.push({
        name: tr.querySelector("td.hauptlink a")?.getAttribute("title") || "",
        club: tds.map((td) => td.querySelector("a[href*='/startseite/verein/']")?.getAttribute("title") || "").find(Boolean) || "",
        injury: (tds[4]?.innerText || "").trim().replace(/\s+/g, " "),
        since: (tds[5]?.innerText || "").trim().replace(/\s+/g, " "),
        until: (tds[6]?.innerText || "").trim().replace(/\s+/g, " "),
      });
    }
    return out;
  });
  await page.close();
  return rows;
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const li = args.indexOf("--league");
  const oi = args.indexOf("--output-dir");
  const outDir = join(ROOT, oi >= 0 ? args[oi + 1] : "public/data/injuries_tm");
  const slugs = all ? Object.keys(LEAGUES) : [li >= 0 ? args[li + 1] : "ligue1"];
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "fr-FR",
    timezoneId: "Europe/Paris",
  });

  for (const slug of slugs) {
    if (!LEAGUES[slug]) { console.error(`Ligue inconnue : ${slug}`); process.exitCode = 1; continue; }
    const rows = await scrapeLeague(ctx, slug, LEAGUES[slug]);
    const fdList = fdNames(slug);
    const teams = {};
    const unmatched = new Set();
    let withReturn = 0;
    for (const r of rows) {
      if (!r.name) continue;
      const { name, via } = mapClub(slug, r.club, fdList);
      if (via === "UNMATCHED") unmatched.add(r.club);
      const returnDate = parseDateFr(r.until);
      if (returnDate) withReturn++;
      (teams[name] ||= []).push({
        player: r.name,
        injury: r.injury || null,
        since: parseDateFr(r.since),
        sinceRaw: r.since || null,
        returnDate,
        returnRaw: r.until || null,
      });
    }
    if (unmatched.size) console.log(`[${slug}] clubs non mappés : ${[...unmatched].join(", ")}`);
    const now = new Date().toISOString();
    writeFileSync(
      join(outDir, `${slug}.json`),
      JSON.stringify({
        meta: {
          leagueId: slug, source: "transfermarkt", sourceUrl: LEAGUES[slug],
          updatedAt: now, fetchedAt: now,
          rowCount: rows.length,
          coveragePct: rows.length ? Math.round(100 * (rows.length - [...unmatched].length) / rows.length) : 0,
          withReturnDates: withReturn,
        },
        teams,
      }, null, 1),
    );
    console.log(`[${slug}] ${rows.length} lignes (${withReturn} avec retour) -> ${outDir}/${slug}.json`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  await browser.close();
}

main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
