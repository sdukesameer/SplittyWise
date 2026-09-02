// Run from the repo root:  node tests/splits.test.js
//
// The invariant that matters: an equal split must sum back to the exact
// total. If it ever does not, money quietly appears or vanishes from the
// ledger and no error is ever raised.
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
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + '  got ' + g + (ok ? '' : '  want ' + w));
}

console.log('--- the case from the plan ---');
check('₹1000 / 3', SW.splitEqually(100000, 3), [33334, 33333, 33333]);
console.log('  reads as: ' + SW.splitEqually(100000, 3).map(SW.money).join('  '));

console.log('\n--- exact-sum invariant across many shapes ---');
let worst = null;
for (let total = 0; total <= 500000; total += 7) {
  for (let n = 1; n <= 9; n++) {
    const parts = SW.splitEqually(total, n);
    const sum = parts.reduce((a, b) => a + b, 0);
    if (sum !== total || parts.length !== n) { worst = { total, n, sum, parts }; break; }
    // No part may differ from another by more than one paise.
    if (Math.max.apply(null, parts) - Math.min.apply(null, parts) > 1) {
      worst = { total, n, spread: parts }; break;
    }
  }
  if (worst) break;
}
check('71,430 combinations sum exactly and stay within 1 paise', worst, null);

console.log('\n--- edge cases ---');
check('₹0.01 / 3',   SW.splitEqually(1, 3),      [1, 0, 0]);
check('₹0 / 4',      SW.splitEqually(0, 4),      [0, 0, 0, 0]);
check('₹100 / 1',    SW.splitEqually(10000, 1),  [10000]);
check('n = 0',       SW.splitEqually(10000, 0),  []);
check('₹0.05 / 7',   SW.splitEqually(5, 7),      [1, 1, 1, 1, 1, 0, 0]);
check('₹1 / 3',      SW.splitEqually(100, 3),    [34, 33, 33]);

console.log('\n--- among named people ---');
const among = SW.splitEquallyAmong(100000, ['a', 'b', 'c']);
check('by user id', among, { a: 33334, b: 33333, c: 33333 });

console.log('\n--- payload sent to create_expense ---');
const payload = SW.splitsPayload(among);
check('rupee strings', payload, [
  { user_id: 'a', amount: '333.34' },
  { user_id: 'b', amount: '333.33' },
  { user_id: 'c', amount: '333.33' },
]);
// The RPC rejects the write unless these add up, so verify the round trip.
const back = payload.reduce((s, p) => s + SW.toPaise(p.amount), 0);
check('payload sums back to ₹1000', back, 100000);

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
