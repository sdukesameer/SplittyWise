// Run from the repo root:  node tests/calc.test.js
//
// The amount field accepts arithmetic. It must never produce a wrong total
// silently, and must never be a way to run something other than a sum.
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

global.window = {};
global.window.SW = global.SW = {};
new Function('window', 'SW', fs.readFileSync('js/balances.js', 'utf8'))(global.window, global.SW);

let fails = 0;
function check(input, want) {
  const got = SW.evalAmount(input);
  const ok = got === want;
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') +
    JSON.stringify(input).padEnd(20) + ' -> ' +
    (got === null ? 'null' : SW.money(got)) +
    (ok ? '' : '   want ' + (want === null ? 'null' : SW.money(want))));
}

console.log('--- sums people actually type ---');
check('240+80*2', 40000);        // precedence: 240 + 160
check('1200/3', 40000);
check('(100+50)*2', 30000);
check('12.5*4', 5000);
check('450', 45000);
check('₹1,200', 120000);
check('99.99', 9999);
check('100-40', 6000);
check('100+0.50', 10050);
check('2*3*4', 2400);
check('1000/8', 12500);

console.log('\n--- rounded to paise, never a fraction of one ---');
check('10/3', 333);              // 3.3333... -> ₹3.33
check('0.005', 1);               // rounds up
check('0.004', 0);

console.log('\n--- rejected rather than guessed at ---');
[['', null], ['   ', null], ['abc', null], ['1.2.3', null], ['5/0', null],
 ['100+', null], ['*5', null], ['(1+2', null], ['1+2)', null], ['--', null],
 ['1e5', null], ['0x10', null], ['-50', null], ['1+alert(1)', null],
 ['999999999', null]].forEach(function (c) { check(c[0], c[1]); });

console.log('\n--- unary signs inside a sum are fine ---');
check('100+-40', 6000);
check('100*-1', null);           // a negative total is not an expense

console.log('\n--- is it a sum, or just a number? ---');
[['240+80', true], ['1200/3', true], ['(5)', true], ['450', false],
 ['99.99', false], ['', false]].forEach(function (c) {
  const got = SW.isExpression(c[0]);
  const ok = got === c[1];
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + JSON.stringify(c[0]).padEnd(12) +
    ' -> ' + got + (ok ? '' : '   want ' + c[1]));
});

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
