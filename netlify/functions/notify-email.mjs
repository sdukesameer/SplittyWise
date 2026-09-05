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
//  INSERT only, and enforced here rather than trusted from the dashboard.
//  A notification's content never changes after it is written — the one and
//  only UPDATE it ever sees is mark_all_notifications_read() flipping
//  is_read, so an UPDATE-triggered call carries nothing new to say. It also
//  arrives in bulk: opening the Activity tab with sixty unread rows would
//  fire sixty of them. An expense being *edited* still reaches you, because
//  that writes a brand new notification row of its own.
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

import { sendMail, shell, siteUrl } from '../lib/mail.mjs';

const WORTH_AN_EMAIL = new Set([
  'expense_added',
  // Somebody putting you on an expense costs you money without you
  // doing anything, which is exactly what an email is for.
  'added_to_expense',
  'settlement',
  // A payment being un-recorded moves somebody's balance without them
  // doing anything, which is exactly when an email is worth sending.
  'settlement_undone',
  'nudge',
  'settle_reminder',
  // The month is over and here is where you stand — the one email that is
  // worth sending to somebody who has not opened the app in weeks.
  'month_summary',
  'friend_added',
  'group_added',
  // Only admins ever receive this one, and somebody joining is exactly the
  // sort of thing worth knowing without opening the app.
  'account_created',
]);

const QUIET_MINUTES = 15;

// Types whose body is a "·"-joined set of facts rather than a sentence.
const LISTED = new Set(['settle_reminder', 'month_summary']);

// Types where the heading ends in the one figure the mail is about.
const HERO_FROM_TITLE = new Set(['settlement', 'settlement_undone']);

// The small uppercase label above the heading — what kind of mail this is,
// readable before the sentence is.
const KICKER = {
  settlement: 'Payment recorded',
  settlement_undone: 'Payment undone',
  settle_reminder: 'Settle up',
  month_summary: 'Your month',
  expense_added: 'New expense',
  expense_updated: 'Expense changed',
  added_to_expense: 'You were added',
  expense_deleted: 'Expense deleted',
  comment: 'New comment',
  nudge: 'A nudge',
  friend_added: 'New friend',
  group_added: 'New group',
  account_created: 'New account',
};

// What the button should say, where "open it" is vaguer than it needs to be.
const LABEL = {
  settle_reminder: 'Settle up now',
  month_summary: 'Review your spending',
  settlement: 'See the payment',
  comment: 'Read the comment',
};

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

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response('Bad payload', { status: 400 });
  }

  // Correctness must not depend on how the webhook was ticked in a dashboard.
  // Anything but a new row is nothing to email about — see the note above.
  if (payload.type && payload.type !== 'INSERT') {
    return new Response(null, { status: 204 });
  }

  const row = payload.record;
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

  const appUrl = siteUrl(request);
  const deepLink = appUrl +
    (row.expense_id ? '/#/expense/' + row.expense_id
      : row.group_id ? '/#/group/' + row.group_id
      : '/#/activity');

  // A settle-up reminder or a month's summary is several facts joined by
  // "·" — what you owe, who else is not square, what piled up since. One
  // paragraph makes them run together; a list is read at a glance, which is
  // the whole point of it.
  const lines = String(row.body || '').split(' · ').filter(Boolean);
  const asList = LISTED.has(row.type) && lines.length > 1;

  // Where one figure is the whole point, lift it out of the heading and set
  // it on its own — "Shriyansh paid you" over a green ₹9,847.17, rather than
  // an amount buried in a sentence. The wording is this app's own, written
  // in schema.sql, so reading it back is not guesswork.
  let heading = row.title;
  let hero = null;
  const money = /(₹[\d,]+(?:\.\d{1,2})?)\s*$/;

  if (HERO_FROM_TITLE.has(row.type) && money.test(row.title)) {
    const amount = row.title.match(money)[1];
    const head = row.title.replace(money, '').replace(/[\s—–-]+$/, '');
    if (head) {
      heading = head;
      // Which way the money went, from the reader's side. Only two of these
      // are ever emailed — a person's own copy of their own action arrives
      // already read — but "You recorded a payment from Ali" means money
      // came in, and an earlier rule that matched "recorded" painted it red.
      //
      // An undone payment is left uncoloured: "Ali undid a payment of ₹500"
      // does not say whose payment, so it could have moved the reader either
      // way, and picking a colour would be a guess printed in green.
      const out = /^you paid\b/i.test(head) || /recorded your payment/i.test(head);
      hero = {
        value: amount,
        tone: row.type === 'settlement' ? (out ? 'owe' : 'good') : null,
      };
    }
  } else if (asList && money.test(lines[0])) {
    // A reminder leads with the reader's own position. That is the figure.
    hero = {
      label: lines[0].replace(money, '').replace(/[\s—–-]+$/, ''),
      value: lines[0].match(money)[1],
      tone: /you owe|you borrowed/i.test(lines[0]) ? 'owe' : 'good',
    };
  }

  const detail = asList ? lines.slice(hero && !HERO_FROM_TITLE.has(row.type) ? 1 : 0) : null;

  const sent = await sendMail({
    to: profile.email,
    name: profile.full_name,
    subject: row.title,
    html: shell(
      heading,
      asList ? '' : (row.body || ''),
      appUrl ? { href: deepLink, label: LABEL[row.type] || 'Open it in SplittyWise' } : null,
      detail && detail.length ? detail : null,
      {
        kicker: KICKER[row.type] || null,
        hero: hero,
        note: 'You are getting this because email notifications are on in ' +
              'your SplittyWise account. Turn them off, or pick which ones ' +
              'you want, under Account → Notifications.',
      },
    ),
    text: row.title + (row.body ? '\n\n' + row.body.split(' · ').join('\n') : '') +
          (appUrl ? '\n\n' + deepLink : ''),
  });

  if (!sent.ok) {
    // Surfaced in the Netlify function log rather than silently swallowed —
    // a quota that ran out should be findable.
    return new Response(sent.reason, { status: 502 });
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
