// ---------------------------------------------------------------------------
//  Sending one email, through Brevo
//
//  Shared by the notification function and the admin function rather than
//  copied into both. Lives outside netlify/functions/ on purpose: a folder
//  inside that directory can be mistaken for another function.
//
//  Brevo's free tier is 300 a day and, unlike Resend, needs no domain of
//  your own — just one verified sender address. Returns a plain result
//  rather than throwing, because both callers want to report the reason.
// ---------------------------------------------------------------------------

export function mailConfigured() {
  return !!(process.env.BREVO_API_KEY && process.env.EMAIL_FROM);
}

export function shell(title, body, action) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;' +
    'max-width:520px;margin:0 auto;padding:24px;color:#141817">' +
      '<p style="font-size:12px;letter-spacing:.09em;text-transform:uppercase;' +
        'color:#7C8D86;margin:0 0 14px">SplittyWise</p>' +
      '<h1 style="font-size:20px;line-height:1.35;margin:0 0 8px">' +
        esc(title) + '</h1>' +
      (body ? '<p style="font-size:15px;color:#4B5B55;margin:0 0 20px">' +
        esc(body) + '</p>' : '') +
      (action
        ? '<p style="margin:0 0 24px"><a href="' + esc(action.href) +
          '" style="display:inline-block;background:#1FC69E;color:#08201B;' +
          'text-decoration:none;font-weight:700;padding:11px 18px;' +
          'border-radius:12px">' + esc(action.label) + '</a></p>' +
          // Repeated as text, because some mail clients strip the button and
          // a link you cannot copy is no link at all.
          '<p style="font-size:12px;color:#7C8D86;word-break:break-all;' +
            'margin:0 0 20px">' + esc(action.href) + '</p>'
        : '') +
      '<p style="font-size:12.5px;color:#7C8D86;margin:0;border-top:' +
        '1px solid #DCE4E1;padding-top:14px">Sent by SplittyWise.</p>' +
    '</div>';
}

export async function sendMail({ to, name, subject, html, text }) {
  const { BREVO_API_KEY, EMAIL_FROM, EMAIL_FROM_NAME } = process.env;
  if (!BREVO_API_KEY || !EMAIL_FROM) {
    return { ok: false, reason: 'BREVO_API_KEY or EMAIL_FROM is not set' };
  }

  let res;
  try {
    res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { email: EMAIL_FROM, name: EMAIL_FROM_NAME || 'SplittyWise' },
        to: [{ email: to, name: name || undefined }],
        subject: subject,
        htmlContent: html,
        textContent: text || subject,
      }),
    });
  } catch (err) {
    return { ok: false, reason: 'Could not reach Brevo: ' + (err.message || err) };
  }

  if (!res.ok) {
    // Brevo's own message, verbatim — a spent quota should be findable
    // rather than reduced to "sending failed".
    return { ok: false, reason: 'Brevo said ' + res.status + ': ' +
             (await res.text().catch(() => '')).slice(0, 300) };
  }
  return { ok: true };
}

// The site's real address, taken from the request rather than trusted from
// configuration. APP_URL set to the README's example — your-site.netlify.app
// — produced emails whose links went nowhere, and nothing could detect that.
// A configured value still wins when it looks like a real URL, so a custom
// domain keeps working.
export function siteUrl(request) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const looksReal = /^https?:\/\//.test(configured) &&
    !/your-site|example\.com|YOUR-|localhost/i.test(configured);
  if (looksReal) return configured;
  try {
    return new URL(request.url).origin;
  } catch (e) {
    return configured || '';
  }
}
