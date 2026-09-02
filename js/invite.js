// ---------------------------------------------------------------------------
//  Invite links — share one, and redeem one on the way in
//
//  A link carries a random token, not an encoded user id, so it cannot be
//  forged to make someone your friend without their say. Opening it stores
//  the token; it is redeemed once there is an account to attach it to, which
//  is what makes "open link, sign up, already friends" work.
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const db = SW.db;
  const esc = SW.escapeHtml;
  const KEY = 'splittywise.invite';

  SW.readPendingInvite = function () {
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  };
  SW.storePendingInvite = function (token) {
    try { localStorage.setItem(KEY, token); } catch (e) { /* private mode */ }
  };
  function clearPending() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }

  /* ======================= sharing one =============================== */

  SW.shareInvite = async function (groupId) {
    SW.sheet({
      title: 'Invite with a link',
      rawBody: '<div class="scan-state"><div class="spinner spinner-lg"></div>' +
               '<p>Making a link…</p></div>',
      confirm: null,
      cancel: 'Close',
    });

    const { data, error } = await db.rpc('create_invite', {
      p_group_id: groupId || null,
    });

    const stage = document.getElementById('sheet-content');
    if (!stage) return;   // the sheet was dismissed while we waited

    if (error || !data || !data.ok) {
      stage.innerHTML = '<div class="scan-state"><div class="scan-art">😕</div>' +
        '<h3>Could not make a link</h3><p>' +
        esc((error && error.message) || 'Try again in a moment.') + '</p></div>';
      return;
    }

    const url = window.location.origin + window.location.pathname.replace(/index\.html$/, '') +
                '#/join/' + data.token;
    const group = groupId ? SW.ledger.groups[groupId] : null;

    stage.innerHTML =
      '<div class="sheet-body">' +
        '<p style="color:var(--muted);font-size:14.5px">' +
          (group
            ? 'Anyone who opens this joins <strong style="color:var(--text)">' +
              esc(group.name) + '</strong> and becomes your friend.'
            : 'Anyone who opens this becomes your friend. They can sign up on the ' +
              'way in — the link still works afterwards.') +
        '</p>' +
        '<input class="input" id="inv-url" readonly value="' + esc(url) + '" ' +
               'style="font-size:13px" aria-label="Invite link">' +
        '<span class="hint">Works for 14 days.</span>' +
      '</div>' +
      '<div class="sheet-actions">' +
        (navigator.share
          ? '<button type="button" class="btn btn-primary" id="inv-share">Share the link</button>'
          : '') +
        '<button type="button" class="btn btn-ghost" id="inv-copy">Copy the link</button>' +
      '</div>';

    const copy = document.getElementById('inv-copy');
    copy.addEventListener('click', async function () {
      const field = document.getElementById('inv-url');
      try {
        await navigator.clipboard.writeText(url);
        SW.toast('Link copied', 'ok');
      } catch (e) {
        // Clipboard access is refused in plenty of contexts; selecting the
        // text at least lets them copy it by hand.
        field.focus();
        field.select();
        SW.toast('Press copy on the selected link');
      }
    });

    const share = document.getElementById('inv-share');
    if (share) share.addEventListener('click', function () {
      navigator.share({
        title: 'SplittyWise',
        text: group ? 'Join ' + group.name + ' on SplittyWise' : 'Split expenses with me',
        url: url,
      }).catch(function () { /* dismissed */ });
    });
  };

  /* ======================= redeeming one ============================= */

  // Called once the user is signed in. Safe to call when there is nothing
  // pending, and safe to call twice.
  SW.redeemPendingInvite = async function () {
    const token = SW.readPendingInvite();
    if (!token || !SW.user) return;

    const { data, error } = await db.rpc('redeem_invite', { p_token: token });
    clearPending();

    if (error) return SW.toast('Could not use that invite: ' + error.message, 'error');
    if (!data || !data.ok) {
      const why = {
        invalid: 'That invite link is not valid.',
        expired: 'That invite link has expired — ask for a fresh one.',
        self: 'That was your own invite link.',
      };
      return SW.toast(why[data && data.error] || 'That invite could not be used', 'error');
    }

    SW.toast(data.joined_group
      ? 'You joined ' + data.group
      : 'You and ' + data.inviter + ' are now friends', 'ok');
  };
})();
