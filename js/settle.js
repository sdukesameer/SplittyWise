// ---------------------------------------------------------------------------
//  Settling up — record a payment, and the plan that clears a whole group
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const db = SW.db;
  const esc = SW.escapeHtml;

  function today() {
    const d = new Date();
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  function parseAmount(text) {
    const cleaned = String(text || '').replace(/[^0-9.]/g, '');
    if (!cleaned || cleaned === '.') return 0;
    const parts = cleaned.split('.');
    return SW.toPaise(parts.length > 1
      ? parts[0] + '.' + parts.slice(1).join('').slice(0, 2)
      : parts[0]);
  }

  /* ======================= record one payment ========================= */

  // opts: { otherId, groupId, amountPaise, iPay }
  //   iPay true  -> money goes from me to them
  //   iPay false -> they paid me
  SW.openPaymentSheet = function (opts) {
    const me = SW.ledger.me;
    const other = SW.person(opts.otherId);
    const groupId = opts.groupId || null;
    const group = groupId ? SW.ledger.groups[groupId] : null;

    let iPay = !!opts.iPay;
    let paise = opts.amountPaise || 0;

    function directionHtml() {
      return '<div class="seg" id="pay-dir" role="group" aria-label="Who paid">' +
        '<button type="button" data-dir="out"' + (iPay ? ' class="is-on"' : '') + '>' +
          'You paid ' + esc(other.full_name.split(' ')[0]) + '</button>' +
        '<button type="button" data-dir="in"' + (!iPay ? ' class="is-on"' : '') + '>' +
          esc(other.full_name.split(' ')[0]) + ' paid you</button>' +
      '</div>';
    }

    SW.sheet({
      title: 'Record a payment',
      rawBody:
        '<div class="sheet-body">' +
          directionHtml() +

          '<div class="amount-row">' +
            '<span class="emoji-btn" style="cursor:default">💸</span>' +
            '<span class="amount-field">' +
              '<span class="cur">₹</span>' +
              '<input class="amount-input" id="pay-amount" type="text" ' +
                     'inputmode="decimal" placeholder="0.00" ' +
                     'value="' + (paise ? SW.rupees(paise) : '') + '" aria-label="Amount">' +
            '</span>' +
          '</div>' +

          '<div class="picker-group">' +
            '<label class="picker-row" for="pay-date">' +
              '<span class="pr-label">Date</span>' +
              '<input type="date" id="pay-date" value="' + today() + '" max="' + today() + '">' +
            '</label>' +
          '</div>' +

          '<div class="field">' +
            '<input class="input" id="pay-note" type="text" maxlength="60" ' +
                   'placeholder="Note — UPI, cash, GPay (optional)">' +
          '</div>' +

          (group
            ? '<span class="hint">Recorded in ' + esc(group.name) + '.</span>'
            : '<span class="hint">Recorded outside any group.</span>') +

          '<div class="field-error" id="pay-error" role="alert"></div>' +
        '</div>',
      confirm: 'Record payment',
      onOpen: function () {
        const amount = document.getElementById('pay-amount');
        amount.focus();
        amount.setSelectionRange(amount.value.length, amount.value.length);

        document.getElementById('pay-dir').addEventListener('click', function (e) {
          const b = e.target.closest('[data-dir]');
          if (!b) return;
          iPay = b.getAttribute('data-dir') === 'out';
          this.querySelectorAll('[data-dir]').forEach(function (x) {
            x.classList.toggle('is-on', (x.getAttribute('data-dir') === 'out') === iPay);
          });
        });
      },
      onConfirm: async function (btn) {
        paise = parseAmount(document.getElementById('pay-amount').value);
        const date = document.getElementById('pay-date').value || today();
        const note = document.getElementById('pay-note').value.trim();

        if (paise <= 0) {
          SW.setError('pay-error', 'Enter an amount greater than zero.');
          return false;
        }

        SW.busy(btn, true);
        const { error } = await db.from('settlements').insert({
          group_id: groupId,
          from_user: iPay ? me : opts.otherId,
          to_user: iPay ? opts.otherId : me,
          amount: SW.rupees(paise),
          note: note || null,
          settled_on: date,
          created_by: me,
        });
        SW.busy(btn, false);

        if (error) { SW.setError('pay-error', error.message); return false; }

        await SW.refreshLedger();
        if (SW.refreshUnread) SW.refreshUnread();
        SW.toast('Payment recorded', 'ok');
        return true;
      },
    });
  };

  /* ======================= settling with one friend =================== */

  document.getElementById('friend-settle').addEventListener('click', function () {
    const id = SW.currentFriendId;
    if (!id) return;
    const net = SW.friendNet(id);

    if (net === 0) {
      return SW.sheet({
        title: 'Already settled',
        body: '<p style="color:var(--muted);font-size:14.5px">Nothing is outstanding ' +
              'between you two. You can still record a payment if you want it on record.</p>',
        confirm: 'Record one anyway',
        onConfirm: function () {
          SW.closeSheet();
          SW.openPaymentSheet({ otherId: id, amountPaise: 0, iPay: true });
          return true;
        },
      });
    }

    // net > 0 means they owe me, so the default is them paying me.
    SW.openPaymentSheet({
      otherId: id,
      amountPaise: Math.abs(net),
      iPay: net < 0,
    });
  });

  /* ======================= settling a whole group ===================== */

  document.getElementById('grp-settle').addEventListener('click', function () {
    const gid = SW.currentGroupId;
    if (!SW.ledger) return;

    const summary = SW.groupSummary(gid);
    const group = gid ? SW.ledger.groups[gid] : { name: 'Non-group expenses', simplify_debts: true };
    const me = SW.ledger.me;
    const simplify = !group || group.simplify_debts !== false;

    let transfers;
    if (simplify) {
      transfers = SW.simplifyDebts(summary.nets);
    } else {
      // Without simplification, show only my own pairwise debts.
      transfers = SW.myGroupPairs(gid).map(function (pr) {
        return pr.amount > 0
          ? { from: pr.id, to: me, amount: pr.amount }
          : { from: me, to: pr.id, amount: -pr.amount };
      });
    }

    if (!transfers.length) {
      return SW.sheet({
        title: 'All settled up',
        rawBody: '<div class="empty" style="padding:26px 24px">' +
          '<div class="empty-art">🎉</div>' +
          '<h3>Nothing to settle</h3>' +
          '<p>Everyone in ' + esc(group.name) + ' is square.</p></div>',
        confirm: null,
      });
    }

    const mine = transfers.filter(function (t) { return t.from === me || t.to === me; });
    const others = transfers.filter(function (t) { return t.from !== me && t.to !== me; });

    function rowHtml(t, actionable) {
      const fromName = t.from === me ? 'You' : SW.person(t.from).full_name;
      const toName = t.to === me ? 'you' : SW.person(t.to).full_name;
      const cls = t.from === me ? 'is-mine' : (t.to === me ? 'is-owed' : 'is-other');

      return '<' + (actionable ? 'button' : 'div') + ' class="plan-row ' + cls + '"' +
        (actionable
          ? ' data-pay="' + esc(t.from) + '|' + esc(t.to) + '|' + t.amount + '"'
          : ' style="cursor:default"') +
        '>' +
        SW.avatar(t.from === me ? t.to : t.from,
                  SW.person(t.from === me ? t.to : t.from).avatar_emoji) +
        '<span class="pl-main">' +
          '<span class="pl-text">' + esc(fromName) + ' pays ' + esc(toName) + '</span>' +
          '<span class="pl-sub">' + (actionable ? 'Tap to record it' : 'Between them') + '</span>' +
        '</span>' +
        '<span class="pl-amt">' + SW.money(t.amount) + '</span>' +
      '</' + (actionable ? 'button' : 'div') + '>';
    }

    SW.sheet({
      title: 'Settle up ' + group.name,
      rawBody:
        '<div class="plan-note">' +
          (simplify
            ? 'The fewest payments that clear the whole group — ' + transfers.length +
              (transfers.length === 1 ? ' transfer' : ' transfers') + ' instead of everyone ' +
              'paying everyone.'
            : 'Debt simplification is off, so these are your own balances, unnetted.') +
        '</div>' +
        '<div>' + mine.map(function (t) { return rowHtml(t, true); }).join('') + '</div>' +
        (others.length
          ? '<div class="card-head" style="padding-top:14px">Not involving you</div>' +
            '<div>' + others.map(function (t) { return rowHtml(t, false); }).join('') + '</div>'
          : ''),
      confirm: null,
      cancel: 'Close',
      onOpen: function () {
        document.getElementById('sheet-content').addEventListener('click', function (e) {
          const b = e.target.closest('[data-pay]');
          if (!b) return;
          const [from, to, amt] = b.getAttribute('data-pay').split('|');
          SW.closeSheet();
          SW.openPaymentSheet({
            otherId: from === me ? to : from,
            groupId: gid,
            amountPaise: parseInt(amt, 10),
            iPay: from === me,
          });
        });
      },
    });
  });
})();
