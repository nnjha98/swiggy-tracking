'use strict';

// Pure parsing helpers (run in Node, unit-testable). The DOM walk itself lives in
// pageExtractor() below and is serialized into the browser by Playwright.

const URL_RE = /\/city\/([^/?#]+)\/([^/?#]+)-rest(\d+)/;

function parseSourceUrl(url) {
  const m = URL_RE.exec(url);
  if (!m) throw new Error(`Not a Swiggy restaurant URL: ${url}`);
  return { city: m[1], slug: m[2], swiggy_id: Number(m[3]) };
}

function toInt(s) {
  if (s == null) return null;
  const n = parseInt(String(s).replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

// Runs inside the page. Returns raw, page-derived fields; Node side does the rest.
// Kept as a function so Playwright can serialize it with page.evaluate.
function pageExtractor() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const lines = document.body.innerText
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // ---- restaurant-level fields ----
  const title = document.title || '';
  const titleMatch = /^Order from (.+?) online in (.+?) \| Swiggy$/.exec(title);
  const restaurantName = titleMatch ? titleMatch[1] : null;

  let ratingLine = null;
  let ratingIdx = -1;
  lines.some((l, i) => {
    if (/^\d(\.\d)?\s*\(.*ratings?\)$/i.test(l)) {
      ratingLine = l;
      ratingIdx = i;
      return true;
    }
    return false;
  });

  let costForTwo = null;
  let cuisines = null;
  lines.some((l, i) => {
    const m = /^₹([\d,]+) for two$/.exec(l);
    if (m) {
      costForTwo = m[1];
      cuisines = lines[i + 1] || null;
      return true;
    }
    return false;
  });

  // ---- outlet block: "License No. ..." is followed by name, area, full address ----
  const licIdx = lines.findIndex((l) => /^License No\./i.test(l));
  let outletBlock = null;
  if (licIdx >= 0) {
    const addrIdx = lines.findIndex(
      (l, i) => i > licIdx && /\b\d{6}\b/.test(l) && l.includes(',')
    );
    if (addrIdx > 0) {
      outletBlock = {
        outlet_name: lines[addrIdx - 2] || null,
        area: lines[addrIdx - 1] || null,
        address: lines[addrIdx],
      };
    }
  }

  // ---- menu: category headers + dish cards ----
  // Each dish is an element whose aria-label looks like:
  //   "Non-veg item. Chicken Biryani Full. This item is a Bestseller, Costs: 458 rupees, ..."
  // Category headers are single-line texts like "Tandoor Chicken Starters (10)".
  const dishes = new Map();
  const headerCounts = [];
  let category = '';
  const seenHeaders = new Set();

  for (const el of document.querySelectorAll('body *')) {
    const label = el.getAttribute('aria-label') || '';
    const dm = /^(Veg Item|Non-veg item)\. (.+?)\. (?:This item is a Bestseller, )?Costs: (\d+) rupees/.exec(label);
    if (dm) {
      const name = dm[2].replace(/\. This item is a Bestseller$/, '').trim();
      const descM = /Description: (.+?)(?: Swipe right|$)/.exec(label);
      const ratingLines = (el.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean);
      const starsStr = ratingLines.find((x) => /^\d(\.\d)?$/.test(x));
      const countStr = ratingLines.find((x) => /^\([\d,]+\)$/.test(x));
      const key = `${category}\u0001${name}`;
      if (!dishes.has(key)) {
        dishes.set(key, {
          category,
          name,
          is_veg: dm[1] === 'Veg Item' ? 1 : 0,
          price: Number(dm[3]),
          description: descM ? clean(descM[1]) : null,
          stars: starsStr ? parseFloat(starsStr) : null,
          rating_count: countStr ? toInt(countStr.slice(1, -1)) : null,
        });
      }
      continue;
    }

    const txt = el.innerText;
    if (txt && !txt.includes('\n')) {
      const hm = /^(.+?) \((\d+)\)$/.exec(txt.trim());
      if (hm) {
        category = hm[1].trim();
        const key = `${category}|${hm[2]}`;
        if (!seenHeaders.has(key)) {
          seenHeaders.add(key);
          headerCounts.push({ category, count: Number(hm[2]) });
        }
      }
    }
  }

  return {
    title,
    restaurantName,
    ratingLine,
    costForTwo,
    cuisines,
    outletBlock,
    dishes: [...dishes.values()],
    headerCounts,
  };
}

// Converts the raw page payload into typed records for db.saveScrape().
function buildRecords(raw, sourceUrl, scrapedAt) {
  const { swiggy_id, city } = parseSourceUrl(sourceUrl);

  let avg = null;
  let count = null;
  let countTxt = null;
  if (raw.ratingLine) {
    const m = /^(\d(?:\.\d)?)\s*\((.*?)\s*ratings?\)$/i.exec(raw.ratingLine);
    if (m) {
      avg = parseFloat(m[1]);
      countTxt = m[2];
      // "1.8K+" -> 1800 (approximate), "350" -> 350
      const k = /^([\d.]+)K/i.exec(countTxt);
      count = k ? Math.round(parseFloat(k[1]) * 1000) : toInt(countTxt);
    }
  }

  const restaurant = {
    swiggy_id,
    name: raw.restaurantName || raw.title || `rest${swiggy_id}`,
    city: city.replace(/-/g, ' '),
    cuisines: raw.cuisines,
    cost_for_two: toInt(raw.costForTwo),
    avg_rating: avg,
    rating_count: count,
    rating_count_txt: countTxt,
    source_url: sourceUrl,
  };

  const outlet = raw.outletBlock || { outlet_name: null, area: null, address: `unknown@${swiggy_id}` };

  const dishesExpected = raw.headerCounts.length
    ? raw.headerCounts.reduce((s, h) => s + h.count, 0)
    : null;

  return {
    restaurant,
    outlet,
    dishes: raw.dishes,
    meta: {
      source_url: sourceUrl,
      scraped_at: scrapedAt,
      dishes_expected: dishesExpected,
      status: 'ok',
    },
  };
}

module.exports = { parseSourceUrl, pageExtractor, buildRecords, toInt };
