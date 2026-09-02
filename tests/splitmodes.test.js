// Run from the repo root:  node tests/splitmodes.test.js
//
// The expected numbers below are read off the reference app's own split
// screens, so this is a like-for-like check rather than a guess at what the
// maths should be.
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
const P = ['sameer', 'ashutosh', 'shriyansh'];
const blank = () => ({ included: {}, exact: {}, percent: {}, shares: {}, adjust: {} });
const amounts = r => P.map(id => r.byUser[id]);

console.log('--- equally, all three (₹20) ---');
let r = SW.computeSplit('equal', 2000, P, blank());
check('₹6.67 / ₹6.67 / ₹6.66', amounts(r), [667, 667, 666]);
check('sums to the total', r.assigned, 2000);
check('valid', r.valid, true);
check('hint', r.hint, '₹6.67/person (3 people)');

console.log('--- equally, two ticked out (the app shows "(1 person)") ---');
const s1 = blank();
s1.included = { ashutosh: false, shriyansh: false };
r = SW.computeSplit('equal', 2000, P, s1);
check('all ₹20 on one person', amounts(r), [2000, 0, 0]);
check('hint names the count', r.hint, '₹20.00/person (1 of 3)');
check('still sums', r.assigned, 2000);

console.log('--- an expense only you are in ("paid for yourself") ---');
r = SW.computeSplit('equal', 4000, ['me'], blank());
check('you owe all of it', r.byUser.me, 4000);
check('valid with one person', r.valid, true);

console.log('--- nobody ticked ---');
const s2 = blank();
P.forEach(id => { s2.included[id] = false; });
r = SW.computeSplit('equal', 2000, P, s2);
check('refused', r.valid, false);
check('says why', r.message, 'Tick at least one person');

console.log('--- exact amounts, part-way through (app: "₹9.00 of ₹20.00, ₹11.00 left") ---');
const s3 = blank();
s3.exact = { sameer: 900 };
r = SW.computeSplit('exact', 2000, P, s3);
check('not valid yet', r.valid, false);
check('remaining stated', r.message, '₹11.00 left to assign');
s3.exact = { sameer: 900, ashutosh: 600, shriyansh: 500 };
r = SW.computeSplit('exact', 2000, P, s3);
check('completed', [r.valid, r.message], [true, 'Adds up']);
s3.exact = { sameer: 2500 };
r = SW.computeSplit('exact', 2000, P, s3);
check('over the total', r.message, '₹5.00 over');

console.log('--- percentages (app: 33 / 33 / 0 => "66% of 100%", "34% left") ---');
const s4 = blank();
s4.percent = { sameer: 33, ashutosh: 33, shriyansh: 0 };
r = SW.computeSplit('percent', 2000, P, s4);
check('refused until 100', r.valid, false);
check('progress hint', r.hint, '66% of 100%');
check('shortfall', r.message, '34% left');

s4.percent = { sameer: 33.34, ashutosh: 33.33, shriyansh: 33.33 };
r = SW.computeSplit('percent', 2000, P, s4);
check('two decimal places total exactly 100', r.valid, true);
check('amounts sum to ₹20', r.assigned, 2000);
console.log('  ' + amounts(r).map(SW.money).join('  '));

s4.percent = { sameer: 50, ashutosh: 30, shriyansh: 20 };
r = SW.computeSplit('percent', 120000, P, s4);
check('50/30/20 of ₹1200', amounts(r), [60000, 36000, 24000]);

console.log('--- shares (app: 2/1/1 of ₹20 => ₹10 / ₹5 / ₹5) ---');
const s5 = blank();
s5.shares = { sameer: 2, ashutosh: 1, shriyansh: 1 };
r = SW.computeSplit('shares', 2000, P, s5);
check('weighted amounts', amounts(r), [1000, 500, 500]);
check('total shares stated', r.hint, '4 total shares');

s5.shares = { sameer: 1, ashutosh: 1, shriyansh: 1 };
r = SW.computeSplit('shares', 2000, P, s5);
check('1/1/1 sums to ₹20', r.assigned, 2000);
check('hint', r.hint, '3 total shares');

s5.shares = {};
r = SW.computeSplit('shares', 2000, P, s5);
check('no shares given', [r.valid, r.message], [false, 'Give at least one share']);

console.log('--- adjustments ---');
// App: ₹20 with +₹5 and +₹5 => ₹8.34 / ₹8.33 / ₹3.33
const s6 = blank();
s6.adjust = { sameer: 500, ashutosh: 500 };
r = SW.computeSplit('adjust', 2000, P, s6);
check('₹8.34 / ₹8.33 / ₹3.33', amounts(r), [834, 833, 333]);
check('sums to ₹20', r.assigned, 2000);

// App: ₹20 with +₹5, +₹5, +₹12 => ₹4.33 / ₹4.33 / ₹11.34
// The adjustments exceed the total, so the remainder is negative.
s6.adjust = { sameer: 500, ashutosh: 500, shriyansh: 1200 };
r = SW.computeSplit('adjust', 2000, P, s6);
check('₹4.33 / ₹4.33 / ₹11.34', amounts(r), [433, 433, 1134]);
check('still sums to ₹20', r.assigned, 2000);
check('valid', r.valid, true);

// But nobody may end up owing less than nothing: expense_splits forbids it.
s6.adjust = { sameer: 5000 };
r = SW.computeSplit('adjust', 2000, P, s6);
check('refused when someone would go negative', r.valid, false);

console.log('--- every mode lands on the total exactly, over many amounts ---');
let bad = null;
for (let amt = 1; amt <= 20000 && !bad; amt += 37) {
  const cases = [
    ['equal',   blank()],
    ['exact',   Object.assign(blank(), { exact: { sameer: amt } })],
    ['percent', Object.assign(blank(), { percent: { sameer: 33.34, ashutosh: 33.33, shriyansh: 33.33 } })],
    ['shares',  Object.assign(blank(), { shares: { sameer: 2, ashutosh: 1, shriyansh: 4 } })],
    ['adjust',  blank()],
  ];
  for (const [mode, st] of cases) {
    const res = SW.computeSplit(mode, amt, P, st);
    if (res.valid && res.assigned !== amt) { bad = { mode, amt, assigned: res.assigned }; break; }
    if (Object.keys(res.byUser).some(k => res.byUser[k] < 0)) { bad = { mode, amt, neg: res.byUser }; break; }
  }
}
check('no mode ever loses or invents a paise', bad, null);

console.log('\n--- mode metadata ---');
check('five modes offered', SW.SPLIT_MODES.map(m => m.key),
  ['equal', 'exact', 'percent', 'shares', 'adjust']);
check('each has a blurb', SW.SPLIT_MODES.every(m => m.blurb && m.label), true);

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
