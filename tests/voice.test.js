// Run from the repo root:  node tests/voice.test.js
//
// Speech comes back as words at least as often as digits, and getting an
// amount wrong here writes the wrong number into the ledger.
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

global.window = {};
global.window.SW = global.SW = {};
new Function('window', 'SW', fs.readFileSync('js/balances.js', 'utf8'))(global.window, global.SW);

let fails = 0;
function amount(said, want) {
  const got = SW.parseSpokenAmount(said);
  const ok = got === want;
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + JSON.stringify(said).padEnd(34) + ' -> ' +
    (got === null ? 'null' : SW.money(got)) +
    (ok ? '' : '   want ' + (want === null ? 'null' : SW.money(want))));
}
function desc(said, want) {
  const got = SW.stripSpokenAmount(said);
  const ok = got === want;
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + JSON.stringify(said).padEnd(34) +
    ' -> ' + JSON.stringify(got) + (ok ? '' : '   want ' + JSON.stringify(want)));
}

console.log('--- digits ---');
amount('chai 40', 4000);
amount('groceries 1250', 125000);
amount('auto 87.50', 8750);

console.log('\n--- words, which is what speech usually returns ---');
amount('chai forty rupees', 4000);
amount('chai fourty rupees', 4000);           // a common misrecognition
amount('lunch two hundred fifty', 25000);
amount('rent fifteen thousand', 1500000);
amount('petrol one thousand two hundred', 120000);
amount('gift five hundred rupees only', 50000);
amount('deposit two lakh', 20000000);
amount('twenty', 2000);
amount('hundred rupees', 10000);
amount('nineteen', 1900);
amount('ninety nine', 9900);

console.log('\n--- nothing to take ---');
amount('', null);
amount('chai', null);
amount('groceries and vegetables', null);
amount('zero', null);
amount('ten crore', null);

console.log('\n--- the description is what is left ---');
desc('chai forty rupees', 'Chai');
desc('lunch two hundred fifty', 'Lunch');
desc('groceries 1250', 'Groceries');
desc('rent fifteen thousand', 'Rent');
desc('petrol for the bike 900', 'Petrol the bike');
desc('two hundred', '');

console.log('\n--- an amount is never invented ---');
let bad = null;
['hello there', 'the quick brown fox', 'no numbers at all'].forEach(function (s) {
  if (SW.parseSpokenAmount(s) !== null) bad = s;
});
console.log((bad ? '  FAIL  ' : '  PASS  ') + 'plain speech yields no amount' +
  (bad ? ' — got one from ' + JSON.stringify(bad) : ''));
if (bad) fails++;

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
