'use strict';

// Parses a captured /dapi/menu/pl response body into the same record shape that
// lib/extract.js buildRecords() produces, so db.saveScrape() can take either.
//
// Facts checked against real snapshots (Pista House, The Good Bowl):
//   - All dishes are in one response. No pagination (firstOffsetRequest: true is
//     only the first page marker and every item was present).
//   - Item prices are in paise (45800 = Rs 458). Some items have no top-level
//     price; the price is then in variantsV2.pricingModels (use the lowest).
//   - Ratings are strings: ratings.aggregatedRating.rating = "4.1",
//     ratingCountV2 = "181". Dishes without ratings have no aggregatedRating.
//   - Restaurant costForTwo is also in paise ("50000" = Rs 500).
//   - Section titles can contain double spaces; they are collapsed here.

const { parseSourceUrl, toInt } = require('./extract');

const PAISE = 100;
const DISH_TYPE = 'swiggy.presentation.food.v2.Dish';
const ITEM_CATEGORY_TYPE = 'swiggy.presentation.food.v2.ItemCategory';
const NESTED_CATEGORY_TYPE = 'swiggy.presentation.food.v2.NestedItemCategory';
const RESTAURANT_TYPE = 'swiggy.presentation.food.v2.Restaurant';
const ADDRESS_TYPE = 'swiggy.presentation.food.v2.RestaurantAddress';
const LICENSE_TYPE = 'swiggy.presentation.food.v2.RestaurantLicenseInfo';

const clean = (s) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim() || null);

// Walks every card in the response and returns each card's inner `card.card`
// object, looking at both the top level and the REGULAR group where the menu lives.
function innerCards(json) {
  const out = [];
  for (const c of json.data.cards || []) {
    if (c.card && c.card.card) out.push(c.card.card);
    const regular = c.groupedCard && c.groupedCard.cardGroupMap && c.groupedCard.cardGroupMap.REGULAR;
    for (const s of (regular && regular.cards) || []) {
      if (s.card && s.card.card) out.push(s.card.card);
    }
  }
  return out;
}

function typeOf(card) {
  return (card['@type'] || '').replace('type.googleapis.com/', '');
}

// Returns [{ category, items: [info, ...] }] in the order the page shows them.
// Nested categories (e.g. "Tandoor Chicken Starters" inside a parent) are flattened
// to their own sections, matching how the page groups them under headers.
function menuSections(json) {
  const sections = [];
  for (const card of innerCards(json)) {
    const t = typeOf(card);
    if (t === ITEM_CATEGORY_TYPE) {
      sections.push({ category: clean(card.title) || '', items: (card.itemCards || []).map((x) => x.card.info) });
    } else if (t === NESTED_CATEGORY_TYPE) {
      for (const sub of card.categories || []) {
        sections.push({ category: clean(sub.title) || '', items: (sub.itemCards || []).map((x) => x.card.info) });
      }
    }
  }
  return sections;
}

// "1.8K+ ratings" -> { txt: "1.8K+", count: 1800 }; "350 ratings" -> { txt: "350", count: 350 }
function parseRatingCount(s) {
  if (s == null) return { txt: null, count: null };
  const m = /^(.*?)\s*ratings?$/i.exec(String(s).trim());
  const txt = m ? m[1] : String(s).trim();
  const k = /^([\d.]+)K/i.exec(txt);
  return { txt, count: k ? Math.round(parseFloat(k[1]) * 1000) : toInt(txt) };
}

function dishPrice(info) {
  if (typeof info.price === 'number') return Math.round(info.price / PAISE);
  const models = (info.variantsV2 && info.variantsV2.pricingModels) || [];
  const prices = models.map((m) => m.price).filter((p) => typeof p === 'number');
  if (prices.length) return Math.round(Math.min(...prices) / PAISE);
  if (typeof info.defaultPrice === 'number') return Math.round(info.defaultPrice / PAISE);
  return null;
}

function dishFromInfo(info, category) {
  const agg = info.ratings && info.ratings.aggregatedRating;
  const stars = agg && agg.rating != null ? parseFloat(agg.rating) : null;
  const countRaw = agg ? agg.ratingCountV2 ?? agg.ratingCount : null;
  const veg = info.itemAttribute && info.itemAttribute.vegClassifier;
  return {
    category,
    name: clean(info.name),
    is_veg: veg === 'VEG' ? 1 : veg === 'NONVEG' ? 0 : null,
    price: dishPrice(info),
    description: clean(info.description),
    stars: Number.isFinite(stars) ? stars : null,
    rating_count: agg ? toInt(String(countRaw)) : null,
    _id: info.id,
  };
}

