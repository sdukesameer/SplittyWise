// Run from the repo root:  node tests/months.test.js
//
// The month in a repeating expense's title moves with it: "Rent August"
// posted again in September reads "Rent September". This is the client's
// preview of what the server will do; sw.shift_month_words() in the schema
// is the authority, and these are the same cases both sides are held to.
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

global.window = {};
global.window.SW = global.SW = {};
new Function('window', 'SW', fs.readFileSync('js/balances.js', 'utf8'))(global.window, global.SW);

let fails = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label +
    (ok ? '' : '\n         got  ' + JSON.stringify(got) +
               '\n         want ' + JSON.stringify(want)));
}

function shifts(src, by, want) {
  check(JSON.stringify(src) + ' ' + (by >= 0 ? '+' : '') + by,
    SW.shiftMonthWords(src, by), want);
}

console.log('--- the month moves, nothing else does ---');
shifts('Rent August', 1, 'Rent September');
shifts('August rent', 1, 'September rent');
shifts('rent august', 1, 'rent september');
shifts('RENT AUGUST', 1, 'RENT SEPTEMBER');
shifts('Rent (August) — flat 2B', 1, 'Rent (September) — flat 2B');
shifts('rent, aug, paid', 1, 'rent, sep, paid');

console.log('\n--- abbreviations stay abbreviated ---');
shifts('JioFiber Aug', 1, 'JioFiber Sep');
shifts('JioFiber Sept 2026', 1, 'JioFiber Oct 2026');
shifts('Rent Jan', 1, 'Rent Feb');

console.log('\n--- the year follows when the month wraps ---');
shifts('Rent December 2026', 1, 'Rent January 2027');
shifts('Rent Dec 2026', 2, 'Rent Feb 2027');
shifts('Nov 2026 dues', 3, 'Feb 2027 dues');
shifts('Rent March 2026', 1, 'Rent April 2026');
shifts('Rent January 2026', -1, 'Rent December 2025');
shifts('Insurance August 2026', 12, 'Insurance August 2027');

console.log('\n--- and it keeps its hands off everything else ---');
shifts('Netflix', 1, 'Netflix');
shifts('Rent for the flat', 1, 'Rent for the flat');
shifts('Rent August', 0, 'Rent August');
// A word that merely contains a month name is not a month.
shifts('Marching band fees', 1, 'Marching band fees');
shifts('Augustine dues', 1, 'Augustine dues');
shifts('Decorations', 1, 'Decorations');
shifts('Janitor', 1, 'Janitor');
// An amount must not be mistaken for a year.
shifts('Rent December 1200', 1, 'Rent January 1200');
shifts('May groceries', 1, 'June groceries');
shifts('Rent August', -2, 'Rent June');
check('null passes through', SW.shiftMonthWords(null, 1), null);

console.log('\n--- how far a title moves between two occurrences ---');
check('monthly moves one', SW.monthsBetween('2026-08-01', '2026-09-01'), 1);
check('yearly moves twelve', SW.monthsBetween('2026-08-01', '2027-08-01'), 12);
check('a week inside one month moves none', SW.monthsBetween('2026-08-03', '2026-08-10'), 0);
check('a week across the boundary moves one', SW.monthsBetween('2026-08-28', '2026-09-04'), 1);
check('December to January moves one', SW.monthsBetween('2026-12-01', '2027-01-01'), 1);

console.log('\n--- resuming a paused rule takes the title with it ---');
// run_due_recurring only rolls the months it actually posts, and a paused
// rule posts none — so a rule paused in August and resumed in December would
// come back still calling itself "Rent August".
function resumed(descr, pausedAt, resumedAt, want) {
  const skipped = SW.monthsBetween(pausedAt, resumedAt);
  check(JSON.stringify(descr) + ' paused ' + pausedAt + ', resumed ' + resumedAt +
        ' (' + skipped + 'm)',
    skipped ? SW.shiftMonthWords(descr, skipped) : descr, want);
}
resumed('Rent August', '2026-08-01', '2026-09-01', 'Rent September');
resumed('Rent August', '2026-08-01', '2026-12-01', 'Rent December');
resumed('Dues December 2026', '2026-12-01', '2027-02-01', 'Dues February 2027');
resumed('Netflix', '2026-08-01', '2026-12-01', 'Netflix');
// Same month: nothing to move.
resumed('Rent August', '2026-08-01', '2026-08-15', 'Rent August');

console.log('\n--- "does this title name a month?" without a second list ---');
// The app asks whether shifting would change anything, rather than keeping
// its own list of month names to drift out of step with.
[['Rent August', true], ['JioFiber Sept 2026', true], ['May groceries', true],
 ['Netflix', false], ['Marching band fees', false], ['Rent for the flat', false]]
  .forEach(function (pair) {
    check('names a month: ' + JSON.stringify(pair[0]),
      SW.shiftMonthWords(pair[0], 1) !== pair[0], pair[1]);
  });

console.log(fails ? '\n' + fails + ' FAILED' : '\nAll checks passed');
process.exit(fails ? 1 : 0);
