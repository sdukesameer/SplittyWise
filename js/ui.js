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

  // A toast carrying one action, used for undo. The destructive work is
  // deferred until the toast expires, so undo cancels rather than reverses —
  // nothing has to be reconstructed, and no notifications get re-sent.
  SW.toastAction = function (message, actionLabel, onAction, onExpire, ms) {
    const host = document.getElementById('toast-host');
    if (!host) return;

    const el = document.createElement('div');
    el.className = 'toast';

    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = actionLabel;
    el.appendChild(btn);

    host.appendChild(el);

    let settled = false;
    function dismiss() {
      el.classList.add('is-out');
      setTimeout(function () { el.remove(); }, 220);
    }

    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      dismiss();
      if (onExpire) onExpire();
    }, ms || 5000);

    btn.addEventListener('click', function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dismiss();
      if (onAction) onAction();
    });
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

/* ==========================================================================
   Bottom sheet
   ========================================================================== */

(function () {
  let active = null;

  const scrim = document.getElementById('sheet-scrim');
  const titleEl = document.getElementById('sheet-title');
  const contentEl = document.getElementById('sheet-content');
  const actionsEl = document.getElementById('sheet-actions');

  // opts: { title, body, rawBody, confirm, cancel, onOpen, onConfirm, onClose }
  //   body     — markup wrapped in .sheet-body padding
  //   rawBody  — markup inserted as-is, for content that owns its own layout
  //   onConfirm(btn) — return false to keep the sheet open (e.g. on a
  //                    validation failure); anything else closes it
  //   onClose()      — fires however the sheet closes: confirmed, cancelled,
  //                    backdrop, or Escape. Used to return to a parent sheet.
  SW.sheet = function (opts) {
    active = opts;

    titleEl.textContent = opts.title || '';
    titleEl.hidden = !opts.title;

    contentEl.innerHTML = opts.rawBody
      ? opts.rawBody
      : (opts.body ? '<div class="sheet-body">' + opts.body + '</div>' : '');

    actionsEl.innerHTML = '';
    if (opts.confirm) {
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'btn btn-primary';
      ok.id = 'sheet-confirm';
      ok.innerHTML = '<span class="spinner"></span><span class="btn-label">' +
                     SW.escapeHtml(opts.confirm) + '</span>';
      ok.addEventListener('click', async function () {
        if (!active || !active.onConfirm) return SW.closeSheet();
        const keep = await active.onConfirm(ok);
        if (keep !== false) SW.closeSheet();
      });
      actionsEl.appendChild(ok);
    }

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-text';
    cancel.style.alignSelf = 'center';
    cancel.style.padding = '10px';
    cancel.textContent = opts.cancel || (opts.confirm ? 'Cancel' : 'Close');
    cancel.addEventListener('click', SW.closeSheet);
    actionsEl.appendChild(cancel);

    scrim.classList.add('is-open');
    document.body.style.overflow = 'hidden';

    if (opts.onOpen) opts.onOpen();

    // Enter submits a single-input sheet, which is what everyone expects.
    const input = contentEl.querySelector('input');
    if (input && opts.confirm) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          document.getElementById('sheet-confirm').click();
        }
      });
    }
  };

  SW.closeSheet = function () {
    const closing = active;
    scrim.classList.remove('is-open');
    document.body.style.overflow = '';
    contentEl.innerHTML = '';
    actionsEl.innerHTML = '';
    active = null;
    // Called last, and after `active` is cleared, so the handler is free to
    // open another sheet without it being torn down immediately.
    if (closing && closing.onClose) closing.onClose();
  };

  // Tapping the backdrop closes; tapping inside the sheet must not.
  scrim.addEventListener('click', function (e) {
    if (e.target === scrim) SW.closeSheet();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && scrim.classList.contains('is-open')) SW.closeSheet();
  });
})();

/* Fallback escaper: shell.js replaces this with its own, but the sheet code
   above may run first. */
SW.escapeHtml = SW.escapeHtml || function (str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};