// Full parse of one response. Throws if the response does not look like a menu.
function parseMenuApi(json) {
  const cards = innerCards(json);
  const restaurantCard = cards.find((c) => typeOf(c) === RESTAURANT_TYPE);
  const addressCard = cards.find((c) => typeOf(c) === ADDRESS_TYPE);
  const licenseCard = cards.find((c) => typeOf(c) === LICENSE_TYPE);
  if (!restaurantCard || !restaurantCard.info) throw new Error('menu-api: no Restaurant card');

  const sections = menuSections(json);
  if (!sections.length) throw new Error('menu-api: no ItemCategory sections');

  const dishes = [];
  const sectionCounts = [];
  for (const sec of sections) {
    sectionCounts.push({ category: sec.category, count: sec.items.length });
    for (const info of sec.items) {
      if (!info || !info.name) continue;
      dishes.push(dishFromInfo(info, sec.category));
    }
  }

  return {
    restaurant: restaurantCard.info,
    address: addressCard || null,
    license: licenseCard || null,
    sections: sectionCounts,
    dishes,
  };
}

// "License No. 23621032004583" -> "23621032004583"
function licenseNumber(card) {
  const text = card && Array.isArray(card.text) ? card.text.join(' ') : '';
  const m = /License No\.?\s*([A-Za-z0-9/-]+)/i.exec(text);
  return m ? m[1] : null;
}

// Same contract as buildRecords() in lib/extract.js.
function buildRecordsFromApi(json, sourceUrl, scrapedAt) {
  const { swiggy_id } = parseSourceUrl(sourceUrl);
  const parsed = parseMenuApi(json);
  const r = parsed.restaurant;
  const rc = parseRatingCount(r.totalRatingsString);

  const restaurant = {
    swiggy_id,
    name: clean(r.name),
    city: clean(r.city),
    cuisines: Array.isArray(r.cuisines) ? r.cuisines.join(', ') : null,
    cost_for_two: r.costForTwo != null ? Math.round(Number(r.costForTwo) / PAISE) : null,
    avg_rating: typeof r.avgRating === 'number' ? r.avgRating : null,
    rating_count: rc.count,
    rating_count_txt: rc.txt,
    source_url: sourceUrl,
  };

  // The outlet's own name comes from RestaurantAddress.name. It can differ from the
  // restaurant name (e.g. "Pista House Bakery"). Fall back to the restaurant name.
  const outlet = {
    outlet_name: clean(parsed.address && parsed.address.name) || restaurant.name,
    area: clean(parsed.address && parsed.address.area) || clean(r.areaName),
    address: clean(parsed.address && parsed.address.completeAddress) || `unknown@${swiggy_id}`,
    license_no: licenseNumber(parsed.license),
  };

  // Duplicate (category, name) pairs would violate the dishes UNIQUE key. Keep the
  // first and report the rest, so the loss is visible instead of silent.
  const seen = new Map();
  const dishes = [];
  const duplicates = [];
  for (const d of parsed.dishes) {
    const key = `${d.category}\u0001${d.name}`;
    if (seen.has(key)) {
      duplicates.push(`${d.category} / ${d.name}`);
      continue;
    }
    seen.set(key, true);
    const { _id, ...row } = d;
    dishes.push(row);
  }

  const dishesExpected = parsed.sections.reduce((s, x) => s + x.count, 0);
  const notes = [];
  if (duplicates.length) notes.push(`${duplicates.length} duplicate dish name(s) skipped: ${duplicates.slice(0, 5).join('; ')}`);
  if (dishes.length !== dishesExpected) notes.push(`parsed ${dishes.length} of ${dishesExpected} items in sections`);

  return {
    restaurant,
    outlet,
    dishes,
    meta: {
      source_url: sourceUrl,
      scraped_at: scrapedAt,
      dishes_expected: dishesExpected,
      status: notes.length ? 'partial' : 'ok',
      note: notes.length ? notes.join(' | ') : null,
      sections: parsed.sections,
    },
  };
}

module.exports = { parseMenuApi, buildRecordsFromApi, parseRatingCount };
