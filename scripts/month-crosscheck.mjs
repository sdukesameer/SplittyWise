// Runs the cases from tests/months.test.js through sw.shift_month_words() in
// the live schema and compares each against SW.shiftMonthWords() in the app.
//
// Two implementations of the same rule will drift. The schema's is the one
// that names the expense; the client's only previews it. This is what stops
// the preview quietly lying — it already caught a null-returning year step
// and a year that moved only when it came before the month.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const suite = fs.readFileSync('tests/months.test.js', 'utf8');
const cases = [...suite.matchAll(/^shifts\((.*?), (-?\d+), (.*?)\);$/gm)]
  .map((m) => [eval(m[1]), Number(m[2])]);   // eslint-disable-line no-eval

if (!cases.length) {
  console.error('  no cases found in tests/months.test.js');
  process.exit(2);
}

const values = cases
  .map(([src, by]) => "('" + String(src).replace(/'/g, "''") + "', " + by + ')')
  .join(',\n  ');

const sql = 'select src, shift, sw.shift_month_words(src, shift) as got\n' +
  'from (values\n  ' + values + '\n) as t(src, shift);';
fs.writeFileSync('/tmp/sw-month-cases.sql', sql);

const out = execFileSync('supabase',
  ['db', 'query', '--linked', '-f', '/tmp/sw-month-cases.sql'],
  { encoding: 'utf8' });

const found = out.match(/"rows":\s*(\[[\s\S]*?\n {2}\])/);
if (!found) {
  console.error('  could not read the query result:\n' + out.slice(0, 600));
  process.exit(2);
}

global.window = {};
global.window.SW = global.SW = {};
new Function('window', 'SW', fs.readFileSync('js/balances.js', 'utf8'))(global.window, global.SW);

let bad = 0;
for (const row of JSON.parse(found[1])) {
  const js = SW.shiftMonthWords(row.src, row.shift);
  if (js !== row.got) {
    bad++;
    console.log('  DISAGREE  ' + JSON.stringify(row.src) + ' ' + row.shift +
      '\n            schema: ' + JSON.stringify(row.got) +
      '\n            client: ' + JSON.stringify(js));
  }
}

console.log('  ' + JSON.parse(found[1]).length + ' cases through both · ' +
  (bad ? bad + ' DISAGREEMENT(S)' : 'they agree'));
process.exit(bad ? 1 : 0);
