// Run from the repo root:  node tests/scan.test.js
//
// The parser has to cope with real Tesseract output: prices on their own
// line, ₹ read as "Rs" or "R5", struck-through MRPs, weights that look like
// prices, and rows repeated by the screenshot.
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

global.window = {};
global.window.SW = global.SW = {};
for (const f of ['js/balances.js', 'js/scan.js']) {
  new Function('window', 'SW', fs.readFileSync(f, 'utf8'))(global.window, global.SW);
}

let fails = 0;
function check(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok ? '' : '\n         got  ' + g + '\n         want ' + w));
}
const brief = r => r.rows.map(x => x.name + '|' + x.qty + '|' + x.totalPaise + '|' + x.kind);

console.log('--- Zepto, amounts on the same line ---');
let r = SW.parseReceipt([
  'Zepto',
  'Onion 1 kg ₹42',
  'Amul Butter 500 g x2 ₹530',
  'Maggi Noodles 12 pack ₹168',
  'Brown Bread ₹45',
  'Item Total ₹785',
  'Handling Fee ₹12',
  'Delivery Fee ₹25',
  'You saved ₹58',
  'To Pay ₹822',
].join('\n'));
check('4 items + 2 fees', brief(r), [
  'Onion 1 kg|1|4200|item',
  'Amul Butter 500 g|2|53000|item',
  'Maggi Noodles 12 pack|1|16800|item',
  'Brown Bread|1|4500|item',
  'Handling Fee|1|1200|fee',
  'Delivery Fee|1|2500|fee',
]);

console.log('\n--- Blinkit, price on its own line ---');
r = SW.parseReceipt([
  'Onion', '1 kg', '₹42',
  'Amul Butter', '500 g', '₹265',
  'Handling Fee', '₹12',
].join('\n'));
check('names joined with their weight line', brief(r), [
  'Onion 1 kg|1|4200|item',
  'Amul Butter 500 g|1|26500|item',
  'Handling Fee|1|1200|fee',
]);

console.log('\n--- OCR noise: Rs / R5 for ₹, and repeated rows ---');
r = SW.parseReceipt([
  'Onion 1kg Rs 42',
  'Onion 1kg Rs 42',
  'Tomato 500 g', 'Rs 38',
  'Platform Fee R5 8',
  'MRP ₹49',
].join('\n'));
check('duplicate folded away', brief(r), [
  'Onion 1kg|1|4200|item',
  'Tomato 500 g|1|3800|item',
  'Platform Fee|1|800|fee',
]);
check('one merge reported', r.merged, 1);

console.log('\n--- struck-through MRP on the same line ---');
r = SW.parseReceipt('Amul Milk 500ml ₹32 ₹28');
check('takes the rightmost (payable) price', brief(r), ['Amul Milk 500ml|1|2800|item']);

console.log('\n--- a weight must not be read as a price ---');
r = SW.parseReceipt('Amul Butter 500 g');
check('no price, no row', brief(r), []);
r = SW.parseReceipt('Basmati Rice 5 kg\n₹560');
check('weight then price', brief(r), ['Basmati Rice 5 kg|1|56000|item']);

console.log('\n--- bare trailing amount, no currency mark ---');
r = SW.parseReceipt('Brown Bread 45\nCurd 400 g 38');
check('trailing number is the amount', brief(r), [
  'Brown Bread|1|4500|item',
  'Curd 400 g|1|3800|item',
]);

console.log('\n--- quantity forms ---');
r = SW.parseReceipt([
  'Coke can x3 ₹120',
  '2 x Dairy Milk ₹90',
  'Eggs Qty: 2 ₹130',
].join('\n'));
check('x3 / 2 x / Qty:', r.rows.map(x => x.qty), [3, 2, 2]);

console.log('\n--- everything that is not an item gets skipped ---');
r = SW.parseReceipt([
  'Order ID 88213', 'Delivered to Home', 'GSTIN 29ABCDE',
  'Sub Total ₹500', 'You saved ₹40', 'Grand Total ₹520',
  'Paid via UPI', 'Thank you for shopping',
].join('\n'));
check('no rows survive', brief(r), []);

