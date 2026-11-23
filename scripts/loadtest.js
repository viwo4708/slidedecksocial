#!/usr/bin/env node
// Socket-level load test: many simultaneous rooms of bot players, each playing a
// complete game with realistic photo uploads. Reports completion and latency.
//
//   node scripts/loadtest.js --url http://localhost:3300 --rooms 100 --players 6 --photo-kb 100 --procs 4
//
// Options: --think <ms> pause between slides (default 300), --ramp <s> spread
// room creation over this many seconds (default 5), --timeout <s> per game.
const { fork } = require('child_process');
const { io } = require('socket.io-client');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const opts = {
  url: arg('url', 'http://localhost:3300'),
  rooms: Number(arg('rooms', 10)),
  players: Number(arg('players', 6)),
  photoKb: Number(arg('photo-kb', 100)),
  think: Number(arg('think', 300)),
  ramp: Number(arg('ramp', 5)),
  timeout: Number(arg('timeout', 240)),
  procs: Number(arg('procs', 1))
};

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

function makePhoto(kb, tag) {
  // Valid base64 body of roughly `kb` kilobytes.
  const body = Buffer.alloc(Math.floor(kb * 1024 * 0.75), tag.charCodeAt(tag.length - 1)).toString('base64');
  return `data:image/jpeg;base64,/9j/${body.replace(/=+$/, '')}`;
}

function runRoom(index, stats) {
  return new Promise(resolve => {
    const started = Date.now();
    const sockets = [];
    const sock = () => {
      const s = io(opts.url, { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 20000 });
      sockets.push(s);
      return s;
    };
    let finished = false;
    const done = (ok, reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sockets.forEach(s => s.disconnect());
      if (ok) stats.durations.push(Date.now() - started);
      else stats.failures.push(`room ${index}: ${reason}`);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false, 'timed out'), opts.timeout * 1000);

    const host = sock();
    host.on('connect_error', e => done(false, `host connect_error ${e.message}`));
    host.on('room_created', ({ roomCode }) => {
      let joined = 0;
      for (let p = 0; p < opts.players; p++) {
        const s = sock();
        const name = `L${index}P${p}`;
        const photos = Array.from({ length: 6 }, (_, i) => makePhoto(opts.photoKb, `${name}${i}`));
        let pools = null;
        let sentAt = 0;
        const joinSent = Date.now();
        s.on('connect_error', e => done(false, `player connect_error ${e.message}`));
        s.on('error_message', m => done(false, `join error: ${m}`));
        s.on('joined_successfully', () => {
          stats.joinRtt.push(Date.now() - joinSent);
          if (++joined === opts.players) host.emit('host_start_game');
        });
        s.on('start_submission_phase', () => {
          const t = Date.now();
          s.emit('submit_player_content', { photos, topics: [`${name} topic A`, `${name} topic B`] }, () => stats.uploadRtt.push(Date.now() - t));
        });
        const advance = d => {
          if (sentAt) stats.advanceRtt.push(Date.now() - sentAt);
          setTimeout(() => {
            const pool = d.nextSlideType === 'PHOTO' ? pools.photosPool : pools.textBlurbsPool;
            sentAt = Date.now();
            s.emit('advance_slide', { slideIndex: d.slideIndex, choice: Math.floor(Math.random() * pool.length) });
          }, opts.think);
        };
        s.on('role_slidemaster', d => { pools = d; sentAt = 0; stats.poolBytes.push(JSON.stringify(d).length); advance(d); });
        s.on('update_slidemaster_remote', d => { if (d.photosPool) pools = d; advance(d); });
        s.on('conclusion_slide_displayed', () => {
          if (sentAt) stats.advanceRtt.push(Date.now() - sentAt);
          sentAt = 0;
          setTimeout(() => s.emit('finish_presentation'), opts.think);
        });
        s.on('role_rating', () => setTimeout(() => s.emit('submit_rating', { rating: 7, comment: 'load test' }), opts.think));
        s.emit('join_room', { roomCode, username: name });
      }
    });
    host.on('submission_progress_updated', ({ allSubmitted }) => { if (allSubmitted) host.emit('start_presentations'); });
    host.on('show_rankings', r => done(r.length === opts.players, `rankings had ${r.length} players`));
    host.on('room_ended', ({ reason }) => done(false, `room ended: ${reason}`));
    host.emit('create_room');
  });
}

async function worker(roomIndexes) {
  const stats = { durations: [], failures: [], joinRtt: [], uploadRtt: [], advanceRtt: [], poolBytes: [] };
  const gap = roomIndexes.length > 1 ? (opts.ramp * 1000) / roomIndexes.length : 0;
  await Promise.all(roomIndexes.map((index, i) => new Promise(r => setTimeout(r, i * gap)).then(() => runRoom(index, stats))));
  return stats;
}

(async () => {
  if (process.env.LOADTEST_WORKER) {
    process.on('message', async ({ rooms }) => {
      process.send(await worker(rooms));
      process.exit(0);
    });
    return;
  }

  const t0 = Date.now();
  const all = Array.from({ length: opts.rooms }, (_, i) => i);
  let results;
  if (opts.procs > 1) {
    results = await Promise.all(Array.from({ length: opts.procs }, (_, k) => new Promise((resolve, reject) => {
      const rooms = all.filter(i => i % opts.procs === k);
      const child = fork(__filename, process.argv.slice(2), {
        env: { ...process.env, LOADTEST_WORKER: '1' },
        execArgv: ['--max-old-space-size=4096']
      });
      let got = false;
      child.on('message', m => { got = true; resolve(m); });
      child.on('error', reject);
      // A load generator that runs out of memory must show up as failures, not vanish.
      child.on('exit', code => {
        if (!got) resolve({ durations: [], failures: rooms.map(i => `room ${i}: load-test worker exited (${code})`), joinRtt: [], uploadRtt: [], advanceRtt: [], poolBytes: [] });
      });
      child.send({ rooms });
    })));
  } else {
    results = [await worker(all)];
  }
  const merged = results.reduce((acc, r) => {
    Object.keys(acc).forEach(k => acc[k].push(...r[k]));
    return acc;
  }, { durations: [], failures: [], joinRtt: [], uploadRtt: [], advanceRtt: [], poolBytes: [] });

  const summary = {
    target: opts.url,
    rooms: opts.rooms,
    playersPerRoom: opts.players,
    sockets: opts.rooms * (opts.players + 1),
    photoKb: opts.photoKb,
    completed: merged.durations.length,
    failed: merged.failures.length,
    wallSeconds: Math.round((Date.now() - t0) / 1000),
    gameSecondsP50: Math.round(pct(merged.durations, 50) / 1000),
    gameSecondsMax: Math.round(Math.max(0, ...merged.durations) / 1000),
    joinMsP95: pct(merged.joinRtt, 95),
    uploadMsP50: pct(merged.uploadRtt, 50),
    uploadMsP95: pct(merged.uploadRtt, 95),
    advanceMsP50: pct(merged.advanceRtt, 50),
    advanceMsP95: pct(merged.advanceRtt, 95),
    advanceMsP99: pct(merged.advanceRtt, 99),
    advanceMsMax: merged.advanceRtt.length ? Math.max(...merged.advanceRtt) : null,
    slidemasterPayloadKB: merged.poolBytes.length ? Math.round(pct(merged.poolBytes, 50) / 1024) : null,
    sampleFailures: merged.failures.slice(0, 5)
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.failed ? 1 : 0);
})();
