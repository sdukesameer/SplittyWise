// Run from the repo root:  node tests/groups.test.js
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));

global.window = {};
global.window.SW = global.SW = {};
new Function('window', 'SW', fs.readFileSync('js/balances.js', 'utf8'))(global.window, global.SW);

let fails = 0;
function check(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label + '  got ' + g + (ok ? '' : '  want ' + w));
}

const ME = 'me', A = 'ali', B = 'bina', C = 'chetan';
const G = 'flat';

SW.ledger = {
  me: ME,
  friendIds: [A, B, C],
  people: {},
  groups: { [G]: { id: G, name: 'Flatmates' } },
  members: { [G]: [ME, A, B, C] },
  expenses: [
    // I paid 1200, split four ways at 300 each.
    { id:'x1', group_id:G, payer_id:ME, amount:'1200.00', description:'Gas', emoji:'🔥',
      expense_date:'2026-08-01', created_at:'2026-08-01T00:00:00Z',
      expense_splits:[{user_id:ME,amount:'300.00'},{user_id:A,amount:'300.00'},
                      {user_id:B,amount:'300.00'},{user_id:C,amount:'300.00'}] },
    // Ali paid 800, split four ways at 200 each.
    { id:'x2', group_id:G, payer_id:A, amount:'800.00', description:'Water', emoji:'🚰',
      expense_date:'2026-08-02', created_at:'2026-08-02T00:00:00Z',
      expense_splits:[{user_id:ME,amount:'200.00'},{user_id:A,amount:'200.00'},
                      {user_id:B,amount:'200.00'},{user_id:C,amount:'200.00'}] },
  ],
  settlements: [],
};

console.log('--- member nets inside the group ---');
const g = SW.groupSummary(G);
// I paid 1200, consumed 500 -> owed 700. Ali paid 800, consumed 500 -> owed 300.
// Bina and Chetan paid nothing, consumed 500 each -> owe 500 each.
check('my net (+700)',    g.nets[ME], 70000);
check('Ali net (+300)',   g.nets[A],  30000);
check('Bina net (-500)',  g.nets[B], -50000);
check('Chetan net (-500)',g.nets[C], -50000);
check('nets sum to zero', Object.keys(g.nets).reduce((s,k)=>s+g.nets[k],0), 0);
check('group total',      g.total, 200000);

console.log('\n--- who paid most vs who consumed most ---');
check('I paid the most',      g.paid[ME], 120000);
check('everyone consumed 500', [g.owed[ME], g.owed[A], g.owed[B], g.owed[C]],
                               [50000, 50000, 50000, 50000]);

console.log('\n--- debt simplification ---');
const t = SW.simplifyDebts(g.nets);
check('transfer count (n-1 or fewer)', t.length <= 3, true);
console.log('  plan: ' + t.map(x => x.from + ' -> ' + x.to + ' ' + SW.money(x.amount)).join(', '));
check('every transfer positive', t.every(x => x.amount > 0), true);
// Applying the plan must zero every net.
const after = Object.assign({}, g.nets);
t.forEach(x => { after[x.from] += x.amount; after[x.to] -= x.amount; });
check('plan clears all balances', Object.keys(after).every(k => after[k] === 0), true);

console.log('\n--- simplification beats paying everyone individually ---');
// 4 people all carrying balances: pairwise worst case is 6 transfers.
check('at most 3 transfers for 4 people', t.length, 3);

console.log('\n--- a settlement moves the nets ---');
SW.ledger.settlements.push({ id:'s1', group_id:G, from_user:B, to_user:ME,
  amount:'500.00', note:'', settled_on:'2026-08-03', created_at:'2026-08-03T00:00:00Z' });
const g2 = SW.groupSummary(G);
check('Bina now settled', g2.nets[B], 0);
check('my net drops to +200', g2.nets[ME], 20000);
check('still sums to zero', Object.keys(g2.nets).reduce((s,k)=>s+g2.nets[k],0), 0);

console.log('\n--- edge cases ---');
check('empty group', SW.simplifyDebts({}), []);
check('already settled', SW.simplifyDebts({ a:0, b:0 }), []);
check('one paise', SW.simplifyDebts({ a:1, b:-1 }), [{from:'b',to:'a',amount:1}]);
check('deterministic order',
  JSON.stringify(SW.simplifyDebts({ z:-100, a:-100, m:200 })) ===
  JSON.stringify(SW.simplifyDebts({ a:-100, m:200, z:-100 })), true);

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
