'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomUUID } = require('crypto');
const { GAME_TEXT_BLURBS, GAME_CONCLUSIONS } = require('./gameContent');
const { version: PACKAGE_VERSION } = require('./package.json');

const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULTS = {
  // Phones drop their connection all the time (screen locks, switching apps, the
  // photo picker). Socket.IO lets them reconnect within this window as the SAME
  // player and replays any events they missed, instead of treating them as a stranger.
  reconnectWindowMs: 30 * 60 * 1000,
  // When rating opens, wait this long for players whose phones are asleep before
  // moving on without them. Players who are connected are always waited for.
  ratingGraceMs: 45 * 1000,
  // If the slidemaster's phone drops mid-presentation, wait this long for it to
  // come back before handing the slide controls to another connected player.
  slidemasterGraceMs: 15 * 1000,
  // If the TV (host page) disappears and doesn't come back within this window,
  // end the room so players aren't left staring at a frozen screen.
  hostGraceMs: 10 * 60 * 1000,
  // Safety net: rooms are deleted once nobody has been connected for
  // reconnectWindowMs, or after this long no matter what.
  maxRoomAgeMs: 12 * 60 * 60 * 1000,
  cleanupIntervalMs: 60 * 1000,
  countdownSeconds: 10,
  countdownTickMs: 1000,
  minPlayers: 2,
  maxPlayers: 8,
  photosPerPlayer: 6,
  topicsPerPlayer: 2,
  totalSlides: 10
};

const LIMITS = {
  username: 15,
  topic: 125,
  comment: 150,
  // A phone-compressed photo is ~50-300 KB as a data URL; this leaves headroom.
  photoChars: 2 * 1024 * 1024
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

// Trims, removes control characters, collapses whitespace and caps the length
// without cutting an emoji in half. Anything that isn't a string becomes ''.
function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, maxLength).join('').trim();
}

const PHOTO_PATTERN = /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
function isValidPhoto(value) {
  return typeof value === 'string' && value.length <= LIMITS.photoChars && PHOTO_PATTERN.test(value);
}

function generateRoomCode(isTaken = () => false) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    if (!isTaken(code)) return code;
  }
  throw new Error('Could not find a free room code');
}

function buildPresenterRing(players) {
  const activePlayers = players.filter(player => !player.left);
  return activePlayers.map((presenter, i) => {
    const slidemaster = activePlayers[(i + 1) % activePlayers.length];
    return {
      presenterId: presenter.id,
      presenterName: presenter.username,
      slidemasterId: slidemaster.id,
      slidemasterName: slidemaster.username
    };
  });
}

function getSlideType(slideIndex, totalSlides = DEFAULTS.totalSlides) {
  if (slideIndex === 1) return 'TOPIC';
  if (slideIndex === totalSlides) return 'CONCLUSION';
  return (slideIndex % 2 === 0) ? 'PHOTO' : 'TEXT';
}

// Sorted high to low; tied scores share a rank (1, 2, 2, 4).
function rankPlayers(players) {
  const sorted = [...players].sort((a, b) => b.totalScore - a.totalScore);
  return sorted.map((p, i) => ({
    username: p.username,
    avatar: p.avatar,
    totalScore: p.totalScore,
    left: Boolean(p.left),
    rank: sorted.findIndex(q => q.totalScore === p.totalScore) + 1
  }));
}

function removeSubmittedItems(pool, submittedItems = []) {
  for (const item of submittedItems) {
    const itemIndex = pool.indexOf(item);
    if (itemIndex !== -1) pool.splice(itemIndex, 1);
  }
}

const FALLBACK_TOPIC = 'The Secret to Ultimate Success';

// Picks (and removes) a topic for the presenter, preferring one somebody else
// wrote. Falls back to the original default topic if the pool runs dry.
function takeTopic(pool, presenter) {
  const topics = pool ? pool.topics : [];
  if (topics.length === 0) return FALLBACK_TOPIC;
  const others = topics.map((t, i) => i).filter(i => topics[i].author !== presenter);
  const candidates = others.length > 0 ? others : topics.map((t, i) => i);
  const index = candidates[Math.floor(Math.random() * candidates.length)];
  return topics.splice(index, 1)[0].text;
}

function respond(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

// Clients can send anything (null, numbers, arrays). Destructuring null used to
// throw inside Socket.IO and take the whole server down.
function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// One bad event or timer must never crash the process (and every game with it).
function safe(label, fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      console.error(`[${label}]`, err);
      return undefined;
    }
  };
}

// ---------------------------------------------------------------------------
// Game server
// ---------------------------------------------------------------------------

