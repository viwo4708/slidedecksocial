#!/usr/bin/env node
// Renders the PNG icons (from public/favicon.svg) and the 1200x630 social share
// image (public/og-image.png) with headless Chrome. Re-run after changing the
// logo or brand colours:  node scripts/build-images.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const PUBLIC = path.join(__dirname, '..', 'public');
const svg = fs.readFileSync(path.join(PUBLIC, 'favicon.svg'), 'utf8');

const OG_HTML = `<!DOCTYPE html><html><head>
<link href="https://fonts.googleapis.com/css2?family=Dosis:wght@600&family=McLaren&family=Noto+Color+Emoji&family=Slackey&display=block" rel="stylesheet">
<style>
  html,body{margin:0;width:1200px;height:630px;background:#52489C;overflow:hidden}
  .wrap{position:relative;width:100%;height:100%;display:flex;align-items:center;gap:56px;padding:0 80px;box-sizing:border-box}
  .slide{flex:0 0 380px;height:270px;background:#9789ff;border:6px solid #6b58fe;border-radius:18px;position:relative;
         display:flex;align-items:center;justify-content:center;transform:rotate(-4deg);box-shadow:0 24px 50px rgba(0,0,0,.35)}
  .slide span{font-family:"Noto Color Emoji";font-size:130px}
  .counter{position:absolute;top:12px;right:18px;font:700 28px "McLaren";color:#EBEBEB}
  .stand{position:absolute;bottom:-60px;left:50%;width:14px;height:54px;background:#EBEBEB;transform:translateX(-50%)}
  h1{font-family:"Slackey";color:#ff8892;font-size:92px;line-height:1;margin:0 0 18px}
  .tag{font-family:"McLaren";color:#EBEBEB;font-size:40px;margin:0 0 26px}
  .pill{display:inline-block;font-family:"Dosis";font-weight:600;font-size:30px;color:#52489C;background:#59c3c3;border-radius:999px;padding:10px 26px}
</style></head><body><div class="wrap">
  <div class="slide"><div class="counter">4/10</div><span>🫣</span><div class="stand"></div></div>
  <div><h1>Slide Deck Social</h1><p class="tag">Your pictures, your topics.<br>Present responsibly!</p>
  <span class="pill">Free party game · 3–8 players · no app</span></div>
</div></body></html>`;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage();

  for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    await page.setViewportSize({ width: size, height: size });
    // The apple-touch icon gets a full-bleed background (iOS rounds the corners itself).
    const bg = name === 'apple-touch-icon.png' ? '#52489C' : 'transparent';
    await page.setContent(`<html><body style="margin:0;background:${bg}">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(PUBLIC, name), omitBackground: bg === 'transparent' });
    console.log('wrote', name);
  }

  await page.setViewportSize({ width: 1200, height: 630 });
  await page.setContent(OG_HTML, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(PUBLIC, 'og-image.png') });
  console.log('wrote og-image.png');

  await browser.close();
})();
