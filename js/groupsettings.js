// ---------------------------------------------------------------------------
//  Group settings — cover photo, name, settle-up date, whiteboard, members,
//  simplify-debts, your own default split, and leaving or deleting
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const db = SW.db;
  const esc = SW.escapeHtml;
  let gid = null;

  const TYPES = [
    { value: 'trip',   label: '🧳 Trip' },
    { value: 'home',   label: '🏠 Flat or home' },
    { value: 'couple', label: '❤️ Couple' },
    { value: 'event',  label: '🎉 Event' },
    { value: 'other',  label: '👥 Other' },
  ];

  function group() { return (SW.ledger && SW.ledger.groups[gid]) || null; }

  /* ======================= render ==================================== */

  function render(param) {
    gid = param;
    // On a cold deep link the ledger has not arrived yet; recompute calls
    // this again once it has.
    if (!SW.ledger) return;
    const g = group();
    if (!g) return SW.navigate('groups');

    const me = SW.ledger.me;
    const members = SW.ledger.members[gid] || [];
    const mine = (SW.ledger.myMembership || {})[gid] || {};

    document.getElementById('gs-name-sub').textContent = g.emoji + '  ' + g.name;

    document.getElementById('gs-settle-sub').textContent = g.settle_up_day
      ? 'Reminder on the ' + SW.ordinalDay(g.settle_up_day) + ' of every month'
      : 'No date set';

    const wb = (g.whiteboard || '').trim();
    document.getElementById('gs-wb-sub').textContent = wb
      ? wb.split('\n')[0].slice(0, 60) + (wb.length > 60 ? '…' : '')
      : 'Shared notes everyone in the group can see';

    document.getElementById('gs-cover-sub').textContent = g.cover_path
      ? 'Tap to replace it' : 'Add a picture for the group';
    showCover(g.cover_path);

    const simplify = g.simplify_debts !== false;
    const sw = document.getElementById('gs-simplify');
    sw.classList.toggle('is-on', simplify);
    sw.setAttribute('aria-checked', String(simplify));

    const rounded = g.rounding === 'rupee';
    const rs = document.getElementById('gs-rounding');
    rs.classList.toggle('is-on', rounded);
    rs.setAttribute('aria-checked', String(rounded));

    document.getElementById('gs-default-split').innerHTML =
      SW.SPLIT_MODES.map(function (m) {
        return '<button type="button" data-dsm="' + m.key + '"' +
               (m.key === (mine.default_split_mode || 'equal') ? ' class="is-on"' : '') +
               '>' + esc(m.label) + '</button>';
      }).join('');

    document.getElementById('gs-members-head').textContent =
      members.length + (members.length === 1 ? ' member' : ' members');

    const owner = g.created_by === me;
    document.getElementById('gs-delete').hidden = !owner;

    const anyOutstanding = Object.keys(SW.groupSummary(gid).nets).some(function (k) {
      return SW.groupSummary(gid).nets[k] !== 0;
    });
    document.getElementById('gs-leave').classList.toggle('is-blocked', anyOutstanding);

    document.getElementById('gs-members').innerHTML = members.map(function (id) {
      const p = SW.person(id);
      const net = SW.groupSummary(gid).nets[id] || 0;
      const canRemove = owner && id !== me;
      return '<div class="list-row" style="cursor:default">' +
        SW.avatar(id, p.avatar_emoji) +
        '<span class="row-main">' +
          '<span class="row-title" style="font-size:15px">' +
            esc(id === me ? 'You' : p.full_name) + '</span>' +
          (p.email ? '<span class="row-sub">' + esc(p.email) + '</span>' : '') +
        '</span>' +
        (net === 0
          ? '<span class="row-amount"><span class="val" style="color:var(--settled);' +
            'font-size:13px">settled up</span></span>'
          : '<span class="row-amount ' + (net > 0 ? 'is-owed' : 'is-owe') + '">' +
            '<span class="lbl">' + (net > 0 ? 'is owed' : 'owes') + '</span>' +
            '<span class="val">' + SW.money(net) + '</span></span>') +
        (canRemove
          ? '<button type="button" class="ir-del" data-remove="' + esc(id) +
            '" aria-label="Remove ' + esc(p.full_name) + '">×</button>'
          : '') +
      '</div>';
    }).join('');

    renderStrangers();
  }

  // The people in this group who are not friends yet. Kept out of the member
  // rows on purpose: those already carry a name, an address, a balance and a
  // remove button, and a fifth thing in them is how a row stops fitting on a
  // phone. As its own card it also says something useful — that there are
  // people here you could be splitting with elsewhere — and it disappears
  // when there is nobody left to add.
  function renderStrangers() {
    const card = document.getElementById('gs-strangers-card');
    const host = document.getElementById('gs-strangers');
    const strangers = SW.groupStrangers(gid);

    card.hidden = strangers.length === 0;
    if (!strangers.length) { host.innerHTML = ''; return; }

    host.innerHTML = strangers.map(function (id) {
      const p = SW.person(id);
      return '<div class="list-row" style="cursor:default">' +
        SW.avatar(id, p.avatar_emoji) +
        '<span class="row-main">' +
          '<span class="row-title" style="font-size:15px">' +
            esc(p.full_name || 'Someone') + '</span>' +
          (p.email ? '<span class="row-sub">' + esc(p.email) + '</span>' : '') +
        '</span>' +
        '<button type="button" class="chip" data-befriend="' + esc(id) + '">' +
          'Add friend</button>' +
      '</div>';
    }).join('');
  }

  document.getElementById('gs-strangers').addEventListener('click', async function (e) {
    const b = e.target.closest('[data-befriend]');
    if (!b) return;
    const id = b.getAttribute('data-befriend');
    const p = SW.person(id);

    SW.busy(b, true);
    const { data, error } = await db.rpc('add_group_peer_as_friend', {
      p_group_id: gid,
      p_user_id: id,
    });
    SW.busy(b, false);

    if (error) { SW.toast(error.message, 'error'); return; }
    if (!data || !data.ok) {
      // 'already' is not a failure worth a red toast: the ledger simply had
      // not caught up, and refreshing makes the row go away by itself.
      if (data && data.error === 'already') {
        await SW.refreshLedger();
        render(gid);
        return;
      }
      SW.toast(data && data.error === 'not_shared'
        ? 'They are not in this group any more'
        : 'Could not add them', 'error');
      return;
    }

    await SW.refreshLedger();
    render(gid);
    SW.toast((p.full_name || 'They') + ' is now a friend', 'ok');
  });

  SW.viewHooks['group-settings'] = render;

  async function showCover(path) {
    const img = document.getElementById('gs-cover-thumb');
    img.hidden = true;
    if (!path) return;
    const { data } = await db.storage.from('covers').createSignedUrl(path, 3600);
    if (data && data.signedUrl && gid) { img.src = data.signedUrl; img.hidden = false; }
  }

  // Group detail shows the cover behind its header.
  SW.applyGroupCover = async function (path) {
    const header = document.querySelector('[data-view="group-detail"] .detail-header');
    if (!header) return;
    if (!path) {
      header.style.backgroundImage = '';
      return;
    }
    const { data } = await db.storage.from('covers').createSignedUrl(path, 3600);
    if (!data || !data.signedUrl) return;
    // Kept dark enough that white text on top stays readable.
    header.style.backgroundImage =
      'linear-gradient(180deg, rgba(0,0,0,.35), var(--bg)), url("' + data.signedUrl + '")';
    header.style.backgroundSize = 'cover';
    header.style.backgroundPosition = 'center';
  };

  /* ======================= navigation =============================== */

  document.getElementById('gs-back').addEventListener('click', function () {
    SW.navigate('group/' + (gid || 'none'));
  });

  /* ======================= cover photo ============================== */

  const coverFile = document.getElementById('gs-cover-file');
  document.getElementById('gs-cover').addEventListener('click', function () {
    coverFile.click();
  });
  coverFile.addEventListener('change', async function () {
    const file = coverFile.files && coverFile.files[0];
    coverFile.value = '';
    if (!file) return;

    SW.toast('Shrinking the picture…');
    let blob;
    try {
      // A cover is displayed wide but short, so a little more room than an
      // avatar and the same hard cap.
      blob = await SW.prepareImage(file, { maxDim: 1000 });
    } catch (err) {
      return SW.toast(err.message || 'Could not read that image', 'error');
    }

    const previous = group().cover_path;
    const path = SW.user.id + '/' + gid + '-' + Date.now() + '.jpg';

    const up = await db.storage.from('covers').upload(path, blob, {
      contentType: 'image/jpeg', upsert: false,
    });
    if (up.error) return SW.toast(up.error.message, 'error');

    const { error } = await db.from('groups').update({ cover_path: path }).eq('id', gid);
    if (error) return SW.toast(error.message, 'error');

    group().cover_path = path;
    if (previous) db.storage.from('covers').remove([previous]);
    render(gid);
    SW.toast('Cover updated · ' + SW.readableSize(blob.size), 'ok');
  });

  /* ======================= name and icon ============================ */

  document.getElementById('gs-name').addEventListener('click', function () {
    const g = group();
    SW.sheet({
      title: 'Name and icon',
      body:
        '<div class="field">' +
          '<label for="gs-f-name">Group name</label>' +
          '<input class="input" id="gs-f-name" type="text" maxlength="50" ' +
                 'value="' + esc(g.name) + '">' +
        '</div>' +
        '<div class="field">' +
          '<label for="gs-f-type">What kind</label>' +
          '<select class="input" id="gs-f-type">' +
            TYPES.map(function (t) {
              return '<option value="' + t.value + '"' +
                     (t.value === (g.group_type || 'other') ? ' selected' : '') + '>' +
                     t.label + '</option>';
            }).join('') +
          '</select>' +
        '</div>' +
        '<div class="field">' +
          '<label for="gs-f-emoji">Icon</label>' +
          '<input class="input" id="gs-f-emoji" type="text" maxlength="4" ' +
                 'value="' + esc(g.emoji) + '" style="width:5rem;text-align:center;' +
                 'font-size:24px">' +
        '</div>' +
        '<div class="field-error" id="gs-f-error"></div>',
      confirm: 'Save',
      onOpen: function () { document.getElementById('gs-f-name').focus(); },
      onConfirm: async function (btn) {
        const name = document.getElementById('gs-f-name').value.trim();
        const type = document.getElementById('gs-f-type').value;
        const emoji = document.getElementById('gs-f-emoji').value.trim() || '👥';
        if (!name) { SW.setError('gs-f-error', 'The group needs a name.'); return false; }

        SW.busy(btn, true);
        const { error } = await db.from('groups')
          .update({ name: name, group_type: type, emoji: emoji }).eq('id', gid);
        SW.busy(btn, false);
        if (error) { SW.setError('gs-f-error', error.message); return false; }

        Object.assign(group(), { name: name, group_type: type, emoji: emoji });
        render(gid);
        if (SW.renderGroups) SW.renderGroups();
        SW.toast('Group updated', 'ok');
        return true;
      },
    });
  });

  /* ======================= settle-up date =========================== */

  document.getElementById('gs-settle-date').addEventListener('click', function () {
    SW.openSettleDate(gid);
  });

  SW.openSettleDate = function (forGid) {
    gid = forGid || gid;
    const g = group();
    if (!g) return;
    const days = [];
    for (let d = 1; d <= 31; d++) {
      days.push('<option value="' + d + '"' +
        (g.settle_up_day === d ? ' selected' : '') + '>' +
        'The ' + SW.ordinalDay(d) + '</option>');
    }

    async function save(day, btn) {
      SW.busy(btn, true);
      const { error } = await db.from('groups')
        .update({ settle_up_day: day }).eq('id', gid);
      SW.busy(btn, false);
      if (error) { SW.toast(error.message, 'error'); return false; }
      group().settle_up_day = day;
      render(gid);
      SW.toast(day ? 'Reminder set for the ' + SW.ordinalDay(day) : 'Reminder removed', 'ok');
      if (SW.renderGroupDetail && SW.currentGroupId === gid) {
        SW.renderGroupDetail(gid);
      }
      return true;
    }

    SW.sheet({
      title: 'Settle-up day',
      body:
        '<p style="color:var(--muted);font-size:14.5px">Pick the day of the ' +
          'month everyone squares up on. Everyone in the group gets a reminder ' +
          'on that day, every month.</p>' +
        '<div class="field" style="margin-top:12px">' +
          '<label for="gs-f-day">Day of the month</label>' +
          '<select class="input" id="gs-f-day">' + days.join('') + '</select>' +
          '<span class="hint">Pick the 29th, 30th or 31st and short months ' +
            'remind you on their last day instead of skipping.</span>' +
        '</div>',
      confirm: 'Save',
      destroy: g.settle_up_day ? 'Turn the reminder off' : null,
      onDestroy: function (btn) { return save(null, btn); },
      onClose: function () { /* nothing to restore */ },
      onConfirm: function (btn) {
        const day = parseInt(document.getElementById('gs-f-day').value, 10);
        return save(day > 0 ? day : null, btn);
      },
    });
  };

  /* ======================= whiteboard =============================== */

  document.getElementById('gs-whiteboard').addEventListener('click', function () {
    SW.openWhiteboard(gid);
  });

  SW.openWhiteboard = function (forGid) {
    gid = forGid || gid;
    const g = group();
    if (!g) return;
    SW.sheet({
      title: 'Whiteboard',
      rawBody:
        '<div class="sheet-body">' +
          '<textarea class="input" id="gs-f-wb" rows="8" maxlength="2000" ' +
                    'placeholder="The landlord\\u2019s number, the wifi password, ' +
                    'who is bringing what\\u2026" ' +
                    'style="resize:vertical;line-height:1.5">' + esc(g.whiteboard || '') +
          '</textarea>' +
          '<div class="scan-warn">Everyone in this group can read and change ' +
            'this. Do not put passwords or bank details here.</div>' +
        '</div>',
      confirm: 'Save',
      onOpen: function () { document.getElementById('gs-f-wb').focus(); },
      onConfirm: async function (btn) {
        const value = document.getElementById('gs-f-wb').value;
        SW.busy(btn, true);
        const { error } = await db.from('groups')
          .update({ whiteboard: value.trim() || null }).eq('id', gid);
        SW.busy(btn, false);
        if (error) { SW.toast(error.message, 'error'); return false; }
        group().whiteboard = value.trim() || null;
        render(gid);
        SW.toast('Whiteboard saved', 'ok');
        return true;
      },
    });
  };

  /* ======================= advanced ================================= */

  document.getElementById('gs-simplify').addEventListener('click', async function () {
    const on = !this.classList.contains('is-on');
    this.classList.toggle('is-on', on);
    this.setAttribute('aria-checked', String(on));
    const { error } = await db.from('groups').update({ simplify_debts: on }).eq('id', gid);
    if (error) return SW.toast(error.message, 'error');
    group().simplify_debts = on;
  });

  document.getElementById('gs-rounding').addEventListener('click', async function () {
    const on = !this.classList.contains('is-on');
    this.classList.toggle('is-on', on);
    this.setAttribute('aria-checked', String(on));
    const { error } = await db.from('groups')
      .update({ rounding: on ? 'rupee' : 'paise' }).eq('id', gid);
    if (error) return SW.toast(error.message, 'error');
    group().rounding = on ? 'rupee' : 'paise';
    SW.toast(on ? 'Splitting to whole rupees' : 'Splitting to the paise', 'ok');
  });

  document.getElementById('gs-default-split').addEventListener('click', async function (e) {
    const b = e.target.closest('[data-dsm]');
    if (!b) return;
    const mode = b.getAttribute('data-dsm');

    this.querySelectorAll('[data-dsm]').forEach(function (x) {
      x.classList.toggle('is-on', x === b);
    });

    const { error } = await db.from('group_members')
      .update({ default_split_mode: mode })
      .eq('group_id', gid).eq('user_id', SW.ledger.me);
    if (error) return SW.toast(error.message, 'error');

    if (!SW.ledger.myMembership) SW.ledger.myMembership = {};
    SW.ledger.myMembership[gid] = Object.assign(
      SW.ledger.myMembership[gid] || {}, { default_split_mode: mode });
  });

  /* ======================= members ================================== */

  document.getElementById('gs-add').addEventListener('click', function () {
    if (SW.openAddMember) SW.openAddMember(gid);
  });
  document.getElementById('gs-invite').addEventListener('click', function () {
    SW.shareInvite(gid);
  });

  document.getElementById('gs-members').addEventListener('click', function (e) {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const id = b.getAttribute('data-remove');
    const p = SW.person(id);
    const net = SW.groupSummary(gid).nets[id] || 0;

    SW.sheet({
      title: 'Remove ' + p.full_name + '?',
      body: net !== 0
        ? '<p style="color:var(--owe);font-size:14.5px;font-weight:700">' +
          (net > 0 ? 'They are still owed ' : 'They still owe ') + SW.money(net) +
          ' in this group.</p><p style="color:var(--muted);font-size:14.5px;' +
          'margin-top:8px">Removing them does not clear it. Their expenses stay ' +
          'on record.</p>'
        : '<p style="color:var(--muted);font-size:14.5px">They are settled up here, ' +
          'so nothing is outstanding. Their expenses stay on record.</p>',
      confirm: 'Remove',
      onConfirm: async function (btn) {
        SW.busy(btn, true);
        const { error } = await db.from('group_members').delete()
          .eq('group_id', gid).eq('user_id', id);
        SW.busy(btn, false);
        if (error) { SW.toast(error.message, 'error'); return false; }
        await SW.refreshLedger();
        render(gid);
        SW.toast(p.full_name + ' removed', 'ok');
        return true;
      },
    });
  });

  /* ======================= leaving and deleting ===================== */

  document.getElementById('gs-leave').addEventListener('click', function () {
    const g = group();
    const net = SW.groupSummary(gid).myNet;

    // Refused rather than warned. Leaving with a balance would strand a debt
    // nobody can settle from either side, and there is no undo for that.
    if (net !== 0) {
      return SW.sheet({
        title: 'You cannot leave yet',
        body:
          '<p style="color:var(--owe);font-size:14.5px;font-weight:700">' +
            (net > 0 ? 'You are owed ' : 'You owe ') + SW.money(net) +
            ' in this group.</p>' +
          '<p style="color:var(--muted);font-size:14.5px;margin-top:8px">Settle up ' +
            'with everyone here first. Leaving now would strand a debt that ' +
            'neither side could clear.</p>',
        confirm: 'Settle up',
        onConfirm: function () {
          SW.closeSheet();
          SW.navigate('group/' + gid);
          setTimeout(function () { document.getElementById('grp-settle').click(); }, 220);
          return true;
        },
      });
    }

    SW.sheet({
      title: 'Leave ' + g.name + '?',
      body: '<p style="color:var(--muted);font-size:14.5px">You are settled up ' +
        'here. The expenses stay on record for everyone else.</p>',
      confirm: 'Leave group',
      onConfirm: async function (btn) {
        SW.busy(btn, true);
        const { error } = await db.from('group_members').delete()
          .eq('group_id', gid).eq('user_id', SW.ledger.me);
        SW.busy(btn, false);
        if (error) { SW.toast(error.message, 'error'); return false; }
        await SW.refreshLedger();
        SW.navigate('groups');
        SW.toast('You left ' + g.name, 'ok');
        return true;
      },
    });
  });

  document.getElementById('gs-delete').addEventListener('click', function () {
    const g = group();
    const summary = SW.groupSummary(gid);
    const outstanding = Object.keys(summary.nets).some(function (k) {
      return summary.nets[k] !== 0;
    });

    SW.sheet({
      title: 'Delete ' + g.name + '?',
      body:
        '<p style="color:var(--danger);font-size:14.5px;font-weight:700">This ' +
          'cannot be undone.</p>' +
        '<p style="color:var(--muted);font-size:14.5px;margin-top:8px">Every ' +
          'expense and payment in this group is deleted for everyone in it' +
          (outstanding
            ? ', and there are still balances outstanding. Those simply disappear.'
            : '.') +
        '</p>',
      confirm: 'Delete for everyone',
      onConfirm: async function (btn) {
        SW.busy(btn, true);
        const { error } = await db.from('groups').delete().eq('id', gid);
        SW.busy(btn, false);
        if (error) { SW.toast(error.message, 'error'); return false; }
        await SW.refreshLedger();
        SW.navigate('groups');
        SW.toast(g.name + ' deleted', 'ok');
        return true;
      },
    });
  });
})();
