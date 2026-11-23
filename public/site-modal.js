// Opens "How to Play" and "About" in a modal instead of leaving the page.
//
// The links are real links (<a href="/how-to-play/" data-modal="how-to-play">),
// so search engines, new-tab clicks and no-JS visitors still get the full pages.
// On a normal click we fetch that page, pull out its <main id="page-content">,
// and show it in a <dialog>. Leaving the page mid-game would disconnect the TV
// or the phone, so this also keeps games alive.
(function () {
  'use strict';

  var PAGES = {
    'how-to-play': '/how-to-play/',
    about: '/about/'
  };
  var cache = {};
  var dialog, titleEl, bodyEl, lastTrigger;

  function build() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.className = 'site-modal';
    dialog.setAttribute('aria-labelledby', 'site-modal-title');
    dialog.innerHTML =
      '<div class="site-modal__panel">' +
        '<div class="site-modal__header">' +
          '<h2 class="site-modal__title" id="site-modal-title"></h2>' +
          '<button type="button" class="site-modal__close" aria-label="Close">&times;</button>' +
        '</div>' +
        '<div class="site-modal__body" tabindex="-1"></div>' +
      '</div>';
    document.body.appendChild(dialog);
    titleEl = dialog.querySelector('.site-modal__title');
    bodyEl = dialog.querySelector('.site-modal__body');

    dialog.querySelector('.site-modal__close').addEventListener('click', close);
    // Clicking the dimmed backdrop (the dialog element itself, outside the panel) closes it.
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) close();
    });
    dialog.addEventListener('close', function () {
      if (/^#(how-to-play|about)$/.test(location.hash)) {
        history.replaceState(history.state && history.state.sdsModal ? null : history.state, '', location.pathname + location.search);
      }
      if (lastTrigger && document.contains(lastTrigger)) lastTrigger.focus();
    });
  }

  function load(name) {
    if (!cache[name]) {
      cache[name] = fetch(PAGES[name], { credentials: 'same-origin' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.text();
        })
        .then(function (html) {
          var doc = new DOMParser().parseFromString(html, 'text/html');
          var main = doc.getElementById('page-content');
          if (!main) throw new Error('No page content');
          var heading = main.querySelector('h1');
          var title = heading ? heading.textContent.trim() : '';
          if (heading) heading.remove();
          return { title: title, html: main.innerHTML };
        })
        .catch(function (err) {
          delete cache[name];
          throw err;
        });
    }
    return cache[name];
  }

  function open(name, options) {
    var push = !options || options.push !== false;
    build();
    titleEl.textContent = name === 'about' ? 'About' : 'How to Play';
    bodyEl.innerHTML = '<p class="site-modal__loading">Loading…</p>';
    if (!dialog.open) dialog.showModal();
    bodyEl.scrollTop = 0;
    if (push && !(history.state && history.state.sdsModal)) {
      history.pushState({ sdsModal: name }, '', '#' + name);
    } else if (push) {
      history.replaceState({ sdsModal: name }, '', '#' + name);
    }
    load(name).then(function (page) {
      if (!dialog.open) return;
      if (page.title) titleEl.textContent = page.title;
      bodyEl.innerHTML = page.html;
      bodyEl.focus({ preventScroll: true });
    }).catch(function () {
      // Couldn't load it here; fall back to the real page.
      window.location.href = PAGES[name];
    });
  }

  function close() {
    if (!dialog || !dialog.open) return;
    if (history.state && history.state.sdsModal) history.back(); // popstate closes it
    else dialog.close();
  }

  document.addEventListener('click', function (event) {
    var link = event.target.closest && event.target.closest('a[data-modal]');
    if (!link || !PAGES[link.dataset.modal]) return;
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (typeof HTMLDialogElement !== 'function') return; // very old browser: just follow the link
    event.preventDefault();
    lastTrigger = link;
    open(link.dataset.modal);
  });

  // Warm the cache when someone is about to click.
  ['pointerenter', 'focusin', 'touchstart'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      var link = event.target.closest && event.target.closest('a[data-modal]');
      if (link && PAGES[link.dataset.modal]) load(link.dataset.modal).catch(function () {});
    }, { passive: true, capture: true });
  });

  // The phone/browser Back button closes the modal instead of leaving the game.
  window.addEventListener('popstate', function (event) {
    var name = event.state && event.state.sdsModal;
    if (name && PAGES[name]) open(name, { push: false });
    else if (dialog && dialog.open) dialog.close();
  });

  // Shared links like slidedecksocial.com/#how-to-play open straight into the modal.
  var initial = location.hash.replace('#', '');
  if (PAGES[initial] && typeof HTMLDialogElement === 'function') {
    var openInitial = function () {
      history.replaceState(null, '', location.pathname + location.search);
      open(initial);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', openInitial);
    else openInitial();
  }

  window.SiteModal = { open: open, close: close };
})();
