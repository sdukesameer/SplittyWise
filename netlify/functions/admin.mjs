// ---------------------------------------------------------------------------
//  Admin operations that need the service_role key
//
//  Everything the admin panel can do with the *database* it does directly
//  from the browser, through the admin_* functions in schema.sql, using the
//  admin's own token. Those are security definer and check is_admin on their
//  first line, so they need nothing privileged in the page.
//
//  This function exists only for the things that touch Supabase's own auth
//  tables, which no SQL policy can reach: blocking an account from logging
//  in, creating one, resetting a password, ending somebody's sessions, and
//  generating a sign-in link to act as them.
//
//  The service_role key bypasses every RLS policy, so it lives here, in
//  Netlify's environment, and never in anything the browser downloads.
//
//  Authorisation, in order:
//    1. the caller's own Supabase access token must be valid
//    2. that account must have profiles.is_admin = true
//    3. the action must be one of the ones listed below
//  Every accepted call is written to admin_audit before it returns.
// ---------------------------------------------------------------------------

const ACTIONS = new Set([
  'ban', 'unban', 'create-user', 'invite-user', 'reset-password',
  'sign-out-everywhere', 'delete-user', 'act-as', 'whoami',
]);

// Long enough to be effectively permanent; unban clears it outright.
const BAN_DURATION = '876000h';   // a hundred years

