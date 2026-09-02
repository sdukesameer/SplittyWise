// Run from the repo root:  node tests/payers.test.js
//
// With several payers there is no "everyone owes the payer" shortcut, so the
// engine nets each expense and resolves it into the fewest transfers. The
// critical property is that one payer still behaves exactly as before.
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
const ME = 'me', A = 'ali', B = 'bina';
const base = (extra) => Object.assign({
  me: ME, friendIds: [A, B], people: { ali: {}, bina: {} },
  groups: {}, members: {}, settlements: [],
}, extra);

console.log('--- one payer, no expense_payers rows (a pre-phase-12 expense) ---');
SW.ledger = base({ expenses: [
  { id: 'e1', group_id: null, payer_id: ME, amount: '1200.00', description: 'Gas',
    emoji: '🔥', expense_date: '2026-08-01', created_at: 'x',
    expense_splits: [{ user_id: ME, amount: '400.00' },
                     { user_id: A, amount: '400.00' },
                     { user_id: B, amount: '400.00' }] },
]});
let edges = SW.expenseEdges(SW.ledger.expenses[0]);
check('two edges, both to me', edges.length, 2);
check('each owes me their share', edges.every(e => e.to === ME && e.amount === 40000), true);
let nets = SW.friendBalances();
check('Ali owes ₹400', nets[A].net, 40000);
check('Bina owes ₹400', nets[B].net, 40000);
check('my own share is not a debt', SW.overallNet(nets), 80000);

console.log('--- one payer, with an expense_payers row: identical result ---');
SW.ledger.expenses[0].expense_payers = [{ user_id: ME, amount: '1200.00' }];
const nets2 = SW.friendBalances();
check('unchanged', [nets2[A].net, nets2[B].net], [40000, 40000]);

console.log('--- two payers on one expense ---');
// ₹900 split three ways at ₹300. I put in ₹600, Ali put in ₹300.
// Nets: me +300, Ali 0, Bina -300. So only Bina owes, and she owes me.
SW.ledger = base({ expenses: [
  { id: 'e2', group_id: null, payer_id: ME, amount: '900.00', description: 'Dinner',
    emoji: '🍽️', expense_date: '2026-08-02', created_at: 'x',
    expense_splits: [{ user_id: ME, amount: '300.00' },
                     { user_id: A, amount: '300.00' },
                     { user_id: B, amount: '300.00' }],
    expense_payers: [{ user_id: ME, amount: '600.00' },
                     { user_id: A, amount: '300.00' }] },
]});
edges = SW.expenseEdges(SW.ledger.expenses[0]);
check('one transfer only', edges.length, 1);
check('Bina pays me ₹300', edges[0], { from: B, to: ME, amount: 30000 });
nets = SW.friendBalances();
check('Ali is square — he paid his own share', nets[A].net, 0);
check('Bina owes me ₹300', nets[B].net, 30000);

console.log('--- a payer who paid more than their share is owed by me ---');
// ₹600 split two ways at ₹300. Ali paid all ₹600. I owe Ali ₹300.
SW.ledger = base({ expenses: [
  { id: 'e3', group_id: null, payer_id: A, amount: '600.00', description: 'Cab',
    emoji: '🛺', expense_date: '2026-08-03', created_at: 'x',
    expense_splits: [{ user_id: ME, amount: '300.00' }, { user_id: A, amount: '300.00' }],
    expense_payers: [{ user_id: A, amount: '600.00' }] },
]});
nets = SW.friendBalances();
check('I owe Ali ₹300', nets[A].net, -30000);

console.log('--- three payers, awkward amounts ---');
// ₹1000 split three ways: 333.34 / 333.33 / 333.33
// Paid: me 500, Ali 400, Bina 100.
// Nets: me +166.66, Ali +66.67, Bina -233.33
SW.ledger = base({ expenses: [
  { id: 'e4', group_id: null, payer_id: ME, amount: '1000.00', description: 'Trip',
    emoji: '🧳', expense_date: '2026-08-04', created_at: 'x',
    expense_splits: [{ user_id: ME, amount: '333.34' },
                     { user_id: A, amount: '333.33' },
                     { user_id: B, amount: '333.33' }],
    expense_payers: [{ user_id: ME, amount: '500.00' },
                     { user_id: A, amount: '400.00' },
                     { user_id: B, amount: '100.00' }] },
]});
edges = SW.expenseEdges(SW.ledger.expenses[0]);
const moved = edges.reduce((t, e) => t + e.amount, 0);
check('edges clear exactly the debt', moved, 23333);
check('every edge is positive', edges.every(e => e.amount > 0), true);
nets = SW.friendBalances();
check('nets are consistent with the paid/owed maths',
  nets[A].net + nets[B].net, 16666);
console.log('  Ali ' + SW.money(nets[A].net) + (nets[A].net < 0 ? ' (I owe)' : ' (owes me)') +
            ', Bina ' + SW.money(nets[B].net) + (nets[B].net < 0 ? ' (I owe)' : ' (owes me)'));

console.log('--- group totals also read the paid map ---');
SW.ledger.groups = { g: { id: 'g', name: 'Trip' } };
SW.ledger.members = { g: [ME, A, B] };
SW.ledger.expenses[0].group_id = 'g';
const g = SW.groupSummary('g');
check('paid per member', [g.paid[ME], g.paid[A], g.paid[B]], [50000, 40000, 10000]);
check('owed per member', [g.owed[ME], g.owed[A], g.owed[B]], [33334, 33333, 33333]);
check('nets still sum to zero',
  Object.keys(g.nets).reduce((s, k) => s + g.nets[k], 0), 0);
check('group total is the expense, not the sum of payments', g.total, 100000);

console.log('--- one friend\'s ledger shows only what moved between us ---');
const led = SW.pairLedger(A);
check('appears only if an edge exists between us',
  led.length <= 1, true);

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
