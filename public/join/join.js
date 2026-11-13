const socket = io();
    const SESSION_KEY = 'slidedecksocial-session';
    let compressedPhotos = [];

    let currentPool = [];
    let currentIndex = 0;
    let currentType = '';
    let conclusionIsDisplayed = false;
    let currentRating = 0; // Default rating value

    function saveSession(roomCode, username, reconnectToken) {
      const sessionToken = reconnectToken || getSavedReconnectToken(roomCode, username);
      localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode, username, reconnectToken: sessionToken }));
    }

    function loadSession() {
      try {
        const raw = localStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (error) {
        return null;
      }
    }

    function getSavedReconnectToken(roomCode, username) {
      const session = loadSession();
      if (
        !session ||
        session.roomCode !== roomCode ||
        typeof session.username !== 'string' ||
        session.username.toLowerCase() !== username.toLowerCase()
      ) return null;
      return session.reconnectToken || null;
    }

    function clearSession() {
      localStorage.removeItem(SESSION_KEY);
    }

    const joinForm = document.getElementById('join-form');
    const lobbyWaiting = document.getElementById('lobby-waiting');
    const stepPhotos = document.getElementById('step-photos');
    const stepTopics = document.getElementById('step-topics');
    const submittedWaiting = document.getElementById('submitted-waiting');
    const countdownScreen = document.getElementById('countdown-screen');
    const presenterScreen = document.getElementById('presenter-screen');
    const audienceScreen = document.getElementById('audience-screen');
    const slidemasterScreen = document.getElementById('slidemaster-screen');
    const ratingScreen = document.getElementById('rating-screen');
    const feedbackScreen = document.getElementById('feedback-screen');

    const roomCodeInput = document.getElementById('room-code-input');
    const usernameInput = document.getElementById('username-input');
    const joinBtn = document.getElementById('join-btn');
    const joinEntryNav = document.getElementById('join-entry-nav');
    const photoInput = document.getElementById('photo-input');
    const photoPreview = document.getElementById('photo-preview');
    const nextToTopicsBtn = document.getElementById('next-to-topics-btn');
    const topic1Input = document.getElementById('topic1');
    const topic2Input = document.getElementById('topic2');
    const submitContentBtn = document.getElementById('submit-content-btn');

    const countdownTimer = document.getElementById('countdown-timer');
    const presenterTopicDisplay = document.getElementById('presenter-topic-display');
    const audiencePresenterName = document.getElementById('audience-presenter-name');
    const smPresenterName = document.getElementById('sm-presenter-name');
    const nextSlideNum = document.getElementById('next-slide-num');
    const nextSlideTypeLabel = document.getElementById('next-slide-type-label');
    const carouselView = document.getElementById('carousel-view');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const advanceSlideBtn = document.getElementById('advance-slide-btn');
    const leaveGameBtn = document.getElementById('leave-game-btn');

    const ratingPresenterName = document.getElementById('rating-presenter-name');
    const ratingValueDisplay = document.getElementById('rating-value');
    const decrementRatingBtn = document.getElementById('decrement-rating');
    const incrementRatingBtn = document.getElementById('increment-rating');
    const commentInput = document.getElementById('comment-input');
    const submitRatingBtn = document.getElementById('submit-rating-btn');

    const myFinalScore = document.getElementById('my-final-score');
    const myCommentsList = document.getElementById('my-comments-list');

    joinBtn.addEventListener('click', () => {
      const roomCode = roomCodeInput.value.trim().toUpperCase();
      const username = usernameInput.value.trim();
      if (!roomCode || !username) return;
      if (joinEntryNav) joinEntryNav.classList.add('is-hidden');
      const reconnectToken = getSavedReconnectToken(roomCode, username);
      saveSession(roomCode, username, reconnectToken);
      socket.emit('join_room', { roomCode, username, reconnectToken });
    });

    leaveGameBtn.addEventListener('click', () => {
      if (!window.confirm('Leave this game? Your future turns will be removed.')) return;
      leaveGameBtn.disabled = true;
      socket.emit('leave_game');
    });

    socket.on('connect', () => {
      const saved = loadSession();
      if (!saved || typeof saved.roomCode !== 'string' || typeof saved.username !== 'string' || !saved.roomCode || !saved.username) return;
      roomCodeInput.value = saved.roomCode;
      usernameInput.value = saved.username;
      socket.emit('join_room', {
        roomCode: saved.roomCode,
        username: saved.username,
        reconnectToken: saved.reconnectToken
      });
    });

    socket.on('joined_successfully', ({ roomCode, player, reconnectToken } = {}) => {
      if (roomCode && player && player.username) {
        saveSession(roomCode, player.username, reconnectToken);
      }
      leaveGameBtn.classList.add('is-visible');
      leaveGameBtn.disabled = false;
      joinForm.style.display = 'none';
      lobbyWaiting.style.display = 'block';
    });

    function returnToJoinScreen(message) {
      clearSession();
      leaveGameBtn.classList.remove('is-visible');
      leaveGameBtn.disabled = false;
      hideAllScreens();
      joinForm.style.display = 'block';
      roomCodeInput.value = '';
      document.getElementById('error-msg').innerText = message;
    }

    socket.on('leave_game_confirmed', () => {
      returnToJoinScreen('You have left the game.');
    });

    socket.on('leave_game_failed', () => {
      leaveGameBtn.disabled = false;
      document.getElementById('error-msg').innerText = 'Could not leave the game. Please try again.';
    });

    socket.on('room_ended', ({ reason } = {}) => {
      const message = reason === 'not_enough_players'
        ? 'The game ended because not enough players remained.'
        : 'The host ended the game.';
      returnToJoinScreen(message);
    });

    // Show "Room not found", "Room is full", etc. under the JOIN button
    socket.on('error_message', (message) => {
      document.getElementById('error-msg').innerText = message;
    });

    socket.on('start_submission_phase', () => {
      compressedPhotos = [];
      photoInput.value = '';
      photoPreview.innerHTML = '';
      nextToTopicsBtn.style.display = 'none';
      topic1Input.value = '';
      topic2Input.value = '';
      hideAllScreens();
      stepPhotos.style.display = 'block';
    });

    socket.on('submission_already_received', () => {
      hideAllScreens();
      submittedWaiting.style.display = 'block';
      document.getElementById('waiting-title').innerText = 'Submissions Received!';
      document.getElementById('waiting-subtitle').innerText = 'Waiting for other players...';
    });

    photoInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      if (files.length !== 6) {
        alert('Please select exactly 6 photos!');
        return;
      }
      
      compressedPhotos = [];
      photoPreview.innerHTML = '';
      
      let processedCount = 0;
      const tempArray = new Array(6);

      files.forEach((file, index) => {
        const reader = new FileReader();
        reader.onload = (event) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const MAX_WIDTH = 600;
            const scaleSize = MAX_WIDTH / img.width;
            canvas.width = MAX_WIDTH;
            canvas.height = img.height * scaleSize;
            
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
            
            // Store in the exact index slot to preserve order
            tempArray[index] = dataUrl;
            processedCount++;

            // Once all 6 are fully compressed, save them and render the grid
            if (processedCount === 6) {
              compressedPhotos = tempArray;
              compressedPhotos.forEach(dataUrl => {
                const box = document.createElement('div');
                box.className = 'photo-box';
                box.innerHTML = `<img src="${dataUrl}">`;
                photoPreview.appendChild(box);
              });
              nextToTopicsBtn.style.display = 'inline-block';
            }
          };
          img.src = event.target.result;
        };
        reader.readAsDataURL(file);
      });
    });

    nextToTopicsBtn.addEventListener('click', () => {
      stepPhotos.style.display = 'none';
      stepTopics.style.display = 'block';
    });

    submitContentBtn.addEventListener('click', () => {
      const t1 = topic1Input.value.trim();
      const t2 = topic2Input.value.trim();
      if (!t1 || !t2) return;
      socket.emit('submit_player_content', { photos: compressedPhotos, topics: [t1, t2] });
      stepTopics.style.display = 'none';
      submittedWaiting.style.display = 'block';
    });

    socket.on('presentation_get_ready', () => {
      hideAllScreens();
      countdownScreen.style.display = 'block';
    });

    socket.on('countdown_tick', (seconds) => {
      countdownTimer.innerText = seconds;
    });

    socket.on('role_presenter', ({ topic }) => {
      hideAllScreens();
      presenterScreen.style.display = 'block';
      presenterTopicDisplay.innerText = topic;
    });

    socket.on('role_audience', ({ presenterName }) => {
      hideAllScreens();
      audienceScreen.style.display = 'block';
      audiencePresenterName.innerText = presenterName;
    });

    socket.on('role_slidemaster', ({ presenterName, nextSlideIndex, nextSlideType, photosPool, textBlurbsPool }) => {
      hideAllScreens();
      slidemasterScreen.style.display = 'block';
      smPresenterName.innerText = presenterName;
      setupCarousel(nextSlideIndex, nextSlideType, photosPool, textBlurbsPool);
    });

    function setupCarousel(nextSlideIndex, nextSlideType, photosPool, textBlurbsPool) {
      currentType = nextSlideType;
      currentIndex = 0;
      conclusionIsDisplayed = false;
      nextSlideNum.innerText = nextSlideIndex;
      // nextSlideTypeLabel.innerText = (nextSlideType === 'PHOTO') ? 'PHOTO' : 'TEXT BLURB';

      if (nextSlideType === 'CONCLUSION') {
        carouselView.innerHTML = '<p style="color:#EBEBEB;">Conclusion slide ready!</p>';
        advanceSlideBtn.innerText = 'Show Final Slide';
        currentPool = [];
        return;
      }

      advanceSlideBtn.innerText = 'Advance Slide >';
      currentPool = shufflePool((nextSlideType === 'PHOTO') ? photosPool : textBlurbsPool);
      renderCarouselItem();
    }

    function shufflePool(pool = []) {
      const shuffledPool = [...pool];
      for (let index = shuffledPool.length - 1; index > 0; index--) {
        const randomIndex = Math.floor(Math.random() * (index + 1));
        [shuffledPool[index], shuffledPool[randomIndex]] = [shuffledPool[randomIndex], shuffledPool[index]];
      }
      return shuffledPool;
    }

    function renderCarouselItem() {
      carouselView.innerHTML = '';
      if (!currentPool || currentPool.length === 0) return;
      const item = currentPool[currentIndex];
      if (currentType === 'PHOTO') {
        carouselView.innerHTML = `<img src="${item}">`;
      } else {
        carouselView.innerHTML = `<p style="font-size:0.95rem; line-height: 1.3;">"${item}"</p>`;
      }
    }

    prevBtn.addEventListener('click', () => {
      if (!currentPool || currentPool.length === 0) return;
      currentIndex = (currentIndex - 1 + currentPool.length) % currentPool.length;
      renderCarouselItem();
    });

    nextBtn.addEventListener('click', () => {
      if (!currentPool || currentPool.length === 0) return;
      currentIndex = (currentIndex + 1) % currentPool.length;
      renderCarouselItem();
    });

    advanceSlideBtn.addEventListener('click', () => {
      if (conclusionIsDisplayed) {
        advanceSlideBtn.disabled = true;
        socket.emit('finish_presentation');
        return;
      }

      let selectedContent = null;
      if (currentType !== 'CONCLUSION' && currentPool.length > 0) {
        selectedContent = currentPool[currentIndex];
      }
      socket.emit('advance_slide', { selectedContent });
    });

    socket.on('update_slidemaster_remote', ({ nextSlideIndex, nextSlideType, photosPool, textBlurbsPool }) => {
      setupCarousel(nextSlideIndex, nextSlideType, photosPool, textBlurbsPool);
    });

    socket.on('conclusion_slide_displayed', ({ presenterName } = {}) => {
      hideAllScreens();
      slidemasterScreen.style.display = 'block';
      if (presenterName) smPresenterName.innerText = presenterName;
      currentType = 'CONCLUSION';
      currentIndex = 0;
      currentPool = [];
      conclusionIsDisplayed = true;
      carouselView.innerHTML = '<p style="color:#EBEBEB;">Conclusion slide is on screen.</p>';
      advanceSlideBtn.disabled = false;
      advanceSlideBtn.innerText = 'Finish Presentation';
    });

    // Transition to Rating View on Mobile
    socket.on('role_rating', ({ presenterName }) => {
      hideAllScreens();
      ratingScreen.style.display = 'block';
      ratingPresenterName.innerText = presenterName;
      currentRating = 8;
      ratingValueDisplay.innerText = currentRating;
      commentInput.value = '';
    });

    socket.on('role_presenter_waiting_rating', ({ presenterName }) => {
      hideAllScreens();
      submittedWaiting.style.display = 'block';
      document.getElementById('waiting-title').innerText = 'You Just Presented!';
      document.getElementById('waiting-subtitle').innerText = 'Waiting for players to rate you...';
    });

    decrementRatingBtn.addEventListener('click', () => {
      if (currentRating > 1) {
        currentRating--;
        ratingValueDisplay.innerText = currentRating;
      }
    });

    incrementRatingBtn.addEventListener('click', () => {
      if (currentRating < 10) {
        currentRating++;
        ratingValueDisplay.innerText = currentRating;
      }
    });

    submitRatingBtn.addEventListener('click', () => {
      const comment = commentInput.value.trim();
      socket.emit('submit_rating', { rating: currentRating, comment });
      hideAllScreens();
      submittedWaiting.style.display = 'block';
      document.getElementById('waiting-title').innerText = 'Rating Submitted!';
      document.getElementById('waiting-subtitle').innerText = 'Waiting for next round...';
    });

    // Final Feedback Screen
    socket.on('show_personal_feedback', ({ comments, totalScore }) => {
      hideAllScreens();
      feedbackScreen.style.display = 'block';
      myFinalScore.innerText = totalScore;
      myCommentsList.innerHTML = '';

      if (comments.length === 0) {
        myCommentsList.innerHTML = '<p style="color: #EBEBEB;">No comments! Your friends plead the 5th.</p>';
        return;
      }

      comments.forEach(c => {
        const div = document.createElement('div');
        div.className = 'comment-card';
        div.innerHTML = `<b>${c.from}:</b> "${c.text}"`;
        myCommentsList.appendChild(div);
      });
    });

    function hideAllScreens() {
      joinForm.style.display = 'none';
      lobbyWaiting.style.display = 'none';
      stepPhotos.style.display = 'none';
      stepTopics.style.display = 'none';
      submittedWaiting.style.display = 'none';
      countdownScreen.style.display = 'none';
      presenterScreen.style.display = 'none';
      audienceScreen.style.display = 'none';
      slidemasterScreen.style.display = 'none';
      ratingScreen.style.display = 'none';
      feedbackScreen.style.display = 'none';
    }

    socket.on('slidemaster_finished', () => {
      hideAllScreens();
      submittedWaiting.style.display = 'block';
      document.getElementById('waiting-title').innerText = 'Presentation Finished!';
      document.getElementById('waiting-subtitle').innerText = 'Get ready to rate!';
    });