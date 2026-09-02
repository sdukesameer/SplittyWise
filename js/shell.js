// ---------------------------------------------------------------------------
//  App shell — tabs, header, theme, Account tab, Activity feed
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const db = SW.db;

  // Per-view chrome. `tab` is which bottom tab stays lit; `chrome` false
  // means the view supplies its own header (detail pages do).
  // `tab` is which bottom tab stays lit, or null to leave whichever was lit
  // alone (an expense can be reached from either Friends or Groups).
  // `chrome` false means the view supplies its own header.
  const VIEWS = {
    friends:          { tab: 'friends',  action: 'Add friends',  summary: true,  chrome: true,  fab: true },
    groups:           { tab: 'groups',   action: 'Create group', summary: true,  chrome: true,  fab: true },
    activity:         { tab: 'activity', action: null,           summary: false, chrome: true,  fab: true },
    account:          { tab: 'account',  action: null,           summary: false, chrome: true,  fab: false },
    'friend-detail':  { tab: 'friends',  action: null,           summary: false, chrome: false, fab: true },
    'group-detail':   { tab: 'groups',   action: null,           summary: false, chrome: false, fab: true },
    'expense-detail': { tab: null,       action: null,           summary: false, chrome: false, fab: false },
    insights:         { tab: 'account',  action: null,           summary: false, chrome: false, fab: false },
    search:           { tab: null,       action: null,           summary: false, chrome: false, fab: false },
  };

  // Views register their renderer here; showView calls it on every entry.
  SW.viewHooks = {};

  let activeView = null;
  let activeParam = null;
  let activityLoaded = false;

  /* ======================= theme ====================================== */

  const THEME_KEY = 'splittywise.theme';

  function applyTheme(choice) {
    const root = document.documentElement;
    if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
    else root.removeAttribute('data-theme');

    document.querySelectorAll('[data-theme-choice]').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-theme-choice') === choice);
    });
  }

  function readTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch (e) {
      return 'system'; // private mode, or site data blocked
    }
  }

  document.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-theme-choice]');
    if (!btn) return;
    const choice = btn.getAttribute('data-theme-choice');
    try { localStorage.setItem(THEME_KEY, choice); } catch (err) { /* not fatal */ }
    applyTheme(choice);
  });

  /* ======================= views ====================================== */

  SW.showView = function (view, param) {
    if (!VIEWS[view]) view = 'friends';
    const cfg = VIEWS[view];

    document.querySelectorAll('[data-view]').forEach(function (el) {
      el.classList.toggle('is-active', el.getAttribute('data-view') === view);
    });
    if (cfg.tab) {
      document.querySelectorAll('.tab').forEach(function (t) {
        const on = t.getAttribute('data-tab') === cfg.tab;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-current', on ? 'page' : 'false');
      });
    }

    // Detail views bring their own header.
    document.getElementById('app-header').hidden = !cfg.chrome;

    const action = document.getElementById('header-action');
    action.hidden = !cfg.action;
    if (cfg.action) action.textContent = cfg.action;

    document.getElementById('summary').hidden = !cfg.summary;

    document.getElementById('fab').hidden = !cfg.fab;

    activeView = view;
    activeParam = param || null;
    window.scrollTo(0, 0);

    const hook = SW.viewHooks[view];
    if (hook) hook(param);
  };

  SW.activeView = function () { return activeView; };

  document.addEventListener('click', function (e) {
    const tab = e.target.closest('.tab');
    if (tab) SW.navigate(tab.getAttribute('data-tab'));
  });

  /* ======================= header ===================================== */

  // Lift the header onto a translucent bar once the list scrolls under it.
  window.addEventListener('scroll', function () {
    const h = document.getElementById('app-header');
    if (h) h.classList.toggle('is-stuck', window.scrollY > 6);
  }, { passive: true });

  document.getElementById('header-action').addEventListener('click', function () {
    if (activeView === 'groups') {
      if (SW.openCreateGroup) SW.openCreateGroup();
      return;
    }
    if (SW.addFriendSheet) SW.addFriendSheet();
  });

  document.getElementById('btn-search').addEventListener('click', function () {
    SW.navigate('search');
  });

  document.getElementById('btn-filter').addEventListener('click', function () {
    if (activeView === 'friends' && SW.friendFilterSheet) return SW.friendFilterSheet();
    SW.toast('Filters for this tab arrive with it');
  });

  document.getElementById('btn-bell').addEventListener('click', function () {
    SW.navigate('activity');
  });

  // Anything still stubbed says so plainly rather than silently doing nothing.
  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-todo]');
    if (el) SW.toast(el.getAttribute('data-todo'));
  });

  /* ======================= activity feed ============================== */

  function timeAgo(iso) {
    const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    if (days < 7) return days + 'd ago';
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  const TYPE_EMOJI = {
    friend_added: '👋',
    group_added: '🏠',
    expense_added: '🧾',
    settlement: '✅',
  };

  async function loadActivity(force) {
    if (SW.activityStale) { SW.activityStale = false; force = true; }
    if (activityLoaded && !force) return;

    const skel = document.getElementById('activity-skel');
    const list = document.getElementById('activity-list');
    const empty = document.getElementById('activity-empty');

    const { data, error } = await db
      .from('notifications')
      .select('id, type, title, body, is_read, created_at')
      .order('created_at', { ascending: false })
      .limit(60);

    skel.hidden = true;
    activityLoaded = true;

    if (error) {
      empty.hidden = true;
      list.innerHTML = '';
      SW.toast('Could not load activity: ' + error.message, 'error');
      return;
    }

    if (!data.length) {
      list.innerHTML = '';
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    list.innerHTML = data.map(function (n) {
      return '<div class="list-row" style="cursor:default">' +
        '<div class="avatar" style="background:var(--surface-2)">' +
          (TYPE_EMOJI[n.type] || '🔔') + '</div>' +
        '<div class="row-main">' +
          '<div class="row-title" style="font-size:15.5px;white-space:normal">' +
            escapeHtml(n.title) + '</div>' +
          '<div class="row-sub">' +
            (n.body ? escapeHtml(n.body) + ' · ' : '') + timeAgo(n.created_at) +
          '</div>' +
        '</div></div>';
    }).join('');

    // Opening the tab is the read receipt.
    const unread = data.filter(function (n) { return !n.is_read; });
    if (unread.length) {
      await db.rpc('mark_all_notifications_read');
      refreshUnread();
    }
  }

  async function refreshUnread() {
    const { count, error } = await db
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('is_read', false);

    if (error) return;

    const badge = document.getElementById('bell-badge');
    const tabDot = document.getElementById('tab-badge-activity');
    const n = count || 0;

    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('is-on', n > 0);
    tabDot.classList.toggle('is-on', n > 0);
  }

  /* ======================= account tab ================================ */

  function renderAccount() {
    const p = SW.profile || {};
    const name = p.full_name || '—';
    const email = p.email || (SW.user && SW.user.email) || '—';

    document.getElementById('profile-name').textContent = name;
    document.getElementById('profile-email').textContent = email;
    document.getElementById('profile-emoji').textContent = p.avatar_emoji || '🙂';
    document.getElementById('sub-name').textContent = name;
    document.getElementById('sub-email').textContent = email;
  }

  /* ---- edit name ---- */

  document.getElementById('row-name').addEventListener('click', function () {
    const current = (SW.profile && SW.profile.full_name) || '';
    SW.sheet({
      title: 'Your name',
      body:
        '<div class="field">' +
          '<label for="sheet-name">This is what friends see</label>' +
          '<input class="input" id="sheet-name" type="text" autocomplete="name" maxlength="60">' +
          '<div class="field-error" id="sheet-name-error"></div>' +
        '</div>',
      confirm: 'Save',
      onOpen: function () {
        const i = document.getElementById('sheet-name');
        i.value = current;
        i.focus();
        i.setSelectionRange(i.value.length, i.value.length);
      },
      onConfirm: async function (btn) {
        const input = document.getElementById('sheet-name');
        const value = input.value.trim();
        if (!value) {
          SW.setError('sheet-name-error', 'Your name cannot be empty.');
          return false;
        }

        SW.busy(btn, true);
        const { error } = await db
          .from('profiles')
          .update({ full_name: value, updated_at: new Date().toISOString() })
          .eq('id', SW.user.id);
        SW.busy(btn, false);

        if (error) {
          SW.setError('sheet-name-error', error.message);
          return false;
        }

        SW.profile.full_name = value;
        renderAccount();
        SW.toast('Name updated', 'ok');
        return true;
      },
    });
  });

  /* ---- pick avatar emoji ---- */

  const EMOJIS = (
    '🙂 😎 🤓 🥳 😄 🤩 🫠 🐱 🐶 🦊 🐼 🐨 🦁 🐯 🐸 🐧 🦉 🦄 🐙 🦋 ' +
    '🌻 🌵 🍀 🔥 ⭐️ 🌙 ⚡️ 🌈 🍕 🍔 🍜 🍣 ☕️ 🍩 🥑 🍉 ⚽️ 🏀 🎸 🎧 ' +
    '🎮 🚀 ✈️ 🏔 🏖 🎯 💎 👑 🧿 🪄'
  ).split(' ');

  function openEmojiPicker() {
    const current = (SW.profile && SW.profile.avatar_emoji) || '🙂';
    SW.sheet({
      title: 'Pick your avatar',
      rawBody:
        '<div class="emoji-grid" id="emoji-grid">' +
        EMOJIS.map(function (e) {
          return '<button type="button" data-emoji="' + e + '"' +
            (e === current ? ' class="is-on"' : '') + '>' + e + '</button>';
        }).join('') +
        '</div>',
      confirm: null,
      onOpen: function () {
        document.getElementById('emoji-grid').addEventListener('click', async function (ev) {
          const b = ev.target.closest('[data-emoji]');
          if (!b) return;
          const emoji = b.getAttribute('data-emoji');

          const { error } = await db
            .from('profiles')
            .update({ avatar_emoji: emoji, updated_at: new Date().toISOString() })
            .eq('id', SW.user.id);

          if (error) return SW.toast(error.message, 'error');

          SW.profile.avatar_emoji = emoji;
          renderAccount();
          SW.closeSheet();
          SW.toast('Avatar updated', 'ok');
        });
      },
    });
  }

  document.getElementById('row-emoji').addEventListener('click', openEmojiPicker);
  document.getElementById('profile-emoji').addEventListener('click', openEmojiPicker);

  /* ---- change password ---- */

  document.getElementById('row-password').addEventListener('click', function () {
    const email = (SW.profile && SW.profile.email) || (SW.user && SW.user.email);
    SW.sheet({
      title: 'Change password',
      rawBody:
        '<div class="sheet-body"><p style="color:var(--muted);font-size:14.5px">' +
        'We will email a link to <strong style="color:var(--text)">' + escapeHtml(email) +
        '</strong>. Open it and you can set a new password straight away.</p></div>',
      confirm: 'Send the link',
      onConfirm: async function (btn) {
        SW.busy(btn, true);
        const { error } = await db.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin + '/#/reset',
        });
        SW.busy(btn, false);

        if (error) { SW.toast(error.message, 'error'); return false; }
        SW.toast('Check your email — and your spam folder', 'ok');
        return true;
      },
    });
  });

  /* ---- log out ---- */

  document.getElementById('app-logout').addEventListener('click', async function () {
    SW.busy(this, true);
    const { error } = await db.auth.signOut();
    SW.busy(this, false);
    if (error) SW.toast(error.message, 'error');
    else if (SW.stopRealtime) SW.stopRealtime();
  });

  /* ======================= helpers ==================================== */

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  SW.escapeHtml = escapeHtml;

  /* ======================= signed-in hook ============================= */

  SW.viewHooks.activity = function () { loadActivity(); };
  SW.viewHooks.account = function () { renderAccount(); };

  SW.refreshUnread = refreshUnread;

  // The inline script in <head> already applied the theme; this syncs the
  // segmented control to match it.
  applyTheme(readTheme());

  SW.onSignedIn = async function () {
    renderAccount();
    refreshUnread();
    activityLoaded = false;
    if (activeView === 'activity') loadActivity(true);

    // The ledger drives Friends, Groups and the balance summary.
    if (SW.refreshLedger) await SW.refreshLedger();

    // Live updates, so a friend's expense lands without a refresh.
    if (SW.startRealtime) SW.startRealtime();
  };
})();
