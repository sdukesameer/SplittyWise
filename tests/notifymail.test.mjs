// Run from the repo root:  node tests/notifymail.test.mjs
//
// The webhook that turns a notification into an email, actually run. Whether
// a mail goes out was decided by a fifteen-minute quiet window, which threw
// away anything that happened to follow something else. It is now decided by
// comparing the mail with the one before it — and that comparison is worth
// executing rather than reading, because getting it wrong either spams
// somebody or silently loses their mail.

let fails = 0;
function check(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label +
    (ok ? '' : '\n         got  ' + g + '\n         want ' + w));
}

Object.assign(process.env, {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  BREVO_API_KEY: 'brevo-key',
  EMAIL_FROM: 'sw@example.com',
  WEBHOOK_SECRET: 'shh',
});

const notify = (await import('../netlify/functions/notify-email.mjs')).default;

const NOTIF = {
  id: 'n-2', user_id: 'u-1', actor_id: 'u-9', type: 'expense_added',
  title: 'Ali added "Groceries"', body: 'Your share is ₹250.00 of ₹500.00',
  group_id: 'g-1', expense_id: 'e-7', is_read: false,
};

// The world the function talks to. `previous` is what the last emailed
// notification was; `claimable` is whether this row is still unclaimed.
function world({ previous = null, claimable = true, brevoOk = true,
                 profile = { email: 'her@example.com', full_name: 'Her',
                             email_notify: true, notify_prefs: {} } } = {}) {
  const seen = { mails: [], claims: [], releases: [], profileStamps: [] };

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;

    if (u.includes('api.brevo.com')) {
      seen.mails.push({ to: body.to[0].email, subject: body.subject, html: body.htmlContent });
      return brevoOk
        ? new Response('{}', { status: 201 })
        : new Response('quota exceeded', { status: 402 });
    }
    if (u.includes('/profiles?id=eq.') && method === 'GET') {
      return new Response(JSON.stringify(profile ? [profile] : []), { status: 200 });
    }
    if (u.includes('/profiles?id=eq.') && method === 'PATCH') {
      seen.profileStamps.push(body);
      return new Response(null, { status: 204 });
    }
    if (u.includes('/notifications?') && u.includes('emailed_at=not.is.null')) {
      return new Response(JSON.stringify(previous ? [previous] : []), { status: 200 });
    }
    if (u.includes('/notifications?') && method === 'PATCH') {
      if (body && body.emailed_at === null) {
        seen.releases.push(u);
        return new Response(null, { status: 204 });
      }
      seen.claims.push(u);
      // The filter is what makes this safe: only one caller can move
      // emailed_at off null, and PostgREST returns the rows it changed.
      return new Response(JSON.stringify(claimable ? [{ id: NOTIF.id }] : []),
        { status: 200 });
    }
    throw new Error('unexpected call: ' + method + ' ' + u);
  };

  return seen;
}

const post = (record, secret = 'shh') => new Request(
  'https://site.netlify.app/.netlify/functions/notify-email',
  { method: 'POST', headers: { 'x-webhook-secret': secret },
    body: JSON.stringify({ type: 'INSERT', record }) });

console.log('--- a notification with nothing before it ---');
let seen = world();
let res = await notify(post(NOTIF));
check('is emailed', seen.mails.length, 1);
check('to the right person', seen.mails[0] && seen.mails[0].to, 'her@example.com');
check('with the notification title as the subject',
  seen.mails[0] && seen.mails[0].subject, NOTIF.title);
check('and the row is claimed first', seen.claims.length, 1);
check('with the claim filtered on emailed_at being null',
  !!(seen.claims[0] || '').includes('emailed_at=is.null'), true);
check('the send is reported as handled', res.status, 204);

console.log('\n--- the same mail as the last one ---');
seen = world({ previous: {
  type: NOTIF.type, title: NOTIF.title, body: NOTIF.body,
  group_id: NOTIF.group_id, expense_id: NOTIF.expense_id,
} });
res = await notify(post(NOTIF));
check('is not sent again', seen.mails.length, 0);
check('and the row is not even claimed', seen.claims.length, 0);
check('reported as handled, not as a failure', res.status, 204);

console.log('\n--- a different mail, minutes after the last one ---');
// The whole point of the change. Under the fifteen-minute rule every one of
// these was dropped for happening to follow something else.
for (const [what, changed] of [
  ['a different expense', { expense_id: 'e-8' }],
  ['a different group', { group_id: 'g-2' }],
  ['a different amount in the body', { body: 'Your share is ₹300.00 of ₹600.00' }],
  ['a different title', { title: 'Ali added "Petrol"' }],
  ['a different kind of news', { type: 'settlement', title: 'Ali paid you ₹500' }],
]) {
  seen = world({ previous: {
    type: NOTIF.type, title: NOTIF.title, body: NOTIF.body,
    group_id: NOTIF.group_id, expense_id: NOTIF.expense_id,
  } });
  await notify(post(Object.assign({}, NOTIF, changed, { id: 'n-3' })));
  check(what + ' is sent', seen.mails.length, 1);
}

console.log('\n--- the same webhook delivered twice ---');
seen = world({ claimable: false });
res = await notify(post(NOTIF));
check('the second delivery sends nothing', seen.mails.length, 0);
check('because the claim found no unclaimed row', seen.claims.length, 1);
check('and it is reported as handled, so it is not retried again', res.status, 204);

console.log('\n--- the mail provider refuses ---');
seen = world({ brevoOk: false });
res = await notify(post(NOTIF));
check('the failure is surfaced, not swallowed', res.status, 502);
check('and the claim is put back, so a retry can try again',
  seen.releases.length, 1);
check('nothing is stamped on the profile', seen.profileStamps.length, 0);

console.log('\n--- what must never be emailed ---');
seen = world();
res = await notify(post(Object.assign({}, NOTIF, { is_read: true })));
check('your own action, which arrives already read', seen.mails.length, 0);

seen = world({ profile: { email: 'her@example.com', email_notify: true,
                          notify_prefs: { expense_added: false } } });
await notify(post(NOTIF));
check('a type the person has muted', seen.mails.length, 0);

seen = world({ profile: { email: 'her@example.com', email_notify: false,
                          notify_prefs: {} } });
await notify(post(NOTIF));
check('anybody who has not opted in at all', seen.mails.length, 0);

seen = world();
await notify(post(Object.assign({}, NOTIF, { type: 'comment' })));
check('a type that is not worth an email', seen.mails.length, 0);

seen = world();
res = await notify(post(NOTIF, 'wrong'));
check('and an unsigned request is refused outright', res.status, 403);
check('having sent nothing', seen.mails.length, 0);

console.log('\n--- unconfigured ---');
const keep = process.env.BREVO_API_KEY;
delete process.env.BREVO_API_KEY;
seen = world();
res = await notify(post(NOTIF));
check('a deploy with no mail set up is quiet, not broken', res.status, 204);
check('and sends nothing', seen.mails.length, 0);
process.env.BREVO_API_KEY = keep;

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
