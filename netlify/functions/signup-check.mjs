// ---------------------------------------------------------------------------
//  "May this address create an account?"
//
//  handle_new_user() in schema.sql is the authoritative gate: it runs inside
//  the transaction that creates the user, so raising there means no account.
//  But GoTrue turns a trigger exception into "Database error saving new
//  user", which tells the person nothing.
//
//  So the signup form asks here first, purely to be able to say why. If this
//  is unreachable the form goes ahead and signs up anyway — the trigger
//  still enforces it, and a deploy without this function must not be a
//  deploy where nobody can register.
//
//  It runs server-side because the alternative was an anon-executable SQL
//  function, and "nothing is executable by anon" is a check worth keeping.
// ---------------------------------------------------------------------------

export default async (request) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  // Unconfigured: say yes and let the trigger decide. Failing closed here
  // would lock everyone out of a deploy that simply has no env vars set.
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ allowed: true, unchecked: true });
  }

  let email = '';
  try {
    const body = await request.json();
    email = String(body.email || '').trim().toLowerCase();
  } catch (e) {
    return json({ allowed: true, unchecked: true });
  }
  if (!email) return json({ allowed: true, unchecked: true });

  const base = SUPABASE_URL.replace(/\/+$/, '');
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
  };

  try {
    const [settingsRes, bannedRes, allowedRes] = await Promise.all([
      fetch(base + '/rest/v1/app_settings?select=key,value', { headers }),
      fetch(base + '/rest/v1/banned_emails?email=eq.' + encodeURIComponent(email) +
            '&select=email', { headers }),
      fetch(base + '/rest/v1/allowed_emails?email=eq.' + encodeURIComponent(email) +
            '&select=email', { headers }),
    ]);

    const settings = {};
    if (settingsRes.ok) {
      (await settingsRes.json()).forEach((r) => {
        settings[r.key] = r.value && r.value.enabled === true;
      });
    }

    if (bannedRes.ok && (await bannedRes.json()).length) {
      return json({ allowed: false, reason: 'blocked' });
    }
    if (settings.signups_enabled === false) {
      return json({ allowed: false, reason: 'closed' });
    }
    if (settings.invite_only === true) {
      const allowed = allowedRes.ok && (await allowedRes.json()).length > 0;
      if (!allowed) return json({ allowed: false, reason: 'invite_only' });
    }

    return json({ allowed: true });
  } catch (err) {
    return json({ allowed: true, unchecked: true });
  }
};

function json(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
