// Drives real Chrome windows through complete Slide Deck Social games: one host
// (TV) page plus one phone-sized page per player. Used by the e2e tests and by
// scripts/simulate.js (which can also point at the live site).
//
// It only uses element ids that exist in both the original and the current UI,
// so the same script can reproduce old bugs on the live site and prove the fix
// locally.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
};
const TV = { viewport: { width: 1366, height: 768 } };

async function launchBrowser({ headless = true } = {}) {
  return chromium.launch({ channel: 'chrome', headless });
}

// Six small, distinct JPEGs drawn in the browser, written to a temp folder.
async function makeFixturePhotos(browser, label = 'P', count = 6) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sds-photos-'));
  const page = await browser.newPage();
  const dataUrls = await page.evaluate(({ label, count }) => {
    const out = [];
    for (let i = 0; i < count; i++) {
      const c = document.createElement('canvas');
      c.width = 640; c.height = 480;
      const g = c.getContext('2d');
      g.fillStyle = `hsl(${(i * 57 + label.charCodeAt(0) * 13) % 360} 70% 55%)`;
      g.fillRect(0, 0, 640, 480);
      g.fillStyle = '#fff';
      g.font = 'bold 120px sans-serif';
      g.fillText(`${label}${i + 1}`, 60, 280);
      out.push(c.toDataURL('image/jpeg', 0.8));
    }
    return out;
  }, { label, count });
  await page.close();
  return dataUrls.map((url, i) => {
    const file = path.join(dir, `${label}-${i + 1}.jpg`);
    fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
    return file;
  });
}

const visible = (page, selector, timeout) =>
  page.locator(selector).first().waitFor({ state: 'visible', timeout });

async function isVisible(page, selector) {
  return page.locator(selector).first().isVisible().catch(() => false);
}

class GameDriver {
  constructor({ browser, baseUrl, names, photos, log = () => {}, stepTimeout = 20000 }) {
    this.browser = browser;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.names = names;
    this.photos = photos;
    this.log = log;
    this.stepTimeout = stepTimeout;
    this.players = [];
    this.contexts = [];
    this.pageErrors = [];
    this.roomCode = null;
  }

  async newPage(options, label) {
    const ctx = await this.browser.newContext(options);
    this.contexts.push(ctx);
    const page = await ctx.newPage();
    page.on('dialog', d => d.accept().catch(() => {}));
    page.on('pageerror', err => this.pageErrors.push(`${label}: ${err.message}`));
    return page;
  }

  async openHost() {
    this.host = await this.newPage(TV, 'host');
    await this.host.goto(`${this.baseUrl}/`);
    await this.host.click('#start-game-btn');
    await this.host.waitForFunction(
      () => /^[A-Z]{4}$/.test(document.getElementById('display-room-code')?.innerText.trim()),
      null, { timeout: this.stepTimeout }
    );
    this.roomCode = (await this.host.innerText('#display-room-code')).trim();
    this.log(`room ${this.roomCode} created`);
    return this.roomCode;
  }

  async joinPlayers() {
    for (const name of this.names) {
      const page = await this.newPage(PHONE, name);
      await page.goto(`${this.baseUrl}/join/`);
      await page.fill('#room-code-input', this.roomCode);
      await page.fill('#username-input', name);
      await page.click('#join-btn');
      await visible(page, '#lobby-waiting', this.stepTimeout);
      this.players.push({ name, page });
    }
    await this.host.waitForFunction(
      n => document.getElementById('player-count')?.innerText.trim() === String(n),
      this.names.length, { timeout: this.stepTimeout }
    );
    this.log(`${this.names.length} players joined ${this.roomCode}`);
  }

  async startGame() {
    await visible(this.host, '#host-start-btn', this.stepTimeout);
    await this.host.click('#host-start-btn');
  }

  async submitAll(round = 1) {
    await Promise.all(this.players.map(async ({ name, page }, i) => {
      await visible(page, '#step-photos', this.stepTimeout);
      await page.setInputFiles('#photo-input', this.photos);
      await visible(page, '#next-to-topics-btn', this.stepTimeout);
      await page.click('#next-to-topics-btn');
      await page.fill('#topic1', `${name} topic A r${round}`);
      await page.fill('#topic2', `${name} topic B r${round}`);
      await page.click('#submit-content-btn');
      await visible(page, '#submitted-waiting', this.stepTimeout);
    }));
    await visible(this.host, '#begin-presentations-btn', this.stepTimeout);
    this.log(`all submissions in (${this.roomCode} game ${round})`);
  }

  async hostSlideIndex() {
    const text = await this.host.innerText('#slide-counter').catch(() => '');
    const m = text.match(/(\d+)\s*\/\s*(\d+)/);
    return m ? Number(m[1]) : 0;
  }

