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

          (other.upi_id
            ? '<button type="button" class="btn btn-ghost" id="pay-upi">' +
              '💸 Pay with UPI</button>' +
              '<span class="hint" id="pay-upi-hint">Opens your payment app. ' +
                'Come back and record it — we cannot see whether it went through.' +
              '</span>'
            : '') +

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

        const upi = document.getElementById('pay-upi');
        if (upi) upi.addEventListener('click', function () {
          const paise = parseAmount(document.getElementById('pay-amount').value);
          if (paise <= 0) {
            return SW.setError('pay-error', 'Enter an amount first.');
          }
          if (!iPay) {
            return SW.setError('pay-error',
              'This is set to them paying you. Switch it round to pay them.');
          }
          window.location.href = SW.upiUri({
            vpa: other.upi_id,
            name: other.full_name,
            amountPaise: paise,
            note: (group ? group.name : 'SplittyWise') + ' settle up',
          });
        });

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

        const row = {
          group_id: groupId,
          from_user: iPay ? me : opts.otherId,
          to_user: iPay ? opts.otherId : me,
          amount: SW.rupees(paise),
          note: note || null,
          settled_on: date,
          created_by: me,
        };

        SW.busy(btn, true);
        const { error } = await db.from('settlements').insert(row);
        SW.busy(btn, false);

        if (error && SW.isOfflineError && SW.isOfflineError(error) && SW.outbox) {
          const optimistic = Object.assign({}, row, {
            created_at: new Date().toISOString(), pending: true,
          });
          await SW.outbox.add('settlement', row, optimistic);
          SW.ledger.settlements.unshift(optimistic);
          SW.bumpLedger();
          SW.recompute();
          SW.toast('Saved on this phone — it will sync when you reconnect', 'ok');
          return true;
        }

        if (error) { SW.setError('pay-error', error.message); return false; }

        const before = SW.friendNet(opts.otherId);
        const groupBefore = groupId ? SW.groupSummary(groupId).myNet : 0;
        await SW.refreshLedger();
        if (SW.refreshUnread) SW.refreshUnread();

        const after = SW.friendNet(opts.otherId);
        const groupCleared = groupId && groupBefore !== 0 &&
                             SW.groupSummary(groupId).myNet === 0;

        if (groupCleared) {
          SW.celebrate('All settled up in ' + group.name);
        } else if (before !== 0 && after === 0) {
          SW.celebrate('All square with ' + other.full_name.split(' ')[0]);
        } else {
          SW.toast('Payment recorded', 'ok');
        }
        return true;
      },
    });
  };

  /* ======================= settling everything at once ================ */

  // Settling the overall total as one non-group payment would leave every
  // group's balance untouched and offset by a payment sitting outside them
  // all. So this writes one settlement per group where a balance exists.
  // Undo the most recent payment. The schema decides whether it really is
  // the most recent; this only asks and reports, so the two cannot disagree.
  SW.undoSettlement = function (id, amountPaise) {
    SW.sheet({
      title: 'Undo this payment?',
      body:
        '<p style="color:var(--muted);font-size:14.5px">' +
          (amountPaise
            ? 'The <strong style="color:var(--text)">' + SW.money(amountPaise) +
              '</strong> goes back onto the balance, '
            : 'The balance goes back to ') +
          'exactly as it was before the payment was recorded. Both of you are ' +
          'told, and the payment is kept as a struck-through record rather than ' +
          'erased.</p>' +
        '<p style="color:var(--muted);font-size:13.5px;margin-top:8px">Only the ' +
          'most recent payment can be undone. If you have squared up again ' +
          'since, undo that one first.</p>',
      confirm: 'Undo the payment',
      onConfirm: async function (btn) {
        SW.busy(btn, true);
        const { error } = await db.rpc('undo_settlement', { p_settlement: id });
        SW.busy(btn, false);

        if (error) {
          // The "only the most recent" refusal is a real answer, not a fault.
          SW.toast(error.message.replace(/^.*?:\s*/, ''), 'error');
          return false;
        }

        await SW.refreshLedger();
        if (SW.refreshUnread) SW.refreshUnread();
        SW.toast('Payment undone', 'ok');
        return true;
      },
    });
  };

  SW.settleAllWith = function (friendId) {
    const me = SW.ledger.me;
    const p = SW.person(friendId);
    const nets = SW.friendBalances();
    const byGroup = (nets[friendId] || { byGroup: {} }).byGroup;

    const parts = Object.keys(byGroup)
      .filter(function (k) { return byGroup[k] !== 0; })
      .map(function (k) {
        return {
          groupId: k === 'none' ? null : k,
          label: k === 'none' ? 'Not in a group' : (SW.ledger.groups[k] || {}).name || 'a group',
          amount: byGroup[k],
        };
      })
      .sort(function (a, b) { return Math.abs(b.amount) - Math.abs(a.amount); });

    const total = parts.reduce(function (t, x) { return t + x.amount; }, 0);

    if (!parts.length) {
      return SW.sheet({
        title: 'Already settled',
        rawBody: '<div class="empty" style="padding:26px 24px">' +
          '<div class="empty-art">🎉</div><h3>Nothing outstanding</h3>' +
          '<p>You and ' + esc(p.full_name) + ' are square everywhere.</p></div>',
        confirm: null,
      });
    }

    // Everything one way is the simple case. Mixed directions mean some
    // groups owe each way, and netting them into one payment would be wrong.
    const mixed = parts.some(function (x) { return x.amount > 0; }) &&
                  parts.some(function (x) { return x.amount < 0; });

    SW.sheet({
      title: 'Settle everything',
      rawBody:
        '<div class="sheet-body"><p style="color:var(--muted);font-size:14.5px">' +
          (mixed
            ? 'Some of these run each way, so they are recorded separately rather ' +
              'than netted into one payment.'
            : (total > 0
                ? esc(p.full_name) + ' pays you <strong style="color:var(--owed)">' +
                  SW.money(total) + '</strong> in total.'
                : 'You pay ' + esc(p.full_name) + ' <strong style="color:var(--owe)">' +
                  SW.money(total) + '</strong> in total.')) +
        '</p></div>' +
        '<div>' + parts.map(function (x) {
          return '<div class="plan-row ' + (x.amount < 0 ? 'is-mine' : 'is-owed') +
                   '" style="cursor:default">' +
            '<span class="pl-main"><span class="pl-text">' + esc(x.label) + '</span>' +
            '<span class="pl-sub">' + (x.amount > 0 ? 'they pay you' : 'you pay them') +
            '</span></span>' +
            '<span class="pl-amt">' + SW.money(x.amount) + '</span></div>';
        }).join('') + '</div>' +
        '<div class="split-foot"><span class="sf-state is-ok">' +
          parts.length + (parts.length === 1 ? ' payment' : ' payments') +
        '</span><span class="sf-total">' + SW.money(total) + ' net</span></div>' +

        // One transfer covers every group at once, so offer it before the
        // recording step. Only when it is all one way and all owed by you:
        // paying a netted figure across mixed directions would be wrong.
        (!mixed && total < 0 && p.upi_id
          ? '<div style="padding:12px 16px 4px">' +
              '<button type="button" class="btn btn-ghost" id="sa-upi">' +
                '💸 Pay ' + SW.money(-total) + ' by UPI</button>' +
              '<span class="hint">Opens your payment app with ' +
                esc(p.full_name.split(' ')[0]) + '\u2019s UPI ID and the amount ' +
                'already in. Come back and record it — we cannot see whether ' +
                'it went through.</span>' +
            '</div>'
          : ''),
      confirm: 'Record them all',
      onOpen: function () {
        const upi = document.getElementById('sa-upi');
        if (upi) upi.addEventListener('click', function () {
          window.location.href = SW.upiUri({
            vpa: p.upi_id,
            name: p.full_name,
            amountPaise: -total,
            note: parts.length === 1 ? parts[0].label + ' settle up'
                                     : 'SplittyWise settle up',
          });
        });
      },
      onConfirm: async function (btn) {
        SW.busy(btn, true);

        const rows = parts.map(function (x) {
          return {
            group_id: x.groupId,
            from_user: x.amount > 0 ? friendId : me,
            to_user: x.amount > 0 ? me : friendId,
            amount: SW.rupees(x.amount),
            note: 'Settled up',
            settled_on: today(),
            created_by: me,
          };
        });

        const { error } = await db.from('settlements').insert(rows);
        SW.busy(btn, false);
        if (error) { SW.toast(error.message, 'error'); return false; }

        await SW.refreshLedger();
        if (SW.refreshUnread) SW.refreshUnread();
        SW.celebrate('All square with ' + p.full_name.split(' ')[0]);
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

    const spread = Object.keys((SW.friendBalances()[id] || { byGroup: {} }).byGroup)
      .filter(function (k) { return (SW.friendBalances()[id].byGroup[k]) !== 0; });

    // Spread across more than one group, settling the total as a single
    // payment would leave each group's balance untouched. Offer the
    // group-by-group version instead.
    if (spread.length > 1) return SW.settleAllWith(id);

    // net > 0 means they owe me, so the default is them paying me.
    SW.openPaymentSheet({
      otherId: id,
      groupId: spread[0] === 'none' ? null : spread[0],
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
