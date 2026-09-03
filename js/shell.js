// ---------------------------------------------------------------------------
//  App shell — tabs, header, theme, Account tab, Activity feed
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const db = SW.db;
  // Defined here rather than borrowed: shell.js loads before the modules
  // that set SW.escapeHtml, and a missing local is a ReferenceError that
  // kills the whole handler.
  const esc = function (str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

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
    'group-settings': { tab: 'groups',   action: null,           summary: false, chrome: false, fab: false },
    recurring:        { tab: 'account',  action: null,           summary: false, chrome: false, fab: false },
    categories:       { tab: 'account',  action: null,           summary: false, chrome: false, fab: false },
    trash:            { tab: 'account',  action: null,           summary: false, chrome: false, fab: false },
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

  /* ---- accent colour, and true black ---- */

  const ACCENT_KEY = 'splittywise.accent';
  const BLACK_KEY = 'splittywise.black';

  const ACCENTS = [
    { key: 'teal',   light: '#0E9878', dark: '#1FC69E' },
    { key: 'indigo', light: '#4F46E5', dark: '#8B93F8' },
    { key: 'rose',   light: '#C2185B', dark: '#F06292' },
    { key: 'amber',  light: '#B26A00', dark: '#F0A85C' },
    { key: 'violet', light: '#7C3AED', dark: '#A78BFA' },
    { key: 'sky',    light: '#0369A1', dark: '#4CB5E8' },
  ];

  function isDarkNow() {
    const stamped = document.documentElement.getAttribute('data-theme');
    if (stamped === 'dark') return true;
    if (stamped === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function readAccent() {
    try { return localStorage.getItem(ACCENT_KEY) || 'teal'; } catch (e) { return 'teal'; }
  }

  function applyAccent(key) {
    const found = ACCENTS.filter(function (a) { return a.key === key; })[0];
    const root = document.documentElement;

    // Only override when it is not the built-in accent, so the designed
    // palette is left exactly as it is by default.
    if (!found || key === 'teal') {
      root.style.removeProperty('--teal');
      root.style.removeProperty('--teal-press');
      root.style.removeProperty('--teal-soft');
    } else {
      // Each accent has a light and a dark variant, because one hex cannot
      // hold contrast on both grounds.
      const hex = isDarkNow() ? found.dark : found.light;
      root.style.setProperty('--teal', hex);
      root.style.setProperty('--teal-press', hex);
      root.style.setProperty('--teal-soft', hex + '22');
    }

    document.querySelectorAll('[data-accent]').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-accent') === (key || 'teal'));
    });
  }

  function renderAccentRow() {
    const row = document.getElementById('accent-row');
    if (!row) return;
    const dark = isDarkNow();
    row.innerHTML = ACCENTS.map(function (a) {
      return '<button type="button" class="swatch" data-accent="' + a.key +
        '" style="background:' + (dark ? a.dark : a.light) +
        '" aria-label="' + a.key + ' accent"></button>';
    }).join('');
    applyAccent(readAccent());
  }

  document.addEventListener('click', function (e) {
    const sw = e.target.closest('[data-accent]');
    if (!sw) return;
    const key = sw.getAttribute('data-accent');
    try { localStorage.setItem(ACCENT_KEY, key); } catch (err) { /* private mode */ }
    applyAccent(key);
  });

  document.getElementById('black-switch').addEventListener('click', function () {
    const on = !this.classList.contains('is-on');
    this.classList.toggle('is-on', on);
    this.setAttribute('aria-checked', String(on));
    if (on) document.documentElement.setAttribute('data-black', '1');
    else document.documentElement.removeAttribute('data-black');
    try { localStorage.setItem(BLACK_KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
    renderAccentRow();
  });

  document.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-theme-choice]');
    if (!btn) return;
    const choice = btn.getAttribute('data-theme-choice');
    try { localStorage.setItem(THEME_KEY, choice); } catch (err) { /* not fatal */ }
    applyTheme(choice);
    renderAccentRow();   // the accent has a light and a dark variant
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
  SW.activeParam = function () { return activeParam; };

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
    if (SW.focusSearch) SW.focusSearch();
  });

  document.getElementById('btn-filter').addEventListener('click', function () {
    if (activeView === 'groups' && SW.groupFilterSheet) return SW.groupFilterSheet();
    if (SW.friendFilterSheet) SW.friendFilterSheet();
  });

  document.getElementById('btn-bell').addEventListener('click', function () {
    SW.navigate('activity');
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
    group_created: '🏠',
    group_deleted: '🗑️',
    expense_added: '🧾',
    expense_updated: '✏️',
    expense_deleted: '🗑️',
    expense_restored: '♻️',
    settlement: '✅',
    settlement_undone: '↩️',
    settle_reminder: '📅',
    comment: '💬',
    nudge: '🔔',
    invite_accepted: '🤝',
  };

  // Your own actions arrive already read, so they show in Activity without
  // ever badging the bell. Switchable off for anyone who finds a record of
  // their own work noise.
  function showsOwn() {
    const prefs = (SW.profile && SW.profile.notify_prefs) || {};
    return prefs.own_actions !== false;
  }

  function visible(n) {
    if (!SW.notifyAllows(n.type)) return false;
    if (n.actor_id && SW.user && n.actor_id === SW.user.id && !showsOwn()) return false;
    return true;
  }

  async function loadActivity(force) {
    if (SW.activityStale) { SW.activityStale = false; force = true; }
    if (activityLoaded && !force) return;

    const skel = document.getElementById('activity-skel');
    const list = document.getElementById('activity-list');
    const empty = document.getElementById('activity-empty');

    const { data, error } = await db
      .from('notifications')
      .select('id, type, title, body, is_read, created_at, ' +
              'actor_id, group_id, expense_id')
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

    const shown = data.filter(visible);

    if (!shown.length) {
      list.innerHTML = '';
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    list.innerHTML = shown.map(function (n) {
      const target = activityTarget(n);
      const tag = target ? 'button' : 'div';
      return '<' + tag + ' class="list-row"' +
          (target ? ' data-goto="' + escapeHtml(target) + '"' : ' style="cursor:default"') + '>' +
        '<span class="avatar" style="background:var(--surface-2)">' +
          (TYPE_EMOJI[n.type] || '🔔') + '</span>' +
        '<span class="row-main">' +
          '<span class="row-title" style="font-size:15.5px;white-space:normal">' +
            escapeHtml(n.title) + '</span>' +
          '<span class="row-sub">' +
            (n.body ? escapeHtml(n.body) + ' · ' : '') + timeAgo(n.created_at) +
            (target ? ' · tap to open' : '') +
          '</span>' +
        '</span></' + tag + '>';
    }).join('');

    // Opening the tab is the read receipt.
    const unread = shown.filter(function (n) { return !n.is_read; });
    if (unread.length) {
      await db.rpc('mark_all_notifications_read');
      refreshUnread();
    }
  }

  async function refreshUnread() {
    // Counted by type rather than with head:true, because a muted type must
    // not contribute to the badge.
    const { data, error } = await db
      .from('notifications')
      .select('type, actor_id')
      .eq('is_read', false)
      .limit(500);

    if (error) return;

    const badge = document.getElementById('bell-badge');
    const tabDot = document.getElementById('tab-badge-activity');
    const n = (data || []).filter(visible).length;

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
    document.getElementById('sub-name').textContent = name;
    document.getElementById('sub-email').textContent = email;
    document.getElementById('sub-upi').textContent = p.upi_id
      ? p.upi_id
      : 'Let friends pay you in one tap';

    const thumb = document.getElementById('photo-thumb');
    const url = p.avatar_path && SW.avatarUrls[p.avatar_path];
    thumb.hidden = !url;
    if (url) thumb.src = url;
    document.getElementById('sub-photo').textContent = p.avatar_path
      ? 'Tap to change or remove it'
      : 'A face is easier to spot than a colour';

    // Show the photo in the header of the tab too, not just the emoji.
    const big = document.getElementById('profile-emoji');
    if (url) {
      big.innerHTML = '<img src="' + esc(url) + '" alt="" ' +
        'style="width:100%;height:100%;object-fit:cover;border-radius:50%">';
      big.style.padding = '0';
    } else {
      big.textContent = p.avatar_emoji || '🙂';
      big.style.padding = '';
    }
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

  /* ---- your photo ---- */

  const photoFile = document.getElementById('photo-file');

  document.getElementById('row-photo').addEventListener('click', function () {
    const p = SW.profile || {};
    if (!p.avatar_path) return photoFile.click();

    SW.sheet({
      title: 'Your photo',
      rawBody: '<div class="scan-state"><img class="avatar" ' +
        'style="width:110px;height:110px" src="' +
        esc(SW.avatarUrls[p.avatar_path] || '') + '" alt=""></div>',
      confirm: 'Choose another',
      destroy: 'Remove it',
      onConfirm: function () { SW.closeSheet(); photoFile.click(); return true; },
      onDestroy: async function (btn) {
        SW.busy(btn, true);
        await removePhoto(p.avatar_path);
        SW.busy(btn, false);
        return true;
      },
    });
  });

  photoFile.addEventListener('change', async function () {
    const file = photoFile.files && photoFile.files[0];
    photoFile.value = '';
    if (!file) return;

    SW.toast('Shrinking the photo…');
    let blob;
    try {
      // Squeezed under the cap here rather than refused: every photo off a
      // phone is far too big, so "too big" is useless advice.
      blob = await SW.prepareImage(file, { maxDim: 512, square: true });
    } catch (err) {
      return SW.toast(err.message || 'Could not read that image', 'error');
    }

    const path = SW.user.id + '/' + Date.now() + '.jpg';
    const up = await db.storage.from('avatars').upload(path, blob, {
      contentType: 'image/jpeg', upsert: false,
    });
    if (up.error) return SW.toast(up.error.message, 'error');

    const previous = SW.profile.avatar_path;
    const { error } = await db.from('profiles')
      .update({ avatar_path: path, updated_at: new Date().toISOString() })
      .eq('id', SW.user.id);
    if (error) return SW.toast(error.message, 'error');

    SW.profile.avatar_path = path;
    SW.avatarUrls[path] = null;
    const signed = await db.storage.from('avatars').createSignedUrl(path, 3600);
    if (signed.data) SW.avatarUrls[path] = signed.data.signedUrl;

    // The old one is dead weight the moment the new one lands.
    if (previous) db.storage.from('avatars').remove([previous]);

    renderAccount();
    if (SW.recompute) SW.recompute();
    SW.toast('Photo updated · ' + SW.readableSize(blob.size), 'ok');
  });

  async function removePhoto(path) {
    const { error } = await db.from('profiles')
      .update({ avatar_path: null, updated_at: new Date().toISOString() })
      .eq('id', SW.user.id);
    if (error) return SW.toast(error.message, 'error');
    if (path) db.storage.from('avatars').remove([path]);
    SW.profile.avatar_path = null;
    renderAccount();
    if (SW.recompute) SW.recompute();
    SW.toast('Photo removed', 'ok');
  }

  document.getElementById('row-upi').addEventListener('click', function () {
    const current = (SW.profile && SW.profile.upi_id) || '';
    SW.sheet({
      title: 'Your UPI ID',
      body:
        '<p style="color:var(--muted);font-size:14.5px">Friends settling up with ' +
          'you get a <strong style="color:var(--text)">Pay with UPI</strong> button ' +
          'that opens their payment app with the amount already filled.</p>' +
        '<div class="field" style="margin-top:12px">' +
          '<label for="upi-input">UPI ID</label>' +
          '<input class="input" id="upi-input" type="text" inputmode="email" ' +
                 'autocapitalize="off" autocomplete="off" spellcheck="false" ' +
                 'placeholder="yourname@okhdfcbank" value="' + esc(current) + '">' +
          '<span class="hint">Only people you split with can see it.</span>' +
          '<div class="field-error" id="upi-error"></div>' +
        '</div>',
      confirm: 'Save',
      destroy: current ? 'Remove it' : null,
      onDestroy: async function (btn) {
        SW.busy(btn, true);
        const { error } = await db.from('profiles')
          .update({ upi_id: null, updated_at: new Date().toISOString() })
          .eq('id', SW.user.id);
        SW.busy(btn, false);
        if (error) { SW.setError('upi-error', error.message); return false; }
        SW.profile.upi_id = null;
        renderAccount();
        SW.toast('UPI ID removed', 'ok');
        return true;
      },
      onOpen: function () { document.getElementById('upi-input').focus(); },
      onConfirm: async function (btn) {
        const value = document.getElementById('upi-input').value.trim();
        if (value && !SW.isUpiId(value)) {
          SW.setError('upi-error', 'That does not look like a UPI ID — try name@bank.');
          return false;
        }

        SW.busy(btn, true);
        const { error } = await db.from('profiles')
          .update({ upi_id: value || null, updated_at: new Date().toISOString() })
          .eq('id', SW.user.id);
        SW.busy(btn, false);
        if (error) { SW.setError('upi-error', error.message); return false; }

        SW.profile.upi_id = value || null;
        renderAccount();
        SW.toast(value ? 'UPI ID saved' : 'UPI ID removed', 'ok');
        return true;
      },
    });
  });

  document.getElementById('row-recurring').addEventListener('click', function () {
    SW.navigate('recurring');
  });

  document.getElementById('row-categories').addEventListener('click', function () {
    SW.navigate('categories');
  });

  document.getElementById('row-trash').addEventListener('click', function () {
    SW.navigate('trash');
  });

  const lockSwitch = document.getElementById('lock-switch');

  function syncLock() {
    const on = SW.lockEnabled && SW.lockEnabled();
    lockSwitch.classList.toggle('is-on', !!on);
    lockSwitch.setAttribute('aria-checked', String(!!on));
    lockSwitch.disabled = !SW.lockAvailable;
    document.getElementById('sub-lock').textContent = SW.lockAvailable
      ? (on ? 'Asked every time the app opens' : 'Asks every time the app opens')
      : 'Not available on this device or over plain http';
  }

  lockSwitch.addEventListener('click', async function () {
    if (!SW.lockAvailable) return;
    if (SW.lockEnabled()) SW.disableLock();
    else await SW.enableLock();
    syncLock();
  });

  /* ---- what reaches you, and what the form shows ---- */

  // The row is still written either way — it belongs in Activity — but the
  // bell and the feed respect this, which is what stops a badge that
  // everyone learns to ignore.
  const NOTIFY_KINDS = [
    { key: 'expense_added',   label: 'Expenses added' },
    { key: 'expense_updated', label: 'Expenses changed' },
    { key: 'expense_deleted', label: 'Expenses deleted' },
    { key: 'settlement',      label: 'Payments recorded' },
    { key: 'settlement_undone', label: 'Payments undone' },
    { key: 'comment',         label: 'Comments' },
    { key: 'nudge',           label: 'Reminders' },
    { key: 'friend_added',    label: 'New friends' },
    { key: 'group_added',     label: 'Being added to a group' },
    { key: 'settle_reminder', label: 'Monthly settle-up day' },
    { key: 'own_actions',     label: 'A record of your own actions' },
  ];

  const FORM_ROWS = [
    { key: 'note',     label: 'Note' },
    { key: 'repeat',   label: 'Repeats' },
    { key: 'category', label: 'Category' },
    { key: 'scan',     label: 'Scan a receipt' },
  ];

  SW.notifyAllows = function (type) {
    const prefs = (SW.profile && SW.profile.notify_prefs) || {};
    // Absent means on: a new event type should not be silently muted.
    return prefs[type] !== false;
  };

  SW.formShows = function (key) {
    const prefs = (SW.profile && SW.profile.ui_prefs) || {};
    return prefs['hide_' + key] !== true;
  };

  function renderPrefs() {
    document.getElementById('notify-prefs').innerHTML = NOTIFY_KINDS.map(function (k) {
      const on = SW.notifyAllows(k.key);
      return '<div class="switch-row">' +
        '<span class="grow"><span class="set-title">' + esc(k.label) + '</span></span>' +
        '<button type="button" class="switch' + (on ? ' is-on' : '') +
          '" data-notify="' + k.key + '" role="switch" aria-checked="' + on +
          '" aria-label="' + esc(k.label) + '"></button>' +
      '</div>';
    }).join('');

    renderEmailSwitch();

    document.getElementById('form-prefs').innerHTML = FORM_ROWS.map(function (k) {
      const on = SW.formShows(k.key);
      return '<div class="switch-row">' +
        '<span class="grow"><span class="set-title">' + esc(k.label) + '</span></span>' +
        '<button type="button" class="switch' + (on ? ' is-on' : '') +
          '" data-formrow="' + k.key + '" role="switch" aria-checked="' + on +
          '" aria-label="Show ' + esc(k.label) + '"></button>' +
      '</div>';
    }).join('');
  }

  async function savePrefs(column, value) {
    const patch = {};
    patch[column] = value;
    patch.updated_at = new Date().toISOString();
    const { error } = await db.from('profiles').update(patch).eq('id', SW.user.id);
    if (error) SW.toast(error.message, 'error');
  }

  function renderEmailSwitch() {
    const on = !!(SW.profile && SW.profile.email_notify);
    const sw = document.getElementById('email-switch');
    sw.classList.toggle('is-on', on);
    sw.setAttribute('aria-checked', String(on));
    document.getElementById('email-notify-sub').textContent = on
      ? 'At most one every 15 minutes, to ' + (SW.user ? SW.user.email : 'you')
      : 'Off — the bell and Activity still work';
  }

  document.getElementById('email-switch').addEventListener('click', async function () {
    const on = !this.classList.contains('is-on');
    SW.profile.email_notify = on;
    renderEmailSwitch();
    await savePrefs('email_notify', on);
    SW.toast(on ? 'Emails on' : 'Emails off', 'ok');
  });

  document.getElementById('notify-prefs').addEventListener('click', function (e) {
    const b = e.target.closest('[data-notify]');
    if (!b) return;
    const key = b.getAttribute('data-notify');
    const on = !b.classList.contains('is-on');
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', String(on));

    SW.profile.notify_prefs = Object.assign({}, SW.profile.notify_prefs || {});
    SW.profile.notify_prefs[key] = on;
    savePrefs('notify_prefs', SW.profile.notify_prefs);
    if (SW.refreshUnread) SW.refreshUnread();
  });

  document.getElementById('form-prefs').addEventListener('click', function (e) {
    const b = e.target.closest('[data-formrow]');
    if (!b) return;
    const key = b.getAttribute('data-formrow');
    const on = !b.classList.contains('is-on');
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', String(on));

    SW.profile.ui_prefs = Object.assign({}, SW.profile.ui_prefs || {});
    SW.profile.ui_prefs['hide_' + key] = !on;
    savePrefs('ui_prefs', SW.profile.ui_prefs);
  });

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
    if (error) return SW.toast(error.message, 'error');
    if (SW.stopRealtime) SW.stopRealtime();
    // Otherwise the next person to sign in on this phone sees these figures.
    if (SW.cache && SW.user) await SW.cache.clear(SW.user.id);
  });

  /* ======================= helpers ==================================== */

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  SW.escapeHtml = escapeHtml;

  /* ======================= signed-in hook ============================= */

  // Where a notification leads. Most specific first: the expense it is
  // about, else the group, else the person who did it.
  function activityTarget(n) {
    if (n.expense_id) return 'expense/' + n.expense_id;
    if (n.group_id) return 'group/' + n.group_id;
    if (n.actor_id && n.actor_id !== SW.user.id &&
        SW.ledger && SW.ledger.friendIds.indexOf(n.actor_id) > -1) {
      return 'friend/' + n.actor_id;
    }
    return null;
  }

  document.getElementById('activity-list').addEventListener('click', function (e) {
    const row = e.target.closest('[data-goto]');
    if (row) SW.navigate(row.getAttribute('data-goto'));
  });

  SW.viewHooks.activity = function () { loadActivity(); };
  SW.viewHooks.account = function () {
    renderAccount();
    renderPrefs();
    syncLock();
    // Covers the case where nothing has resolved it yet, and re-signs a URL
    // that has expired while the app sat open.
    if (SW.ensureAvatars) SW.ensureAvatars();
  };

  SW.refreshUnread = refreshUnread;

  // js/theme.js applied the theme and the true-black choice before first
  // paint; this syncs the controls to match.
  applyTheme(readTheme());
  renderAccentRow();

  (function syncBlack() {
    let on = false;
    try { on = localStorage.getItem(BLACK_KEY) === '1'; } catch (e) { /* ignore */ }
    const sw = document.getElementById('black-switch');
    if (sw) { sw.classList.toggle('is-on', on); sw.setAttribute('aria-checked', String(on)); }
  })();

  // Called by SW.ensureAvatars the moment a signed URL arrives, so a photo
  // resolved after its screen was drawn appears without a navigation.
  SW.repaintAvatars = function () {
    renderAccount();
    const view = SW.activeView();
    const hook = SW.viewHooks[view];
    if (hook && view !== 'account') hook(SW.activeParam());
  };

  SW.onSignedIn = async function () {
    renderAccount();
    refreshUnread();

    // Your own photo needs nothing but your profile, which is already
    // loaded — so it does not have to wait behind the cache read, the
    // invite redemption, the outbox flush and the ledger fetch.
    if (SW.ensureAvatars) SW.ensureAvatars();
    activityLoaded = false;
    if (activeView === 'activity') loadActivity(true);

    // Paint the last known balances immediately. Waiting on the network
    // meant every launch opened on an empty skeleton; this shows real
    // figures at once and corrects them a moment later.
    if (SW.cache && SW.recompute) {
      const cached = await SW.cache.load(SW.user.id);
      if (cached) {
        SW.ledger = cached;
        if (SW.bumpLedger) SW.bumpLedger();
        if (SW.outbox) await SW.outbox.applyPending();
        SW.recompute();
      }
    }

    // Redeem first, so a friend or group gained from an invite is already
    // there when the ledger loads.
    if (SW.redeemPendingInvite) await SW.redeemPendingInvite();

    // Anything queued while offline goes now, before the fetch, so the
    // ledger that comes back already includes it.
    if (SW.outbox) await SW.outbox.flush({ quiet: true });

    // The ledger drives Friends, Groups and the balance summary.
    if (SW.refreshLedger) await SW.refreshLedger();

    // Post any repeating expense that has come due. Doing it here means
    // recurring works with no scheduler configured at all — but once a day
    // is enough, so most launches skip the round trip entirely.
    try {
      const stampKey = 'splittywise.recurringChecked';
      const todayStamp = new Date().toISOString().slice(0, 10);
      let checked = null;
      try { checked = localStorage.getItem(stampKey); } catch (e) { /* ignore */ }
      if (checked === todayStamp) throw new Error('already checked today');
      try { localStorage.setItem(stampKey, todayStamp); } catch (e) { /* ignore */ }

      // Same daily window covers emptying the bin of anything past 30 days.
      db.rpc('purge_trash').then(function () {}, function () {});

      // Monthly settle-up reminders. Writes only to your own feed and
      // dedupes per calendar month, so this is safe to call every day.
      db.rpc('run_due_settle_reminders').then(function (r) {
        if (r && r.data > 0 && SW.refreshUnread) SW.refreshUnread();
      }, function () {});

      const { data } = await db.rpc('run_due_recurring');
      if (data && data.posted > 0) {
        SW.toast(data.posted === 1
          ? 'Added 1 repeating expense'
          : 'Added ' + data.posted + ' repeating expenses', 'ok');
        await SW.refreshLedger();
      }
    } catch (e) {
      // Offline, or the function is not deployed yet. Neither is fatal.
    }

    // Live updates, so a friend's expense lands without a refresh.
    if (SW.startRealtime) SW.startRealtime();
    if (SW.outbox) SW.outbox.render();
  };
})();
