'use strict';

// Step 1 of 2: capture. Opens each URL in a visible Chrome, clicks "View full menu",
// scrolls until no more dish cards load, and saves everything to disk.
// No parsing happens here, so the parser can be developed and re-run against the
// saved snapshots without touching Swiggy again.
//
// The browser uses a persistent profile folder (default: browser-profile\ in this
// project). Cookies and the saved location carry over between runs, like a normal
// Chrome window. This is a separate profile, not your personal Chrome profile.
//
// Usage:
//   node capture.js                  -> captures every URL in ref.txt
//   node capture.js <url> [<url>...] -> captures the given URLs
//   env: HEADLESS=1 to run without a window
//        PROFILE=<folder>           to use a different profile folder
//
// Output: snapshots/rest<id>/<timestamp>/
//   menu-api-<n>.json  raw bodies of every /dapi/menu/pl response (the source of truth)
//   page-source.html   DOM HTML at the moment the most dish cards were loaded (diagnostic)
//   page-text.txt      innerText of the same moment (diagnostic)
//   screenshot.png     viewport screenshot at the end
//   meta.json          url, timings, counts, and dom_status
//
// dom_status (diagnostic only; it does not decide success, the parser does):
//   cards_seen      dish cards appeared in the page
//   no_cards        the page loaded but no dish cards ever appeared
//   no_button       no "View full menu" button was found
//   error           navigation or another step threw

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = __dirname;
const REF_FILE = path.join(ROOT, 'ref.txt');
const SNAP_ROOT = path.join(ROOT, 'snapshots');
const PROFILE_DIR = process.env.PROFILE || path.join(ROOT, 'browser-profile');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// Current Swiggy markup: each dish is data-testid="normal-dish-item". The older
// aria-label form is kept as a fallback. The DOM check is diagnostic only.
const CARD_SELECTOR = '[data-testid="normal-dish-item"], [aria-label*="Costs:"]';

function urlsFromRefFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0].replace(/[,;]+$/, ''));
}

function restIdOf(url) {
  const m = /-rest(\d+)/.exec(url);
  if (!m) throw new Error(`No restaurant id in URL: ${url}`);
  return m[1];
}

async function captureOne(context, url) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(SNAP_ROOT, `rest${restIdOf(url)}`, stamp);
  fs.mkdirSync(dir, { recursive: true });

  const page = await context.newPage();

  // Collect the menu API bodies as they arrive.
  const apiBodies = [];
  page.on('response', (resp) => {
    if (resp.url().includes('/dapi/menu/pl')) {
      apiBodies.push(resp.text().then((t) => ({ status: resp.status(), body: t })).catch(() => null));
    }
  });

  const meta = {
    url,
    dir,
    profile: PROFILE_DIR,
    started_at: new Date().toISOString(),
    dom_status: 'error',
    max_cards: 0,
    final_cards: 0,
    notes: [],
  };
  let bestHtml = null;
  let bestText = null;

  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    meta.http_status = resp ? resp.status() : null;
    if (!resp || resp.status() >= 400) {
      throw new Error(`Swiggy returned HTTP ${meta.http_status} (access denied or blocked) for ${url}`);
    }
    if (resp.status() === 202) meta.notes.push('HTTP 202 on navigation (page still loaded; not treated as an error)');

    // Wait for the restaurant header, then for the button itself.
    await page.waitForSelector('h1, [class*="restaurant"]', { timeout: 30000 }).catch(() => {});
    const btn = page.locator('button', { hasText: /view full menu/i }).first();
    const hasButton = await btn.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false);
    if (hasButton) {
      await btn.click();
      meta.notes.push('clicked View full menu');
    } else {
      meta.notes.push('no View full menu button found');
      meta.dom_status = 'no_button';
    }

    // "attached" (in the DOM) rather than "visible": a menu that renders off-screen
    // or late should still be read, and the API body is what the parser uses.
    const cardsAppeared = await page
      .waitForSelector(CARD_SELECTOR, { state: 'attached', timeout: 30000 })
      .then(() => true, () => false);

    if (cardsAppeared) {
      // Scroll until the dish-card count stops growing. Save the page each time
      // the count reaches a new maximum, so lazily unloaded cards are not lost.
      let unchanged = 0;
      for (let i = 0; i < 150 && unchanged < 4; i++) {
        const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, CARD_SELECTOR);
        if (count > meta.max_cards) {
          meta.max_cards = count;
          bestHtml = await page.content();
          bestText = await page.evaluate(() => document.body.innerText);
          unchanged = 0;
        } else {
          unchanged++;
        }
        await page.evaluate(() => window.scrollBy(0, 1200));
        await page.waitForTimeout(500);
      }
      meta.final_cards = await page.evaluate((sel) => document.querySelectorAll(sel).length, CARD_SELECTOR);
      meta.dom_status = 'cards_seen';
    } else {
      meta.notes.push('no dish cards in the DOM after 30 s (menu API may still have been captured)');
      if (meta.dom_status !== 'no_button') meta.dom_status = 'no_cards';
    }
  } catch (err) {
    meta.notes.push(`error: ${err.message}`);
    meta.dom_status = 'error';
    // Keep whatever was captured so far, even if the run failed midway.
    if (!bestHtml) {
      try {
        bestHtml = await page.content();
        bestText = await page.evaluate(() => document.body.innerText);
      } catch {
        // page already gone
      }
    }
  }

  // Let in-flight API bodies finish before the page closes.
  const bodies = (await Promise.all(apiBodies)).filter(Boolean);
  bodies.forEach((b, i) => {
    const file = path.join(dir, `menu-api-${i + 1}.json`);
    fs.writeFileSync(file, b.body);
  });
  meta.api_responses = bodies.map((b) => ({ status: b.status, bytes: b.body.length }));

  if (bestHtml) fs.writeFileSync(path.join(dir, 'page-source.html'), bestHtml);
  if (bestText) fs.writeFileSync(path.join(dir, 'page-text.txt'), bestText);
  try {
    await page.screenshot({ path: path.join(dir, 'screenshot.png') });
  } catch {
    // window may already be closed
  }

  meta.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  await page.close().catch(() => {});
  return meta;
}

async function main() {
  const urls = process.argv.slice(2).length ? process.argv.slice(2) : urlsFromRefFile(REF_FILE);
  if (!urls.length) throw new Error('No URLs found');

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: CHROME,
    headless: process.env.HEADLESS === '1',
    args: ['--disable-blink-features=AutomationControlled'],
    locale: 'en-IN',
    viewport: { width: 1280, height: 900 },
  });

  try {
    for (const url of urls) {
      console.log(`\n> ${url}`);
      try {
        const m = await captureOne(context, url);
        console.log(`  dom: ${m.dom_status} (max ${m.max_cards}, final ${m.final_cards} cards)`);
        console.log(`  menu API responses: ${m.api_responses.length}`);
        console.log(`  saved to: ${m.dir}`);
        for (const n of m.notes) console.log(`  note: ${n}`);
      } catch (err) {
        console.log(`  FAILED: ${err.stack || err.message}`);
      }
    }
  } finally {
    await context.close().catch(() => {});
  }
  console.log('\nCapture finished. Next: parse the snapshot folders.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
