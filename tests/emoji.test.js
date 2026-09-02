// Run from the repo root:  node tests/emoji.test.js
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

global.window = {};
global.window.SW = global.SW = {};
new Function('window', 'SW', fs.readFileSync('js/emoji.js', 'utf8'))(global.window, global.SW);

let fails = 0;
function check(desc, want) {
  const got = SW.guessEmoji(desc);
  const ok = got === want;
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + got + '  "' + desc + '"' + (ok ? '' : '   want ' + want));
}

console.log('--- the ones from the plan ---');
check('chai', '☕');
check('petrol', '⛽');
check('rent', '🏠');

console.log('\n--- realistic descriptions ---');
check('Morning chai for everyone', '☕');
check('Big grocery run at DMart', '🛒');
check('Swiggy dinner', '🍽️');
check('Ola to airport', '🛺');
check('Jio Fiber monthly', '🌐');
check('electricity bill august', '💡');
check('Gas cylinder refill', '🔥');
check('PVR tickets for the movie', '🎬');
check('Medicines from Apollo', '💊');
check('maid salary', '🧹');
check('Goa trip hotel', '🏨');
check('Amazon shopping', '🛍️');
check('birthday cake', '🎂');
check('beer at the pub', '🍻');
check('paneer and milk', '🥛');
check('IRCTC train booking', '🚆');
check('gym membership', '🏋️');

console.log('\n--- specificity: earlier rules must win ---');
check('chai and snacks', '☕');          // chai before snacks
check('pizza dinner', '🍕');            // pizza before generic dinner
check('petrol pump', '⛽');

console.log('\n--- fallback ---');
check('', '🧾');
check('   ', '🧾');
check('xyzzy misc thing', '🧾');
check('Settlement', '🧾');

console.log('\n--- picker groups are well formed ---');
let bad = 0;
SW.EMOJI_GROUPS.forEach(function (g) {
  if (!g.label || !Array.isArray(g.items) || !g.items.length) bad++;
  g.items.forEach(function (e) { if (!e || e.length > 6) bad++; });
});
const total = SW.EMOJI_GROUPS.reduce((n, g) => n + g.items.length, 0);
console.log((bad ? '  FAIL  ' : '  PASS  ') + SW.EMOJI_GROUPS.length +
            ' groups, ' + total + ' emoji, ' + bad + ' malformed');
if (bad) fails++;

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