  async findPlayer(selector, timeout = this.stepTimeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (const p of this.players) if (await isVisible(p.page, selector)) return p;
      await new Promise(r => setTimeout(r, 150));
    }
    return null;
  }

  // Plays one presentation. Returns { ok, reason, slides } instead of throwing,
  // so a stuck slide is reported as a finding rather than a crash.
  async playTurn(turn, { countdownTimeout = 30000 } = {}) {
    const slides = [];
    await this.host.waitForFunction(
      () => {
        const stage = document.getElementById('presentation-stage');
        return stage && getComputedStyle(stage).display !== 'none' &&
          /^\s*1\s*\/\s*10/.test(document.getElementById('slide-counter').innerText);
      },
      null, { timeout: countdownTimeout }
    );
    slides.push(await this.describeHostSlide());

    const sm = await this.findPlayer('#slidemaster-screen');
    if (!sm) return { ok: false, reason: 'no phone shows the slidemaster controls', slides };
    const presenter = await this.findPlayer('#presenter-screen', 2000);

    for (let expected = 2; expected <= 10; expected++) {
      const btn = sm.page.locator('#advance-slide-btn');
      // The button is briefly disabled while a tap is in flight (double-tap guard).
      // A human can't tap faster than that, so wait a moment; if it never comes
      // back, that's the "slides don't advance" bug.
      const disabled = await sm.page.waitForFunction(
        () => !document.getElementById('advance-slide-btn').disabled, null, { timeout: 4000 }
      ).then(() => false).catch(() => true);
      await btn.click({ force: true });
      try {
        await this.host.waitForFunction(
          n => new RegExp(`^\\s*${n}\\s*/\\s*10`).test(document.getElementById('slide-counter').innerText),
          expected, { timeout: 8000 }
        );
      } catch {
        return {
          ok: false,
          reason: `slide stuck at ${expected - 1}/10 after ${sm.name} tapped Advance` +
            (disabled ? ' (the Advance button was disabled)' : ''),
          slidemaster: sm.name,
          presenter: presenter?.name,
          slides
        };
      }
      slides.push(await this.describeHostSlide());
    }

    // Conclusion is up; the slidemaster's button now finishes the presentation.
    await sm.page.waitForFunction(
      () => /finish/i.test(document.getElementById('advance-slide-btn').innerText), null, { timeout: 8000 }
    ).catch(() => {});
    await sm.page.click('#advance-slide-btn', { force: true });
    try {
      await visible(this.host, '#host-rating-screen', 8000);
    } catch {
      return { ok: false, reason: 'Finish Presentation did not open rating', slidemaster: sm.name, slides };
    }

    // Everyone but the presenter rates (alternating scores, plus a comment).
    let raters = 0;
    for (const p of this.players) {
      if (await isVisible(p.page, '#rating-screen') || await p.page.locator('#rating-screen').waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false)) {
        await p.page.fill('#comment-input', `nice one from ${p.name} (turn ${turn})`);
        await p.page.click('#submit-rating-btn');
        raters++;
      }
    }
    return { ok: true, slidemaster: sm.name, presenter: presenter?.name, raters, slides };
  }

  async describeHostSlide() {
    return this.host.evaluate(() => {
      const el = document.getElementById('slide-content');
      const img = el.querySelector('img');
      return {
        counter: document.getElementById('slide-counter').innerText.trim(),
        kind: img ? 'photo' : 'text',
        text: img ? '' : el.innerText.trim().slice(0, 80),
        imgOk: img ? img.complete && img.naturalWidth > 0 : null
      };
    });
  }

  async playAllTurns(gameNo = 1) {
    const results = [];
    for (let turn = 1; turn <= this.players.length; turn++) {
      if (turn === 1) await this.host.click('#begin-presentations-btn');
      const r = await this.playTurn(turn);
      results.push(r);
      this.log(`${this.roomCode} game ${gameNo} turn ${turn}: ${r.ok ? `ok (presenter ${r.presenter}, slidemaster ${r.slidemaster}, ${r.raters} ratings)` : `FAILED - ${r.reason}`}`);
      if (!r.ok) return { ok: false, results };
    }
    await visible(this.host, '#rankings-screen', this.stepTimeout);
    const rankings = await this.host.$$eval('#rankings-list .ranking-row', rows => rows.map(r => r.innerText.replace(/\s+/g, ' ').trim()));
    const feedbackShown = await Promise.all(this.players.map(p => visible(p.page, '#feedback-screen', 8000).then(() => true).catch(() => false)));
    return { ok: true, results, rankings, feedbackShown };
  }

  async rematch() {
    await visible(this.host, '#same-players-btn', this.stepTimeout);
    await this.host.click('#same-players-btn');
  }

  async close() {
    await Promise.all(this.contexts.map(c => c.close().catch(() => {})));
  }
}

module.exports = { launchBrowser, makeFixturePhotos, GameDriver, PHONE, TV };
