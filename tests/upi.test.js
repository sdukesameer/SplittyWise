// Run from the repo root:  node tests/upi.test.js
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

console.log('--- UPI ids ---');
['shriyansh@okhdfcbank', 'md.sameer@ybl', 'a-b_c@paytm', '9876543210@upi',
 'name@okaxis'].forEach(v => check('valid: ' + v, SW.isUpiId(v), true));
['', 'nope', '@ybl', 'a@', 'a@b', 'has space@ybl', 'two@@ybl', 'x@1bank']
  .forEach(v => check('rejected: "' + v + '"', SW.isUpiId(v), false));

console.log('\n--- the deep link ---');
const uri = SW.upiUri({
  vpa: 'shriyansh@okhdfcbank', name: 'Shriyansh', amountPaise: 45000,
  note: 'Grocery & Utilities: settle up!',
});
console.log('  ' + uri);
check('scheme and payee', uri.indexOf('upi://pay?pa=shriyansh%40okhdfcbank') === 0, true);
check('amount is rupees, two decimals', uri.indexOf('&am=450.00') > -1, true);
check('currency is fixed to INR', uri.indexOf('&cu=INR') > -1, true);
check('note stripped to alphanumerics', uri.indexOf('&tn=Grocery%20Utilities%20settle%20up') > -1, true);
check('payee name encoded', SW.upiUri({ vpa: 'a@b', name: 'Md Sameer', amountPaise: 100 })
  .indexOf('pn=Md%20Sameer') > -1, true);
check('no note, no tn param',
  SW.upiUri({ vpa: 'a@b', name: 'X', amountPaise: 100 }).indexOf('&tn=') === -1, true);
check('paise render exactly', SW.upiUri({ vpa: 'a@b', name: 'X', amountPaise: 1 })
  .indexOf('&am=0.01') > -1, true);

console.log('\n--- recurrence: the day of the month must not drift ---');
// The classic bug: 31 Jan clamps to 28 Feb, and every later month sticks there.
let d = '2026-01-31';
const monthly = [];
for (let i = 0; i < 5; i++) { d = SW.nextOccurrence(d, 'monthly', 31); monthly.push(d); }
check('31st is restored after February', monthly,
  ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);

d = '2026-01-15';
check('mid-month is simple', SW.nextOccurrence(d, 'monthly', 15), '2026-02-15');
check('December rolls the year', SW.nextOccurrence('2026-12-05', 'monthly', 5), '2027-01-05');
check('30th in February clamps', SW.nextOccurrence('2026-01-30', 'monthly', 30), '2026-02-28');
check('leap February takes the 29th', SW.nextOccurrence('2028-01-31', 'monthly', 31), '2028-02-29');

console.log('\n--- weekly and yearly ---');
check('weekly', SW.nextOccurrence('2026-09-02', 'weekly'), '2026-09-09');
check('weekly across a month end', SW.nextOccurrence('2026-09-28', 'weekly'), '2026-10-05');
check('weekly across a year end', SW.nextOccurrence('2026-12-29', 'weekly'), '2027-01-05');
check('yearly', SW.nextOccurrence('2026-03-01', 'yearly'), '2027-03-01');
check('29 Feb clamps to 28 the next year', SW.nextOccurrence('2028-02-29', 'yearly'), '2029-02-28');

console.log('\n--- catching up never goes backwards ---');
let cur = '2026-01-01';
let bad = null;
for (let i = 0; i < 400; i++) {
  const next = SW.nextOccurrence(cur, 'monthly', 1);
  if (next <= cur) { bad = { cur, next }; break; }
  cur = next;
}
check('always strictly forward', bad, null);
console.log('  33 years of monthly steps end at ' + cur);

console.log('\n--- cadence labels ---');
check('three cadences', SW.CADENCES.map(c => c.key), ['weekly', 'monthly', 'yearly']);
check('label', SW.cadenceLabel('monthly'), 'Every month');
check('unknown reads as Never', SW.cadenceLabel('nonsense'), 'Never');

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
