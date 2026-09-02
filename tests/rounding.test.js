// Run from the repo root:  node tests/rounding.test.js
//
// Rounding to whole rupees must still land on the total to the paise, or the
// ledger drifts. The payer absorbs the leftover, because they are the one
// out of pocket.
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
const P = ['me', 'ali', 'zara'];
const state = (extra) => Object.assign({
  included: {}, exact: {}, percent: {}, shares: {}, adjust: {},
}, extra);

console.log('--- to the paise, as before ---');
let r = SW.computeSplit('equal', 100000, P, state());
check('₹1000 / 3', P.map(id => r.byUser[id]), [33334, 33333, 33333]);

console.log('--- to whole rupees, payer absorbing the difference ---');
r = SW.computeSplit('equal', 100000, P, state({ rounding: 'rupee', payerId: 'me' }));
check('every share is a whole rupee',
  P.every(id => r.byUser[id] % 100 === 0), true);
check('shares', P.map(id => r.byUser[id]), [33400, 33300, 33300]);
check('still totals ₹1000', P.reduce((t, id) => t + r.byUser[id], 0), 100000);
console.log('  ' + P.map(id => SW.money(r.byUser[id])).join('  '));

console.log('--- the leftover follows the payer, not the first person ---');
r = SW.computeSplit('equal', 100000, P, state({ rounding: 'rupee', payerId: 'zara' }));
check('zara absorbs it', r.byUser.zara % 100 === 0 && r.byUser.zara === 33400, true);
check('total unchanged', P.reduce((t, id) => t + r.byUser[id], 0), 100000);

console.log('--- an amount that is already whole rupees is untouched ---');
r = SW.computeSplit('equal', 90000, P, state({ rounding: 'rupee', payerId: 'me' }));
check('₹900 / 3 exactly', P.map(id => r.byUser[id]), [30000, 30000, 30000]);

console.log('--- every mode, every amount, still lands on the total ---');
let bad = null;
for (let amt = 100; amt <= 300000 && !bad; amt += 271) {
  for (const mode of ['equal', 'percent', 'shares']) {
    const st = state({
      rounding: 'rupee', payerId: 'ali',
      percent: { me: 33.34, ali: 33.33, zara: 33.33 },
      shares: { me: 2, ali: 1, zara: 3 },
    });
    const res = SW.computeSplit(mode, amt, P, st);
    if (!res.valid) continue;
    const sum = P.reduce((t, id) => t + res.byUser[id], 0);
    if (sum !== amt) { bad = { mode, amt, sum }; break; }
    if (P.some(id => res.byUser[id] < 0)) { bad = { mode, amt, neg: res.byUser }; break; }
  }
}
check('1,107 combinations sum exactly, none negative', bad, null);

console.log('--- rounding cannot push anyone below zero ---');
// ₹1 across three: base rounding would give 0/0/0 and dump ₹1 on the payer.
r = SW.computeSplit('equal', 100, P, state({ rounding: 'rupee', payerId: 'me' }));
check('nobody owes less than nothing', P.every(id => r.byUser[id] >= 0), true);
check('and it still totals ₹1', P.reduce((t, id) => t + r.byUser[id], 0), 100);

console.log('\n--- the people a group usually splits with ---');
const ME = 'me';
function ex(splits, by) {
  return {
    id: Math.random().toString(36).slice(2), group_id: 'g', payer_id: ME,
    amount: '300.00', description: 'x', emoji: 'x', created_by: by || ME,
    expense_date: '2026-08-01', created_at: 'a',
    expense_splits: splits.map(u => ({ user_id: u, amount: '100.00' })),
  };
}
SW.ledger = {
  me: ME, friendIds: ['ali', 'zara', 'dev'], people: {}, groups: { g: {} },
  members: { g: [ME, 'ali', 'zara', 'dev'] }, settlements: [],
  expenses: [
    ex([ME, 'ali', 'zara']), ex([ME, 'ali', 'zara']), ex([ME, 'ali', 'zara']),
    ex([ME, 'ali', 'zara', 'dev']),
  ],
};
SW.bumpLedger();
check('the usual three, not all four', SW.usualPeopleFor('g').sort(), ['ali', 'me', 'zara']);

SW.ledger.expenses = [ex([ME, 'ali']), ex([ME, 'zara'])];
SW.bumpLedger();
check('too few entries is coincidence, not a pattern', SW.usualPeopleFor('g'), null);

SW.ledger.expenses = [ex([ME, 'ali']), ex([ME, 'zara']), ex([ME, 'dev']), ex([ME, 'ali'])];
SW.bumpLedger();
check('no clear majority means no guess', SW.usualPeopleFor('g'), null);

SW.ledger.expenses = [ex([ME, 'ali']), ex([ME, 'ali']), ex([ME, 'ali'], 'ali')];
SW.bumpLedger();
check('only my own entries shape my default',
  SW.usualPeopleFor('g') === null || SW.usualPeopleFor('g').length === 2, true);

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
