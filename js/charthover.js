// ---------------------------------------------------------------------------
//  Reading a value off a chart
//
//  The charts here are hand-drawn SVG with no library, so hovering needs
//  wiring by hand too. Shared by the app's insights charts and the admin
//  console's, which is why it is its own file: both pages load it.
//
//  The pattern is the same everywhere. A chart draws an invisible hit area
//  per data point carrying data-hover="<index>", and passes an array of
//  descriptions in the same order. This positions a tooltip over whichever
//  one the pointer is on.
//
//  Pointer events rather than mouse events, so a tap on a phone works — and
//  on a touch screen the tooltip stays until the next tap somewhere else,
//  because there is no hovering away from something with a finger.
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  const esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  // host   an element containing exactly one <svg>; it is made the
  //        positioning context, so it must not already rely on being static
  // items  [{ title, rows: [{ name, value, color }] }] in hit-area order
  SW.attachChartHover = function (host, items) {
    if (!host || !items || !items.length) return;
    const svg = host.querySelector('svg');
    if (!svg) return;

    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    const tip = document.createElement('div');
    tip.className = 'ch-tip';
    tip.hidden = true;
    host.appendChild(tip);

    let shown = -1;

    function hide() {
      shown = -1;
      tip.hidden = true;
      svg.querySelectorAll('[data-hover]').forEach(function (el) {
        el.classList.remove('is-hovered');
      });
    }

    function show(index, target) {
      const item = items[index];
      if (!item) return hide();

      if (index !== shown) {
        shown = index;
        tip.innerHTML =
          '<span class="ch-tip-title">' + esc(item.title) + '</span>' +
          (item.rows || []).map(function (r) {
            return '<span class="ch-tip-row">' +
              (r.color
                ? '<i style="background:' + esc(r.color) + '"></i>'
                : '') +
              '<span class="n">' + esc(r.name) + '</span>' +
              '<span class="v">' + esc(r.value) + '</span></span>';
          }).join('');

        svg.querySelectorAll('[data-hover]').forEach(function (el) {
          el.classList.toggle('is-hovered', el === target);
        });
      }

      tip.hidden = false;

      // Positioned against the hit area, not the pointer, so it does not
      // jitter while the finger or cursor moves within one column.
      const hostBox = host.getBoundingClientRect();
      const hitBox = target.getBoundingClientRect();
      const tipBox = tip.getBoundingClientRect();

      let left = hitBox.left - hostBox.left + hitBox.width / 2 - tipBox.width / 2;
      // Kept inside the chart, or the first and last columns push it off.
      left = Math.max(4, Math.min(left, hostBox.width - tipBox.width - 4));

      let top = hitBox.top - hostBox.top - tipBox.height - 8;
      if (top < 0) top = hitBox.top - hostBox.top + hitBox.height + 8;

      tip.style.left = left.toFixed(1) + 'px';
      tip.style.top = top.toFixed(1) + 'px';
    }

    function locate(e) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const hit = el && el.closest ? el.closest('[data-hover]') : null;
      if (!hit || !svg.contains(hit)) return null;
      return hit;
    }

    svg.addEventListener('pointermove', function (e) {
      const hit = locate(e);
      if (!hit) return hide();
      show(Number(hit.getAttribute('data-hover')), hit);
    });

    svg.addEventListener('pointerdown', function (e) {
      const hit = locate(e);
      if (!hit) return hide();
      show(Number(hit.getAttribute('data-hover')), hit);
    });

    svg.addEventListener('pointerleave', function (e) {
      // A finger leaving the svg has not moved anywhere else, so the reading
      // it was showing should stay put until the next tap.
      if (e.pointerType === 'mouse') hide();
    });

    // Tapping away dismisses it on a touch screen.
    document.addEventListener('pointerdown', function (e) {
      if (!svg.contains(e.target)) hide();
    });

    // Keyboard: the hit areas are focusable, so tabbing reads the series out.
    svg.addEventListener('focusin', function (e) {
      const hit = e.target.closest ? e.target.closest('[data-hover]') : null;
      if (hit) show(Number(hit.getAttribute('data-hover')), hit);
    });
    svg.addEventListener('focusout', hide);
  };

  // The hit area itself. Full plot height per column, so there is no aiming
  // at a two-pixel bar, and focusable so it works without a pointer at all.
  SW.chartHit = function (index, x, y, w, h, label) {
    return '<rect class="ch-hit" data-hover="' + index + '" tabindex="0" ' +
      'x="' + Number(x).toFixed(1) + '" y="' + Number(y).toFixed(1) + '" ' +
      'width="' + Math.max(1, Number(w)).toFixed(1) + '" ' +
      'height="' + Math.max(1, Number(h)).toFixed(1) + '" ' +
      'fill="transparent"' + (label ? ' aria-label="' + esc(label) + '"' : '') +
      '></rect>';
  };
})();
