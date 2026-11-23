// Browser tests in real (headless) Google Chrome against a local server.
// Run with: npm run test:e2e
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGameServer } = require('../../server');
const { launchBrowser, makeFixturePhotos, GameDriver, PHONE, TV } = require('./driver');

let game, baseUrl, browser, photos;

test.before(async () => {
  game = createGameServer({ countdownSeconds: 1, countdownTickMs: 300, slidemasterGraceMs: 500, ratingGraceMs: 2000 });
  await new Promise(r => game.server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${game.server.address().port}`;
  browser = await launchBrowser();
  photos = await makeFixturePhotos(browser, 'E');
});

test.after(async () => {
  await browser?.close();
  await game?.close();
});

async function page(options = PHONE) {
  const ctx = await browser.newContext(options);
  const p = await ctx.newPage();
  p.on('dialog', d => d.accept());
  return p;
}

test('home: Join is the big primary button and Host is secondary (phone and TV)', async () => {
  for (const options of [PHONE, TV]) {
    const p = await page(options);
    await p.goto(`${baseUrl}/`);
    const join = await p.locator('#join-game-link').boundingBox();
    const host = await p.locator('#start-game-btn').boundingBox();
    assert.ok(join.width * join.height > 2.5 * host.width * host.height, 'join button is much bigger');
    assert.ok(join.y < host.y, 'join comes first');
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `no sideways scrolling (overflow ${overflow}px)`);
    await p.context().close();
  }
});

test('How to Play and About open as modals, without leaving the page', async () => {
  const p = await page(TV);
  await p.goto(`${baseUrl}/`);
  await p.click('nav >> text=How to Play');
  await p.locator('dialog.site-modal[open]').waitFor();
  await p.locator('.site-modal__body >> text=Slidemaster').first().waitFor();
  assert.equal(new URL(p.url()).pathname, '/', 'still on the home page');
  assert.equal(await p.locator('.site-modal__title').innerText(), 'How to Play');
  assert.ok(await p.locator('.site-modal__body img').first().evaluate(img => img.complete || img.loading === 'lazy'));

  await p.keyboard.press('Escape');
  await p.locator('dialog.site-modal[open]').waitFor({ state: 'detached', timeout: 2000 }).catch(() => {});
  assert.equal(await p.locator('dialog.site-modal[open]').count(), 0, 'Esc closes it');

  await p.click('nav >> text=About');
  await p.locator('.site-modal__body >> text=Jake Derouin').waitFor();
  await p.goBack(); // phone Back button closes the modal instead of leaving
  await p.waitForFunction(() => !document.querySelector('dialog.site-modal[open]'));
  assert.equal(new URL(p.url()).pathname, '/');

  // Direct links still work as normal pages (and for search engines).
  await p.goto(`${baseUrl}/how-to-play/`);
  assert.match(await p.title(), /How to Play/);
  await p.goto(`${baseUrl}/#about`);
  await p.locator('.site-modal__body >> text=Vikki Wong').waitFor();
  await p.context().close();
});

test('join page: Leave button hidden until joined, Enter key joins, ?code= pre-fills', async () => {
  const tv = await page(TV);
  await tv.goto(`${baseUrl}/`);
  await tv.click('#start-game-btn');
  await tv.waitForFunction(() => /^[A-Z]{4}$/.test(document.getElementById('display-room-code').innerText));
  const code = await tv.innerText('#display-room-code');
  assert.match(await tv.innerText('.join-url'), /127\.0\.0\.1:\d+\/join/, 'lobby says where to join');

  const phone = await page();
  await phone.goto(`${baseUrl}/join/?code=${code.toLowerCase()}`);
  assert.equal(await phone.inputValue('#room-code-input'), code);
  assert.equal(await phone.isVisible('#leave-game-btn'), false, 'no Leave button before joining');
  await phone.fill('#username-input', 'Enterprising');
  await phone.press('#username-input', 'Enter');
  await phone.locator('#lobby-waiting').waitFor();
  assert.equal(await phone.isVisible('#leave-game-btn'), true);

  // Wrong code shows a helpful error.
  const other = await page();
  await other.goto(`${baseUrl}/join/`);
  await other.fill('#room-code-input', 'zzzz');
  await other.fill('#username-input', 'Someone');
  await other.click('#join-btn');
  await other.locator('#error-msg >> text=not found').waitFor();

  await Promise.all([tv.context().close(), phone.context().close(), other.context().close()]);
});

test('photos can be added in batches and removed before submitting', async () => {
  const tv = await page(TV);
  await tv.goto(`${baseUrl}/`);
  await tv.click('#start-game-btn');
  await tv.waitForFunction(() => /^[A-Z]{4}$/.test(document.getElementById('display-room-code').innerText));
  const code = await tv.innerText('#display-room-code');
  const phones = [];
  for (const name of ['Batcher', 'Buddy']) {
    const ph = await page();
    await ph.goto(`${baseUrl}/join/`);
    await ph.fill('#room-code-input', code);
    await ph.fill('#username-input', name);
    await ph.click('#join-btn');
    await ph.locator('#lobby-waiting').waitFor();
    phones.push(ph);
  }
  await tv.click('#host-start-btn');
  const ph = phones[0];
  await ph.locator('#step-photos').waitFor();
  await ph.setInputFiles('#photo-input', photos.slice(0, 4));
  await ph.waitForFunction(() => document.querySelectorAll('#photo-preview img').length === 4);
  assert.equal(await ph.isVisible('#next-to-topics-btn'), false, 'needs 6');
  await ph.setInputFiles('#photo-input', photos); // 6 more selected, only 2 fit
  await ph.waitForFunction(() => document.querySelectorAll('#photo-preview img').length === 6);
  assert.match(await ph.innerText('#photo-status'), /first 2/);
  await ph.click('.photo-remove >> nth=0');
  assert.equal(await ph.locator('#photo-preview img').count(), 5);
  await ph.setInputFiles('#photo-input', photos.slice(0, 1));
  await ph.locator('#next-to-topics-btn').waitFor();
  await ph.click('#next-to-topics-btn');

  await ph.fill('#topic1', 'My first topic');
  await ph.click('#submit-content-btn');
  assert.match(await ph.innerText('#submit-error'), /two topics/, 'both topics are required');
  await ph.fill('#topic2', 'My second topic');
  await ph.click('#submit-content-btn');
  await ph.locator('#submitted-waiting').waitFor();
  await Promise.all([tv.context().close(), ...phones.map(p => p.context().close())]);
});

test('player names and topics are shown as text, never run as code on the TV', async () => {
  const tv = await page(TV);
  await tv.goto(`${baseUrl}/`);
  await tv.click('#start-game-btn');
  await tv.waitForFunction(() => /^[A-Z]{4}$/.test(document.getElementById('display-room-code').innerText));
  const code = await tv.innerText('#display-room-code');
  const ph = await page();
  await ph.goto(`${baseUrl}/join/`);
  await ph.fill('#room-code-input', code);
  await ph.evaluate(() => { document.getElementById('username-input').removeAttribute('maxlength'); });
  await ph.fill('#username-input', '<img src=x onerror=window.__pwned=1>');
  await ph.click('#join-btn');
  await tv.locator('.player-card').first().waitFor();
  assert.equal(await tv.evaluate(() => window.__pwned), undefined);
  assert.equal(await tv.locator('#player-grid img[src="x"]').count(), 0);
  assert.match(await tv.locator('.player-name').first().innerText(), /<img src=x/);
  await Promise.all([tv.context().close(), ph.context().close()]);
});

test('full game, then "New Game, Same Players" – every slide advances (regression)', async () => {
  const driver = new GameDriver({ browser, baseUrl, names: ['Ann', 'Ben', 'Cat'], photos });
  try {
    await driver.openHost();
    await driver.joinPlayers();
    await driver.startGame();
    await driver.submitAll(1);
    const first = await driver.playAllTurns(1);
    assert.ok(first.ok, JSON.stringify(first.results.find(r => !r.ok)));
    first.results.forEach(r => r.slides.forEach(s => { if (s.kind === 'photo') assert.ok(s.imgOk, 'photo rendered'); }));
    assert.ok(first.feedbackShown.every(Boolean), 'every phone shows its feedback');

    await driver.rematch();
    await driver.submitAll(2);
    const second = await driver.playAllTurns(2);
    assert.ok(second.ok, JSON.stringify(second.results.find(r => !r.ok)));
    assert.deepEqual(driver.pageErrors, [], 'no JavaScript errors on any page');
  } finally {
    await driver.close();
  }
});

test('the TV page can be reloaded mid-presentation and carries on', async () => {
  const driver = new GameDriver({ browser, baseUrl, names: ['Dee', 'Eli', 'Fay'], photos });
  try {
    await driver.openHost();
    await driver.joinPlayers();
    await driver.startGame();
    await driver.submitAll(1);
    await driver.host.click('#begin-presentations-btn');
    await driver.host.locator('#presentation-stage').waitFor();
    await driver.host.reload();
    await driver.host.waitForFunction(() => getComputedStyle(document.getElementById('presentation-stage')).display !== 'none');
    assert.match(await driver.host.innerText('#slide-counter'), /1\/10/);
    const sm = await driver.findPlayer('#slidemaster-screen');
    await sm.page.click('#advance-slide-btn');
    await driver.host.waitForFunction(() => /2\/10/.test(document.getElementById('slide-counter').innerText));
  } finally {
    await driver.close();
  }
});
