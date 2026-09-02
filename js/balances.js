// ---------------------------------------------------------------------------
//  Money, avatars, and the balance engine
//
//  Balances are never stored. They are derived from expenses minus
//  settlements on every load, so a row can always be corrected without a
//  stored total drifting out of sync with the rows it summarises.
//
//  All arithmetic happens in integer paise. Doing it in rupees with floats
//  makes ₹0.01 appear out of nowhere after a few dozen splits.
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  /* ======================= money ====================================== */

  const inr = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  // Postgres numeric arrives as a string, which is exactly what we want —
  // parsing it as a float first would already have lost precision.
  SW.toPaise = function (value) {
    if (value == null) return 0;
    const s = String(value).trim();
    const neg = s.startsWith('-');
    const [whole, frac = ''] = s.replace(/^-/, '').split('.');
    const paise = parseInt(whole || '0', 10) * 100 +
                  parseInt((frac + '00').slice(0, 2), 10);
    return neg ? -paise : paise;
  };

  SW.money = function (paise) {
    return '₹' + inr.format(Math.abs(paise) / 100);
  };

  SW.rupees = function (paise) {
    return (Math.abs(paise) / 100).toFixed(2);
  };

  /* ======================= splitting ================================== */

  // Divide a total across n people so the parts sum to the total EXACTLY.
  // ₹1000 across 3 is 333.34 + 333.33 + 333.33, never 3 × 333.33 = ₹999.99.
  // The odd paise go to the earliest participants (largest-remainder).
  SW.splitEqually = function (totalPaise, n) {
    if (n <= 0) return [];
    const sign = totalPaise < 0 ? -1 : 1;
    const total = Math.abs(totalPaise);
    const base = Math.floor(total / n);
    let remainder = total - base * n;

    const parts = [];
    for (let i = 0; i < n; i++) {
      const extra = remainder > 0 ? 1 : 0;
      if (remainder > 0) remainder--;
      parts.push(sign * (base + extra));
    }
    return parts;
  };

  SW.splitEquallyAmong = function (totalPaise, ids) {
    const parts = SW.splitEqually(totalPaise, ids.length);
    const out = {};
    ids.forEach(function (id, i) { out[id] = parts[i]; });
    return out;
  };

  // Paise -> the JSON shape create_expense() expects.
  SW.splitsPayload = function (byUser) {
    return Object.keys(byUser).map(function (id) {
      return { user_id: id, amount: SW.rupees(byUser[id]) };
    });
  };

  /* ======================= generated avatars ========================== */

  // Deterministic abstract art from a user id, in the spirit of the
  // reference app's avatars but drawn from scratch.
  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }

  SW.avatar = function (id, emoji) {
    // A chosen emoji always wins over generated art.
    if (emoji && emoji !== '🙂') {
      return '<span class="avatar" style="background:var(--surface-2)">' + emoji + '</span>';
    }

    const h = hashString(String(id || 'x'));
    const hue = h % 360;
    const hue2 = (hue + 35 + (h >> 5) % 90) % 360;
    const variant = (h >> 3) % 4;
    const rot = (h >> 7) % 360;

    const base = 'hsl(' + hue + ' 58% 32%)';
    const mid = 'hsl(' + hue2 + ' 66% 52%)';
    const top = 'hsl(' + hue2 + ' 78% 72%)';

    const shapes = [
      '<path d="M0 26 L44 6 L44 44 L0 44 Z" fill="' + mid + '"/>' +
      '<path d="M0 36 L44 20 L44 44 L0 44 Z" fill="' + top + '" opacity=".62"/>',

      '<path d="M22 0 A22 22 0 0 1 40 34 Z" fill="' + mid + '"/>' +
      '<circle cx="14" cy="30" r="11" fill="' + top + '" opacity=".55"/>',

      '<path d="M44 12 L0 32 L0 0 L44 0 Z" fill="' + mid + '"/>' +
      '<path d="M44 2 L10 0 L44 0 Z" fill="' + top + '" opacity=".7"/>',

      '<rect x="0" y="18" width="44" height="26" fill="' + mid + '"/>' +
      '<path d="M0 18 L22 4 L44 18 Z" fill="' + top + '" opacity=".6"/>',
    ];

    // A span, not a div: these render inside <button class="list-row">, whose
    // content model only admits phrasing content.
    return '<span class="avatar">' +
      '<svg viewBox="0 0 44 44" aria-hidden="true">' +
        '<circle cx="22" cy="22" r="22" fill="' + base + '"/>' +
        '<g transform="rotate(' + rot + ' 22 22)">' + shapes[variant] + '</g>' +
      '</svg></span>';
  };

  /* ======================= ledger ===================================== */

  // Everything the balance maths needs, fetched once per refresh.
  SW.ledger = null;

  SW.loadLedger = async function () {
    const db = SW.db;
    const me = SW.user.id;

    const [friendRes, expRes, setRes, grpRes, memRes] = await Promise.all([
      db.from('friendships').select('user_a, user_b'),
      db.from('expenses').select(
        'id, group_id, payer_id, amount, description, emoji, category, ' +
        'expense_date, created_at, expense_splits(user_id, amount)'
      ).order('expense_date', { ascending: false }),
      db.from('settlements').select(
        'id, group_id, from_user, to_user, amount, note, settled_on, created_at'
      ).order('settled_on', { ascending: false }),
      db.from('groups').select('id, name, emoji, simplify_debts'),
      db.from('group_members').select('group_id, user_id'),
    ]);

    const firstError = friendRes.error || expRes.error || setRes.error ||
                       grpRes.error || memRes.error;
    if (firstError) throw firstError;

    // Friend ids, from whichever side of the pair I am on.
    const friendIds = friendRes.data.map(function (f) {
      return f.user_a === me ? f.user_b : f.user_a;
    });

    // Anyone appearing in the ledger needs a name, not just my friends —
    // a group can contain someone I have not befriended directly.
    const involved = new Set(friendIds);
    expRes.data.forEach(function (e) {
      involved.add(e.payer_id);
      (e.expense_splits || []).forEach(function (s) { involved.add(s.user_id); });
    });
    setRes.data.forEach(function (s) {
      involved.add(s.from_user);
      involved.add(s.to_user);
    });
    memRes.data.forEach(function (m) { involved.add(m.user_id); });
    involved.delete(me);

    let profiles = [];
    if (involved.size) {
      const profRes = await db
        .from('profiles')
        .select('id, full_name, email, avatar_emoji')
        .in('id', Array.from(involved));
      // A profile we are not permitted to read is not fatal; it shows as
      // "Someone" rather than breaking the whole screen.
      if (!profRes.error) profiles = profRes.data;
    }

    const peopleById = {};
    profiles.forEach(function (p) { peopleById[p.id] = p; });

    const groupsById = {};
    grpRes.data.forEach(function (g) { groupsById[g.id] = g; });

    // group id -> member ids, which is what a group expense splits across.
    const membersByGroup = {};
    memRes.data.forEach(function (m) {
      (membersByGroup[m.group_id] = membersByGroup[m.group_id] || []).push(m.user_id);
    });

    SW.ledger = {
      me: me,
      friendIds: friendIds,
      people: peopleById,
      groups: groupsById,
      members: membersByGroup,
      expenses: expRes.data,
      settlements: setRes.data,
    };
    return SW.ledger;
  };

  SW.person = function (id) {
    if (id === SW.ledger.me) {
      return { id: id, full_name: 'You', email: '', avatar_emoji: (SW.profile || {}).avatar_emoji };
    }
    return SW.ledger.people[id] ||
           { id: id, full_name: 'Someone', email: '', avatar_emoji: '👤' };
  };

  /* ======================= balance maths ============================== */

  // net > 0  → they owe me
  // net < 0  → I owe them
  //
  // Within one expense every non-payer participant owes the payer their own
  // split. That yields the pairwise edges directly, which is what the
  // friends list needs — the payer's own split is not a debt to anyone.
  SW.friendBalances = function () {
    const L = SW.ledger;
    const me = L.me;
    const nets = {};   // friendId -> { net, byGroup: { gid|'none': paise } }

    function bucket(friendId) {
      if (!nets[friendId]) nets[friendId] = { net: 0, byGroup: {} };
      return nets[friendId];
    }

    function add(friendId, groupId, paise) {
      const b = bucket(friendId);
      const key = groupId || 'none';
      b.net += paise;
      b.byGroup[key] = (b.byGroup[key] || 0) + paise;
    }

    L.expenses.forEach(function (e) {
      const splits = e.expense_splits || [];

      if (e.payer_id === me) {
        // I paid, so everyone else's split is owed to me.
        splits.forEach(function (s) {
          if (s.user_id === me) return;
          add(s.user_id, e.group_id, SW.toPaise(s.amount));
        });
      } else {
        // Someone else paid; only my own split is a debt, and only to them.
        const mine = splits.find(function (s) { return s.user_id === me; });
        if (mine) add(e.payer_id, e.group_id, -SW.toPaise(mine.amount));
      }
    });

    L.settlements.forEach(function (s) {
      const paise = SW.toPaise(s.amount);
      if (s.from_user === me) {
        // I paid them, which cancels that much of what I owed.
        add(s.to_user, s.group_id, paise);
      } else if (s.to_user === me) {
        // They paid me, cancelling that much of what they owed.
        add(s.from_user, s.group_id, -paise);
      }
    });

    // Every friend appears, including those at zero, so the list can show
    // them greyed as settled rather than dropping them silently.
    L.friendIds.forEach(function (id) { bucket(id); });

    // Drop group buckets that netted to zero — they carry no information.
    Object.keys(nets).forEach(function (id) {
      const b = nets[id];
      Object.keys(b.byGroup).forEach(function (g) {
        if (b.byGroup[g] === 0) delete b.byGroup[g];
      });
    });

    return nets;
  };

  SW.overallNet = function (nets) {
    return Object.keys(nets).reduce(function (sum, id) {
      return sum + nets[id].net;
    }, 0);
  };

  /* ======================= group maths =============================== */

  // Each member's position inside one group, from the group's point of view:
  //   net > 0  -> the member is owed this much (they overpaid)
  //   net < 0  -> the member owes this much
  // The nets always sum to zero, because every expense's splits sum to its
  // total and every settlement cancels itself out.
  //
  // Pass null for the non-group bucket.
  SW.groupMemberNets = function (groupId) {
    const L = SW.ledger;
    const paid = {};
    const owed = {};

    function bump(map, id, paise) { map[id] = (map[id] || 0) + paise; }

    L.expenses.forEach(function (e) {
      if ((e.group_id || null) !== groupId) return;
      bump(paid, e.payer_id, SW.toPaise(e.amount));
      (e.expense_splits || []).forEach(function (sp) {
        bump(owed, sp.user_id, SW.toPaise(sp.amount));
      });
    });

    L.settlements.forEach(function (st) {
      if ((st.group_id || null) !== groupId) return;
      const paise = SW.toPaise(st.amount);
      // Paying someone back behaves like having paid that much more.
      bump(paid, st.from_user, paise);
      bump(owed, st.to_user, paise);
    });

    const nets = {};
    Object.keys(paid).forEach(function (id) { nets[id] = 0; });
    Object.keys(owed).forEach(function (id) { nets[id] = 0; });
    // Anyone in the group counts, even with no activity yet.
    (L.members[groupId] || []).forEach(function (id) { nets[id] = 0; });

    Object.keys(nets).forEach(function (id) {
      nets[id] = (paid[id] || 0) - (owed[id] || 0);
    });

    return { nets: nets, paid: paid, owed: owed };
  };

  // My own position in a group, and the total spent in it.
  SW.groupSummary = function (groupId) {
    const L = SW.ledger;
    const { nets, paid, owed } = SW.groupMemberNets(groupId);

    let total = 0;
    L.expenses.forEach(function (e) {
      if ((e.group_id || null) === groupId) total += SW.toPaise(e.amount);
    });

    return {
      groupId: groupId,
      myNet: nets[L.me] || 0,
      nets: nets,
      paid: paid,
      owed: owed,
      total: total,
      memberIds: Object.keys(nets),
    };
  };

  // Every group I am in, plus the pseudo-group for non-group expenses.
  SW.groupList = function () {
    const L = SW.ledger;
    const out = Object.keys(L.groups).map(function (gid) {
      return { id: gid, group: L.groups[gid], summary: SW.groupSummary(gid) };
    });

    const loose = SW.groupSummary(null);
    if (loose.total !== 0 || loose.myNet !== 0) {
      out.push({
        id: null,
        group: { id: null, name: 'Non-group expenses', emoji: '🧾' },
        summary: loose,
      });
    }
    return out;
  };

  /* ======================= debt simplification ======================== */

  // Turn a set of member nets into the fewest payments that clear them all.
  // Repeatedly send the largest debtor's money to the largest creditor: with
  // n people carrying a balance this settles in at most n-1 transfers,
  // against up to n(n-1)/2 if everyone pays everyone individually.
  SW.simplifyDebts = function (nets) {
    const creditors = [];
    const debtors = [];

    Object.keys(nets).forEach(function (id) {
      const v = nets[id];
      if (v > 0) creditors.push({ id: id, amt: v });
      else if (v < 0) debtors.push({ id: id, amt: -v });
    });

    // Sort by size, then id, so the result is stable rather than depending
    // on object key order.
    const bySize = function (a, b) { return b.amt - a.amt || (a.id < b.id ? -1 : 1); };
    creditors.sort(bySize);
    debtors.sort(bySize);

    const transfers = [];
    let i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      const pay = Math.min(debtors[i].amt, creditors[j].amt);
      if (pay > 0) {
        transfers.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
      }
      debtors[i].amt -= pay;
      creditors[j].amt -= pay;
      if (debtors[i].amt === 0) i++;
      if (creditors[j].amt === 0) j++;
    }
    return transfers;
  };

  // What I owe / am owed inside a group, member by member, without netting.
  SW.myGroupPairs = function (groupId) {
    const all = SW.friendBalances();
    const out = [];
    Object.keys(all).forEach(function (id) {
      const v = all[id].byGroup[groupId === null ? 'none' : groupId];
      if (v) out.push({ id: id, amount: v });
    });
    out.sort(function (a, b) { return Math.abs(b.amount) - Math.abs(a.amount); });
    return out;
  };

  /* ======================= one friend's ledger ======================== */

  // Every line item between me and one friend, newest first.
  SW.pairLedger = function (friendId) {
    const L = SW.ledger;
    const me = L.me;
    const items = [];

    L.expenses.forEach(function (e) {
      const splits = e.expense_splits || [];
      let delta = 0;

      if (e.payer_id === me) {
        const theirs = splits.find(function (s) { return s.user_id === friendId; });
        if (!theirs) return;
        delta = SW.toPaise(theirs.amount);          // they owe me their share
      } else if (e.payer_id === friendId) {
        const mine = splits.find(function (s) { return s.user_id === me; });
        if (!mine) return;
        delta = -SW.toPaise(mine.amount);           // I owe them my share
      } else {
        return; // neither of us paid: nothing between the two of us
      }

      items.push({
        kind: 'expense',
        id: e.id,
        date: e.expense_date,
        sortKey: e.expense_date + 'T' + (e.created_at || ''),
        emoji: e.emoji || '🧾',
        title: e.description,
        groupId: e.group_id,
        total: SW.toPaise(e.amount),
        payerId: e.payer_id,
        delta: delta,
      });
    });

    L.settlements.forEach(function (s) {
      const between = (s.from_user === me && s.to_user === friendId) ||
                      (s.from_user === friendId && s.to_user === me);
      if (!between) return;

      const paise = SW.toPaise(s.amount);
      items.push({
        kind: 'settlement',
        id: s.id,
        date: s.settled_on,
        sortKey: s.settled_on + 'T' + (s.created_at || ''),
        emoji: '✅',
        title: s.from_user === me ? 'You paid them' : 'They paid you',
        note: s.note || '',
        groupId: s.group_id,
        delta: s.from_user === me ? paise : -paise,
      });
    });

    items.sort(function (a, b) { return a.sortKey < b.sortKey ? 1 : -1; });
    return items;
  };

  /* ======================= dates ====================================== */

  SW.formatDate = function (iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };

  SW.monthLabel = function (iso) {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  };
})();
