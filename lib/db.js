'use strict';

const Database = require('better-sqlite3');

// Schema:
//   restaurants  one row per Swiggy restaurant (swiggy_id from the URL, e.g. rest1239425)
//   outlets      one row per physical outlet (restaurant can have many)
//   dishes       one row per dish on an outlet's menu (menu is per outlet)
//   dish_ratings time-series of dish ratings, one row per dish per scrape run
//   scrape_runs  audit log: what was scraped, when, and how complete it looked
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS restaurants (
  swiggy_id        INTEGER PRIMARY KEY,
  name             TEXT    NOT NULL,
  city             TEXT,
  cuisines         TEXT,
  cost_for_two     INTEGER,
  avg_rating       REAL,
  rating_count     INTEGER,
  rating_count_txt TEXT,
  source_url       TEXT    NOT NULL,
  last_scraped_at  TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS outlets (
  id            INTEGER PRIMARY KEY,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(swiggy_id) ON DELETE CASCADE,
  outlet_name   TEXT,
  area          TEXT,
  address       TEXT    NOT NULL,
  UNIQUE (restaurant_id, address)
);

CREATE TABLE IF NOT EXISTS dishes (
  id          INTEGER PRIMARY KEY,
  outlet_id   INTEGER NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  category    TEXT    NOT NULL DEFAULT '',
  name        TEXT    NOT NULL,
  is_veg      INTEGER,               -- 1 veg, 0 non-veg, NULL unknown
  price       INTEGER,
  description TEXT,
  UNIQUE (outlet_id, category, name)
);

CREATE TABLE IF NOT EXISTS dish_ratings (
  dish_id      INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
  scraped_at   TEXT    NOT NULL,
  stars        REAL    NOT NULL,
  rating_count INTEGER,
  PRIMARY KEY (dish_id, scraped_at)
);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id                 INTEGER PRIMARY KEY,
  source_url         TEXT    NOT NULL,
  outlet_id          INTEGER REFERENCES outlets(id) ON DELETE SET NULL,
  scraped_at         TEXT    NOT NULL,
  dishes_found       INTEGER NOT NULL,
  dishes_with_rating INTEGER NOT NULL,
  dishes_expected    INTEGER,        -- sum of category counts shown on the page, for QA
  status             TEXT    NOT NULL,
  note               TEXT
);

CREATE INDEX IF NOT EXISTS idx_outlets_restaurant ON outlets(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_dishes_outlet      ON dishes(outlet_id);
CREATE INDEX IF NOT EXISTS idx_ratings_dish       ON dish_ratings(dish_id);

-- dish_ratings plus the names it belongs to. Read-only convenience view.
DROP VIEW IF EXISTS dish_ratings_named;
CREATE VIEW dish_ratings_named AS
SELECT r.dish_id, r.scraped_at, r.stars, r.rating_count,
       d.name AS dish_name,
       rs.name AS restaurant_name,
       o.outlet_name
  FROM dish_ratings r
  JOIN dishes d       ON d.id = r.dish_id
  JOIN outlets o      ON o.id = d.outlet_id
  JOIN restaurants rs ON rs.swiggy_id = o.restaurant_id;
`;

function openDb(file) {
  const db = new Database(file);
  db.exec(SCHEMA);

  // Migration: outlets.license_no (FSSAI licence number, one per outlet). Added after the first schema.
  const outletCols = db.prepare('PRAGMA table_info(outlets)').all().map((c) => c.name);
  if (!outletCols.includes('license_no')) db.exec('ALTER TABLE outlets ADD COLUMN license_no TEXT');

  const upsertRestaurant = db.prepare(`
    INSERT INTO restaurants (swiggy_id, name, city, cuisines, cost_for_two, avg_rating,
                             rating_count, rating_count_txt, source_url, last_scraped_at)
    VALUES (@swiggy_id, @name, @city, @cuisines, @cost_for_two, @avg_rating,
            @rating_count, @rating_count_txt, @source_url, @last_scraped_at)
    ON CONFLICT(swiggy_id) DO UPDATE SET
      name = excluded.name, city = excluded.city, cuisines = excluded.cuisines,
      cost_for_two = excluded.cost_for_two, avg_rating = excluded.avg_rating,
      rating_count = excluded.rating_count, rating_count_txt = excluded.rating_count_txt,
      source_url = excluded.source_url, last_scraped_at = excluded.last_scraped_at
  `);

  const upsertOutlet = db.prepare(`
    INSERT INTO outlets (restaurant_id, outlet_name, area, address, license_no)
    VALUES (@restaurant_id, @outlet_name, @area, @address, @license_no)
    ON CONFLICT(restaurant_id, address) DO UPDATE SET
      outlet_name = excluded.outlet_name, area = excluded.area, license_no = excluded.license_no
    RETURNING id
  `);

  const upsertDish = db.prepare(`
    INSERT INTO dishes (outlet_id, category, name, is_veg, price, description)
    VALUES (@outlet_id, @category, @name, @is_veg, @price, @description)
    ON CONFLICT(outlet_id, category, name) DO UPDATE SET
      is_veg = excluded.is_veg, price = excluded.price, description = excluded.description
    RETURNING id
  `);

  const upsertRating = db.prepare(`
    INSERT INTO dish_ratings (dish_id, scraped_at, stars, rating_count)
    VALUES (@dish_id, @scraped_at, @stars, @rating_count)
    ON CONFLICT(dish_id, scraped_at) DO UPDATE SET
      stars = excluded.stars, rating_count = excluded.rating_count
  `);

  const insertRun = db.prepare(`
    INSERT INTO scrape_runs (source_url, outlet_id, scraped_at, dishes_found,
                             dishes_with_rating, dishes_expected, status, note)
    VALUES (@source_url, @outlet_id, @scraped_at, @dishes_found,
            @dishes_with_rating, @dishes_expected, @status, @note)
  `);

  // Writes one full scrape result atomically. Re-running the same URL refreshes
  // restaurant/outlet/dish rows and appends a new rating snapshot.
  const saveScrape = db.transaction((result) => {
    const { restaurant, outlet, dishes, meta } = result;

    upsertRestaurant.run({ ...restaurant, last_scraped_at: meta.scraped_at });
    const outletId = upsertOutlet.get({
      restaurant_id: restaurant.swiggy_id,
      outlet_name: outlet.outlet_name ?? null,
      area: outlet.area ?? null,
      address: outlet.address,
      license_no: outlet.license_no ?? null,
    }).id;

    let withRating = 0;
    for (const d of dishes) {
      const dishId = upsertDish.get({ outlet_id: outletId, ...d }).id;
      if (d.stars != null) {
        upsertRating.run({
          dish_id: dishId,
          scraped_at: meta.scraped_at,
          stars: d.stars,
          rating_count: d.rating_count,
        });
        withRating++;
      }
    }

    insertRun.run({
      source_url: meta.source_url,
      outlet_id: outletId,
      scraped_at: meta.scraped_at,
      dishes_found: dishes.length,
      dishes_with_rating: withRating,
      dishes_expected: meta.dishes_expected,
      status: meta.status,
      note: meta.note ?? null,
    });

    return { outletId, dishesSaved: dishes.length, dishesWithRating: withRating };
  });

  return { db, saveScrape, close: () => db.close() };
}

module.exports = { openDb };