function createGameServer(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const appVersion = options.appVersion || `${PACKAGE_VERSION}-${Date.now().toString(36)}`;

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 1e7,
    connectionStateRecovery: { maxDisconnectionDuration: config.reconnectWindowMs }
  });

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // One canonical host for search engines: www.slidedecksocial.com -> slidedecksocial.com
    const host = req.headers.host || '';
    if (/^www\./i.test(host)) {
      return res.redirect(301, `https://${host.replace(/^www\./i, '')}${req.originalUrl}`);
    }
    next();
  });

  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', rooms: Object.keys(rooms).length, connections: io.engine.clientsCount, version: appVersion });
  });

  app.use(express.static(PUBLIC_DIR, {
    setHeaders(res, filePath) {
      if (/\.(png|jpe?g|webp|gif|svg|ico)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=604800');
      } else {
        // HTML/JS/CSS keep their names between deploys, so always revalidate.
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));

  app.use((req, res) => {
    res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'));
  });

  const rooms = {};

  function ensureReconnectToken(player, requestedToken) {
    if (!player.reconnectToken) {
      // Not enumerable, so it's never sent to other players in player lists.
      Object.defineProperty(player, 'reconnectToken', {
        value: requestedToken || randomUUID(),
        configurable: true
      });
    }
    return player.reconnectToken;
  }

  const getCurrentPair = room => room.presenterRing[room.currentPairIndex];
  const findPlayer = (room, id) => room.players.find(p => p.id === id);

  function generatePresentationDeck(topic, photosPool) {
    return {
      currentSlideIndex: 1,
      totalSlides: config.totalSlides,
      topic,
      photosPool,
      textBlurbsPool: GAME_TEXT_BLURBS,
      conclusion: GAME_CONCLUSIONS[Math.floor(Math.random() * GAME_CONCLUSIONS.length)],
      currentSlideContent: { type: 'TOPIC', content: topic }
    };
  }

  function slidePayload(deck) {
    return {
      slideIndex: deck.currentSlideIndex,
      totalSlides: deck.totalSlides,
      content: deck.currentSlideContent
    };
  }

  function slidemasterPayload(room, pair, { includePools = true } = {}) {
    const deck = room.activeDeck;
    const payload = {
      presenterName: pair.presenterName,
      slideIndex: deck.currentSlideIndex,
      nextSlideIndex: deck.currentSlideIndex + 1,
      nextSlideType: getSlideType(deck.currentSlideIndex + 1, deck.totalSlides)
    };
    if (includePools) {
      payload.photosPool = deck.photosPool;
      payload.textBlurbsPool = deck.textBlurbsPool;
    }
    return payload;
  }

  function submissionPhasePayload() {
    return { photosRequired: config.photosPerPlayer };
  }

  // Tells one player what their phone should be showing during a presentation.
  function emitPresentationRole(target, room, pair, player) {
    if (player.id === pair.presenterId) {
      target.emit('role_presenter', { topic: room.activeDeck.topic });
    } else if (player.id === pair.slidemasterId) {
      if (room.gameState === 'CONCLUSION') {
        target.emit('conclusion_slide_displayed', { presenterName: pair.presenterName });
      } else {
        target.emit('role_slidemaster', slidemasterPayload(room, pair));
      }
    } else {
      target.emit('role_audience', { presenterName: pair.presenterName });
    }
  }

  function notifyMobileRoles(room, pair) {
    room.players.forEach(p => {
      if (!p.left) emitPresentationRole(io.to(p.id), room, pair, p);
    });
  }

  function startTurn(roomCode, room) {
    room.gameState = 'PRESENTING';
    room.countdownActive = true;
    room.ratedBy = new Set();
    clearTimeout(room.slidemasterTimer);
    const currentPair = getCurrentPair(room);
    pickSlidemaster(room, currentPair);

    const presenter = findPlayer(room, currentPair.presenterId);
    const chosenTopic = takeTopic(room.pool, presenter);
    room.activeDeck = generatePresentationDeck(chosenTopic, room.pool ? room.pool.photos : []);

    io.to(roomCode).emit('presentation_get_ready', {
      presenterName: currentPair.presenterName,
      slidemasterName: currentPair.slidemasterName,
      topic: chosenTopic,
      countdown: config.countdownSeconds
    });

    let countdown = config.countdownSeconds;
    clearInterval(room.countdownTimer);
    const tick = () => {
      io.to(roomCode).emit('countdown_tick', countdown);
      countdown--;
      if (countdown >= 0) return;

      clearInterval(room.countdownTimer);
      room.countdownTimer = null;
      room.countdownActive = false;
      io.to(roomCode).emit('slide_update', slidePayload(room.activeDeck));
      notifyMobileRoles(room, getCurrentPair(room));
    };
    room.countdownTimer = setInterval(safe('countdown', tick), config.countdownTickMs);
  }

  // The slidemaster needs their phone. If theirs is offline (closed the tab, phone
  // died), hand the controls to the next connected player after the presenter.
  // Returns true if the slidemaster changed.
  function pickSlidemaster(room, pair) {
    const scheduled = findPlayer(room, pair.slidemasterId);
    if (scheduled && scheduled.connected && !scheduled.left) return false;

    const start = room.players.findIndex(p => p.id === pair.presenterId);
    for (let i = 1; i < room.players.length; i++) {
      const p = room.players[(start + i) % room.players.length];
      if (p.connected && !p.left && p.id !== pair.presenterId) {
        pair.slidemasterId = p.id;
        pair.slidemasterName = p.username;
        return true;
      }
    }
    return false;
  }

  // The slidemaster's phone dropped mid-presentation. Give it a moment to come
  // back, then move the controls so the presentation can't freeze.
  function scheduleSlidemasterHandoff(roomCode, room, player) {
    const pair = getCurrentPair(room);
    if (!pair || pair.slidemasterId !== player.id) return;
    if (room.gameState !== 'PRESENTING' && room.gameState !== 'CONCLUSION') return;

    clearTimeout(room.slidemasterTimer);
    room.slidemasterTimer = setTimeout(safe('slidemaster-handoff', () => {
      room.slidemasterTimer = null;
      if (rooms[roomCode] !== room || getCurrentPair(room) !== pair) return;
      if (room.gameState !== 'PRESENTING' && room.gameState !== 'CONCLUSION') return;
      if (!pickSlidemaster(room, pair)) return;
      if (room.countdownActive) return; // roles go out when the countdown ends
      const replacement = findPlayer(room, pair.slidemasterId);
      if (replacement) emitPresentationRole(io.to(replacement.id), room, pair, replacement);
    }), config.slidemasterGraceMs);
  }

  function startRating(roomCode, room) {
    room.gameState = 'RATING';
    room.ratedBy = new Set();
    room.ratingStartedAt = Date.now();
    clearTimeout(room.slidemasterTimer);
    const currentPair = getCurrentPair(room);

    io.to(room.hostSocketId).emit('start_rating_display', { presenterName: currentPair.presenterName });

    room.players.forEach(p => {
      if (p.left) return;
      if (p.id === currentPair.presenterId) {
        io.to(p.id).emit('role_presenter_waiting_rating', { presenterName: currentPair.presenterName });
      } else {
        io.to(p.id).emit('role_rating', { presenterName: currentPair.presenterName });
      }
    });

    // Once the grace period is over, stop waiting for phones that are still offline.
    clearTimeout(room.ratingTimer);
    room.ratingTimer = setTimeout(safe('rating-grace', () => {
      if (rooms[roomCode] === room && room.gameState === 'RATING') checkRatingsComplete(roomCode, room);
    }), config.ratingGraceMs);
  }

  // Everyone except the presenter rates. We wait for every connected player, and
  // for offline ones only until ratingGraceMs after rating opened, so one dead
  // phone can't freeze the game. Players who already sat out a whole round offline
  // are "away" and aren't waited for at all until their phone comes back.
  function checkRatingsComplete(roomCode, room) {
    const currentPair = getCurrentPair(room);
    if (!currentPair) return;
    const graceOver = Date.now() - room.ratingStartedAt >= config.ratingGraceMs;
    const raters = room.players.filter(p =>
      !p.left && p.id !== currentPair.presenterId && (p.connected || (!graceOver && !p.away))
    );
    if (!raters.every(p => room.ratedBy.has(p.id))) return;

    clearTimeout(room.ratingTimer);
    room.players.forEach(p => {
      if (!p.left && !p.connected && p.id !== currentPair.presenterId && !room.ratedBy.has(p.id)) p.away = true;
    });
    room.currentPairIndex++;

    if (room.currentPairIndex < room.presenterRing.length) startTurn(roomCode, room);
    else showRankings(room);
  }

  function showRankings(room) {
    room.gameState = 'RANKINGS';
    clearTimeout(room.slidemasterTimer);
    io.to(room.hostSocketId).emit('show_rankings', rankPlayers(room.players));

    room.players.forEach(p => {
      if (p.left || !p.connected) return;
      io.to(p.id).emit('show_personal_feedback', { comments: p.receivedComments, totalScore: p.totalScore });
    });

    // The game is over, so free the photos (the bulk of a room's memory).
    room.pool = null;
    room.activeDeck = null;
  }

  // Players whose phones are offline don't hold up the "Begin Presentations!" button.
  function sendSubmissionProgress(room) {
    const active = room.players.filter(p => !p.left);
    const online = active.filter(p => p.connected);
    const allSubmitted = active.length >= config.minPlayers && online.length > 0 && online.every(p => p.submitted);
    io.to(room.hostSocketId).emit('submission_progress_updated', { players: room.players, allSubmitted });
  }

  // Someone dropped or came back: the game may be able to move on now.
  function checkProgress(roomCode, room) {
    if (room.gameState === 'SUBMITTING') sendSubmissionProgress(room);
    if (room.gameState === 'RATING') checkRatingsComplete(roomCode, room);
  }

  function syncPlayerToCurrentRoom(socket, roomCode, room, player) {
    if (!player || !room) return;

    socket.emit('joined_successfully', { roomCode, player, reconnectToken: ensureReconnectToken(player) });

    if (room.gameState === 'LOBBY') {
      io.to(roomCode).emit('player_list_updated', room.players);
      return;
    }

    if (room.gameState === 'SUBMITTING') {
      if (player.submitted) socket.emit('submission_already_received');
      else socket.emit('start_submission_phase', submissionPhasePayload());
      return;
    }

    if ((room.gameState === 'PRESENTING' || room.gameState === 'CONCLUSION') && room.activeDeck) {
      const currentPair = getCurrentPair(room);
      if (!currentPair) return;
      socket.emit('presentation_get_ready', {
        presenterName: currentPair.presenterName,
        slidemasterName: currentPair.slidemasterName,
        topic: room.activeDeck.topic
      });
      if (room.countdownActive) return; // roles go out when the countdown ends
      socket.emit('slide_update', slidePayload(room.activeDeck));
      emitPresentationRole(socket, room, currentPair, player);
      return;
    }

    if (room.gameState === 'RATING') {
      const currentPair = getCurrentPair(room);
      if (!currentPair) return;
      if (player.id === currentPair.presenterId) {
        socket.emit('role_presenter_waiting_rating', { presenterName: currentPair.presenterName });
      } else if (room.ratedBy.has(player.id)) {
        socket.emit('rating_already_received');
      } else {
        socket.emit('role_rating', { presenterName: currentPair.presenterName });
      }
      return;
    }

    if (room.gameState === 'RANKINGS') {
      socket.emit('show_personal_feedback', { comments: player.receivedComments, totalScore: player.totalScore });
    }
  }

  // Puts a (re)connected TV back on the screen that matches the game.
  function syncHost(socket, roomCode, room) {
    socket.emit('room_created', { roomCode, hostToken: room.hostToken, state: room.gameState });
    const pair = getCurrentPair(room);
    switch (room.gameState) {
      case 'LOBBY':
        socket.emit('player_list_updated', room.players);
        break;
      case 'SUBMITTING':
        socket.emit('submission_phase_started', room.players);
        sendSubmissionProgress(room);
        break;
      case 'PRESENTING':
      case 'CONCLUSION':
        if (!pair || !room.activeDeck) break;
        if (room.countdownActive) {
          socket.emit('presentation_get_ready', {
            presenterName: pair.presenterName,
            slidemasterName: pair.slidemasterName,
            topic: room.activeDeck.topic
          });
        } else {
          socket.emit('slide_update', slidePayload(room.activeDeck));
        }
        break;
      case 'RATING':
        if (pair) socket.emit('start_rating_display', { presenterName: pair.presenterName });
        break;
      case 'RANKINGS':
        socket.emit('show_rankings', rankPlayers(room.players));
        break;
    }
  }

  function hostCameBack(room) {
    room.hostConnected = true;
    clearTimeout(room.hostTimer);
    room.hostTimer = null;
  }

  function hostWentAway(roomCode, room) {
    room.hostConnected = false;
    clearTimeout(room.hostTimer);
    room.hostTimer = setTimeout(safe('host-grace', () => {
      if (rooms[roomCode] === room && !room.hostConnected) endRoom(roomCode, room, 'host_left');
    }), config.hostGraceMs);
  }

  // A phone that dropped its connection came back within reconnectWindowMs.
  // It still has the same socket id and room, and Socket.IO replays what it missed.
  function handleReconnect(socket) {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    if (socket.id === room.hostSocketId) {
      hostCameBack(room);
      return;
    }

    let player = findPlayer(room, socket.id);

    // Players who drop in the lobby are removed from it, so put them back if
    // presentations haven't started yet.
    const canRejoin = room.gameState === 'LOBBY' || room.gameState === 'SUBMITTING';
    if (!player && socket.data.player && canRejoin && room.players.length < config.maxPlayers) {
      player = socket.data.player;
      player.id = socket.id;
      room.players.push(player);
      io.to(roomCode).emit('player_list_updated', room.players);
    }
    if (!player) return;

    player.connected = true;
    player.away = false;
    syncPlayerToCurrentRoom(socket, roomCode, room, player);
    checkProgress(roomCode, room);
  }

  function deleteRoom(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    clearInterval(room.countdownTimer);
    clearTimeout(room.ratingTimer);
    clearTimeout(room.slidemasterTimer);
    clearTimeout(room.hostTimer);
    delete rooms[roomCode];
  }

  function endRoom(roomCode, room, reason = 'host') {
    if (rooms[roomCode] !== room) return;

    const memberSocketIds = [...(io.sockets.adapter.rooms.get(roomCode) || [])];
    io.to(roomCode).emit('room_ended', { reason });

    memberSocketIds.forEach(socketId => {
      const memberSocket = io.sockets.sockets.get(socketId);
      if (!memberSocket) return;
      memberSocket.data.roomCode = null;
      delete memberSocket.data.player;
      memberSocket.leave(roomCode);
    });

    deleteRoom(roomCode);
  }

  function createRoomForHost(socket) {
    const roomCode = generateRoomCode(code => Boolean(rooms[code]));
    socket.data.roomCode = roomCode;

    rooms[roomCode] = {
      hostSocketId: socket.id,
      hostToken: randomUUID(),
      hostConnected: true,
      hostTimer: null,
      players: [],
      gameState: 'LOBBY',
      pool: { photos: [], topics: [] },
      contributions: new Map(),
      presenterRing: [],
      currentPairIndex: 0,
      activeDeck: null,
      countdownActive: false,
      countdownTimer: null,
      ratingTimer: null,
      slidemasterTimer: null,
      ratedBy: new Set(),
      ratingStartedAt: 0,
      createdAt: Date.now()
    };

    socket.join(roomCode);
    socket.emit('room_created', { roomCode, hostToken: rooms[roomCode].hostToken, state: 'LOBBY' });
  }

  function addNewPlayer(socket, roomCode, room, username, requestedToken) {
    const player = {
      id: socket.id,
      username,
      avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(username)}`,
      submitted: false,
      totalScore: 0,
      receivedComments: [],
      left: false,
      connected: true
    };
    ensureReconnectToken(player, requestedToken);
    socket.data.roomCode = roomCode;
    socket.data.player = player;
    room.players.push(player);
    socket.join(roomCode);
    syncPlayerToCurrentRoom(socket, roomCode, room, player);
    if (room.gameState === 'SUBMITTING') {
      io.to(roomCode).emit('player_list_updated', room.players);
      sendSubmissionProgress(room);
    }
  }

  io.on('connection', safe('connection', (socket) => {
    const on = (event, handler) => socket.on(event, safe(event, handler));
    socket.emit('app_version', appVersion);
    if (socket.recovered) handleReconnect(socket);

    on('create_room', () => {
      const existing = rooms[socket.data.roomCode];
      if (existing) {
        if (existing.hostSocketId !== socket.id) return; // a player can't also host
        endRoom(socket.data.roomCode, existing, 'host_restart');
      }
      createRoomForHost(socket);
    });

    // The TV page reloaded (or lost its connection for good): put it back in charge.
    on('resume_host', (payload, ack) => {
      const { roomCode, hostToken } = asObject(payload);
      const code = String(roomCode || '').toUpperCase().trim();
      const room = rooms[code];
      if (!room || typeof hostToken !== 'string' || hostToken !== room.hostToken || rooms[socket.data.roomCode] && socket.data.roomCode !== code) {
        socket.emit('resume_host_failed');
        respond(ack, { ok: false });
        return;
      }
      const previous = io.sockets.sockets.get(room.hostSocketId);
      if (previous && previous.id !== socket.id) {
        previous.emit('host_replaced');
        previous.leave(code);
        previous.data.roomCode = null;
      }
      room.hostSocketId = socket.id;
      socket.data.roomCode = code;
      socket.join(code);
      hostCameBack(room);
      syncHost(socket, code, room);
      respond(ack, { ok: true });
    });

    on('start_new_room', () => {
      const roomCode = socket.data.roomCode;
      const room = rooms[roomCode];
      if (!room || socket.id !== room.hostSocketId || room.gameState !== 'RANKINGS') {
        socket.emit('restart_game_failed');
        return;
      }
      endRoom(roomCode, room, 'host_restart');
      createRoomForHost(socket);
    });

    on('start_same_players_game', () => {
      const roomCode = socket.data.roomCode;
      const room = rooms[roomCode];
      if (!room || socket.id !== room.hostSocketId || room.gameState !== 'RANKINGS') {
        socket.emit('restart_game_failed');
        return;
      }

      const activePlayers = room.players.filter(player => !player.left);
      if (activePlayers.length < config.minPlayers) {
        socket.emit('restart_game_failed', `At least ${config.minPlayers} players are needed for a rematch.`);
        return;
      }

      clearInterval(room.countdownTimer);
      clearTimeout(room.ratingTimer);
      clearTimeout(room.slidemasterTimer);
      room.players = activePlayers;
      room.players.forEach(player => {
        player.submitted = false;
        player.totalScore = 0;
        player.receivedComments = [];
        player.away = false;
        player.connected = Boolean(io.sockets.sockets.get(player.id)?.connected);
      });
      Object.assign(room, {
        gameState: 'SUBMITTING',
        pool: { photos: [], topics: [] },
        contributions: new Map(),
        presenterRing: [],
        currentPairIndex: 0,
        activeDeck: null,
        countdownTimer: null,
        countdownActive: false,
        ratedBy: new Set(),
        ratingStartedAt: 0
      });

      socket.emit('submission_phase_started', room.players);
      room.players.forEach(player => {
        if (player.connected) io.to(player.id).emit('start_submission_phase', submissionPhasePayload());
      });
      sendSubmissionProgress(room);
    });

    on('end_game', () => {
      const roomCode = socket.data.roomCode;
      const room = rooms[roomCode];
      if (!room || socket.id !== room.hostSocketId) {
        socket.emit('end_game_failed');
        return;
      }
      endRoom(roomCode, room);
    });

    on('leave_game', () => {
      const roomCode = socket.data.roomCode;
      const room = rooms[roomCode];
      if (!room) {
        socket.emit('leave_game_failed');
        return;
      }

      const playerIndex = room.players.findIndex(player => player.id === socket.id);
      if (playerIndex === -1) {
        socket.emit('leave_game_failed');
        return;
      }

      const player = room.players[playerIndex];
      const gameState = room.gameState;
      const isWaitingPhase = gameState === 'LOBBY' || gameState === 'SUBMITTING';
      const currentPair = getCurrentPair(room);
      const wasCurrentPresenter = currentPair?.presenterId === player.id;
      const wasCurrentSlidemaster = currentPair?.slidemasterId === player.id;
      const skipCurrentTurn = wasCurrentPresenter && ['PRESENTING', 'CONCLUSION', 'RATING'].includes(gameState);
      const nextPair = skipCurrentTurn
        ? room.presenterRing.slice(room.currentPairIndex + 1).find(pair => pair.presenterId !== player.id)
        : null;

      if (isWaitingPhase) {
        if (gameState === 'SUBMITTING' && room.pool) {
          const contribution = room.contributions.get(player.id);
          removeSubmittedItems(room.pool.photos, contribution?.photos);
          removeSubmittedItems(room.pool.topics, contribution?.topics);
          room.contributions.delete(player.id);
        }
        room.players.splice(playerIndex, 1);
      } else {
        player.left = true;
        player.connected = false;
        room.presenterRing = room.presenterRing.filter(pair => pair.presenterId !== player.id);

        if (skipCurrentTurn) {
          room.currentPairIndex = nextPair ? room.presenterRing.indexOf(nextPair) : room.presenterRing.length;
        } else if (currentPair) {
          const activePairIndex = room.presenterRing.indexOf(currentPair);
          room.currentPairIndex = activePairIndex === -1
            ? Math.min(room.currentPairIndex, room.presenterRing.length)
            : activePairIndex;
        }
      }

      socket.leave(roomCode);
      socket.data.roomCode = null;
      delete socket.data.player;
      socket.emit('leave_game_confirmed');

      if (isWaitingPhase) {
        io.to(roomCode).emit('player_list_updated', room.players);
        if (gameState === 'SUBMITTING') sendSubmissionProgress(room);
        return;
      }

      if (gameState === 'RANKINGS') return;

      const activePlayers = room.players.filter(roomPlayer => !roomPlayer.left);
      if (activePlayers.length < config.minPlayers) {
        endRoom(roomCode, room, 'not_enough_players');
        return;
      }

      if (skipCurrentTurn) {
        clearInterval(room.countdownTimer);
        room.countdownTimer = null;
        room.countdownActive = false;
        clearTimeout(room.ratingTimer);
        if (nextPair) startTurn(roomCode, room);
        else showRankings(room);
        return;
      }

      if ((gameState === 'PRESENTING' || gameState === 'CONCLUSION') && wasCurrentSlidemaster && currentPair) {
        clearTimeout(room.slidemasterTimer);
        pickSlidemaster(room, currentPair);
        if (room.countdownActive) {
          io.to(roomCode).emit('presentation_get_ready', {
            presenterName: currentPair.presenterName,
            slidemasterName: currentPair.slidemasterName,
            topic: room.activeDeck?.topic
          });
        } else {
          const replacement = findPlayer(room, currentPair.slidemasterId);
          if (replacement && replacement.connected && !replacement.left) {
            emitPresentationRole(io.to(replacement.id), room, currentPair, replacement);
          }
        }
      }

      if (gameState === 'RATING') checkRatingsComplete(roomCode, room);
    });

    on('join_room', (payload) => {
      const { roomCode, username, reconnectToken } = asObject(payload);
      const cleanCode = String(roomCode || '').toUpperCase().trim();
      const room = rooms[cleanCode];
      const cleanUsername = cleanText(username, LIMITS.username);
      const requestedToken = typeof reconnectToken === 'string' ? reconnectToken.slice(0, 64) : '';

      if (!room) {
        socket.emit('error_message', 'Room not found! Check your code.');
        return;
      }

      if (!cleanUsername) {
        socket.emit('error_message', 'Please enter a username.');
        return;
      }

      // The TV can't also be a player.
      if (socket.id === room.hostSocketId) return;

      // Ignore a double-tap on JOIN (it would add the same phone twice).
      if (room.players.some(p => p.id === socket.id)) return;

      const tokenPlayer = requestedToken && room.players.find(p => p.reconnectToken === requestedToken);
      const existingPlayer = tokenPlayer || room.players.find(
        p => p.username && p.username.toLowerCase() === cleanUsername.toLowerCase()
      );

      if (existingPlayer) {
        if (existingPlayer.left) {
          socket.emit('error_message', 'You have already left this game.');
          return;
        }
        const previousId = existingPlayer.id;
        const previousSocket = io.sockets.sockets.get(previousId);
        const isTokenReconnect = tokenPlayer === existingPlayer;
        if (existingPlayer.connected && previousId !== socket.id && !isTokenReconnect && previousSocket?.connected) {
          socket.emit('error_message', 'That name is already taken in this room.');
          return;
        }

        ensureReconnectToken(existingPlayer, requestedToken);
        existingPlayer.id = socket.id;
        existingPlayer.connected = true;
        existingPlayer.away = false;

        if (previousId !== socket.id) {
          room.presenterRing.forEach(pair => {
            if (pair.presenterId === previousId) pair.presenterId = socket.id;
            if (pair.slidemasterId === previousId) pair.slidemasterId = socket.id;
          });
          if (room.ratedBy.delete(previousId)) room.ratedBy.add(socket.id);
          if (room.contributions.has(previousId)) {
            room.contributions.set(socket.id, room.contributions.get(previousId));
            room.contributions.delete(previousId);
          }
        }

        socket.data.roomCode = cleanCode;
        socket.data.player = existingPlayer;
        socket.join(cleanCode);
        if (previousSocket && previousId !== socket.id) {
          previousSocket.data.roomCode = null;
          previousSocket.disconnect(true);
        }

        syncPlayerToCurrentRoom(socket, cleanCode, room, existingPlayer);
        io.to(cleanCode).emit('player_list_updated', room.players);
        checkProgress(cleanCode, room);
        return;
      }

      // Late arrivals can still join while everyone is picking photos, because
      // the presentation order isn't decided until presentations begin.
      if (room.gameState !== 'LOBBY' && room.gameState !== 'SUBMITTING') {
        socket.emit('error_message', room.gameState === 'RANKINGS'
          ? 'This game has already finished.'
          : 'This game has already started!');
        return;
      }

      if (room.players.length >= config.maxPlayers) {
        socket.emit('error_message', `Room is full! (Max ${config.maxPlayers} players)`);
        return;
      }

      addNewPlayer(socket, cleanCode, room, cleanUsername, requestedToken);
    });

    on('host_start_game', () => {
      const roomCode = socket.data.roomCode;
      const room = rooms[roomCode];
      if (!room || socket.id !== room.hostSocketId || room.gameState !== 'LOBBY') return;
      // With one player, the presenter would also be the slidemaster and nobody
      // could ever change the slides.
      if (room.players.length < config.minPlayers) {
        socket.emit('start_game_failed', `You need at least ${config.minPlayers} players to start.`);
        return;
      }

      room.gameState = 'SUBMITTING';
      socket.emit('submission_phase_started', room.players);
      socket.broadcast.to(roomCode).emit('start_submission_phase', submissionPhasePayload());
      sendSubmissionProgress(room);
    });

    on('submit_player_content', (payload, ack) => {
      const { photos, topics } = asObject(payload);
      const room = rooms[socket.data.roomCode];
      if (!room || !room.pool) {
        respond(ack, { ok: false, error: 'This game is no longer running.' });
        return;
      }

      const playerObj = findPlayer(room, socket.id);
      if (!playerObj || playerObj.left) {
        respond(ack, { ok: false, error: 'You are not in this game.' });
        return;
      }
      if (playerObj.submitted) {
        respond(ack, { ok: true, duplicate: true });
        return;
      }

      const cleanPhotos = (Array.isArray(photos) ? photos : []).filter(isValidPhoto).slice(0, config.photosPerPlayer);
      const cleanTopics = (Array.isArray(topics) ? topics : [])
        .map(t => cleanText(t, LIMITS.topic)).filter(Boolean).slice(0, config.topicsPerPlayer);
      if (cleanPhotos.length === 0 || cleanTopics.length === 0) {
        respond(ack, { ok: false, error: 'Please add your photos and at least one topic.' });
        return;
      }

      const contribution = {
        photos: cleanPhotos,
        topics: cleanTopics.map(text => ({ text, author: playerObj }))
      };
      room.contributions.set(playerObj.id, contribution);
      room.pool.photos.push(...contribution.photos);
      room.pool.topics.push(...contribution.topics);
      playerObj.submitted = true;
      respond(ack, { ok: true });

      if (room.gameState === 'SUBMITTING') sendSubmissionProgress(room);
    });

    on('start_presentations', () => {
      const roomCode = socket.data.roomCode;
      const room = rooms[roomCode];
      // Only once (a double-click used to start two overlapping countdowns).
      if (!room || socket.id !== room.hostSocketId || room.gameState !== 'SUBMITTING') return;

      const active = room.players.filter(p => !p.left);
      const waitingFor = active.filter(p => p.connected && !p.submitted);
      if (active.length < config.minPlayers) {
        socket.emit('start_presentations_failed', `You need at least ${config.minPlayers} players.`);
        return;
      }
      if (waitingFor.length > 0 || room.pool.photos.length === 0) {
        socket.emit('start_presentations_failed', 'Still waiting for submissions.');
        return;
      }

      room.contributions.clear();
      room.presenterRing = buildPresenterRing(room.players);
      room.currentPairIndex = 0;
      startTurn(roomCode, room);
    });

    on('advance_slide', (payload) => {
      const { slideIndex, choice, selectedContent } = asObject(payload);
      const roomCode = socket.data.roomCode;
      const room = rooms[roomCode];
      if (!room || !room.activeDeck || room.gameState !== 'PRESENTING' || room.countdownActive) return;

      // Only the current slidemaster can change slides.
      const currentPair = getCurrentPair(room);
      if (!currentPair || socket.id !== currentPair.slidemasterId) return;

      const deck = room.activeDeck;
      // The phone says which slide it was looking at; a double-tap or a tap from
      // an out-of-date screen would otherwise skip a slide (and could put a photo
      // on a text slide). Re-sync that phone instead.
      if (slideIndex !== undefined && slideIndex !== deck.currentSlideIndex) {
        socket.emit('update_slidemaster_remote', slidemasterPayload(room, currentPair));
        return;
      }
      if (deck.currentSlideIndex >= deck.totalSlides) return;

      const nextIndex = deck.currentSlideIndex + 1;
      const nextType = getSlideType(nextIndex, deck.totalSlides);
      let content;
      if (nextType === 'CONCLUSION') {
        content = deck.conclusion;
      } else {
        const pool = nextType === 'PHOTO' ? deck.photosPool : deck.textBlurbsPool;
        if (Number.isInteger(choice) && choice >= 0 && choice < pool.length) content = pool[choice];
        else if (typeof selectedContent === 'string' && pool.includes(selectedContent)) content = selectedContent;
        else content = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
      }

      deck.currentSlideIndex = nextIndex;
      deck.currentSlideContent = { type: nextType, content };
      io.to(room.hostSocketId).emit('slide_update', slidePayload(deck));

      if (deck.currentSlideIndex < deck.totalSlides) {
        socket.emit('update_slidemaster_remote', slidemasterPayload(room, currentPair, { includePools: false }));
      } else {
        room.gameState = 'CONCLUSION';
        socket.emit('conclusion_slide_displayed', { presenterName: currentPair.presenterName });
      }
    });

    on('finish_presentation', () => {
      const roomCode = socket.data.roomCode;
      const room = rooms[roomCode];
      if (!room || !room.activeDeck || room.gameState !== 'CONCLUSION') return;
      if (room.activeDeck.currentSlideIndex < room.activeDeck.totalSlides) return;

      const currentPair = getCurrentPair(room);
      if (!currentPair || socket.id !== currentPair.slidemasterId) return;

      startRating(roomCode, room);
    });

    on('submit_rating', (payload) => {
      const { rating, comment } = asObject(payload);
      const roomCode = socket.data.roomCode;
      const room = rooms[roomCode];
      // Late ratings (after the round moved on) used to crash the whole server.
      if (!room || room.gameState !== 'RATING') return;

      const currentPair = getCurrentPair(room);
      if (!currentPair) return;
      const presenterObj = findPlayer(room, currentPair.presenterId);
      const raterObj = findPlayer(room, socket.id);

      // The presenter doesn't rate themselves, and each player rates once per round.
      if (!raterObj || raterObj === presenterObj || room.ratedBy.has(raterObj.id)) return;
      room.ratedBy.add(raterObj.id);

      if (presenterObj) {
        presenterObj.totalScore += Math.round(Math.min(10, Math.max(1, Number(rating) || 0)));
        const text = cleanText(comment, LIMITS.comment);
        if (text) presenterObj.receivedComments.push({ from: raterObj.username, text });
      }

      checkRatingsComplete(roomCode, room);
    });

    on('disconnect', () => {
      const roomCode = socket.data.roomCode;
      const room = rooms[roomCode];
      if (!room) return;

      if (socket.id === room.hostSocketId) {
        hostWentAway(roomCode, room);
        return;
      }

      const player = findPlayer(room, socket.id);
      if (!player) return;

      if (room.gameState === 'LOBBY') {
        room.players.splice(room.players.indexOf(player), 1);
        io.to(roomCode).emit('player_list_updated', room.players);
        return;
      }

      // Mid-game, keep the player (their score, turn and comments) in case their
      // phone comes back, but don't let them hold everyone else up.
      player.connected = false;
      scheduleSlidemasterHandoff(roomCode, room, player);
      checkProgress(roomCode, room);
    });
  }));

  // Delete rooms nobody is connected to anymore, so finished and abandoned games
  // (and all their photos) don't pile up in memory.
  function cleanupRooms(now = Date.now()) {
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const someoneConnected = (io.sockets.adapter.rooms.get(roomCode)?.size || 0) > 0;

      if (someoneConnected) room.emptySince = null;
      else if (!room.emptySince) room.emptySince = now;

      const abandoned = room.emptySince && now - room.emptySince > config.reconnectWindowMs;
      if (abandoned || now - room.createdAt > config.maxRoomAgeMs) deleteRoom(roomCode);
    }
  }
  const cleanupTimer = setInterval(safe('cleanup', () => cleanupRooms()), config.cleanupIntervalMs);
  cleanupTimer.unref();

  function close() {
    clearInterval(cleanupTimer);
    Object.keys(rooms).forEach(deleteRoom);
    return new Promise(resolve => {
      io.close(() => resolve());
    });
  }

  return { app, server, io, rooms, config, appVersion, cleanupRooms, close };
}

module.exports = {
  createGameServer,
  DEFAULTS,
  LIMITS,
  cleanText,
  isValidPhoto,
  generateRoomCode,
  buildPresenterRing,
  getSlideType,
  rankPlayers,
  removeSubmittedItems,
  takeTopic,
  asObject,
  safe
};

if (require.main === module) {
  const { server } = createGameServer();
  const PORT = process.env.PORT || 3000;
  // The production server sets HOST=127.0.0.1 so the app is only reachable through
  // nginx. Unset (all interfaces) for local development, e.g. testing from phones.
  const HOST = process.env.HOST;
  server.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST || 'localhost'}:${PORT}`);
  });
}
