// ---------------------------------------------------------------------------
//  Authentication — signup, login, logout, password reset
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const db = SW.db;

  // Set once, if this page load arrived from a recovery link. It suppresses
  // the normal "signed in, go to the app" jump so the user actually gets the
  // chance to type a new password.
  let recoveryMode = /type=recovery/.test(SW.initialHash || '');
  let lastSignupEmail = '';
  let booted = false;

  /* ======================= routing ==================================== */

  const AUTH_SCREENS = ['login', 'signup', 'verify', 'forgot', 'forgot-sent', 'reset'];
  const APP_VIEWS = ['friends', 'groups', 'activity', 'account'];
  const DEFAULT_VIEW = 'friends';

  SW.APP_VIEWS = APP_VIEWS;

  // One route namespace covers both worlds: an auth screen name, or an app
  // view name (which implies the 'app' screen).
  SW.navigate = function (route, opts) {
    const replace = opts && opts.replace;
    const target = '#/' + route;
    if (window.location.hash !== target) {
      if (replace) window.history.replaceState(null, '', target);
      else window.location.hash = target;
    }
    render(route);
  };

  function render(route) {
    if (APP_VIEWS.includes(route)) {
      SW.show('app');
      if (SW.showView) SW.showView(route);
    } else {
      SW.show(route);
    }
  }

  function routeFromHash() {
    const h = window.location.hash || '';
    // An auth callback hash is not a route.
    if (h.includes('access_token') || h.includes('error_description')) return null;
    const m = h.match(/^#\/([a-z-]+)/);
    return m ? m[1] : null;
  }

  window.addEventListener('hashchange', function () {
    const r = routeFromHash();
    if (!r) return;
    // Signed-in users have no business on the auth screens, and signed-out
    // users have no business in the app.
    if (SW.session && AUTH_SCREENS.includes(r) && !recoveryMode) {
      return SW.navigate(DEFAULT_VIEW, { replace: true });
    }
    if (!SW.session && APP_VIEWS.includes(r)) {
      return SW.navigate('login', { replace: true });
    }
    render(r);
  });

  /* ======================= error messages ============================= */

  // Supabase's messages are written for developers. These are written for
  // whoever is standing in a restaurant trying to log in.
  function humanize(error) {
    const raw = (error && error.message) || 'Something went wrong.';
    const m = raw.toLowerCase();

    if (m.includes('invalid login credentials'))
      return 'That email and password do not match.';
    if (m.includes('email not confirmed'))
      return 'Confirm your email first — open the link we sent you, and check spam.';
    if (m.includes('user already registered') || m.includes('already been registered'))
      return 'That email already has an account. Log in instead.';
    if (m.includes('new password should be different'))
      return 'That is your current password. Pick a different one.';
    if (m.includes('auth session missing') || m.includes('invalid claim'))
      return 'This reset link has expired. Request a fresh one.';
    if (m.includes('email rate limit') || m.includes('over_email_send_rate_limit'))
      return 'Too many emails sent just now. Wait a few minutes and try again.';
    if (m.includes('for security purposes'))
      return raw.replace(/^For security purposes, you can only request this after/i,
                         'Please wait').replace(/\.$/, ' before trying again.');
    if (m.includes('failed to fetch') || m.includes('networkerror'))
      return 'No connection. Check your internet and try again.';
    if (m.includes('password should be at least'))
      return 'Password must be at least ' + SW.MIN_PASSWORD + ' characters.';

    return raw;
  }

  /* ======================= profile ==================================== */

  async function loadProfile(user) {
    const { data, error } = await db
      .from('profiles')
      .select('full_name, email, avatar_emoji')
      .eq('id', user.id)
      .maybeSingle();

    if (error) {
      console.warn('Could not load profile:', error.message);
      return null;
    }
    return data;
  }

  async function renderApp() {
    const user = SW.session && SW.session.user;
    if (!user) return;

    const profile = await loadProfile(user);

    // A missing profile row means the signup trigger did not fire — surface
    // it now rather than as a mystery empty screen in phase 3.
    if (!profile) SW.toast('Your profile row is missing — re-run schema.sql', 'error');

    SW.profile = profile || {
      full_name: (user.email || '').split('@')[0],
      email: user.email,
      avatar_emoji: '🙂',
    };
    SW.user = user;

    if (SW.onSignedIn) SW.onSignedIn();
  }

  /* ======================= sign up ==================================== */

  document.getElementById('form-signup').addEventListener('submit', async function (e) {
    e.preventDefault();
    const form = e.target;
    const btn = document.getElementById('signup-submit');
    const nameEl = document.getElementById('signup-name');
    const emailEl = document.getElementById('signup-email');
    const pwEl = document.getElementById('signup-password');

    SW.clearInvalid(form);
    SW.setError('signup-error', '');

    const full_name = nameEl.value.trim();
    const email = emailEl.value.trim().toLowerCase();
    const password = pwEl.value;

    if (!full_name) {
      SW.markInvalid(nameEl, true);
      return SW.setError('signup-error', 'What should your friends call you?');
    }
    if (!SW.isEmail(email)) {
      SW.markInvalid(emailEl, true);
      return SW.setError('signup-error', 'That does not look like an email address.');
    }
    if (password.length < SW.MIN_PASSWORD) {
      SW.markInvalid(pwEl, true);
      return SW.setError('signup-error',
        'Password must be at least ' + SW.MIN_PASSWORD + ' characters.');
    }

    SW.busy(btn, true);
    const { data, error } = await db.auth.signUp({
      email: email,
      password: password,
      options: {
        data: { full_name: full_name },
        emailRedirectTo: window.location.origin + '/',
      },
    });
    SW.busy(btn, false);

    if (error) return SW.setError('signup-error', humanize(error));

    // Supabase returns a decoy user with no identities when the email is
    // already taken, so as not to leak which addresses exist.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      return SW.setError('signup-error',
        'That email already has an account. Log in, or reset your password.');
    }

    lastSignupEmail = email;

    if (data.session) {
      // Email confirmation is switched off in this project.
      SW.toast('Account created', 'ok');
      return; // onAuthStateChange takes it from here
    }

    document.getElementById('verify-email').textContent = email;
    pwEl.value = '';
    SW.navigate('verify');
  });

  /* ---- resend confirmation ---- */

  document.getElementById('verify-resend').addEventListener('click', async function () {
    const btn = this;
    if (!lastSignupEmail) return SW.navigate('signup');

    SW.busy(btn, true);
    const { error } = await db.auth.resend({ type: 'signup', email: lastSignupEmail });
    SW.busy(btn, false);

    if (error) return SW.toast(humanize(error), 'error');
    SW.toast('Confirmation link sent again', 'ok');
  });

  /* ======================= log in ===================================== */

  document.getElementById('form-login').addEventListener('submit', async function (e) {
    e.preventDefault();
    const form = e.target;
    const btn = document.getElementById('login-submit');
    const emailEl = document.getElementById('login-email');
    const pwEl = document.getElementById('login-password');

    SW.clearInvalid(form);
    SW.setError('login-error', '');

    const email = emailEl.value.trim().toLowerCase();
    const password = pwEl.value;

    if (!SW.isEmail(email)) {
      SW.markInvalid(emailEl, true);
      return SW.setError('login-error', 'Enter the email you signed up with.');
    }
    if (!password) {
      SW.markInvalid(pwEl, true);
      return SW.setError('login-error', 'Enter your password.');
    }

    SW.busy(btn, true);
    const { error } = await db.auth.signInWithPassword({ email: email, password: password });
    SW.busy(btn, false);

    if (error) {
      // Give them a way forward, not just a rejection.
      if (/email not confirmed/i.test(error.message)) {
        lastSignupEmail = email;
        document.getElementById('verify-email').textContent = email;
        SW.navigate('verify');
        return;
      }
      SW.markInvalid(pwEl, true);
      return SW.setError('login-error', humanize(error));
    }

    pwEl.value = '';
  });

  /* ======================= forgot password ============================ */

  document.getElementById('form-forgot').addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = document.getElementById('forgot-submit');
    const emailEl = document.getElementById('forgot-email');

    SW.clearInvalid(e.target);
    SW.setError('forgot-error', '');

    const email = emailEl.value.trim().toLowerCase();
    if (!SW.isEmail(email)) {
      SW.markInvalid(emailEl, true);
      return SW.setError('forgot-error', 'Enter the email you signed up with.');
    }

    SW.busy(btn, true);
    const { error } = await db.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + '/#/reset',
    });
    SW.busy(btn, false);

    if (error) return SW.setError('forgot-error', humanize(error));

    document.getElementById('forgot-sent-email').textContent = email;
    SW.navigate('forgot-sent');
  });

  /* ======================= set new password =========================== */

  document.getElementById('form-reset').addEventListener('submit', async function (e) {
    e.preventDefault();
    const btn = document.getElementById('reset-submit');
    const pwEl = document.getElementById('reset-password');
    const confirmEl = document.getElementById('reset-confirm');

    SW.clearInvalid(e.target);
    SW.setError('reset-error', '');

    const password = pwEl.value;

    if (password.length < SW.MIN_PASSWORD) {
      SW.markInvalid(pwEl, true);
      return SW.setError('reset-error',
        'Password must be at least ' + SW.MIN_PASSWORD + ' characters.');
    }
    if (password !== confirmEl.value) {
      SW.markInvalid(confirmEl, true);
      return SW.setError('reset-error', 'Those two passwords are different.');
    }

    SW.busy(btn, true);
    const { error } = await db.auth.updateUser({ password: password });
    SW.busy(btn, false);

    if (error) {
      const msg = humanize(error);
      SW.setError('reset-error', msg);
      // An expired link leaves no usable session, so send them back to ask
      // for a new one instead of stranding them on a dead form.
      if (/expired/.test(msg)) {
        setTimeout(function () {
          recoveryMode = false;
          SW.navigate('forgot');
        }, 2200);
      }
      return;
    }

    pwEl.value = '';
    confirmEl.value = '';
    recoveryMode = false;
    SW.toast('Password updated', 'ok');

    if (SW.session) SW.navigate(DEFAULT_VIEW, { replace: true });
    else SW.navigate('login', { replace: true });
  });

  /* ======================= session lifecycle ========================== */

  db.auth.onAuthStateChange(function (event, session) {
    SW.session = session;

    if (event === 'PASSWORD_RECOVERY') {
      recoveryMode = true;
      SW.navigate('reset', { replace: true });
      if (booted) SW.hideBoot();
      return;
    }

    if (event === 'SIGNED_OUT') {
      recoveryMode = false;
      SW.navigate('login', { replace: true });
      return;
    }

    if (session && !recoveryMode) {
      const r = routeFromHash();
      if (!r || AUTH_SCREENS.includes(r)) SW.navigate(DEFAULT_VIEW, { replace: true });
      renderApp();
    }
  });

  /* ======================= boot ======================================= */

  async function boot() {
    // A dead or already-used email link comes back as an error in the hash.
    const errMatch = (SW.initialHash || '').match(/error_description=([^&]+)/);
    if (errMatch) {
      const msg = decodeURIComponent(errMatch[1].replace(/\+/g, ' '));
      window.history.replaceState(null, '', window.location.pathname);
      SW.toast(/expired|invalid/i.test(msg)
        ? 'That link has expired. Request a new one.'
        : msg, 'error');
    }

    const { data } = await db.auth.getSession();
    SW.session = data.session;
    booted = true;

    if (recoveryMode) {
      SW.navigate('reset', { replace: true });
    } else if (SW.session) {
      const r = routeFromHash();
      SW.navigate(APP_VIEWS.includes(r) ? r : DEFAULT_VIEW, { replace: true });
      await renderApp();
    } else {
      const r = routeFromHash();
      SW.navigate(r && AUTH_SCREENS.includes(r) ? r : 'login', { replace: true });
    }

    SW.hideBoot();
  }

  // getSession() resolves on a microtask, which drains the moment this
  // script's top level ends — before shell.js has executed. Booting then
  // would find SW.showView and SW.onSignedIn still undefined and silently
  // skip both. DOMContentLoaded fires only after every script has run.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
