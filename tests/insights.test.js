// Run from the repo root:  node tests/insights.test.js
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

global.window = {};
global.window.SW = global.SW = {};
for (const f of ['js/balances.js', 'js/emoji.js']) {
  new Function('window', 'SW', fs.readFileSync(f, 'utf8'))(global.window, global.SW);
}

let fails = 0;
function check(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + (ok ? '' : '\n         got  ' + g + '\n         want ' + w));
}

console.log('--- every emoji belongs to exactly one category ---');
const seen = {}; const dupes = [];
SW.EMOJI_GROUPS.forEach(g => g.items.forEach(e => {
  if (seen[e]) dupes.push(e + ' (' + seen[e] + ' & ' + g.label + ')');
  seen[e] = g.label;
}));
check('no emoji in two groups', dupes, []);
console.log('  ' + SW.CATEGORIES.length + ' categories, ' + Object.keys(seen).length + ' emoji');

console.log('\n--- the guesser and the categories agree ---');
check('chai is Food & drink', SW.guessCategory('chai'), 'Food & drink');
check('grocery is Groceries',  SW.guessCategory('big grocery run'), 'Groceries');
check('petrol is Travel',      SW.guessCategory('petrol'), 'Travel');
check('rent is Home & bills',  SW.guessCategory('rent'), 'Home & bills');
check('movie is Life & fun',   SW.guessCategory('PVR movie'), 'Life & fun');
check('unknown falls to Home & bills via 🧾', SW.guessCategory('xyzzy'), 'Home & bills');

const ME = 'me', A = 'ali';
const G = 'flat';
const thisMonth = new Date();
const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-05';
const monthsAgo = (n) => iso(new Date(thisMonth.getFullYear(), thisMonth.getMonth() - n, 5));

SW.ledger = {
  me: ME,
  friendIds: [A],
  people: { ali: { id: A, full_name: 'Ali Khan' } },
  groups: { [G]: { id: G, name: 'Flatmates' } },
  members: { [G]: [ME, A] },
  expenses: [
    { id:'e1', group_id:G, payer_id:ME, amount:'1000.00', description:'Big grocery run',
      emoji:'🛒', category:'Groceries', notes:null, expense_date:monthsAgo(0),
      created_at:'2026-09-01T00:00:00Z',
      expense_splits:[{user_id:ME,amount:'600.00'},{user_id:A,amount:'400.00'}] },
    { id:'e2', group_id:null, payer_id:A, amount:'200.00', description:'Morning chai',
      emoji:'☕', category:'Food & drink', notes:null, expense_date:monthsAgo(0),
      created_at:'2026-09-02T00:00:00Z',
      expense_splits:[{user_id:ME,amount:'100.00'},{user_id:A,amount:'100.00'}] },
    { id:'e3', group_id:G, payer_id:ME, amount:'500.00', description:'Petrol',
      emoji:'⛽', category:'Travel', notes:'full tank', expense_date:monthsAgo(1),
      created_at:'2026-08-10T00:00:00Z',
      expense_splits:[{user_id:ME,amount:'500.00'}] },
    // Legacy row with no category — must fall back to its emoji.
    { id:'e4', group_id:null, payer_id:ME, amount:'300.00', description:'Old one',
      emoji:'🎬', category:'general', notes:null, expense_date:monthsAgo(1),
      created_at:'2026-08-11T00:00:00Z',
      expense_splits:[{user_id:ME,amount:'150.00'},{user_id:A,amount:'150.00'}] },
  ],
  settlements: [
    { id:'s1', group_id:G, from_user:ME, to_user:A, amount:'250.00', note:'UPI',
      settled_on:monthsAgo(0), created_at:'2026-09-03T00:00:00Z' },
  ],
};

console.log('\n--- my share, not the whole expense ---');
check('e1 total 1000, my share 600', SW.myShareOf(SW.ledger.expenses[0]), 60000);
check('e3 all mine', SW.myShareOf(SW.ledger.expenses[2]), 50000);

console.log('\n--- spend by category uses my share ---');
check('categories, biggest first', SW.spendByCategory(),
  [{label:'Groceries',paise:60000},{label:'Travel',paise:50000},
   {label:'Life & fun',paise:15000},{label:'Food & drink',paise:10000}]);
check('legacy row categorised by emoji', SW.categoryOf(SW.ledger.expenses[3]), 'Life & fun');
check('scoped to one group', SW.spendByCategory({ groupId: G }),
  [{label:'Groceries',paise:60000},{label:'Travel',paise:50000}]);
check('scoped to non-group', SW.spendByCategory({ groupId: null }),
  [{label:'Life & fun',paise:15000},{label:'Food & drink',paise:10000}]);

console.log('\n--- spend by month keeps empty months ---');
const months = SW.spendByMonth({ months: 6 });
check('six buckets', months.length, 6);
check('oldest first', months[0].paise, 0);
check('this month = 600 + 100', months[5].paise, 70000);
check('last month = 500 + 150', months[4].paise, 65000);

