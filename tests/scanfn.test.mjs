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

const KEYS = ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY',
              'MISTRAL_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY'];
const clearKeys = () => KEYS.forEach((k) => { delete process.env[k]; });
clearKeys();
process.env.SCAN_TIME_BUDGET_MS = '4000';

const scan = (await import('../netlify/functions/scan.mjs')).default;

const png = { mime: 'image/png', data: 'AAAA' };
const post = (body) => new Request('http://x/.netlify/functions/scan', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const one = () => post({ images: [png] });

// Google's reply shape, and an OpenAI-shaped one.
const gemini = (rows) => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text: JSON.stringify({ rows }) }] } }],
}), { status: 200 });
const openai = (rows) => new Response(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ rows }) } }],
}), { status: 200 });
const refused = (status, message, headers) =>
  new Response(JSON.stringify({ error: { code: status, message } }),
    { status, headers: headers || {} });

const ROW = { name: 'Bottle Gourd', qty: 1, price: 35, kind: 'item' };
const PAISE = { name: 'Bottle Gourd', qty: 1, totalPaise: 3500, kind: 'item' };

console.log('--- with no key set, scanning is impossible and says so ---');
let r = await scan(new Request('http://x/'));
let body = await r.json();
check('GET says it is not ready', body.ready, false);
check('and names every provider it could use', body.providers, []);
r = await scan(one());
check('POST is a 501, which the client turns into "no reader is set up"',
  r.status, 501);
check('naming the variables that would turn it on',
  /GEMINI_API_KEY[\s\S]*ANTHROPIC_API_KEY/.test((await r.json()).detail), true);

console.log('\n--- one provider configured ---');
process.env.GEMINI_API_KEY = 'k';
r = await scan(new Request('http://x/'));
check('GET says it is ready', (await r.json()).ready, true);

globalThis.fetch = async (url) => String(url).includes('/models?')
  ? new Response(JSON.stringify({ models: [
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
    ] }), { status: 200 })
  : gemini([ROW]);
r = await scan(one());
body = await r.json();
check('the receipt is read', body.rows, [PAISE]);
check('and the answer says which provider and model read it',
  /^Gemini · gemini-/.test(body.by), true);

console.log('\n--- a retired model name is not a dead end ---');
clearKeys();
process.env.GEMINI_API_KEY = 'k';
delete process.env.OPENAI_MODEL;
let models = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/models?')) {
    return new Response(JSON.stringify({ models: [
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
    ] }), { status: 200 });
  }
  const model = u.split('/models/')[1].split(':')[0];
  models.push(model);
  return models.length === 1
    ? refused(404, 'no longer available to new users')
    : gemini([ROW]);
};
r = await scan(one());
check('it moves on to the next name', models.length, 2);
check('and reads the receipt with that one', (await r.json()).rows, [PAISE]);

console.log('\n--- everything refuses ---');
clearKeys();
process.env.GEMINI_API_KEY = 'k';
globalThis.fetch = async (url) => String(url).includes('/models?')
  ? new Response(JSON.stringify({ models: [
      { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
    ] }), { status: 200 })
  : refused(500, 'upstream exploded');
r = await scan(one());
body = await r.json();
check('the status says try later', r.status, 503);
check('the client is told to stop waiting on the cloud', body.fallback, true);
check('and told what was tried, so it is not a mystery',
  body.tried.length > 0, true);

console.log('\n--- what comes back is money, so it is checked ---');
clearKeys();
process.env.GEMINI_API_KEY = 'k';
process.env.GEMINI_MODEL = 'gemini-3.6-flash';
globalThis.fetch = async () => gemini([
  { name: 'Handling Fee', qty: 1, price: 12, kind: 'fee' },
  { name: 'Apples', qty: 1, price: 178.5, kind: 'item' },
  { name: 'Lady Finger', qty: 2, price: 24, kind: 'item' },
  { name: '', qty: 1, price: 99, kind: 'item' },
  { name: 'Free sample', qty: 1, price: 0, kind: 'item' },
  { name: 'Barcode', qty: 1, price: 9999999, kind: 'item' },
  { name: 'Odd qty', qty: 0, price: 5, kind: 'item' },
]);
r = await scan(one());
check('rupees become integer paise, fees last, nonsense dropped',
  (await r.json()).rows.map((x) => x.kind + '|' + x.totalPaise + '|x' + x.qty + '|' + x.name),
  ['item|17850|x1|Apples', 'item|2400|x2|Lady Finger', 'item|500|x1|Odd qty',
   'fee|1200|x1|Handling Fee']);

console.log('\n--- a model that wraps its JSON in a fence ---');
globalThis.fetch = async () => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{
    text: 'Here you go:\n```json\n{"rows":[' + JSON.stringify(ROW) + ']}\n```',
  }] } }],
}), { status: 200 });
r = await scan(one());
check('is unwrapped rather than refused', (await r.json()).rows, [PAISE]);

console.log('\n--- what it will not accept ---');
globalThis.fetch = async () => gemini([]);
check('nothing sent', (await scan(post({ images: [] }))).status, 400);
check('not an image',
  (await scan(post({ images: [{ mime: 'application/pdf', data: 'AA' }] }))).status, 400);
check('more screenshots than it will read',
  (await scan(post({ images: new Array(9).fill(png) }))).status, 400);
check('a DELETE is never a scan',
  (await scan(new Request('http://x/', { method: 'DELETE' }))).status, 405);

// The prompt is the whole accuracy story now there is no second reader.
const src = readFileSync('netlify/functions/scan.mjs', 'utf8');
check('the model is told the struck-out price is not what was paid',
  /use the amount PAID/.test(src), true);
check('and that several screenshots are one order',
  /consecutive parts of the same scrolling list/.test(src), true);
check('and to read decimals exactly, which is what OCR could not do',
  /100\.00 is one hundred, not ten thousand/.test(src), true);

console.log('\n--- a provider out of quota is not the end of the scan ---');
clearKeys();
process.env.GEMINI_API_KEY = 'k';
process.env.OPENAI_API_KEY = 'k';
process.env.OPENAI_MODEL = 'gpt-4o-mini';   // skip discovery for the second
let asked = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('generativelanguage')) {
    asked.push('gemini');
    return refused(429, 'Quota exceeded', { 'retry-after': '30' });
  }
  asked.push('openai');
  return openai([ROW]);
};
r = await scan(one());
body = await r.json();
check('the next provider answers', body.rows, [PAISE]);
check('it is OpenAI that did', /^OpenAI · /.test(body.by), true);
check('and the one that refused is reported, not hidden',
  body.tried.map((t) => t.label + ':' + t.error), ['Gemini:rate limited']);
check('with how long to wait before trying it again',
  body.tried[0].retryInMs, 30000);

console.log('\n--- a provider on cooldown is skipped, not re-asked ---');
asked = [];
r = await scan(one());
check('Gemini is not called again', asked.includes('gemini'), false);
check('but the scan still succeeds', (await r.json()).rows, [PAISE]);


console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
