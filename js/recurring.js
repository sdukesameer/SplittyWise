// ---------------------------------------------------------------------------
//  Repeating expenses — the rules, and pausing or stopping them
//
//  The rules post themselves at launch through run_due_recurring(), so this
//  page is for seeing and changing them, not for triggering them.
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const db = SW.db;
  const esc = SW.escapeHtml;
  let rules = [];

  async function load() {
    const { data, error } = await db
      .from('recurring_expenses')
      .select('id, group_id, payer_id, amount, description, emoji, cadence, ' +
              'day_of_month, next_run, last_run, runs, active, splits')
      .order('next_run', { ascending: true });

    if (error) {
      SW.toast('Could not load repeating expenses: ' + error.message, 'error');
      return [];
    }
    return data || [];
  }

  function render(list) {
    const host = document.getElementById('rec-list');
    const empty = document.getElementById('rec-empty');

    if (!list.length) {
      host.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const me = SW.ledger ? SW.ledger.me : null;

    host.innerHTML = list.map(function (r) {
      const group = r.group_id && SW.ledger ? SW.ledger.groups[r.group_id] : null;
      const people = (r.splits || []).length;
      const payer = r.payer_id === me ? 'You pay' : SW.person(r.payer_id).full_name + ' pays';

      const when = r.active
        ? 'Next on ' + SW.formatDate(r.next_run)
        : 'Paused';

      return '<div class="rec-row' + (r.active ? '' : ' is-paused') + '">' +
        '<span class="ledger-emoji">' + esc(r.emoji || '🔁') + '</span>' +
        '<span class="rec-main">' +
          '<span class="rec-title">' + esc(r.description) + '</span>' +
          '<span class="rec-sub">' + esc(SW.cadenceLabel(r.cadence)) + ' · ' + esc(when) +
            ' · ' + esc(payer) +
            (group ? ' · ' + esc(group.name) : '') +
            ' · ' + people + (people === 1 ? ' person' : ' people') +
          '</span>' +
        '</span>' +
        '<span class="rec-amt">' + SW.money(SW.toPaise(r.amount)) + '</span>' +
        '<span class="rec-actions">' +
          '<button type="button" class="icon-btn" data-toggle-rule="' + esc(r.id) +
            '" aria-label="' + (r.active ? 'Pause' : 'Resume') + '" ' +
            'style="width:34px;height:34px;font-size:15px">' +
            (r.active ? '⏸' : '▶') + '</button>' +
          '<button type="button" class="ir-del" data-drop-rule="' + esc(r.id) +
            '" aria-label="Delete this rule">&times;</button>' +
        '</span>' +
      '</div>';
    }).join('');
  }

  SW.viewHooks.recurring = async function () {
    rules = await load();
    render(rules);

    const active = rules.filter(function (r) { return r.active; }).length;
    const sub = document.getElementById('sub-recurring');
    if (sub) {
      sub.textContent = rules.length
        ? active + ' active' + (rules.length > active
            ? ', ' + (rules.length - active) + ' paused' : '')
        : 'Rent, wifi, anything monthly';
    }
  };

  document.getElementById('rec-back').addEventListener('click', function () {
    SW.navigate('account');
  });

  document.getElementById('rec-list').addEventListener('click', async function (e) {
    const toggle = e.target.closest('[data-toggle-rule]');
    if (toggle) {
      const id = toggle.getAttribute('data-toggle-rule');
      const rule = rules.filter(function (r) { return r.id === id; })[0];
      if (!rule) return;

      const next = !rule.active;
      const patch = { active: next };
      // Resuming after a long pause should not post a backlog, so pick up
      // from today rather than from where it stopped.
      if (next && rule.next_run < todayIso()) {
        patch.next_run = SW.nextOccurrence(todayIso(), rule.cadence, rule.day_of_month);
      }

      const { error } = await db.from('recurring_expenses').update(patch).eq('id', id);
      if (error) return SW.toast(error.message, 'error');

      SW.toast(next ? 'Resumed' : 'Paused', 'ok');
      SW.viewHooks.recurring();
      return;
    }

    const drop = e.target.closest('[data-drop-rule]');
    if (!drop) return;
    const id = drop.getAttribute('data-drop-rule');
    const rule = rules.filter(function (r) { return r.id === id; })[0];
    if (!rule) return;

    SW.sheet({
      title: 'Stop repeating "' + rule.description + '"?',
      body: '<p style="color:var(--muted);font-size:14.5px">The expenses it has ' +
        'already added stay exactly as they are. Only the rule goes.</p>',
      confirm: 'Stop repeating',
      onConfirm: async function (btn) {
        SW.busy(btn, true);
        const { error } = await db.from('recurring_expenses').delete().eq('id', id);
        SW.busy(btn, false);
        if (error) { SW.toast(error.message, 'error'); return false; }
        SW.toast('Stopped', 'ok');
        SW.viewHooks.recurring();
        return true;
      },
    });
  });

  function todayIso() {
    const d = new Date();
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }
})();