console.log('\n--- fees are recognised, and sorted after items ---');
r = SW.parseReceipt([
  'Handling Fee ₹12', 'Onion ₹42', 'GST ₹6', 'Tomato ₹38', 'Tip ₹20',
].join('\n'));
check('items first, then fees', brief(r), [
  'Onion|1|4200|item',
  'Tomato|1|3800|item',
  'Handling Fee|1|1200|fee',
  'GST|1|600|fee',
  'Tip|1|2000|fee',
]);

console.log('\n--- pasted order text, which is exact rather than guessed at ---');
// A real Zepto order copied out of the app: tabs, rupee signs, a struck MRP,
// quantity badges, and the fee block at the end.
r = SW.parseReceipt([
  'Order summary',
  'Onion (Peeled)\t1 kg\t₹42',
  'Amul Butter\t500 g\t₹265',
  'Maggi Masala Noodles\t12 x 70 g\tx2\t₹336',
  'Tata Salt\t1 kg\t₹28',
  'Item total\t₹671',
  'Handling charge\t₹12',
  'Delivery charge\t₹0',
  'Grand total\t₹683',
].join('\n'));
check('four items and one real fee', brief(r), [
  'Onion (Peeled) 1 kg|1|4200|item',
  'Amul Butter 500 g|1|26500|item',
  'Maggi Masala Noodles 12 x 70 g|2|33600|item',
  'Tata Salt 1 kg|1|2800|item',
  'Handling charge|1|1200|fee',
]);
console.log('  a ₹0 delivery charge is dropped, since it splits to nothing');

console.log('\n--- a pack size is not a quantity ---');
check('"12 x 70 g" alone is one item',
  SW.parseReceipt('Maggi 12 x 70 g ₹336').rows.map(x => x.qty + '|' + x.name),
  ['1|Maggi 12 x 70 g']);
check('"x2" after a pack size is the count',
  SW.parseReceipt('Maggi 12 x 70 g x2 ₹336').rows.map(x => x.qty + '|' + x.name),
  ['2|Maggi 12 x 70 g']);
check('"2 x Name" is still a count',
  SW.parseReceipt('2 x Dairy Milk ₹90').rows.map(x => x.qty + '|' + x.name),
  ['2|Dairy Milk']);
check('"6 x 250 ml" is a pack, not six',
  SW.parseReceipt('Real Juice 6 x 250 ml ₹390').rows.map(x => x.qty),
  [1]);

console.log('\n--- a real Blinkit screenshot, where OCR loses the rupee sign ---');
// Reconstructed from the screenshot that failed: every ₹ came back as a "2",
// so ₹35 read as 235 and the ₹469 basket totalled ₹53,727. The thumbnails
// became junk in front of the names, the order number became an item, and the
// struck-out MRP under each row became a second one.
r = SW.parseReceipt([
  '2:14 7.00 KB/S',
  'Order #HGTKKOIU49669',
  '10 items',
  'Get Help',
  '10 items in order',
  '& Bottle Gourd 235',
  '1pc + 1 unit 299',
  '© ..& Tomato Local 226',
  '500 g + 1 unit 263',
  '& Capsicum Green 226',
  '250 - 275 g + 1 unit 257',
  'Banana Raw 211',
  '2 pcs + 1 unit 228',
  'Amul Taaza Toned Fresh Milk | Pouch 230',
  '1 pack (500 ml) + 1 unit',
  't3 Baby Apple Shimla 2178',
  '500 g + 1 unit 2216',
  '&7 Spinach (Palak) 234',
  '250 g + 1 unit 267',
  '2 Organically Grown Lady Finger 224',
  '250 g + 2 units 264',
  'Ganesh Whole Wheat Chakki Pure Atta | 252',
  'No Maida 256',
  '1 pack (1 kg) + 1 unit',
  'Ovo Farms On-Day White Eggs 253',
  '1 pack (6 pcs) + 1 unit 280',
  'Rate Order Order Again',
].join('\n'));
check('the misread rupee sign is identified', r.glyph, '2');
check('ten items, at the prices actually printed', brief(r), [
  'Bottle Gourd|1|3500|item',
  'Tomato Local|1|2600|item',
  'Capsicum Green|1|2600|item',
  'Banana Raw|1|1100|item',
  'Amul Taaza Toned Fresh Milk Pouch|1|3000|item',
  'Baby Apple Shimla|1|17800|item',
  'Spinach (Palak)|1|3400|item',
  'Organically Grown Lady Finger|1|2400|item',
  'Ganesh Whole Wheat Chakki Pure Atta No Maida|1|5200|item',
  'Ovo Farms On-Day White Eggs|1|5300|item',
]);
check('and the basket adds up to what the receipt says',
  r.rows.reduce((s, x) => s + x.totalPaise, 0), 46900);
