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

  /* ======================= the insights view ========================= */

  function renderInsights() {
    if (!SW.ledger) return;

    const cats = SW.spendByCategory();
    const months = SW.spendByMonth({ months: 6 });
    const empty = document.getElementById('ins-empty');

    const anySpend = cats.length > 0;
    empty.hidden = anySpend;
    ['ins-donut', 'ins-bars'].forEach(function (id) {
      document.getElementById(id).parentElement.hidden = !anySpend;
    });
    document.querySelector('[data-view="insights"] .stat-row').hidden = !anySpend;
    document.getElementById('ins-csv').parentElement.hidden = !anySpend;
    if (!anySpend) return;

    const thisMonth = months[months.length - 1].paise;
    const withData = months.filter(function (m) { return m.paise > 0; });
    const avg = withData.length
      ? Math.round(months.reduce(function (s, m) { return s + m.paise; }, 0) / months.length)
      : 0;

    document.getElementById('ins-month').textContent = SW.money(thisMonth);
    document.getElementById('ins-avg').textContent = SW.money(avg);

    const prev = months[months.length - 2];
    document.getElementById('ins-month-note').textContent = prev && prev.paise
      ? (thisMonth >= prev.paise ? '↑ ' : '↓ ') +
        SW.money(Math.abs(thisMonth - prev.paise)) + ' vs last month'
      : 'first month with spending';

    document.getElementById('ins-donut').innerHTML = donutHtml(cats);
    document.getElementById('ins-bars').innerHTML = barsHtml(months);
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
    const cats = SW.spendByCategory({ groupId: groupId });
    const months = SW.spendByMonth({ groupId: groupId, months: 6 });
    document.getElementById('grp-donut').innerHTML = donutHtml(cats);
    document.getElementById('grp-bars').innerHTML = barsHtml(months);
  };

  /* ======================= CSV export ================================ */

  document.getElementById('ins-csv').addEventListener('click', function () {
    if (!SW.ledger) return;

    const csv = SW.buildCsv();
    const stamp = new Date().toISOString().slice(0, 10);
    const name = 'splittywise-' + stamp + '.csv';

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
      SW.toast(rows + ' rows exported', 'ok');
    } catch (err) {
      SW.toast('Could not build the file: ' + (err.message || err), 'error');
    }
  });
})();
