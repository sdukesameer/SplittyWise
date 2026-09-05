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

// The group settings screen now states this in so many words: "If you owe
// Ali ₹5 and Ali owes Bea ₹5, you pay Bea ₹5 and Ali is out of it. Nobody
// ends up better or worse off." A claim printed in the UI belongs under
// test, or the copy and the engine can drift apart.
console.log('\n--- the example the UI promises ---');
{
  const nets = { me: -500, ali: 0, bea: 500 };
  const out = SW.simplifyDebts(nets);
  check('one payment, not two', out.length, 1);
  check('and it goes straight to Bea',
    out[0] && out[0].from + '->' + out[0].to + '@' + out[0].amount, 'me->bea@500');

  const after = Object.assign({}, nets);
  out.forEach(function (t) { after[t.from] += t.amount; after[t.to] -= t.amount; });
  check('nobody ends up better or worse off', after, { me: 0, ali: 0, bea: 0 });

  // Ali is owed nothing and owes nothing, so Ali must not be asked to move
  // money at all — that is the whole point of the shortcut.
  check('Ali is not involved in any transfer',
    out.some(function (t) { return t.from === 'ali' || t.to === 'ali'; }), false);
}


console.log('\n--- who in this group is not a friend yet ---');
// The whole point of the card in group settings: A and B are both in the
// group, so A should be offered B — and only there.
{
  const base = SW.ledger;

  const ledgerWith = (friendIds, members) => Object.assign({}, base, {
    friendIds: friendIds,
    members: Object.assign({}, base.members, { [G]: members }),
  });

  SW.ledger = ledgerWith([A, B, C], [ME, A, B, C]);
  check('nobody to add when everyone is already a friend',
    SW.groupStrangers(G), []);

  SW.ledger = ledgerWith([A], [ME, A, B, C]);
  check('the co-members who are not friends yet',
    SW.groupStrangers(G), [B, C]);

  SW.ledger = ledgerWith([], [ME, A]);
  check('never yourself', SW.groupStrangers(G).indexOf(ME), -1);

  SW.ledger = ledgerWith([], [ME]);
  check('a group of one offers nothing', SW.groupStrangers(G), []);

  // Only ever this group's members. Somebody in another group entirely must
  // not turn up here, or the card would be offering strangers.
  SW.ledger = Object.assign({}, base, {
    friendIds: [],
    members: { [G]: [ME, A], other: [ME, B] },
  });
  check('only people in the group asked about', SW.groupStrangers(G), [A]);
  check('and the other group has its own answer', SW.groupStrangers('other'), [B]);

  check('a group that does not exist is empty, not an error',
    SW.groupStrangers('nope'), []);

  SW.ledger = base;
}

process.exit(fails ? 1 : 0);
