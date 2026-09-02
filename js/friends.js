// ---------------------------------------------------------------------------
//  Friends — the list, the balance summary, add/remove, and one friend's page
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const db = SW.db;
  const esc = SW.escapeHtml;

  const FILTER_KEY = 'splittywise.friendFilter';
  const COLLAPSE_KEY = 'splittywise.hideSettled';

  const FILTERS = {
    none:        'Everyone',
    outstanding: 'Friends with outstanding balances',
    'you-owe':   'Friends you owe',
    'owes-you':  'Friends who owe you',
  };

  let filter = read(FILTER_KEY, 'none');
  let hideSettled = read(COLLAPSE_KEY, '0') === '1';
  let nets = {};
  let showSettledHistory = false;

  function read(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
  }
  function write(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }

  /* ======================= ledger refresh ============================= */

  // Recompute and repaint from the ledger already in memory. Kept separate
  // from refreshLedger so an optimistic change (deleting an expense with an
  // undo window) can be reflected without a refetch that would undo it.
  SW.recompute = function () {
    nets = SW.friendBalances();
    renderSummary();
    renderFriends();

    // Repaint whatever is actually on screen. Naming views individually
    // meant adding an expense from a group page left that page stale, and
    // every new view had to remember to add itself here.
    const view = SW.activeView();
    const hook = SW.viewHooks[view];
    if (hook && view !== 'friends') hook(SW.activeParam());
  };

  SW.friendNet = function (id) {
    return (nets[id] || { net: 0 }).net;
  };

  SW.refreshLedger = async function () {
    try {
      await SW.loadLedger();
    } catch (err) {
      document.getElementById('friends-skel').hidden = true;
      // With a cached ledger already on screen there is nothing to shout
      // about: the figures are simply as of the last successful load.
      if (!SW.ledger) {
        SW.toast('Could not load balances: ' + (err.message || err), 'error');
      }
      return;
    }

    // Writes still waiting to be sent belong in the ledger, or a queued
    // expense would vanish from the balances until it syncs.
    if (SW.outbox) await SW.outbox.applyPending();
    if (SW.cache) SW.cache.save(SW.ledger);
    SW.recompute();
    if (SW.outbox) SW.outbox.render();
  };

  /* ======================= summary ==================================== */

  function renderSummary() {
    const el = document.getElementById('summary-text');
    if (!el) return;
    const total = SW.overallNet(nets);

    if (total > 0) {
      el.innerHTML = 'Overall, you are owed <span class="amt-owed">' +
                     SW.money(total) + '</span>';
    } else if (total < 0) {
      el.innerHTML = 'Overall, you owe <span class="amt-owe">' +
                     SW.money(total) + '</span>';
    } else {
      el.innerHTML = 'Overall, you are <span class="amt-none">all settled up</span>';
    }
  }

  /* ======================= friends list =============================== */

  function stateOf(net) {
    return net > 0 ? 'owed' : (net < 0 ? 'owe' : 'settled');
  }

  function passesFilter(net) {
    if (filter === 'outstanding') return net !== 0;
    if (filter === 'you-owe') return net < 0;
    if (filter === 'owes-you') return net > 0;
    return true;
  }

  function groupName(gid) {
    if (gid === 'none') return 'non-group expenses';
    const g = SW.ledger.groups[gid];
    return g ? '"' + g.name + '"' : 'a group';
  }

  function breakdownHtml(friendName, bucket) {
    const keys = Object.keys(bucket.byGroup);
    // A single source tells you nothing the row above does not already say.
    if (keys.length < 2) return '';

    keys.sort(function (a, b) {
      return Math.abs(bucket.byGroup[b]) - Math.abs(bucket.byGroup[a]);
    });

    return '<div class="breakdown">' + keys.map(function (k) {
      const v = bucket.byGroup[k];
      const cls = v > 0 ? 'bd-owed' : 'bd-owe';
      const text = v > 0
        ? esc(friendName) + ' owes you <span class="' + cls + '">' + SW.money(v) + '</span>'
        : 'You owe ' + esc(friendName) + ' <span class="' + cls + '">' + SW.money(v) + '</span>';
      return '<div class="bd-row">' + text + ' in ' + esc(groupName(k)) + '</div>';
    }).join('') + '</div>';
  }

  function rowHtml(id, bucket) {
    const p = SW.person(id);
    const net = bucket.net;
    const state = stateOf(net);

    let amount;
    if (state === 'settled') {
      amount = '<span class="val">settled up</span>';
    } else {
      // The label stays next to the amount on purpose: colour alone is not
      // a signal everyone can read.
      amount = '<span class="lbl">' + (state === 'owed' ? 'owes you' : 'you owe') +
               '</span><span class="val">' + SW.money(net) + '</span>';
    }

    return '<button class="list-row is-' + state + '" data-friend="' + esc(id) + '">' +
             SW.avatar(id, p.avatar_emoji) +
             '<span class="row-main"><span class="row-title">' + esc(p.full_name) + '</span></span>' +
             '<span class="row-amount">' + amount + '</span>' +
           '</button>' +
           breakdownHtml(p.full_name, bucket);
  }

  function renderFriends() {
    const skel = document.getElementById('friends-skel');
    const body = document.getElementById('friends-body');
    const empty = document.getElementById('friends-empty');
    const filteredEmpty = document.getElementById('friends-filtered-empty');
    const list = document.getElementById('friends-list');
    const settledWrap = document.getElementById('friends-settled-wrap');
    const settledList = document.getElementById('friends-settled-list');

    skel.hidden = true;

    const ids = SW.ledger.friendIds.slice();
    if (!ids.length) {
      body.hidden = true;
      filteredEmpty.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    // Biggest balances first; settled friends drop to their own section.
    const active = [];
    const settled = [];
    ids.forEach(function (id) {
      const bucket = nets[id] || { net: 0, byGroup: {} };
      if (!passesFilter(bucket.net)) return;
      (bucket.net === 0 ? settled : active).push({ id: id, bucket: bucket });
    });

    active.sort(function (a, b) { return Math.abs(b.bucket.net) - Math.abs(a.bucket.net); });
    settled.sort(function (a, b) {
      return SW.person(a.id).full_name.localeCompare(SW.person(b.id).full_name);
    });

    if (!active.length && !settled.length) {
      body.hidden = true;
      filteredEmpty.hidden = false;
      return;
    }
    filteredEmpty.hidden = true;
    body.hidden = false;

    list.innerHTML = active.map(function (r) { return rowHtml(r.id, r.bucket); }).join('');

    if (settled.length) {
      settledWrap.hidden = false;
      document.getElementById('friends-settled-label').textContent =
        'Settled up · ' + settled.length;
      document.getElementById('friends-settled-toggle').textContent =
        hideSettled ? 'Show' : 'Hide';
      settledList.hidden = hideSettled;
      settledList.innerHTML = hideSettled
        ? ''
        : settled.map(function (r) { return rowHtml(r.id, r.bucket); }).join('');
    } else {
      settledWrap.hidden = true;
    }
  }

  SW.viewHooks.friends = function () {
    if (SW.ledger) { renderSummary(); renderFriends(); }
  };

  /* ---- list interactions ---- */

  document.getElementById('friends-list').addEventListener('click', onFriendClick);
  document.getElementById('friends-settled-list').addEventListener('click', onFriendClick);

  function onFriendClick(e) {
    const row = e.target.closest('[data-friend]');
    if (row) SW.navigate('friend/' + row.getAttribute('data-friend'));
  }

  document.getElementById('friends-settled-toggle').addEventListener('click', function () {
    hideSettled = !hideSettled;
    write(COLLAPSE_KEY, hideSettled ? '1' : '0');
    renderFriends();
  });

  document.getElementById('friends-add-more').addEventListener('click', function () { SW.addFriendSheet(); });
  document.getElementById('friends-empty-add').addEventListener('click', function () { SW.addFriendSheet(); });
  document.getElementById('friends-clear-filter').addEventListener('click', function () {
    filter = 'none';
    write(FILTER_KEY, filter);
    renderFriends();
  });

  /* ======================= add a friend =============================== */

  const ADD_ERRORS = {
    no_user: 'No SplittyWise account uses that email yet. Ask them to sign up first, ' +
             'then add them again.',
    self: 'That is your own email address.',
    already: 'You are already friends with them.',
  };

  SW.addFriendSheet = function () {
    SW.sheet({
      title: 'Add a friend',
      body:
        '<div class="field">' +
          '<label for="add-friend-email">Their email address</label>' +
          '<input class="input" id="add-friend-email" type="email" inputmode="email" ' +
                 'autocomplete="off" autocapitalize="off" spellcheck="false" ' +
                 'placeholder="friend@example.com">' +
          '<span class="hint">They need a SplittyWise account already. ' +
            'If they do not, send them a link instead.</span>' +
          '<div class="field-error" id="add-friend-error"></div>' +
        '</div>' +
        '<div class="sheet-actions" style="padding-top:0">' +
          '<button type="button" class="btn-text" id="add-friend-link" ' +
                  'style="align-self:center;padding:8px">🔗 Invite with a link instead</button>' +
        '</div>',
      confirm: 'Add friend',
      onOpen: function () {
        document.getElementById('add-friend-email').focus();
        document.getElementById('add-friend-link').addEventListener('click', function () {
          SW.closeSheet();
          SW.shareInvite(null);
        });
      },
      onConfirm: async function (btn) {
        const input = document.getElementById('add-friend-email');
        const email = input.value.trim().toLowerCase();

        if (!SW.isEmail(email)) {
          SW.setError('add-friend-error', 'That does not look like an email address.');
          return false;
        }

        SW.busy(btn, true);
        const { data, error } = await db.rpc('add_friend_by_email', { friend_email: email });
        SW.busy(btn, false);

        if (error) {
          SW.setError('add-friend-error', error.message);
          return false;
        }
        if (!data || !data.ok) {
          SW.setError('add-friend-error',
            ADD_ERRORS[data && data.error] || 'Could not add them.');
          return false;
        }

        await SW.refreshLedger();
        SW.toast(data.full_name + ' added', 'ok');
        return true;
      },
    });
  };

  /* ======================= filter sheet =============================== */

  SW.friendFilterSheet = function () {
    SW.sheet({
      title: 'Show which friends',
      rawBody: '<div class="opt-list">' + Object.keys(FILTERS).map(function (k) {
        return '<button type="button" class="opt' + (k === filter ? ' is-on' : '') +
               '" data-filter="' + k + '">' + esc(FILTERS[k]) +
               '<svg class="tick" width="19" height="19" aria-hidden="true">' +
               '<use href="#ic-check"/></svg></button>';
      }).join('') + '</div>',
      confirm: null,
      onOpen: function () {
        document.querySelector('.opt-list').addEventListener('click', function (e) {
          const b = e.target.closest('[data-filter]');
          if (!b) return;
          filter = b.getAttribute('data-filter');
          write(FILTER_KEY, filter);
          renderFriends();
          SW.closeSheet();
        });
      },
    });
  };

  /* ======================= one friend's page ========================== */

  SW.currentFriendId = null;

  function renderFriendDetail(friendId) {
    if (friendId !== SW.currentFriendId) showSettledHistory = false;
    SW.currentFriendId = friendId;
    if (!friendId || !SW.ledger) return;

    const p = SW.person(friendId);
    const bucket = nets[friendId] || { net: 0, byGroup: {} };
    const net = bucket.net;
    const state = stateOf(net);

    document.getElementById('friend-avatar').innerHTML = SW.avatar(friendId, p.avatar_emoji);
    document.getElementById('friend-name').textContent = p.full_name;

    const bal = document.getElementById('friend-balance');
    bal.className = 'detail-balance is-' + state;
    bal.textContent = state === 'settled'
      ? 'You are all settled up'
      : (state === 'owed'
          ? p.full_name + ' owes you ' + SW.money(net)
          : 'You owe ' + p.full_name + ' ' + SW.money(net));

    // Remind only makes sense when they are the one who owes.
    document.getElementById('friend-nudge').hidden = !(net > 0);
    document.getElementById('friend-charts').hidden = false;

    // Groups the two of you share, so the friend page says where the money
    // actually sits rather than only the total.
    const shared = SW.sharedGroups(friendId);
    const sharedWrap = document.getElementById('friend-shared');
    sharedWrap.hidden = !shared.length;
    if (shared.length) {
      document.getElementById('friend-shared-list').innerHTML = shared.map(function (sg) {
        const state = stateOf(sg.net);
        return '<button class="list-row is-' + state + '" data-group="' + esc(sg.id) + '">' +
          '<span class="avatar" style="background:var(--surface-2)">' +
            esc(sg.group.emoji) + '</span>' +
          '<span class="row-main"><span class="row-title">' + esc(sg.group.name) +
            '</span></span>' +
          '<span class="row-amount">' + (sg.net === 0
            ? '<span class="val">settled up</span>'
            : '<span class="lbl">' + (sg.net > 0 ? 'owes you' : 'you owe') + '</span>' +
              '<span class="val">' + SW.money(sg.net) + '</span>') +
          '</span></button>';
      }).join('');
    }

    const items = SW.pairLedger(friendId);
    const host = document.getElementById('friend-ledger');
    const empty = document.getElementById('friend-empty');
    const more = document.getElementById('friend-settled-more');

    if (!items.length) {
      host.innerHTML = '';
      more.hidden = true;
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    // Everything older than the last time you squared up is finished
    // business, so it is folded away by default.
    const showCount = SW.settledCutoff(items);
    const hiddenCount = items.length - showCount;
    const visible = showSettledHistory ? items : items.slice(0, showCount);

    let html = '';
    let month = null;
    visible.forEach(function (it) {
      const m = SW.monthLabel(it.date);
      if (m !== month) {
        month = m;
        html += '<div class="month-head">' + esc(m) + '</div>';
      }
      html += itemHtml(it, p.full_name);
      if (it.clearsBalance) {
        html += '<div class="cleared-mark">You fully settled up here</div>';
      }
    });
    host.innerHTML = html;

    if (hiddenCount > 0) {
      more.hidden = false;
      more.textContent = showSettledHistory
        ? 'Hide ' + hiddenCount + ' settled ' + (hiddenCount === 1 ? 'entry' : 'entries')
        : 'Everything before this has been settled up.\nTap to show ' + hiddenCount +
          ' settled ' + (hiddenCount === 1 ? 'entry' : 'entries');
    } else {
      more.hidden = true;
    }
  }

  function itemHtml(it, friendName) {
    const d = new Date(it.date + 'T00:00:00');
    const day = d.getDate();
    const mon = d.toLocaleDateString('en-IN', { month: 'short' });

    let lbl, val, cls, title, sub;

    if (it.kind === 'settlement') {
      // A payment clears a debt rather than creating one, so it reads
      // neutral — the direction lives in the title.
      cls = 'is-flat';
      lbl = 'payment';
      val = SW.money(it.delta);
      title = it.delta > 0 ? 'You paid ' + friendName : friendName + ' paid you';
      sub = it.note ? esc(it.note) : 'Settled up';
    } else {
      const owed = it.delta > 0;
      cls = owed ? 'is-owed' : 'is-owe';
      lbl = owed ? 'you lent' : 'you borrowed';
      val = SW.money(it.delta);
      title = it.title;
      const who = owed ? 'You paid ' + SW.money(it.total) : friendName + ' paid ' + SW.money(it.total);
      const g = it.groupId ? SW.ledger.groups[it.groupId] : null;
      sub = who + (g ? ' · ' + esc(g.name) : '');
    }

    return '<div class="ledger-row">' +
      '<span class="ledger-date"><span class="d">' + day + '</span><br>' +
        '<span class="m">' + esc(mon) + '</span></span>' +
      '<span class="ledger-emoji">' + esc(it.emoji) + '</span>' +
      '<span class="ledger-main">' +
        '<span class="ledger-title">' + esc(title) + '</span>' +
        '<span class="ledger-sub">' + sub + '</span>' +
      '</span>' +
      '<span class="ledger-delta ' + cls + '">' +
        '<span class="lbl">' + lbl + '</span><span class="val">' + val + '</span>' +
      '</span></div>';
  }

  SW.viewHooks['friend-detail'] = function (param) { renderFriendDetail(param); };

  document.getElementById('friend-back').addEventListener('click', function () {
    SW.navigate('friends');
  });

  document.getElementById('friend-add-expense').addEventListener('click', function () {
    SW.openExpenseSheet({ friendId: SW.currentFriendId });
  });

  document.getElementById('friend-charts').addEventListener('click', function () {
    if (SW.openFriendCharts) SW.openFriendCharts(SW.currentFriendId);
  });

  document.getElementById('friend-share').addEventListener('click', async function () {
    const id = SW.currentFriendId;
    const p = SW.person(id);
    const net = SW.friendNet(id);
    const shared = SW.sharedGroups(id).filter(function (sg) { return sg.net !== 0; });

    const lines = [];
    lines.push(net === 0
      ? 'You and ' + p.full_name + ' are all settled up.'
      : (net > 0
          ? p.full_name + ' owes you ' + SW.money(net)
          : 'You owe ' + p.full_name + ' ' + SW.money(net)));

    shared.forEach(function (sg) {
      lines.push('· ' + sg.group.name + ': ' +
        (sg.net > 0 ? 'owes you ' : 'you owe ') + SW.money(sg.net));
    });
    lines.push('');
    lines.push('via SplittyWise');
    const text = lines.join('\n');

    if (navigator.share) {
      try {
        await navigator.share({ title: 'SplittyWise', text: text });
        return;
      } catch (e) { /* dismissed, fall through to copying */ }
    }
    try {
      await navigator.clipboard.writeText(text);
      SW.toast('Summary copied', 'ok');
    } catch (e) {
      SW.sheet({
        title: 'Balance summary',
        rawBody: '<div class="sheet-body"><textarea class="input" rows="6" readonly ' +
                 'style="line-height:1.5">' + esc(text) + '</textarea></div>',
        confirm: null,
      });
    }
  });

  document.getElementById('friend-export').addEventListener('click', function () {
    const p = SW.person(SW.currentFriendId);
    SW.exportCsv({ withFriend: SW.currentFriendId },
      p.full_name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  });

  document.getElementById('friend-settled-more').addEventListener('click', function () {
    showSettledHistory = !showSettledHistory;
    renderFriendDetail(SW.currentFriendId);
  });

  document.getElementById('friend-shared-list').addEventListener('click', function (e) {
    const row = e.target.closest('[data-group]');
    if (row) SW.navigate('group/' + row.getAttribute('data-group'));
  });

  document.getElementById('friend-nudge').addEventListener('click', async function () {
    const id = SW.currentFriendId;
    const owed = SW.friendNet(id);
    if (owed <= 0) return;

    SW.busy(this, true);
    const { data, error } = await db.rpc('nudge', {
      p_user_id: id, p_group_id: null, p_amount: SW.rupees(owed),
    });
    SW.busy(this, false);

    if (error) return SW.toast(error.message, 'error');
    if (!data || !data.ok) {
      const why = {
        too_soon: 'You reminded them recently — give it a few hours.',
        self: 'That is you.',
        stranger: 'You are not connected to them.',
      };
      return SW.toast(why[data && data.error] || 'Could not send that', 'error');
    }
    SW.toast('Reminder sent to ' + SW.person(id).full_name, 'ok');
  });

  /* ---- remove a friend ---- */

  document.getElementById('friend-remove').addEventListener('click', function () {
    const id = SW.currentFriendId;
    const p = SW.person(id);
    const net = (nets[id] || { net: 0 }).net;

    SW.sheet({
      title: 'Remove ' + p.full_name + '?',
      body: net !== 0
        ? '<p style="color:var(--owe);font-size:14.5px;font-weight:700">' +
          (net > 0 ? 'They still owe you ' : 'You still owe them ') + SW.money(net) +
          '.</p><p style="color:var(--muted);font-size:14.5px;margin-top:8px">' +
          'Removing them does not clear that. The expenses stay in the ledger and the ' +
          'balance comes back if you add them again. Settle up first if you meant to.</p>'
        : '<p style="color:var(--muted);font-size:14.5px">You are settled up, so nothing ' +
          'is lost. Shared expenses stay on record and you can add them again any time.</p>',
      confirm: 'Remove friend',
      onConfirm: async function (btn) {
        SW.busy(btn, true);
        const me = SW.ledger.me;
        const { error } = await db
          .from('friendships')
          .delete()
          .eq('user_a', me < id ? me : id)
          .eq('user_b', me < id ? id : me);
        SW.busy(btn, false);

        if (error) { SW.toast(error.message, 'error'); return false; }

        await SW.refreshLedger();
        SW.navigate('friends');
        SW.toast(p.full_name + ' removed', 'ok');
        return true;
      },
    });
  });
})();
