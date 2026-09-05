// Compares sw.group_member_net() against SW.groupMemberNets() on the real
// ledger, member by member.
//
// Balances are derived on the device by design, and now also in SQL so a
// midnight reminder can say something true. Two implementations of one sum
// will drift; an email that disagrees with the app is worse than no email.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const q = (sql) => {
  fs.writeFileSync('/tmp/sw-net.sql', sql);
  const out = execFileSync('supabase', ['db', 'query', '--linked', '-f', '/tmp/sw-net.sql'],
    { encoding: 'utf8' });
  // Parsed as JSON rather than pattern-matched. These rows contain nested
  // arrays (the payers and splits of each expense), and any non-greedy
  // bracket match stops at the first inner `]`.
  const start = out.indexOf('{');
  if (start === -1) throw new Error('no JSON in the result:\n' + out.slice(0, 500));
  let parsed;
  try {
    parsed = JSON.parse(out.slice(start));
  } catch (err) {
    throw new Error('could not parse the result: ' + err.message +
      '\n' + out.slice(0, 500));
  }
  if (!Array.isArray(parsed.rows)) {
    throw new Error('no rows in the result:\n' + out.slice(0, 500));
  }
  return parsed.rows;
};

// Everything the client needs to compute the same thing itself.
const groups = q("select id, name from public.groups order by created_at");
if (!groups.length) {
  console.log('  no groups on this project — nothing to compare');
  process.exit(0);
}

const expenses = q(`
  select e.id, e.group_id, e.payer_id, e.amount,
    coalesce((select jsonb_agg(jsonb_build_object('user_id', ep.user_id, 'amount', ep.amount))
              from public.expense_payers ep where ep.expense_id = e.id), '[]') as payers,
    coalesce((select jsonb_agg(jsonb_build_object('user_id', es.user_id, 'amount', es.amount))
              from public.expense_splits es where es.expense_id = e.id), '[]') as splits
  from public.expenses e where e.deleted_at is null`);

const settlements = q(`
  select group_id, from_user, to_user, amount from public.settlements
  where deleted_at is null`);

const members = q("select group_id, user_id from public.group_members");

const sqlNets = q(`
  select gm.group_id, gm.user_id,
         round(sw.group_member_net(gm.group_id, gm.user_id), 2)::text as net
  from public.group_members gm`);

// Load the real client engine and give it a ledger in the shape it expects.
global.window = {};
global.window.SW = global.SW = {};
new Function('window', 'SW', fs.readFileSync('js/balances.js', 'utf8'))(global.window, global.SW);

const byGroup = {};
members.forEach((m) => { (byGroup[m.group_id] ||= []).push(m.user_id); });

SW.ledger = {
  me: members[0] ? members[0].user_id : null,
  members: byGroup,
  people: {},
  groups: Object.fromEntries(groups.map((g) => [g.id, g])),
  expenses: expenses.map((e) => ({
    id: e.id, group_id: e.group_id, payer_id: e.payer_id, amount: e.amount,
    expense_payers: e.payers, expense_splits: e.splits,
  })),
  settlements: settlements,
};

let compared = 0, bad = 0;
for (const g of groups) {
  const clientNets = SW.groupMemberNets(g.id).nets;
  for (const row of sqlNets.filter((r) => r.group_id === g.id)) {
    compared++;
    const fromSql = Math.round(Number(row.net) * 100);          // paise
    const fromClient = clientNets[row.user_id] || 0;
    if (fromSql !== fromClient) {
      bad++;
      console.log('  DISAGREE  group ' + JSON.stringify(g.name) +
        ' member ' + row.user_id.slice(0, 8) +
        '\n            sql:    ' + fromSql + ' paise' +
        '\n            client: ' + fromClient + ' paise');
    }
  }
}

console.log('  ' + compared + ' member/group positions compared across ' +
  groups.length + ' group(s) · ' + (bad ? bad + ' DISAGREEMENT(S)' : 'they agree'));

// And the invariant that must hold whatever the numbers are.
for (const g of groups) {
  const nets = sqlNets.filter((r) => r.group_id === g.id)
    .reduce((t, r) => t + Math.round(Number(r.net) * 100), 0);
  if (nets !== 0) {
    bad++;
    console.log('  DOES NOT SUM TO ZERO  ' + JSON.stringify(g.name) + ': ' + nets + ' paise');
  }
}
if (!bad) console.log('  and every group\'s positions sum to zero');

// ---------------------------------------------------------------------------
//  And the whole position, groups and friend-only expenses together
//
//  sw.user_net() exists because summing group positions misses an expense
//  split with a friend outside any group — which reported "square overall"
//  to somebody who owed ₹208. So it is compared against the client's own
//  overall, which sums the same differences edge by edge.
// ---------------------------------------------------------------------------
const people = q(`
  select p.id, p.full_name, round(sw.user_net(p.id), 2)::text as net
  from public.profiles p order by p.full_name`);

let overallBad = 0;
for (const person of people) {
  const others = people.filter((o) => o.id !== person.id).map((o) => o.id);

  // A new object each time, so friendBalances() cannot serve its memo.
  SW.ledger = Object.assign({}, SW.ledger, { me: person.id, friendIds: others });

  const fromClient = SW.overallNet(SW.friendBalances());
  const fromSql = Math.round(Number(person.net) * 100);
  if (fromSql !== fromClient) {
    overallBad++;
    console.log('  DISAGREE  ' + JSON.stringify(person.full_name) +
      '\n            sql:    ' + fromSql + ' paise' +
      '\n            client: ' + fromClient + ' paise');
  }
}
console.log('  ' + people.length + ' overall position(s) compared · ' +
  (overallBad ? overallBad + ' DISAGREEMENT(S)' : 'they agree'));

// Everybody's overall positions must cancel out, for the same reason a
// group's do: every split sums to its expense and every settlement cancels.
const sum = people.reduce((t, p) => t + Math.round(Number(p.net) * 100), 0);
if (sum !== 0) {
  overallBad++;
  console.log('  OVERALL POSITIONS DO NOT SUM TO ZERO: ' + sum + ' paise');
} else {
  console.log('  and they sum to zero across the whole project');
}

process.exit(bad + overallBad ? 1 : 0);
