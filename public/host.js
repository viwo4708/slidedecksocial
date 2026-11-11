const socket = io();

    const homeScreen = document.getElementById('home-screen');
    const lobbyScreen = document.getElementById('lobby-screen');
    const submissionScreen = document.getElementById('submission-screen');
    const countdownScreen = document.getElementById('countdown-screen');
    const presentationStage = document.getElementById('presentation-stage');
    const hostRatingScreen = document.getElementById('host-rating-screen');
    const rankingsScreen = document.getElementById('rankings-screen');

    const startGameBtn = document.getElementById('start-game-btn');
    const displayRoomCode = document.getElementById('display-room-code');
    const playerGrid = document.getElementById('player-grid');
    const playerCount = document.getElementById('player-count');
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

    startGameBtn.addEventListener('click', () => socket.emit('create_room'));

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

    socket.on('room_created', ({ roomCode }) => {
      homeScreen.style.display = 'none';
      lobbyScreen.style.display = 'block';
      displayRoomCode.innerText = roomCode;
      endGameBtn.style.display = 'block';
      endGameBtn.disabled = false;
    });

    socket.on('room_ended', () => {
      hideHostScreens();
      homeScreen.style.display = 'block';
      endGameBtn.style.display = 'none';
      endGameBtn.disabled = false;
      displayRoomCode.innerText = '----';
      playerGrid.innerHTML = '';
      playerCount.innerText = '0';
      hostStartBtn.style.display = 'none';
      beginPresentationsBtn.style.display = 'none';
      setRestartButtonsDisabled(false);
    });

    socket.on('end_game_failed', () => {
      endGameBtn.disabled = false;
      window.alert('The game could not be ended. Please try again.');
    });

    socket.on('restart_game_failed', (message) => {
      setRestartButtonsDisabled(false);
      window.alert(message || 'The game could not be restarted. Please try again.');
    });

    socket.on('player_list_updated', (players) => {
      playerCount.innerText = players.length;
      playerGrid.innerHTML = '';
      players.forEach(p => {
        const div = document.createElement('div');
        div.className = 'player-card';
        div.innerHTML = `<img src="${p.avatar}"><p>${p.username}</p>`;
        playerGrid.appendChild(div);
      });
      hostStartBtn.style.display = players.length > 0 ? 'inline-block' : 'none';
    });

    hostStartBtn.addEventListener('click', () => socket.emit('host_start_game'));

    socket.on('submission_phase_started', (players) => {
      hideHostScreens();
      lobbyScreen.style.display = 'none';
      submissionScreen.style.display = 'block';
      endGameBtn.style.display = 'block';
      totalCount.innerText = players.length;
      renderSubmissionGrid(players);
      beginPresentationsBtn.style.display = 'none';
      setRestartButtonsDisabled(false);
    });

    socket.on('submission_progress_updated', ({ players, allSubmitted }) => {
      submittedCount.innerText = players.filter(p => p.submitted).length;
      renderSubmissionGrid(players);
      beginPresentationsBtn.style.display = allSubmitted ? 'inline-block' : 'none';
    });

    function renderSubmissionGrid(players) {
      submissionGrid.innerHTML = '';
      players.forEach(p => {
        const div = document.createElement('div');
        div.className = 'player-card';
        div.innerHTML = `<img src="${p.avatar}"><p>${p.username}</p><p class="${p.submitted ? 'status-done' : ''}">${p.submitted ? 'READY ✓' : 'Waiting...'}</p>`;
        submissionGrid.appendChild(div);
      });
    }

    beginPresentationsBtn.addEventListener('click', () => socket.emit('start_presentations'));

    socket.on('presentation_get_ready', ({ presenterName, slidemasterName }) => {
      hideHostScreens();
      countdownScreen.style.display = 'block';
      announcePresenter.innerText = `${presenterName.toUpperCase()}, YOU'RE PRESENTING!`;
      announceSlidemaster.innerText = `Slidemaster: ${slidemasterName}`;
    });

    socket.on('countdown_tick', (seconds) => {
      hostCountdown.innerText = seconds;
    });

    socket.on('slide_update', ({ slideIndex, totalSlides, content }) => {
      hideHostScreens();
      presentationStage.style.display = 'flex';

      slideCounter.innerText = `${slideIndex}/${totalSlides}`;
      slideContent.innerHTML = '';

      if (content.type === 'TOPIC') {
        slideContent.innerHTML = `<h2>${content.content}</h2>`;
      } else if (content.type === 'PHOTO') {
        slideContent.innerHTML = `<img src="${content.content}">`;
      } else if (content.type === 'TEXT') {
        slideContent.innerHTML = `<h2>${content.content}</h2>`;
      } else if (content.type === 'CONCLUSION') {
        slideContent.innerHTML = `<h2 style="color:#bb86fc;">CONCLUSION</h2><p>${content.content}</p>`;
      }
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
      rankingsList.innerHTML = '';

      sortedPlayers.forEach((player, index) => {
        const rank = index + 1;
        const div = document.createElement('div');
        div.className = `ranking-row ${rank <= 3 ? 'ranking-top-3' : ''}`;
        div.innerHTML = `
          <span><b style="font-size: 3rem;">#${rank}</b> ${player.username}</span>
          <span style="font-weight: bold;">${player.totalScore} pts</span>
        `;
        rankingsList.appendChild(div);
      });
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