#!/usr/bin/env node
// Starts the game server for load testing and prints resource usage every 2s.
//   PORT=3300 COUNTDOWN_SECONDS=1 node scripts/loadtest-server.js
const { monitorEventLoopDelay } = require('perf_hooks');
const { createGameServer } = require('../server');

const game = createGameServer({
  countdownSeconds: Number(process.env.COUNTDOWN_SECONDS || 10),
  countdownTickMs: Number(process.env.COUNTDOWN_TICK_MS || 1000)
});
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

let peakRss = 0;
let peakLag = 0;
game.server.listen(Number(process.env.PORT || 3300), () => {
  console.log(JSON.stringify({ event: 'listening', port: game.server.address().port }));
});

setInterval(() => {
  const mem = process.memoryUsage();
  peakRss = Math.max(peakRss, mem.rss);
  const p99 = loop.percentile(99) / 1e6;
  peakLag = Math.max(peakLag, p99);
  console.log(JSON.stringify({
    t: Date.now(),
    rooms: Object.keys(game.rooms).length,
    connections: game.io.engine.clientsCount,
    rssMB: Math.round(mem.rss / 1048576),
    heapMB: Math.round(mem.heapUsed / 1048576),
    peakRssMB: Math.round(peakRss / 1048576),
    loopLagP99ms: Math.round(p99),
    loopLagMaxMs: Math.round(loop.max / 1e6),
    peakLagP99ms: Math.round(peakLag)
  }));
  loop.reset();
}, 2000).unref();
