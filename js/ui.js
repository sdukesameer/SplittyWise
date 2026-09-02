// ---------------------------------------------------------------------------
//  Screens, toasts, form plumbing
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  const SCREENS = ['login', 'signup', 'verify', 'forgot', 'forgot-sent', 'reset', 'app'];

  /* ---- screens --------------------------------------------------------- */

  SW.currentScreen = null;

  SW.show = function (name) {
    if (!SCREENS.includes(name)) name = 'login';
    SCREENS.forEach(function (s) {
      const el = document.querySelector('[data-screen="' + s + '"]');
      if (el) el.classList.toggle('is-active', s === name);
    });
    SW.currentScreen = name;
    window.scrollTo(0, 0);

    // Move focus to the screen's first real input so a keyboard or screen
    // reader user is not left behind on the previous screen.
    const focusTarget = document.querySelector(
      '[data-screen="' + name + '"] input:not([type=hidden])'
    );
    if (focusTarget && !SW.isTouch) focusTarget.focus();
  };

  SW.isTouch = window.matchMedia('(hover: none)').matches;

  SW.hideBoot = function () {
    const boot = document.getElementById('boot');
    if (!boot) return;
    boot.classList.add('is-hidden');
    setTimeout(function () { boot.remove(); }, 300);
  };

  /* ---- toasts ---------------------------------------------------------- */

  SW.toast = function (message, kind) {
    const host = document.getElementById('toast-host');
    if (!host) return;

    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' toast-' + kind : '');
    el.textContent = message;
    host.appendChild(el);

    const life = kind === 'error' ? 5200 : 3200;
    setTimeout(function () {
      el.classList.add('is-out');
      setTimeout(function () { el.remove(); }, 220);
    }, life);
  };

  /* ---- buttons --------------------------------------------------------- */

  SW.busy = function (btn, on) {
    if (!btn) return;
    btn.classList.toggle('is-loading', !!on);
    btn.disabled = !!on;
  };

  /* ---- field errors ---------------------------------------------------- */

  SW.setError = function (id, message) {
    const el = document.getElementById(id);
    if (el) el.textContent = message || '';
  };

  SW.markInvalid = function (input, invalid) {
    if (input) input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
  };

  SW.clearInvalid = function (form) {
    form.querySelectorAll('[aria-invalid="true"]').forEach(function (i) {
      i.setAttribute('aria-invalid', 'false');
    });
  };

  /* ---- validation ------------------------------------------------------ */

  // Deliberately loose. The authoritative check is the confirmation email
  // actually arriving; a strict regex only rejects valid addresses.
  SW.isEmail = function (v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v).trim());
  };

  SW.MIN_PASSWORD = 8;

  /* ---- global listeners ------------------------------------------------ */

  document.addEventListener('click', function (e) {
    // Screen switch links
    const go = e.target.closest('[data-go]');
    if (go) {
      e.preventDefault();
      SW.navigate(go.getAttribute('data-go'));
      return;
    }

    // Show / hide password
    const toggle = e.target.closest('[data-pw-toggle]');
    if (toggle) {
      e.preventDefault();
      const input = document.getElementById(toggle.getAttribute('data-pw-toggle'));
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      toggle.textContent = showing ? 'Show' : 'Hide';
      toggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    }
  });
})();
