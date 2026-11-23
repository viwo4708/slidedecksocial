const socket = io();

    const HOST_SESSION_KEY = 'slidedecksocial-host';

    const homeScreen = document.getElementById('home-screen');
    const lobbyScreen = document.getElementById('lobby-screen');
    const submissionScreen = document.getElementById('submission-screen');
    const countdownScreen = document.getElementById('countdown-screen');
    const presentationStage = document.getElementById('presentation-stage');
    const hostRatingScreen = document.getElementById('host-rating-screen');
    const rankingsScreen = document.getElementById('rankings-screen');

    const startGameBtn = document.getElementById('start-game-btn');
    const homeNotice = document.getElementById('home-notice');
    const displayRoomCode = document.getElementById('display-room-code');
    const playerGrid = document.getElementById('player-grid');
    const playerCount = document.getElementById('player-count');
    const lobbyHint = document.getElementById('lobby-hint');
    const hostStartBtn = document.getElementById('host-start-btn');
    const endGameBtn = document.getElementById('host-end-game-btn');
    const newRoomBtn = document.getElementById('new-room-btn');
    const samePlayersBtn = document.getElementById('same-players-btn');

    const submissionGrid = document.getElementById('submission-grid');
    const submittedCount = document.getElementById('submitted-count');
    const totalCount = document.getElementById('total-count');
    const beginPresentationsBtn = document.getElementById('begin-presentations-btn');

    const announcePresenter = document.getElementById('announce-presenter');
    const announceSlidemaster = document.getElementById('announce-slidemaster');
    const hostCountdown = document.getElementById('host-countdown');

    const slideCounter = document.getElementById('slide-counter');
    const slideContent = document.getElementById('slide-content');
    const ratingPresenterTitle = document.getElementById('rating-presenter-title');
    const rankingsList = document.getElementById('rankings-list');

    const MIN_PLAYERS = 2;
    let appVersion = null;

    // Show the real address players should type (works on the live site and locally).
    document.querySelectorAll('.join-url').forEach(el => { el.textContent = `${location.host}/join`; });

    // Builds an element with plain-text content. Player names, topics and
    // comments are never inserted as HTML, so nobody can inject markup or
    // scripts onto the TV.
    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = text;
      return node;
    }

    function playerCard(p, statusText, statusClass) {
      const card = el('div', 'player-card');
      const img = el('img');
      img.src = p.avatar;
      img.alt = '';
      img.width = 80;
      img.height = 80;
      card.append(img, el('p', 'player-name', p.username));
      if (statusText) card.append(el('p', statusClass || '', statusText));
      if (p.connected === false) card.classList.add('player-card--offline');
      return card;
    }

    function saveHostSession(roomCode, hostToken) {
      try { sessionStorage.setItem(HOST_SESSION_KEY, JSON.stringify({ roomCode, hostToken })); } catch (e) {}
    }
    function loadHostSession() {
      try { return JSON.parse(sessionStorage.getItem(HOST_SESSION_KEY) || 'null'); } catch (e) { return null; }
    }
    function clearHostSession() {
      try { sessionStorage.removeItem(HOST_SESSION_KEY); } catch (e) {}
    }

    function showHome(message) {
      hideHostScreens();
      homeScreen.style.display = 'block';
      endGameBtn.style.display = 'none';
      endGameBtn.disabled = false;
      startGameBtn.disabled = false;
      displayRoomCode.innerText = '----';
      playerGrid.innerHTML = '';
      playerCount.innerText = '0';
      hostStartBtn.style.display = 'none';
      beginPresentationsBtn.style.display = 'none';
      setRestartButtonsDisabled(false);
      homeNotice.textContent = message || '';
    }

    // If this TV page was reloaded mid-game, take the game back over.
    socket.on('connect', () => {
      if (socket.recovered) return;
      const saved = loadHostSession();
      if (saved && saved.roomCode && saved.hostToken) socket.emit('resume_host', saved);
    });

    // A new server version was deployed (or the server restarted): reload to get
    // the matching page code. Any game in progress is gone at that point anyway.
    socket.on('app_version', (version) => {
      if (appVersion && appVersion !== version) window.location.reload();
      appVersion = version;
    });

    startGameBtn.addEventListener('click', () => {
      startGameBtn.disabled = true; // a double-click used to create two rooms
      homeNotice.textContent = '';
      socket.emit('create_room');
      setTimeout(() => { startGameBtn.disabled = false; }, 5000);
    });

    endGameBtn.addEventListener('click', () => {
      if (!window.confirm('End this game for everyone? Players will be returned to the join screen.')) return;
      endGameBtn.disabled = true;
      socket.emit('end_game');
    });

    newRoomBtn.addEventListener('click', () => {
      if (!window.confirm('End this game and create a new room? Players will need to join with the new room code.')) return;
      setRestartButtonsDisabled(true);
      socket.emit('start_new_room');
    });

    samePlayersBtn.addEventListener('click', () => {
      if (!window.confirm('Start a new game with the players who have not left? Scores and submissions will reset.')) return;
      setRestartButtonsDisabled(true);
      socket.emit('start_same_players_game');
    });

    function setRestartButtonsDisabled(disabled) {
      newRoomBtn.disabled = disabled;
      samePlayersBtn.disabled = disabled;
    }

    socket.on('room_created', ({ roomCode, hostToken, state } = {}) => {
      saveHostSession(roomCode, hostToken);
      displayRoomCode.innerText = roomCode;
      document.querySelectorAll('.room-code-inline').forEach(node => { node.textContent = roomCode; });
      endGameBtn.style.display = 'block';
      endGameBtn.disabled = false;
      homeNotice.textContent = '';
      // When resuming mid-game, the next event from the server shows the right screen.
      if (!state || state === 'LOBBY') {
        hideHostScreens();
        lobbyScreen.style.display = 'block';
      }
    });

    socket.on('resume_host_failed', () => {
      clearHostSession();
      if (homeScreen.style.display === 'none') showHome('That game has ended. Start a new one whenever you’re ready!');
    });

    socket.on('host_replaced', () => {
      clearHostSession();
      showHome('This game was opened in another tab or window.');
    });

    socket.on('room_ended', ({ reason } = {}) => {
      clearHostSession();
      showHome(reason === 'host_left' ? 'The game ended because this screen was disconnected for too long.' : '');
    });

    socket.on('end_game_failed', () => {
      endGameBtn.disabled = false;
      window.alert('The game could not be ended. Please try again.');
    });

    socket.on('restart_game_failed', (message) => {
      setRestartButtonsDisabled(false);
      window.alert(message || 'The game could not be restarted. Please try again.');
    });

    socket.on('start_game_failed', (message) => {
      hostStartBtn.disabled = false;
      lobbyHint.textContent = message || 'The game could not be started.';
    });

    socket.on('start_presentations_failed', (message) => {
      beginPresentationsBtn.disabled = false;
      window.alert(message || 'Presentations could not be started yet.');
    });

    socket.on('player_list_updated', (players) => {
      playerCount.innerText = players.length;
      playerGrid.replaceChildren(...players.map(p => playerCard(p)));
      const enough = players.length >= MIN_PLAYERS;
      hostStartBtn.style.display = enough ? 'inline-block' : 'none';
      hostStartBtn.disabled = false;
      lobbyHint.textContent = enough
        ? (players.length < 3 ? '3–8 players works best, but you can start now.' : 'Everyone in? Start the game!')
        : `Waiting for players… (need at least ${MIN_PLAYERS}, 3–8 works best)`;
    });

    hostStartBtn.addEventListener('click', () => {
      hostStartBtn.disabled = true;
      socket.emit('host_start_game');
    });

    socket.on('submission_phase_started', (players) => {
      hideHostScreens();
      submissionScreen.style.display = 'block';
      endGameBtn.style.display = 'block';
      totalCount.innerText = players.length;
      submittedCount.innerText = players.filter(p => p.submitted).length;
      renderSubmissionGrid(players);
      beginPresentationsBtn.style.display = 'none';
      beginPresentationsBtn.disabled = false;
      setRestartButtonsDisabled(false);
    });

    socket.on('submission_progress_updated', ({ players, allSubmitted }) => {
      const active = players.filter(p => !p.left);
      submittedCount.innerText = active.filter(p => p.submitted).length;
      totalCount.innerText = active.length;
      renderSubmissionGrid(active);
      beginPresentationsBtn.style.display = allSubmitted ? 'inline-block' : 'none';
    });

    function renderSubmissionGrid(players) {
      submissionGrid.replaceChildren(...players.map(p => {
        if (p.submitted) return playerCard(p, 'READY ✓', 'status-done');
        return playerCard(p, p.connected === false ? 'Offline' : 'Waiting...');
      }));
    }

    beginPresentationsBtn.addEventListener('click', () => {
      beginPresentationsBtn.disabled = true;
      socket.emit('start_presentations');
    });

    socket.on('presentation_get_ready', ({ presenterName, slidemasterName, countdown } = {}) => {
      hideHostScreens();
      countdownScreen.style.display = 'block';
      if (presenterName) announcePresenter.innerText = `${presenterName.toUpperCase()}, YOU'RE PRESENTING!`;
      if (slidemasterName) announceSlidemaster.innerText = `Slidemaster: ${slidemasterName}`;
      if (countdown !== undefined) hostCountdown.innerText = countdown;
    });

    socket.on('countdown_tick', (seconds) => {
      hostCountdown.innerText = seconds;
    });

    socket.on('slide_update', ({ slideIndex, totalSlides, content } = {}) => {
      hideHostScreens();
      presentationStage.style.display = 'flex';

      slideCounter.innerText = `${slideIndex}/${totalSlides}`;
      const slide = content || {};
      const nodes = [];

      if (slide.type === 'TOPIC') {
        nodes.push(el('h2', 'slide-label', 'TOPIC:'), el('h2', 'slide-topic', slide.content));
      } else if (slide.type === 'PHOTO') {
        if (typeof slide.content === 'string' && slide.content.startsWith('data:image/')) {
          const img = el('img');
          img.src = slide.content;
          img.alt = '';
          nodes.push(img);
        } else {
          nodes.push(el('h2', '', '🖼️'));
        }
      } else if (slide.type === 'TEXT' || slide.type === 'CONCLUSION') {
        nodes.push(el('h2', slide.type === 'CONCLUSION' ? 'slide-conclusion' : '', slide.content || ''));
      }
      slideContent.replaceChildren(...nodes);
    });

    // Rating Display on TV
    socket.on('start_rating_display', ({ presenterName }) => {
      hideHostScreens();
      hostRatingScreen.style.display = 'block';
      ratingPresenterTitle.innerText = presenterName;
    });

    // Final Leaderboard Rankings Display on TV
    socket.on('show_rankings', (sortedPlayers) => {
      hideHostScreens();
      rankingsScreen.style.display = 'block';
      endGameBtn.style.display = 'none';
      setRestartButtonsDisabled(false);

      rankingsList.replaceChildren(...sortedPlayers.map((player, index) => {
        const rank = player.rank || index + 1; // tied scores share a rank
        const row = el('div', `ranking-row ${rank <= 3 ? 'ranking-top-3' : ''}`);
        const name = el('span', 'ranking-name');
        name.append(el('b', 'ranking-rank', `#${rank}`), document.createTextNode(` ${player.username}`));
        if (player.left) name.append(el('small', 'ranking-left', ' (left)'));
        row.append(name, el('span', 'ranking-score', `${player.totalScore} pts`));
        return row;
      }));
    });

    function hideHostScreens() {
      homeScreen.style.display = 'none';
      lobbyScreen.style.display = 'none';
      submissionScreen.style.display = 'none';
      countdownScreen.style.display = 'none';
      presentationStage.style.display = 'none';
      hostRatingScreen.style.display = 'none';
      rankingsScreen.style.display = 'none';
    }
