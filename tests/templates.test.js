// Run from the repo root:  node tests/templates.test.js
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

global.window = {};
global.window.SW = global.SW = {};
new Function('window', 'SW', fs.readFileSync('js/balances.js', 'utf8'))(global.window, global.SW);

let fails = 0;
function check(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok ? '' : '\n         got  ' + g + '\n         want ' + w));
}
const ME = 'me', A = 'ali';
function exp(o) {
  return Object.assign({
    group_id: null, payer_id: ME, amount: '100.00', description: 'x', emoji: '🧾',
    category: 'general', split_mode: 'equal', created_by: ME,
    expense_date: '2026-08-01', created_at: 'a',
    expense_splits: [{ user_id: ME, amount: '50.00' }, { user_id: A, amount: '50.00' }],
  }, o);
}

SW.ledger = {
  me: ME, friendIds: [A], people: { ali: {} }, groups: {}, members: {},
  settlements: [],
  expenses: [
    exp({ id: '1', description: 'Morning chai', amount: '40.00', emoji: '☕', expense_date: '2026-08-01' }),
    exp({ id: '2', description: 'morning chai', amount: '40.00', emoji: '☕', expense_date: '2026-08-05' }),
    exp({ id: '3', description: 'Morning Chai', amount: '60.00', emoji: '☕', expense_date: '2026-08-20' }),
    exp({ id: '4', description: 'Groceries', amount: '900.00', emoji: '🛒', expense_date: '2026-08-10' }),
    exp({ id: '5', description: 'Groceries', amount: '820.00', emoji: '🛒', expense_date: '2026-08-18' }),
    // Entered once: a one-off, not a habit.
    exp({ id: '6', description: 'Cinema tickets', amount: '600.00', emoji: '🎬' }),
    // Somebody else's habit is not mine.
    exp({ id: '7', description: 'Their rent', created_by: A, payer_id: A }),
    exp({ id: '8', description: 'Their rent', created_by: A, payer_id: A }),
    // Not yet synced, so not yet a data point.
    exp({ id: '9', description: 'Morning chai', pending: true }),
  ],
};

console.log('--- built from habit, most-used first ---');
const t = SW.frequentExpenses(5);
check('two templates', t.map(x => x.description), ['Morning Chai', 'Groceries']);
check('counted case-insensitively', t[0].times, 3);
check('groceries counted twice', t[1].times, 2);

console.log('--- each carries the shape of the LAST time ---');
check('latest chai amount, not the first', t[0].amountPaise, 6000);
check('latest groceries amount', t[1].amountPaise, 82000);
check('emoji carried', [t[0].emoji, t[1].emoji], ['☕', '🛒']);
check('people carried', t[0].people.sort(), [A, ME].sort());

console.log('--- what is deliberately left out ---');
check('a one-off is not a template',
  t.some(x => x.description === 'Cinema tickets'), false);
check('someone else\'s habit is not mine',
  t.some(x => x.description === 'Their rent'), false);
check('an unsynced entry does not count yet', t[0].times !== 4, true);

console.log('--- limits and empty states ---');
check('limit respected', SW.frequentExpenses(1).length, 1);
SW.ledger.expenses = [];
check('nothing entered yet', SW.frequentExpenses(5), []);
SW.ledger = null;
check('no ledger at all', SW.frequentExpenses(5), []);

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
