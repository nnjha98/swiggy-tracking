'use strict';

// Local viewer server. Binds to 127.0.0.1 only.
//
// Usage:  npm run viewer   then open http://127.0.0.1:3000
//
// Status rules (one place, used by the list and by the mining job):
//   done      the latest parse run for the URL saved at least one dish
//   not_done  no dishes saved for the URL yet
// The expected item count is not used. Missing ratings is not a failure: a restaurant
// can have no dish ratings. Browser (DOM) steps are logged for diagnosis only.
// A failed mining job's reason is shown on the row until a later run saves dishes.
//
// Endpoints:
//   GET  /                 the viewer page
//   GET  /api/list         every URL in hyderabad_restaurants.txt, with status from swiggy.db
//   POST /api/mine         body {"url": "..."}: runs capture.js then parse.js for that URL (one at a time)
//   GET  /api/job          state and log of the current or last mining job

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const LIST_FILE = path.join(ROOT, 'hyderabad_restaurants.txt');
const DB_FILE = path.join(ROOT, 'swiggy.db');
const SNAP_ROOT = path.join(ROOT, 'snapshots');
const PAGE = path.join(__dirname, 'index.html');
const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';

const urls = fs
  .readFileSync(LIST_FILE, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);
const urlSet = new Set(urls);

// Last failed job per URL, kept until that URL succeeds. Lost on server restart.
const lastFailure = new Map();

function idOf(url) {
  const m = /-rest(\d+)$/.exec(url);
  return m ? Number(m[1]) : null;
}

// "https://www.swiggy.com/city/hyderabad/pista-house-gachibowli-rest1239425" -> "Pista House Gachibowli"
function nameFromUrl(url) {
  const m = /\/city\/[^/]+\/([^/?#]+)-rest\d+$/.exec(url);
  if (!m) return url;
  return m[1]
    .split('-')
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function withDb(fn) {
  if (!fs.existsSync(DB_FILE)) return fn(null);
  const db = new Database(DB_FILE, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// Latest parse run per source URL, plus restaurant name and dish count.
function latestRuns() {
  return withDb((db) => {
    if (!db) return new Map();
    const rows = db
      .prepare(
        `SELECT s.id, s.source_url AS url, s.status, s.note, s.dishes_found AS dishes,
                s.dishes_expected AS expected, s.dishes_with_rating AS rated, s.scraped_at AS scrapedAt
           FROM scrape_runs s
           JOIN (SELECT source_url, MAX(id) AS id FROM scrape_runs GROUP BY source_url) m ON m.id = s.id`
      )
      .all();
    return new Map(rows.map((r) => [r.url, r]));
  });
}

function latestRunFor(url) {
  return latestRuns().get(url) || null;
}

function restaurantNames() {
  return withDb((db) => {
    if (!db) return new Map();
    return new Map(db.prepare('SELECT swiggy_id AS id, name FROM restaurants').all().map((r) => [r.id, r.name]));
  });
}

function listRows() {
  const runs = latestRuns();
  const names = restaurantNames();
  return urls.map((url) => {
    const id = idOf(url);
    const run = runs.get(url);
    const dbName = names.get(id);

    const dishes = run ? run.dishes : 0;
    const status = dishes > 0 ? 'done' : 'not_done';
    const reason = status === 'not_done' && lastFailure.has(url) ? lastFailure.get(url) : null;

    return {
      url,
      id,
      name: dbName && !dbName.startsWith('http') ? dbName : nameFromUrl(url),
      status,
      reason,
      dishes,
      rated: run ? run.rated : 0,
      lastScrapedAt: run ? run.scrapedAt : null,
    };
  });
}

// ---- mining job (capture.js then parse.js, one at a time) ----
let job = null;

function appendLog(line) {
  job.log.push(line);
  if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
}

function runStep(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    const pipe = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) appendLog(line);
    };
    child.stdout.on('data', pipe);
    child.stderr.on('data', pipe);
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

// Newest snapshot folder for a restaurant. Folder names are ISO timestamps, so they sort.
function newestSnapshot(id) {
  const dir = path.join(SNAP_ROOT, `rest${id}`);
  if (!fs.existsSync(dir)) return null;
  const stamps = fs.readdirSync(dir).sort();
  return stamps.length ? path.join(dir, stamps[stamps.length - 1]) : null;
}

// Resolves when the parse saved dishes for this URL. Throws with the reason otherwise.
async function runMining(url) {
  const id = idOf(url);
  const before = newestSnapshot(id);
  const runBefore = latestRunFor(url);

  appendLog(`capture: ${url}`);
  await runStep(['capture.js', url]);

  const after = newestSnapshot(id);
  if (!after || after === before) throw new Error('capture created no snapshot folder');

  // Browser step is logged for diagnosis. Success is decided by the menu response below.
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(after, 'meta.json'), 'utf8'));
    appendLog(`browser: dom_status=${meta.dom_status}, menu API responses=${(meta.api_responses || []).length}`);
  } catch {
    appendLog('browser: no meta.json');
  }

  const hasMenu = fs.readdirSync(after).some((f) => /^menu-api-\d+\.json$/.test(f));
  if (!hasMenu) throw new Error('no menu API response was captured');

  appendLog(`parse: ${after}`);
  await runStep(['parse.js', after]);

  const runAfter = latestRunFor(url);
  if (!runAfter || (runBefore && runAfter.id === runBefore.id)) {
    throw new Error('parse saved no new run; see log');
  }
  if (runAfter.dishes === 0) throw new Error('parse saved 0 dishes; see log');
}

function startJob(url) {
  job = { url, state: 'running', log: [], error: null, startedAt: new Date().toISOString(), finishedAt: null };
  runMining(url)
    .then(() => {
      job.state = 'done';
      lastFailure.delete(url);
      appendLog('RESULT: done');
    })
    .catch((err) => {
      job.state = 'failed';
      job.error = err.message;
      lastFailure.set(url, err.message);
      appendLog(`RESULT: failed: ${err.message}`);
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
    });
}

// ---- HTTP ----
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, `http://${HOST}`);

    if (req.method === 'GET' && pathname === '/') {
      return send(res, 200, fs.readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && pathname === '/api/list') {
      return send(res, 200, listRows());
    }
    if (req.method === 'GET' && pathname === '/api/job') {
      return send(res, 200, job || { state: 'idle', log: [] });
    }
    if (req.method === 'POST' && pathname === '/api/mine') {
      const { url } = JSON.parse((await readBody(req)) || '{}');
      if (!urlSet.has(url)) return send(res, 400, { error: 'URL is not in hyderabad_restaurants.txt' });
      if (job && job.state === 'running') return send(res, 409, { error: 'a mining job is already running' });
      startJob(url);
      return send(res, 202, { started: url });
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Viewer: http://${HOST}:${PORT}  (${urls.length} restaurants in list)`);
});
