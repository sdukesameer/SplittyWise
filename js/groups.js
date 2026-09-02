// ---------------------------------------------------------------------------
//  Groups — the list, one group's page, membership, and settings
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const db = SW.db;
  const esc = SW.escapeHtml;
  const COLLAPSE_KEY = 'splittywise.hideSettledGroups';

  // The non-group bucket has no id, but still needs to be routable.
  const LOOSE = 'none';
  const routeId = function (id) { return id === null ? LOOSE : id; };
  const realId = function (param) { return param === LOOSE ? null : param; };

  const FILTER_KEY = 'splittywise.groupFilter';
  const FILTERS = {
    none:        'All groups',
    outstanding: 'Groups with an outstanding balance',
    'you-owe':   'Groups where you owe',
    'owes-you':  'Groups where you are owed',
  };

  let hideSettled = read(COLLAPSE_KEY) === '1';
  let filter = read(FILTER_KEY) || 'none';
  let pane = 'expenses';
  let showSettledHistory = false;

  SW.currentGroupId = null;

  function read(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function write(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  const GROUP_TYPES = [
    { value: 'trip',   label: '🧳 Trip' },
    { value: 'home',   label: '🏠 Flat or home' },
    { value: 'couple', label: '❤️ Couple' },
    { value: 'event',  label: '🎉 Event' },
    { value: 'other',  label: '👥 Other' },
  ];
  const TYPE_EMOJI = { trip: '🧳', home: '🏠', couple: '❤️', event: '🎉', other: '👥' };

  /* ======================= groups list ================================ */

  function stateOf(net) { return net > 0 ? 'owed' : (net < 0 ? 'owe' : 'settled'); }

  function groupRowHtml(entry) {
    const g = entry.group;
    const net = entry.summary.myNet;
    const state = stateOf(net);

    let amount;
    if (state === 'settled') {
      amount = '<span class="val">settled up</span>';
    } else {
      amount = '<span class="lbl">' + (state === 'owed' ? 'you are owed' : 'you owe') +
               '</span><span class="val">' + SW.money(net) + '</span>';
    }

    // Per-member breakdown, the same shape as the friends list.
    const pairs = SW.myGroupPairs(entry.id);
    const breakdown = pairs.length
      ? '<div class="breakdown">' + pairs.slice(0, 4).map(function (pr) {
          const p = SW.person(pr.id);
          return '<div class="bd-row">' + (pr.amount > 0
            ? esc(p.full_name) + ' owes you <span class="bd-owed">' + SW.money(pr.amount) + '</span>'
            : 'You owe ' + esc(p.full_name) + ' <span class="bd-owe">' + SW.money(pr.amount) + '</span>'
          ) + '</div>';
        }).join('') +
        (pairs.length > 4
          ? '<div class="bd-row">and ' + (pairs.length - 4) + ' more</div>'
          : '') +
        '</div>'
      : '';

    return '<button class="list-row is-' + state + '" data-group="' + esc(routeId(entry.id)) + '">' +
             '<span class="avatar" style="background:var(--surface-2)">' + esc(g.emoji) + '</span>' +
             '<span class="row-main"><span class="row-title">' + esc(g.name) + '</span>' +
               '<span class="row-sub">' + SW.money(entry.summary.total) + ' in total</span>' +
             '</span>' +
             '<span class="row-amount">' + amount + '</span>' +
           '</button>' + breakdown;
  }

  function renderGroups() {
    if (!SW.ledger) return;

    document.getElementById('groups-skel').hidden = true;
    const body = document.getElementById('groups-body');
    const empty = document.getElementById('groups-empty');
    const list = document.getElementById('groups-list');
    const wrap = document.getElementById('groups-settled-wrap');
    const settledList = document.getElementById('groups-settled-list');

    const filteredEmpty = document.getElementById('groups-filtered-empty');
    const all = SW.groupList();

    if (!all.length) {
      body.hidden = true;
      filteredEmpty.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const entries = all.filter(function (e) {
      const net = e.summary.myNet;
      if (filter === 'outstanding') return net !== 0;
      if (filter === 'you-owe') return net < 0;
      if (filter === 'owes-you') return net > 0;
      return true;
    });

    if (!entries.length) {
      body.hidden = true;
      filteredEmpty.hidden = false;
      return;
    }
    filteredEmpty.hidden = true;
    body.hidden = false;

    const active = entries.filter(function (e) { return e.summary.myNet !== 0; });
    const settled = entries.filter(function (e) { return e.summary.myNet === 0; });

    active.sort(function (a, b) {
      return Math.abs(b.summary.myNet) - Math.abs(a.summary.myNet);
    });
    settled.sort(function (a, b) { return a.group.name.localeCompare(b.group.name); });

    list.innerHTML = active.map(groupRowHtml).join('');

    if (settled.length) {
      wrap.hidden = false;
      document.getElementById('groups-settled-label').textContent =
        'Settled up · ' + settled.length;
      document.getElementById('groups-settled-toggle').textContent =
        hideSettled ? 'Show' : 'Hide';
      settledList.hidden = hideSettled;
      settledList.innerHTML = hideSettled ? '' : settled.map(groupRowHtml).join('');
    } else {
      wrap.hidden = true;
    }
  }

  SW.viewHooks.groups = renderGroups;
  SW.renderGroups = renderGroups;

  function onGroupClick(e) {
    const row = e.target.closest('[data-group]');
    if (row) SW.navigate('group/' + row.getAttribute('data-group'));
  }
  document.getElementById('groups-list').addEventListener('click', onGroupClick);
  document.getElementById('groups-settled-list').addEventListener('click', onGroupClick);

  document.getElementById('groups-settled-toggle').addEventListener('click', function () {
    hideSettled = !hideSettled;
    write(COLLAPSE_KEY, hideSettled ? '1' : '0');
    renderGroups();
  });

  SW.groupFilterSheet = function () {
    SW.sheet({
      title: 'Show which groups',
      rawBody: '<div class="opt-list">' + Object.keys(FILTERS).map(function (k) {
        return '<button type="button" class="opt' + (k === filter ? ' is-on' : '') +
               '" data-gfilter="' + k + '">' + esc(FILTERS[k]) +
               '<svg class="tick" width="19" height="19" aria-hidden="true">' +
               '<use href="#ic-check"/></svg></button>';
      }).join('') + '</div>',
      confirm: null,
      onOpen: function () {
        document.querySelector('.opt-list').addEventListener('click', function (e) {
          const b = e.target.closest('[data-gfilter]');
          if (!b) return;
          filter = b.getAttribute('data-gfilter');
          write(FILTER_KEY, filter);
          renderGroups();
          SW.closeSheet();
        });
      },
    });
  };

  document.getElementById('groups-clear-filter').addEventListener('click', function () {
    filter = 'none';
    write(FILTER_KEY, filter);
    renderGroups();
  });

  document.getElementById('groups-add-more').addEventListener('click', openCreateGroup);
  document.getElementById('groups-empty-add').addEventListener('click', openCreateGroup);

  /* ======================= create a group ============================= */

  function openCreateGroup() {
    SW.sheet({
      title: 'Start a group',
      body:
        '<div class="field">' +
          '<label for="grp-f-name">Group name</label>' +
          '<input class="input" id="grp-f-name" type="text" maxlength="50" ' +
                 'placeholder="Flatmates, Goa trip, JioFiber">' +
        '</div>' +
        '<div class="field">' +
          '<label for="grp-f-type">What kind</label>' +
          '<select class="input" id="grp-f-type">' +
            GROUP_TYPES.map(function (t) {
              return '<option value="' + t.value + '"' +
                     (t.value === 'other' ? ' selected' : '') + '>' + t.label + '</option>';
            }).join('') +
          '</select>' +
        '</div>' +
        '<span class="hint">You can add members once it exists.</span>' +
        '<div class="field-error" id="grp-f-error"></div>',
      confirm: 'Create group',
      onOpen: function () { document.getElementById('grp-f-name').focus(); },
      onConfirm: async function (btn) {
        const name = document.getElementById('grp-f-name').value.trim();
        const type = document.getElementById('grp-f-type').value;

        if (!name) {
          SW.setError('grp-f-error', 'Give the group a name.');
          return false;
        }

        SW.busy(btn, true);
        const { data, error } = await db.rpc('create_group', {
          p_name: name,
          p_group_type: type,
          p_emoji: TYPE_EMOJI[type] || '👥',
        });
        SW.busy(btn, false);

        if (error) { SW.setError('grp-f-error', error.message); return false; }

        await SW.refreshLedger();
        SW.navigate('group/' + data);
        SW.toast(name + ' created', 'ok');
        return true;
      },
    });
  }

  SW.openCreateGroup = openCreateGroup;

  /* ======================= one group's page =========================== */

  function renderGroupDetail(param) {
    const gid = realId(param);
    SW.currentGroupId = gid;
    if (!SW.ledger) return;

    const missing = document.getElementById('grp-missing');
    const isLoose = gid === null;
    const g = isLoose
      ? { id: null, name: 'Non-group expenses', emoji: '🧾' }
      : SW.ledger.groups[gid];

    const chrome = document.querySelectorAll(
      '[data-view="group-detail"] .detail-hero, [data-view="group-detail"] .chip-row, ' +
      '[data-view="group-detail"] [data-pane], #grp-balance'
    );

    if (!g) {
      missing.hidden = false;
      chrome.forEach(function (el) { el.hidden = true; });
      return;
    }
    missing.hidden = true;
    chrome.forEach(function (el) { el.hidden = false; });
    // Only the selected pane shows; the hidden reset above cleared that.
    showPane(pane);

    const summary = SW.groupSummary(gid);
    const memberIds = isLoose
      ? summary.memberIds
      : (SW.ledger.members[gid] || summary.memberIds);

    document.getElementById('grp-emoji').textContent = g.emoji;
    document.getElementById('grp-name').textContent = g.name;
    document.getElementById('grp-people-text').textContent =
      memberIds.length + (memberIds.length === 1 ? ' person' : ' people');
    document.getElementById('grp-people').hidden = isLoose;
    document.getElementById('grp-settings').hidden = isLoose;
    document.getElementById('grp-add-people').hidden = isLoose;

    // A group of one cannot split anything, so say so up front rather than
    // only refusing when they try to save an expense.
    const solo = !isLoose && memberIds.length < 2;
    document.getElementById('grp-solo').hidden = !solo;

    // My position in this group.
    const net = summary.myNet;
    const state = stateOf(net);
    const bal = document.getElementById('grp-balance');
    bal.className = 'detail-balance is-' + state;
    bal.style.padding = '0 18px 12px';
    bal.textContent = state === 'settled'
      ? '🎉 You are all settled up in this group'
      : (state === 'owed' ? 'Overall, you are owed ' + SW.money(net)
                          : 'Overall, you owe ' + SW.money(net));

    if (SW.applyGroupCover) SW.applyGroupCover(isLoose ? null : g.cover_path);

    const dateChip = document.getElementById('grp-settle-date-chip');
    dateChip.hidden = isLoose;
    document.getElementById('grp-settle-date-text').textContent = g.settle_up_day
      ? 'Settle up on the ' + SW.ordinalDay(g.settle_up_day) + ' of the month'
      : 'Add settle-up date';
    document.getElementById('grp-whiteboard-chip').hidden = isLoose;
    document.getElementById('grp-settings-chip').hidden = isLoose;

    // A settle-up date is a promise the group made, so show it where the
    // balance is.
    if (!isLoose && g.settle_up_day) {
      bal.textContent += ' · settle up on the ' + SW.ordinalDay(g.settle_up_day);
    }

    renderGroupExpenses(gid);
    renderGroupBalances(gid, summary);
    renderGroupTotals(gid, summary, memberIds);
    if (SW.renderGroupCharts) SW.renderGroupCharts(gid);
  }

  SW.viewHooks['group-detail'] = renderGroupDetail;
  SW.renderGroupDetail = renderGroupDetail;

  /* ---- expenses pane ---- */

  function renderGroupExpenses(gid) {
    const host = document.getElementById('grp-expenses');
    const empty = document.getElementById('grp-no-expenses');
    const me = SW.ledger.me;

    const rows = SW.ledger.expenses
      .filter(function (e) { return (e.group_id || null) === gid; })
      .slice()
      .sort(function (a, b) {
        return (a.expense_date + (a.created_at || '')) < (b.expense_date + (b.created_at || '')) ? 1 : -1;
      });

    // The solo prompt already explains an empty group of one.
    const solo = !document.getElementById('grp-solo').hidden;

    const more = document.getElementById('grp-settled-more');

    if (!rows.length) {
      host.innerHTML = '';
      more.hidden = true;
      empty.hidden = solo;
      return;
    }
    empty.hidden = true;

    // Same idea as the friend page: anything older than the last time your
    // own balance here hit zero is finished business.
    const withDelta = rows.map(function (e) {
      return { e: e, delta: SW.myDeltaOn(e) };
    });
    const showCount = SW.settledCutoff(withDelta);
    const hiddenCount = withDelta.length - showCount;
    const visible = showSettledHistory ? withDelta : withDelta.slice(0, showCount);

    if (hiddenCount > 0) {
      more.hidden = false;
      more.textContent = showSettledHistory
        ? 'Hide ' + hiddenCount + ' settled ' + (hiddenCount === 1 ? 'expense' : 'expenses')
        : 'Everything before this has been settled up.\nTap to show ' + hiddenCount +
          ' settled ' + (hiddenCount === 1 ? 'expense' : 'expenses');
    } else {
      more.hidden = true;
    }

    let html = '';
    let month = null;
    visible.map(function (x) { return x.e; }).forEach(function (e) {
      const m = SW.monthLabel(e.expense_date);
      if (m !== month) { month = m; html += '<div class="month-head">' + esc(m) + '</div>'; }

      const total = SW.toPaise(e.amount);
      const mine = (e.expense_splits || []).find(function (s) { return s.user_id === me; });
      const minePaise = mine ? SW.toPaise(mine.amount) : 0;
      const payer = SW.person(e.payer_id);
      const d = new Date(e.expense_date + 'T00:00:00');

      let cls, lbl, val;
      if (e.payer_id === me) {
        const lent = total - minePaise;
        cls = lent > 0 ? 'is-owed' : 'is-flat';
        lbl = 'you lent'; val = SW.money(lent);
      } else if (mine) {
        cls = 'is-owe'; lbl = 'you owe'; val = SW.money(minePaise);
      } else {
        cls = 'is-flat'; lbl = 'not you'; val = '—';
      }

      html += '<button class="ledger-row" data-expense="' + esc(e.id) + '" ' +
                      'style="cursor:pointer">' +
        '<span class="ledger-date"><span class="d">' + d.getDate() + '</span><br>' +
          '<span class="m">' + esc(d.toLocaleDateString('en-IN', { month: 'short' })) + '</span></span>' +
        '<span class="ledger-emoji">' + esc(e.emoji || '🧾') + '</span>' +
        '<span class="ledger-main">' +
          '<span class="ledger-title">' + esc(e.description) + '</span>' +
          '<span class="ledger-sub">' +
            (e.payer_id === me ? 'You paid ' : esc(payer.full_name) + ' paid ') +
            SW.money(total) + '</span>' +
        '</span>' +
        '<span class="ledger-delta ' + cls + '">' +
          '<span class="lbl">' + lbl + '</span><span class="val">' + val + '</span>' +
        '</span></button>';
    });
    host.innerHTML = html;
  }

  document.getElementById('grp-expenses').addEventListener('click', function (e) {
    const row = e.target.closest('[data-expense]');
    if (row) SW.navigate('expense/' + row.getAttribute('data-expense'));
  });

  /* ---- balances pane ---- */

  function renderGroupBalances(gid, summary) {
    const host = document.getElementById('grp-balances');
    const me = SW.ledger.me;
    const ids = Object.keys(summary.nets).sort(function (a, b) {
      return summary.nets[b] - summary.nets[a];
    });

    host.innerHTML = ids.map(function (id) {
      const v = summary.nets[id];
      const p = SW.person(id);
      const state = stateOf(v);
      const name = id === me ? 'You' : p.full_name;

      let amount;
      if (state === 'settled') {
        amount = '<span class="val">settled up</span>';
      } else {
        amount = '<span class="lbl">' + (v > 0 ? 'is owed' : 'owes') + '</span>' +
                 '<span class="val">' + SW.money(v) + '</span>';
      }
      // Tappable unless it is you or already square — there is nothing to do
      // about your own row.
      const actionable = id !== me && v !== 0;
      return '<' + (actionable ? 'button' : 'div') + ' class="list-row is-' + state + '"' +
        (actionable ? ' data-member="' + esc(id) + '"' : ' style="cursor:default"') + '>' +
        SW.avatar(id, p.avatar_emoji) +
        '<span class="row-main"><span class="row-title">' + esc(name) + '</span>' +
          (actionable ? '<span class="row-sub">Tap to settle or remind</span>' : '') +
        '</span>' +
        '<span class="row-amount">' + amount + '</span>' +
        '</' + (actionable ? 'button' : 'div') + '>';
    }).join('');
  }

  document.getElementById('grp-balances').addEventListener('click', function (e) {
    const row = e.target.closest('[data-member]');
    if (!row) return;
    const id = row.getAttribute('data-member');
    const gid = SW.currentGroupId;
    const pairNet = SW.myGroupPairs(gid).filter(function (pr) { return pr.id === id; })[0];
    const between = pairNet ? pairNet.amount : 0;
    const p = SW.person(id);

    SW.sheet({
      title: p.full_name,
      rawBody:
        '<div class="sheet-body"><p style="color:var(--muted);font-size:14.5px">' +
          (between === 0
            ? 'Nothing is outstanding between the two of you in this group, even ' +
              'though they have a balance with others here.'
            : (between > 0
                ? esc(p.full_name) + ' owes you <strong style="color:var(--owed)">' +
                  SW.money(between) + '</strong> here.'
                : 'You owe ' + esc(p.full_name) + ' <strong style="color:var(--owe)">' +
                  SW.money(between) + '</strong> here.')) +
        '</p></div>' +
        '<div class="sheet-actions">' +
          '<button type="button" class="btn btn-primary" id="bal-settle">' +
            'Record a payment</button>' +
          (between > 0
            ? '<button type="button" class="btn btn-ghost" id="bal-nudge">' +
              'Send a reminder</button>'
            : '') +
        '</div>',
      confirm: null,
      onOpen: function () {
        document.getElementById('bal-settle').addEventListener('click', function () {
          SW.closeSheet();
          SW.openPaymentSheet({
            otherId: id, groupId: gid,
            amountPaise: Math.abs(between), iPay: between < 0,
          });
        });

        const nudge = document.getElementById('bal-nudge');
        if (nudge) nudge.addEventListener('click', async function () {
          SW.busy(this, true);
          const res = await db.rpc('nudge', {
            p_user_id: id, p_group_id: gid, p_amount: SW.rupees(between),
          });
          SW.busy(this, false);
          if (res.error) return SW.toast(res.error.message, 'error');
          if (!res.data || !res.data.ok) {
            return SW.toast(res.data && res.data.error === 'too_soon'
              ? 'You reminded them recently — give it a few hours.'
              : 'Could not send that', 'error');
          }
          SW.closeSheet();
          SW.toast('Reminder sent to ' + p.full_name, 'ok');
        });
      },
    });
  });

  /* ---- totals pane ---- */

  function renderGroupTotals(gid, summary, memberIds) {
    document.getElementById('grp-total').textContent = SW.money(summary.total);
    const me = SW.ledger.me;

    function column(map) {
      const ids = memberIds.slice().sort(function (a, b) {
        return (map[b] || 0) - (map[a] || 0);
      });
      const top = Math.max.apply(null, ids.map(function (id) { return map[id] || 0; }).concat([1]));

      return ids.map(function (id, i) {
        const v = map[id] || 0;
        const name = id === me ? 'You' : SW.person(id).full_name;
        const pct = Math.round((v / top) * 100);
        return '<div class="totals-line' + (i === 0 && v > 0 ? ' is-top' : '') + '">' +
                 '<span class="tl-name">' + esc(name) + '</span>' +
                 '<span class="tl-val">' + SW.money(v) + '</span>' +
               '</div>' +
               '<div class="totals-bar"><span style="width:' + pct + '%"></span></div>';
      }).join('');
    }

    document.getElementById('grp-paid').innerHTML = column(summary.paid);
    document.getElementById('grp-consumed').innerHTML = column(summary.owed);
  }

  /* ---- pane switching ---- */

  function showPane(which) {
    pane = which;
    document.querySelectorAll('[data-view="group-detail"] [data-pane]').forEach(function (el) {
      el.classList.toggle('is-active', el.getAttribute('data-pane') === which);
    });
    document.querySelectorAll('[data-pane-btn]').forEach(function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-pane-btn') === which);
    });
  }

  document.querySelector('[data-view="group-detail"] .chip-row')
    .addEventListener('click', function (e) {
      const b = e.target.closest('[data-pane-btn]');
      if (b) showPane(b.getAttribute('data-pane-btn'));
    });

  document.getElementById('grp-add-people').addEventListener('click', function () {
    if (SW.currentGroupId) openAddMember(SW.currentGroupId);
  });
  document.getElementById('grp-solo-add').addEventListener('click', function () {
    if (SW.currentGroupId) openAddMember(SW.currentGroupId);
  });

  // Both live on the settings page; these are the shortcuts to them.
  document.getElementById('grp-settle-date-chip').addEventListener('click', function () {
    if (SW.openSettleDate) SW.openSettleDate(SW.currentGroupId);
  });
  document.getElementById('grp-whiteboard-chip').addEventListener('click', function () {
    if (SW.openWhiteboard) SW.openWhiteboard(SW.currentGroupId);
  });

  document.getElementById('grp-export').addEventListener('click', function () {
    const gid = SW.currentGroupId;
    const g = gid ? SW.ledger.groups[gid] : null;
    SW.exportCsv({ groupId: gid },
      (g ? g.name : 'non-group').toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  });

  document.getElementById('grp-settled-more').addEventListener('click', function () {
    showSettledHistory = !showSettledHistory;
    renderGroupDetail(SW.currentGroupId === null ? LOOSE : SW.currentGroupId);
  });

  document.getElementById('grp-back').addEventListener('click', function () {
    SW.navigate('groups');
  });
  document.getElementById('grp-missing-back').addEventListener('click', function () {
    SW.navigate('groups');
  });

  /* ======================= group settings ============================= */

  function openSettings() {
    if (SW.currentGroupId) SW.navigate('gsettings/' + SW.currentGroupId);
    else SW.toast('Non-group expenses have no settings');
  }

  // Three ways in, because one gear icon was not findable.
  document.getElementById('grp-settings').addEventListener('click', openSettings);
  document.getElementById('grp-settings-chip').addEventListener('click', openSettings);
  document.getElementById('grp-name-tap').addEventListener('click', openSettings);

  SW.openAddMember = function (gid) { openAddMember(gid); };

  function openAddMember(gid) {
    const me = SW.ledger.me;
    const members = SW.ledger.members[gid] || [];
    // Friends who are not in this group yet — nobody should have to retype
    // an email address they already have as a friend.
    const candidates = SW.ledger.friendIds.filter(function (id) {
      return members.indexOf(id) === -1;
    }).sort(function (a, b) {
      return SW.person(a).full_name.localeCompare(SW.person(b).full_name);
    });

    let chosen = [];

    SW.sheet({
      title: 'Add people',
      rawBody:
        (candidates.length
          ? '<div class="card-head">Your friends</div><div class="list" id="mem-list">' +
            candidates.map(function (id) {
              const pr = SW.person(id);
              return '<button type="button" class="list-row" data-mem="' + esc(id) + '">' +
                SW.avatar(id, pr.avatar_emoji) +
                '<span class="row-main"><span class="row-title">' + esc(pr.full_name) +
                  '</span>' + (pr.email ? '<span class="row-sub">' + esc(pr.email) +
                  '</span>' : '') + '</span>' +
                '<span class="sp-check"><svg aria-hidden="true">' +
                  '<use href="#ic-check"/></svg></span>' +
              '</button>';
            }).join('') + '</div>'
          : '<div class="search-hint">' +
            (members.length > 1
              ? 'All of your friends are already in this group.'
              : 'You have no friends to add yet.') +
            '</div>') +

        '<div class="sheet-actions">' +
          '<button type="button" class="btn btn-ghost" id="mem-link">' +
            '🔗 Invite with a link</button>' +
          '<button type="button" class="btn-text" id="mem-email-toggle" ' +
                  'style="align-self:center;padding:8px">Add by email instead</button>' +
        '</div>' +

        '<div id="mem-email-wrap" hidden><div class="sheet-body">' +
          '<div class="field">' +
            '<label for="mem-email">Their email address</label>' +
            '<input class="input" id="mem-email" type="email" inputmode="email" ' +
                   'autocomplete="off" autocapitalize="off" spellcheck="false" ' +
                   'placeholder="friend@example.com">' +
            '<span class="hint">They need a SplittyWise account already.</span>' +
            '<div class="field-error" id="mem-error"></div>' +
          '</div>' +
        '</div></div>',
      confirm: candidates.length ? 'Add to group' : null,
      onOpen: function () {
        const list = document.getElementById('mem-list');
        if (list) {
          list.addEventListener('click', function (e) {
            const b = e.target.closest('[data-mem]');
            if (!b) return;
            const id = b.getAttribute('data-mem');
            const at = chosen.indexOf(id);
            if (at > -1) chosen.splice(at, 1);
            else chosen.push(id);
            b.querySelector('.sp-check').classList.toggle('is-on', at === -1);
          });
        }

        document.getElementById('mem-link').addEventListener('click', function () {
          SW.closeSheet();
          SW.shareInvite(gid);
        });

        document.getElementById('mem-email-toggle').addEventListener('click', function () {
          const wrap = document.getElementById('mem-email-wrap');
          wrap.hidden = !wrap.hidden;
          this.textContent = wrap.hidden ? 'Add by email instead' : 'Hide the email field';
          if (!wrap.hidden) document.getElementById('mem-email').focus();
        });
      },
      onConfirm: async function (btn) {
        const emailField = document.getElementById('mem-email');
        const email = emailField && !document.getElementById('mem-email-wrap').hidden
          ? emailField.value.trim().toLowerCase() : '';

        if (!chosen.length && !email) {
          SW.toast('Pick a friend, or type an email address', 'error');
          return false;
        }

        SW.busy(btn, true);

        if (chosen.length) {
          const { data, error } = await db.rpc('add_group_members', {
            p_group_id: gid, p_user_ids: chosen,
          });
          if (error) { SW.busy(btn, false); SW.toast(error.message, 'error'); return false; }
          if (data && data.added === 0) {
            SW.busy(btn, false);
            SW.toast('Nobody was added', 'error');
            return false;
          }
        }

        if (email) {
          if (!SW.isEmail(email)) {
            SW.busy(btn, false);
            SW.setError('mem-error', 'That does not look like an email address.');
            return false;
          }
          const { data, error } = await db.rpc('add_group_member_by_email', {
            p_group_id: gid, p_email: email,
          });
          if (error) { SW.busy(btn, false); SW.setError('mem-error', error.message); return false; }
          if (!data || !data.ok) {
            SW.busy(btn, false);
            SW.setError('mem-error', data && data.error === 'already'
              ? 'They are already in this group.'
              : 'No SplittyWise account uses that email yet. Send them a link instead.');
            return false;
          }
        }

        SW.busy(btn, false);
        await SW.refreshLedger();
        const n = chosen.length + (email ? 1 : 0);
        SW.toast(n === 1 ? 'Added to the group' : n + ' people added', 'ok');
        return true;
      },
    });
  }

  /* ======================= header action ============================== */

  // The Groups tab's top-right action.
  SW.createGroupAction = openCreateGroup;
})();
