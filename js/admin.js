// ---------------------------------------------------------------------------
//  SplittyWise admin console
//
//  A separate page from the app, deliberately: none of this ships in the
//  bundle every ordinary user downloads, and it can be reasoned about on its
//  own.
//
//  There is no admin password. You sign in with your own account, and
//  everything here works only if profiles.is_admin is true for it. That flag
//  cannot be set from a browser at all — a trigger refuses it — so the first
//  one is set by hand in SQL, once. README section 12.
//
//  Two kinds of operation:
//
//    Database reads and writes go straight to Postgres through the admin_*
//    functions, using your own token. They are security definer and each
//    checks is_admin on its first line, so nothing privileged is needed here.
//
//    Auth operations — blocking a login, creating an account, acting as
//    somebody — go through /.netlify/functions/admin, because they need the
//    service_role key, which must never reach a browser.
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  const cfg = window.SPLITTYWISE_CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    document.body.innerHTML =
      '<p style="padding:28px;font-family:sans-serif">js/config.js has no ' +
      'Supabase URL or anon key. See README section 3.</p>';
    return;
  }

  // The storageKey MUST match js/db.js. Both pages are the same origin, so
  // they share localStorage — but only if they agree on the key. Omitting it
  // here meant supabase-js fell back to its own default name, the console
  // could not see the session the app had already stored, and an admin who
  // was plainly signed in was asked to sign in again.
  //
  // detectSessionInUrl is false because auth email links all point at the
  // app, never here; flowType matches the app so a session written by one is
  // read the same way by the other.
  const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'implicit',
      storageKey: 'splittywise.auth',
    },
  });
  SW.db = db;

  const esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  SW.escapeHtml = esc;

  const $ = function (id) { return document.getElementById(id); };

  /* ======================= small shared bits ========================= */

  function toast(message, kind) {
    const host = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' is-' + kind : '');
    el.textContent = message;
    host.appendChild(el);
    setTimeout(function () { el.remove(); }, kind === 'error' ? 6000 : 3400);
  }
  SW.toast = toast;

  function busy(btn, on) {
    if (!btn) return;
    btn.disabled = !!on;
    btn.classList.toggle('is-busy', !!on);
    const spinner = btn.querySelector('.spinner');
    if (spinner) spinner.style.display = on ? 'inline-block' : 'none';
  }
  SW.busy = busy;

  function setError(id, message) {
    const el = $(id);
    if (el) { el.textContent = message || ''; el.hidden = !message; }
  }
  SW.setError = setError;

  function money(paise) {
    const n = (Number(paise) || 0) / 100;
    return '₹' + n.toLocaleString('en-IN', {
      minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2,
    });
  }

  function count(n) { return (Number(n) || 0).toLocaleString('en-IN'); }

  function ago(iso) {
    if (!iso) return 'never';
    const secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 60) return 'just now';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
    if (secs < 2592000) return Math.floor(secs / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString('en-IN',
      { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /* ======================= the sheet ================================= */
  //
  // A trimmed copy of the app's, rather than loading js/ui.js — that file
  // reaches for app-only elements. Same shape, so it looks the same.

  let sheetOpts = null;
  const scrim = $('sheet-scrim');
  let content = $('sheet-content');

  SW.sheet = function (opts) {
    sheetOpts = opts;
    $('sheet-title').textContent = opts.title || '';

    const fresh = document.createElement('div');
    fresh.id = 'sheet-content';
    content.parentNode.replaceChild(fresh, content);
    content = fresh;
    content.innerHTML = opts.body ? '<div class="sheet-body">' + opts.body + '</div>' : '';

    const actions = $('sheet-actions');
    actions.innerHTML = '';

    if (opts.confirm) {
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
      ok.innerHTML = '<span class="spinner"></span><span class="btn-label">' +
                     esc(opts.confirm) + '</span>';
      ok.addEventListener('click', async function () {
        if (!sheetOpts || !sheetOpts.onConfirm) return closeSheet();
        const keep = await sheetOpts.onConfirm(ok);
        if (keep !== false) closeSheet();
      });
      actions.appendChild(ok);
    }

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-text';
    cancel.style.alignSelf = 'center';
    cancel.style.padding = '10px';
    cancel.textContent = opts.cancel || (opts.confirm ? 'Cancel' : 'Close');
    cancel.addEventListener('click', closeSheet);
    actions.appendChild(cancel);

    scrim.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    if (opts.onOpen) opts.onOpen();
  };

  function closeSheet() {
    scrim.classList.remove('is-open');
    document.body.style.overflow = '';
    sheetOpts = null;
  }
  SW.closeSheet = closeSheet;

  scrim.addEventListener('click', function (e) { if (e.target === scrim) closeSheet(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && scrim.classList.contains('is-open')) closeSheet();
  });

  /* ======================= calling the two APIs ====================== */

  // The database, as me. Errors from these are the admin_* functions
  // refusing, which is worth showing verbatim.
  async function rpc(name, args) {
    const { data, error } = await db.rpc(name, args || {});
    if (error) throw new Error(error.message);
    return data;
  }

  // The auth operations, through the function that holds service_role.
  async function api(action, payload) {
    const { data: sess } = await db.auth.getSession();
    const token = sess && sess.session && sess.session.access_token;
    if (!token) throw new Error('Your session has expired — sign in again.');

    const res = await fetch('/.netlify/functions/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    });

    let body = {};
    try { body = await res.json(); } catch (e) { /* empty body */ }

    if (!res.ok) {
      if (res.status === 501) {
        // The function names the variables that are actually missing. The
        // page used to assert one specific name, which was wrong whenever a
        // different one was the problem.
        throw new Error(body.error ||
          'This deploy is not configured for admin actions — README 12.3.');
      }
      if (res.status === 404) {
        throw new Error('The admin function is not deployed. It needs a ' +
          'Netlify deploy; it does not exist on a plain static server.');
      }
      throw new Error(body.error || ('That failed (' + res.status + ')'));
    }
    return body;
  }

  /* ======================= signing in ================================ */

  $('ad-login').addEventListener('submit', async function (e) {
    e.preventDefault();
    setError('ad-login-error', '');
    const btn = $('ad-login-btn');
    busy(btn, true);

    const { error } = await db.auth.signInWithPassword({
      email: $('ad-email').value.trim().toLowerCase(),
      password: $('ad-password').value,
    });
    busy(btn, false);

    if (error) {
      return setError('ad-login-error',
        /invalid login/i.test(error.message)
          ? 'That email and password do not match.'
          : error.message);
    }
    await afterSignIn();
  });

  $('ad-signout').addEventListener('click', async function () {
    await db.auth.signOut();
    location.reload();
  });

  // On the gate, for somebody signed in as a non-admin who wants to try
  // another account. The only place this page signs anyone out unasked.
  $('ad-use-other').addEventListener('click', async function () {
    await db.auth.signOut();
    location.reload();
  });

  // Three states, not two: checking, signed in, or a form. Showing the form
  // while the session is still being read makes an already-signed-in admin
  // think they have been logged out.
  function show(which) {
    $('ad-boot').hidden = which !== 'boot';
    $('ad-gate').hidden = which !== 'gate';
    $('ad-app').hidden = which !== 'app';
  }

  async function afterSignIn() {
    const { data } = await db.auth.getUser();
    const user = data && data.user;
    if (!user) return show('gate');

    // admin_stats() refuses a non-admin, which is the check — there is no
    // separate "am I allowed" call that could get out of step with it.
    let stats;
    try {
      stats = await rpc('admin_stats');
    } catch (err) {
      // Deliberately NOT signOut(). This page shares its session storage
      // with the app, so signing out here would sign the person out of
      // SplittyWise itself — for the crime of opening a URL. Explain
      // instead, and let them choose.
      show('gate');
      $('ad-signed-as').hidden = false;
      $('ad-signed-as-email').textContent = user.email || 'this account';
      return setError('ad-login-error',
        /administrator/i.test(err.message)
          ? 'That account is not an administrator.'
          : err.message);
    }

    show('app');
    $('ad-who').textContent = user.email || '';

    paintStats(stats);
    loadUsers();
    loadAccess(stats);
    loadErrors();
    loadTrail();
  }

  /* ======================= tabs ====================================== */

  $('ad-tabs').addEventListener('click', function (e) {
    const tab = e.target.closest('[data-adpane]');
    if (!tab) return;
    const name = tab.getAttribute('data-adpane');
    document.querySelectorAll('.ad-tab').forEach(function (t) {
      t.classList.toggle('is-on', t === tab);
    });
    document.querySelectorAll('.ad-pane').forEach(function (p) {
      p.classList.toggle('is-on', p.getAttribute('data-adpane') === name);
    });
  });

  /* ======================= overview ================================== */

  function paintStats(s) {
    // Eight, so the grid fills evenly at both two and four columns rather
    // than leaving one tile stranded on its own row.
    const access = !s.signups_enabled ? 'Closed'
                 : (s.invite_only ? 'Invite only' : 'Open');

    const tiles = [
      { k: 'People', v: count(s.users),
        n: count(s.admins) + (s.admins === 1 ? ' admin' : ' admins') },
      { k: 'Active this week', v: count(s.active_7d),
        n: count(s.active_30d) + ' this month' },
      { k: 'Expenses', v: count(s.expenses),
        n: count(s.expenses_binned) + ' in bins' },
      { k: 'Total recorded', v: money(s.volume_paise),
        n: 'across ' + count(s.expenses) + ' expenses' },
      { k: 'Groups', v: count(s.groups),
        n: count(s.groups_reminding) + ' with a settle-up day' },
      { k: 'Payments', v: count(s.settlements),
        n: money(s.settled_paise) + ' settled' },
      { k: 'Failures today', v: count(s.errors_24h),
        n: count(s.errors_total) + ' ever', warn: s.errors_24h > 0 },
      // Answers "can anyone sign up right now?", which is the actual
      // question — a bare "Blocked: 0" answered nothing.
      { k: 'New accounts', v: access,
        n: count(s.banned) + ' blocked', warn: access !== 'Open' },
    ];

    $('ad-stats').innerHTML = tiles.map(function (t) {
      return '<div class="ad-stat' + (t.warn ? ' is-warn' : '') + '">' +
        '<span class="k">' + esc(t.k) + '</span>' +
        '<span class="v">' + esc(t.v) + '</span>' +
        '<span class="n">' + esc(t.n) + '</span></div>';
    }).join('');

    drawChart(s.series || []);
  }

  // Hand-drawn SVG, like the app's charts: no library, and it stays legible
  // in both themes because every colour comes from a token.
  function drawChart(series) {
    const host = $('ad-chart');
    if (!series.length) { host.innerHTML = '<div class="ad-empty">No history yet.</div>'; return; }

    const W = 720, H = 190, PAD_L = 34, PAD_R = 10, PAD_T = 12, PAD_B = 26;
    const inner = W - PAD_L - PAD_R;
    const step = inner / series.length;
    const peak = Math.max(1,
      ...series.map(function (d) { return Math.max(d.signups, d.expenses, d.errors); }));

    // A tick every whole number up to 4, then round steps.
    const ticks = peak <= 4 ? peak : 4;
    const y = function (v) { return PAD_T + (H - PAD_T - PAD_B) * (1 - v / peak); };

    let svg = '<svg class="ad-chart" viewBox="0 0 ' + W + ' ' + H +
              '" role="img" aria-label="Signups, expenses and failures over 30 days">';

    for (let i = 0; i <= ticks; i++) {
      const v = Math.round(peak * i / ticks);
      svg += '<line x1="' + PAD_L + '" x2="' + (W - PAD_R) + '" y1="' + y(v) +
             '" y2="' + y(v) + '" stroke="var(--line)" stroke-width="1"/>' +
             '<text x="' + (PAD_L - 6) + '" y="' + (y(v) + 4) +
             '" text-anchor="end" font-size="10" fill="var(--faint)">' + v + '</text>';
    }

    const bar = Math.max(2, step * 0.26);
    const SERIES = [
      ['expenses', 'var(--teal)', 'Expenses'],
      ['signups', '#7C9CF5', 'Signups'],
      ['errors', 'var(--owe)', 'Failures'],
    ];

    series.forEach(function (d, i) {
      const x = PAD_L + step * i + (step - bar * 3) / 2;
      SERIES.forEach(function (pair, j) {
        const v = d[pair[0]] || 0;
        if (!v) return;
        const top = y(v);
        svg += '<rect x="' + (x + bar * j) + '" y="' + top + '" width="' + bar +
               '" height="' + Math.max(1, H - PAD_B - top) + '" rx="1.5" fill="' +
               pair[1] + '"/>';
      });
    });

    // Thirty days by three series and no value labels: without this there is
    // no way to read a figure off it at all. One hit area per day, the full
    // height of the plot, so there is no aiming at a two-pixel bar.
    const tips = series.map(function (d) {
      const when = new Date(d.day).toLocaleDateString('en-IN',
        { weekday: 'short', day: 'numeric', month: 'short' });
      return {
        title: when,
        rows: SERIES.map(function (pair) {
          return { color: pair[1], name: pair[2], value: count(d[pair[0]] || 0) };
        }),
      };
    });

    series.forEach(function (d, i) {
      svg += SW.chartHit(i, PAD_L + step * i, PAD_T, step, H - PAD_B - PAD_T,
        tips[i].title + ': ' + tips[i].rows.map(function (r) {
          return r.value + ' ' + r.name.toLowerCase();
        }).join(', '));
    });

    // A label every seventh day, plus the last — but only if the last is far
    // enough from the one before it. Thirty days means day 28 and day 29 land
    // side by side, and the two labels print on top of each other.
    const labelAt = [];
    for (let i = 0; i < series.length; i += 7) labelAt.push(i);
    const last = series.length - 1;
    if (last - labelAt[labelAt.length - 1] >= 4) labelAt.push(last);

    labelAt.forEach(function (i) {
      const day = new Date(series[i].day);
      svg += '<text x="' + (PAD_L + step * i + step / 2) + '" y="' + (H - 8) +
             '" text-anchor="middle" font-size="10" fill="var(--faint)">' +
             day.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) +
             '</text>';
    });

    svg += '</svg>' +
      '<div class="ad-legend">' +
        '<span><i style="background:var(--teal)"></i>Expenses</span>' +
        '<span><i style="background:#7C9CF5"></i>Signups</span>' +
        '<span><i style="background:var(--owe)"></i>Failures</span>' +
        '<span style="color:var(--faint)">Hover or tap a day for its figures</span>' +
      '</div>';

    host.innerHTML = svg;
    SW.attachChartHover(host, tips);
  }

  async function refreshStats() {
    try { paintStats(await rpc('admin_stats')); } catch (e) { toast(e.message, 'error'); }
  }

  /* ======================= people ==================================== */

  let searchTimer = null;
  $('ad-user-search').addEventListener('input', function () {
    clearTimeout(searchTimer);
    const term = this.value;
    searchTimer = setTimeout(function () { loadUsers(term); }, 220);
  });

  async function loadUsers(term) {
    const host = $('ad-users');
    host.innerHTML = '<div class="ad-empty">Loading…</div>';
    let rows;
    try {
      rows = await rpc('admin_users', { p_search: term || null, p_limit: 100, p_offset: 0 });
    } catch (err) {
      host.innerHTML = '<div class="ad-empty">' + esc(err.message) + '</div>';
      return;
    }

    if (!rows.length) { host.innerHTML = '<div class="ad-empty">Nobody matches.</div>'; return; }

    host.innerHTML = rows.map(function (u) {
      return '<div class="ad-item">' +
        '<span class="ad-item-main">' +
          '<span class="ad-item-title">' + esc(u.full_name || '—') +
            (u.is_admin ? ' <span class="ad-pill is-admin">admin</span>' : '') +
            (u.banned ? ' <span class="ad-pill is-banned">blocked</span>' : '') +
          '</span>' +
          '<span class="ad-item-sub">' + esc(u.email) + ' · ' +
            count(u.expenses) + ' expenses · ' + count(u.groups) + ' groups · ' +
            'joined ' + ago(u.created_at) + ' · last wrote ' + ago(u.last_write) +
          '</span>' +
        '</span>' +
        '<span class="ad-item-actions">' +
          '<button class="ad-mini" data-open="' + esc(u.id) + '">Open</button>' +
        '</span></div>';
    }).join('');
  }

  $('ad-users').addEventListener('click', function (e) {
    const b = e.target.closest('[data-open]');
    if (b) openPerson(b.getAttribute('data-open'));
  });

  async function openPerson(id) {
    let d;
    try { d = await rpc('admin_user_detail', { p_user: id }); }
    catch (err) { return toast(err.message, 'error'); }

    const p = d.profile || {};
    const live = (d.expenses || []).filter(function (e) { return !e.deleted_at; });

    SW.sheet({
      title: p.full_name || p.email || 'Person',
      body:
        '<div class="ad-item"><span class="ad-item-main">' +
          '<span class="ad-item-title">' + esc(p.email) + '</span>' +
          '<span class="ad-item-sub">Joined ' + ago(p.created_at) +
            ' · ' + count(live.length) + ' live expenses · ' +
            count((d.groups || []).length) + ' groups · ' +
            count((d.friends || []).length) + ' friends' +
            (p.upi_id ? ' · UPI ' + esc(p.upi_id) : '') +
          '</span></span></div>' +

        ((d.errors || []).length
          ? '<div class="ad-warn">' + count(d.errors.length) +
            ' failure' + (d.errors.length === 1 ? '' : 's') + ' reported by them. ' +
            'Most recent: ' + esc(d.errors[0].message) + '</div>'
          : '') +

        '<div class="ad-sub">Groups<span class="n">' +
          count((d.groups || []).length) + '</span></div>' +
        ((d.groups || []).length
          ? d.groups.map(function (g) {
              return '<div class="ad-item"><span class="ad-item-main">' +
                '<span class="ad-item-title">' + esc(g.emoji) + ' ' + esc(g.name) + '</span>' +
                '<span class="ad-item-sub">' + count(g.members) + ' members</span></span>' +
                '<span class="ad-item-actions">' +
                  '<button class="ad-mini is-danger" data-delgroup="' + esc(g.id) +
                  '" data-name="' + esc(g.name) + '">Delete</button>' +
                '</span></div>';
            }).join('')
          : '<div class="ad-empty">None.</div>') +

        '<div class="ad-sub">Expenses<span class="n">' +
          count((d.expenses || []).length) + '</span></div>' +
        ((d.expenses || []).length
          ? d.expenses.slice(0, 40).map(function (e) {
              return '<div class="ad-item"><span class="ad-item-main">' +
                '<span class="ad-item-title">' + esc(e.emoji || '🧾') + ' ' +
                  esc(e.description) +
                  (e.deleted_at ? ' <span class="ad-pill">binned</span>' : '') +
                '</span>' +
                '<span class="ad-item-sub">' + money(Math.round(Number(e.amount) * 100)) +
                  ' · their share ' +
                  money(Math.round(Number(e.share || 0) * 100)) +
                  ' · ' + esc(e.date) + '</span></span>' +
                '<span class="ad-item-actions"><button class="ad-mini' +
                  (e.deleted_at ? '' : ' is-danger') + '" data-bin="' + esc(e.id) +
                  '" data-to="' + (e.deleted_at ? 'restore' : 'bin') + '">' +
                  (e.deleted_at ? 'Restore' : 'Bin') + '</button></span></div>';
            }).join('') +
            (d.expenses.length > 40
              ? '<div class="ad-empty">…and ' + count(d.expenses.length - 40) + ' more.</div>'
              : '')
          : '<div class="ad-empty">None.</div>') +

        '<div class="ad-sub">Act on this account</div>' +
        // An even grid of equal chips, safe ones first and the two
        // irreversible ones last, so Delete is never next to Rename.
        '<div class="ad-actions-grid">' +
          '<button class="ad-mini" data-act="rename">Rename</button>' +
          '<button class="ad-mini" data-act="reset">Reset password</button>' +
          '<button class="ad-mini" data-act="signout">Sign out everywhere</button>' +
          '<button class="ad-mini" data-act="actas">Act as them</button>' +
          '<button class="ad-mini" data-act="admin">' +
            (p.is_admin ? 'Remove admin' : 'Make admin') + '</button>' +
          '<button class="ad-mini is-danger" data-act="ban">Block</button>' +
          '<button class="ad-mini is-danger" data-act="delete">Delete account</button>' +
        '</div>',
      confirm: null,
      onOpen: function () {
        content.addEventListener('click', function (e) {
          const bin = e.target.closest('[data-bin]');
          if (bin) return binExpense(bin, id);

          const dg = e.target.closest('[data-delgroup]');
          if (dg) return deleteGroup(dg, id);

          const act = e.target.closest('[data-act]');
          if (act) return personAction(act.getAttribute('data-act'), p, id);
        });
      },
    });
  }

  async function binExpense(btn, personId) {
    const to = btn.getAttribute('data-to') === 'bin';
    try {
      await rpc('admin_set_expense_deleted', {
        p_expense: btn.getAttribute('data-bin'), p_deleted: to,
      });
      toast(to ? 'Moved to their bin' : 'Restored', 'ok');
      closeSheet();
      openPerson(personId);
      refreshStats();
    } catch (err) { toast(err.message, 'error'); }
  }

  function deleteGroup(btn, personId) {
    const id = btn.getAttribute('data-delgroup');
    const name = btn.getAttribute('data-name');
    closeSheet();
    SW.sheet({
      title: 'Delete ' + name + '?',
      body: '<p class="ad-muted">Every expense in it goes too, for everyone in ' +
            'it, and this is not recoverable. Their 1:1 balances survive.</p>',
      confirm: 'Delete the group', danger: true,
      onConfirm: async function (b) {
        busy(b, true);
        try {
          await rpc('admin_delete_group', { p_group: id });
          toast('Group deleted', 'ok');
          refreshStats();
          openPerson(personId);
        } catch (err) { toast(err.message, 'error'); }
        busy(b, false);
        return true;
      },
    });
  }

  function personAction(what, p, id) {
    const email = p.email;

    if (what === 'rename') {
      closeSheet();
      return SW.sheet({
        title: 'Rename',
        body: '<div class="field"><label for="ad-rn">Name</label>' +
              '<input class="input" id="ad-rn" value="' + esc(p.full_name || '') + '"></div>',
        confirm: 'Save',
        onConfirm: async function (b) {
          busy(b, true);
          try {
            await rpc('admin_set_profile', { p_user: id, p_full_name: $('ad-rn').value });
            toast('Renamed', 'ok');
            loadUsers($('ad-user-search').value);
          } catch (err) { toast(err.message, 'error'); busy(b, false); return false; }
          busy(b, false);
          return true;
        },
      });
    }

    if (what === 'admin') {
      const making = !p.is_admin;
      closeSheet();
      return SW.sheet({
        title: making ? 'Make ' + email + ' an admin?' : 'Remove admin from ' + email + '?',
        body: '<p class="ad-muted">' + (making
          ? 'They will be able to read and change everyone’s data, block ' +
            'accounts, and act as any user. Every action they take is recorded ' +
            'in the audit trail under their name.'
          : 'They lose access to this console immediately.') + '</p>',
        confirm: making ? 'Make admin' : 'Remove admin', danger: !making,
        onConfirm: async function (b) {
          busy(b, true);
          try {
            await rpc('admin_set_profile', { p_user: id, p_is_admin: making });
            toast(making ? 'They are an admin now' : 'Admin removed', 'ok');
            loadUsers($('ad-user-search').value);
            refreshStats();
          } catch (err) { toast(err.message, 'error'); busy(b, false); return false; }
          busy(b, false);
          return true;
        },
      });
    }

    if (what === 'reset') {
      closeSheet();
      return runApi('reset-password', { email: email }, 'Password reset link', true);
    }
    if (what === 'signout') {
      closeSheet();
      return runApi('sign-out-everywhere', { email: email }, 'Sessions ended');
    }

    if (what === 'actas') {
      closeSheet();
      return SW.sheet({
        title: 'Act as ' + email + '?',
        body:
          '<div class="ad-warn">This signs <strong>this browser</strong> in as ' +
            esc(email) + ', replacing your own session. You will be them until ' +
            'you sign out and sign back in as yourself. Anything you do will ' +
            'look like they did it.</div>' +
          '<p class="ad-muted">Recorded in the audit trail either way, whether ' +
            'or not you follow the link.</p>',
        confirm: 'Generate a sign-in link', danger: true,
        onConfirm: async function (b) {
          busy(b, true);
          try {
            const r = await api('act-as', { email: email });
            closeSheet();
            SW.sheet({
              title: 'Sign-in link for ' + email,
              body: '<p class="ad-muted">Single use. Opening it makes this ' +
                    'browser them.</p><code class="ad-code">' + esc(r.link) + '</code>',
              confirm: 'Open it and become them', danger: true,
              onConfirm: function () { window.location.href = r.link; return true; },
              cancel: 'Never mind',
            });
          } catch (err) { toast(err.message, 'error'); busy(b, false); return false; }
          return true;
        },
      });
    }

    if (what === 'ban') {
      closeSheet();
      return SW.sheet({
        title: 'Block ' + email + '?',
        body:
          '<p class="ad-muted">They are signed out everywhere, cannot sign in ' +
            'again, and cannot create a new account with this address. Their ' +
            'expenses stay exactly as they are, so nobody else’s balances ' +
            'move.</p>' +
          '<div class="field"><label for="ad-br">Reason (only you see this)</label>' +
          '<input class="input" id="ad-br" placeholder="optional"></div>',
        confirm: 'Block them', danger: true,
        onConfirm: async function (b) {
          busy(b, true);
          try {
            const r = await api('ban', { email: email, reason: $('ad-br').value });
            toast(r.message || 'Blocked', 'ok');
            loadUsers($('ad-user-search').value);
            loadLists();
            refreshStats();
          } catch (err) { toast(err.message, 'error'); busy(b, false); return false; }
          busy(b, false);
          return true;
        },
      });
    }

    if (what === 'delete') {
      closeSheet();
      return SW.sheet({
        title: 'Delete ' + email + '?',
        body:
          '<div class="ad-warn">Everything of theirs goes: expenses, groups they ' +
            'created, splits, payments. <strong>This changes other people’s ' +
            'balances</strong>, because their share of shared expenses disappears ' +
            'with them. There is no undo.</div>' +
          '<p class="ad-muted">Blocking them instead keeps every figure intact ' +
            'and simply stops them signing in.</p>',
        confirm: 'Delete permanently', danger: true,
        onConfirm: async function (b) {
          busy(b, true);
          try {
            const r = await api('delete-user', { email: email });
            toast(r.message || 'Deleted', 'ok');
            loadUsers($('ad-user-search').value);
            refreshStats();
          } catch (err) { toast(err.message, 'error'); busy(b, false); return false; }
          busy(b, false);
          return true;
        },
      });
    }
  }

  // For the actions whose only result is a message, or a link to pass on.
  async function runApi(action, payload, title, showLink) {
    try {
      const r = await api(action, payload);
      if (showLink && r.link) {
        return SW.sheet({
          title: title,
          body: '<p class="ad-muted">' + esc(r.message || '') + '</p>' +
                '<code class="ad-code">' + esc(r.link) + '</code>',
          confirm: null,
        });
      }
      toast(r.message || 'Done', 'ok');
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ======================= access ==================================== */

  function loadAccess(stats) {
    setSwitch('ad-signups', stats.signups_enabled);
    $('ad-signups-sub').textContent = stats.signups_enabled
      ? 'Anyone can sign up'
      : 'Closed — nobody new can register';

    setSwitch('ad-invite', stats.invite_only);
    $('ad-invite-sub').textContent = stats.invite_only
      ? 'Only the ' + count(stats.allowed_emails) + ' allowed addresses below'
      : 'Off — any address may register';

    loadLists();
  }

  function setSwitch(id, on) {
    const el = $(id);
    el.classList.toggle('is-on', !!on);
    el.setAttribute('aria-checked', String(!!on));
  }

  ['ad-signups', 'ad-invite'].forEach(function (id) {
    $(id).addEventListener('click', async function () {
      const key = id === 'ad-signups' ? 'signups_enabled' : 'invite_only';
      const on = !this.classList.contains('is-on');
      setSwitch(id, on);
      try {
        await rpc('admin_set_setting', { p_key: key, p_enabled: on });
        const stats = await rpc('admin_stats');
        loadAccess(stats);
        paintStats(stats);
        toast(key === 'signups_enabled'
          ? (on ? 'Signups open' : 'Signups closed')
          : (on ? 'Invite only' : 'Open to anyone'), 'ok');
      } catch (err) {
        setSwitch(id, !on);
        toast(err.message, 'error');
      }
    });
  });

  async function loadLists() {
    let lists;
    try { lists = await rpc('admin_lists'); } catch (err) { return toast(err.message, 'error'); }

    $('ad-banned').innerHTML = (lists.banned || []).length
      ? lists.banned.map(function (b) {
          return '<div class="ad-item"><span class="ad-item-main">' +
            '<span class="ad-item-title">' + esc(b.email) + '</span>' +
            '<span class="ad-item-sub">' + esc(b.reason || 'no reason given') +
              ' · ' + ago(b.at) + (b.by ? ' by ' + esc(b.by) : '') +
              (b.has_account ? ' · has an account' : ' · never signed up') +
            '</span></span>' +
            '<span class="ad-item-actions"><button class="ad-mini" data-unban="' +
              esc(b.email) + '">Unblock</button></span></div>';
        }).join('')
      : '<div class="ad-empty">Nobody is blocked.</div>';

    $('ad-allowed').innerHTML = (lists.allowed || []).length
      ? lists.allowed.map(function (a) {
          return '<div class="ad-item"><span class="ad-item-main">' +
            '<span class="ad-item-title">' + esc(a.email) + '</span>' +
            '<span class="ad-item-sub">' + esc(a.note || 'allowed') + ' · ' + ago(a.at) +
              (a.signed_up ? ' · signed up' : ' · not yet') + '</span></span>' +
            '<span class="ad-item-actions"><button class="ad-mini" data-disallow="' +
              esc(a.email) + '">Remove</button></span></div>';
        }).join('')
      : '<div class="ad-empty">Nothing allowed yet. While invite only is on, ' +
        'nobody can register.</div>';
  }

  $('ad-banned').addEventListener('click', async function (e) {
    const b = e.target.closest('[data-unban]');
    if (!b) return;
    b.disabled = true;
    try {
      const r = await api('unban', { email: b.getAttribute('data-unban') });
      toast(r.message || 'Unblocked', 'ok');
      loadLists(); loadUsers($('ad-user-search').value); refreshStats();
    } catch (err) { toast(err.message, 'error'); b.disabled = false; }
  });

  $('ad-allowed').addEventListener('click', async function (e) {
    const b = e.target.closest('[data-disallow]');
    if (!b) return;
    b.disabled = true;
    try {
      await rpc('admin_disallow_email', { p_email: b.getAttribute('data-disallow') });
      toast('Removed', 'ok');
      loadLists(); refreshStats();
    } catch (err) { toast(err.message, 'error'); b.disabled = false; }
  });

  $('ad-allow').addEventListener('click', async function () {
    const btn = this;
    const email = $('ad-allow-email').value.trim().toLowerCase();
    if (!email) return toast('Which address?', 'error');
    busy(btn, true);
    try {
      await rpc('admin_allow_email', { p_email: email, p_note: null });
      $('ad-allow-email').value = '';
      toast('Allowed', 'ok');
      loadLists(); refreshStats();
    } catch (err) { toast(err.message, 'error'); }
    busy(btn, false);
  });

  $('ad-ban').addEventListener('click', async function () {
    const btn = this;
    const email = $('ad-ban-email').value.trim().toLowerCase();
    if (!email) return toast('Which address?', 'error');
    busy(btn, true);
    try {
      const r = await api('ban', { email: email, reason: $('ad-ban-reason').value });
      $('ad-ban-email').value = ''; $('ad-ban-reason').value = '';
      toast(r.message || 'Blocked', 'ok');
      loadLists(); loadUsers($('ad-user-search').value); refreshStats();
    } catch (err) { toast(err.message, 'error'); }
    busy(btn, false);
  });

  $('ad-create').addEventListener('click', async function () {
    const btn = this;
    busy(btn, true);
    try {
      const r = await api('create-user', {
        email: $('ad-new-email').value.trim().toLowerCase(),
        password: $('ad-new-pw').value,
        full_name: $('ad-new-name').value,
      });
      $('ad-new-email').value = ''; $('ad-new-pw').value = ''; $('ad-new-name').value = '';
      toast(r.message || 'Created', 'ok');
      loadUsers(); refreshStats();
    } catch (err) { toast(err.message, 'error'); }
    busy(btn, false);
  });

  $('ad-invite-send').addEventListener('click', async function () {
    const btn = this;
    busy(btn, true);
    try {
      const r = await api('invite-user', {
        email: $('ad-new-email').value.trim().toLowerCase(),
      });
      toast(r.message || 'Invited', 'ok');
      loadLists();
    } catch (err) { toast(err.message, 'error'); }
    busy(btn, false);
  });

  /* ======================= failures ================================== */

  async function loadErrors() {
    const host = $('ad-errors');
    let d;
    try { d = await rpc('admin_errors', { p_limit: 200 }); }
    catch (err) { host.innerHTML = '<div class="ad-empty">' + esc(err.message) + '</div>'; return; }

    if (!(d.grouped || []).length) {
      host.innerHTML = '<div class="ad-empty">Nothing has thrown. ' +
        'Reports arrive here on their own when the app hits an error.</div>';
      return;
    }

    host.innerHTML = d.grouped.map(function (g) {
      return '<div class="ad-item"><span class="ad-item-main">' +
        '<span class="ad-item-title">' + esc(g.message) + '</span>' +
        '<span class="ad-item-sub">' + count(g.n) + '×' +
          ' · ' + count(g.people) + ' ' + (g.people === 1 ? 'person' : 'people') +
          ' · last ' + ago(g.last_at) +
          (g.source ? ' · ' + esc(g.source) : '') + '</span></span>' +
        (g.stack
          ? '<span class="ad-item-actions"><button class="ad-mini" data-stack="' +
            esc(g.message) + '">Stack</button></span>'
          : '') +
        '</div>';
    }).join('');

    stacks = {};
    d.grouped.forEach(function (g) { stacks[g.message] = g.stack; });
  }

  let stacks = {};

  $('ad-errors').addEventListener('click', function (e) {
    const b = e.target.closest('[data-stack]');
    if (!b) return;
    const msg = b.getAttribute('data-stack');
    SW.sheet({
      title: 'Stack',
      body: '<p class="ad-muted">' + esc(msg) + '</p>' +
            '<code class="ad-code">' + esc(stacks[msg] || 'none recorded') + '</code>',
      confirm: null,
    });
  });

  $('ad-clear-errors').addEventListener('click', function () {
    SW.sheet({
      title: 'Clear every failure report?',
      body: '<p class="ad-muted">They are only diagnostics, so nothing of value ' +
            'is lost — but you will not be able to tell whether a bug is fixed ' +
            'or simply not reported again yet.</p>',
      confirm: 'Clear them', danger: true,
      onConfirm: async function (b) {
        busy(b, true);
        try {
          const n = await rpc('admin_clear_errors');
          toast(count(n) + ' cleared', 'ok');
          loadErrors(); refreshStats(); loadTrail();
        } catch (err) { toast(err.message, 'error'); }
        busy(b, false);
        return true;
      },
    });
  });

  /* ======================= audit trail =============================== */

  async function loadTrail() {
    const host = $('ad-trail');
    let rows;
    try { rows = await rpc('admin_audit_log', { p_limit: 300 }); }
    catch (err) { host.innerHTML = '<div class="ad-empty">' + esc(err.message) + '</div>'; return; }

    if (!rows.length) {
      host.innerHTML = '<div class="ad-empty">Nothing yet.</div>';
      return;
    }

    host.innerHTML = rows.map(function (a) {
      const detail = a.detail && Object.keys(a.detail).length
        ? ' · ' + JSON.stringify(a.detail)
        : '';
      return '<div class="ad-item"><span class="ad-item-main">' +
        '<span class="ad-item-title">' + esc(a.action.replace(/_/g, ' ')) +
          (a.target_email ? ' — ' + esc(a.target_email) : '') + '</span>' +
        '<span class="ad-item-sub">' + esc(a.actor_email || 'someone') + ' · ' +
          ago(a.at) + esc(detail) + '</span></span></div>';
    }).join('');
  }

  /* ======================= start ===================================== */

  // Already signed in — in the app or here, they share the session — means
  // straight into the console. The form is only for someone who is not.
  db.auth.getSession().then(function (r) {
    if (r.data && r.data.session) return afterSignIn();
    show('gate');
  }, function () {
    show('gate');
  });

  // A session that expires or is signed out in the app tab should take this
  // tab with it, rather than leaving a console that 401s on every action.
  db.auth.onAuthStateChange(function (event, session) {
    if (event === 'SIGNED_OUT' || !session) {
      if (!$('ad-app').hidden) location.reload();
    }
  });
})();
