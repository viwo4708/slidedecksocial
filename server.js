const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomUUID } = require('crypto');
const { GAME_TEXT_BLURBS, GAME_CONCLUSIONS } = require('./gameContent');

// Phones drop their connection all the time (screen locks, switching apps, the
// photo picker). Socket.IO lets them reconnect within this window as the SAME
// player and replays any events they missed, instead of treating them as a stranger.
const RECONNECT_WINDOW_MS = 30 * 60 * 1000;
// When rating opens, wait this long for players whose phones are asleep before
// moving on without them. Players who are connected are always waited for.
const RATING_GRACE_MS = 45 * 1000;
// Safety net: rooms are deleted once nobody has been connected for
// RECONNECT_WINDOW_MS, or after this long no matter what.
const MAX_ROOM_AGE_MS = 12 * 60 * 60 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7,
  connectionStateRecovery: { maxDisconnectionDuration: RECONNECT_WINDOW_MS }
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function ensureReconnectToken(player, requestedToken) {
  if (!player.reconnectToken) {
    Object.defineProperty(player, 'reconnectToken', {
      value: requestedToken || randomUUID(),
      configurable: true
    });
  }
  return player.reconnectToken;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function removeSubmittedItems(pool, submittedItems = []) {
  for (const item of submittedItems) {
    const itemIndex = pool.indexOf(item);
    if (itemIndex !== -1) pool.splice(itemIndex, 1);
  }
}

function buildPresenterRing(players) {
  const ring = [];
  const activePlayers = players.filter(player => !player.left);
  const numPlayers = activePlayers.length;
  for (let i = 0; i < numPlayers; i++) {
    const presenter = activePlayers[i];
    const slidemaster = activePlayers[(i + 1) % numPlayers];
    ring.push({
      presenterId: presenter.id,
      presenterName: presenter.username,
      slidemasterId: slidemaster.id,
      slidemasterName: slidemaster.username
    });
  }
  return ring;
}

function getSlideType(slideIndex) {
  if (slideIndex === 1) return 'TOPIC';
  if (slideIndex === 10) return 'CONCLUSION';
  return (slideIndex % 2 === 0) ? 'PHOTO' : 'TEXT';
}

function generatePresentationDeck(topic, photosPool) {
  const randomConclusion = GAME_CONCLUSIONS[Math.floor(Math.random() * GAME_CONCLUSIONS.length)];
  return {
    currentSlideIndex: 1,
    totalSlides: 10,
    topic: topic,
    photosPool: photosPool,
    textBlurbsPool: GAME_TEXT_BLURBS,
    conclusion: randomConclusion,
    currentSlideContent: {
      type: 'TOPIC',
      content: topic
    }
  };
}

function startTurn(roomCode, room) {
  room.gameState = 'PRESENTING';
  room.countdownActive = true;
  room.ratedBy = new Set();
  const currentPair = room.presenterRing[room.currentPairIndex];
  pickSlidemaster(room, currentPair);

  let chosenTopic = "The Secret to Ultimate Success";
  if (room.pool && room.pool.topics && room.pool.topics.length > 0) {
    const randomIndex = Math.floor(Math.random() * room.pool.topics.length);
    chosenTopic = room.pool.topics.splice(randomIndex, 1)[0];
  }

  room.activeDeck = generatePresentationDeck(chosenTopic, room.pool ? room.pool.photos : []);

  io.to(roomCode).emit('presentation_get_ready', {
    presenterName: currentPair.presenterName,
    slidemasterName: currentPair.slidemasterName,
    topic: chosenTopic
  });

  let countdown = 10;
  clearInterval(room.countdownTimer);
  room.countdownTimer = setInterval(() => {
    io.to(roomCode).emit('countdown_tick', countdown);
    countdown--;

    if (countdown < 0) {
      clearInterval(room.countdownTimer);
      room.countdownTimer = null;
      room.countdownActive = false;

      io.to(roomCode).emit('slide_update', {
        slideIndex: room.activeDeck.currentSlideIndex,
        totalSlides: room.activeDeck.totalSlides,
        content: room.activeDeck.currentSlideContent
      });

      notifyMobileRoles(roomCode, room, currentPair);
    }
  }, 1000);
}

// The slidemaster needs their phone. If theirs is offline when the turn starts
// (e.g. they closed the tab), hand the controls to the next connected player.
function pickSlidemaster(room, pair) {
  const scheduled = room.players.find(p => p.id === pair.slidemasterId);
  if (scheduled && scheduled.connected) return;

  const start = room.players.findIndex(p => p.id === pair.presenterId);
  for (let i = 1; i < room.players.length; i++) {
    const p = room.players[(start + i) % room.players.length];
    if (p.connected && !p.left && p.id !== pair.presenterId) {
      pair.slidemasterId = p.id;
      pair.slidemasterName = p.username;
      return;
    }
  }
}

function notifyMobileRoles(roomCode, room, currentPair) {
  const nextSlideType = getSlideType(room.activeDeck.currentSlideIndex + 1);

  room.players.forEach(p => {
    if (p.left) return;
    if (p.id === currentPair.presenterId) {
      io.to(p.id).emit('role_presenter', { topic: room.activeDeck.topic });
    } else if (p.id === currentPair.slidemasterId) {
      io.to(p.id).emit('role_slidemaster', {
        presenterName: currentPair.presenterName,
        nextSlideIndex: room.activeDeck.currentSlideIndex + 1,
        nextSlideType: nextSlideType,
        photosPool: room.activeDeck.photosPool,
        textBlurbsPool: room.activeDeck.textBlurbsPool
      });
    } else {
      io.to(p.id).emit('role_audience', { presenterName: currentPair.presenterName });
    }
  });
}

function startRating(roomCode, room) {
  room.gameState = 'RATING';
  room.ratedBy = new Set();
  room.ratingStartedAt = Date.now();
  const currentPair = room.presenterRing[room.currentPairIndex];

  io.to(room.hostSocketId).emit('start_rating_display', {
    presenterName: currentPair.presenterName
  });

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
  room.ratingTimer = setTimeout(() => {
    if (rooms[roomCode] === room && room.gameState === 'RATING') checkRatingsComplete(roomCode, room);
  }, RATING_GRACE_MS);
}

// Everyone except the presenter rates. We wait for every connected player, and
// for offline ones only until RATING_GRACE_MS after rating opened, so one dead
// phone can't freeze the game. Players who already sat out a whole round offline
// are "away" and aren't waited for at all until their phone comes back.
function checkRatingsComplete(roomCode, room) {
  const currentPair = room.presenterRing[room.currentPairIndex];
  const graceOver = Date.now() - room.ratingStartedAt >= RATING_GRACE_MS;
  const raters = room.players.filter(p =>
    !p.left && p.id !== currentPair.presenterId && (p.connected || (!graceOver && !p.away))
  );
  if (!raters.every(p => room.ratedBy.has(p.id))) return;

  clearTimeout(room.ratingTimer);
  room.players.forEach(p => {
    if (!p.left && !p.connected && p.id !== currentPair.presenterId && !room.ratedBy.has(p.id)) p.away = true;
  });
  room.currentPairIndex++;

  if (room.currentPairIndex < room.presenterRing.length) {
    // Start next player's presentation turn
    startTurn(roomCode, room);
  } else {
    showRankings(room);
  }
}

function showRankings(room) {
  // Game Over! Transition to final rankings leaderboard
  room.gameState = 'RANKINGS';

  // Sort players from highest score to lowest score
  const sortedPlayers = [...room.players].sort((a, b) => b.totalScore - a.totalScore);

  io.to(room.hostSocketId).emit('show_rankings', sortedPlayers);

  room.players.forEach(p => {
    if (p.left || !p.connected) return;
    io.to(p.id).emit('show_personal_feedback', {
      comments: p.receivedComments,
      totalScore: p.totalScore
    });
  });

  // The game is over, so free the photos (the bulk of a room's memory).
  room.pool = null;
  room.activeDeck = null;
}

// Players whose phones are offline don't hold up the "Begin Presentations!" button.
function sendSubmissionProgress(room) {
  const online = room.players.filter(p => p.connected && !p.left);
  const allSubmitted = online.length > 0 && online.every(p => p.submitted);

  io.to(room.hostSocketId).emit('submission_progress_updated', {
    players: room.players,
    allSubmitted
  });
}

// Someone dropped or came back: the game may be able to move on now.
function checkProgress(roomCode, room) {
  if (room.gameState === 'SUBMITTING') sendSubmissionProgress(room);
  if (room.gameState === 'RATING') checkRatingsComplete(roomCode, room);
}

function syncPlayerToCurrentRoom(socket, roomCode, room, player) {
  if (!player || !room) return;

  socket.emit('joined_successfully', {
    roomCode,
    player,
    reconnectToken: ensureReconnectToken(player)
  });

  if (room.gameState === 'LOBBY') {
    io.to(roomCode).emit('player_list_updated', room.players);
    return;
  }

  if (room.gameState === 'SUBMITTING') {
    socket.emit(player.submitted ? 'submission_already_received' : 'start_submission_phase');
    return;
  }

  if ((room.gameState === 'PRESENTING' || room.gameState === 'CONCLUSION') && room.activeDeck && room.presenterRing.length > 0) {
    const currentPair = room.presenterRing[room.currentPairIndex];
    if (!currentPair) return;

    socket.emit('presentation_get_ready', {
      presenterName: currentPair.presenterName,
      slidemasterName: currentPair.slidemasterName,
      topic: room.activeDeck.topic
    });

    socket.emit('slide_update', {
      slideIndex: room.activeDeck.currentSlideIndex,
      totalSlides: room.activeDeck.totalSlides,
      content: room.activeDeck.currentSlideContent
    });

    if (player.id === currentPair.presenterId) {
      socket.emit('role_presenter', { topic: room.activeDeck.topic });
    } else if (player.id === currentPair.slidemasterId) {
      if (room.gameState === 'CONCLUSION') {
        socket.emit('conclusion_slide_displayed', { presenterName: currentPair.presenterName });
        return;
      }
      const nextSlideType = getSlideType(room.activeDeck.currentSlideIndex + 1);
      socket.emit('role_slidemaster', {
        presenterName: currentPair.presenterName,
        nextSlideIndex: room.activeDeck.currentSlideIndex + 1,
        nextSlideType,
        photosPool: room.activeDeck.photosPool,
        textBlurbsPool: room.activeDeck.textBlurbsPool
      });
    } else {
      socket.emit('role_audience', { presenterName: currentPair.presenterName });
    }
    return;
  }

  if (room.gameState === 'RATING') {
    const currentPair = room.presenterRing[room.currentPairIndex];
    if (!currentPair) return;

    if (player.id === currentPair.presenterId) {
      socket.emit('role_presenter_waiting_rating', { presenterName: currentPair.presenterName });
    } else {
      socket.emit('role_rating', { presenterName: currentPair.presenterName });
    }
    return;
  }

  if (room.gameState === 'RANKINGS') {
    socket.emit('show_personal_feedback', {
      comments: player.receivedComments,
      totalScore: player.totalScore
    });
  }
}

// A phone that dropped its connection came back within RECONNECT_WINDOW_MS.
// It still has the same socket id and room, and Socket.IO replays what it missed.
function handleReconnect(socket) {
  const roomCode = socket.data.roomCode;
  const room = rooms[roomCode];
  if (!room || socket.id === room.hostSocketId) return;

  let player = room.players.find(p => p.id === socket.id);

  // Players who drop in the lobby are removed from it, so put them back if
  // presentations haven't started yet.
  const canRejoin = room.gameState === 'LOBBY' || room.gameState === 'SUBMITTING';
  if (!player && socket.data.player && canRejoin && room.players.length < 8) {
    player = socket.data.player;
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
  const roomCode = generateRoomCode();
  socket.data.roomCode = roomCode;

  rooms[roomCode] = {
    hostSocketId: socket.id,
    players: [],
    gameState: 'LOBBY',
    pool: { photos: [], topics: [] },
    contributions: new Map(),
    presenterRing: [],
    currentPairIndex: 0,
    activeDeck: null,
    countdownActive: false,
    ratedBy: new Set(),
    ratingStartedAt: 0,
    createdAt: Date.now()
  };

  socket.join(roomCode);
  socket.emit('room_created', { roomCode });
}

io.on('connection', (socket) => {
  if (socket.recovered) handleReconnect(socket);

  socket.on('create_room', () => {
    createRoomForHost(socket);
  });

  socket.on('start_new_room', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.gameState !== 'RANKINGS') {
      socket.emit('restart_game_failed');
      return;
    }

    endRoom(roomCode, room, 'host_restart');
    createRoomForHost(socket);
  });

  socket.on('start_same_players_game', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.gameState !== 'RANKINGS') {
      socket.emit('restart_game_failed');
      return;
    }

    const activePlayers = room.players.filter(player => !player.left);
    if (activePlayers.length < 3) {
      socket.emit('restart_game_failed', 'At least three players are needed for a rematch.');
      return;
    }

    clearInterval(room.countdownTimer);
    clearTimeout(room.ratingTimer);
    room.players = activePlayers;
    room.players.forEach(player => {
      player.submitted = false;
      player.totalScore = 0;
      player.receivedComments = [];
      player.away = false;
      player.connected = Boolean(io.sockets.sockets.get(player.id)?.connected);
    });
    room.gameState = 'SUBMITTING';
    room.pool = { photos: [], topics: [] };
    room.contributions = new Map();
    room.presenterRing = [];
    room.currentPairIndex = 0;
    room.activeDeck = null;
    room.countdownTimer = null;
    room.countdownActive = false;
    room.ratedBy = new Set();
    room.ratingStartedAt = 0;

    socket.emit('submission_phase_started', room.players);
    room.players.forEach(player => {
      if (player.connected) io.to(player.id).emit('start_submission_phase');
    });
  });

  socket.on('end_game', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId) {
      socket.emit('end_game_failed');
      return;
    }
    endRoom(roomCode, room);
  });

  socket.on('leave_game', () => {
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
    const currentPair = room.presenterRing[room.currentPairIndex];
    const wasCurrentPresenter = currentPair?.presenterId === player.id;
    const wasCurrentSlidemaster = currentPair?.slidemasterId === player.id;
    const skipCurrentTurn = wasCurrentPresenter &&
      ['PRESENTING', 'CONCLUSION', 'RATING'].includes(gameState);
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
    if (activePlayers.length < 3) {
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

    if (gameState === 'PRESENTING' && wasCurrentSlidemaster && currentPair) {
      pickSlidemaster(room, currentPair);
      if (room.countdownActive) {
        io.to(roomCode).emit('presentation_get_ready', {
          presenterName: currentPair.presenterName,
          slidemasterName: currentPair.slidemasterName
        });
      } else {
        notifyMobileRoles(roomCode, room, currentPair);
      }
    } else if (gameState === 'CONCLUSION' && wasCurrentSlidemaster && currentPair) {
      pickSlidemaster(room, currentPair);
      const replacement = room.players.find(roomPlayer => roomPlayer.id === currentPair.slidemasterId);
      if (replacement && replacement.connected && !replacement.left) {
        io.to(replacement.id).emit('conclusion_slide_displayed', {
          presenterName: currentPair.presenterName
        });
      }
    }

    if (gameState === 'RATING') checkRatingsComplete(roomCode, room);
  });

  socket.on('join_room', ({ roomCode, username, reconnectToken } = {}) => {
    const cleanCode = String(roomCode || '').toUpperCase().trim();
    const room = rooms[cleanCode];
    const cleanUsername = String(username || '').trim();
    const requestedToken = typeof reconnectToken === 'string' ? reconnectToken : '';

    if (!room) {
      socket.emit('error_message', 'Room not found! Check your code.');
      return;
    }

    if (!cleanUsername) {
      socket.emit('error_message', 'Please enter a username.');
      return;
    }

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
      if (
        existingPlayer.connected &&
        previousId !== socket.id &&
        !isTokenReconnect &&
        previousSocket?.connected
      ) {
        socket.emit('error_message', 'That name is already active in this room.');
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
      if (previousSocket && previousId !== socket.id) previousSocket.disconnect(true);

      syncPlayerToCurrentRoom(socket, cleanCode, room, existingPlayer);
      io.to(cleanCode).emit('player_list_updated', room.players);
      return;
    }

    // Someone joining mid-game has no turn and would hold up the ratings.
    if (room.gameState !== 'LOBBY') {
      socket.emit('error_message', 'This game has already started!');
      return;
    }

    if (room.players.length >= 8) {
      socket.emit('error_message', 'Room is full! (Max 8 players)');
      return;
    }

    socket.data.roomCode = cleanCode;

    const player = {
      id: socket.id,
      username: cleanUsername,
      avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${cleanUsername}`,
      submitted: false,
      totalScore: 0,
      receivedComments: [],
      left: false,
      connected: true
    };
    const playerReconnectToken = ensureReconnectToken(player, requestedToken);
    socket.data.player = player;

    room.players.push(player);
    socket.join(cleanCode);

    socket.emit('joined_successfully', {
      roomCode: cleanCode,
      player,
      reconnectToken: playerReconnectToken
    });
    io.to(cleanCode).emit('player_list_updated', room.players);
  });

  socket.on('host_start_game', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostSocketId || room.gameState !== 'LOBBY') return;

    room.gameState = 'SUBMITTING';

    io.to(roomCode).emit('submission_phase_started', room.players);
    socket.broadcast.to(roomCode).emit('start_submission_phase');
  });

  socket.on('submit_player_content', ({ photos, topics } = {}) => {
    const room = rooms[socket.data.roomCode];
    if (!room || !room.pool) return;

    const playerObj = room.players.find(p => p.id === socket.id);
    if (!playerObj || playerObj.left || playerObj.submitted) return;

    const contribution = {
      photos: Array.isArray(photos) ? photos : [],
      topics: Array.isArray(topics) ? topics : []
    };
    room.contributions.set(playerObj.id, contribution);
    room.pool.photos.push(...contribution.photos);
    room.pool.topics.push(...contribution.topics);
    playerObj.submitted = true;

    if (room.gameState === 'SUBMITTING') sendSubmissionProgress(room);
  });

  socket.on('start_presentations', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    // Only once (a double-click used to start two overlapping countdowns).
    if (!room || socket.id !== room.hostSocketId || room.gameState !== 'SUBMITTING') return;
    if (room.players.length === 0) return;

    room.contributions.clear();
    room.presenterRing = buildPresenterRing(room.players);
    startTurn(roomCode, room);
  });

  socket.on('advance_slide', ({ selectedContent } = {}) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.activeDeck || room.gameState !== 'PRESENTING') return;

    // Only the current slidemaster can change slides.
    const currentPair = room.presenterRing[room.currentPairIndex];
    if (socket.id !== currentPair.slidemasterId) return;

    const deck = room.activeDeck;
    if (deck.currentSlideIndex >= deck.totalSlides) return;
    deck.currentSlideIndex++;

    const currentType = getSlideType(deck.currentSlideIndex);

    if (currentType === 'CONCLUSION') {
      deck.currentSlideContent = {
        type: 'CONCLUSION',
        content: deck.conclusion
      };
    } else {
      deck.currentSlideContent = {
        type: currentType,
        content: selectedContent
      };
    }

    io.to(room.hostSocketId).emit('slide_update', {
      slideIndex: deck.currentSlideIndex,
      totalSlides: deck.totalSlides,
      content: deck.currentSlideContent
    });

    if (deck.currentSlideIndex < deck.totalSlides) {
      const upcomingIndex = deck.currentSlideIndex + 1;
      const upcomingType = getSlideType(upcomingIndex);

      socket.emit('update_slidemaster_remote', {
        nextSlideIndex: upcomingIndex,
        nextSlideType: upcomingType,
        photosPool: deck.photosPool,
        textBlurbsPool: deck.textBlurbsPool
      });
    } else {
      room.gameState = 'CONCLUSION';
      socket.emit('conclusion_slide_displayed', { presenterName: currentPair.presenterName });
    }
  });

  socket.on('finish_presentation', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || !room.activeDeck || room.gameState !== 'CONCLUSION') return;
    if (room.activeDeck.currentSlideIndex < room.activeDeck.totalSlides) return;

    const currentPair = room.presenterRing[room.currentPairIndex];
    if (!currentPair || socket.id !== currentPair.slidemasterId) return;

    startRating(roomCode, room);
  });

  // Handle Player Rating & Optional Comment Submission
  socket.on('submit_rating', ({ rating, comment } = {}) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    // Late ratings (after the round moved on) used to crash the whole server.
    if (!room || room.gameState !== 'RATING') return;

    const currentPair = room.presenterRing[room.currentPairIndex];
    const presenterObj = room.players.find(p => p.id === currentPair.presenterId);
    const raterObj = room.players.find(p => p.id === socket.id);

    // The presenter doesn't rate themselves, and each player rates once per round.
    if (!raterObj || raterObj === presenterObj || room.ratedBy.has(raterObj.id)) return;
    room.ratedBy.add(raterObj.id);

    // Record rating score and optional comment
    if (presenterObj) {
      presenterObj.totalScore += Math.min(10, Math.max(1, Number(rating) || 0));

      if (typeof comment === 'string' && comment.trim() !== '') {
        presenterObj.receivedComments.push({
          from: raterObj.username,
          text: comment.trim()
        });
      }
    }

    checkRatingsComplete(roomCode, room);
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    if (room.gameState === 'LOBBY') {
      room.players.splice(room.players.indexOf(player), 1);
      io.to(roomCode).emit('player_list_updated', room.players);
      return;
    }

    // Mid-game, keep the player (their score, turn and comments) in case their
    // phone comes back, but don't let them hold everyone else up.
    player.connected = false;
    checkProgress(roomCode, room);
  });
});

// Delete rooms nobody is connected to anymore, so finished and abandoned games
// (and all their photos) don't pile up in memory.
setInterval(() => {
  const now = Date.now();
  for (const roomCode in rooms) {
    const room = rooms[roomCode];
    const someoneConnected = (io.sockets.adapter.rooms.get(roomCode)?.size || 0) > 0;

    if (someoneConnected) room.emptySince = null;
    else if (!room.emptySince) room.emptySince = now;

    const abandoned = room.emptySince && now - room.emptySince > RECONNECT_WINDOW_MS;
    if (abandoned || now - room.createdAt > MAX_ROOM_AGE_MS) deleteRoom(roomCode);
  }
}, 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
// The production server sets HOST=127.0.0.1 so the app is only reachable through
// nginx. Unset (all interfaces) for local development, e.g. testing from phones.
const HOST = process.env.HOST;
server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST || 'localhost'}:${PORT}`);
});