console.log('\n--- search ---');
check('by description', SW.searchExpenses('chai').map(e => e.id), ['e2']);
check('by person',      SW.searchExpenses('ali').map(e => e.id).sort(), ['e1','e2','e4']);
check('by group',       SW.searchExpenses('flatmates').map(e => e.id).sort(), ['e1','e3']);
check('by category',    SW.searchExpenses('travel').map(e => e.id), ['e3']);
check('by note',        SW.searchExpenses('full tank').map(e => e.id), ['e3']);
check('by total',       SW.searchExpenses('500').map(e => e.id), ['e3']);
check('by someone\'s share', SW.searchExpenses('400').map(e => e.id), ['e1']);
check('too short is ignored', SW.searchExpenses('a'), []);
check('no match', SW.searchExpenses('zzzz'), []);
const ordered = SW.searchExpenses('ali');
check('newest first', ordered.map(e => e.expense_date)[0] >= ordered.map(e => e.expense_date)[1], true);

console.log('\n--- CSV ---');
const csv = SW.buildCsv();
const rows = csv.replace(/^﻿/, '').trim().split('\r\n');
check('header + 4 expenses + 1 settlement', rows.length, 6);
check('starts with a BOM so Excel reads UTF-8', csv.charCodeAt(0), 0xFEFF);
check('CRLF line endings', csv.indexOf('\r\n') > -1, true);
console.log('  ' + rows[0]);
console.log('  ' + rows[1]);
const groceryRow = rows.find(r => r.indexOf('Big grocery run') > -1);
check('my net when I paid (1000 - 600)', groceryRow.split(',')[7], '400.00');
check('rows are date-ordered, oldest first', rows[1].indexOf('Petrol') > -1, true);
const chaiRow = rows.find(r => r.indexOf('Morning chai') > -1);
check('my net when they paid', chaiRow.split(',')[7], '-100.00');
check('settlement present', rows.some(r => r.indexOf('Payment to Ali Khan') > -1), true);

console.log('\n--- CSV injection is neutralised ---');
SW.ledger.expenses.push({
  id:'bad', group_id:null, payer_id:ME, amount:'1.00',
  description:'=cmd|calc', emoji:'🧾', category:'general',
  notes:'has "quotes", a comma and\na newline', expense_date:monthsAgo(0),
  created_at:'2026-09-09T00:00:00Z',
  expense_splits:[{user_id:ME,amount:'1.00'}],
});
const csv2 = SW.buildCsv();
check('formula prefixed with an apostrophe', csv2.indexOf("'=cmd|calc") > -1, true);
check('negative amounts stay numeric, not text', csv2.indexOf("'-") === -1, true);
check('inner quotes doubled', csv2.indexOf('""quotes""') > -1, true);
check('embedded newline is quoted, not a new row',
  csv2.replace(/^﻿/, '').trim().split('\r\n').length, 7);

console.log('\n--- categories of your own, and monthly caps ---');
// Reset to a known month so the budget maths is deterministic.
const nowMonth = new Date().toISOString().slice(0, 7);
SW.ledger.categories = [
  { id: 'c1', name: 'Groceries', emoji: null, budget_paise: 50000, is_custom: false, sort_order: 0 },
  { id: 'c2', name: 'Cigarettes', emoji: '🚬', budget_paise: 20000, is_custom: true, sort_order: 1 },
  { id: 'c3', name: 'Travel', emoji: null, budget_paise: null, is_custom: false, sort_order: 2 },
];
SW.ledger.expenses = [
  { id: 'b1', group_id: null, payer_id: ME, amount: '600.00', description: 'Big shop',
    emoji: '🛒', category: 'Groceries', notes: null,
    expense_date: nowMonth + '-04', created_at: 'a',
    expense_splits: [{ user_id: ME, amount: '600.00' }] },
  { id: 'b2', group_id: null, payer_id: ME, amount: '250.00', description: 'Smokes',
    emoji: '🏷️', category: 'Cigarettes', notes: null,
    expense_date: nowMonth + '-06', created_at: 'b',
    expense_splits: [{ user_id: ME, amount: '250.00' }] },
  // Last month: must not count against this month's cap.
  { id: 'b3', group_id: null, payer_id: ME, amount: '900.00', description: 'Old shop',
    emoji: '🛒', category: 'Groceries', notes: null,
    expense_date: '2020-01-04', created_at: 'c',
    expense_splits: [{ user_id: ME, amount: '900.00' }] },
];

check('a category of your own resolves', SW.categoryOf(SW.ledger.expenses[1]), 'Cigarettes');
check('built-ins plus your own', SW.categoryList().map(c => c.name),
  ['Groceries', 'Food & drink', 'Home & bills', 'Travel', 'Life & fun', 'Other', 'Cigarettes']);
check('a cap is attached to its category',
  SW.categoryList().filter(c => c.name === 'Groceries')[0].budget, 50000);

const status = SW.budgetStatus();
check('only capped categories appear', status.map(s => s.name), ['Cigarettes', 'Groceries']);
check('over budget is flagged', status[0].over, true);
check('by how much', status[0].left, -5000);
check('and the bar is capped at 100', status[0].pct, 100);
check('within budget', [status[1].spent, status[1].left, status[1].over],
  [60000, -10000, true]);
// Sorted by how much of the cap is used, so the overspent one leads —
// assert by name rather than by position.
const byName = {};
SW.budgetStatus('2020-01').forEach(s => { byName[s.name] = s.spent; });
check('another month counts only its own expenses', byName,
  { Groceries: 90000, Cigarettes: 0 });
check('worst overspend is listed first',
  SW.budgetStatus('2020-01')[0].name, 'Groceries');

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
