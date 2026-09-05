// ---------------------------------------------------------------------------
//  Read a receipt with a vision model instead of guessing at pixels
//
//  Tesseract is character recognition with no idea what a receipt is. Its
//  English model has never been shown a ₹, so it substitutes the nearest
//  glyph it knows — on a Blinkit order, "2" — and ₹35 silently becomes 235.
//  js/scan.js now detects and undoes that, but it is a repair, not a cure:
//  the reader still cannot tell a struck-out MRP from the price paid, or a
//  product thumbnail from a word.
//
//  A vision model reads the layout. It knows the right-hand column is money,
//  that a crossed-out number is the old price, and that three screenshots of
//  the same scrolling list are one order and not three.
//
//  Unconfigured, this returns 501 and the app falls back to on-device OCR,
//  so a deploy without a key still scans — just less well.
//
//  Note the trade: the picture leaves the phone. The scanner says so before
//  it is used, and the on-device reader stays one tap away.
// ---------------------------------------------------------------------------

const MODEL = 'gemini-2.5-flash';
const MAX_IMAGES = 5;
const MAX_BYTES = 5 * 1024 * 1024;       // per image, after the client shrinks it

const PROMPT = [
  'These images are screenshots of ONE order from an Indian quick-commerce or',
  'food app (Zepto, Blinkit, Swiggy Instamart, BigBasket, Zomato, Dunzo).',
  'Several images are consecutive parts of the same scrolling list, so an item',
  'visible in two of them is ONE item — never list it twice.',
  '',
  'List every line the customer actually ordered.',
  '',
  'price: the rupee amount CHARGED for that line, as a number. Quick-commerce',
  'apps show a discount by printing the old MRP struck through, usually smaller',
  'or greyed, next to or under the amount paid — use the amount PAID, which is',
  'the smaller one. The price shown against a row is the total for that row.',
  '',
  'qty: how many of it were ordered. "1 unit", "2 units", "x2". A pack size',
  '("500 g", "12 x 70 g", "1 pack (6 pcs)") is NOT a quantity — that is 1.',
  '',
  'kind: "fee" for handling, delivery, platform, packaging, surge, rain, tip,',
  'GST and other taxes. "item" for anything anyone ate or unpacked.',
  '',
  'Leave out order totals, subtotals, "you saved", order ids, addresses,',
  'delivery times, and anything that is app furniture rather than the order.',
  'Give the product name as printed, without the size line beneath it.',
  'If an image is not a receipt at all, return an empty list.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          qty: { type: 'integer' },
          price: { type: 'number' },
          kind: { type: 'string', enum: ['item', 'fee'] },
        },
        required: ['name', 'qty', 'price', 'kind'],
      },
    },
  },
  required: ['rows'],
};

export default async (request) => {
  const key = process.env.GEMINI_API_KEY;

  // A GET is the scanner asking, before it shows anything, whether this
  // deploy has a reader — so that it can say truthfully where the picture
  // goes instead of promising one thing and doing another.
  if (request.method === 'GET') return json({ ready: !!key });
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

  if (!key) {
    // Not an error the person needs to see: the app quietly reads on-device.
    return json({ error: 'unconfigured', detail: 'GEMINI_API_KEY is not set' }, 501);
  }

  let images;
  try {
    const body = await request.json();
    images = Array.isArray(body.images) ? body.images : [];
  } catch (e) {
    return json({ error: 'Send { images: [{ mime, data }] }' }, 400);
  }

  if (!images.length) return json({ error: 'No images sent' }, 400);
  if (images.length > MAX_IMAGES) {
    return json({ error: 'At most ' + MAX_IMAGES + ' screenshots at a time' }, 400);
  }

  const parts = [{ text: PROMPT }];
  for (const img of images) {
    const mime = String(img && img.mime || '');
    const data = String(img && img.data || '');
    if (!/^image\/(png|jpe?g|webp|heic|heif)$/i.test(mime)) {
      return json({ error: 'That file is not an image the reader accepts' }, 400);
    }
    // base64 inflates by 4/3; measure what was actually sent.
    if ((data.length * 3) / 4 > MAX_BYTES) {
      return json({ error: 'One of those images is too large' }, 413);
    }
    parts.push({ inline_data: { mime_type: mime, data: data } });
  }

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
              MODEL + ':generateContent';

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: SCHEMA,
        },
      }),
    });
  } catch (err) {
    return json({ error: 'Could not reach the reader', detail: String(err) }, 502);
  }

  const raw = await res.text();
  if (!res.ok) {
    // The key being out of quota is the one failure worth naming, because the
    // answer is "wait, or use the on-device reader" and not "try again".
    const quota = res.status === 429;
    return json({
      error: quota ? 'The free reader is out of quota for now' : 'The reader refused that',
      detail: raw.slice(0, 400),
      fallback: true,
    }, quota ? 429 : 502);
  }

  let rows = [];
  try {
    const payload = JSON.parse(raw);
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed.rows) ? parsed.rows : [];
  } catch (err) {
    return json({ error: 'The reader sent back something unreadable', fallback: true }, 502);
  }

  // Money crosses the wire as rupees and becomes paise here, so the client
  // never has to do the rounding — every amount in this app is an integer.
  const clean = [];
  for (const r of rows) {
    const name = String(r && r.name || '').trim().slice(0, 120);
    const price = Number(r && r.price);
    if (!name || !isFinite(price) || price <= 0 || price > 500000) continue;
    const qty = Math.min(99, Math.max(1, Math.round(Number(r && r.qty) || 1)));
    clean.push({
      name,
      qty,
      totalPaise: Math.round(price * 100),
      kind: r && r.kind === 'fee' ? 'fee' : 'item',
    });
  }

  // Fees last, the same order js/scan.js puts them in.
  const items = clean.filter((r) => r.kind === 'item');
  const fees = clean.filter((r) => r.kind === 'fee');
  return json({ rows: items.concat(fees), by: MODEL });
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
