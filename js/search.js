// ---------------------------------------------------------------------------
//  Expense search — the thing Splitwise puts behind its paywall
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const esc = SW.escapeHtml;
  let debounce = null;

  function render(query) {
    const hint = document.getElementById('srch-hint');
    const count = document.getElementById('srch-count');
    const host = document.getElementById('srch-results');

    if (!SW.ledger) return;

    const q = String(query || '').trim();
    if (q.length < 2) {
      hint.hidden = false;
      hint.textContent = q.length === 1
        ? 'Keep typing — two characters at least.'
        : 'Search by what it was, who was involved, which group, or the amount.';
      count.hidden = true;
      host.innerHTML = '';
      return;
    }

    const hits = SW.searchExpenses(q);
    hint.hidden = hits.length > 0;
    if (!hits.length) {
      hint.textContent = 'Nothing matches “' + q + '”.';
      count.hidden = true;
      host.innerHTML = '';
      return;
    }

    count.hidden = false;
    count.textContent = hits.length + (hits.length === 1 ? ' match' : ' matches');

    const me = SW.ledger.me;
    host.innerHTML = hits.slice(0, 120).map(function (e) {
      const total = SW.toPaise(e.amount);
      const mine = SW.myShareOf(e);
      const payer = SW.person(e.payer_id);
      const group = e.group_id ? SW.ledger.groups[e.group_id] : null;
      const d = new Date(e.expense_date + 'T00:00:00');

      let cls, lbl, val;
      if (e.payer_id === me) {
        const lent = total - mine;
        cls = lent > 0 ? 'is-owed' : 'is-flat';
        lbl = 'you lent'; val = SW.money(lent);
      } else if (mine) {
        cls = 'is-owe'; lbl = 'you owe'; val = SW.money(mine);
      } else {
        cls = 'is-flat'; lbl = 'not you'; val = '—';
      }

      return '<button class="ledger-row" data-expense="' + esc(e.id) + '" style="cursor:pointer">' +
        '<span class="ledger-date"><span class="d">' + d.getDate() + '</span><br>' +
          '<span class="m">' + esc(d.toLocaleDateString('en-IN', { month: 'short' })) + '</span></span>' +
        '<span class="ledger-emoji">' + esc(e.emoji || '🧾') + '</span>' +
        '<span class="ledger-main">' +
          '<span class="ledger-title">' + esc(e.description) + '</span>' +
          '<span class="ledger-sub">' +
            (e.payer_id === me ? 'You paid ' : esc(payer.full_name) + ' paid ') +
            SW.money(total) + (group ? ' · ' + esc(group.name) : '') + '</span>' +
        '</span>' +
        '<span class="ledger-delta ' + cls + '">' +
          '<span class="lbl">' + lbl + '</span><span class="val">' + val + '</span>' +
        '</span></button>';
    }).join('') +
    (hits.length > 120
      ? '<div class="search-hint">Showing the first 120. Narrow the search to see more.</div>'
      : '');
  }

  SW.viewHooks.search = function () {
    const input = document.getElementById('srch-input');
    render(input.value);
    // Focus only on a pointer-capable device: on a phone this would throw up
    // the keyboard over the results before anything has been typed.
    if (!SW.isTouch) input.focus();
  };

  document.getElementById('srch-input').addEventListener('input', function () {
    const value = this.value;
    clearTimeout(debounce);
    debounce = setTimeout(function () { render(value); }, 120);
  });

  document.getElementById('srch-input').addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { this.value = ''; render(''); }
  });

  document.getElementById('srch-back').addEventListener('click', function () {
    if (history.length > 1) history.back();
    else SW.navigate('friends');
  });

  document.getElementById('srch-results').addEventListener('click', function (e) {
    const row = e.target.closest('[data-expense]');
    if (row) SW.navigate('expense/' + row.getAttribute('data-expense'));
  });
})();
