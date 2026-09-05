// ---------------------------------------------------------------------------
//  End-to-end: every module, against the live project
//
//    ./scripts/db e2e
//
//  The other suites are static or pure-arithmetic. They all passed while
//  signup returned a 500, because nothing in them ever signed anybody up.
//  This one does the actual thing, over HTTP, as real users with real
//  tokens — so RLS applies, triggers fire, and a broken mail configuration
//  is a failing test rather than a friend's bad afternoon.
//
//  It creates its own throwaway accounts on example.com (a reserved domain
//  that reaches nobody) and removes them and everything they made at the
//  end, in a finally block, whether it passed or not.
//
//  Needs SUPABASE_SERVICE_ROLE_KEY, which ./scripts/db supplies from the
//  linked project. Nothing here is written to the repo.
// ---------------------------------------------------------------------------

const BASE = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!BASE || !ANON || !SVC) {
  console.error('Needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}

let passed = 0, failed = 0, skipped = 0;
const failures = [];

function ok(label, condition, detail) {
  if (condition) { passed++; console.log('  PASS  ' + label); return true; }
  failed++;
  failures.push(label);
  console.log('  FAIL  ' + label +
    (detail === undefined ? '' : '\n          ' + JSON.stringify(detail).slice(0, 240)));
  return false;
}

function skip(label, why) {
  skipped++;
  console.log('  SKIP  ' + label + ' — ' + why);
}

function section(name) { console.log('\n--- ' + name + ' ---'); }

const svcHead = {
  apikey: SVC, Authorization: 'Bearer ' + SVC, 'Content-Type': 'application/json',
};

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  return { status: res.status, ok: res.ok, body };
}

// A signed-in user's own client: anon key as apikey, their token as bearer.
function asUser(token) {
  const head = {
    apikey: ANON, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
  };
  return {
    rpc: (fn, args) => api('/rest/v1/rpc/' + fn,
      { method: 'POST', headers: head, body: JSON.stringify(args || {}) }),
    select: (q) => api('/rest/v1/' + q, { headers: head }),
    insert: (table, row, prefer) => api('/rest/v1/' + table, {
      method: 'POST',
      headers: Object.assign({}, head, { Prefer: prefer || 'return=representation' }),
      body: JSON.stringify(row),
    }),
    patch: (q, row) => api('/rest/v1/' + q, {
      method: 'PATCH',
      headers: Object.assign({}, head, { Prefer: 'return=representation' }),
      body: JSON.stringify(row),
    }),
    del: (q) => api('/rest/v1/' + q, { method: 'DELETE', headers: head }),
  };
}

async function makeUser(email, name) {
  // Created through the Admin API with email_confirm, so the suite still
  // runs when the project's outgoing mail is broken — which is exactly the
  // situation it was written for.
  const made = await api('/auth/v1/admin/users', {
    method: 'POST', headers: svcHead,
    body: JSON.stringify({
      email, password: 'e2e-pass-' + Math.random().toString(36).slice(2, 10),
      email_confirm: true, user_metadata: { full_name: name },
    }),
  });
  if (!made.ok) throw new Error('could not create ' + email + ': ' + JSON.stringify(made.body));

  const link = await api('/auth/v1/admin/generate_link', {
    method: 'POST', headers: svcHead,
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const ver = await api('/auth/v1/verify', {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: link.body.hashed_token }),
  });
  if (!ver.body || !ver.body.access_token) {
    throw new Error('could not get a token for ' + email);
  }
  return { id: made.body.id, email, token: ver.body.access_token, api: asUser(ver.body.access_token) };
}

// Reports whether it worked. Swallowing this is how a completely broken
// "Delete account" survived a full run of the suite: the cleanup failed
// silently and only the leftover-profiles check at the end noticed.
async function removeUser(id, label) {
  if (!id) return true;
  const res = await api('/auth/v1/admin/users/' + id,
    { method: 'DELETE', headers: svcHead }).catch((e) => ({ ok: false, body: String(e) }));
  if (!res.ok && label) {
    ok('deleting ' + label + ' works, expenses and settlements and all', false,
      { status: res.status, body: res.body });
  }
  return res.ok;
}

// An admin has to exist before the signup, or there is nobody for the
// new-account notification to reach.
async function firstExistingAdmin() {
  const res = await api('/rest/v1/profiles?is_admin=is.true&select=id,email&limit=1',
    { headers: svcHead });
  return Array.isArray(res.body) && res.body[0] ? res.body[0] : null;
}

const stamp = Date.now();
const A_EMAIL = 'e2e-a-' + stamp + '@example.com';
const B_EMAIL = 'e2e-b-' + stamp + '@example.com';
const C_EMAIL = 'e2e-c-' + stamp + '@example.com';
const SIGNUP_EMAIL = 'e2e-signup-' + stamp + '@example.com';

let A = null, B = null, C = null, signupId = null;

try {
  /* =================================================================== */
  section('signing up, as a stranger would');

  // No service key, no admin API: the anon endpoint, exactly what the app
  // calls. This is the check that was missing when a friend hit a 500.
  const su = await api('/auth/v1/signup', {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: SIGNUP_EMAIL, password: 'e2e-pass-signup-991',
      data: { full_name: 'E2E Signup' },
    }),
  });

  const watchingAdmin = await firstExistingAdmin();

  const mailBroken = su.status >= 500 &&
    /sending (confirmation|recovery|magic|invite)/i.test(JSON.stringify(su.body || ''));

  if (mailBroken) {
    ok('a stranger can create an account', false, {
      status: su.status, body: su.body,
      diagnosis: 'Supabase accepted the signup and then failed to SEND the ' +
        'confirmation email, so the whole thing was rolled back. This is the ' +
        'project mail configuration, not the app. Either fix custom SMTP ' +
        '(README 4.6) or turn Confirm email off (README 4.2).',
    });
  } else {
    ok('a stranger can create an account', su.ok || su.status === 200, {
      status: su.status, body: su.body,
    });
    if (su.body && su.body.id) signupId = su.body.id;
    if (su.body && su.body.user && su.body.user.id) signupId = su.body.user.id;
  }

  // Every admin hears about a new account — and, just as importantly, the
  // signup still succeeds when that notification cannot be written, because
  // it runs inside the same transaction.
  if (!watchingAdmin) {
    skip('every admin is told about the new account', 'no admin exists yet');
  } else if (!su.ok) {
    skip('every admin is told about the new account', 'the signup itself failed');
  } else {
    const told = await api('/rest/v1/notifications?type=eq.account_created' +
      '&user_id=eq.' + watchingAdmin.id +
      '&order=created_at.desc&limit=5&select=title,body', { headers: svcHead });
    ok('every admin is told about the new account',
      Array.isArray(told.body) &&
      told.body.some((n) => (n.body || '').toLowerCase() === SIGNUP_EMAIL),
      told.body);
  }

  // Whatever happened, it must not leave a half-made account behind.
  const orphan = await api('/rest/v1/profiles?email=eq.' +
    encodeURIComponent(SIGNUP_EMAIL) + '&select=id', { headers: svcHead });
  ok('a failed signup leaves no half-made profile',
    Array.isArray(orphan.body) && (su.ok ? orphan.body.length === 1 : orphan.body.length === 0),
    { profiles: orphan.body });

  /* =================================================================== */
  section('accounts and profiles');

  A = await makeUser(A_EMAIL, 'Ay Tester');
  B = await makeUser(B_EMAIL, 'Bee Tester');
  C = await makeUser(C_EMAIL, 'Cee Outsider');
  ok('three accounts exist with working tokens', !!(A.token && B.token && C.token));

  const prof = await A.api.select('profiles?id=eq.' + A.id +
    '&select=full_name,email,avatar_emoji,avatar_path,upi_id,notify_prefs,ui_prefs,email_notify,is_admin');
  ok('the signup trigger made a profile row',
    Array.isArray(prof.body) && prof.body.length === 1, prof.body);
  ok('every column the app reads is present and readable',
    prof.body[0] && ['full_name', 'email', 'avatar_emoji', 'avatar_path', 'upi_id',
      'notify_prefs', 'ui_prefs', 'email_notify', 'is_admin']
      .every((k) => k in prof.body[0]), prof.body[0] && Object.keys(prof.body[0]));
  ok('the name came from the signup metadata',
    prof.body[0] && prof.body[0].full_name === 'Ay Tester', prof.body[0]);

  const rename = await A.api.patch('profiles?id=eq.' + A.id,
    { full_name: 'Ay Renamed', upi_id: 'ay@okhdfcbank' });
  ok('you can edit your own name and UPI id', rename.ok, rename.body);

  const escalate = await A.api.patch('profiles?id=eq.' + A.id, { is_admin: true });
  ok('but you cannot make yourself an admin', escalate.status === 403 ||
    (escalate.body && String(escalate.body.message || '').includes('is_admin')),
    { status: escalate.status, body: escalate.body });

  /* =================================================================== */
  section('friends');

  const friend = await A.api.rpc('add_friend_by_email', { friend_email: B_EMAIL });
  ok('adding a friend by email works', friend.ok, friend.body);

  const dup = await A.api.rpc('add_friend_by_email', { friend_email: B_EMAIL });
  ok('adding the same friend twice says so rather than duplicating',
    dup.body && dup.body.ok === false && dup.body.error === 'already', dup.body);

  const self = await A.api.rpc('add_friend_by_email', { friend_email: A_EMAIL });
  ok('you cannot add yourself',
    self.body && self.body.ok === false && self.body.error === 'self',
    { status: self.status, body: self.body });

  const ghost = await A.api.rpc('add_friend_by_email',
    { friend_email: 'nobody-' + stamp + '@example.com' });
  ok('an address with no account is refused clearly',
    ghost.body && ghost.body.ok === false && ghost.body.error === 'no_user', ghost.body);

  const seen = await A.api.select('profiles?select=email');
  ok('you can see your friend’s profile',
    Array.isArray(seen.body) && seen.body.some((p) => p.email === B_EMAIL), seen.body);
  ok('but not a stranger’s',
    Array.isArray(seen.body) && !seen.body.some((p) => p.email === C_EMAIL),
    seen.body);

  /* =================================================================== */
  section('groups');

  const grp = await A.api.rpc('create_group',
    { p_name: 'E2E Flat', p_group_type: 'home', p_emoji: '🏠' });
  const gid = grp.body && (grp.body.id || grp.body.group_id ||
    (typeof grp.body === 'string' ? grp.body : null));
  ok('a group can be created', grp.ok && !!gid, grp.body);

  const addMem = await A.api.rpc('add_group_member_by_email',
    { p_group_id: gid, p_email: B_EMAIL });
  ok('a member can be added by email', addMem.ok, addMem.body);

  const members = await A.api.select('group_members?group_id=eq.' + gid + '&select=user_id,role');
  ok('the group has both people', Array.isArray(members.body) && members.body.length === 2,
    members.body);

  const outsiderPeek = await C.api.select('group_members?group_id=eq.' + gid + '&select=user_id');
  ok('an outsider cannot see the membership',
    Array.isArray(outsiderPeek.body) && outsiderPeek.body.length === 0, outsiderPeek.body);

  const outsiderJoin = await C.api.insert('group_members',
    { group_id: gid, user_id: C.id }, 'return=minimal');
  ok('and cannot add themselves to it', !outsiderJoin.ok,
    { status: outsiderJoin.status, body: outsiderJoin.body });

  /* =================================================================== */
  section('expenses and splitting');

  const equal = await A.api.rpc('create_expense', {
    p_amount: 1000, p_description: 'E2E equal',
    p_splits: [{ user_id: A.id, amount: 500 }, { user_id: B.id, amount: 500 }],
    p_payer_id: A.id, p_group_id: gid, p_category: 'general', p_split_mode: 'equal',
  });
  const eid = typeof equal.body === 'string' ? equal.body : (equal.body && equal.body.id);
  ok('an equally split expense can be created', equal.ok && !!eid, equal.body);

  const splits = await A.api.select('expense_splits?expense_id=eq.' + eid + '&select=user_id,amount');
  const sum = (splits.body || []).reduce((t, s) => t + Math.round(Number(s.amount) * 100), 0);
  ok('its splits sum to the total exactly', sum === 100000, { sum, splits: splits.body });

  const payers = await A.api.select('expense_payers?expense_id=eq.' + eid + '&select=user_id,amount');
  const paid = (payers.body || []).reduce((t, s) => t + Math.round(Number(s.amount) * 100), 0);
  ok('and its payments sum to the total', paid === 100000, { paid, payers: payers.body });

  const thirds = await A.api.rpc('create_expense', {
    p_amount: 1000, p_description: 'E2E uneven',
    p_splits: [{ user_id: A.id, amount: 333.34 }, { user_id: B.id, amount: 666.66 }],
    p_payer_id: B.id, p_group_id: gid, p_split_mode: 'exact',
  });
  ok('an exact split that does not divide evenly is accepted', thirds.ok, thirds.body);

  const wrong = await A.api.rpc('create_expense', {
    p_amount: 1000, p_description: 'E2E broken',
    p_splits: [{ user_id: A.id, amount: 100 }],
    p_payer_id: A.id, p_group_id: gid,
  });
  ok('splits that do not add up to the amount are refused',
    !wrong.ok, { status: wrong.status, body: wrong.body });

  const outsiderRead = await C.api.select('expenses?id=eq.' + eid + '&select=description');
  ok('an outsider cannot read the expense',
    Array.isArray(outsiderRead.body) && outsiderRead.body.length === 0, outsiderRead.body);

  const bSees = await B.api.select('expenses?id=eq.' + eid + '&select=description');
  ok('the other participant can', Array.isArray(bSees.body) && bSees.body.length === 1,
    bSees.body);

  /* =================================================================== */
  section('notifications');

  const bNotes = await B.api.select(
    'notifications?select=type,title,is_read&order=created_at.desc&limit=10');
  ok('the other person was told about the expense',
    Array.isArray(bNotes.body) && bNotes.body.some((n) => n.type === 'expense_added'),
    bNotes.body);
  ok('and theirs is unread',
    (bNotes.body || []).filter((n) => n.type === 'expense_added').some((n) => !n.is_read),
    bNotes.body);

  const aNotes = await A.api.select(
    'notifications?select=type,title,is_read&order=created_at.desc&limit=10');
  const own = (aNotes.body || []).filter((n) => n.type === 'expense_added');
  ok('you are told about your own action too', own.length > 0, aNotes.body);
  ok('but it arrives already read, so the bell stays quiet',
    own.length > 0 && own.every((n) => n.is_read), own);
  ok('and it reads as your own doing',
    own.length > 0 && own.every((n) => /^You added/.test(n.title)), own.map((n) => n.title));

  const forge = await A.api.insert('notifications',
    { user_id: B.id, actor_id: A.id, type: 'nudge', title: 'Pay me', body: '' },
    'return=minimal');
  ok('a client cannot forge a notification', !forge.ok,
    { status: forge.status, body: forge.body });

  const markRead = await B.api.rpc('mark_all_notifications_read');
  ok('marking them read works', markRead.ok, markRead.body);

  /* =================================================================== */
  section('settling up, and undoing it');

  const pay = await B.api.insert('settlements', {
    group_id: gid, from_user: B.id, to_user: A.id, amount: 500,
    note: 'E2E settle', settled_on: new Date().toISOString().slice(0, 10),
    created_by: B.id,
  });
  const sid = Array.isArray(pay.body) && pay.body[0] && pay.body[0].id;
  ok('a payment can be recorded', pay.ok && !!sid, pay.body);

  const pay2 = await B.api.insert('settlements', {
    group_id: gid, from_user: B.id, to_user: A.id, amount: 100,
    settled_on: new Date().toISOString().slice(0, 10), created_by: B.id,
  });
  const sid2 = Array.isArray(pay2.body) && pay2.body[0] && pay2.body[0].id;

  const undoOld = await B.api.rpc('undo_settlement', { p_settlement: sid });
  ok('only the most recent payment can be undone', !undoOld.ok,
    { status: undoOld.status, body: undoOld.body });

  const undoNew = await B.api.rpc('undo_settlement', { p_settlement: sid2 });
  ok('the most recent one can', undoNew.ok, undoNew.body);

  // Soft delete: the row survives on purpose, and the ledger query is what
  // excludes it. Asking without that filter finds it and proves nothing.
  const live = await B.api.select(
    'settlements?id=eq.' + sid2 + '&deleted_at=is.null&select=id');
  ok('an undone payment drops out of the live ledger',
    Array.isArray(live.body) && live.body.length === 0, live.body);
  const kept = await B.api.select('settlements?id=eq.' + sid2 + '&select=deleted_at');
  ok('but is kept as a struck-through record, not erased',
    Array.isArray(kept.body) && kept.body.length === 1 && !!kept.body[0].deleted_at,
    kept.body);

  const undoStranger = await C.api.rpc('undo_settlement', { p_settlement: sid });
  ok('a stranger cannot undo somebody’s payment', !undoStranger.ok,
    { status: undoStranger.status, body: undoStranger.body });

  /* =================================================================== */
  section('invite links');

  const inv = await A.api.rpc('create_invite', { p_group_id: gid });
  const token = inv.body && inv.body.token;
  ok('an invite link can be made', inv.ok && !!token, inv.body);
  ok('its token is URL safe', typeof token === 'string' && /^[0-9a-f]{32}$/.test(token), token);

  const redeem = await C.api.rpc('redeem_invite', { p_token: token });
  ok('and an outsider can redeem it', redeem.ok && redeem.body && redeem.body.ok !== false,
    redeem.body);

  const nowIn = await C.api.select('group_members?group_id=eq.' + gid + '&user_id=eq.' + C.id);
  ok('which puts them in the group', Array.isArray(nowIn.body) && nowIn.body.length === 1,
    nowIn.body);

  /* =================================================================== */
  section('categories');

  const cat = await A.api.insert('user_categories',
    { user_id: A.id, name: 'E2E Cat', emoji: '🧪', is_custom: true });
  ok('a category can be added', cat.ok, cat.body);

  await A.api.rpc('create_expense', {
    p_amount: 60, p_description: 'E2E categorised', p_category: 'E2E Cat',
    p_splits: [{ user_id: A.id, amount: 60 }], p_payer_id: A.id,
  });

  const ren = await A.api.rpc('rename_category', { p_old: 'E2E Cat', p_new: 'E2E Renamed' });
  ok('renaming it reports what it moved', ren.ok && ren.body && ren.body.ok, ren.body);
  ok('and the expense followed it', ren.body && ren.body.expenses >= 1, ren.body);

  const moved = await A.api.select(
    'expenses?description=eq.E2E%20categorised&select=category');
  ok('the expense really carries the new name',
    Array.isArray(moved.body) && moved.body[0] && moved.body[0].category === 'E2E Renamed',
    moved.body);

  const other = await B.api.rpc('rename_category', { p_old: 'E2E Renamed', p_new: 'Hijack' });
  ok('somebody else cannot rename your category', !other.ok, other.body);

  /* =================================================================== */
  section('trash, recurring and nudges');

  const bin = await A.api.rpc('set_expense_deleted', { p_expense_id: eid, p_deleted: true });
  ok('an expense can be binned', bin.ok, bin.body);

  const hidden = await A.api.select('expenses?id=eq.' + eid + '&deleted_at=is.null&select=id');
  ok('and drops out of the live ledger',
    Array.isArray(hidden.body) && hidden.body.length === 0, hidden.body);

  const restore = await A.api.rpc('set_expense_deleted', { p_expense_id: eid, p_deleted: false });
  ok('and can be restored', restore.ok, restore.body);

  const purge = await A.api.rpc('purge_trash');
  ok('purge_trash runs and reports', purge.ok, purge.body);

  const nextOcc = await A.api.rpc('next_occurrence',
    { p_from: '2026-01-31', p_cadence: 'monthly', p_day: 31 });
  ok('next_occurrence does not drift on a 31st',
    nextOcc.ok && String(nextOcc.body).startsWith('2026-02-28'), nextOcc.body);

  const due = await A.api.rpc('run_due_recurring');
  ok('run_due_recurring runs', due.ok, due.body);

  const reminders = await A.api.rpc('run_due_settle_reminders');
  ok('run_due_settle_reminders runs', reminders.ok, reminders.body);

  const nudge = await A.api.rpc('nudge', { p_user_id: B.id, p_group_id: gid, p_amount: 500 });
  ok('a nudge can be sent', nudge.ok, nudge.body);

  const nudgeAgain = await A.api.rpc('nudge', { p_user_id: B.id, p_group_id: gid, p_amount: 500 });
  ok('and is rate limited', !nudgeAgain.ok ||
    (nudgeAgain.body && nudgeAgain.body.ok === false), nudgeAgain.body);

  /* =================================================================== */
  section('itemised receipts');

  // Scanning alone used to be refused outright. It is useful on its own —
  // it totals the order and records what was in it — and now that the
  // itemisation is stored, it leaves something to share out later.
  const solo = await A.api.rpc('create_expense', {
    p_amount: 300, p_description: 'E2E Zepto order',
    p_splits: [{ user_id: A.id, amount: 300 }],
    p_payer_id: A.id,
    p_items: [
      { name: 'Eggs 6', qty: 1, totalPaise: 9000, kind: 'item', who: [A.id] },
      { name: 'Milk 1L', qty: 2, totalPaise: 13000, kind: 'item', who: [A.id] },
      { name: 'Handling fee', qty: 1, totalPaise: 8000, kind: 'fee', who: [A.id] },
    ],
  });
  const soloId = typeof solo.body === 'string' ? solo.body : (solo.body && solo.body.id);
  ok('one person can itemise a receipt alone', solo.ok && !!soloId, solo.body);

  const stored = await A.api.select('expenses?id=eq.' + soloId + '&select=items');
  ok('and the itemisation is stored, not thrown away',
    Array.isArray(stored.body) && Array.isArray(stored.body[0].items) &&
    stored.body[0].items.length === 3, stored.body);
  ok('with who was in on each line',
    stored.body[0].items[0].who && stored.body[0].items[0].who[0] === A.id,
    stored.body[0].items[0]);

  // The egg, later shared.
  const reassign = await A.api.rpc('update_expense', {
    p_expense_id: soloId, p_amount: 300, p_description: 'E2E Zepto order',
    p_splits: [{ user_id: A.id, amount: 255 }, { user_id: B.id, amount: 45 }],
    p_items: [
      { name: 'Eggs 6', qty: 1, totalPaise: 9000, kind: 'item', who: [A.id, B.id] },
      { name: 'Milk 1L', qty: 2, totalPaise: 13000, kind: 'item', who: [A.id] },
      { name: 'Handling fee', qty: 1, totalPaise: 8000, kind: 'fee', who: [A.id, B.id] },
    ],
  });
  ok('a line can be reassigned later', reassign.ok, reassign.body);

  const after = await A.api.select('expenses?id=eq.' + soloId + '&select=items');
  ok('and the stored itemisation follows',
    after.body[0].items[0].who.length === 2, after.body[0].items[0]);

  const told = await B.api.select('notifications?expense_id=eq.' + soloId +
    '&select=type,title,body&order=created_at.desc&limit=1');
  ok('the person newly added is told they were added',
    Array.isArray(told.body) && told.body[0] &&
    told.body[0].type === 'added_to_expense' &&
    /added you to/.test(told.body[0].title), told.body);
  ok('and told what their share is',
    told.body[0] && /Your share is ₹45\.00 of ₹300\.00/.test(told.body[0].body),
    told.body[0]);

  // An edit that never opens the itemiser must not discard it.
  const keepItems = await A.api.rpc('update_expense', {
    p_expense_id: soloId, p_amount: 300, p_description: 'E2E Zepto order renamed',
    p_splits: [{ user_id: A.id, amount: 255 }, { user_id: B.id, amount: 45 }],
  });
  const stillThere = await A.api.select('expenses?id=eq.' + soloId + '&select=items');
  ok('an edit that never opened the itemiser keeps it',
    keepItems.ok && Array.isArray(stillThere.body[0].items) &&
    stillThere.body[0].items.length === 3, stillThere.body[0]);

  await A.api.rpc('set_expense_deleted', { p_expense_id: soloId, p_deleted: true });

  /* =================================================================== */
  section('settle-up reminders');

  // A group whose settle-up day is today, so a reminder is due right now.
  const today = new Date();
  const gset = await A.api.patch('groups?id=eq.' + gid,
    { settle_up_day: today.getDate() });
  ok('a group can be given a settle-up day', gset.ok, gset.body);

  // Everything between A and B has been settled and undone above, so the
  // position here is whatever the expenses left — which is the point: a
  // reminder is only sent when there is something to settle.
  const raised = await A.api.rpc('run_due_settle_reminders');
  ok('run_due_settle_reminders reports how many it raised',
    raised.ok && typeof raised.body === 'number', raised.body);

  const reminder = await A.api.select('notifications?type=eq.settle_reminder' +
    '&group_id=eq.' + gid + '&select=title,body&limit=1');
  if (Array.isArray(reminder.body) && reminder.body.length) {
    const r0 = reminder.body[0];
    ok('the reminder names the group', /^Settle up in /.test(r0.title), r0.title);
    ok('and says what there is to settle, not just the date',
      /(You owe|You are owed) ₹/.test(r0.body || ''), r0.body);
    ok('naming the other people who are not square',
      /(owes|is owed) ₹/.test((r0.body || '').replace(/^(You owe|You are owed) ₹\S+/, '')),
      r0.body);
  } else {
    // Square in this group, which is the other correct outcome.
    ok('no reminder is sent when there is nothing to settle',
      raised.body === 0, { raised: raised.body, found: reminder.body });
  }

  const again = await A.api.rpc('run_due_settle_reminders');
  ok('calling it twice in a month raises nothing the second time',
    again.ok && again.body === 0, again.body);

  await A.api.patch('groups?id=eq.' + gid, { settle_up_day: null });

  /* =================================================================== */
  section('error reporting');

  const rep = await A.api.insert('error_reports',
    { user_id: A.id, message: 'E2E probe error', source: 'e2e.mjs' }, 'return=minimal');
  ok('the app can report its own failure', rep.ok, { status: rep.status, body: rep.body });

  const blame = await A.api.insert('error_reports',
    { user_id: B.id, message: 'E2E not mine' }, 'return=minimal');
  ok('but not blame somebody else', !blame.ok, { status: blame.status, body: blame.body });

  const readErrs = await A.api.select('error_reports?select=message');
  ok('and cannot read them back without being an admin',
    Array.isArray(readErrs.body) && readErrs.body.length === 0, readErrs.body);

  /* =================================================================== */
  section('the admin API');

  const notAdmin = await A.api.rpc('admin_stats');
  ok('a normal user cannot call admin_stats', !notAdmin.ok, notAdmin.body);

  // admin_set_profile needs an admin caller, and there isn't one yet — so
  // the bootstrap is a direct write with the service role, which the
  // is_admin guard now permits (it is the owner's key, and it already
  // bypasses RLS entirely).
  const promote = await api('/rest/v1/profiles?id=eq.' + A.id, {
    method: 'PATCH', headers: Object.assign({}, svcHead, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ is_admin: true }),
  });
  ok('the service role can bootstrap the first admin', promote.ok,
    { status: promote.status, body: promote.body });

  const stats = await A.api.rpc('admin_stats');
  ok('an admin can', stats.ok && stats.body && typeof stats.body.users === 'number',
    stats.body);
  ok('and the figures are real numbers',
    stats.ok && ['users', 'groups', 'expenses', 'db_bytes', 'audit_rows']
      .every((k) => typeof stats.body[k] === 'number'), stats.body && Object.keys(stats.body));

  const people = await A.api.rpc('admin_users', { p_limit: 5 });
  ok('admin_users returns a page', people.ok && Array.isArray(people.body), people.body);

  const detail = await A.api.rpc('admin_user_detail', { p_user: B.id });
  ok('admin_user_detail returns the whole picture',
    detail.ok && detail.body && detail.body.profile &&
    Array.isArray(detail.body.groups) && Array.isArray(detail.body.expenses), detail.body);

  const errsNow = await A.api.rpc('admin_errors', { p_limit: 10 });
  ok('an admin can read the failures',
    errsNow.ok && errsNow.body && Array.isArray(errsNow.body.grouped) &&
    errsNow.body.grouped.some((g) => g.message === 'E2E probe error'), errsNow.body);

  const trail = await A.api.rpc('admin_audit_log', { p_limit: 5 });
  ok('and the audit trail', trail.ok && Array.isArray(trail.body), trail.body);

  ok('the console can see which timezone midnight means',
    typeof stats.body.timezone === 'string' &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(stats.body.local_now || ''),
    { tz: stats.body.timezone, local: stats.body.local_now });
  ok('and whether the reminders are actually scheduled',
    stats.body.reminders_scheduled === true,
    { scheduled: stats.body.reminders_scheduled,
      note: 'pg_cron job splittywise-settle-reminders must exist and be active' });

  const badTz = await A.api.rpc('admin_set_timezone', { p_tz: 'Mars/Olympus' });
  ok('a timezone Postgres does not know is refused', !badTz.ok, badTz.body);

  const goodTz = await A.api.rpc('admin_set_timezone', { p_tz: stats.body.timezone });
  ok('and a real one is accepted', goodTz.ok && goodTz.body &&
    goodTz.body.tz === stats.body.timezone, goodTz.body);

  /* =================================================================== */
  section('the deployed functions');

  const site = process.env.SITE_URL;
  if (!site) {
    skip('signup-check answers', 'SITE_URL not set');
    skip('the email test sends', 'SITE_URL not set');
    skip('the receipt reader says whether it is configured', 'SITE_URL not set');
  } else {
    const chk = await fetch(site + '/.netlify/functions/signup-check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'anyone-' + stamp + '@example.com' }),
    }).then((r) => r.json()).catch((e) => ({ error: String(e) }));
    ok('signup-check answers', chk && typeof chk.allowed === 'boolean', chk);

    const mail = await fetch(site + '/.netlify/functions/email-test', {
      method: 'POST', headers: { Authorization: 'Bearer ' + A.token },
    });
    const mailBody = await mail.json().catch(() => ({}));
    if (mail.status === 501) {
      skip('the email test sends', 'email is not configured on this deploy');
    } else {
      ok('the email test sends to the caller only',
        mail.ok && mailBody.sentTo === A_EMAIL, { status: mail.status, body: mailBody });
    }

    // The scanner asks this before it draws anything, so that it can say
    // truthfully whether the picture stays on the phone. A deploy where this
    // 404s would have the scanner claim on-device reading and be right, so
    // the failure that matters is this answering something unreadable.
    const reader = await fetch(site + '/.netlify/functions/scan');
    const readerBody = await reader.json().catch(() => ({}));
    ok('the receipt reader says whether it is configured',
      reader.ok && typeof readerBody.ready === 'boolean',
      { status: reader.status, body: readerBody });

    // microphone=() disables it for every origin including ours, so the
    // browser refuses without ever prompting. Checked on the served header,
    // because that is the thing that actually reaches a phone.
    const head = await fetch(site + '/', { method: 'GET' });
    const pp = head.headers.get('permissions-policy') || '';
    ok('the served headers allow this origin to use the microphone',
      /microphone=\(self\)/.test(pp), pp);
    ok('and still deny geolocation outright', /geolocation=\(\)/.test(pp), pp);

    const noTok = await fetch(site + '/.netlify/functions/admin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'whoami' }),
    });
    ok('the admin function refuses an unsigned request', noTok.status === 401,
      { status: noTok.status });
  }
} catch (err) {
  failed++;
  failures.push('the run itself threw');
  console.log('\n  THREW  ' + (err && err.stack ? err.stack.split('\n')[0] : err));
} finally {
  section('cleaning up');
  // Deleting the accounts cascades their groups, expenses, splits, payments,
  // notifications and categories away.
  const removals = [];
  for (const [u, name] of [[A, 'the payer'], [B, 'the person who settled up'], [C, 'the invitee']]) {
    if (u && u.id) removals.push(await removeUser(u.id, name));
  }
  await removeUser(signupId);
  if (removals.length) {
    ok('every test account deleted cleanly', removals.every(Boolean), removals);
  }
  await api('/rest/v1/error_reports?message=like.E2E*', { method: 'DELETE', headers: svcHead })
    .catch(() => {});
  await api('/rest/v1/profiles?email=like.e2e-*', { method: 'DELETE', headers: svcHead })
    .catch(() => {});

  const left = await api('/rest/v1/profiles?email=like.e2e-*&select=email',
    { headers: svcHead });
  // This is the check that caught six foreign keys with no ON DELETE action:
  // deleting an account that had settled up simply failed, and the profile
  // stayed behind.
  ok('deleting the accounts really removed them, settlements and all',
    Array.isArray(left.body) && left.body.length === 0, left.body);

  console.log('\n' + (passed + failed) + ' checks · ' + passed + ' passed · ' +
    failed + ' failed' + (skipped ? ' · ' + skipped + ' skipped' : ''));
  if (failed) console.log('\nfailed:\n  - ' + failures.join('\n  - '));
  process.exit(failed ? 1 : 0);
}
