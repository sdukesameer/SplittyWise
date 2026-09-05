// Run from the repo root:  node tests/scanfn.test.mjs
//
// The receipt reader function, actually run. Every earlier check on it was a
// regex over its source, and two of them passed for a week while the model
// name they described had been retired by Google — then failed the moment the
// code was fixed, which is the wrong way round. These call it.
import { readFileSync } from 'node:fs';

let fails = 0;
function check(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label +
    (ok ? '' : '\n         got  ' + g + '\n         want ' + w));
}

const scan = (await import('../netlify/functions/scan.mjs')).default;
const png = { mime: 'image/png', data: 'AAAA' };
const post = (body) => new Request('http://x/.netlify/functions/scan', {
  method: 'POST', body: JSON.stringify(body),
});
const one = () => post({ images: [png] });

// Google's reply, in the shape it actually arrives.
function said(rows) {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({ rows }) }] } }],
  }), { status: 200 });
}
function refused(status, message) {
  return new Response(JSON.stringify({ error: { code: status, message } }), { status });
}

console.log('--- with no key set, the app must still be able to scan ---');
delete process.env.GEMINI_API_KEY;
let r = await scan(new Request('http://x/'));
check('GET says it is not ready', await r.json(), { ready: false, tried: [
  'gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-flash-latest'] });
r = await scan(one());
check('POST is a 501, which the client reads as "use the device"', r.status, 501);

console.log('\n--- with a key ---');
process.env.GEMINI_API_KEY = 'test-key';
r = await scan(new Request('http://x/'));
check('GET says it is ready', (await r.json()).ready, true);

console.log('\n--- a model name Google has retired ---');
// This is the real failure: gemini-2.5-flash began answering "no longer
// available to new users", the scanner treated it as a dead end, and fell
// back to on-device OCR without a word. It looked like an ignored API key.
const asked = [];
globalThis.fetch = async (url) => {
  asked.push(String(url).split('/models/')[1].split(':')[0]);
  if (asked.length === 1) {
    return refused(404, 'This model models/x is no longer available to new users.');
  }
  return said([{ name: 'Bottle Gourd', qty: 1, price: 35, kind: 'item' }]);
};
r = await scan(one());
let body = await r.json();
check('it moves on to the next name', asked, ['gemini-3.6-flash', 'gemini-2.5-flash']);
check('and reads the receipt with that one', body.rows,
  [{ name: 'Bottle Gourd', qty: 1, totalPaise: 3500, kind: 'item' }]);
check('saying which model answered', body.by, 'gemini-2.5-flash');

console.log('\n--- a failure that trying again cannot fix ---');
asked.length = 0;
globalThis.fetch = async (url) => {
  asked.push(String(url).split('/models/')[1].split(':')[0]);
  return refused(429, 'Quota exceeded');
};
r = await scan(one());
body = await r.json();
check('quota is not retried against every other model', asked.length, 1);
check('the status is the real one', r.status, 429);
check('it is named rather than reduced to "failed"',
  /out of quota/.test(body.error), true);
check('and it tells the client to fall back', body.fallback, true);

asked.length = 0;
globalThis.fetch = async () => refused(400, 'API key not valid');
r = await scan(one());
check('a bad key is not retried either', r.status, 502);
check('and still falls back rather than stranding the scan',
  (await r.json()).fallback, true);

console.log('\n--- what comes back is money, so it is checked ---');
globalThis.fetch = async () => said([
  { name: 'Handling Fee', qty: 1, price: 12, kind: 'fee' },
  { name: 'Apples', qty: 1, price: 178.5, kind: 'item' },
  { name: 'Lady Finger', qty: 2, price: 24, kind: 'item' },
  { name: '', qty: 1, price: 99, kind: 'item' },
  { name: 'Free sample', qty: 1, price: 0, kind: 'item' },
  { name: 'Barcode', qty: 1, price: 9999999, kind: 'item' },
  { name: 'Odd qty', qty: 0, price: 5, kind: 'item' },
]);
r = await scan(one());
body = await r.json();
check('rupees become integer paise, fees last, nonsense dropped',
  body.rows.map((x) => x.kind + '|' + x.totalPaise + '|x' + x.qty + '|' + x.name),
  ['item|17850|x1|Apples', 'item|2400|x2|Lady Finger', 'item|500|x1|Odd qty',
   'fee|1200|x1|Handling Fee']);

console.log('\n--- what it will not accept ---');
globalThis.fetch = async () => said([]);
check('nothing sent', (await scan(post({ images: [] }))).status, 400);
check('not an image',
  (await scan(post({ images: [{ mime: 'application/pdf', data: 'AA' }] }))).status, 400);
check('more screenshots than it will read',
  (await scan(post({ images: new Array(9).fill(png) }))).status, 400);
check('a GET is never a scan', (await scan(new Request('http://x/', {
  method: 'DELETE' }))).status, 405);

// The prompt is the whole accuracy story for this path, so the one thing it
// must say is checked here rather than trusted.
const src = readFileSync('netlify/functions/scan.mjs', 'utf8');
check('the model is told the struck-out price is not what was paid',
  /use the amount PAID/.test(src), true);
check('and that several screenshots are one order',
  /consecutive parts of the same scrolling list/.test(src), true);

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
