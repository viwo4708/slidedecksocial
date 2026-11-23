#!/usr/bin/env node
// Plays complete games in real (headless) Chrome: one TV page plus one phone
// page per player, several games at once, optionally followed by a rematch
// ("New Game, Same Players").
//
//   node scripts/simulate.js --url http://localhost:3000 --games 3 --players 4 --rematch
//   node scripts/simulate.js --url https://slidedecksocial.com --games 1 --players 3 --rematch
//
// Exit code is 0 only if every game (and rematch) finished cleanly.
const { launchBrowser, makeFixturePhotos, GameDriver } = require('../test/e2e/driver');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}

async function runGame(browser, { url, players, rematch, index, photos }) {
  const names = Array.from({ length: players }, (_, i) => `G${index}P${i + 1}`);
  const log = msg => console.log(`[game ${index}] ${msg}`);
  const driver = new GameDriver({ browser, baseUrl: url, names, photos, log });
  const summary = { game: index, games: [] };
  const started = Date.now();
  try {
    await driver.openHost();
    summary.roomCode = driver.roomCode;
    await driver.joinPlayers();
    await driver.startGame();
    await driver.submitAll(1);
    const first = await driver.playAllTurns(1);
    summary.games.push(first);
    if (first.ok && rematch) {
      await driver.rematch();
      await driver.submitAll(2);
      summary.games.push(await driver.playAllTurns(2));
    }
  } catch (err) {
    summary.error = err.message.split('\n')[0];
    log(`ERROR ${summary.error}`);
  } finally {
    summary.seconds = Math.round((Date.now() - started) / 1000);
    summary.pageErrors = driver.pageErrors;
    await driver.close();
  }
  summary.ok = !summary.error && summary.games.length === (rematch ? 2 : 1) && summary.games.every(g => g.ok);
  return summary;
}

(async () => {
  const url = arg('url', 'http://localhost:3000');
  const games = Number(arg('games', 1));
  const players = Number(arg('players', 3));
  const rematch = Boolean(arg('rematch', false));
  const headless = !arg('headed', false);

  const browser = await launchBrowser({ headless });
  const photos = await makeFixturePhotos(browser, 'S');
  console.log(`Simulating ${games} simultaneous game(s) x ${players} players on ${url}${rematch ? ' with rematch' : ''}`);

  const results = await Promise.all(
    Array.from({ length: games }, (_, i) => runGame(browser, { url, players, rematch, index: i + 1, photos }))
  );
  await browser.close();

  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    const parts = r.games.map((g, i) => {
      const label = i === 0 ? 'game 1' : 'rematch';
      if (g.ok) return `${label}: OK`;
      const bad = g.results.find(t => !t.ok);
      return `${label}: FAILED (${bad ? bad.reason : 'unknown'})`;
    });
    console.log(`room ${r.roomCode || '????'} (${r.seconds}s): ${r.ok ? 'PASS' : 'FAIL'} | ${parts.join(' | ')}${r.error ? ` | error: ${r.error}` : ''}`);
    if (r.pageErrors.length) console.log(`  page errors: ${r.pageErrors.join('; ')}`);
    const last = r.games[r.games.length - 1];
    if (last?.rankings) console.log(`  rankings: ${last.rankings.join(' / ')}`);
  }
  if (arg('json', false)) console.log(JSON.stringify(results, null, 2));
  process.exit(results.every(r => r.ok) ? 0 : 1);
})().catch(err => {
  console.error(err);
  process.exit(2);
});
