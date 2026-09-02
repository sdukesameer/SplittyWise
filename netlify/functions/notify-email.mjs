// ---------------------------------------------------------------------------
//  Email notifications
//
//  Supabase's own SMTP is for authentication mail only, and the free tier
//  rate-limits it to a couple of messages an hour, so it cannot carry app
//  notifications. This function does, for nothing, through Brevo's free
//  tier (300 emails a day, no domain of your own required).
//
//  Wiring: a Supabase Database Webhook on INSERT into public.notifications
//  POSTs the new row here, and this decides whether it is worth an email.
//  The API key lives in Netlify's environment, never in the database.
//
//  Setup is in README section 4.7. Without the environment variables set
//  this function replies 204 and does nothing, so an unconfigured deploy is
//  harmless rather than broken.
//
//  Deliberately conservative about what it sends. An app that emails on
//  every event trains people to filter it, which loses the ones that
//  mattered — so: only events about money, never your own actions, and at
//  most one email per person every fifteen minutes.
// ---------------------------------------------------------------------------

const WORTH_AN_EMAIL = new Set([
  'expense_added',
  'settlement',
  'nudge',
  'settle_reminder',
  'friend_added',
  'group_added',
]);

const QUIET_MINUTES = 15;

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('POST only', { status: 405 });
  }

  const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    BREVO_API_KEY,
    EMAIL_FROM,
    EMAIL_FROM_NAME,
    WEBHOOK_SECRET,
    APP_URL,
  } = process.env;

  // Not configured yet: succeed quietly so the webhook does not retry.
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !BREVO_API_KEY || !EMAIL_FROM) {
    return new Response(null, { status: 204 });
  }

  // The webhook is a public URL, so it needs to prove who it is. Anyone
  // could otherwise make this app email arbitrary addresses.
  if (!WEBHOOK_SECRET || request.headers.get('x-webhook-secret') !== WEBHOOK_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }

  let row;
  try {
    const payload = await request.json();
    row = payload.record;
  } catch (e) {
    return new Response('Bad payload', { status: 400 });
  }
  if (!row || !row.user_id) return new Response(null, { status: 204 });

  // A row that arrives already read is the actor's own action, recorded for
  // their feed. Emailing someone about what they just did is noise.
  if (row.is_read) return new Response(null, { status: 204 });
  if (!WORTH_AN_EMAIL.has(row.type)) return new Response(null, { status: 204 });

  const rest = SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1';
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };

  const who = await fetch(
    rest + '/profiles?id=eq.' + encodeURIComponent(row.user_id) +
    '&select=email,full_name,notify_prefs,email_notify,last_email_at',
    { headers }
  );
  if (!who.ok) return new Response('Lookup failed', { status: 502 });

  const profile = (await who.json())[0];
  if (!profile || !profile.email) return new Response(null, { status: 204 });

  // Opt-in, and the same per-type switches that govern the in-app bell.
  if (profile.email_notify !== true) return new Response(null, { status: 204 });
  if ((profile.notify_prefs || {})[row.type] === false) {
    return new Response(null, { status: 204 });
  }

  if (profile.last_email_at) {
    const since = Date.now() - new Date(profile.last_email_at).getTime();
    if (since < QUIET_MINUTES * 60 * 1000) {
      return new Response(null, { status: 204 });
    }
  }

  const appUrl = (APP_URL || '').replace(/\/+$/, '');
  const deepLink = appUrl +
    (row.expense_id ? '/#/expense/' + row.expense_id
      : row.group_id ? '/#/group/' + row.group_id
      : '/#/activity');

  const escape = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const sent = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { email: EMAIL_FROM, name: EMAIL_FROM_NAME || 'SplittyWise' },
      to: [{ email: profile.email, name: profile.full_name || undefined }],
      subject: row.title,
      htmlContent:
        '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;' +
        'max-width:520px;margin:0 auto;padding:24px;color:#141817">' +
          '<p style="font-size:12px;letter-spacing:.09em;text-transform:uppercase;' +
            'color:#7C8D86;margin:0 0 14px">SplittyWise</p>' +
          '<h1 style="font-size:20px;line-height:1.35;margin:0 0 8px">' +
            escape(row.title) + '</h1>' +
          (row.body
            ? '<p style="font-size:15px;color:#4B5B55;margin:0 0 20px">' +
              escape(row.body) + '</p>'
            : '') +
          (appUrl
            ? '<p style="margin:0 0 24px"><a href="' + escape(deepLink) +
              '" style="display:inline-block;background:#1FC69E;color:#08201B;' +
              'text-decoration:none;font-weight:700;padding:11px 18px;' +
              'border-radius:12px">Open it in SplittyWise</a></p>'
            : '') +
          '<p style="font-size:12.5px;color:#7C8D86;margin:0;border-top:' +
            '1px solid #DCE4E1;padding-top:14px">You are getting this because ' +
            'email notifications are on in your SplittyWise account. Turn them ' +
            'off under Account → Notifications.</p>' +
        '</div>',
      textContent: row.title + (row.body ? '\n\n' + row.body : '') +
        (appUrl ? '\n\n' + deepLink : ''),
    }),
  });

  if (!sent.ok) {
    // Surfaced in the Netlify function log rather than silently swallowed —
    // a quota that ran out should be findable.
    return new Response('Brevo said ' + sent.status + ': ' + (await sent.text()),
      { status: 502 });
  }

  // Stamping this only on a successful send means a failed one does not eat
  // somebody's quiet window.
  await fetch(rest + '/profiles?id=eq.' + encodeURIComponent(row.user_id), {
    method: 'PATCH',
    headers: Object.assign({}, headers, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ last_email_at: new Date().toISOString() }),
  });

  return new Response(null, { status: 204 });
};
