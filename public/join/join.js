const socket = io();
    const SESSION_KEY = 'slidedecksocial-session';
    const PHOTOS_REQUIRED = 6;
    const MAX_PHOTO_SIDE = 720; // px; plenty for a TV slide, small enough for mobile data

    let compressedPhotos = [];
    let photoQueue = Promise.resolve();

    // Slidemaster state. The photo/phrase pools arrive once per turn; afterwards
    // the server only tells us which slide is next.
    let photosPool = [];
    let textBlurbsPool = [];
    let carouselOrder = [];   // shuffled indexes into the current pool
    let currentIndex = 0;
    let currentType = '';
    let currentSlideIndex = 1;
    let conclusionIsDisplayed = false;
    let advancePending = false;
    let advanceTimer = null;

    let currentRating = 8;
    let appVersion = null;
    let autoJoinPending = false;

    function saveSession(roomCode, username, reconnectToken) {
      const sessionToken = reconnectToken || getSavedReconnectToken(roomCode, username);
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode, username, reconnectToken: sessionToken }));
      } catch (error) {}
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
      try { localStorage.removeItem(SESSION_KEY); } catch (error) {}
    }

    const $ = id => document.getElementById(id);

    const joinForm = $('join-form');
    const lobbyWaiting = $('lobby-waiting');
    const stepPhotos = $('step-photos');
    const stepTopics = $('step-topics');
    const submittedWaiting = $('submitted-waiting');
    const countdownScreen = $('countdown-screen');
    const presenterScreen = $('presenter-screen');
    const audienceScreen = $('audience-screen');
    const slidemasterScreen = $('slidemaster-screen');
    const ratingScreen = $('rating-screen');
    const feedbackScreen = $('feedback-screen');

    const roomCodeInput = $('room-code-input');
    const usernameInput = $('username-input');
    const joinBtn = $('join-btn');
    const errorMsg = $('error-msg');
    const photoInput = $('photo-input');
    const photoPreview = $('photo-preview');
    const photoStatus = $('photo-status');
    const uploadLabel = $('upload-label');
    const clearPhotosBtn = $('clear-photos-btn');
    const nextToTopicsBtn = $('next-to-topics-btn');
    const topic1Input = $('topic1');
    const topic2Input = $('topic2');
    const submitContentBtn = $('submit-content-btn');
    const submitError = $('submit-error');

    const countdownTimer = $('countdown-timer');
    const countdownRole = $('countdown-role');
    const presenterTopicDisplay = $('presenter-topic-display');
    const audiencePresenterName = $('audience-presenter-name');
    const smPresenterName = $('sm-presenter-name');
    const nextSlideNum = $('next-slide-num');
    const carouselView = $('carousel-view');
    const prevBtn = $('prev-btn');
    const nextBtn = $('next-btn');
    const advanceSlideBtn = $('advance-slide-btn');
    const leaveGameBtn = $('leave-game-btn');

    const ratingPresenterName = $('rating-presenter-name');
    const ratingValueDisplay = $('rating-value');
    const decrementRatingBtn = $('decrement-rating');
    const incrementRatingBtn = $('increment-rating');
    const commentInput = $('comment-input');
    const submitRatingBtn = $('submit-rating-btn');

    const myFinalScore = $('my-final-score');
    const myCommentsList = $('my-comments-list');

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = text;
      return node;
    }

    function showWaiting(title, subtitle) {
      hideAllScreens();
      submittedWaiting.style.display = 'block';
      $('waiting-title').innerText = title;
      $('waiting-subtitle').innerText = subtitle;
    }

    // A link like slidedecksocial.com/join?code=ABCD fills in the room code.
    const linkedCode = new URLSearchParams(location.search).get('code');
    if (linkedCode && /^[a-z]{4}$/i.test(linkedCode)) roomCodeInput.value = linkedCode.toUpperCase();

    roomCodeInput.addEventListener('input', () => {
      roomCodeInput.value = roomCodeInput.value.replace(/[^a-z]/gi, '').toUpperCase();
      if (roomCodeInput.value.length === 4 && !usernameInput.value) usernameInput.focus();
    });

    // A real <form>, so the phone keyboard's Go/Enter key joins too.
    joinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const roomCode = roomCodeInput.value.trim().toUpperCase();
      const username = usernameInput.value.trim();
      if (roomCode.length !== 4) {
        errorMsg.innerText = 'Enter the 4-letter room code shown on the TV.';
        roomCodeInput.focus();
        return;
      }
      if (!username) {
        errorMsg.innerText = 'Pick a name so everyone knows who you are.';
        usernameInput.focus();
        return;
      }
      errorMsg.innerText = '';
      autoJoinPending = false;
      joinBtn.disabled = true;
      setTimeout(() => { joinBtn.disabled = false; }, 3000);
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
      // A recovered connection is still in the game; the server re-syncs it.
      if (socket.recovered) return;
      const saved = loadSession();
      if (!saved || typeof saved.roomCode !== 'string' || typeof saved.username !== 'string' || !saved.roomCode || !saved.username) return;
      roomCodeInput.value = saved.roomCode;
      usernameInput.value = saved.username;
      autoJoinPending = true;
      socket.emit('join_room', {
        roomCode: saved.roomCode,
        username: saved.username,
        reconnectToken: saved.reconnectToken
      });
    });

    // A new server version was deployed (or the server restarted): reload to get
    // the matching page code. Any game in progress is gone at that point anyway.
    socket.on('app_version', (version) => {
      if (appVersion && appVersion !== version) window.location.reload();
      appVersion = version;
    });

    socket.on('joined_successfully', ({ roomCode, player, reconnectToken } = {}) => {
      if (roomCode && player && player.username) saveSession(roomCode, player.username, reconnectToken);
      autoJoinPending = false;
      joinBtn.disabled = false;
      errorMsg.innerText = '';
      leaveGameBtn.classList.add('is-visible');
      leaveGameBtn.disabled = false;
      hideAllScreens();
      lobbyWaiting.style.display = 'block';
    });

    function returnToJoinScreen(message) {
      clearSession();
      leaveGameBtn.classList.remove('is-visible');
      leaveGameBtn.disabled = false;
      joinBtn.disabled = false;
      hideAllScreens();
      joinForm.style.display = 'block';
      roomCodeInput.value = '';
      errorMsg.innerText = message;
    }

    socket.on('leave_game_confirmed', () => {
      returnToJoinScreen('You have left the game.');
    });

    socket.on('leave_game_failed', () => {
      leaveGameBtn.disabled = false;
      errorMsg.innerText = 'Could not leave the game. Please try again.';
    });

    socket.on('room_ended', ({ reason } = {}) => {
      const messages = {
        not_enough_players: 'The game ended because not enough players remained.',
        host_restart: 'The host started a new room. Enter the new code from the TV to keep playing!',
        host_left: 'The game ended because the host’s screen disconnected.'
      };
      returnToJoinScreen(messages[reason] || 'The host ended the game.');
    });

    // Show "Room not found", "Room is full", etc. under the JOIN button
    socket.on('error_message', (message) => {
      joinBtn.disabled = false;
      if (autoJoinPending) {
        // We tried to rejoin a saved game that no longer exists (or can't be
        // rejoined): go back to the join form instead of leaving a stale screen up.
        autoJoinPending = false;
        returnToJoinScreen(/not found|finished|left/i.test(message) ? 'Your last game has ended. Join a new one!' : message);
        if (linkedCode && /^[a-z]{4}$/i.test(linkedCode)) roomCodeInput.value = linkedCode.toUpperCase();
        return;
      }
      errorMsg.innerText = message;
    });

    // ---------- Step 1: photos ----------

    function resetSubmissionForm() {
      compressedPhotos = [];
      photoQueue = Promise.resolve();
      photoInput.value = '';
      renderPhotos();
      topic1Input.value = '';
      topic2Input.value = '';
      submitError.innerText = '';
      submitContentBtn.disabled = false;
      submitContentBtn.innerText = 'Submit Topics';
    }

    socket.on('start_submission_phase', () => {
      resetSubmissionForm();
      hideAllScreens();
      stepPhotos.style.display = 'block';
    });

    socket.on('submission_already_received', () => {
      showWaiting('Submissions Received!', 'Waiting for other players...');
    });

    function renderPhotos(message) {
      photoPreview.replaceChildren(...compressedPhotos.map((dataUrl, index) => {
        const box = el('div', 'photo-box');
        const img = el('img');
        img.src = dataUrl;
        img.alt = `Photo ${index + 1}`;
        const remove = el('button', 'photo-remove', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', `Remove photo ${index + 1}`);
        remove.addEventListener('click', () => {
          compressedPhotos.splice(index, 1);
          renderPhotos();
        });
        box.append(img, remove);
        return box;
      }));
      const count = compressedPhotos.length;
      const done = count >= PHOTOS_REQUIRED;
      photoStatus.innerText = message || (done
        ? 'All 6 photos added! Tap × on a photo to swap it out.'
        : `${count} / ${PHOTOS_REQUIRED} photos added${count ? ' – add ' + (PHOTOS_REQUIRED - count) + ' more' : ''}`);
      nextToTopicsBtn.style.display = done ? 'inline-block' : 'none';
      clearPhotosBtn.style.display = count ? 'inline-block' : 'none';
      uploadLabel.classList.toggle('is-disabled', done);
      photoInput.disabled = done;
      uploadLabel.firstChild.textContent = count ? 'Add More Photos ' : 'Add Photos ';
    }

    // Shrinks a photo to fit within MAX_PHOTO_SIDE and re-encodes it as JPEG.
    function compressPhoto(file) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          try {
            const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.7));
          } catch (err) {
            reject(err);
          } finally {
            URL.revokeObjectURL(url);
          }
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('unreadable'));
        };
        img.src = url;
      });
    }

    // Photos can be added in several batches. They're processed one at a time:
    // decoding six full-size camera photos at once can crash a phone's browser tab.
    photoInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []).filter(f => !f.type || f.type.startsWith('image/'));
      photoInput.value = '';
      const room = PHOTOS_REQUIRED - compressedPhotos.length;
      if (!files.length || room <= 0) return;
      const accepted = files.slice(0, room);
      const skipped = files.length - accepted.length;
      let failed = 0;
      photoStatus.innerText = `Processing ${accepted.length} photo${accepted.length === 1 ? '' : 's'}…`;

      photoQueue = photoQueue.then(async () => {
        for (const file of accepted) {
          if (compressedPhotos.length >= PHOTOS_REQUIRED) break;
          try {
            compressedPhotos.push(await compressPhoto(file));
          } catch (err) {
            failed++;
          }
        }
        const notes = [];
        if (failed) notes.push(`${failed} photo${failed === 1 ? '' : 's'} couldn't be opened – try a different one.`);
        if (skipped) notes.push(`Only the first ${accepted.length} were added (6 max).`);
        renderPhotos(notes.length ? `${compressedPhotos.length} / ${PHOTOS_REQUIRED} photos added. ${notes.join(' ')}` : undefined);
      });
    });

    clearPhotosBtn.addEventListener('click', () => {
      compressedPhotos = [];
      renderPhotos();
    });

    nextToTopicsBtn.addEventListener('click', () => {
      if (compressedPhotos.length < PHOTOS_REQUIRED) return;
      stepPhotos.style.display = 'none';
      stepTopics.style.display = 'block';
    });

    // ---------- Step 2: topics ----------

    submitContentBtn.addEventListener('click', () => {
      const t1 = topic1Input.value.trim();
      const t2 = topic2Input.value.trim();
      if (!t1 || !t2) {
        submitError.innerText = 'Write two topics.';
        return;
      }
      submitError.innerText = '';
      submitContentBtn.disabled = true;
      submitContentBtn.innerText = 'Uploading…';
      // Wait for the server to confirm, so a dropped upload doesn't leave this
      // phone stuck on "Submissions Received!" while the TV waits forever.
      socket.timeout(45000).emit('submit_player_content', { photos: compressedPhotos, topics: [t1, t2] }, (err, res) => {
        if (!err && res && res.ok) {
          showWaiting('Submissions Received!', 'Waiting for other players...');
          return;
        }
        submitContentBtn.disabled = false;
        submitContentBtn.innerText = 'Try Again';
        submitError.innerText = (res && res.error) || 'Upload failed. Check your connection and try again.';
      });
    });

    // ---------- Presentations ----------

    socket.on('presentation_get_ready', ({ presenterName, slidemasterName, countdown } = {}) => {
      hideAllScreens();
      countdownScreen.style.display = 'block';
      if (countdown !== undefined) countdownTimer.innerText = countdown;
      countdownRole.innerText = presenterName ? `${presenterName} is up next${slidemasterName ? `, with ${slidemasterName} on slides` : ''}.` : '';
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

    socket.on('role_slidemaster', (data = {}) => {
      hideAllScreens();
      slidemasterScreen.style.display = 'block';
      smPresenterName.innerText = data.presenterName || '';
      setupCarousel(data);
    });

    socket.on('update_slidemaster_remote', (data = {}) => {
      setupCarousel(data);
    });

    function shuffledIndexes(length) {
      const order = Array.from({ length }, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      return order;
    }

    function activePool() {
      return currentType === 'PHOTO' ? photosPool : textBlurbsPool;
    }

    function setAdvancePending(pending) {
      advancePending = pending;
      clearTimeout(advanceTimer);
      // The fix for "slides don't advance in the 2nd game": the button used to be
      // disabled after "Finish Presentation" and never turned back on, so a
      // player's next turn as slidemaster started with a dead button.
      advanceSlideBtn.disabled = pending;
      if (pending) {
        // If the server never answers (dropped connection), let them tap again.
        advanceTimer = setTimeout(() => setAdvancePending(false), 6000);
      }
    }

    function setupCarousel({ slideIndex, nextSlideIndex, nextSlideType, photosPool: photos, textBlurbsPool: blurbs }) {
      if (Array.isArray(photos)) photosPool = photos;
      if (Array.isArray(blurbs)) textBlurbsPool = blurbs;
      currentType = nextSlideType;
      currentSlideIndex = typeof slideIndex === 'number' ? slideIndex : (nextSlideIndex - 1);
      conclusionIsDisplayed = false;
      nextSlideNum.innerText = nextSlideIndex;
      setAdvancePending(false);

      if (nextSlideType === 'CONCLUSION') {
        carouselView.replaceChildren(el('p', 'carousel-note', 'Conclusion slide ready!'));
        advanceSlideBtn.innerText = 'Show Final Slide';
        carouselOrder = [];
        prevBtn.disabled = nextBtn.disabled = true;
        return;
      }

      advanceSlideBtn.innerText = 'Advance Slide >';
      carouselOrder = shuffledIndexes(activePool().length);
      currentIndex = 0;
      prevBtn.disabled = nextBtn.disabled = carouselOrder.length < 2;
      renderCarouselItem();
    }

    function renderCarouselItem() {
      if (!carouselOrder.length) {
        carouselView.replaceChildren(el('p', 'carousel-note', 'Nothing to choose – just advance!'));
        return;
      }
      const item = activePool()[carouselOrder[currentIndex]];
      if (currentType === 'PHOTO') {
        const img = el('img');
        img.src = item;
        img.alt = `Photo option ${currentIndex + 1} of ${carouselOrder.length}`;
        carouselView.replaceChildren(img);
      } else {
        carouselView.replaceChildren(el('p', 'carousel-text', `"${item}"`));
      }
    }

    prevBtn.addEventListener('click', () => {
      if (!carouselOrder.length) return;
      currentIndex = (currentIndex - 1 + carouselOrder.length) % carouselOrder.length;
      renderCarouselItem();
    });

    nextBtn.addEventListener('click', () => {
      if (!carouselOrder.length) return;
      currentIndex = (currentIndex + 1) % carouselOrder.length;
      renderCarouselItem();
    });

    // Swiping the preview left/right also flips through the options.
    let touchStartX = null;
    carouselView.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
    carouselView.addEventListener('touchend', e => {
      if (touchStartX === null) return;
      const dx = e.changedTouches[0].clientX - touchStartX;
      touchStartX = null;
      if (Math.abs(dx) > 40) (dx < 0 ? nextBtn : prevBtn).click();
    });

    advanceSlideBtn.addEventListener('click', () => {
      if (advancePending) return; // a double-tap used to skip a slide
      setAdvancePending(true);

      if (conclusionIsDisplayed) {
        socket.emit('finish_presentation');
        return;
      }

      const payload = { slideIndex: currentSlideIndex };
      if (currentType !== 'CONCLUSION' && carouselOrder.length > 0) payload.choice = carouselOrder[currentIndex];
      socket.emit('advance_slide', payload);
    });

    socket.on('conclusion_slide_displayed', ({ presenterName } = {}) => {
      hideAllScreens();
      slidemasterScreen.style.display = 'block';
      if (presenterName) smPresenterName.innerText = presenterName;
      currentType = 'CONCLUSION';
      currentIndex = 0;
      carouselOrder = [];
      conclusionIsDisplayed = true;
      prevBtn.disabled = nextBtn.disabled = true;
      carouselView.replaceChildren(el('p', 'carousel-note', 'Conclusion slide is on screen.'));
      setAdvancePending(false);
      advanceSlideBtn.innerText = 'Finish Presentation';
    });

    // ---------- Rating ----------

    socket.on('role_rating', ({ presenterName }) => {
      hideAllScreens();
      setAdvancePending(false);
      ratingScreen.style.display = 'block';
      ratingPresenterName.innerText = presenterName;
      currentRating = 8;
      ratingValueDisplay.innerText = currentRating;
      commentInput.value = '';
      submitRatingBtn.disabled = false;
    });

    socket.on('rating_already_received', () => {
      showWaiting('Rating Submitted!', 'Waiting for next round...');
    });

    socket.on('role_presenter_waiting_rating', () => {
      setAdvancePending(false);
      showWaiting('You Just Presented!', 'Waiting for players to rate you...');
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
      submitRatingBtn.disabled = true;
      const comment = commentInput.value.trim();
      socket.emit('submit_rating', { rating: currentRating, comment });
      showWaiting('Rating Submitted!', 'Waiting for next round...');
    });

    // Final Feedback Screen
    socket.on('show_personal_feedback', ({ comments = [], totalScore = 0 } = {}) => {
      hideAllScreens();
      feedbackScreen.style.display = 'block';
      myFinalScore.innerText = totalScore;

      if (comments.length === 0) {
        myCommentsList.replaceChildren(el('p', 'no-comments', 'No comments! Your friends plead the 5th.'));
        return;
      }

      myCommentsList.replaceChildren(...comments.map(c => {
        const card = el('div', 'comment-card');
        card.append(el('b', '', `${c.from}:`), document.createTextNode(` "${c.text}"`));
        return card;
      }));
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

    renderPhotos();
