// Integration and regression tests: real Socket.IO clients play complete games
// against a real server instance (with fast timers).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startServer, once, sleep, photo, HostBot, PlayerBot, playFullGame } = require('./helpers/bots');
const { GAME_TEXT_BLURBS, GAME_CONCLUSIONS } = require('../gameContent');

const names = n => Array.from({ length: n }, (_, i) => `Player${i + 1}`);

function withServer(options, fn) {
  if (typeof options === 'function') { fn = options; options = {}; }
  return async () => {
    const server = await startServer(options);
    try {
      await fn(server);
    } finally {
      await server.close();
    }
  };
}

async function lobby(server, count, playerOptions) {
  const host = new HostBot(server);
  await host.createRoom();
  const players = [];
  for (const name of names(count)) {
    const p = new PlayerBot(server, name, playerOptions);
    const r = await p.join(host.roomCode);
    assert.ok(r.ok, r.message);
    players.push(p);
  }
  return { host, players };
}

function assertDeckShape(slides, photosAllowed) {
  // One presentation = 10 slide updates in order with the right content types.
  assert.deepEqual(slides.map(s => s.slideIndex), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  slides.forEach(s => {
    const { type, content } = s.content;
    if (s.slideIndex === 1) assert.equal(type, 'TOPIC');
    else if (s.slideIndex === 10) {
      assert.equal(type, 'CONCLUSION');
      assert.ok(GAME_CONCLUSIONS.includes(content));
    } else if (s.slideIndex % 2 === 0) {
      assert.equal(type, 'PHOTO');
      assert.ok(photosAllowed.has(content), 'photo comes from this room');
    } else {
      assert.equal(type, 'TEXT');
      assert.ok(GAME_TEXT_BLURBS.includes(content), 'text comes from the phrase list');
    }
  });
}

test('a full 3-player game plays every slide in order and scores correctly', withServer(async server => {
  const { host, players, rankings } = await playFullGame(server, names(3));
  const roomPhotos = new Set(players.flatMap(p => p.photos()));
  assert.equal(host.slides.length, 30);
  for (let turn = 0; turn < 3; turn++) assertDeckShape(host.slides.slice(turn * 10, turn * 10 + 10), roomPhotos);

  // Each presenter is rated 8 by the two other players.
  assert.deepEqual(rankings.map(r => r.totalScore), [16, 16, 16]);
  assert.deepEqual(rankings.map(r => r.rank), [1, 1, 1]);
  // Everyone presented once and drove the slides once.
  players.forEach(p => {
    assert.equal(p.roles.filter(r => r === 'presenter').length, 1, `${p.name} presented once`);
    assert.equal(p.roles.filter(r => r === 'slidemaster').length, 1, `${p.name} was slidemaster once`);
  });
  const feedback = await Promise.all(players.map(p =>
    p.log.find(e => e.event === 'show_personal_feedback')?.data || once(p.socket, 'show_personal_feedback')));
  feedback.forEach(f => assert.equal(f.comments.length, 2));
}));

test('REGRESSION: the second game ("New Game, Same Players") plays all the way through', withServer(async server => {
  const first = await playFullGame(server, names(4));
  const second = await playFullGame(server, null, { host: first.host, players: first.players, rematch: true });
  assert.equal(first.host.slides.length, 80, 'both games showed 4 x 10 slides');
  // Scores reset between games: 3 raters x 8 each.
  assert.deepEqual(second.rankings.map(r => r.totalScore), [24, 24, 24, 24]);
  first.players.forEach(p => assert.equal(p.roles.filter(r => r === 'slidemaster').length, 2));
  // Every phone was asked for new photos and topics for the rematch.
  const prompts = first.players[0].log.filter(e => e.event === 'start_submission_phase');
  assert.equal(prompts.length, 2);
}));

test('three games back to back in the same room all finish', withServer(async server => {
  const g = await playFullGame(server, names(3));
  await playFullGame(server, null, { host: g.host, players: g.players, rematch: true });
  const third = await playFullGame(server, null, { host: g.host, players: g.players, rematch: true });
  assert.equal(third.rankings.length, 3);
  assert.equal(g.host.slides.length, 90);
}));

test('"End Game & Start New Room" gives a new code and players can play again', withServer(async server => {
  const g = await playFullGame(server, names(3));
  const ended = Promise.all(g.players.map(p => once(p.socket, 'room_ended')));
  const created = once(g.host.socket, 'room_created', { filter: d => d.roomCode !== g.host.roomCode });
  g.host.socket.emit('start_new_room');
  const reasons = await ended;
  reasons.forEach(r => assert.equal(r.reason, 'host_restart'));
  const { roomCode } = await created;
  assert.equal(Object.keys(server.game.rooms).length, 1);
  g.host.roomCode = roomCode;
  for (const p of g.players) assert.ok((await p.join(roomCode)).ok);
  const again = await playFullGame(server, null, { host: g.host, players: g.players });
  assert.equal(again.rankings.length, 3);
}));

test('8 players can play a full game and a 9th is turned away', withServer(async server => {
  const { host, players } = await lobby(server, 8);
  const ninth = new PlayerBot(server, 'Ninth');
  const r = await ninth.join(host.roomCode);
  assert.equal(r.ok, false);
  assert.match(r.message, /full/i);
  const { rankings } = await playFullGame(server, null, { host, players });
  assert.equal(rankings.length, 8);
  rankings.forEach(p => assert.equal(p.totalScore, 7 * 8));
}));

test('one player cannot start (they would be their own slidemaster); two players can play', withServer(async server => {
  const { host, players } = await lobby(server, 1);
  host.socket.emit('host_start_game');
  const msg = await once(host.socket, 'start_game_failed');
  assert.match(msg, /at least 2/);
  assert.equal(server.game.rooms[host.roomCode].gameState, 'LOBBY');

  const second = new PlayerBot(server, 'Second');
  assert.ok((await second.join(host.roomCode)).ok);
  players.push(second);
  const { rankings } = await playFullGame(server, null, { host, players });
  assert.deepEqual(rankings.map(r => r.totalScore), [8, 8]);
}));

test('late arrivals can join while photos are being picked, but not once presentations start', withServer(async server => {
  const { host, players } = await lobby(server, 2, { autoplay: false });
  await host.startGame();
  const late = new PlayerBot(server, 'Latecomer', { autoplay: false });
  const prompt = once(late.socket, 'start_submission_phase');
  assert.ok((await late.join(host.roomCode)).ok);
  await prompt; // the late joiner gets the photo/topic step

  const allIn = host.waitAllSubmitted();
  for (const p of [...players, late]) assert.deepEqual(await p.submit(), { ok: true });
  const progress = await allIn;
  assert.equal(progress.players.length, 3);

  [...players, late].forEach(p => p.autoplay());
  const rankingsPromise = host.waitRankings();
  host.socket.emit('start_presentations');
  await once(host.socket, 'slide_update');

  const tooLate = new PlayerBot(server, 'TooLate');
  const r = await tooLate.join(host.roomCode);
  assert.equal(r.ok, false);
  assert.match(r.message, /already started/);
  const rankings = await rankingsPromise;
  assert.equal(rankings.length, 3);

  const afterGame = await new PlayerBot(server, 'AfterGame').join(host.roomCode);
  assert.match(afterGame.message, /already finished/);
}));

test('names: duplicates of an active player are refused; blank names are refused', withServer(async server => {
  const { host } = await lobby(server, 1);
  const dupe = new PlayerBot(server, 'player1'); // case-insensitive
  const r = await dupe.join(host.roomCode);
  assert.equal(r.ok, false);
  assert.match(r.message, /already taken/);
  const blank = new PlayerBot(server, '   ');
  assert.match((await blank.join(host.roomCode)).message, /username/);
  const nope = await new PlayerBot(server, 'X').join('ZZZZ');
  assert.match(nope.message, /not found/);
}));

test('a phone that reloads mid-game gets its role back via its reconnect token', withServer(async server => {
  const { host, players } = await lobby(server, 3);
  const slidemasterBot = players[1]; // Player2 is slidemaster for Player1's turn
  slidemasterBot.pauseSlides = true;
  await host.startGame();
  await host.waitAllSubmitted();
  host.socket.emit('start_presentations');
  await once(slidemasterBot.socket, 'role_slidemaster');

  slidemasterBot.pauseSlides = false;
  const rejoin = await slidemasterBot.reconnectWithToken();
  assert.ok(rejoin.ok);
  // The fresh socket is the slidemaster again and finishes the game.
  const rankings = await host.waitRankings();
  assert.equal(rankings.length, 3);
}));

test('a disconnected player can come back by typing the same name (FAQ promise)', withServer(async server => {
  const { host, players } = await lobby(server, 3);
  players[2].pauseRating = true;
  await host.startGame();
  await host.waitAllSubmitted();
  host.socket.emit('start_presentations');
  await once(players[2].socket, 'role_rating', { timeout: 4000 });
  players[2].socket.disconnect();

  const comeback = new PlayerBot(server, 'Player3');
  const r = await comeback.join(host.roomCode);
  assert.ok(r.ok, 'same name can rejoin after their phone dropped');
  const room = server.game.rooms[host.roomCode];
  assert.equal(room.players.length, 3, 'no duplicate player was created');
  const rankings = await host.waitRankings();
  assert.equal(rankings.length, 3);
}));

test('slide controls: double taps, stale taps, other players and countdown taps are ignored', withServer({ countdownSeconds: 3, countdownTickMs: 40 }, async server => {
  const { host, players } = await lobby(server, 3);
  const [presenter, sm, audience] = players;
  sm.pauseSlides = true;
  await host.startGame();
  await host.waitAllSubmitted();
  host.socket.emit('start_presentations');
  await once(host.socket, 'presentation_get_ready');
  const room = server.game.rooms[host.roomCode];

  // During the countdown nothing can change the slide.
  sm.socket.emit('advance_slide', { slideIndex: 1, choice: 0 });
  await sleep(30);
  assert.equal(room.activeDeck.currentSlideIndex, 1);

  const controls = await once(sm.socket, 'role_slidemaster');
  assert.equal(controls.slideIndex, 1);
  assert.equal(controls.photosPool.length, 18);

  // Audience and presenter can't drive the slides.
  audience.socket.emit('advance_slide', { slideIndex: 1, choice: 0 });
  presenter.socket.emit('advance_slide', { slideIndex: 1, choice: 0 });
  await sleep(30);
  assert.equal(room.activeDeck.currentSlideIndex, 1);

  // A double tap only advances once.
  const update = once(sm.socket, 'update_slidemaster_remote');
  sm.socket.emit('advance_slide', { slideIndex: 1, choice: 4 });
  sm.socket.emit('advance_slide', { slideIndex: 1, choice: 4 });
  const next = await update;
  await sleep(30);
  assert.equal(room.activeDeck.currentSlideIndex, 2);
  assert.equal(room.activeDeck.currentSlideContent.content, controls.photosPool[4], 'the chosen photo is shown');
  assert.equal(next.photosPool, undefined, 'photos are not re-sent on every slide');
  assert.equal(next.nextSlideType, 'TEXT');

  // A stale tap (from slide 1) re-syncs the phone instead of skipping a slide.
  const resync = once(sm.socket, 'update_slidemaster_remote');
  sm.socket.emit('advance_slide', { slideIndex: 1, choice: 0 });
  const resynced = await resync;
  assert.equal(resynced.slideIndex, 2);
  assert.equal(room.activeDeck.currentSlideIndex, 2);

  // Legacy payload: a photo sent for a TEXT slide is never put on screen as text.
  sm.socket.emit('advance_slide', { selectedContent: controls.photosPool[0] });
  await sleep(30);
  assert.equal(room.activeDeck.currentSlideContent.type, 'TEXT');
  assert.ok(GAME_TEXT_BLURBS.includes(room.activeDeck.currentSlideContent.content));
}));

test('submissions are validated: junk photos dropped, long topics trimmed, nothing valid is refused', withServer(async server => {
  const { host, players } = await lobby(server, 2, { autoplay: false });
  await host.startGame();
  const [a, b] = players;
  const bad = await a.submit({ photos: ['javascript:alert(1)', 'https://evil.example/x.png', 42], topics: ['  '] });
  assert.equal(bad.ok, false);

  const ok = await a.submit({
    photos: [photo('a1'), 'data:text/html;base64,PHNjcmlwdD4=', photo('a2'), photo('a3'), photo('a4'), photo('a5'), photo('a6'), photo('a7')],
    topics: ['x'.repeat(400), '<img src=x onerror=alert(1)>', 'third topic ignored']
  });
  assert.deepEqual(ok, { ok: true });
  const dupe = await a.submit();
  assert.deepEqual(dupe, { ok: true, duplicate: true }, 'a retried upload is acknowledged, not double-counted');

  const pool = server.game.rooms[host.roomCode].pool;
  assert.equal(pool.photos.length, 6, 'max 6 photos, invalid ones removed');
  assert.equal(pool.topics.length, 2);
  assert.equal(pool.topics[0].text.length, 125);
  assert.equal(pool.topics[1].text, '<img src=x onerror=alert(1)>', 'stored as plain text; the pages render it as text');

  // Begin Presentations is refused until every connected player has submitted.
  host.socket.emit('start_presentations');
  assert.match(await once(host.socket, 'start_presentations_failed'), /waiting/i);
  assert.deepEqual(await b.submit(), { ok: true });
}));

test('presenters get a topic someone else wrote', withServer(async server => {
  for (let round = 0; round < 3; round++) {
    const host = new HostBot(server);
    await host.createRoom();
    const players = [];
    for (const n of names(4)) {
      const p = new PlayerBot(server, `${n}r${round}`);
      await p.join(host.roomCode);
      players.push(p);
    }
    const topics = [];
    host.socket.on('presentation_get_ready', d => topics.push(d));
    await playFullGame(server, null, { host, players });
    assert.equal(topics.length, 4);
    topics.forEach(t => assert.ok(!t.topic.startsWith(`${t.presenterName} `), `${t.presenterName} got their own topic "${t.topic}"`));
  }
}));

test('leaving: presenter leaving skips their turn; too few players ends the game', withServer(async server => {
  const { host, players } = await lobby(server, 4);
  players[0].pauseSlides = true;
  players[1].pauseSlides = true; // Player2 is slidemaster for Player1's turn
  await host.startGame();
  await host.waitAllSubmitted();
  host.socket.emit('start_presentations');
  await once(players[1].socket, 'role_slidemaster');

  // Player1 (presenting) walks out: Player2's turn starts.
  const nextTurn = once(host.socket, 'presentation_get_ready');
  players[0].socket.emit('leave_game');
  await once(players[0].socket, 'leave_game_confirmed');
  assert.equal((await nextTurn).presenterName, 'Player2');

  // Two more leave: only one player remains, so the room ends.
  const ended = once(players[3].socket, 'room_ended');
  players[1].socket.emit('leave_game');
  players[2].socket.emit('leave_game');
  assert.equal((await ended).reason, 'not_enough_players');
  assert.equal(server.game.rooms[host.roomCode], undefined);
}));

test('if the slidemaster\'s phone dies mid-presentation, another player gets the controls', withServer(async server => {
  const { host, players } = await lobby(server, 3);
  players[1].pauseSlides = true; // slidemaster for turn 1
  await host.startGame();
  await host.waitAllSubmitted();
  const rankingsPromise = host.waitRankings(8000);
  host.socket.emit('start_presentations');
  await once(players[1].socket, 'role_slidemaster');
  players[1].socket.disconnect();

  // After the grace period, Player3 (the next connected player) takes over.
  const takeover = await once(players[2].socket, 'role_slidemaster', { timeout: 2000 });
  assert.equal(takeover.slideIndex, 1);
  const rankings = await rankingsPromise;
  assert.equal(rankings.length, 3, 'game finished without the dead phone');
}));

test('the TV can reload mid-game and pick up where it left off', withServer(async server => {
  const { host, players } = await lobby(server, 3);
  players[1].pauseSlides = true;
  await host.startGame();
  await host.waitAllSubmitted();
  host.socket.emit('start_presentations');
  await once(players[1].socket, 'role_slidemaster');
  const { roomCode, hostToken } = host;
  host.socket.disconnect();
  await sleep(30);

  // A different tab with the wrong token is refused.
  const intruder = server.socket();
  intruder.emit('resume_host', { roomCode, hostToken: 'nope' });
  await once(intruder, 'resume_host_failed');

  const tv = new HostBot(server);
  const created = once(tv.socket, 'room_created');
  const slide = once(tv.socket, 'slide_update');
  tv.socket.emit('resume_host', { roomCode, hostToken });
  assert.equal((await created).state, 'PRESENTING');
  assert.equal((await slide).slideIndex, 1);
  tv.roomCode = roomCode;

  players[1].pauseSlides = false;
  players[1].advance({ slideIndex: 1, nextSlideType: 'PHOTO' });
  const rankings = await tv.waitRankings();
  assert.equal(rankings.length, 3, 'the reloaded TV received the rest of the game');
}));

test('if the TV never comes back, players are told the game ended', withServer(async server => {
  const { host, players } = await lobby(server, 2);
  const ended = once(players[0].socket, 'room_ended', { timeout: 2000 });
  host.socket.disconnect();
  assert.equal((await ended).reason, 'host_left');
  assert.equal(Object.keys(server.game.rooms).length, 0);
}));

test('an offline rater only holds up the round until the grace period ends', withServer(async server => {
  const { host, players } = await lobby(server, 3);
  await host.startGame();
  await host.waitAllSubmitted();
  players[2].pauseRating = true;
  const ratingOpen = once(players[2].socket, 'role_rating', { timeout: 4000 });
  const rankingsPromise = host.waitRankings(8000);
  host.socket.emit('start_presentations');
  await ratingOpen;
  players[2].socket.disconnect();
  const rankings = await rankingsPromise;
  assert.equal(rankings.length, 3);
}));

test('late, duplicate and self ratings are ignored; scores are clamped to 1-10', withServer(async server => {
  const { host, players } = await lobby(server, 3, { autoplay: false });
  await host.startGame();
  for (const p of players) await p.submit();
  const [presenter, sm, audience] = players;
  host.socket.emit('start_presentations');
  const controls = await once(sm.socket, 'role_slidemaster', { timeout: 4000 });
  let state = controls;
  for (let i = 0; i < 9; i++) {
    const next = Promise.race([once(sm.socket, 'update_slidemaster_remote'), once(sm.socket, 'conclusion_slide_displayed')]);
    sm.socket.emit('advance_slide', { slideIndex: state.slideIndex, choice: 0 });
    state = await next;
  }
  sm.socket.emit('finish_presentation');
  await once(audience.socket, 'role_rating');
  const room = server.game.rooms[host.roomCode];

  presenter.socket.emit('submit_rating', { rating: 10 });
  audience.socket.emit('submit_rating', { rating: 999, comment: 'y'.repeat(500) });
  audience.socket.emit('submit_rating', { rating: 10 });
  await sleep(30);
  const p1 = room.players.find(p => p.username === 'Player1');
  assert.equal(p1.totalScore, 10, 'clamped to 10, presenter + duplicate ignored');
  assert.equal(p1.receivedComments[0].text.length, 150);

  sm.socket.emit('submit_rating', { rating: -5, comment: '' });
  await once(host.socket, 'presentation_get_ready');
  assert.equal(p1.totalScore, 11, 'minimum rating is 1');
  sm.socket.emit('submit_rating', { rating: 10 }); // late: round is over
  await sleep(30);
  assert.equal(p1.totalScore, 11);
}));

test('garbage payloads on every event never crash the server', withServer(async server => {
  const original = console.error;
  console.error = () => {};
  try {
    const { host, players } = await lobby(server, 3);
    const events = ['create_room', 'resume_host', 'join_room', 'host_start_game', 'submit_player_content',
      'start_presentations', 'advance_slide', 'finish_presentation', 'submit_rating', 'leave_game',
      'start_same_players_game', 'start_new_room', 'end_game'];
    const junk = [null, undefined, 0, 'x', [], [null], { photos: 'nope', topics: {} }, { roomCode: {}, username: [] },
      { slideIndex: 'NaN', choice: -1 }, { rating: 'ten', comment: { evil: true } }];
    const vandal = server.socket();
    for (const event of events) {
      for (const payload of junk) vandal.emit(event, payload);
    }
    // Vandalism from a real player socket mid-game too.
    await host.startGame();
    for (const payload of junk) players[0].socket.emit('submit_player_content', payload);
    for (const payload of junk) players[0].socket.emit('advance_slide', payload);
    await sleep(100);
    // The server is still up and the real game still works.
    await host.waitAllSubmitted().catch(() => {});
    const rankingsPromise = host.waitRankings();
    host.socket.emit('start_presentations');
    assert.equal((await rankingsPromise).length, 3);
  } finally {
    console.error = original;
  }
}));

test('double-clicking "Host a Game" leaves only one room', withServer(async server => {
  const host = new HostBot(server);
  host.socket.emit('create_room');
  host.socket.emit('create_room');
  await sleep(80);
  assert.equal(Object.keys(server.game.rooms).length, 1);
}));

test('players can\'t host, and the TV can\'t join its own game as a player', withServer(async server => {
  const { host, players } = await lobby(server, 1);
  players[0].socket.emit('create_room');
  host.socket.emit('join_room', { roomCode: host.roomCode, username: 'TV' });
  await sleep(50);
  assert.equal(Object.keys(server.game.rooms).length, 1);
  assert.equal(server.game.rooms[host.roomCode].players.length, 1);
}));

test('rematch leaves out players who left and resets scores', withServer(async server => {
  const g = await playFullGame(server, names(4));
  g.players[3].socket.emit('leave_game');
  await once(g.players[3].socket, 'leave_game_confirmed');
  const again = await playFullGame(server, null, { host: g.host, players: g.players.slice(0, 3), rematch: true });
  assert.deepEqual(again.rankings.map(r => r.username).sort(), ['Player1', 'Player2', 'Player3']);
  assert.deepEqual(again.rankings.map(r => r.totalScore), [16, 16, 16]);
}));

test('abandoned rooms are cleaned up and their photos freed', withServer({ reconnectWindowMs: 50 }, async server => {
  const { host, players } = await lobby(server, 2);
  host.socket.disconnect();
  players.forEach(p => p.socket.disconnect());
  await sleep(30);
  server.game.cleanupRooms(Date.now());
  server.game.cleanupRooms(Date.now() + 1000);
  assert.equal(Object.keys(server.game.rooms).length, 0);
}));

test('20 simultaneous games stay completely separate', withServer(async server => {
  const games = await Promise.all(Array.from({ length: 20 }, async (_, g) => {
    const host = new HostBot(server);
    await host.createRoom();
    const players = [];
    for (let i = 0; i < 5; i++) {
      const p = new PlayerBot(server, `G${g}P${i}`, { photoTag: `room${g}-p${i}` });
      const r = await p.join(host.roomCode);
      assert.ok(r.ok, r.message);
      players.push(p);
    }
    return playFullGame(server, null, { host, players, timeout: 20000 });
  }));
  const codes = new Set(games.map(g => g.host.roomCode));
  assert.equal(codes.size, 20);
  for (const g of games) {
    const roomPhotos = new Set(g.players.flatMap(p => p.photos()));
    for (let turn = 0; turn < 5; turn++) assertDeckShape(g.host.slides.slice(turn * 10, turn * 10 + 10), roomPhotos);
    assert.deepEqual(g.rankings.map(r => r.totalScore), [32, 32, 32, 32, 32]);
  }
}));

// ---------- HTTP / SEO ----------

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

test('SEO and HTTP basics', withServer(async server => {
  const home = await get(`${server.url}/`);
  assert.equal(home.status, 200);
  assert.match(home.body, /<meta name="viewport"/);
  assert.match(home.body, /<link rel="canonical" href="https:\/\/slidedecksocial.com\/">/);
  assert.match(home.body, /<meta name="description"/);
  assert.match(home.body, /application\/ld\+json/);
  assert.equal((home.body.match(/<h1[\s>]/g) || []).length, 1, 'exactly one h1');
  assert.equal(home.headers['x-powered-by'], undefined);
  assert.equal(home.headers['x-content-type-options'], 'nosniff');

  for (const page of ['/about/', '/how-to-play/', '/join/']) {
    const res = await get(server.url + page);
    assert.equal(res.status, 200, page);
    assert.match(res.body, /<!DOCTYPE html>/i, `${page} doctype`);
    assert.match(res.body, /<meta name="viewport"/, `${page} viewport`);
    assert.match(res.body, /<link rel="canonical"/, `${page} canonical`);
    assert.match(res.body, /<title>[^<]{20,}<\/title>/, `${page} title`);
    assert.doesNotMatch(res.body, /Host-Slide Deck Social/, `${page} has its own title`);
  }
  for (const page of ['/about/', '/how-to-play/']) {
    assert.match((await get(server.url + page)).body, /id="page-content"/, `${page} can be shown in the modal`);
  }

  const robots = await get(`${server.url}/robots.txt`);
  assert.match(robots.body, /Sitemap: https:\/\/slidedecksocial.com\/sitemap.xml/);
  const sitemap = await get(`${server.url}/sitemap.xml`);
  assert.match(sitemap.body, /<loc>https:\/\/slidedecksocial.com\/how-to-play\/<\/loc>/);
  for (const asset of ['/how-to-play/boxtv.jpg', '/how-to-play/holgas.jpg', '/how-to-play/tedtalk.jpg',
    '/about/jakevikki.jpg', '/site-modal.js']) {
    assert.equal((await get(server.url + asset)).status, 200, asset);
  }
  const img = await get(`${server.url}/how-to-play/boxtv.jpg`);
  assert.match(img.headers['cache-control'], /max-age=604800/);
  assert.equal((await get(`${server.url}/host.js`)).headers['cache-control'], 'no-cache');

  const missing = await get(`${server.url}/nope`);
  assert.equal(missing.status, 404);
  assert.match(missing.body, /noindex/);

  const www = await get(`${server.url}/about/?x=1`, { Host: 'www.slidedecksocial.com' });
  assert.equal(www.status, 301);
  assert.equal(www.headers.location, 'https://slidedecksocial.com/about/?x=1');

  const health = JSON.parse((await get(`${server.url}/healthz`)).body);
  assert.equal(health.status, 'ok');
}));
