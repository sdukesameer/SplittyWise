// ---------------------------------------------------------------------------
//  Trash — deleting is recoverable for thirty days
//
//  The five-second undo was good but it was five seconds. A deleted row is
//  now marked rather than removed, kept out of every balance, and swept up
//  by purge_trash() once it is a month old.
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const db = SW.db;
  const esc = SW.escapeHtml;
  let rows = [];

  function daysLeft(deletedAt) {
    const gone = 30 - Math.floor((Date.now() - new Date(deletedAt).getTime()) / 86400000);
    return Math.max(0, gone);
  }

  async function load() {
    const { data, error } = await db
      .from('expenses')
      .select('id, group_id, payer_id, amount, description, emoji, expense_date, deleted_at')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(200);

    if (error) {
      SW.toast('Could not load the trash: ' + error.message, 'error');
      return [];
    }
    return data || [];
  }

  function render() {
    const host = document.getElementById('trash-list');
    const empty = document.getElementById('trash-empty');

    if (!rows.length) {
      host.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    host.innerHTML = rows.map(function (e) {
      const group = e.group_id && SW.ledger ? SW.ledger.groups[e.group_id] : null;
      const left = daysLeft(e.deleted_at);
      return '<div class="trash-row">' +
        '<span class="ledger-emoji">' + esc(e.emoji || '🧾') + '</span>' +
        '<span class="trash-main">' +
          '<span class="trash-title">' + esc(e.description) + '</span>' +
          '<span class="trash-sub">' + esc(SW.formatDate(e.expense_date)) +
            (group ? ' · ' + esc(group.name) : '') +
            ' · ' + (left ? left + (left === 1 ? ' day left' : ' days left')
                          : 'going today') +
          '</span>' +
        '</span>' +
        '<span class="trash-amt">' + SW.money(SW.toPaise(e.amount)) + '</span>' +
        '<span class="trash-actions">' +
          '<button type="button" class="icon-btn" data-restore="' + esc(e.id) +
            '" aria-label="Restore" style="width:34px;height:34px;font-size:15px">↩</button>' +
          '<button type="button" class="ir-del" data-purge="' + esc(e.id) +
            '" aria-label="Delete for good">&times;</button>' +
        '</span>' +
      '</div>';
    }).join('');
  }

  SW.viewHooks.trash = async function () {
    rows = await load();
    render();

    const sub = document.getElementById('sub-trash');
    if (sub) {
      sub.textContent = rows.length
        ? rows.length + (rows.length === 1 ? ' item, recoverable' : ' items, recoverable')
        : 'Deleted things, recoverable for 30 days';
    }
  };

  SW.trashCount = function () { return rows.length; };

  document.getElementById('trash-back').addEventListener('click', function () {
    SW.navigate('account');
  });

  document.getElementById('trash-list').addEventListener('click', async function (e) {
    const restore = e.target.closest('[data-restore]');
    if (restore) {
      const id = restore.getAttribute('data-restore');
      const { error } = await db.rpc('set_expense_deleted', {
        p_expense_id: id, p_deleted: false,
      });
      if (error) return SW.toast(error.message, 'error');
      await SW.refreshLedger();
      SW.viewHooks.trash();
      SW.toast('Restored', 'ok');
      return;
    }

    const purge = e.target.closest('[data-purge]');
    if (!purge) return;
    const id = purge.getAttribute('data-purge');
    const row = rows.filter(function (x) { return x.id === id; })[0];

    SW.sheet({
      title: 'Delete "' + (row ? row.description : 'this') + '" for good?',
      body: '<p style="color:var(--danger);font-size:14.5px;font-weight:700">' +
        'This cannot be undone.</p><p style="color:var(--muted);font-size:14.5px;' +
        'margin-top:8px">It would go on its own in ' +
        (row ? daysLeft(row.deleted_at) : 30) + ' days anyway.</p>',
      confirm: 'Delete for good',
      onConfirm: async function (btn) {
        SW.busy(btn, true);
        const { error } = await db.from('expenses').delete().eq('id', id);
        SW.busy(btn, false);
        if (error) { SW.toast(error.message, 'error'); return false; }
        SW.viewHooks.trash();
        SW.toast('Gone', 'ok');
        return true;
      },
    });
  });
})();
