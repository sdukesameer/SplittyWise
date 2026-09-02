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

    if (!rows.length) {
      host.innerHTML = '';
      empty.hidden = solo;
      return;
    }
    empty.hidden = true;

    let html = '';
    let month = null;
    rows.forEach(function (e) {
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
      return '<div class="list-row is-' + state + '" style="cursor:default">' +
        SW.avatar(id, p.avatar_emoji) +
        '<span class="row-main"><span class="row-title">' + esc(name) + '</span></span>' +
        '<span class="row-amount">' + amount + '</span></div>';
    }).join('');
  }

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

  document.getElementById('grp-back').addEventListener('click', function () {
    SW.navigate('groups');
  });
  document.getElementById('grp-missing-back').addEventListener('click', function () {
    SW.navigate('groups');
  });

  /* ======================= group settings ============================= */

  document.getElementById('grp-settings').addEventListener('click', function () {
    const gid = SW.currentGroupId;
    if (!gid) return;
    const g = SW.ledger.groups[gid];
    if (!g) return;

    const members = (SW.ledger.members[gid] || []);
    const iOwn = false; // determined server-side; delete simply fails if not
    const simplify = g.simplify_debts !== false;

    SW.sheet({
      title: g.name,
      rawBody:
        '<div class="card-head">' + members.length +
          (members.length === 1 ? ' member' : ' members') + '</div>' +
        '<div class="list">' + members.map(function (id) {
          const p = SW.person(id);
          return '<div class="list-row" style="cursor:default;padding-top:8px;padding-bottom:8px">' +
            SW.avatar(id, p.avatar_emoji) +
            '<span class="row-main"><span class="row-title" style="font-size:15px">' +
              esc(id === SW.ledger.me ? 'You' : p.full_name) + '</span>' +
              (p.email ? '<span class="row-sub">' + esc(p.email) + '</span>' : '') +
            '</span></div>';
        }).join('') + '</div>' +

        '<div class="switch-row" style="margin-top:6px">' +
          '<span class="grow">' +
            '<span class="set-title">Simplify debts</span>' +
            '<span class="set-sub">Net three-way chains into single payments</span>' +
          '</span>' +
          '<button type="button" class="switch' + (simplify ? ' is-on' : '') +
                  '" id="grp-simplify" role="switch" aria-checked="' + simplify +
                  '" aria-label="Simplify debts"></button>' +
        '</div>' +

        '<div class="sheet-actions">' +
          '<button type="button" class="btn btn-ghost" id="grp-add-member">Add someone by email</button>' +
          '<button type="button" class="btn-text" id="grp-leave" ' +
                  'style="color:var(--danger);align-self:center;padding:10px">Leave this group</button>' +
        '</div>',
      confirm: null,
      cancel: 'Done',
      onOpen: function () {
        document.getElementById('grp-simplify').addEventListener('click', async function () {
          const on = !this.classList.contains('is-on');
          this.classList.toggle('is-on', on);
          this.setAttribute('aria-checked', String(on));
          const { error } = await db.from('groups')
            .update({ simplify_debts: on }).eq('id', gid);
          if (error) return SW.toast(error.message, 'error');
          g.simplify_debts = on;
        });

        document.getElementById('grp-add-member').addEventListener('click', function () {
          SW.closeSheet();
          openAddMember(gid);
        });

        document.getElementById('grp-leave').addEventListener('click', function () {
          SW.closeSheet();
          confirmLeave(gid, g);
        });
      },
    });
  });

  SW.openAddMember = function (gid) { openAddMember(gid); };

  function openAddMember(gid) {
    SW.sheet({
      title: 'Add someone to the group',
      body:
        '<div class="field">' +
          '<label for="mem-email">Their email address</label>' +
          '<input class="input" id="mem-email" type="email" inputmode="email" ' +
                 'autocomplete="off" autocapitalize="off" spellcheck="false" ' +
                 'placeholder="friend@example.com">' +
          '<span class="hint">They need a SplittyWise account already. Adding them ' +
            'here also makes you friends.</span>' +
          '<div class="field-error" id="mem-error"></div>' +
        '</div>',
      confirm: 'Add to group',
      onOpen: function () { document.getElementById('mem-email').focus(); },
      onConfirm: async function (btn) {
        const email = document.getElementById('mem-email').value.trim().toLowerCase();
        if (!SW.isEmail(email)) {
          SW.setError('mem-error', 'That does not look like an email address.');
          return false;
        }

        SW.busy(btn, true);
        const { data, error } = await db.rpc('add_group_member_by_email', {
          p_group_id: gid, p_email: email,
        });
        SW.busy(btn, false);

        if (error) { SW.setError('mem-error', error.message); return false; }
        if (!data || !data.ok) {
          SW.setError('mem-error', data && data.error === 'already'
            ? 'They are already in this group.'
            : 'No SplittyWise account uses that email yet. Ask them to sign up first.');
          return false;
        }

        await SW.refreshLedger();
        SW.toast(data.full_name + ' added to the group', 'ok');
        return true;
      },
    });
  }

  function confirmLeave(gid, g) {
    const net = SW.groupSummary(gid).myNet;
    SW.sheet({
      title: 'Leave ' + g.name + '?',
      body: net !== 0
        ? '<p style="color:var(--owe);font-size:14.5px;font-weight:700">' +
          (net > 0 ? 'You are still owed ' : 'You still owe ') + SW.money(net) +
          ' in this group.</p><p style="color:var(--muted);font-size:14.5px;margin-top:8px">' +
          'Leaving does not clear that. Settle up first if you meant to.</p>'
        : '<p style="color:var(--muted);font-size:14.5px">You are settled up here, so ' +
          'nothing is outstanding. The expenses stay on record for everyone else.</p>',
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
  }

  /* ======================= header action ============================== */

  // The Groups tab's top-right action.
  SW.createGroupAction = openCreateGroup;
})();
