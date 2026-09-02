// Run from the repo root:  node tests/balances.test.js
//
// Exercises the balance engine against a synthetic ledger. Worth having as a
// test rather than a manual check, because the failure mode of this code is
// silently wrong money rather than a crash.
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
// balances.js assigns window.SW then uses a bare `SW`, which in a browser is
// the same global. Mirror that here.
global.window = {};
global.window.SW = global.SW = {};
new Function('window', 'SW', fs.readFileSync('js/balances.js', 'utf8'))(global.window, global.SW);

const ME = 'me', SHRI = 'shri', ASHU = 'ashu', DIVYAM = 'divyam', YASH = 'yash';
const G1 = 'g-grocery', G2 = 'g-flat';

SW.profile = { avatar_emoji: '🦊' };
SW.ledger = {
  me: ME,
  friendIds: [SHRI, ASHU, DIVYAM],
  people: {
    shri:   { id: SHRI,   full_name: 'Shriyansh',    avatar_emoji: '🙂' },
    ashu:   { id: ASHU,   full_name: 'Ashutosh',     avatar_emoji: '🙂' },
    divyam: { id: DIVYAM, full_name: 'Divyam Kumar', avatar_emoji: '🙂' },
    yash:   { id: YASH,   full_name: 'Yash',         avatar_emoji: '🙂' },
  },
  groups: { [G1]: { id: G1, name: 'Grocery & Utilities' }, [G2]: { id: G2, name: 'Flatmates' } },
  expenses: [
    // I paid; Shriyansh owes his share in a group.
    { id:'e1', group_id:G1, payer_id:ME, amount:'1923.00', description:'Big grocery run',
      emoji:'🛒', expense_date:'2026-08-20', created_at:'2026-08-20T10:00:00Z',
      expense_splits:[{user_id:ME,amount:'961.50'},{user_id:SHRI,amount:'961.50'}] },

    // I paid; Shriyansh owes his share outside any group.
    { id:'e2', group_id:null, payer_id:ME, amount:'396.00', description:'Auto fare',
      emoji:'🛺', expense_date:'2026-08-25', created_at:'2026-08-25T09:00:00Z',
      expense_splits:[{user_id:ME,amount:'198.00'},{user_id:SHRI,amount:'198.00'}] },

    // Ashutosh paid; I owe my share.
    { id:'e3', group_id:null, payer_id:ASHU, amount:'318.00', description:'Lunch',
      emoji:'🍜', expense_date:'2026-08-28', created_at:'2026-08-28T13:00:00Z',
      expense_splits:[{user_id:ME,amount:'159.00'},{user_id:ASHU,amount:'159.00'}] },

    // Divyam paid; cleared by a settlement below.
    { id:'e4', group_id:G2, payer_id:DIVYAM, amount:'1000.00', description:'Internet bill',
      emoji:'🌐', expense_date:'2026-07-05', created_at:'2026-07-05T08:00:00Z',
      expense_splits:[{user_id:ME,amount:'500.00'},{user_id:DIVYAM,amount:'500.00'}] },

    // A three-way expense I paid: my own split must NOT count as a debt.
    { id:'e5', group_id:G2, payer_id:ME, amount:'1200.00', description:'Gas cylinder',
      emoji:'🔥', expense_date:'2026-08-30', created_at:'2026-08-30T18:00:00Z',
      expense_splits:[{user_id:ME,amount:'400.00'},{user_id:ASHU,amount:'400.00'},
                      {user_id:DIVYAM,amount:'400.00'}] },

    // A group expense between two OTHER people. Must not touch my balance.
    { id:'e6', group_id:G2, payer_id:ASHU, amount:'600.00', description:'Cleaner',
      emoji:'🧹', expense_date:'2026-08-31', created_at:'2026-08-31T11:00:00Z',
      expense_splits:[{user_id:ASHU,amount:'300.00'},{user_id:YASH,amount:'300.00'}] },
  ],
  settlements: [
    // I paid Divyam back for the internet bill.
    { id:'s1', group_id:G2, from_user:ME, to_user:DIVYAM, amount:'500.00',
      note:'UPI', settled_on:'2026-07-10', created_at:'2026-07-10T12:00:00Z' },
    // Divyam paid me back for the gas cylinder.
    { id:'s2', group_id:G2, from_user:DIVYAM, to_user:ME, amount:'400.00',
      note:'cash', settled_on:'2026-09-01', created_at:'2026-09-01T12:00:00Z' },
  ],
};

const nets = SW.friendBalances();
let fails = 0;
function check(label, got, want) {
  const ok = got === want;
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label +
    '  got ' + got + (ok ? '' : '  want ' + want));
}

console.log('--- net balances (paise; + = they owe me) ---');
check('Shriyansh net',            nets[SHRI].net,   115950);
check('  ..in Grocery group',     nets[SHRI].byGroup[G1], 96150);
check('  ..non-group',            nets[SHRI].byGroup['none'], 19800);
check('Ashutosh net',             nets[ASHU].net,   -15900 + 40000);
check('Divyam net (all cleared)', nets[DIVYAM].net, 0);
check('Yash absent (not friend)', nets[YASH] === undefined, true);

console.log('\n--- payer own-split exclusion ---');
// e5: I paid 1200, my own split 400. Only Ashutosh + Divyam owe me 400 each.
check('e5 gave Ashutosh +400',    nets[ASHU].byGroup[G2], 40000);
check('e5+s2 gave Divyam 0',      nets[DIVYAM].byGroup[G2], 0 === 0 ? undefined : 0);

console.log('\n--- overall ---');
const total = SW.overallNet(nets);
check('overall net', total, 115950 + 24100 + 0);
console.log('  formatted: ' + SW.money(total));

console.log('\n--- one friend\'s ledger (Shriyansh) ---');
const led = SW.pairLedger(SHRI);
check('line count', led.length, 2);
check('newest first', led[0].id, 'e2');
check('e2 delta (+198)', led[0].delta, 19800);
check('e1 delta (+961.50)', led[1].delta, 96150);

console.log('\n--- Divyam\'s ledger includes both settlements ---');
const dled = SW.pairLedger(DIVYAM);
check('line count', dled.length, 4);
check('sums to zero', dled.reduce((s, i) => s + i.delta, 0), 0);

console.log('\n--- expense between two other people is invisible to me ---');
check('e6 not in Ashutosh ledger',
  SW.pairLedger(ASHU).some(i => i.id === 'e6'), false);

console.log('\n--- formatting (Indian grouping) ---');
check('₹1,000.50', SW.money(100050), '₹1,000.50');
check('₹1,00,000.00', SW.money(10000000), '₹1,00,000.00');
check('₹0.01', SW.money(1), '₹0.01');
check('negative shown absolute', SW.money(-15900), '₹159.00');

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
