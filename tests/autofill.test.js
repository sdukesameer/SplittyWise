// Run from the repo root:  node tests/autofill.test.js
//
// The "fill in the last one for me" rule, and the ordinal day used by the
// monthly settle-up reminder.
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
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label +
    (ok ? '' : '\n         got  ' + g + '\n         want ' + w));
}

// Shorthand: 'a:5000' is a filled field, 'a:' is blank, 'a*:5000' is one we
// filled ourselves last time.
function fields(spec) {
  return spec.split(' ').map(function (s) {
    const auto = s.indexOf('*') > -1;
    const bits = s.replace('*', '').split(':');
    return {
      id: bits[0],
      value: bits[1] ? Number(bits[1]) : 0,
      filled: bits[1] !== '',
      auto: auto,
    };
  });
}

console.log('--- the one figure that has to follow ---');

// The example from the request: ₹300 across three, 50 and 100 typed.
check('₹300, two of three typed → the third is forced',
  SW.deriveBlank(30000, fields('a:5000 b:10000 c:')),
  { id: 'c', value: 15000 });

check('two still blank → nothing is guessed',
  SW.deriveBlank(30000, fields('a:5000 b: c:')), null);

check('all three typed → nothing to fill',
  SW.deriveBlank(30000, fields('a:5000 b:10000 c:15000')), null);

check('the field we filled keeps tracking the others',
  SW.deriveBlank(30000, fields('a:6000 b:10000 c*:15000')),
  { id: 'c', value: 14000 });

check('two people, one typed',
  SW.deriveBlank(30000, fields('a:12000 b:')), { id: 'b', value: 18000 });

console.log('\n--- when it must keep its hands off ---');

check('the others already cover the total',
  SW.deriveBlank(30000, fields('a:15000 b:15000 c:')), null);

check('the others overshoot the total',
  SW.deriveBlank(30000, fields('a:20000 b:20000 c:')), null);

check('no total yet',
  SW.deriveBlank(0, fields('a:5000 b:')), null);

check('a single field is not a remainder',
  SW.deriveBlank(30000, fields('a:')), null);

check('two auto fields cannot both be derived',
  SW.deriveBlank(30000, fields('a:5000 b*:10000 c*:15000')), null);

console.log('\n--- percentages use the same rule ---');

check('100% across three, two typed',
  SW.deriveBlank(100, fields('a:50 b:20 c:')), { id: 'c', value: 30 });

check('fractional percents do not drift',
  SW.deriveBlank(100, fields('a:33.33 b:33.33 c:')), { id: 'c', value: 33.34 });

check('already at 100%',
  SW.deriveBlank(100, fields('a:60 b:40 c:')), null);

console.log('\n--- paise are exact, because they are integers ---');

// ₹1000 three ways: the remainder must be the exact paise left, never a
// rounded rupee that leaves the split a paisa short.
check('₹1000 less 333.33 twice is exactly 333.34',
  SW.deriveBlank(100000, fields('a:33333 b:33333 c:')),
  { id: 'c', value: 33334 });

check('the derived figure closes the split exactly', (function () {
  const answer = SW.deriveBlank(100000, fields('a:33333 b:33333 c:'));
  return 33333 + 33333 + answer.value;
})(), 100000);

console.log('\n--- ordinal days, matching sw.ordinal_day() ---');
[[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [5, '5th'],
 [11, '11th'], [12, '12th'], [13, '13th'],
 [21, '21st'], [22, '22nd'], [23, '23rd'], [30, '30th'], [31, '31st']]
  .forEach(function (pair) {
    check('the ' + pair[1], SW.ordinalDay(pair[0]), pair[1]);
  });

console.log(fails ? '\n' + fails + ' FAILED' : '\nAll checks passed');
process.exit(fails ? 1 : 0);
