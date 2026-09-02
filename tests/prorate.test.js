// Run from the repo root:  node tests/prorate.test.js
//
// Fees are prorated by what each person actually ordered. The allocation must
// land on the fee exactly, or the expense will not sum and the RPC rejects it.
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

console.log('--- the case from the request: 15% of the basket, 15% of the fee ---');
// Basket ₹100: me ₹15, ali ₹35, zara ₹50. Handling fee ₹20.
const fee = SW.prorate(2000, { me: 1500, ali: 3500, zara: 5000 });
check('₹20 fee split by share', fee, { me: 300, ali: 700, zara: 1000 });
console.log('  me ' + SW.money(fee.me) + ' (15%), ali ' + SW.money(fee.ali) +
            ' (35%), zara ' + SW.money(fee.zara) + ' (50%)');
check('sums to the fee', fee.me + fee.ali + fee.zara, 2000);

console.log('\n--- awkward fee that cannot divide cleanly ---');
const f2 = SW.prorate(1000, { a: 3333, b: 3333, c: 3334 });
check('₹10 across near-equal shares', f2.a + f2.b + f2.c, 1000);
console.log('  ' + [f2.a, f2.b, f2.c].map(SW.money).join('  '));

console.log('\n--- exact-sum invariant over many shapes ---');
let bad = null;
for (let total = 0; total <= 20000 && !bad; total += 13) {
  const shapes = [
    { a: 1 }, { a: 1, b: 1 }, { a: 1, b: 2, c: 3 },
    { a: 100, b: 7, c: 993, d: 1 }, { a: 5000, b: 5000 },
    { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 },
  ];
  for (const w of shapes) {
    const out = SW.prorate(total, w);
    const sum = Object.keys(out).reduce((s, k) => s + out[k], 0);
    if (sum !== total) { bad = { total, w, sum }; break; }
    if (Object.keys(out).some(k => out[k] < 0)) { bad = { total, w, negative: out }; break; }
  }
}
check('every allocation sums exactly and stays non-negative', bad, null);

console.log('\n--- degenerate inputs ---');
check('no people',            SW.prorate(500, {}), {});
check('zero fee',             SW.prorate(0, { a: 10, b: 20 }), { a: 0, b: 0 });
check('all weights zero',     SW.prorate(300, { a: 0, b: 0 }), { a: 150, b: 150 });
check('all zero, odd paise',  SW.prorate(301, { a: 0, b: 0 }), { a: 151, b: 150 });
check('one person takes all', SW.prorate(999, { solo: 4200 }), { solo: 999 });
check('negative weight ignored', SW.prorate(100, { a: 100, b: -50 }), { a: 100, b: 0 });

console.log('\n--- deterministic regardless of key order ---');
// Compare by value, not by key insertion order: Object.keys follows the order
// the weights were given in, so the two results are the same allocation even
// when their JSON text differs.
function normalise(o) {
  return Object.keys(o).sort().map(function (k) { return k + '=' + o[k]; }).join(',');
}
check('same allocation either way',
  normalise(SW.prorate(1000, { z: 1, a: 1, m: 1 })),
  normalise(SW.prorate(1000, { a: 1, m: 1, z: 1 })));
check('which is', normalise(SW.prorate(1000, { z: 1, a: 1, m: 1 })), 'a=334,m=333,z=333');

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
