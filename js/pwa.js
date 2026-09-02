// ---------------------------------------------------------------------------
//  Install to the home screen, and keeping the app up to date
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  /* ======================= service worker ============================ */

  // Only over https or on localhost; a service worker is rejected anywhere
  // else, and calling register would just throw.
  const canRegister = 'serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost');

  if (canRegister) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.warn('Service worker did not register:', err.message);
      });
    });
  }

  /* ======================= install prompts =========================== */

  const DISMISS_KEY = 'splittywise.installHidden';

  function dismissed() {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return false; }
  }
  function dismiss() {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch (e) { /* ignore */ }
  }

  const standalone = window.matchMedia('(display-mode: standalone)').matches ||
                     window.navigator.standalone === true;

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    // iPadOS 13+ reports itself as a Mac, but a Mac has no touch points.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const isSafari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(navigator.userAgent);

  let deferredPrompt = null;

  function banner(html, onAction) {
    if (document.getElementById('install-banner')) return;

    const el = document.createElement('div');
    el.id = 'install-banner';
    el.className = 'install-banner';
    el.innerHTML = html +
      '<button type="button" class="ib-close" aria-label="Dismiss">&times;</button>';
    document.body.appendChild(el);

    el.querySelector('.ib-close').addEventListener('click', function () {
      dismiss();
      el.remove();
    });

    const action = el.querySelector('.ib-action');
    if (action && onAction) action.addEventListener('click', function () { onAction(el); });
  }

  // Android and desktop Chrome fire this when the app is installable.
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (standalone || dismissed()) return;

    banner(
      '<span class="ib-icon">📲</span>' +
      '<span class="ib-text"><strong>Install SplittyWise</strong>' +
      '<span>Opens fullscreen from your home screen</span></span>' +
      '<button type="button" class="ib-action">Install</button>',
      async function (el) {
        el.remove();
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        deferredPrompt = null;
        if (choice.outcome === 'accepted') SW.toast('Installing…', 'ok');
        else dismiss();
      }
    );
  });

  window.addEventListener('appinstalled', function () {
    dismiss();
    const el = document.getElementById('install-banner');
    if (el) el.remove();
  });

  // iOS never fires beforeinstallprompt and has no install API at all, so
  // the only route is Share -> Add to Home Screen, and only in Safari.
  if (isIOS && isSafari && !standalone && !dismissed()) {
    window.addEventListener('load', function () {
      setTimeout(function () {
        banner(
          '<span class="ib-icon">📲</span>' +
          '<span class="ib-text"><strong>Add to your home screen</strong>' +
          '<span>Tap Share, then <em>Add to Home Screen</em></span></span>'
        );
      }, 2500);
    });
  }
})();
