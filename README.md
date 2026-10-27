# Swiggy Tracking

Goal, progress and learnings for the Swiggy Hyderabad restaurant, outlet, menu and rating research.

Rendered page: https://nnjha98.github.io/swiggy-tracking/ (source: `index.html`)

## Code

- `capture.js`: opens one restaurant URL in Chrome, clicks "View full menu", saves the menu API response to `snapshots/`.
- `parse.js`: parses saved snapshots into `swiggy.db` (SQLite).
- `lib/menu-api.js`: menu API parser (restaurant, outlet, license, dishes, ratings).
- `lib/db.js`: schema, migrations and the `dish_ratings_named` view.
- `viewer/`: local viewer (`npm run viewer`, then open http://127.0.0.1:3000).
- `test/`: parser tests (`npm test`). They need the snapshot folders, which are not in the repo.

Setup: `npm install`. Capture needs Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`.

## Data

- `swiggy.db`: the SQLite database (11 restaurants, 11 outlets, 1,627 dishes, 1,171 dish ratings at the time of push). Includes the FSSAI license number per outlet.
- `hyderabad_restaurants.txt`: 27,418 Hyderabad restaurant URLs from Swiggy's public sitemap.

Not in the repo: `snapshots/` (raw captures, large), `browser-profile/` (browser profile), and `node_modules/`. The tests in `test/` need the snapshot folders.
