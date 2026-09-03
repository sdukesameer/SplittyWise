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

  // Allocate a total across people in proportion to weights, landing on the
  // total EXACTLY. Used for handling and delivery fees: someone who ordered
  // 15% of the basket carries 15% of the fee. Odd paise go to the largest
  // fractional remainders, then by id so the result is deterministic.
  SW.prorate = function (totalPaise, weights) {
    const ids = Object.keys(weights);
    if (!ids.length) return {};

    const total = Math.max(0, Math.round(totalPaise));
    const sum = ids.reduce(function (s, id) { return s + Math.max(0, weights[id]); }, 0);

    // Nobody has a share to weight against, so fall back to an even split.
    if (sum <= 0) {
      const even = SW.splitEqually(total, ids.length);
      const flat = {};
      ids.forEach(function (id, i) { flat[id] = even[i]; });
      return flat;
    }

    const out = {};
    const remainders = [];
    let allocated = 0;

    ids.forEach(function (id) {
      const exact = total * Math.max(0, weights[id]) / sum;
      const whole = Math.floor(exact);
      out[id] = whole;
      allocated += whole;
      remainders.push({ id: id, frac: exact - whole });
    });

    remainders.sort(function (a, b) {
      return (b.frac - a.frac) || (a.id < b.id ? -1 : 1);
    });

    let left = total - allocated;
    for (let i = 0; i < left; i++) out[remainders[i].id] += 1;

    return out;
  };

  /* ======================= the five split modes ====================== */

  //   equal    split evenly across whoever is ticked
  //   exact    type each person's amount
  //   percent  type each person's share of 100%
  //   shares   weights — 2 nights is 2 shares, a family of 3 is 3 shares
  //   adjust   type who owes extra; the remainder is split evenly
  //
  // state: { included:{}, exact:{}, percent:{}, shares:{}, adjust:{} }
  // Returns { byUser, assigned, valid, message, hint }. byUser always covers
  // every participant, with 0 for anyone left out; the caller drops the zeros
  // when building the payload so nobody appears on an expense owing nothing.
  // Cash groups do not deal in paise. Each share is rounded to a whole
  // rupee and the leftover goes to the payer, so the total still matches to
  // the paise while every figure is payable in notes.
  SW.applyRounding = function (byUser, ids, totalPaise, payerId) {
    let assigned = 0;
    ids.forEach(function (id) {
      byUser[id] = Math.round((byUser[id] || 0) / 100) * 100;
      assigned += byUser[id];
    });

    const drift = totalPaise - assigned;
    if (drift === 0) return byUser;

    // The payer absorbs it, since they are the one out of pocket.
    const absorber = (payerId && byUser[payerId] !== undefined) ? payerId : ids[0];
    byUser[absorber] += drift;
    if (byUser[absorber] < 0) {
      // Rounding cannot be allowed to make somebody owe less than nothing.
      byUser[absorber] = 0;
    }
    return byUser;
  };

  SW.computeSplit = function (mode, amountPaise, ids, state) {
    const byUser = {};
    ids.forEach(function (id) { byUser[id] = 0; });

    const sum = function () {
      return ids.reduce(function (t, id) { return t + byUser[id]; }, 0);
    };
    const done = function (valid, message, hint) {
      // Rounding is applied last, and only to a split that already balances.
      if (valid && state.rounding === 'rupee') {
        SW.applyRounding(byUser, ids, amountPaise, state.payerId);
      }
      return { byUser: byUser, assigned: sum(), valid: valid, message: message, hint: hint };
    };

    if (!ids.length) return done(false, 'Nobody to split between', '');
    if (amountPaise <= 0) return done(false, 'Enter an amount', '');

    /* ---- equally, across the ticked people ---- */
    if (mode === 'equal') {
      const on = ids.filter(function (id) { return state.included[id] !== false; });
      if (!on.length) return done(false, 'Tick at least one person', '');

      const parts = SW.splitEqually(amountPaise, on.length);
      on.forEach(function (id, i) { byUser[id] = parts[i]; });

      return done(true, 'Adds up',
        SW.money(parts[0]) + '/person (' +
        (on.length === ids.length ? on.length + (on.length === 1 ? ' person' : ' people')
                                  : on.length + ' of ' + ids.length) + ')');
    }

    /* ---- exact amounts ---- */
    if (mode === 'exact') {
      ids.forEach(function (id) { byUser[id] = Math.max(0, state.exact[id] || 0); });
      const diff = amountPaise - sum();
      if (diff > 0) return done(false, SW.money(diff) + ' left to assign', '');
      if (diff < 0) return done(false, SW.money(diff) + ' over', '');
      return done(true, 'Adds up', '');
    }

    /* ---- percentages ---- */
    if (mode === 'percent') {
      // Compared in hundredths of a percent so 33.33 + 33.33 + 33.34 works.
      const weights = {};
      let bp = 0;
      ids.forEach(function (id) {
        const v = Math.max(0, Math.round((state.percent[id] || 0) * 100));
        weights[id] = v;
        bp += v;
      });
      if (bp !== 10000) {
        const off = (10000 - bp) / 100;
        return done(false,
          (off > 0 ? off.toFixed(2).replace(/\.00$/, '') + '% left'
                   : Math.abs(off).toFixed(2).replace(/\.00$/, '') + '% over'),
          (bp / 100).toFixed(2).replace(/\.00$/, '') + '% of 100%');
      }
      const alloc = SW.prorate(amountPaise, weights);
      ids.forEach(function (id) { byUser[id] = alloc[id] || 0; });
      return done(true, 'Adds up', '100% of 100%');
    }

    /* ---- shares ---- */
    if (mode === 'shares') {
      const weights = {};
      let total = 0;
      ids.forEach(function (id) {
        const v = Math.max(0, parseInt(state.shares[id], 10) || 0);
        weights[id] = v;
        total += v;
      });
      if (total <= 0) return done(false, 'Give at least one share', '');

      const alloc = SW.prorate(amountPaise, weights);
      ids.forEach(function (id) { byUser[id] = alloc[id] || 0; });
      return done(true, 'Adds up',
        total + (total === 1 ? ' total share' : ' total shares'));
    }

    /* ---- adjustments: extras first, remainder split evenly ---- */
    if (mode === 'adjust') {
      let extra = 0;
      ids.forEach(function (id) { extra += (state.adjust[id] || 0); });

      // The remainder can go negative when the adjustments exceed the total,
      // and splitEqually handles that; what cannot happen is a person ending
      // up owing less than nothing, because expense_splits forbids it.
      const base = SW.splitEqually(amountPaise - extra, ids.length);
      ids.forEach(function (id, i) { byUser[id] = base[i] + (state.adjust[id] || 0); });

      const negative = ids.filter(function (id) { return byUser[id] < 0; });
      if (negative.length) {
        return done(false, 'Those adjustments leave someone owing less than nothing', '');
      }
      return done(true, 'Adds up',
        extra ? SW.money(extra) + ' in adjustments' : 'no adjustments yet');
    }

    return done(false, 'Unknown split mode', '');
  };

  SW.SPLIT_MODES = [
    { key: 'equal',   label: 'Equally',
      blurb: 'Select which people owe an equal share.' },
    { key: 'exact',   label: 'Exact',
      blurb: 'Specify exactly how much each person owes.' },
    { key: 'percent', label: 'Percent',
      blurb: 'Enter the percentage split that is fair for your situation.' },
    { key: 'shares',  label: 'Shares',
      blurb: 'Good for time-based splitting (2 nights is 2 shares) and for families (a family of 3 is 3 shares).' },
    { key: 'adjust',  label: 'Adjust',
      blurb: 'Enter who owes extra; the remainder is split equally.' },
  ];

  /* ======================= categories and budgets ==================== */

  // The built-in names from the emoji picker, plus anything you have added,
  // each with its budget if it has one. Built-ins always appear, so removing
  // a budget never removes the category.
  SW.categoryList = function () {
    const rows = (SW.ledger && SW.ledger.categories) || [];
    const byName = {};
    rows.forEach(function (r) { byName[r.name] = r; });

    const builtIn = (SW.CATEGORIES || []).map(function (name) {
      const row = byName[name];
      return {
        name: name,
        emoji: null,                 // built-ins are identified by their group
        budget: row ? row.budget_paise : null,
        custom: false,
        id: row ? row.id : null,
      };
    });

    const custom = rows.filter(function (r) {
      return r.is_custom && (SW.CATEGORIES || []).indexOf(r.name) === -1;
    }).map(function (r) {
      return { name: r.name, emoji: r.emoji, budget: r.budget_paise,
               custom: true, id: r.id };
    });

    return builtIn.concat(custom);
  };

  // Spend against budget for one month, for the categories that have one.
  // month: 'YYYY-MM', defaulting to the current one.
  SW.budgetStatus = function (month) {
    if (!SW.ledger) return [];
    const key = month || new Date().toISOString().slice(0, 7);
    const spend = {};

    SW.ledger.expenses.forEach(function (e) {
      if (String(e.expense_date).slice(0, 7) !== key) return;
      const mine = SW.myShareOf(e);
      if (mine <= 0) return;
      const cat = SW.categoryOf(e);
      spend[cat] = (spend[cat] || 0) + mine;
    });

    return SW.categoryList()
      .filter(function (c) { return c.budget > 0; })
      .map(function (c) {
        const spent = spend[c.name] || 0;
        return {
          name: c.name,
          emoji: c.emoji,
          budget: c.budget,
          spent: spent,
          left: c.budget - spent,
          // Capped for the bar; `over` carries the truth.
          pct: Math.min(100, Math.round((spent / c.budget) * 100)),
          over: spent > c.budget,
        };
      })
      .sort(function (a, b) { return b.spent / b.budget - a.spent / a.budget; });
  };

  /* ======================= what you enter over and over =============== */

  // Templates built from habit rather than configured by hand: the things
  // you have entered more than once, most-used first, each carrying the
  // shape of the last time you entered it.
  //
  // Only your own entries count — someone else's rent is not your habit.
  SW.frequentExpenses = function (limit) {
    const L = SW.ledger;
    if (!L) return [];
    const me = L.me;
    const groups = {};

    L.expenses.forEach(function (e) {
      if (e.created_by !== me) return;
      if (e.pending) return;
      const key = String(e.description || '').trim().toLowerCase();
      if (!key) return;

      if (!groups[key]) groups[key] = { count: 0, latest: null };
      groups[key].count++;

      const stamp = e.expense_date + (e.created_at || '');
      const best = groups[key].latest;
      if (!best || stamp > (best.expense_date + (best.created_at || ''))) {
        groups[key].latest = e;
      }
    });

    return Object.keys(groups)
      .map(function (k) { return groups[k]; })
      // Once is not a habit. Twice is.
      .filter(function (g) { return g.count >= 2 && g.latest; })
      .sort(function (a, b) {
        return (b.count - a.count) ||
               (b.latest.expense_date < a.latest.expense_date ? -1 : 1);
      })
      .slice(0, limit || 5)
      .map(function (g) {
        const e = g.latest;
        const people = Object.keys(SW.paidMap(e))
          .concat((e.expense_splits || []).map(function (x) { return x.user_id; }));
        return {
          description: e.description,
          amountPaise: SW.toPaise(e.amount),
          emoji: e.emoji || '🧾',
          category: e.category,
          groupId: e.group_id || null,
          splitMode: e.split_mode || 'equal',
          people: people.filter(function (id, i) { return people.indexOf(id) === i; }),
          times: g.count,
        };
      });
  };

  // The set of people a group's expenses usually involve. If groceries in
  // the flat are always three ways excluding Dev, the form should open that
  // way rather than making you untick him every time.
  SW.usualPeopleFor = function (groupId) {
    const L = SW.ledger;
    if (!L) return null;
    const me = L.me;
    const counts = {};
    let total = 0;

    L.expenses.forEach(function (e) {
      if ((e.group_id || null) !== groupId) return;
      if (e.created_by !== me) return;
      const key = (e.expense_splits || [])
        .map(function (sp) { return sp.user_id; })
        .sort()
        .join(',');
      if (!key) return;
      counts[key] = (counts[key] || 0) + 1;
      total++;
    });

    // Below three entries there is no pattern, only coincidence.
    if (total < 3) return null;

    const best = Object.keys(counts).sort(function (a, b) {
      return counts[b] - counts[a] || (a < b ? -1 : 1);
    })[0];

    // And it has to actually be the usual case, not merely the most common.
    if (!best || counts[best] / total < 0.6) return null;
    return best.split(',');
  };

  // Twelve months of my own share with one friend, oldest first, for a
  // sparkline. Whether a balance is growing matters more than today's value.
  SW.friendTrend = function (friendId, months) {
    const L = SW.ledger;
    if (!L) return [];
    const span = months || 12;
    const buckets = [];
    const index = {};
    const now = new Date();

    for (let i = span - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const entry = { key: key, paise: 0 };
      index[key] = entry;
      buckets.push(entry);
    }

    L.expenses.forEach(function (e) {
      const bucket = index[String(e.expense_date).slice(0, 7)];
      if (!bucket) return;
      SW.expenseEdges(e).forEach(function (edge) {
        if (edge.from === friendId && edge.to === L.me) bucket.paise += edge.amount;
        else if (edge.from === L.me && edge.to === friendId) bucket.paise -= edge.amount;
      });
    });

    // A running balance reads better than per-month deltas.
    let running = 0;
    return buckets.map(function (b) {
      running += b.paise;
      return { key: b.key, paise: running };
    });
  };

  /* ======================= amount arithmetic ========================= */

  // "240+80*2" in the amount field. Hand-rolled recursive descent rather
  // than eval: the Content-Security-Policy forbids eval outright, and
  // handing arbitrary input to it for the sake of a calculator would be a
  // poor trade even if it did not.
  //
  // Returns paise, or null if the expression is not something to total.
  SW.evalAmount = function (text) {
    const src = String(text == null ? '' : text).replace(/[₹,\s]/g, '');
    if (!src) return null;
    // Only the characters a sum can be made of.
    if (!/^[0-9.+\-*/()]+$/.test(src)) return null;

    let at = 0;
    const peek = function () { return src[at]; };

    function number() {
      const start = at;
      while (at < src.length && /[0-9.]/.test(src[at])) at++;
      const raw = src.slice(start, at);
      // "1.2.3" is a typo, not a number.
      if (!/^\d*\.?\d*$/.test(raw) || raw === '' || raw === '.') return NaN;
      return parseFloat(raw);
    }

    function factor() {
      if (peek() === '(') {
        at++;
        const inner = expression();
        if (peek() !== ')') return NaN;
        at++;
        return inner;
      }
      if (peek() === '-') { at++; return -factor(); }
      if (peek() === '+') { at++; return factor(); }
      return number();
    }

    function term() {
      let value = factor();
      while (peek() === '*' || peek() === '/') {
        const op = src[at++];
        const rhs = factor();
        if (op === '/' && rhs === 0) return NaN;
        value = op === '*' ? value * rhs : value / rhs;
      }
      return value;
    }

    function expression() {
      let value = term();
      while (peek() === '+' || peek() === '-') {
        const op = src[at++];
        const rhs = term();
        value = op === '+' ? value + rhs : value - rhs;
      }
      return value;
    }

    const result = expression();
    // Trailing rubbish means the whole thing is suspect.
    if (at !== src.length) return null;
    if (!isFinite(result) || result < 0 || result > 5000000) return null;
    return Math.round(result * 100);
  };

  // True when the text is a sum rather than a plain number, so the form can
  // show the total it works out to.
  SW.isExpression = function (text) {
    return /[+\-*/()]/.test(String(text || '').replace(/^\s*-/, ''));
  };

  /* ======================= spoken amounts ============================ */

  const WORD_NUMBERS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
    nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
    sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  const WORD_SCALES = {
    hundred: 100, thousand: 1000, lakh: 100000, lac: 100000, crore: 10000000,
  };

  // "chai forty rupees" -> 4000 paise. Speech comes back as words as often
  // as digits, and "two hundred fifty" has to add rather than concatenate.
  SW.parseSpokenAmount = function (text) {
    const words = String(text || '').toLowerCase()
      .replace(/[^a-z0-9. ]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    let total = 0;      // completed scales
    let current = 0;    // the group being built
    let seen = false;

    for (let i = 0; i < words.length; i++) {
      const w = words[i];

      if (/^\d+(\.\d{1,2})?$/.test(w)) {
        current += parseFloat(w);
        seen = true;
        continue;
      }
      if (WORD_NUMBERS[w] !== undefined) {
        current += WORD_NUMBERS[w];
        seen = true;
        continue;
      }
      if (WORD_SCALES[w] !== undefined) {
        const scale = WORD_SCALES[w];
        // "two hundred" multiplies what is pending; "hundred" alone is 100.
        if (scale === 100) current = (current || 1) * 100;
        else { total += (current || 1) * scale; current = 0; }
        seen = true;
        continue;
      }
      // Anything else ends the number, so "chai forty rupees dinner" does
      // not quietly fold two amounts together.
      if (seen && (total + current) > 0 && /^(rupees?|rs|only)$/.test(w)) break;
    }

    if (!seen) return null;
    const rupees = total + current;
    if (!(rupees > 0) || rupees > 5000000) return null;
    return Math.round(rupees * 100);
  };

  // What is left once the amount and its filler words are taken out — that
  // is the description.
  SW.stripSpokenAmount = function (text) {
    const filler = new RegExp(
      '\\b(' + Object.keys(WORD_NUMBERS).join('|') + '|' +
      Object.keys(WORD_SCALES).join('|') + '|rupees?|rs|only|for|and)\\b', 'gi');

    return String(text || '')
      .replace(/\d+(\.\d{1,2})?/g, ' ')
      .replace(filler, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .replace(/^./, function (c) { return c.toUpperCase(); });
  };

  /* ======================= UPI ======================================== */

  // A virtual payment address: something@bank. Deliberately permissive on the
  // handle, since banks and apps keep inventing new suffixes.
  SW.isUpiId = function (value) {
    return /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9.]{1,63}$/
      .test(String(value || '').trim());
  };

  // The UPI deep link. Opening it hands the phone to GPay, PhonePe, Paytm or
  // whatever else is installed, with payee and amount already filled.
  // Which field has to follow from the others, and what it has to be.
  //
  // ₹300 across three people: fill in 50 and 100 and the third can only be
  // 150. Returns null unless the answer is forced — two blanks could be
  // divided any number of ways, so nothing is guessed, and a total already
  // met or overshot leaves the field alone rather than writing a negative
  // share nobody asked for.
  //
  // `fields` is [{ id, value, filled, auto }]. A field we filled ourselves
  // last time counts as available again, so it keeps tracking the others
  // until the person types in it.
  SW.deriveBlank = function (total, fields) {
    if (!(total > 0) || !fields || fields.length < 2) return null;

    const open = fields.filter(function (x) { return !x.filled || x.auto; });
    if (open.length !== 1) return null;

    const target = open[0];
    const others = fields.filter(function (x) { return x !== target; });
    if (others.some(function (x) { return !x.filled; })) return null;

    const assigned = others.reduce(function (t, x) { return t + (x.value || 0); }, 0);
    const left = Math.round((total - assigned) * 100) / 100;
    if (left <= 0) return null;

    return { id: target.id, value: left };
  };

  // Mirrors sw.ordinal_day() so reminder text reads the same either side.
  SW.ordinalDay = function (d) {
    d = parseInt(d, 10) || 0;
    const suffix = (d % 100 >= 11 && d % 100 <= 13) ? 'th'
      : (d % 10 === 1 ? 'st' : d % 10 === 2 ? 'nd' : d % 10 === 3 ? 'rd' : 'th');
    return d + suffix;
  };

  SW.upiUri = function (opts) {
    // The note field is fussy across apps: keep it short and alphanumeric.
    const note = String(opts.note || '')
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);

    return 'upi://pay' +
      '?pa=' + encodeURIComponent(String(opts.vpa).trim()) +
      '&pn=' + encodeURIComponent(String(opts.name || '').trim()) +
      '&am=' + SW.rupees(opts.amountPaise) +
      '&cu=INR' +
      (note ? '&tn=' + encodeURIComponent(note) : '');
  };

  /* ======================= recurrence ================================= */

  function pad(n) { return String(n).padStart(2, '0'); }

  // Mirrors next_occurrence() in the schema, for showing "next on 1 Oct"
  // without a round trip. Adding a month repeatedly would drift — 31 Jan
  // clamps to 28 Feb and every later month then sticks at the 28th — so the
  // intended day of the month is carried separately.
  SW.nextOccurrence = function (fromIso, cadence, dayOfMonth) {
    const parts = String(fromIso).split('-').map(Number);
    const y = parts[0], m = parts[1], d = parts[2];

    if (cadence === 'weekly') {
      const dt = new Date(Date.UTC(y, m - 1, d + 7));
      return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
    }

    if (cadence === 'yearly') {
      // 29 Feb only exists every fourth year; clamp rather than roll over.
      const daysIn = new Date(Date.UTC(y + 1, m, 0)).getUTCDate();
      return (y + 1) + '-' + pad(m) + '-' + pad(Math.min(d, daysIn));
    }

    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? y + 1 : y;
    const daysIn = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    const want = dayOfMonth || d;
    return ny + '-' + pad(nm) + '-' + pad(Math.min(want, daysIn));
  };

  SW.CADENCES = [
    { key: 'weekly',  label: 'Every week' },
    { key: 'monthly', label: 'Every month' },
    { key: 'yearly',  label: 'Every year' },
  ];

  SW.cadenceLabel = function (key) {
    const found = SW.CADENCES.filter(function (c) { return c.key === key; })[0];
    return found ? found.label : 'Never';
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
    // A photograph beats an emoji, which beats generated art.
    const person = (SW.ledger && (id === SW.ledger.me
      ? (SW.profile || {})
      : (SW.ledger.people[id] || {}))) || {};
    const url = person.avatar_path && SW.avatarUrls[person.avatar_path];
    if (url) {
      return '<span class="avatar"><img src="' + url + '" alt="" ' +
             'loading="lazy" decoding="async"></span>';
    }

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

  // Both balance passes walk every expense, and the screens call them a lot:
  // the group settings page asked for the same group summary six times in one
  // render, and drawing N group rows meant N full passes over the ledger.
  //
  // A memo that relies on every caller remembering to invalidate it is a
  // stale-data bug waiting to happen, so the stamp below is checked on every
  // read: the ledger object itself, its row counts, and a counter for edits
  // that change neither. Any mismatch recomputes.
  let bumps = 0;
  let memoFriends = null;
  let memoGroups = {};

  function stamp() {
    const L = SW.ledger;
    if (!L) return 'none';
    return bumps + ':' + L.expenses.length + ':' + L.settlements.length;
  }

  function fresh(memo) {
    return memo && memo.ledger === SW.ledger && memo.stamp === stamp();
  }

  SW.bumpLedger = function () {
    bumps++;
    memoFriends = null;
    memoGroups = {};
  };

  SW.loadLedger = async function () {
    const db = SW.db;
    const me = SW.user.id;

    const [friendRes, expRes, setRes, grpRes, memRes, catRes, nickRes, presetRes] =
      await Promise.all([
      db.from('friendships').select('user_a, user_b'),
      // Live rows only. Deleted ones live on for thirty days so a mistake
      // can be undone, but they must not touch a balance meanwhile.
      db.from('expenses').select(
        'id, group_id, payer_id, amount, description, emoji, category, split_mode, ' +
        'notes, expense_date, created_at, created_by, ' +
        'expense_splits(user_id, amount), expense_payers(user_id, amount)'
      ).is('deleted_at', null).order('expense_date', { ascending: false }),
      db.from('settlements').select(
        // deleted_at is filtered server-side below, but the client checks it
        // too — and a check on a column that was never selected is always
        // false, which is how four profile features silently reverted once.
        'id, group_id, from_user, to_user, amount, note, settled_on, ' +
        'created_at, deleted_at'
      ).is('deleted_at', null).order('settled_on', { ascending: false }),
      db.from('groups').select(
        'id, name, emoji, group_type, simplify_debts, cover_path, whiteboard, ' +
        'settle_up_day, rounding, created_by'),
      db.from('group_members').select('group_id, user_id, role, default_split_mode'),
      db.from('user_categories')
        .select('id, name, emoji, budget_paise, is_custom, sort_order')
        .order('sort_order', { ascending: true }),
      db.from('nicknames').select('other_id, nickname'),
      db.from('split_presets').select('id, group_id, name, mode, config'),
    ]);

    // Categories are a convenience rather than part of the ledger, so a
    // failure there degrades to the built-in list instead of breaking.
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
      (e.expense_payers || []).forEach(function (s) { involved.add(s.user_id); });
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
        .select('id, full_name, email, avatar_emoji, upi_id, avatar_path')
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
    const myMembership = {};
    memRes.data.forEach(function (m) {
      (membersByGroup[m.group_id] = membersByGroup[m.group_id] || []).push(m.user_id);
      if (m.user_id === me) myMembership[m.group_id] = m;
    });

    SW.ledger = {
      me: me,
      friendIds: friendIds,
      people: peopleById,
      groups: groupsById,
      members: membersByGroup,
      myMembership: myMembership,   // group id -> my own group_members row
      categories: (catRes && !catRes.error && catRes.data) || [],
      nicknames: (function () {
        const out = {};
        if (nickRes && !nickRes.error) {
          (nickRes.data || []).forEach(function (r) { out[r.other_id] = r.nickname; });
        }
        return out;
      })(),
      presets: (presetRes && !presetRes.error && presetRes.data) || [],
      expenses: expRes.data,
      settlements: setRes.data,
    };
    SW.bumpLedger();
    await SW.ensureAvatars({ quiet: true });
    return SW.ledger;
  };

  // Avatars are private objects, so each needs a signed URL. Resolved in one
  // batch and cached, because SW.avatar() is called inside render loops and
  // cannot wait on a request per row.
  //
  // This used to hang off the end of loadLedger, which made a photo's
  // appearance depend on a long chain — cache load, invite redemption,
  // outbox flush, then the fetch — completing, and on whichever view
  // happened to be repainted afterwards. A saved photo would then be there
  // or not depending on timing nobody can see. It is now standalone,
  // idempotent, callable from anywhere, and repaints when it resolves
  // something new.
  SW.avatarUrls = {};

  const SIGNED_FOR = 3600;          // seconds; Supabase's own maximum window
  const RESIGN_WITHIN = 300;        // re-sign when this close to expiry
  const expiry = {};                // path -> epoch ms the URL dies
  let inFlight = null;

  function needsUrl(path) {
    if (!SW.avatarUrls[path]) return true;
    // A URL cached from an hour ago is a broken image, not a cached one.
    return (expiry[path] || 0) - Date.now() < RESIGN_WITHIN * 1000;
  }

  function knownPaths() {
    const paths = [];
    const own = (SW.profile && SW.profile.avatar_path) || null;
    if (own) paths.push(own);

    const L = SW.ledger;
    if (L && L.people) {
      Object.keys(L.people).forEach(function (id) {
        const p = L.people[id];
        if (p && p.avatar_path) paths.push(p.avatar_path);
      });
    }
    return paths.filter(function (path, i) {
      return path && paths.indexOf(path) === i;
    });
  }

  // Resolves any avatar we know about and have no live URL for. Safe to call
  // repeatedly: it de-duplicates concurrent calls and returns how many new
  // URLs it obtained, so the caller knows whether a repaint is worth it.
  async function signMissing() {
    // Recomputed here, inside the serialised section, so a caller that
    // arrived while another was signing does not have its paths dropped —
    // and so nothing is ever signed twice.
    const wanted = knownPaths().filter(needsUrl);
    if (!wanted.length) return 0;

    // createSignedUrls resolves with { data, error } rather than throwing
    // for an API error, so `error` has to be read. Ignoring it was why a
    // failure here left no trace anywhere at all.
    let res;
    try {
      // SW.db, not `db`: the local `db` belongs to loadLedger's scope. Using
      // the bare name here threw "db is not defined" on every call, and the
      // only reason that surfaced at all is that this function reports its
      // own failures.
      res = await SW.db.storage.from('avatars').createSignedUrls(wanted, SIGNED_FOR);
    } catch (err) {
      res = { data: null, error: err };
    }

    if (res.error || !res.data) {
      const msg = (res.error && (res.error.message || res.error)) || 'unknown';
      console.warn('Could not sign avatar URLs:', msg);
      if (SW.reportError) SW.reportError('Avatar signing failed: ' + msg, 'balances.js');
      return 0;
    }

    let got = 0;
    const dies = Date.now() + SIGNED_FOR * 1000;
    res.data.forEach(function (row, i) {
      // `path` is echoed by the API, but falling back to position keeps
      // this working if that ever stops being true.
      const path = (row && row.path) || wanted[i];
      if (row && path && row.signedUrl) {
        SW.avatarUrls[path] = row.signedUrl;
        expiry[path] = dies;
        got++;
      } else if (row && row.error) {
        console.warn('Could not sign', path, '—', row.error);
      }
    });
    return got;
  }

  SW.ensureAvatars = function (opts) {
    // Serialised rather than de-duplicated: calls queue, and each one works
    // out what is still missing when its turn comes.
    const mine = (inFlight || Promise.resolve()).then(signMissing, signMissing);
    inFlight = mine.catch(function () { return 0; });

    return mine.then(function (got) {
      // A photo that arrives after its screen was drawn has to trigger a
      // redraw, or it waits for the next navigation to show up.
      if (got && !(opts && opts.quiet) && SW.repaintAvatars) SW.repaintAvatars();
      return got;
    });
  };

  SW.person = function (id) {
    if (id === SW.ledger.me) {
      const mine = SW.profile || {};
      // avatar_path was missing here, so your own photo never appeared in
      // any list — only your emoji — however well it had uploaded.
      return {
        id: id,
        full_name: 'You',
        email: mine.email || '',
        avatar_emoji: mine.avatar_emoji,
        avatar_path: mine.avatar_path || null,
        upi_id: mine.upi_id || null,
      };
    }
    const found = SW.ledger.people[id];
    if (!found) return { id: id, full_name: 'Someone', email: '', avatar_emoji: '👤' };

    // What you call them wins over what they call themselves, everywhere.
    const nick = (SW.ledger.nicknames || {})[id];
    if (!nick) return found;
    return Object.assign({}, found, { full_name: nick, real_name: found.full_name });
  };

  /* ======================= balance maths ============================== */

  // Who paid what on one expense. Written for every expense since phase 12,
  // but rows created before that have no expense_payers, so the primary
  // payer is treated as having covered the whole thing.
  SW.paidMap = function (e) {
    const paid = {};
    const rows = e.expense_payers || [];
    if (rows.length) {
      rows.forEach(function (r) {
        paid[r.user_id] = (paid[r.user_id] || 0) + SW.toPaise(r.amount);
      });
    } else {
      paid[e.payer_id] = SW.toPaise(e.amount);
    }
    return paid;
  };

  SW.owedMap = function (e) {
    const owed = {};
    (e.expense_splits || []).forEach(function (r) {
      owed[r.user_id] = (owed[r.user_id] || 0) + SW.toPaise(r.amount);
    });
    return owed;
  };

  // The debts one expense creates, as pairwise edges.
  //
  // With a single payer this is trivially "everyone owes the payer their
  // share". With several payers there is no such shortcut: the only honest
  // answer is each person's net for that expense, resolved into the fewest
  // transfers. For one payer the two agree exactly, so this stays one code
  // path rather than a special case.
  SW.expenseEdges = function (e) {
    const paid = SW.paidMap(e);
    const owed = SW.owedMap(e);

    const nets = {};
    Object.keys(paid).forEach(function (id) { nets[id] = 0; });
    Object.keys(owed).forEach(function (id) { nets[id] = 0; });
    Object.keys(nets).forEach(function (id) {
      nets[id] = (paid[id] || 0) - (owed[id] || 0);
    });

    return SW.simplifyDebts(nets);
  };

  // net > 0  → they owe me
  // net < 0  → I owe them
  SW.friendBalances = function () {
    if (fresh(memoFriends)) return memoFriends.value;
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
      SW.expenseEdges(e).forEach(function (edge) {
        // An edge between two other people says nothing about my balance.
        if (edge.to === me) add(edge.from, e.group_id, edge.amount);
        else if (edge.from === me) add(edge.to, e.group_id, -edge.amount);
      });
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

    memoFriends = { ledger: SW.ledger, stamp: stamp(), value: nets };
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
      const pm = SW.paidMap(e);
      const om = SW.owedMap(e);
      Object.keys(pm).forEach(function (id) { bump(paid, id, pm[id]); });
      Object.keys(om).forEach(function (id) { bump(owed, id, om[id]); });
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
    const key = groupId === null ? '__none' : groupId;
    if (fresh(memoGroups[key])) return memoGroups[key].value;

    const L = SW.ledger;
    const { nets, paid, owed } = SW.groupMemberNets(groupId);

    let total = 0;
    L.expenses.forEach(function (e) {
      if ((e.group_id || null) === groupId) total += SW.toPaise(e.amount);
    });

    const value = {
      groupId: groupId,
      myNet: nets[L.me] || 0,
      nets: nets,
      paid: paid,
      owed: owed,
      total: total,
      memberIds: Object.keys(nets),
    };
    memoGroups[key] = { ledger: SW.ledger, stamp: stamp(), value: value };
    return value;
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
  // The newest live payment in one scope — a pair, optionally within one
  // group. Mirrors undo_settlement() in the schema, which is the authority:
  // only this one may be undone, because undoing an older payment would
  // leave newer ones explaining a balance that no longer exists.
  SW.undoableSettlement = function (opts) {
    const L = SW.ledger;
    if (!L) return null;
    const me = L.me;
    const other = opts && opts.friendId;
    const gid = (opts && opts.groupId) || null;
    const scoped = opts && Object.prototype.hasOwnProperty.call(opts, 'groupId');

    const live = L.settlements.filter(function (s) {
      if (s.deleted_at) return false;
      if (scoped && (s.group_id || null) !== gid) return false;
      if (other) {
        const between = (s.from_user === me && s.to_user === other) ||
                        (s.from_user === other && s.to_user === me);
        if (!between) return false;
      } else if (s.from_user !== me && s.to_user !== me) {
        return false;
      }
      return true;
    });
    if (!live.length) return null;

    live.sort(function (a, b) {
      const ka = a.settled_on + 'T' + (a.created_at || '');
      const kb = b.settled_on + 'T' + (b.created_at || '');
      return ka < kb ? 1 : (ka > kb ? -1 : 0);
    });
    return live[0];
  };

  // Every payment touching one group, for the group's own timeline. The
  // group page used to list expenses only, so squaring up left no trace on
  // the screen where the group's balance is read.
  SW.groupSettlements = function (gid) {
    const L = SW.ledger;
    const me = L.me;

    return L.settlements
      .filter(function (s) {
        return !s.deleted_at && (s.group_id || null) === gid;
      })
      .map(function (s) {
        const paise = SW.toPaise(s.amount);
        const mine = s.from_user === me || s.to_user === me;
        return {
          kind: 'settlement',
          id: s.id,
          date: s.settled_on,
          sortKey: s.settled_on + 'T' + (s.created_at || ''),
          emoji: '✅',
          note: s.note || '',
          fromUser: s.from_user,
          toUser: s.to_user,
          amount: paise,
          // What it did to *my* balance in this group; zero when the payment
          // was between two other members, which still belongs on the
          // timeline but must not move my figures.
          delta: !mine ? 0 : (s.from_user === me ? paise : -paise),
        };
      });
  };

  SW.pairLedger = function (friendId) {
    const L = SW.ledger;
    const me = L.me;
    const items = [];

    L.expenses.forEach(function (e) {
      // Whatever this expense settled between the two of us specifically.
      let delta = 0;
      SW.expenseEdges(e).forEach(function (edge) {
        if (edge.from === friendId && edge.to === me) delta += edge.amount;
        else if (edge.from === me && edge.to === friendId) delta -= edge.amount;
      });
      if (delta === 0) return;

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
        payerCount: Object.keys(SW.paidMap(e)).length,
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

  /* ======================= insights ================================== */

  // What I personally spent: my own share of every expense, which is the
  // only figure that means anything for "where does my money go". The
  // expense total would count other people's shares as mine.
  SW.myShareOf = function (expense) {
    const mine = (expense.expense_splits || []).find(function (s) {
      return s.user_id === SW.ledger.me;
    });
    return mine ? SW.toPaise(mine.amount) : 0;
  };

  // Everyone an expense touches, payers included.
  function peopleOn(e) {
    return Object.keys(SW.paidMap(e))
      .concat((e.expense_splits || []).map(function (s) { return s.user_id; }));
  }

  // opts: { groupId } one group (null for the non-group bucket),
  //       { withFriend } only expenses the two of us are both on,
  //       { month } 'YYYY-MM' to narrow to one month.
  SW.inScope = function (e, opts) {
    if (opts.groupId !== undefined && (e.group_id || null) !== opts.groupId) return false;
    if (opts.month && String(e.expense_date).slice(0, 7) !== opts.month) return false;
    if (opts.withFriend) {
      const people = peopleOn(e);
      if (people.indexOf(opts.withFriend) === -1) return false;
      if (people.indexOf(SW.ledger.me) === -1) return false;
    }
    return true;
  };

  SW.spendByCategory = function (opts) {
    opts = opts || {};
    const totals = {};
    SW.ledger.expenses.forEach(function (e) {
      if (!SW.inScope(e, opts)) return;
      const mine = SW.myShareOf(e);
      if (mine <= 0) return;
      const cat = SW.categoryOf(e);
      totals[cat] = (totals[cat] || 0) + mine;
    });

    return Object.keys(totals)
      .map(function (k) { return { label: k, paise: totals[k] }; })
      .sort(function (a, b) { return b.paise - a.paise; });
  };

  // The last `months` calendar months, oldest first, including empty ones so
  // the bars show gaps rather than silently compressing time.
  SW.spendByMonth = function (opts) {
    opts = opts || {};
    const months = opts.months || 6;
    const buckets = [];
    const index = {};
    const now = new Date();

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const entry = {
        key: key,
        label: d.toLocaleDateString('en-IN', { month: 'short' }),
        year: d.getFullYear(),
        paise: 0,
      };
      index[key] = entry;
      buckets.push(entry);
    }

    // The month filter is deliberately ignored here: the bars are how you
    // move between months, so narrowing them to one would leave one bar.
    const scope = Object.assign({}, opts);
    delete scope.month;

    SW.ledger.expenses.forEach(function (e) {
      if (!SW.inScope(e, scope)) return;
      const key = String(e.expense_date).slice(0, 7);
      if (!index[key]) return;
      index[key].paise += SW.myShareOf(e);
    });

    return buckets;
  };

  // What was spent in scope, and how much of it was mine. The percentage is
  // the figure the reference app calls "% of total group spending".
  SW.periodTotals = function (opts) {
    opts = opts || {};
    let total = 0;
    let mine = 0;
    let count = 0;

    SW.ledger.expenses.forEach(function (e) {
      if (!SW.inScope(e, opts)) return;
      total += SW.toPaise(e.amount);
      mine += SW.myShareOf(e);
      count++;
    });

    return {
      total: total,
      mine: mine,
      count: count,
      pct: total ? Math.round((mine / total) * 1000) / 10 : null,
    };
  };

  // Months that actually have something in them, newest first, for the
  // period navigator.
  SW.monthsWithSpending = function (opts) {
    const seen = {};
    SW.ledger.expenses.forEach(function (e) {
      if (!SW.inScope(e, Object.assign({}, opts, { month: null }))) return;
      seen[String(e.expense_date).slice(0, 7)] = true;
    });
    return Object.keys(seen).sort().reverse();
  };

  /* ======================= search ===================================== */

  // Matches description, category, the people involved, the group name, and
  // the amount. "ali" finds what you split with Ali; "420" finds ₹420.
  SW.searchExpenses = function (query) {
    const q = String(query || '').trim().toLowerCase();
    if (q.length < 2) return [];

    const digits = q.replace(/[^0-9.]/g, '');
    const asPaise = digits ? SW.toPaise(digits) : null;

    return SW.ledger.expenses.filter(function (e) {
      if (String(e.description || '').toLowerCase().indexOf(q) > -1) return true;
      if (SW.categoryOf(e).toLowerCase().indexOf(q) > -1) return true;
      if (String(e.notes || '').toLowerCase().indexOf(q) > -1) return true;

      const group = e.group_id ? SW.ledger.groups[e.group_id] : null;
      if (group && group.name.toLowerCase().indexOf(q) > -1) return true;

      const people = [e.payer_id].concat(
        (e.expense_splits || []).map(function (s) { return s.user_id; }));
      for (let i = 0; i < people.length; i++) {
        const p = SW.ledger.people[people[i]];
        if (p && String(p.full_name).toLowerCase().indexOf(q) > -1) return true;
      }

      // An amount query matches the total or anybody's share.
      if (asPaise) {
        if (SW.toPaise(e.amount) === asPaise) return true;
        const hit = (e.expense_splits || []).some(function (s) {
          return SW.toPaise(s.amount) === asPaise;
        });
        if (hit) return true;
      }
      return false;
    }).sort(function (a, b) {
      return (a.expense_date + (a.created_at || '')) < (b.expense_date + (b.created_at || '')) ? 1 : -1;
    });
  };

  /* ======================= CSV export ================================ */

  function csvCell(value) {
    const text = value == null ? '' : String(value);
    // Quote anything that could break a cell, and double any inner quotes.
    // A leading =, +, - or @ is prefixed so a spreadsheet treats it as text
    // rather than a formula.
    // A plain number must stay a number, or Excel imports every negative
    // amount as text. Only genuinely formula-shaped cells get neutralised.
    const isNumber = /^-?\d+(\.\d+)?$/.test(text);
    const risky = (!isNumber && /^[=+@\t\r-]/.test(text)) ? "'" + text : text;
    return /[",\n\r]/.test(risky) ? '"' + risky.replace(/"/g, '""') + '"' : risky;
  }

  SW.buildCsv = function (opts) {
    opts = opts || {};
    const L = SW.ledger;
    const header = ['Date', 'Description', 'Category', 'Group', 'Paid by',
                    'Total (INR)', 'Your share (INR)', 'Your net (INR)', 'Note'];
    const lines = [header.map(csvCell).join(',')];

    L.expenses.filter(function (e) {
      return SW.inScope(e, opts);
    }).sort(function (a, b) {
      return a.expense_date < b.expense_date ? -1 : 1;
    }).forEach(function (e) {
      const total = SW.toPaise(e.amount);
      const mine = SW.myShareOf(e);
      // Net is what this row did to my balance: lent if I paid, owed if not.
      const net = e.payer_id === L.me ? total - mine : -mine;
      const group = e.group_id ? (L.groups[e.group_id] || {}).name : '';

      lines.push([
        e.expense_date,
        e.description,
        SW.categoryOf(e),
        group || 'Non-group',
        e.payer_id === L.me ? 'You' : (L.people[e.payer_id] || {}).full_name || 'Someone',
        SW.rupees(total),
        SW.rupees(mine),
        (net < 0 ? '-' : '') + SW.rupees(net),
        e.notes || '',
      ].map(csvCell).join(','));
    });

    L.settlements.filter(function (st) {
      if (opts.groupId !== undefined && (st.group_id || null) !== opts.groupId) return false;
      if (opts.withFriend) {
        if (st.from_user !== opts.withFriend && st.to_user !== opts.withFriend) return false;
      }
      if (opts.month && String(st.settled_on).slice(0, 7) !== opts.month) return false;
      return true;
    }).sort(function (a, b) {
      return a.settled_on < b.settled_on ? -1 : 1;
    }).forEach(function (st) {
      const paise = SW.toPaise(st.amount);
      const iPaid = st.from_user === L.me;
      const other = iPaid ? st.to_user : st.from_user;
      const name = (L.people[other] || {}).full_name || 'Someone';

      lines.push([
        st.settled_on,
        iPaid ? 'Payment to ' + name : 'Payment from ' + name,
        'Settlement',
        st.group_id ? (L.groups[st.group_id] || {}).name : 'Non-group',
        iPaid ? 'You' : name,
        SW.rupees(paise),
        '0.00',
        (iPaid ? '' : '-') + SW.rupees(paise),
        st.note || '',
      ].map(csvCell).join(','));
    });

    // A BOM so Excel opens the ₹ and any Indian names as UTF-8.
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  };

  /* ======================= settled history =========================== */

  // Walking a two-person ledger oldest-first, the balance returns to zero
  // every time they square up. Everything at or before the LAST such point
  // is finished business and can be folded away.
  //
  // `items` arrive newest-first. Returns how many of the newest to show, and
  // marks the entries that brought the balance back to zero.
  SW.settledCutoff = function (items) {
    const oldestFirst = items.slice().reverse();
    let running = 0;
    let lastZero = -1;

    oldestFirst.forEach(function (it, i) {
      running += it.delta;
      it.clearsBalance = false;
      if (running === 0) { lastZero = i; it.clearsBalance = true; }
    });

    // Never balanced, so nothing is settled history.
    if (lastZero < 0) return items.length;
    return items.length - (lastZero + 1);
  };

  // My side of one expense, for a group feed.
  SW.myDeltaOn = function (e) {
    const me = SW.ledger.me;
    let delta = 0;
    SW.expenseEdges(e).forEach(function (edge) {
      if (edge.to === me) delta += edge.amount;
      else if (edge.from === me) delta -= edge.amount;
    });
    return delta;
  };

  // Groups the two of us are both in.
  SW.sharedGroups = function (friendId) {
    const L = SW.ledger;
    const nets = SW.friendBalances();
    const mine = (nets[friendId] || { byGroup: {} }).byGroup;

    return Object.keys(L.groups).filter(function (gid) {
      const m = L.members[gid] || [];
      return m.indexOf(L.me) > -1 && m.indexOf(friendId) > -1;
    }).map(function (gid) {
      return { id: gid, group: L.groups[gid], net: mine[gid] || 0 };
    }).sort(function (a, b) {
      return Math.abs(b.net) - Math.abs(a.net) || a.group.name.localeCompare(b.group.name);
    });
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
