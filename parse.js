'use strict';

// Step 2 of 2: parse. Reads the menu-api-<n>.json files that capture.js saved and
// writes each snapshot into swiggy.db. No browser is used here.
//
// Usage:
//   node parse.js                       -> every snapshot folder under snapshots\ that has a menu-api file
//   node parse.js <snapshot-dir> [...]  -> only the given folders
//   env: DB=path/to/file.db  (default swiggy.db)

const fs = require('fs');
const path = require('path');
const { openDb } = require('./lib/db');
const { buildRecordsFromApi, parseMenuApi } = require('./lib/menu-api');

const ROOT = __dirname;
const SNAP_ROOT = path.join(ROOT, 'snapshots');
const DB_FILE = process.env.DB || path.join(ROOT, 'swiggy.db');

function snapshotDirs() {
  const out = [];
  if (!fs.existsSync(SNAP_ROOT)) return out;
  for (const rest of fs.readdirSync(SNAP_ROOT)) {
    const restDir = path.join(SNAP_ROOT, rest);
    if (!fs.statSync(restDir).isDirectory()) continue;
    for (const stamp of fs.readdirSync(restDir)) {
      const dir = path.join(restDir, stamp);
      if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /^menu-api-\d+\.json$/.test(f))) out.push(dir);
    }
  }
  return out.sort();
}

// capture.js can save more than one menu response. Use the one with the most items.
function bestMenuFile(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^menu-api-\d+\.json$/.test(f));
  let best = null;
  for (const f of files) {
    const full = path.join(dir, f);
    let n = -1;
    try {
      n = parseMenuApi(JSON.parse(fs.readFileSync(full, 'utf8'))).dishes.length;
    } catch {
      continue; // not a menu response (e.g. an error body)
    }
    if (!best || n > best.n) best = { file: full, n };
  }
  return best;
}

function main() {
  const dirs = process.argv.slice(2).length ? process.argv.slice(2).map((d) => path.resolve(d)) : snapshotDirs();
  if (!dirs.length) throw new Error('No snapshot folders with menu-api files found');

  const store = openDb(DB_FILE);
  let saved = 0;
  let problems = 0;
  try {
    for (const dir of dirs) {
      console.log(`\n> ${dir}`);
      const metaFile = path.join(dir, 'meta.json');
      if (!fs.existsSync(metaFile)) {
        console.log('  skipped: no meta.json (need the source URL)');
        problems++;
        continue;
      }
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      const best = bestMenuFile(dir);
      if (!best) {
        console.log('  skipped: no menu-api file parsed as a menu');
        problems++;
        continue;
      }

      const json = JSON.parse(fs.readFileSync(best.file, 'utf8'));
      const rec = buildRecordsFromApi(json, meta.url, meta.started_at || new Date().toISOString());
      const r = store.saveScrape(rec);
      saved++;

      console.log(`  restaurant: ${rec.restaurant.name} (${rec.restaurant.cuisines}) rating ${rec.restaurant.avg_rating} [${rec.restaurant.rating_count_txt}]`);
      console.log(`  outlet:     ${rec.outlet.area} | ${rec.outlet.address}`);
      console.log(`  dishes:     ${r.dishesSaved} saved, ${r.dishesWithRating} with ratings, ${rec.meta.sections.length} sections, expected ${rec.meta.dishes_expected} -> ${rec.meta.status}`);
      if (rec.meta.note) console.log(`  note:       ${rec.meta.note}`);
      if (rec.meta.status !== 'ok') problems++;
    }
  } finally {
    store.close();
  }

  console.log(`\nDone: ${saved} saved, ${problems} need a look. DB: ${DB_FILE}`);
  process.exitCode = problems ? 1 : 0;
}

main();
