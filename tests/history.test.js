// Run from the repo root:  node tests/history.test.js
//
// Folding away settled history is easy to get subtly wrong: fold one entry
// too many and the balance on screen stops matching the entries shown.
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

global.window = {};
global.window.SW = global.SW = {};
for (const f of ['js/balances.js', 'js/emoji.js']) {
  new Function('window', 'SW', fs.readFileSync(f, 'utf8'))(global.window, global.SW);
}

let fails = 0;
function check(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok ? '' : '\n         got  ' + g + '\n         want ' + w));
}

console.log('--- folding away settled history (items are newest-first) ---');
// Oldest to newest: +500, -500 (square), +300.
// Only the newest entry is live; the first two are finished business.
let items = [{ delta: 30000 }, { delta: -50000 }, { delta: 50000 }];
check('shows only the unsettled tail', SW.settledCutoff(items), 1);
check('marks the entry that squared it', items.map(i => i.clearsBalance),
  [false, true, false]);

console.log('--- everything settled ---');
items = [{ delta: -50000 }, { delta: 50000 }];
check('nothing to show', SW.settledCutoff(items), 0);

console.log('--- never settled ---');
items = [{ delta: 20000 }, { delta: 30000 }];
check('shows everything', SW.settledCutoff(items), 2);
check('nothing marked', items.some(i => i.clearsBalance), false);

console.log('--- squared more than once: only the last point counts ---');
// +100, -100 (square), +200, -200 (square), +50
items = [{ delta: 5000 }, { delta: -20000 }, { delta: 20000 },
         { delta: -10000 }, { delta: 10000 }];
check('folds both earlier settlements', SW.settledCutoff(items), 1);
check('both squaring points marked', items.filter(i => i.clearsBalance).length, 2);

console.log('--- the shown entries must sum to the live balance ---');
let bad = null;
for (let trial = 0; trial < 300 && !bad; trial++) {
  const n = 1 + (trial % 9);
  const seq = [];
  for (let i = 0; i < n; i++) {
    seq.push({ delta: ((trial * 37 + i * 13) % 21 - 10) * 100 });
  }
  const total = seq.reduce((t, x) => t + x.delta, 0);
  const show = SW.settledCutoff(seq);
  const shown = seq.slice(0, show).reduce((t, x) => t + x.delta, 0);
  if (shown !== total) bad = { seq: seq.map(x => x.delta), show, shown, total };
}
check('folded entries always net to zero', bad, null);

console.log('--- shared groups, and scoped totals ---');
const ME = 'me', A = 'ali', B = 'bina';
SW.ledger = {
  me: ME, friendIds: [A, B],
  people: { ali: { id: A, full_name: 'Ali' }, bina: { id: B, full_name: 'Bina' } },
  groups: { g1: { id: 'g1', name: 'Flat', emoji: '🏠' },
            g2: { id: 'g2', name: 'Trip', emoji: '🧳' } },
  members: { g1: [ME, A], g2: [ME, B] },
  expenses: [
    { id: 'x1', group_id: 'g1', payer_id: ME, amount: '1000.00', description: 'Rent',
      emoji: '🏠', category: 'Home & bills', notes: null,
      expense_date: '2026-08-10', created_at: 'a',
      expense_splits: [{ user_id: ME, amount: '500.00' }, { user_id: A, amount: '500.00' }] },
    { id: 'x2', group_id: 'g2', payer_id: B, amount: '600.00', description: 'Hotel',
      emoji: '🏨', category: 'Travel', notes: null,
      expense_date: '2026-09-02', created_at: 'b',
      expense_splits: [{ user_id: ME, amount: '300.00' }, { user_id: B, amount: '300.00' }] },
  ],
  settlements: [],
};

check('groups shared with Ali', SW.sharedGroups(A).map(x => x.id), ['g1']);
check('groups shared with Bina', SW.sharedGroups(B).map(x => x.id), ['g2']);
check('Ali owes me ₹500 in the flat', SW.sharedGroups(A)[0].net, 50000);

console.log('--- period totals and the percentage ---');
let t = SW.periodTotals({});
check('all time: ₹1600 spent, ₹800 mine', [t.total, t.mine], [160000, 80000]);
check('my percentage', t.pct, 50);
check('expense count', t.count, 2);

t = SW.periodTotals({ groupId: 'g1' });
check('one group only', [t.total, t.mine, t.pct], [100000, 50000, 50]);

t = SW.periodTotals({ month: '2026-09' });
check('one month only', [t.total, t.mine], [60000, 30000]);

t = SW.periodTotals({ withFriend: A });
check('only what Ali and I share', t.total, 100000);
t = SW.periodTotals({ withFriend: B });
check('only what Bina and I share', t.total, 60000);

check('months with spending, newest first', SW.monthsWithSpending({}),
  ['2026-09', '2026-08']);
check('months within one group', SW.monthsWithSpending({ groupId: 'g2' }), ['2026-09']);

console.log('--- category charts respect the same scope ---');
check('scoped to a friend', SW.spendByCategory({ withFriend: A }),
  [{ label: 'Home & bills', paise: 50000 }]);
check('scoped to a month', SW.spendByCategory({ month: '2026-09' }),
  [{ label: 'Travel', paise: 30000 }]);

console.log('--- monthly bars ignore the month filter, being the navigator ---');
const bars = SW.spendByMonth({ month: '2026-09', months: 6 });
check('six buckets regardless', bars.length, 6);

console.log('--- export honours the scope ---');
const all = SW.buildCsv({}).trim().split('\r\n');
const one = SW.buildCsv({ groupId: 'g1' }).trim().split('\r\n');
check('everything: header + 2', all.length, 3);
check('one group: header + 1', one.length, 2);
check('the right row', one[1].indexOf('Rent') > -1, true);

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
