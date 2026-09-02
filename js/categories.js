// ---------------------------------------------------------------------------
//  Categories and monthly budgets
//
//  Expenses store their category as plain text, so a category can be renamed
//  or removed without migrating anything. A row here exists either to add a
//  category the built-in list does not cover, or to hang a budget on one it
//  does.
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const db = SW.db;
  const esc = SW.escapeHtml;

  function render() {
    if (!SW.ledger) return;

    const list = SW.categoryList();
    const status = SW.budgetStatus();
    const spendByName = {};
    status.forEach(function (s) { spendByName[s.name] = s; });

    // This month against the caps, so the page opens on the answer.
    const summary = document.getElementById('cat-budget-summary');
    if (status.length) {
      const totalBudget = status.reduce(function (t, s) { return t + s.budget; }, 0);
      const totalSpent = status.reduce(function (t, s) { return t + s.spent; }, 0);
      const over = status.filter(function (s) { return s.over; });

      summary.innerHTML =
        '<div class="budget-card">' +
          '<h3>' + esc(SW.monthLabel(new Date().toISOString().slice(0, 7) + '-01')) + '</h3>' +
          '<div class="bc-sub">' + SW.money(totalSpent) + ' of ' + SW.money(totalBudget) +
            (over.length
              ? ' · <span style="color:var(--owe);font-weight:800">' + over.length +
                (over.length === 1 ? ' category over' : ' categories over') + '</span>'
              : ' · all within budget') +
          '</div>' +
          status.map(function (s) {
            return '<div class="budget-line">' +
              '<div class="bl-top">' +
                '<span class="bl-name">' + esc(s.name) + '</span>' +
                '<span class="bl-num' + (s.over ? ' is-over' : '') + '">' +
                  SW.money(s.spent) + '</span>' +
                '<span class="bl-num" style="color:var(--faint);font-weight:600">/ ' +
                  SW.money(s.budget) + '</span>' +
              '</div>' +
              '<div class="budget-track' +
                (s.over ? ' is-over' : (s.pct >= 80 ? ' is-close' : '')) + '">' +
                '<span style="width:' + s.pct + '%"></span></div>' +
            '</div>';
          }).join('') +
        '</div>';
    } else {
      summary.innerHTML =
        '<div class="budget-card"><h3>No budgets yet</h3>' +
          '<div class="bc-sub" style="margin-bottom:0">Tap a category to cap it. ' +
            'The charts then tell you when you are close, instead of only what ' +
            'happened.</div></div>';
    }

    document.getElementById('cat-builtin').innerHTML =
      list.filter(function (c) { return !c.custom; }).map(row).join('');

    const custom = list.filter(function (c) { return c.custom; });
    document.getElementById('cat-custom').innerHTML = custom.length
      ? custom.map(row).join('')
      : '<div class="comments-empty">None yet. Add one for anything the built-in ' +
        'list does not cover.</div>';

    const sub = document.getElementById('sub-categories');
    if (sub) {
      sub.textContent = status.length
        ? status.length + (status.length === 1 ? ' budget set' : ' budgets set')
        : 'Cap what you spend, per month';
    }

    function row(c) {
      const s = spendByName[c.name];
      return '<button class="budget-row" data-cat="' + esc(c.name) + '">' +
        '<span class="ledger-emoji">' + esc(c.emoji || emojiFor(c.name)) + '</span>' +
        '<span class="budget-main">' +
          '<span class="budget-name">' + esc(c.name) +
            (c.custom ? '' : '') + '</span>' +
          '<span class="budget-sub">' +
            (s
              ? SW.money(s.spent) + ' this month' +
                (s.over ? ' · ' + SW.money(-s.left) + ' over' : ' · ' + SW.money(s.left) + ' left')
              : 'No cap set') +
          '</span>' +
          (s ? '<span class="budget-track' + (s.over ? ' is-over' : (s.pct >= 80 ? ' is-close' : '')) +
               '"><span style="width:' + s.pct + '%"></span></span>' : '') +
        '</span>' +
        '<span class="budget-cap' + (c.budget ? '' : ' is-none') + '">' +
          (c.budget ? SW.money(c.budget) : 'set a cap') + '</span>' +
      '</button>';
    }
  }

  // Built-ins have no emoji of their own; borrow the first from their group.
  function emojiFor(name) {
    const group = (SW.EMOJI_GROUPS || []).filter(function (g) { return g.label === name; })[0];
    return group ? group.items[0] : '🏷️';
  }

  SW.viewHooks.categories = render;

  document.getElementById('cat-back').addEventListener('click', function () {
    SW.navigate('account');
  });

  /* ======================= editing ================================== */

  function parseRupees(text) {
    const cleaned = String(text || '').replace(/[^0-9.]/g, '');
    if (!cleaned) return null;
    const paise = SW.toPaise(cleaned);
    return paise > 0 ? paise : null;
  }

  document.getElementById('cat-builtin').addEventListener('click', onRowClick);
  document.getElementById('cat-custom').addEventListener('click', onRowClick);

  function onRowClick(e) {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    const name = b.getAttribute('data-cat');
    const entry = SW.categoryList().filter(function (c) { return c.name === name; })[0];
    if (entry) openEditor(entry);
  }

  function openEditor(entry) {
    const spent = (SW.budgetStatus().filter(function (s) {
      return s.name === entry.name;
    })[0] || {}).spent;

    SW.sheet({
      title: entry.name,
      body:
        (spent
          ? '<p style="color:var(--muted);font-size:14px">' + SW.money(spent) +
            ' spent this month.</p>'
          : '') +
        '<div class="field" style="margin-top:10px">' +
          '<label for="cat-budget">Monthly cap</label>' +
          '<input class="input" id="cat-budget" type="text" inputmode="decimal" ' +
                 'placeholder="No cap" value="' +
                 (entry.budget ? SW.rupees(entry.budget) : '') + '">' +
          '<span class="hint">Leave it empty for no cap. Only you can see this.</span>' +
        '</div>' +
        (entry.custom
          ? '<div class="field">' +
              '<label for="cat-name">Name</label>' +
              '<input class="input" id="cat-name" type="text" maxlength="40" value="' +
                esc(entry.name) + '">' +
            '</div>' +
            '<div class="field">' +
              '<label for="cat-emoji">Icon</label>' +
              '<input class="input" id="cat-emoji" type="text" maxlength="4" value="' +
                esc(entry.emoji || '🏷️') + '" ' +
                'style="width:5rem;text-align:center;font-size:24px">' +
            '</div>'
          : '') +
        '<div class="field-error" id="cat-error"></div>',
      confirm: 'Save',
      cancel: entry.custom ? 'Delete this category' : 'Cancel',
      onOpen: function () { document.getElementById('cat-budget').focus(); },
      onConfirm: async function (btn) {
        const budget = parseRupees(document.getElementById('cat-budget').value);
        const nameField = document.getElementById('cat-name');
        const name = nameField ? nameField.value.trim() : entry.name;
        const emojiField = document.getElementById('cat-emoji');
        const emoji = emojiField ? (emojiField.value.trim() || '🏷️') : '🏷️';

        if (!name) { SW.setError('cat-error', 'A category needs a name.'); return false; }

        SW.busy(btn, true);
        let error;

        if (entry.id) {
          // Nothing left to hold: no cap and not a category of your own.
          if (!budget && !entry.custom) {
            ({ error } = await db.from('user_categories').delete().eq('id', entry.id));
          } else {
            ({ error } = await db.from('user_categories')
              .update({ name: name, emoji: emoji, budget_paise: budget })
              .eq('id', entry.id));
          }
        } else if (budget) {
          ({ error } = await db.from('user_categories').insert({
            user_id: SW.user.id,
            name: entry.name,
            emoji: emojiFor(entry.name),
            budget_paise: budget,
            is_custom: false,
          }));
        }

        SW.busy(btn, false);
        if (error) {
          SW.setError('cat-error', /duplicate|unique/i.test(error.message)
            ? 'You already have a category with that name.'
            : error.message);
          return false;
        }

        await SW.refreshLedger();
        render();
        SW.toast(budget ? 'Cap set to ' + SW.money(budget) : 'Cap removed', 'ok');
        return true;
      },
      onClose: function () { /* nothing to restore */ },
    });
  }

  document.getElementById('cat-add').addEventListener('click', function () {
    SW.sheet({
      title: 'Add a category',
      body:
        '<div class="field">' +
          '<label for="new-cat-name">Name</label>' +
          '<input class="input" id="new-cat-name" type="text" maxlength="40" ' +
                 'placeholder="Bike, Tuition, Cigarettes">' +
        '</div>' +
        '<div class="field">' +
          '<label for="new-cat-emoji">Icon</label>' +
          '<input class="input" id="new-cat-emoji" type="text" maxlength="4" ' +
                 'value="🏷️" style="width:5rem;text-align:center;font-size:24px">' +
        '</div>' +
        '<div class="field">' +
          '<label for="new-cat-budget">Monthly cap (optional)</label>' +
          '<input class="input" id="new-cat-budget" type="text" inputmode="decimal" ' +
                 'placeholder="No cap">' +
        '</div>' +
        '<div class="field-error" id="new-cat-error"></div>',
      confirm: 'Add',
      onOpen: function () { document.getElementById('new-cat-name').focus(); },
      onConfirm: async function (btn) {
        const name = document.getElementById('new-cat-name').value.trim();
        const emoji = document.getElementById('new-cat-emoji').value.trim() || '🏷️';
        const budget = parseRupees(document.getElementById('new-cat-budget').value);

        if (!name) { SW.setError('new-cat-error', 'Give it a name.'); return false; }
        if ((SW.CATEGORIES || []).indexOf(name) > -1) {
          SW.setError('new-cat-error', 'That is already a built-in category — ' +
            'set its cap from the list above.');
          return false;
        }

        SW.busy(btn, true);
        const { error } = await db.from('user_categories').insert({
          user_id: SW.user.id, name: name, emoji: emoji,
          budget_paise: budget, is_custom: true,
        });
        SW.busy(btn, false);

        if (error) {
          SW.setError('new-cat-error', /duplicate|unique/i.test(error.message)
            ? 'You already have one with that name.'
            : error.message);
          return false;
        }

        await SW.refreshLedger();
        render();
        SW.toast(name + ' added', 'ok');
        return true;
      },
    });
  });
})();