export default async (request) => {
  if (request.method !== 'POST') {
    return json({ error: 'POST only' }, 405);
  }

  // Anyone at all can POST to this URL, so the cheapest test that needs no
  // configuration comes first: is a token even presented? Reporting the
  // deployment's configuration state to an anonymous caller told them
  // something they have no business knowing.
  const bearer = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!bearer) return json({ error: 'Not signed in' }, 401);

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
    return json({ error: 'This deploy has no admin credentials configured. See README 12.' }, 501);
  }

  const base = SUPABASE_URL.replace(/\/+$/, '');
  const svc = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
  };

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: 'Expected a JSON body' }, 400);
  }

  const action = String(body.action || '');
  if (!ACTIONS.has(action)) return json({ error: 'Unknown action' }, 400);

  // ---- 1. who is asking ---------------------------------------------------
  const meRes = await fetch(base + '/auth/v1/user', {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + bearer },
  });
  if (!meRes.ok) return json({ error: 'Your session has expired — sign in again' }, 401);
  const me = await meRes.json();
  if (!me || !me.id) return json({ error: 'Could not identify you' }, 401);

  // ---- 2. are they an admin ----------------------------------------------
  const profRes = await fetch(
    base + '/rest/v1/profiles?id=eq.' + encodeURIComponent(me.id) +
    '&select=is_admin,email', { headers: svc });
  const prof = profRes.ok ? (await profRes.json())[0] : null;

  if (!prof || prof.is_admin !== true) {
    // Deliberately the same message either way: whether an address is an
    // admin is not something an outsider needs confirmed.
    return json({ error: 'Not an administrator' }, 403);
  }

  if (action === 'whoami') {
    return json({ ok: true, email: prof.email, id: me.id });
  }

  const log = (act, detail, targetEmail, targetId) =>
    fetch(base + '/rest/v1/admin_audit', {
      method: 'POST',
      headers: Object.assign({}, svc, { Prefer: 'return=minimal' }),
      body: JSON.stringify({
        actor_id: me.id, actor_email: prof.email || '', action: act,
        target_email: targetEmail || null, target_id: targetId || null,
        detail: detail || {},
      }),
    }).catch(() => {});

  // Resolve an email to an auth user, which is what every action needs.
  const findUser = async (email) => {
    const addr = String(email || '').trim().toLowerCase();
    if (!addr) return null;
    const r = await fetch(
      base + '/auth/v1/admin/users?page=1&per_page=200&filter=' + encodeURIComponent(addr),
      { headers: svc });
    if (!r.ok) return null;
    const list = await r.json();
    const users = list.users || [];
    return users.filter((u) => (u.email || '').toLowerCase() === addr)[0] || null;
  };

  const email = String(body.email || '').trim().toLowerCase();

  try {
    switch (action) {

      // ---- blocking an account -------------------------------------------
      //
      // Two halves, and both matter. The banned_emails row is what stops a
      // NEW account being created with this address (the signup trigger
      // reads it). banned_until on the auth user is what stops the EXISTING
      // account logging in. One without the other leaves a way through.
      case 'ban': {
        if (!email) return json({ error: 'Which email?' }, 400);
        if (email === (prof.email || '').toLowerCase()) {
          return json({ error: 'You cannot block your own account.' }, 400);
        }

        const target = await findUser(email);
        if (target) {
          const other = await fetch(base + '/rest/v1/profiles?id=eq.' + target.id +
            '&select=is_admin', { headers: svc });
          const row = other.ok ? (await other.json())[0] : null;
          if (row && row.is_admin) {
            return json({ error: 'Remove their admin rights first.' }, 400);
          }
        }

        await fetch(base + '/rest/v1/banned_emails', {
          method: 'POST',
          headers: Object.assign({}, svc, {
            Prefer: 'return=minimal,resolution=merge-duplicates',
          }),
          body: JSON.stringify({
            email, reason: String(body.reason || '').slice(0, 200) || null,
            banned_by: me.id,
          }),
        });

        let existing = false;
        if (target) {
          existing = true;
          await fetch(base + '/auth/v1/admin/users/' + target.id, {
            method: 'PUT', headers: svc,
            body: JSON.stringify({ ban_duration: BAN_DURATION }),
          });
          // An access token already issued stays valid for its hour, so the
          // sessions have to be ended too or the ban waits for expiry.
          await fetch(base + '/auth/v1/admin/users/' + target.id + '/logout', {
            method: 'POST', headers: svc,
          }).catch(() => {});
        }

        await log('banned', { reason: body.reason || null, had_account: existing },
                  email, target && target.id);
        return json({
          ok: true,
          message: existing
            ? 'Blocked, signed out of every device, and cannot sign up again.'
            : 'Blocked. There is no account with that address yet, so this stops one being created.',
        });
      }

      case 'unban': {
        if (!email) return json({ error: 'Which email?' }, 400);

        await fetch(base + '/rest/v1/banned_emails?email=eq.' + encodeURIComponent(email), {
          method: 'DELETE', headers: svc,
        });

        const target = await findUser(email);
        if (target) {
          await fetch(base + '/auth/v1/admin/users/' + target.id, {
            method: 'PUT', headers: svc,
            body: JSON.stringify({ ban_duration: 'none' }),
          });
        }

        await log('unbanned', {}, email, target && target.id);
        return json({ ok: true, message: 'Unblocked. They can sign in again.' });
      }

      // ---- creating an account for somebody ------------------------------
      case 'create-user': {
        if (!email) return json({ error: 'Which email?' }, 400);
        const password = String(body.password || '');
        if (password.length < 8) {
          return json({ error: 'Give them a password of at least 8 characters.' }, 400);
        }

        // Written first, so invite-only mode does not block the admin's own
        // creation. Harmless when invite-only is off.
        await fetch(base + '/rest/v1/allowed_emails', {
          method: 'POST',
          headers: Object.assign({}, svc, {
            Prefer: 'return=minimal,resolution=merge-duplicates',
          }),
          body: JSON.stringify({ email, note: 'created by an admin', added_by: me.id }),
        });

        const made = await fetch(base + '/auth/v1/admin/users', {
          method: 'POST', headers: svc,
          body: JSON.stringify({
            email, password, email_confirm: true,
            user_metadata: { full_name: String(body.full_name || '').slice(0, 80) || undefined },
          }),
        });
        const madeBody = await made.json();
        if (!made.ok) {
          return json({ error: madeBody.msg || madeBody.message || 'Could not create them' }, 400);
        }

        await log('user_created', { confirmed: true }, email, madeBody.id);
        return json({ ok: true, message: 'Created, with the email already confirmed.' });
      }

      case 'invite-user': {
        if (!email) return json({ error: 'Which email?' }, 400);
        await fetch(base + '/rest/v1/allowed_emails', {
          method: 'POST',
          headers: Object.assign({}, svc, {
            Prefer: 'return=minimal,resolution=merge-duplicates',
          }),
          body: JSON.stringify({ email, note: 'invited by an admin', added_by: me.id }),
        });

        const sent = await fetch(base + '/auth/v1/invite', {
          method: 'POST', headers: svc, body: JSON.stringify({ email }),
        });
        const sentBody = await sent.json().catch(() => ({}));
        if (!sent.ok) {
          return json({
            error: (sentBody.msg || sentBody.message || 'Could not invite them') +
              ' — Supabase caps invite mail sharply on the free tier.',
          }, 400);
        }

        await log('user_invited', {}, email, sentBody.id);
        return json({ ok: true, message: 'Invited. Tell them to check their spam folder.' });
      }

      case 'reset-password': {
        if (!email) return json({ error: 'Which email?' }, 400);
        const link = await fetch(base + '/auth/v1/admin/generate_link', {
          method: 'POST', headers: svc,
          body: JSON.stringify({ type: 'recovery', email }),
        });
        const linkBody = await link.json();
        if (!link.ok) {
          return json({ error: linkBody.msg || 'Could not make a reset link' }, 400);
        }
        await log('password_reset_link', {}, email, linkBody.id);
        // Returned rather than emailed, so it works even with mail throttled.
        return json({ ok: true, link: linkBody.action_link,
                      message: 'Send them this link yourself. It is single use.' });
      }

      case 'sign-out-everywhere': {
        const target = await findUser(email);
        if (!target) return json({ error: 'No account with that address' }, 404);
        await fetch(base + '/auth/v1/admin/users/' + target.id + '/logout', {
          method: 'POST', headers: svc,
        });
        await log('sessions_revoked', {}, email, target.id);
        return json({ ok: true, message: 'Signed out on every device.' });
      }

      // ---- acting as somebody --------------------------------------------
      //
      // This is the honest form of "log in as anyone": a single-use sign-in
      // link for their account. Following it replaces YOUR session with
      // theirs in this browser — you are them until you sign out — which is
      // why the panel says so before handing it over. Recorded either way.
      case 'act-as': {
        if (!email) return json({ error: 'Which email?' }, 400);
        if (email === (prof.email || '').toLowerCase()) {
          return json({ error: 'That is already you.' }, 400);
        }
        const link = await fetch(base + '/auth/v1/admin/generate_link', {
          method: 'POST', headers: svc,
          body: JSON.stringify({ type: 'magiclink', email }),
        });
        const linkBody = await link.json();
        if (!link.ok) {
          return json({ error: linkBody.msg || 'Could not make a sign-in link' }, 400);
        }
        await log('acted_as', { note: 'a sign-in link was generated' }, email, linkBody.id);
        return json({
          ok: true, link: linkBody.action_link,
          message: 'Opening this signs this browser in as them, replacing your own session.',
        });
      }

      // ---- deleting an account -------------------------------------------
      case 'delete-user': {
        if (!email) return json({ error: 'Which email?' }, 400);
        if (email === (prof.email || '').toLowerCase()) {
          return json({ error: 'You cannot delete your own account here.' }, 400);
        }
        const target = await findUser(email);
        if (!target) return json({ error: 'No account with that address' }, 404);

        // Logged BEFORE the delete: admin_audit.actor_id survives, but
        // afterwards there would be nothing left to name as the target.
        await log('user_deleted', { note: 'expenses and groups cascade away' },
                  email, target.id);

        const gone = await fetch(base + '/auth/v1/admin/users/' + target.id, {
          method: 'DELETE', headers: svc,
        });
        if (!gone.ok) {
          const err = await gone.json().catch(() => ({}));
          return json({ error: err.msg || 'Could not delete them' }, 400);
        }
        return json({ ok: true, message: 'Deleted, along with everything of theirs.' });
      }

      default:
        return json({ error: 'Unknown action' }, 400);
    }
  } catch (err) {
    return json({ error: 'That failed: ' + (err.message || String(err)) }, 500);
  }
};

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
