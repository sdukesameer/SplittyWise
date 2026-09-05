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

// The look of every email the app sends.
//
// Built out of tables with inline styles, which is not how anybody writes
// HTML any more and is exactly how mail clients still want it: Outlook lays
// out tables, ignores a <style> block, and does not know border-radius. So
// the card degrades to a plain box there rather than falling apart.
//
//   shell(title, body, action, lines, opts)
//     lines  strings, or { text, tone } — the middle of the mail, one fact
//            per row, because a settle-up reminder read as a paragraph runs
//            together and a reminder that is not skimmable is not a reminder
//     opts   { kicker, hero: { label, value, tone }, note }
//
// Money is coloured the way the app colours it: green when you are up,
// orange when you are down. Which way round is worked out from the wording,
// all of which this app writes itself.
const INK = '#141817';
const MUTED = '#6B7A74';
const FAINT = '#93A29B';
const RULE = '#E3EAE7';
const PAPER = '#FFFFFF';
const GROUND = '#F4F7F5';
const GOOD = '#0F8657';      // --owed
const OWE = '#C9431A';       // --owe
const BRAND = '#1FC69E';

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto," +
             "'Helvetica Neue',Arial,sans-serif";

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Only the first person is coloured. "Md Sameer is owed ₹600" on a reminder
// is context about somebody else, and painting that red would say the reader
// is down when they are not.
function toneOf(text) {
  if (/\b(?:you owe|you borrowed|you paid|amount due)\b/i.test(text)) return OWE;
  if (/\b(?:you are owed|you lent|you received|owes you|owe you)\b/i.test(text)) return GOOD;
  return null;
}

function toneClass(colour) {
  return colour === OWE ? 'm-owe' : colour === GOOD ? 'm-good' : 'm-muted';
}

// Split a row into what it is and what it came to, so the money is picked
// out of "Electricity July (Aug 1) — you lent ₹1,139" without the row having
// to arrive pre-chopped.
function verdict(text) {
  const m = String(text).match(
    /^(.*?)(?:[—–-]\s*)?((?:you (?:owe|are owed|lent|borrowed|received|paid)|owes? you|is owed|are square)\b.*)$/i);
  if (!m || !m[1].trim()) return { head: String(text), tail: '' };
  return { head: m[1].replace(/[\s—–-]+$/, ''), tail: m[2] };
}

function row(line, first) {
  const text = typeof line === 'string' ? line : String(line && line.text || '');
  const forced = line && line.tone;
  const parts = verdict(text);
  const tone = forced || toneOf(parts.tail || text);

  return '<tr><td style="padding:' + (first ? '0' : '10px') + ' 0 0">' +
      '<div class="m-ink" style="font-family:' + FONT + ';font-size:15px;' +
        'line-height:1.45;color:' + INK + ';font-weight:600">' +
        esc(parts.head) + '</div>' +
      (parts.tail
        ? '<div class="' + toneClass(tone) + '" style="font-family:' + FONT + ';' +
          'font-size:15px;line-height:1.5;color:' + (tone || MUTED) +
          ';font-weight:' + (tone ? '700' : '400') + ';padding-top:1px">' +
          esc(parts.tail) + '</div>'
        : '') +
    '</td></tr>';
}

