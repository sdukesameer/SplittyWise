// ---------------------------------------------------------------------------
//  Insights — spending charts and CSV export
//
//  The charts are hand-drawn SVG rather than a charting library: the app is
//  meant to work offline once installed, and a CDN-loaded library would be
//  the one thing that breaks with no signal. Inline SVG also takes its
//  colours straight from the theme tokens.
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const esc = SW.escapeHtml;

  // Category index decides colour, so a category keeps the same colour
  // between the doughnut, its legend, and the group charts.
  function colourFor(label) {
    const i = SW.CATEGORIES.indexOf(label);
    return 'var(--cat-' + ((i < 0 ? 5 : i % 6) + 1) + ')';
  }

  /* ======================= doughnut ================================== */

  function donutHtml(slices) {
    const total = slices.reduce(function (s, x) { return s + x.paise; }, 0);
    if (!total) {
      return '<p style="color:var(--muted);font-size:14px">Nothing recorded yet.</p>';
    }

    const R = 52, C = 66, W = 20;
    const circ = 2 * Math.PI * R;
    let offset = 0;

    const arcs = slices.map(function (s) {
      const len = (s.paise / total) * circ;
      const arc = '<circle cx="' + C + '" cy="' + C + '" r="' + R + '" fill="none" ' +
        'style="stroke:' + colourFor(s.label) + '" stroke-width="' + W + '" ' +
        'stroke-dasharray="' + len.toFixed(2) + ' ' + (circ - len).toFixed(2) + '" ' +
        'stroke-dashoffset="' + (-offset).toFixed(2) + '" ' +
        'transform="rotate(-90 ' + C + ' ' + C + ')"></circle>';
      offset += len;
      return arc;
    }).join('');

    // viewBox is 132 wide against an outer radius of 62, so nothing clips.
    const svg = '<svg class="donut" viewBox="0 0 132 132" role="img" ' +
      'aria-label="Spending by category, total ' + SW.money(total) + '">' +
      '<circle cx="' + C + '" cy="' + C + '" r="' + R + '" fill="none" ' +
        'style="stroke:var(--surface-3)" stroke-width="' + W + '"></circle>' +
      arcs +
      '<text class="donut-centre-value" x="' + C + '" y="' + (C + 1) +
        '" text-anchor="middle">' + SW.money(total) + '</text>' +
      '<text class="donut-centre-label" x="' + C + '" y="' + (C + 14) +
        '" text-anchor="middle">TOTAL</text>' +
      '</svg>';

    const legend = '<div class="legend">' + slices.map(function (s) {
      const pct = Math.round((s.paise / total) * 100);
      return '<div class="legend-row">' +
        '<span class="legend-dot" style="background:' + colourFor(s.label) + '"></span>' +
        '<span class="legend-name">' + esc(s.label) + '</span>' +
        '<span class="legend-pct">' + pct + '%</span>' +
        '<span class="legend-val">' + SW.money(s.paise) + '</span>' +
      '</div>';
    }).join('') + '</div>';

    return '<div class="donut-wrap">' + svg + legend + '</div>';
  }

  /* ======================= monthly bars ============================== */

  function niceCeiling(paise) {
    if (paise <= 0) return 10000;
    const rupees = paise / 100;
    const mag = Math.pow(10, Math.floor(Math.log10(rupees)));
    return Math.ceil(rupees / mag) * mag * 100;
  }

  function barsHtml(buckets) {
    const W = 320, H = 168;
    const padL = 30, padR = 8, padT = 20, padB = 26;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const peak = Math.max.apply(null, buckets.map(function (b) { return b.paise; }).concat([0]));
    if (peak <= 0) {
      return '<p style="color:var(--muted);font-size:14px">No spending in the last six months.</p>';
    }
    const top = niceCeiling(peak);

    const slot = plotW / buckets.length;
    const barW = Math.min(34, slot * 0.56);
    const y = function (p) { return padT + plotH - (p / top) * plotH; };

    // Two gridlines only: the ceiling and its midpoint. Every label names a
    // value the chart actually reaches.
    const grid = [top, top / 2, 0].map(function (v) {
      return '<line class="grid-line" x1="' + padL + '" y1="' + y(v).toFixed(1) +
             '" x2="' + (W - padR) + '" y2="' + y(v).toFixed(1) + '"></line>' +
             '<text class="tick-label" x="' + (padL - 5) + '" y="' + (y(v) + 3.5).toFixed(1) +
             '" text-anchor="end">' + (v === 0 ? '0' : shortMoney(v)) + '</text>';
    }).join('');

    const bars = buckets.map(function (b, i) {
      const cx = padL + slot * i + slot / 2;
      const h = Math.max(b.paise > 0 ? 2 : 0, (b.paise / top) * plotH);
      const isNow = i === buckets.length - 1;

      return (h > 0
        ? '<rect class="' + (isNow ? 'bar-now' : 'bar') + '" x="' + (cx - barW / 2).toFixed(1) +
          '" y="' + (padT + plotH - h).toFixed(1) + '" width="' + barW.toFixed(1) +
          '" height="' + h.toFixed(1) + '" rx="3"></rect>'
        : '') +
        (b.paise > 0
          ? '<text class="value-label" x="' + cx.toFixed(1) + '" y="' +
            (padT + plotH - h - 5).toFixed(1) + '" text-anchor="middle">' +
            shortMoney(b.paise) + '</text>'
          : '') +
        '<text class="month-label" x="' + cx.toFixed(1) + '" y="' + (H - 8) +
          '" text-anchor="middle">' + esc(b.label) + '</text>';
    }).join('');

    return '<svg class="bars" viewBox="0 0 ' + W + ' ' + H + '" role="img" ' +
      'aria-label="Spending per month, peaking at ' + SW.money(peak) + '">' +
      grid + bars + '</svg>';
  }

  // ₹1,240 -> "1.2k", so axis and value labels never collide.
  function shortMoney(paise) {
    const r = paise / 100;
    if (r >= 100000) return '₹' + (r / 100000).toFixed(1).replace(/\.0$/, '') + 'L';
    if (r >= 1000) return '₹' + (r / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return '₹' + Math.round(r);
  }

  /* ======================= a reusable chart block ==================== */

  // Renders a period navigator, the headline totals, a category doughnut and
  // the monthly bars into one container. Used by the Insights page, a group's
  // Charts pane and a friend's charts, so all three behave identically.
  //
  // Period state lives on the element, so two blocks on screen cannot fight
  // over one shared variable.
  SW.renderChartBlock = function (host, scope, opts) {
    opts = opts || {};
    if (!SW.ledger) return;

    const months = SW.monthsWithSpending(scope);
    if (host._period === undefined) host._period = null;   // null means all time
    if (host._period && months.indexOf(host._period) === -1) host._period = null;

    const period = host._period;
    const at = period ? months.indexOf(period) : -1;

    const scoped = Object.assign({}, scope, { month: period });
    const totals = SW.periodTotals(scoped);
    const cats = SW.spendByCategory(scoped);
    const bars = SW.spendByMonth(Object.assign({}, scope, { months: 6 }));

    host.innerHTML =
      '<div class="period-bar">' +
        '<button type="button" class="pb-all' + (period ? '' : ' is-on') + '" ' +
                'data-period="all">All time</button>' +
        '<span class="pb-spacer"></span>' +
        '<button type="button" class="pb-nav" data-step="1" ' +
                (at + 1 >= months.length ? 'disabled' : '') + ' ' +
                'aria-label="Earlier">&lsaquo;</button>' +
        '<span class="pb-label">' +
          (period ? esc(SW.monthLabel(period + '-01')) : 'All time') + '</span>' +
        '<button type="button" class="pb-nav" data-step="-1" ' +
                (!period || at <= 0 ? 'disabled' : '') + ' ' +
                'aria-label="Later">&rsaquo;</button>' +
      '</div>' +

      '<div class="stat-row">' +
        '<div class="stat">' +
          '<div class="s-label">' + (opts.totalLabel || 'Total spent') + '</div>' +
          '<div class="s-value">' + SW.money(totals.total) + '</div>' +
          '<div class="s-note">' + totals.count +
            (totals.count === 1 ? ' expense' : ' expenses') + '</div>' +
        '</div>' +
        '<div class="stat">' +
          '<div class="s-label">Your share</div>' +
          '<div class="s-value">' + SW.money(totals.mine) + '</div>' +
          '<div class="s-note">' +
            (totals.pct === null ? 'nothing recorded'
              : totals.pct + '% of ' + (opts.ofLabel || 'the total')) + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="chart-card">' +
        '<h3>Where it goes</h3>' +
        '<div class="ch-sub">Your share by category' +
          (period ? ' in ' + esc(SW.monthLabel(period + '-01')) : ', all time') + '</div>' +
        donutHtml(cats) +
      '</div>' +

      '<div class="chart-card">' +
        '<h3>Month by month</h3>' +
        '<div class="ch-sub">Your share, last six months</div>' +
        barsHtml(bars) +
      '</div>';

    host.querySelector('.period-bar').addEventListener('click', function (e) {
      const all = e.target.closest('[data-period]');
      if (all) {
        host._period = null;
        return SW.renderChartBlock(host, scope, opts);
      }
      const nav = e.target.closest('[data-step]');
      if (!nav || nav.disabled) return;

      const step = parseInt(nav.getAttribute('data-step'), 10);
      // months is newest-first, so stepping "earlier" moves forward in it.
      const from = host._period ? months.indexOf(host._period) : -1;
      const next = from + step;
      host._period = (next < 0 || next >= months.length) ? null : months[next];
      SW.renderChartBlock(host, scope, opts);
    });
  };

  /* ======================= the insights view ========================= */

  function renderInsights() {
    if (!SW.ledger) return;
    const empty = document.getElementById('ins-empty');
    const host = document.getElementById('ins-charts');

    const any = SW.ledger.expenses.some(function (e) { return SW.myShareOf(e) > 0; });
    empty.hidden = any;
    host.hidden = !any;
    document.getElementById('ins-csv').parentElement.hidden = !any;
    if (!any) return;

    SW.renderChartBlock(host, {}, { ofLabel: 'everything recorded' });

    // Caps come first: what is left this month matters more than what has
    // already gone.
    const status = SW.budgetStatus();
    const budgets = document.getElementById('ins-budgets');
    if (!status.length) { budgets.innerHTML = ''; return; }

    const over = status.filter(function (s) { return s.over; });
    budgets.innerHTML =
      '<div class="budget-card">' +
        '<h3>Budgets this month</h3>' +
        '<div class="bc-sub">' +
          (over.length
            ? '<span style="color:var(--owe);font-weight:800">' + over.length +
              (over.length === 1 ? ' category over' : ' categories over') + '</span>'
            : 'All within budget') +
        '</div>' +
        status.map(function (s) {
          return '<div class="budget-line">' +
            '<div class="bl-top">' +
              '<span class="bl-name">' + esc(s.name) + '</span>' +
              '<span class="bl-num' + (s.over ? ' is-over' : '') + '">' +
                (s.over ? SW.money(-s.left) + ' over' : SW.money(s.left) + ' left') +
              '</span>' +
            '</div>' +
            '<div class="budget-track' +
              (s.over ? ' is-over' : (s.pct >= 80 ? ' is-close' : '')) + '">' +
              '<span style="width:' + s.pct + '%"></span></div>' +
          '</div>';
        }).join('') +
      '</div>';
  }

  SW.viewHooks.insights = renderInsights;

  document.getElementById('ins-back').addEventListener('click', function () {
    SW.navigate('account');
  });
  document.getElementById('row-insights').addEventListener('click', function () {
    SW.navigate('insights');
  });

  /* ======================= group charts pane ========================= */

  SW.renderGroupCharts = function (groupId) {
    const host = document.getElementById('grp-charts');
    if (!host) return;
    SW.renderChartBlock(host, { groupId: groupId }, {
      totalLabel: 'Group spending',
      ofLabel: 'total group spending',
    });
  };

  // A friend's charts, scoped to expenses the two of you are both on.
  SW.openFriendCharts = function (friendId) {
    const p = SW.person(friendId);
    SW.sheet({
      title: 'Charts with ' + p.full_name.split(' ')[0],
      rawBody: '<div id="fr-charts"></div>',
      confirm: null,
      cancel: 'Close',
      onOpen: function () {
        SW.renderChartBlock(document.getElementById('fr-charts'),
          { withFriend: friendId },
          { totalLabel: 'Spent together', ofLabel: 'what you spent together' });
      },
    });
  };

  /* ======================= CSV export ================================ */

  SW.exportCsv = function (scope, label) {
    if (!SW.ledger) return;

    const csv = SW.buildCsv(scope || {});
    const stamp = new Date().toISOString().slice(0, 10);
    const name = 'splittywise-' + (label ? label + '-' : '') + stamp + '.csv';

    try {
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);

      const rows = csv.split('\r\n').length - 2;
      if (rows <= 0) return SW.toast('Nothing to export', 'error');
      SW.toast(rows + ' rows exported', 'ok');
    } catch (err) {
      SW.toast('Could not build the file: ' + (err.message || err), 'error');
    }
  };

  document.getElementById('ins-csv').addEventListener('click', function () {
    SW.exportCsv({}, null);
  });
})();
