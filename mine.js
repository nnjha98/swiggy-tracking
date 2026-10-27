'use strict';

// Usage:
//   node mine.js                       -> mines every URL in ref.txt into swiggy.db
//   node mine.js <url> [<url> ...]     -> mines the given URLs instead
//   env: DB=path/to/file.db  HEADLESS=1  (default: visible Chrome window)

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { openDb } = require('./lib/db');
const { pageExtractor, buildRecords } = require('./lib/extract');

const ROOT = __dirname;
const REF_FILE = path.join(ROOT, 'ref.txt');
const DB_FILE = process.env.DB || path.join(ROOT, 'swiggy.db');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function urlsFromRefFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0].replace(/[,;]+$/, ''));
}

// Clicks "View full menu" if present, then waits for dish cards to render.
async function openFullMenu(page) {
  const btn = page.locator('button', { hasText: /view full menu/i }).first();
  if (await btn.count()) {
    await btn.click();
  }
  await page.waitForSelector('[aria-label*="Costs:"]', { timeout: 30000 });
}

// The menu is virtualised/lazy in places, so scroll through it and merge each pass.
async function extractFullMenu(page) {
  const merged = new Map();
  let meta = null;
  const headers = new Map();
  let stable = 0;
  let last = -1;

  for (let i = 0; i < 80 && stable < 3; i++) {
    const raw = await page.evaluate(pageExtractor);
    meta = meta || raw;
    for (const h of raw.headerCounts) headers.set(h.category, h.count);
    for (const d of raw.dishes) {
      const key = `${d.category}\u0001${d.name}`;
      const prev = merged.get(key);
      // keep the first-seen record, but fill in rating if a later pass found one
      if (!prev) merged.set(key, d);
      else if (prev.stars == null && d.stars != null) merged.set(key, { ...prev, ...d });
    }
    if (merged.size === last) stable++;
    else stable = 0;
    last = merged.size;
    await page.mouse.wheel(0, 1500);
    await page.waitForTimeout(350);
  }

  return {
    meta: {
      ...meta,
      headerCounts: [...headers].map(([category, count]) => ({ category, count })),
    },
    dishes: [...merged.values()],
  };
}

async function mineUrl(browser, store, url) {
  const context = await browser.newContext({ locale: 'en-IN', viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('h1, [class*="restaurant"]', { timeout: 30000 }).catch(() => {});
    await openFullMenu(page);
    const { meta, dishes } = await extractFullMenu(page);

    const scrapedAt = new Date().toISOString();
    const rec = buildRecords({ ...meta, dishes }, url, scrapedAt);

    // QA: compare what we parsed against the category counts printed by the page.
    const expected = rec.meta.dishes_expected;
    const withRating = dishes.filter((d) => d.stars != null).length;
    if (expected != null && dishes.length < expected) {
      rec.meta.status = 'partial';
      rec.meta.note = `parsed ${dishes.length} of ${expected} dishes shown in category headers`;
    }
    if (dishes.length === 0) {
      rec.meta.status = 'failed';
      rec.meta.note = 'no dishes parsed';
    }

    const saved = store.saveScrape(rec);
    return { ok: rec.meta.status !== 'failed', url, restaurant: rec.restaurant.name, outlet: rec.outlet, status: rec.meta.status, note: rec.meta.note, expected, withRating, ...saved };
  } catch (err) {
    store.saveScrape({
      restaurant: { swiggy_id: Number((/rest(\d+)/.exec(url) || [0, 0])[1]), name: url, city: null, cuisines: null, cost_for_two: null, avg_rating: null, rating_count: null, rating_count_txt: null, source_url: url },
      outlet: { outlet_name: null, area: null, address: `failed@${url}` },
      dishes: [],
      meta: { source_url: url, scraped_at: new Date().toISOString(), dishes_expected: null, status: 'failed', note: String(err.message).slice(0, 500) },
    });
    return { ok: false, url, error: err.message };
  } finally {
    await context.close();
  }
}

async function main() {
  const urls = process.argv.slice(2).length ? process.argv.slice(2) : urlsFromRefFile(REF_FILE);
  if (!urls.length) throw new Error('No URLs found');

  const store = openDb(DB_FILE);
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: process.env.HEADLESS === '1',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const results = [];
  try {
    for (const url of urls) {
      console.log(`\n> ${url}`);
      const r = await mineUrl(browser, store, url);
      results.push(r);
      if (r.ok) {
        console.log(`  restaurant: ${r.restaurant}`);
        console.log(`  outlet:     ${r.outlet.area || '-'} | ${r.outlet.address}`);
        console.log(`  dishes:     ${r.dishesSaved} saved, ${r.withRating} with ratings, expected ${r.expected ?? 'n/a'} -> ${r.status}`);
        if (r.note) console.log(`  note:       ${r.note}`);
      } else {
        console.log(`  FAILED: ${r.error}`);
      }
    }
  } finally {
    await browser.close();
    store.close();
  }

  const bad = results.filter((r) => !r.ok || r.status === 'partial');
  console.log(`\nDone: ${results.length - bad.length}/${results.length} clean. DB: ${DB_FILE}`);
  process.exitCode = bad.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
