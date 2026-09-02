// ---------------------------------------------------------------------------
//  Expenses — the add/edit form, splitting, receipts, and one expense's page
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const db = SW.db;
  const esc = SW.escapeHtml;

  // Held at module scope so a sub-sheet (the emoji picker) can close the form
  // and reopen it without losing what has been typed.
  let f = null;

  function today() {
    const d = new Date();
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  function blankForm() {
    return {
      id: null,
      amountPaise: 0,
      amountText: '',
      description: '',
      emoji: '🧾',
      emojiManual: false,
      date: today(),
      targetKind: null,      // 'friend' | 'group'
      targetId: null,
      payerId: SW.user.id,
      mode: 'equal',
      included: {},          // userId -> false to leave someone out of an equal split
      exact: {},             // userId -> paise
      percent: {},           // userId -> percent, two decimals
      shares: {},            // userId -> whole shares
      adjust: {},            // userId -> paise owed on top
      note: '',              // typed, or written by the itemised scanner
      receiptPath: null,
      receiptFile: null,
      receiptName: '',
    };
  }

  /* ======================= participants =============================== */

  function participants() {
    if (!f || !f.targetId) return [];
    const me = SW.ledger.me;

    if (f.targetKind === 'friend') return [me, f.targetId];

    const members = (SW.ledger.members[f.targetId] || []).slice();
    // Belt and braces: I should always be a member of a group I can see.
    if (members.indexOf(me) === -1) members.unshift(me);
    return members;
  }

  function targetLabel() {
    if (!f.targetId) return '';
    if (f.targetKind === 'friend') return SW.person(f.targetId).full_name;
    const g = SW.ledger.groups[f.targetId];
    return g ? g.name : 'a group';
  }

  /* ======================= amount parsing ============================= */

  function parseAmount(text) {
    // Tolerate "1,200", "₹1200", "1200." — anything a person might type.
    const cleaned = String(text || '').replace(/[^0-9.]/g, '');
    if (!cleaned || cleaned === '.') return 0;
    const parts = cleaned.split('.');
    const normalised = parts.length > 1
      ? parts[0] + '.' + parts.slice(1).join('').slice(0, 2)
      : parts[0];
    return SW.toPaise(normalised);
  }

  /* ======================= the form =================================== */

  SW.openExpenseSheet = function (opts) {
    opts = opts || {};

    if (!SW.ledger) return SW.toast('Still loading — try again in a second');

    if (opts.keepState && f) {
      // Reopening after a sub-sheet.
    } else if (opts.expenseId) {
      const e = findExpense(opts.expenseId);
      if (!e) return SW.toast('That expense is no longer available', 'error');
      f = fromExpense(e);
    } else {
      f = blankForm();
      if (opts.friendId) { f.targetKind = 'friend'; f.targetId = opts.friendId; }
      if (opts.groupId) { f.targetKind = 'group'; f.targetId = opts.groupId; }
    }

    const friends = SW.ledger.friendIds.slice().sort(function (a, b) {
      return SW.person(a).full_name.localeCompare(SW.person(b).full_name);
    });
    const groupIds = Object.keys(SW.ledger.groups).sort(function (a, b) {
      return SW.ledger.groups[a].name.localeCompare(SW.ledger.groups[b].name);
    });

    if (!friends.length && !groupIds.length) {
      return SW.sheet({
        title: 'Nobody to split with yet',
        body: '<p style="color:var(--muted);font-size:14.5px">Add a friend by email ' +
              'first, then you can split an expense with them.</p>',
        confirm: 'Add a friend',
        onConfirm: function () { SW.closeSheet(); SW.addFriendSheet(); return true; },
      });
    }

    const selected = f.targetId ? f.targetKind + ':' + f.targetId : '';

    SW.sheet({
      title: f.id ? 'Edit expense' : 'Add an expense',
      rawBody:
        '<div class="sheet-body">' +

          '<div class="amount-row">' +
            '<button type="button" class="emoji-btn" id="exp-f-emoji" ' +
                    'aria-label="Change the icon">' + esc(f.emoji) + '</button>' +
            '<span class="amount-field">' +
              '<span class="cur">₹</span>' +
              '<input class="amount-input" id="exp-f-amount" type="text" ' +
                     'inputmode="decimal" placeholder="0.00" ' +
                     'value="' + esc(f.amountText) + '" aria-label="Amount">' +
            '</span>' +
          '</div>' +

          '<div class="field">' +
            '<input class="input" id="exp-f-desc" type="text" maxlength="80" ' +
                   'placeholder="What was it for?" value="' + esc(f.description) + '" ' +
                   'aria-label="Description">' +
          '</div>' +

          '<div class="picker-group">' +
            '<label class="picker-row" for="exp-f-target">' +
              '<span class="pr-label">Split with</span>' +
              '<select id="exp-f-target" required>' +
                '<option value=""' + (selected ? '' : ' selected') + ' disabled>Choose…</option>' +
                (friends.length
                  ? '<optgroup label="Friends">' + friends.map(function (id) {
                      const v = 'friend:' + id;
                      return '<option value="' + esc(v) + '"' +
                             (v === selected ? ' selected' : '') + '>' +
                             esc(SW.person(id).full_name) + '</option>';
                    }).join('') + '</optgroup>'
                  : '') +
                (groupIds.length
                  ? '<optgroup label="Groups">' + groupIds.map(function (id) {
                      const v = 'group:' + id;
                      const g = SW.ledger.groups[id];
                      return '<option value="' + esc(v) + '"' +
                             (v === selected ? ' selected' : '') + '>' +
                             esc(g.emoji + ' ' + g.name) + '</option>';
                    }).join('') + '</optgroup>'
                  : '') +
              '</select>' +
              '<svg class="chev" width="17" height="17" aria-hidden="true">' +
                '<use href="#ic-chev"/></svg>' +
            '</label>' +

            '<label class="picker-row" for="exp-f-payer">' +
              '<span class="pr-label">Paid by</span>' +
              '<select id="exp-f-payer"></select>' +
              '<svg class="chev" width="17" height="17" aria-hidden="true">' +
                '<use href="#ic-chev"/></svg>' +
            '</label>' +

            '<label class="picker-row" for="exp-f-date">' +
              '<span class="pr-label">Date</span>' +
              '<input type="date" id="exp-f-date" value="' + esc(f.date) + '" ' +
                     'max="' + today() + '">' +
            '</label>' +
          '</div>' +

          '<div id="exp-f-split"></div>' +

          '<button type="button" class="btn btn-ghost" id="exp-f-scan">' +
            '🧾 Scan a receipt to itemise' +
          '</button>' +

          (f.note
            ? '<div class="callout" id="exp-f-note">' + esc(f.note) + '</div>'
            : '') +

          '<div class="receipt-row">' +
            '<input type="file" id="exp-f-file" accept="image/*" hidden>' +
            '<button type="button" class="receipt-drop" id="exp-f-receipt">' +
              (f.receiptName || f.receiptPath ? '📎 ' + esc(f.receiptName || 'Receipt attached')
                                              : '📷 Attach a photo instead') +
            '</button>' +
          '</div>' +

          '<div class="field-error" id="exp-f-error" role="alert"></div>' +
        '</div>',
      confirm: f.id ? 'Save changes' : 'Add expense',
      onOpen: wireForm,
      onConfirm: save,
    });
  };

  function wireForm() {
    const amount = document.getElementById('exp-f-amount');
    const desc = document.getElementById('exp-f-desc');
    const target = document.getElementById('exp-f-target');
    const date = document.getElementById('exp-f-date');

    amount.addEventListener('input', function () {
      f.amountText = amount.value;
      f.amountPaise = parseAmount(amount.value);
      renderSplit();
    });

    desc.addEventListener('input', function () {
      f.description = desc.value;
      if (!f.emojiManual) {
        f.emoji = SW.guessEmoji(desc.value);
        document.getElementById('exp-f-emoji').textContent = f.emoji;
      }
    });

    target.addEventListener('change', function () {
      const [kind, id] = target.value.split(':');
      f.targetKind = kind;
      f.targetId = id;
      // Participants changed, so a previous payer or exact split may no
      // longer make sense.
      if (participants().indexOf(f.payerId) === -1) f.payerId = SW.ledger.me;
      f.included = {}; f.exact = {}; f.percent = {}; f.shares = {}; f.adjust = {};
      renderPayer();
      renderSplit();
    });

    date.addEventListener('change', function () { f.date = date.value || today(); });

    document.getElementById('exp-f-emoji').addEventListener('click', function () {
      SW.closeSheet();
      openEmojiPicker();
    });

    document.getElementById('exp-f-scan').addEventListener('click', function () {
      if (!f.targetId) {
        return SW.setError('exp-f-error',
          'Choose a friend or group first, so the scanner knows who to split between.');
      }
      const people = participants();
      if (people.length < 2) {
        return SW.setError('exp-f-error',
          'That group needs at least two people before an itemised split makes sense.');
      }

      // The form closes while the scanner runs, then comes back with the
      // itemisation applied — or unchanged if it was cancelled.
      SW.closeSheet();
      SW.openScanner({
        participants: people,
        onApply: function (result) {
          f.amountPaise = result.grandTotal;
          f.amountText = SW.rupees(result.grandTotal);
          f.mode = 'exact';
          f.exact = result.totals;
          f.included = {}; f.percent = {}; f.shares = {}; f.adjust = {};
          f.note = result.note;
          if (!f.description.trim()) {
            const lines = (result.note.match(/;/g) || []).length + 1;
            f.description = 'Order · ' + lines + (lines === 1 ? ' item' : ' items');
            if (!f.emojiManual) f.emoji = SW.guessEmoji(f.description);
          }
          SW.openExpenseSheet({ keepState: true });
          SW.toast('Itemised — shares filled in', 'ok');
        },
        onCancel: function () { SW.openExpenseSheet({ keepState: true }); },
      });
    });

    const file = document.getElementById('exp-f-file');
    document.getElementById('exp-f-receipt').addEventListener('click', function () {
      file.click();
    });
    file.addEventListener('change', function () {
      const chosen = file.files && file.files[0];
      if (!chosen) return;
      if (chosen.size > 8 * 1024 * 1024) {
        return SW.setError('exp-f-error', 'That image is over 8 MB. Try a smaller one.');
      }
      f.receiptFile = chosen;
      f.receiptName = chosen.name;
      document.getElementById('exp-f-receipt').textContent = '📎 ' + chosen.name;
      SW.setError('exp-f-error', '');
    });

    if (!f.emojiManual && f.description) f.emoji = SW.guessEmoji(f.description);
    renderPayer();
    renderSplit();

    if (!f.targetId) target.focus();
    else amount.focus();
  }

  function renderPayer() {
    const sel = document.getElementById('exp-f-payer');
    if (!sel) return;
    const people = participants();

    if (!people.length) {
      sel.innerHTML = '<option value="">—</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML = people.map(function (id) {
      const name = id === SW.ledger.me ? 'You' : SW.person(id).full_name;
      return '<option value="' + esc(id) + '"' +
             (id === f.payerId ? ' selected' : '') + '>' + esc(name) + '</option>';
    }).join('');

    sel.onchange = function () { f.payerId = sel.value; renderSplit(); };
  }

  function splitState() {
    return {
      included: f.included, exact: f.exact,
      percent: f.percent, shares: f.shares, adjust: f.adjust,
    };
  }

  function currentSplit() {
    return SW.computeSplit(f.mode, f.amountPaise, participants(), splitState());
  }

  function renderSplit() {
    const host = document.getElementById('exp-f-split');
    if (!host) return;

    const people = participants();
    if (!people.length) { host.innerHTML = ''; return; }

    const mode = SW.SPLIT_MODES.filter(function (m) { return m.key === f.mode; })[0] ||
                 SW.SPLIT_MODES[0];
    const result = currentSplit();

    host.innerHTML =
      '<div class="split-block">' +
        '<div class="split-modes" id="exp-f-mode" role="group" aria-label="How to split">' +
          SW.SPLIT_MODES.map(function (m) {
            return '<button type="button" data-mode="' + m.key + '"' +
                   (m.key === f.mode ? ' class="is-on"' : '') + '>' +
                   esc(m.label) + '</button>';
          }).join('') +
        '</div>' +
        '<div class="split-blurb">' + esc(mode.blurb) + '</div>' +
        '<div class="split-list">' +
          people.map(function (id) { return personRow(id, result); }).join('') +
        '</div>' +
        '<div class="split-foot">' +
          '<span class="sf-state ' + (result.valid ? 'is-ok' : 'is-off') + '">' +
            esc(result.message) + '</span>' +
          '<span class="sf-total">' + esc(result.hint || SW.money(result.assigned) +
            ' of ' + SW.money(f.amountPaise)) + '</span>' +
        '</div>' +
      '</div>';

    wireSplit();
  }

  function personRow(id, result) {
    const p = SW.person(id);
    const name = (id === SW.ledger.me ? 'You' : p.full_name) +
                 (id === f.payerId ? ' · paid' : '');
    const amount = result.byUser[id] || 0;
    const avatar = SW.avatar(id, p.avatar_emoji);
    const label = '<span class="sp-name">' + esc(name) + '</span>';

    if (f.mode === 'equal') {
      const on = f.included[id] !== false;
      return '<div class="split-person is-toggle ' + (on ? 'is-on' : 'is-off') +
               '" data-toggle="' + esc(id) + '" role="checkbox" aria-checked="' + on + '">' +
        avatar + label +
        '<span class="sp-fixed">' + (on ? SW.money(amount) : '—') + '</span>' +
        '<span class="sp-check"><svg aria-hidden="true"><use href="#ic-check"/></svg></span>' +
      '</div>';
    }

    if (f.mode === 'exact') {
      return '<div class="split-person">' + avatar + label +
        '<span class="sp-amount"><span class="cur">₹</span>' +
        '<input type="text" inputmode="decimal" data-exact="' + esc(id) + '" ' +
        'value="' + (f.exact[id] ? SW.rupees(f.exact[id]) : '') + '" ' +
        'placeholder="0.00" aria-label="Amount for ' + esc(p.full_name) + '"></span>' +
      '</div>';
    }

    if (f.mode === 'percent') {
      return '<div class="split-person">' + avatar + label +
        '<span class="sp-derived">' + SW.money(amount) + '</span>' +
        '<span class="sp-unit"><input type="text" inputmode="decimal" ' +
        'data-percent="' + esc(id) + '" value="' + (f.percent[id] || '') + '" ' +
        'placeholder="0" aria-label="Percent for ' + esc(p.full_name) + '">' +
        '<span class="suffix">%</span></span>' +
      '</div>';
    }

    if (f.mode === 'shares') {
      return '<div class="split-person">' + avatar + label +
        '<span class="sp-derived">' + SW.money(amount) + '</span>' +
        '<span class="sp-unit"><input type="text" inputmode="numeric" ' +
        'data-shares="' + esc(id) + '" value="' + (f.shares[id] || '') + '" ' +
        'placeholder="0" aria-label="Shares for ' + esc(p.full_name) + '">' +
        '<span class="suffix">sh</span></span>' +
      '</div>';
    }

    // adjust
    return '<div class="split-person">' + avatar + label +
      '<span class="sp-derived">' + SW.money(amount) + '</span>' +
      '<span class="sp-unit"><span class="prefix">+₹</span>' +
      '<input type="text" inputmode="decimal" data-adjust="' + esc(id) + '" ' +
      'value="' + (f.adjust[id] ? SW.rupees(f.adjust[id]) : '') + '" ' +
      'placeholder="0.00" aria-label="Extra for ' + esc(p.full_name) + '"></span>' +
    '</div>';
  }

  function wireSplit() {
    document.getElementById('exp-f-mode').addEventListener('click', function (e) {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      const next = b.getAttribute('data-mode');
      if (next === f.mode) return;
      seedMode(next);
      f.mode = next;
      renderSplit();
    });

    // Whole-row toggles for the equal split.
    document.querySelectorAll('[data-toggle]').forEach(function (row) {
      row.addEventListener('click', function () {
        const id = row.getAttribute('data-toggle');
        f.included[id] = f.included[id] === false;
        renderSplit();
      });
    });

    // Typed inputs update the model and only the derived figures, so focus is
    // never yanked away mid-edit by a full re-render.
    bind('data-exact', function (id, raw) { f.exact[id] = parseAmount(raw); });
    bind('data-adjust', function (id, raw) { f.adjust[id] = parseAmount(raw); });
    bind('data-percent', function (id, raw) {
      const n = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
      f.percent[id] = isFinite(n) ? Math.min(100, n) : 0;
    });
    bind('data-shares', function (id, raw) {
      const n = parseInt(String(raw).replace(/[^0-9]/g, ''), 10);
      f.shares[id] = isFinite(n) ? Math.min(99, n) : 0;
    });
  }

  function bind(attr, apply) {
    document.querySelectorAll('[' + attr + ']').forEach(function (input) {
      input.addEventListener('input', function () {
        apply(input.getAttribute(attr), input.value);
        updateDerived();
      });
    });
  }

  // Switching mode carries the current numbers across rather than blanking
  // the screen, so a mode can be tried without losing the work.
  function seedMode(next) {
    const people = participants();
    const current = currentSplit().byUser;

    if (next === 'exact') {
      people.forEach(function (id) { f.exact[id] = current[id] || 0; });
    } else if (next === 'percent') {
      const anySet = people.some(function (id) { return f.percent[id]; });
      if (!anySet && f.amountPaise > 0) {
        people.forEach(function (id) {
          f.percent[id] = Math.round(((current[id] || 0) / f.amountPaise) * 10000) / 100;
        });
      }
    } else if (next === 'shares') {
      const anySet = people.some(function (id) { return f.shares[id]; });
      if (!anySet) people.forEach(function (id) { f.shares[id] = 1; });
    }
    // 'equal' and 'adjust' start from their own defaults, which are already
    // "everyone in" and "no adjustments".
  }

  function updateDerived() {
    const result = currentSplit();

    document.querySelectorAll('.split-person').forEach(function (row) {
      const input = row.querySelector('[data-percent], [data-shares], [data-adjust]');
      if (!input) return;
      const id = input.getAttribute('data-percent') || input.getAttribute('data-shares') ||
                 input.getAttribute('data-adjust');
      const cell = row.querySelector('.sp-derived');
      if (cell) cell.textContent = SW.money(result.byUser[id] || 0);
    });

    const foot = document.querySelector('.split-foot');
    if (!foot) return;
    const state = foot.querySelector('.sf-state');
    state.className = 'sf-state ' + (result.valid ? 'is-ok' : 'is-off');
    state.textContent = result.message;
    foot.querySelector('.sf-total').textContent = result.hint ||
      (SW.money(result.assigned) + ' of ' + SW.money(f.amountPaise));
  }

  /* ======================= emoji sub-sheet ============================ */

  function openEmojiPicker() {
    // Closing this sheet for ANY reason returns to the form. Picking an
    // emoji just sets it and closes, so there is one path back rather than
    // two that could both fire and open the form twice.
    SW.sheet({
      title: 'Pick an icon',
      rawBody: SW.EMOJI_GROUPS.map(function (g) {
        return '<div class="card-head">' + esc(g.label) + '</div>' +
               '<div class="emoji-grid">' + g.items.map(function (e) {
                 return '<button type="button" data-pick="' + esc(e) + '"' +
                        (e === f.emoji ? ' class="is-on"' : '') + '>' + e + '</button>';
               }).join('') + '</div>';
      }).join(''),
      confirm: null,
      cancel: 'Back',
      onOpen: function () {
        document.getElementById('sheet-content').addEventListener('click', function (e) {
          const b = e.target.closest('[data-pick]');
          if (!b) return;
          f.emoji = b.getAttribute('data-pick');
          f.emojiManual = true;
          SW.closeSheet();
        });
      },
      onClose: function () {
        if (f) SW.openExpenseSheet({ keepState: true });
      },
    });
  }

  /* ======================= saving ===================================== */

  async function uploadReceipt() {
    const file = f.receiptFile;
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    // The storage policy only admits uploads under your own uid prefix.
    const path = SW.user.id + '/' + Date.now() + '.' + (ext || 'jpg');

    const { error } = await db.storage.from('receipts').upload(path, file, {
      contentType: file.type || 'image/jpeg',
      upsert: false,
    });
    if (error) throw error;
    return path;
  }

  async function save(btn) {
    SW.setError('exp-f-error', '');

    if (f.amountPaise <= 0) {
      return fail('Enter an amount greater than zero.');
    }
    if (!f.description.trim()) {
      return fail('Add a short description.');
    }
    if (!f.targetId) {
      return fail('Choose a friend or a group to split this with.');
    }

    const people = participants();
    if (!people.length) {
      return fail('There is nobody to split this with.');
    }

    const result = currentSplit();
    if (!result.valid) return fail(result.message + '.');

    // Anyone on zero is simply not part of this expense, so they are left
    // off it rather than recorded as owing nothing.
    const split = {};
    people.forEach(function (id) {
      if (result.byUser[id] > 0) split[id] = result.byUser[id];
    });
    if (!Object.keys(split).length) {
      return fail('Nobody has been given a share yet.');
    }

    SW.busy(btn, true);
    try {
      let receiptPath = f.receiptPath;
      if (f.receiptFile) receiptPath = await uploadReceipt();

      const args = {
        p_amount: SW.rupees(f.amountPaise),
        p_description: f.description.trim(),
        p_splits: SW.splitsPayload(split),
        p_payer_id: f.payerId,
        p_emoji: f.emoji,
        // Derived from the emoji, so the picker and the charts can never
        // disagree about what counts as groceries.
        p_category: SW.categoryForEmoji(f.emoji),
        p_split_mode: f.mode,
        p_expense_date: f.date,
        p_notes: f.note || null,
        p_receipt_path: receiptPath,
      };

      // Always sent, for both create and update: null means the expense is
      // not in a group. Editing the target therefore actually moves it.
      args.p_group_id = f.targetKind === 'group' ? f.targetId : null;

      let error;
      if (f.id) {
        args.p_expense_id = f.id;
        ({ error } = await db.rpc('update_expense', args));
      } else {
        ({ error } = await db.rpc('create_expense', args));
      }
      if (error) throw error;

      await SW.refreshLedger();
      if (SW.refreshUnread) SW.refreshUnread();
      SW.toast(f.id ? 'Expense updated' : 'Expense added', 'ok');
      f = null;
      return true;
    } catch (err) {
      SW.busy(btn, false);
      return fail(err.message || String(err));
    }

    function fail(message) {
      SW.busy(btn, false);
      SW.setError('exp-f-error', message);
      return false;
    }
  }

  /* ======================= one expense's page ========================= */

  SW.currentExpenseId = null;

  function findExpense(id) {
    if (!SW.ledger) return null;
    return SW.ledger.expenses.find(function (e) { return e.id === id; }) || null;
  }

  function fromExpense(e) {
    const paise = SW.toPaise(e.amount);
    const exact = {};
    const included = {};
    const percent = {};

    (e.expense_splits || []).forEach(function (sp) {
      exact[sp.user_id] = SW.toPaise(sp.amount);
      included[sp.user_id] = true;
      percent[sp.user_id] = paise
        ? Math.round((SW.toPaise(sp.amount) / paise) * 10000) / 100
        : 0;
    });

    // Only the amounts are stored, not the shares or adjustments that
    // produced them. Percentages can be derived back exactly enough; shares
    // and adjustments cannot, so those open as exact amounts — which
    // preserves the money rather than silently re-deriving a different split.
    let mode = e.split_mode || 'equal';
    if (mode === 'shares' || mode === 'adjust') mode = 'exact';

    return {
      id: e.id,
      amountPaise: paise,
      amountText: SW.rupees(paise),
      description: e.description,
      emoji: e.emoji || '🧾',
      emojiManual: true,
      date: e.expense_date,
      targetKind: e.group_id ? 'group' : 'friend',
      targetId: e.group_id || otherPartyOf(e),
      payerId: e.payer_id,
      mode: mode,
      included: included,
      exact: exact,
      percent: percent,
      shares: {},
      adjust: {},
      note: e.notes || '',
      receiptPath: e.receipt_path || null,
      receiptFile: null,
      receiptName: e.receipt_path ? 'Receipt attached' : '',
    };
  }

  function otherPartyOf(e) {
    const me = SW.ledger.me;
    const ids = (e.expense_splits || []).map(function (s) { return s.user_id; });
    ids.push(e.payer_id);
    const other = ids.find(function (id) { return id !== me; });
    return other || null;
  }

  SW.renderExpenseDetail = function (id) {
    SW.currentExpenseId = id;
    if (!SW.ledger) return;

    const e = findExpense(id);
    const missing = document.getElementById('exp-missing');
    const bar = document.querySelector('[data-view="expense-detail"] .detail-bar');

    if (!e) {
      missing.hidden = false;
      document.getElementById('exp-share').hidden = true;
      document.getElementById('exp-receipt').hidden = true;
      document.getElementById('exp-splits').innerHTML = '';
      document.getElementById('exp-desc').textContent = '';
      document.getElementById('exp-amount').textContent = '';
      document.getElementById('exp-meta').textContent = '';
      document.getElementById('exp-emoji').textContent = '🤷';
      if (bar) bar.hidden = true;
      return;
    }
    missing.hidden = true;
    if (bar) bar.hidden = false;

    const me = SW.ledger.me;
    const total = SW.toPaise(e.amount);
    const splits = e.expense_splits || [];
    const mine = splits.find(function (s) { return s.user_id === me; });
    const minePaise = mine ? SW.toPaise(mine.amount) : 0;
    const payer = SW.person(e.payer_id);
    const group = e.group_id ? SW.ledger.groups[e.group_id] : null;

    document.getElementById('exp-emoji').textContent = e.emoji || '🧾';
    document.getElementById('exp-desc').textContent = e.description;
    document.getElementById('exp-amount').textContent = SW.money(total);
    document.getElementById('exp-meta').textContent =
      (e.payer_id === me ? 'You paid' : payer.full_name + ' paid') +
      ' · ' + SW.formatDate(e.expense_date) +
      (group ? ' · ' + group.name : ' · not in a group');

    // What this expense means for me specifically.
    const share = document.getElementById('exp-share');
    const label = document.getElementById('exp-share-label');
    const value = document.getElementById('exp-share-value');
    share.hidden = false;

    if (e.payer_id === me) {
      const lent = total - minePaise;
      share.className = 'exp-your-share ' + (lent > 0 ? 'is-owed' : 'is-flat');
      label.textContent = lent > 0 ? 'You lent' : 'Your share';
      value.textContent = SW.money(lent > 0 ? lent : minePaise);
    } else if (mine) {
      share.className = 'exp-your-share is-owe';
      label.textContent = 'You owe ' + payer.full_name;
      value.textContent = SW.money(minePaise);
    } else {
      share.className = 'exp-your-share is-flat';
      label.textContent = 'You are not in this split';
      value.textContent = '—';
    }

    // The itemised breakdown, if this expense was scanned.
    const noteEl = document.getElementById('exp-note');
    if (e.notes) {
      noteEl.textContent = e.notes;
      noteEl.hidden = false;
    } else {
      noteEl.hidden = true;
    }

    // Receipt, behind a short-lived signed URL rather than a public one.
    const img = document.getElementById('exp-receipt');
    img.hidden = true;
    if (e.receipt_path) {
      db.storage.from('receipts').createSignedUrl(e.receipt_path, 3600)
        .then(function (res) {
          if (res.data && res.data.signedUrl && SW.currentExpenseId === id) {
            img.src = res.data.signedUrl;
            img.hidden = false;
          }
        });
    }

    document.getElementById('exp-splits').innerHTML = splits
      .slice()
      .sort(function (a, b) { return SW.toPaise(b.amount) - SW.toPaise(a.amount); })
      .map(function (s) {
        const p = SW.person(s.user_id);
        const name = (s.user_id === me ? 'You' : p.full_name);
        return '<div class="list-row" style="cursor:default">' +
          SW.avatar(s.user_id, p.avatar_emoji) +
          '<span class="row-main"><span class="row-title">' + esc(name) + '</span>' +
            (s.user_id === e.payer_id
              ? '<span class="row-sub">paid ' + SW.money(total) + '</span>' : '') +
          '</span>' +
          '<span class="row-amount"><span class="val" style="color:var(--text)">' +
            SW.money(SW.toPaise(s.amount)) + '</span></span>' +
        '</div>';
      }).join('');
  };

  SW.viewHooks['expense-detail'] = function (param) { SW.renderExpenseDetail(param); };

  /* ======================= detail actions ============================= */

  document.getElementById('exp-back').addEventListener('click', function () {
    if (history.length > 1) history.back();
    else SW.navigate('friends');
  });
  document.getElementById('exp-missing-back').addEventListener('click', function () {
    SW.navigate('friends');
  });

  document.getElementById('exp-edit').addEventListener('click', function () {
    SW.openExpenseSheet({ expenseId: SW.currentExpenseId });
  });

  document.getElementById('exp-delete').addEventListener('click', function () {
    const id = SW.currentExpenseId;
    const e = findExpense(id);
    if (!e) return;

    // Optimistic: drop it from the ledger now so balances move immediately,
    // and only commit the delete when the undo window closes. Undo therefore
    // cancels rather than reverses — nothing is reconstructed and nobody
    // gets a second round of notifications.
    const index = SW.ledger.expenses.findIndex(function (x) { return x.id === id; });
    const removed = SW.ledger.expenses.splice(index, 1)[0];
    SW.recompute();

    if (history.length > 1) history.back();
    else SW.navigate('friends');

    SW.toastAction(
      'Deleted "' + e.description + '"',
      'Undo',
      function () {
        SW.ledger.expenses.splice(index, 0, removed);
        SW.recompute();
      },
      async function () {
        const { error } = await db.from('expenses').delete().eq('id', id);
        if (error) {
          SW.ledger.expenses.splice(index, 0, removed);
          SW.recompute();
          SW.toast('Could not delete it: ' + error.message, 'error');
          return;
        }
        await SW.refreshLedger();
      },
      5000
    );
  });

  /* ======================= entry points =============================== */

  document.getElementById('fab').addEventListener('click', function () {
    const view = SW.activeView();
    if (view === 'friend-detail') return SW.openExpenseSheet({ friendId: SW.currentFriendId });
    if (view === 'group-detail') return SW.openExpenseSheet({ groupId: SW.currentGroupId });
    SW.openExpenseSheet({});
  });
})();
