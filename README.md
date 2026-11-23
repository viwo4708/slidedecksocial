# slidedecksocial
collaborative presentation game for atlas masters 2026

Live at https://slidedecksocial.com – host on a TV/laptop, everyone else joins on their phone.

## Run it locally

```bash
npm install
npm start            # http://localhost:3000 (PORT / HOST env vars are respected)
```

## Tests

```bash
npm test             # unit + integration tests (real Socket.IO clients play full games), ~5s
npm run test:e2e     # real headless Google Chrome: TV + phones, modals, photos, rematch, TV reload
```

The e2e tests and simulations use your installed Google Chrome via `playwright-core`
(no browser download needed).

## Simulations and load tests

```bash
# Play complete games in real Chrome windows (one TV + one phone per player), several at once,
# then "New Game, Same Players". Works against any URL, including the live site.
node scripts/simulate.js --url http://localhost:3000 --games 3 --players 4 --rematch

# Socket-level load test: many simultaneous rooms of bots with realistic photo uploads.
PORT=3300 COUNTDOWN_SECONDS=1 COUNTDOWN_TICK_MS=500 node scripts/loadtest-server.js   # prints memory / event-loop lag
node scripts/loadtest.js --url http://localhost:3300 --rooms 100 --players 6 --photo-kb 100 --procs 6
```

Please keep load tests against the live site small (it runs on a home server).

## Project layout

- `server.js` – Express + Socket.IO game server. `createGameServer(options)` builds an instance
  (used by the tests with fast timers); running the file directly starts the real server.
- `gameContent.js` – slide phrases and conclusions.
- `public/` – host/TV page (`index.html`, `host.js`), phone page (`join/`), How to Play and About
  pages (also shown as modals via `site-modal.js`), SEO files (`robots.txt`, `sitemap.xml`, icons).
- `scripts/build-images.js` – regenerates the PNG icons and social share image from `favicon.svg`.
- `test/` – unit, integration and browser tests.

`/healthz` returns a small JSON status (room and connection counts) for uptime monitoring.
