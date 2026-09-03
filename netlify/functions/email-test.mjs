// ---------------------------------------------------------------------------
//  "Send me a test email"
//
//  Email notifications are easy to think broken when they are working. The
//  function skips your own actions on purpose — so adding an expense
//  yourself produces an Activity row and no email, which looks exactly like
//  a misconfiguration. This proves the pipeline in one tap.
//
//  Its own function rather than an action on notify-email, which is driven
//  by a database webhook: mixing a webhook path and a user-authenticated
//  path in one entry point is how the wrong one ends up trusted.
//
//  Sends only to the caller's own registered address, never to one supplied
//  in the request, so this cannot be turned into a way to mail strangers.
// ---------------------------------------------------------------------------

import { sendMail, shell, mailConfigured } from '../lib/mail.mjs';

export default async (request) => {
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!bearer) return json({ error: 'Not signed in' }, 401);

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, APP_URL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: 'This deploy is not configured for email. See README 4.7.' }, 501);
  }
  if (!mailConfigured()) {
    return json({
      error: 'BREVO_API_KEY and EMAIL_FROM are not set in Netlify. See README 4.7.',
    }, 501);
  }

  const base = SUPABASE_URL.replace(/\/+$/, '');

  const who = await fetch(base + '/auth/v1/user', {
    headers: {
      apikey: SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + bearer,
    },
  });
  if (!who.ok) return json({ error: 'Your session has expired — sign in again' }, 401);

  const me = await who.json();
  if (!me || !me.email) return json({ error: 'Could not identify you' }, 401);

  const appUrl = (APP_URL || '').replace(/\/+$/, '');
  const sent = await sendMail({
    to: me.email,
    subject: 'SplittyWise email notifications are working',
    html: shell(
      'This is a test',
      'If you are reading this, email notifications are set up correctly. ' +
      'You will get one when somebody adds an expense that involves you, ' +
      'records a payment, nudges you, or adds you to a group — at most one ' +
      'every fifteen minutes. Not for anything you do yourself.',
      appUrl ? { href: appUrl + '/#/activity', label: 'Open SplittyWise' } : null),
    text: 'If you are reading this, SplittyWise email notifications are ' +
          'set up correctly. You will not get one for your own actions.',
  });

  if (!sent.ok) return json({ error: sent.reason }, 502);
  return json({ ok: true, sentTo: me.email });
};

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
