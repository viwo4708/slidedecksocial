// Socket-level test bots: a host (the TV) and players (phones) that speak the
// same Socket.IO protocol as the real pages, so tests can run whole games in
// milliseconds and check what every client received.
const { io: connect } = require('socket.io-client');
const { createGameServer } = require('../../server');

// Fast timers so a full game takes well under a second.
const FAST = {
  countdownSeconds: 1,
  countdownTickMs: 5,
  ratingGraceMs: 300,
  slidemasterGraceMs: 150,
  hostGraceMs: 400,
  cleanupIntervalMs: 60 * 60 * 1000
};

async function startServer(options = {}) {
  const game = createGameServer({ ...FAST, ...options });
  await new Promise(resolve => game.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.server.address().port}`;
  const sockets = [];
  return {
    game,
    url,
    socket(opts = {}) {
      const s = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false, ...opts });
      sockets.push(s);
      return s;
    },
    async close() {
      sockets.forEach(s => s.disconnect());
      await game.close();
    }
  };
}

function once(socket, event, { timeout = 3000, filter } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeout);
    function handler(...args) {
      if (filter && !filter(...args)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(args[0]);
    }
    socket.on(event, handler);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A tiny valid JPEG data URL, tagged so tests can tell whose photo is on screen.
function photo(tag) {
  const base = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP';
  return `data:image/jpeg;base64,${base}${Buffer.from(String(tag)).toString('base64').replace(/=+$/, '')}`;
}

function recordAll(socket) {
  const log = [];
  socket.onAny((event, ...args) => log.push({ event, data: args[0], at: Date.now() }));
  return log;
}

class HostBot {
  constructor(server) {
    this.socket = server.socket();
    this.log = recordAll(this.socket);
    this.slides = [];
    this.socket.on('slide_update', s => this.slides.push(s));
  }

  async createRoom() {
    const created = once(this.socket, 'room_created');
    this.socket.emit('create_room');
    const { roomCode, hostToken } = await created;
    this.roomCode = roomCode;
    this.hostToken = hostToken;
    return roomCode;
  }

  async startGame() {
    const started = once(this.socket, 'submission_phase_started');
    this.socket.emit('host_start_game');
    return started;
  }

  waitAllSubmitted(timeout = 3000) {
    return once(this.socket, 'submission_progress_updated', { timeout, filter: p => p.allSubmitted });
  }

  async beginPresentations() {
    const ready = once(this.socket, 'presentation_get_ready');
    this.socket.emit('start_presentations');
    return ready;
  }

  waitRankings(timeout = 5000) {
    return once(this.socket, 'show_rankings', { timeout });
  }

  count(event) {
    return this.log.filter(e => e.event === event).length;
  }
}

class PlayerBot {
  constructor(server, name, { autoplay = true, rating = 8, comment, photoTag } = {}) {
    this.server = server;
    this.name = name;
    this.rating = rating;
    this.comment = comment === undefined ? `great job from ${name}` : comment;
    this.photoTag = photoTag || name;
    this.roles = [];
    this.attach(server.socket());
    if (autoplay) this.autoplay();
  }

  attach(socket) {
    this.socket = socket;
    this.log = recordAll(socket);
    socket.on('joined_successfully', d => { this.reconnectToken = d.reconnectToken; this.player = d.player; });
    socket.on('role_presenter', () => this.roles.push('presenter'));
    socket.on('role_slidemaster', () => this.roles.push('slidemaster'));
    socket.on('role_audience', () => this.roles.push('audience'));
  }

  photos(count = 6) {
    return Array.from({ length: count }, (_, i) => photo(`${this.photoTag}-${i + 1}`));
  }

  topics() {
    return [`${this.name} topic A`, `${this.name} topic B`];
  }

  async join(roomCode, extra = {}) {
    this.roomCode = roomCode;
    const result = Promise.race([
      once(this.socket, 'joined_successfully').then(d => ({ ok: true, data: d })),
      once(this.socket, 'error_message').then(message => ({ ok: false, message }))
    ]);
    this.socket.emit('join_room', { roomCode, username: this.name, ...extra });
    return result;
  }

  submit(payload) {
    return new Promise(resolve => {
      this.socket.emit('submit_player_content', payload || { photos: this.photos(), topics: this.topics() }, resolve);
    });
  }

  // Plays like an attentive human: submits when asked, drives the slides when
  // slidemaster, finishes the presentation, and rates when asked.
  autoplay() {
    if (this.autoplaying) return;
    this.autoplaying = true;
    const s = () => this.socket;
    const bind = socket => {
      socket.on('start_submission_phase', () => {
        if (this.autoSubmit !== false) this.submit();
      });
      socket.on('role_slidemaster', d => { this.pools = d; this.advance(d); });
      socket.on('update_slidemaster_remote', d => this.advance(d));
      socket.on('conclusion_slide_displayed', () => {
        if (this.pauseSlides) return;
        setImmediate(() => s().emit('finish_presentation'));
      });
      socket.on('role_rating', () => {
        if (this.pauseRating) return;
        setImmediate(() => s().emit('submit_rating', { rating: this.rating, comment: this.comment }));
      });
    };
    bind(this.socket);
    this.rebind = bind;
  }

  advance(d) {
    if (this.pauseSlides) return;
    const pools = this.pools || d;
    const pool = d.nextSlideType === 'PHOTO' ? pools.photosPool : pools.textBlurbsPool;
    const choice = pool && pool.length ? Math.floor(Math.random() * pool.length) : undefined;
    setImmediate(() => this.socket.emit('advance_slide', { slideIndex: d.slideIndex, choice }));
  }

  // Simulates the phone dropping and a fresh page load rejoining with the saved token.
  async reconnectWithToken() {
    this.socket.disconnect();
    this.attach(this.server.socket());
    if (this.rebind) this.rebind(this.socket);
    return this.join(this.roomCode, { reconnectToken: this.reconnectToken });
  }
}

// Creates a room with `names.length` players and plays until rankings.
async function playFullGame(server, names, options = {}) {
  const host = options.host || new HostBot(server);
  const players = options.players || names.map(n => new PlayerBot(server, n, options.playerOptions));
  if (!options.host) await host.createRoom();
  if (!options.players) {
    for (const p of players) {
      const r = await p.join(host.roomCode);
      if (!r.ok) throw new Error(`${p.name} could not join: ${r.message}`);
    }
  }
  const allIn = host.waitAllSubmitted(options.timeout || 5000);
  if (options.rematch) host.socket.emit('start_same_players_game');
  else await host.startGame();
  await allIn;
  const rankingsPromise = host.waitRankings(options.timeout || 10000);
  host.socket.emit('start_presentations');
  const rankings = await rankingsPromise;
  return { host, players, rankings };
}

module.exports = { FAST, startServer, once, sleep, photo, HostBot, PlayerBot, playFullGame };