export function shell(title, body, action, lines, opts) {
  opts = opts || {};
  const hero = opts.hero;

  const card =
    (opts.kicker
      ? '<p class="m-faint" style="font-family:' + FONT + ';font-size:11.5px;' +
        'letter-spacing:.1em;text-transform:uppercase;color:' + FAINT + ';' +
        'margin:0 0 10px;font-weight:700">' + esc(opts.kicker) + '</p>'
      : '') +
    '<h1 class="m-ink" style="font-family:' + FONT + ';font-size:21px;' +
      'line-height:1.3;margin:0;color:' + INK + ';font-weight:800">' +
      esc(title) + '</h1>' +
    (body
      ? '<p class="m-muted" style="font-family:' + FONT + ';font-size:15px;' +
        'line-height:1.55;color:' + MUTED + ';margin:10px 0 0">' +
        esc(body) + '</p>'
      : '') +

    // One figure, large, when the mail is really about a single number —
    // a payment recorded, a month's position.
    (hero
      ? '<table role="presentation" cellpadding="0" cellspacing="0" border="0" ' +
          'width="100%" style="margin:18px 0 0"><tr><td align="center" ' +
          'class="m-well" style="background:' + GROUND + ';border-radius:12px;' +
          'padding:18px 14px">' +
          (hero.label
            ? '<div class="m-muted" style="font-family:' + FONT + ';' +
              'font-size:12.5px;color:' + MUTED + ';padding-bottom:4px">' +
              esc(hero.label) + '</div>'
            : '') +
          '<div class="' +
            (hero.tone === 'owe' ? 'm-owe' : hero.tone === 'good' ? 'm-good' : 'm-ink') +
            '" style="font-family:' + FONT + ';font-size:27px;font-weight:800;' +
            'color:' + (hero.tone === 'owe' ? OWE : hero.tone === 'good' ? GOOD : INK) +
            '">' + esc(hero.value) + '</div>' +
        '</td></tr></table>'
      : '') +

    (lines && lines.length
      ? '<table role="presentation" cellpadding="0" cellspacing="0" border="0" ' +
          'width="100%" class="m-rule" style="margin:18px 0 0;' +
          'border-top:1px solid ' + RULE + ';padding-top:4px">' +
        lines.map(function (l, i) { return row(l, i === 0); }).join('') +
        '</table>'
      : '') +

    (action
      ? '<table role="presentation" cellpadding="0" cellspacing="0" border="0" ' +
          'style="margin:22px 0 0"><tr><td style="background:' + BRAND + ';' +
          'border-radius:12px"><a href="' + esc(action.href) + '" ' +
          'style="display:inline-block;font-family:' + FONT + ';font-size:15px;' +
          'font-weight:700;color:#08201B;text-decoration:none;padding:13px 22px">' +
          esc(action.label) + '</a></td></tr></table>' +
        // Repeated as text, because some clients strip the button and a link
        // you cannot copy is no link at all.
        '<p class="m-faint" style="font-family:' + FONT + ';font-size:11.5px;' +
          'color:' + FAINT + ';word-break:break-all;margin:12px 0 0">' +
          esc(action.href) + '</p>'
      : '');

  const doc =
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" ' +
      'width="100%" class="m-ground" style="background:' + GROUND + ';margin:0;padding:0">' +
    '<tr><td align="center" style="padding:26px 12px">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" ' +
        'width="520" style="width:520px;max-width:520px">' +

        '<tr><td style="padding:0 4px 14px">' +
          '<span class="m-ink" style="font-family:' + FONT + ';font-size:15px;' +
            'font-weight:800;letter-spacing:-.01em;color:' + INK + '">Splitty' +
            '<span style="color:' + BRAND + '">Wise</span></span>' +
        '</td></tr>' +

        '<tr><td class="m-card" style="background:' + PAPER + ';border:1px solid ' +
          RULE + ';border-radius:16px;padding:26px 24px">' + card + '</td></tr>' +

        (opts.note
          ? '<tr><td class="m-muted" style="padding:16px 6px 0;font-family:' +
            FONT + ';font-size:12.5px;line-height:1.55;color:' + MUTED + '">' +
            esc(opts.note) + '</td></tr>'
          : '') +

        '<tr><td class="m-faint" style="padding:16px 6px 0;font-family:' + FONT +
          ';font-size:11.5px;line-height:1.6;color:' + FAINT + '">' +
          'Sent by SplittyWise, which is one person&rsquo;s copy of Splitwise ' +
          'and not Splitwise. Nobody else is emailed about your ledger.' +
        '</td></tr>' +

      '</table>' +
    '</td></tr></table>';

  // A full document, for two reasons the preview made obvious.
  //
  // charset: without it a client that ignores the MIME header decodes UTF-8
  // as Latin-1, and every ₹ in the mail becomes "â‚¹". The amounts are the
  // point of these emails.
  //
  // The dark block: this is read in a dark inbox. Clients that understand
  // prefers-color-scheme get the app's own dark palette rather than the
  // client's guess at inverting a white card; those that strip <style> —
  // Gmail among them — keep the inline light styling, which is why every
  // colour is still set inline as well.
  return '<!doctype html><html><head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light dark">' +
    '<meta name="supported-color-schemes" content="light dark">' +
    '<title>' + esc(title) + '</title>' +
    '<style>' +
      '@media (prefers-color-scheme: dark){' +
        '.m-ground{background:#0F1513!important}' +
        '.m-card{background:#171E1B!important;border-color:#2A342F!important}' +
        '.m-ink{color:#EAF2EE!important}' +
        '.m-muted{color:#9DACA5!important}' +
        '.m-faint{color:#7C8A84!important}' +
        '.m-well{background:#111815!important}' +
        '.m-rule{border-top-color:#2A342F!important}' +
        // The app's own dark-mode --owed and --owe, which are lighter so they
        // hold their contrast on a dark ground.
        '.m-good{color:#35C88A!important}' +
        '.m-owe{color:#FF7A4D!important}' +
      '}' +
    '</style></head>' +
    '<body style="margin:0;padding:0;background:' + GROUND + '">' + doc + '</body></html>';
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