console.log('  before: 11 rows, ₹53,727 — including "Order #HGTKKOIU" at ₹49,669');

console.log('\n--- but a receipt that genuinely has no rupee sign is left alone ---');
r = SW.parseReceipt([
  'Brown Bread 45', 'Curd 400 g 38', 'Onion 1 kg 42', 'Tomato 500 g 26',
  'Amul Butter 265',
].join('\n'));
check('no glyph inferred', r.glyph, null);
check('amounts untouched', r.rows.map(x => x.totalPaise), [4500, 3800, 4200, 2600, 26500]);

console.log('\n--- prices sitting beside their struck-out MRP ---');
check('the payable one is the smaller, wherever it sits',
  SW.parseReceipt('Amul Milk 500ml ₹28 ₹32').rows.map(x => x.totalPaise), [2800]);
check('a size row on its own is not an item',
  brief(SW.parseReceipt('Bottle Gourd ₹35\n1 pc • 1 unit ₹99')),
  ['Bottle Gourd|1|3500|item']);
check('but a size row still carries the price of the name above it',
  brief(SW.parseReceipt('Onion\n1 kg ₹42')), ['Onion 1 kg|1|4200|item']);

console.log('\n--- an order number is not an amount ---');
check('welded to letters, so not a price',
  brief(SW.parseReceipt('Order #HGTKKOIU49669\nOnion ₹42')), ['Onion|1|4200|item']);

console.log('\n--- the scenario from the request ---');
// 5 items across 4 people: 2 shared by all, 2 by three of them, 1 by one.
const P = ['p1', 'p2', 'p3', 'p4'];
const rows = [
  { name: 'Onion',    qty: 1, totalPaise: 10000, kind: 'item', who: P },
  { name: 'Butter',   qty: 1, totalPaise: 20000, kind: 'item', who: P },
  { name: 'Paneer',   qty: 1, totalPaise:  9000, kind: 'item', who: ['p1','p2','p3'] },
  { name: 'Curd',     qty: 1, totalPaise:  6000, kind: 'item', who: ['p1','p2','p3'] },
  { name: 'Protein',  qty: 1, totalPaise:  5000, kind: 'item', who: ['p1'] },
  { name: 'Handling', qty: 1, totalPaise:  2000, kind: 'fee' },
];
const split = SW.itemisedSplit(rows, P);
check('item subtotals', split.subtotal, { p1: 17500, p2: 12500, p3: 12500, p4: 7500 });
check('items total',    split.itemsTotal, 50000);
check('fee prorated by order size', {
  p1: split.totals.p1 - split.subtotal.p1,
  p2: split.totals.p2 - split.subtotal.p2,
  p3: split.totals.p3 - split.subtotal.p3,
  p4: split.totals.p4 - split.subtotal.p4,
}, { p1: 700, p2: 500, p3: 500, p4: 300 });
console.log('  p1 ordered 35% of ₹500 and carries ₹7 of the ₹20 fee');
check('totals', split.totals, { p1: 18200, p2: 13000, p3: 13000, p4: 7800 });
check('totals sum to the grand total',
  P.reduce((s, id) => s + split.totals[id], 0), split.grandTotal);
check('grand total', split.grandTotal, 52000);

console.log('\n--- an item nobody is ticked on is left out of the total ---');
const orphan = SW.itemisedSplit(
  [{ name: 'Mystery', qty: 1, totalPaise: 5000, kind: 'item', who: [] }], P);
check('contributes nothing', orphan.grandTotal, 0);

console.log('\n--- the note ---');
const note = SW.itemisedNote(rows, id => ({ p1: 'You', p2: 'Ali', p3: 'Zara', p4: 'Dev' }[id]));
console.log('  ' + note);
check('names every row and its people', note.indexOf('Protein ₹50.00 (You)') > -1, true);
check('marks fees as prorated', note.indexOf('shared by order size') > -1, true);

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
