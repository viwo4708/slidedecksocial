// Unit tests for the pure game logic in server.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cleanText, isValidPhoto, generateRoomCode, buildPresenterRing, getSlideType,
  rankPlayers, removeSubmittedItems, takeTopic, asObject, safe, LIMITS
} = require('../server');
const { GAME_TEXT_BLURBS, GAME_CONCLUSIONS } = require('../gameContent');

test('slide order is topic, then photo/text alternating, then conclusion', () => {
  const types = Array.from({ length: 10 }, (_, i) => getSlideType(i + 1));
  assert.deepEqual(types, ['TOPIC', 'PHOTO', 'TEXT', 'PHOTO', 'TEXT', 'PHOTO', 'TEXT', 'PHOTO', 'TEXT', 'CONCLUSION']);
});

test('presenter ring: everyone presents once and is slidemaster once, never for themselves', () => {
  for (let n = 2; n <= 8; n++) {
    const players = Array.from({ length: n }, (_, i) => ({ id: `id${i}`, username: `P${i}` }));
    const ring = buildPresenterRing(players);
    assert.equal(ring.length, n);
    assert.deepEqual(new Set(ring.map(r => r.presenterId)).size, n);
    assert.deepEqual(new Set(ring.map(r => r.slidemasterId)).size, n);
    ring.forEach(r => assert.notEqual(r.presenterId, r.slidemasterId));
  }
});

test('presenter ring skips players who left', () => {
  const ring = buildPresenterRing([
    { id: 'a', username: 'A' }, { id: 'b', username: 'B', left: true }, { id: 'c', username: 'C' }
  ]);
  assert.deepEqual(ring.map(r => [r.presenterId, r.slidemasterId]), [['a', 'c'], ['c', 'a']]);
});

test('rankings: sorted high to low and tied scores share a rank', () => {
  const ranked = rankPlayers([
    { username: 'A', totalScore: 10 }, { username: 'B', totalScore: 25 },
    { username: 'C', totalScore: 10 }, { username: 'D', totalScore: 3, left: true }
  ]);
  assert.deepEqual(ranked.map(r => [r.username, r.rank]), [['B', 1], ['A', 2], ['C', 2], ['D', 4]]);
  assert.equal(ranked[3].left, true);
  assert.equal(ranked[0].receivedComments, undefined, 'comments are not broadcast to the TV');
});

test('cleanText trims, strips control characters, caps length without splitting emoji', () => {
  assert.equal(cleanText('  hello \n\t world  ', 50), 'hello world');
  assert.equal(cleanText('a\u0000b\u0007c', 50), 'a b c');
  assert.equal(cleanText('😂😂😂😂', 2), '😂😂');
  assert.equal(cleanText('x'.repeat(500), LIMITS.topic).length, LIMITS.topic);
  for (const bad of [null, undefined, 42, {}, [], true]) assert.equal(cleanText(bad, 10), '');
});

test('isValidPhoto accepts image data URLs and rejects anything else', () => {
  assert.ok(isValidPhoto('data:image/jpeg;base64,/9j/4AAQSkZJRg=='));
  assert.ok(isValidPhoto('data:image/png;base64,iVBORw0KGgo='));
  for (const bad of [
    'javascript:alert(1)',
    'https://example.com/a.jpg',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/jpeg;base64,abc" onerror="alert(1)',
    `data:image/jpeg;base64,${'A'.repeat(LIMITS.photoChars)}`,
    null, 12, {}
  ]) assert.equal(isValidPhoto(bad), false, String(bad).slice(0, 40));
});

test('room codes are 4 capital letters and never reuse a code in use', () => {
  const taken = new Set();
  for (let i = 0; i < 2000; i++) {
    const code = generateRoomCode(c => taken.has(c));
    assert.match(code, /^[A-Z]{4}$/);
    assert.ok(!taken.has(code));
    taken.add(code);
  }
  assert.throws(() => generateRoomCode(() => true), /free room code/);
});

test('takeTopic prefers topics written by someone other than the presenter', () => {
  const me = { username: 'me' };
  const other = { username: 'other' };
  for (let i = 0; i < 50; i++) {
    const pool = { topics: [{ text: 'mine', author: me }, { text: 'theirs', author: other }] };
    assert.equal(takeTopic(pool, me), 'theirs');
    assert.equal(pool.topics.length, 1);
  }
  const onlyMine = { topics: [{ text: 'mine', author: me }] };
  assert.equal(takeTopic(onlyMine, me), 'mine', 'falls back to own topic rather than none');
});

test('takeTopic falls back to the original default topic when the pool is empty', () => {
  assert.equal(takeTopic({ topics: [] }, null), 'The Secret to Ultimate Success');
  assert.equal(takeTopic(null, null), 'The Secret to Ultimate Success');
});

test('game content is present', () => {
  assert.ok(GAME_TEXT_BLURBS.length > 50);
  assert.ok(GAME_CONCLUSIONS.length > 10);
});

test('removeSubmittedItems removes one copy of each item', () => {
  const pool = ['a', 'b', 'a', 'c'];
  removeSubmittedItems(pool, ['a', 'c', 'zzz']);
  assert.deepEqual(pool, ['b', 'a']);
  removeSubmittedItems(pool, undefined);
  assert.deepEqual(pool, ['b', 'a']);
});

test('asObject turns any client payload into a safe object', () => {
  for (const bad of [null, undefined, 3, 'x', [], true]) assert.deepEqual(asObject(bad), {});
  const ok = { a: 1 };
  assert.equal(asObject(ok), ok);
});

test('safe() swallows exceptions so one bad event cannot crash the server', () => {
  const original = console.error;
  console.error = () => {};
  try {
    const wrapped = safe('test', () => { throw new Error('boom'); });
    assert.doesNotThrow(() => wrapped());
    assert.equal(safe('ok', x => x * 2)(21), 42);
  } finally {
    console.error = original;
  }
});
