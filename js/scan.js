// ---------------------------------------------------------------------------
//  Receipt scanning — OCR in the browser, then an editable itemisation
//
//  The image is read on this device and thrown away. Nothing is uploaded and
//  nothing is stored: what gets saved is the itemised split and a note.
//
//  Tesseract is honest-to-goodness OCR, not a layout model, so the parser
//  below is deliberately forgiving and everything it produces is editable.
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  /* ======================= line classification ======================= */

  // Rows that are never items: order metadata, totals, savings banners.
  const NOISE = new RegExp([
    '^(sub\\s*)?total', '^grand\\s*total', '^to\\s*pay', '^amount\\s*payable',
    '^payable', '^bill\\s*(total|details)', '^item\\s*total', '^order\\s*(id|no|summary)',
    '^invoice', '^gst\\s*(no|in)', '^address', '^deliver(ed|y)\\s*(to|in|by)',
    '^arriv', '^eta\\b', '^paid\\s*(via|using)', '^payment', '^thank',
    '^you\\s*sav', '^sav(ed|ings)', '^discount', '^coupon', '^promo',
    '^mrp\\b', '^cart\\s*total', '^grand\\b', '^\\W*$',
  ].join('|'), 'i');

  // Rows that are charges rather than things anyone ordered. These get
  // prorated across whoever ordered, by the size of their share.
  const FEE = new RegExp([
    'handling', 'delivery\\s*(fee|charge|partner)', 'platform\\s*fee',
    'small\\s*cart', 'surge', 'rain\\s*fee', 'packaging', 'packing',
    'convenience', '\\btip\\b', '\\bgst\\b', '\\btax(es)?\\b',
    'service\\s*(charge|fee)', 'cgst', 'sgst', 'round\\s*off',
  ].join('|'), 'i');

  // Units that follow a number, so "500 g" is a weight and not ₹500.
  const UNIT_AFTER = /^(g|gm|gms|kg|kgs|ml|l|ltr|litre|pc|pcs|piece|pieces|pack|packs|nos?|units?|dozen|combo|sachet|bottle|can|box|bag)\b/i;

  function pricesIn(line) {
    const found = [];

    // Anchored to a currency mark — the most reliable signal. OCR renders ₹
    // variously as ₹, ₨, Rs, INR, or a stray R.
    const anchored = /(?:₹|₨|rs\.?|inr|r5)\s*([\d,]+(?:\.\d{1,2})?)/gi;
    let m;
    while ((m = anchored.exec(line)) !== null) {
      const v = toPaise(m[1]);
      if (v !== null) found.push(v);
    }
    if (found.length) return found;

    // Otherwise a bare number at the very end of the line is the amount
    // column. Anything followed by a unit is a weight, not a price.
    const trailing = line.match(/([\d,]+(?:\.\d{1,2})?)\s*$/);
    if (trailing) {
      const before = line.slice(0, trailing.index).trim();
      // Reject "Maggi 12" style trailing counts only when a unit follows,
      // which by definition cannot happen at end of line — so accept.
      if (!/[a-z]$/i.test(before) || before.length > 2) {
        const v = toPaise(trailing[1]);
        if (v !== null) found.push(v);
      }
    }
    return found;
  }

  function toPaise(text) {
    const cleaned = String(text).replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
    const n = parseFloat(cleaned);
    // Guard against OCR turning a barcode into a price.
    if (!isFinite(n) || n <= 0 || n > 500000) return null;
    return Math.round(n * 100);
  }

  // "12 x 70 g" is a pack size; "x2" is how many were ordered. Telling them
  // apart is the whole difficulty: a count is never followed by a unit, and
  // an "N x" count is never followed by another number.
  function quantityCandidates(line) {
    const found = [];

    // "x2" — the near-universal marker, so it wins.
    const after = /(?:^|\s)x\s*(\d{1,2})(?=\s|$)/gi;
    let m;
    while ((m = after.exec(line)) !== null) {
      const rest = line.slice(m.index + m[0].length).trim();
      if (UNIT_AFTER.test(rest)) continue;          // "x 70 g" is a pack size
      found.push({ n: parseInt(m[1], 10), at: m.index, form: 'after' });
    }
    if (found.length) return found;

    // "2 x Dairy Milk" — only when what follows is neither a unit nor
    // another number, which is what "12 x 70 g" looks like.
    const before = /(?:^|\s)(\d{1,2})\s*x(?=\s|$)/gi;
    while ((m = before.exec(line)) !== null) {
      const rest = line.slice(m.index + m[0].length).trim();
      if (UNIT_AFTER.test(rest) || /^\d/.test(rest)) continue;
      found.push({ n: parseInt(m[1], 10), at: m.index, form: 'before' });
    }
    return found;
  }

  function quantityIn(line) {
    const candidates = quantityCandidates(line);
    if (candidates.length) {
      const q = candidates[candidates.length - 1].n;
      if (q >= 1 && q <= 99) return q;
    }

    const m = line.match(/\bqty\.?\s*[:\-]?\s*(\d{1,2})\b/i) ||
              line.match(/\((\d{1,2})\)\s*$/);
    if (!m) return 1;
    const q = parseInt(m[1], 10);
    return q >= 1 && q <= 99 ? q : 1;
  }

  function cleanName(text) {
    return text
      // Currency-marked amounts first.
      .replace(/(?:₹|₨|rs\.?|inr|r5)\s*[\d,]+(?:\.\d{1,2})?/gi, ' ')
      // Then the quantity — BEFORE the trailing-number pass, which would
      // otherwise eat the digits of "x2" and leave a stray "x" behind. Only
      // a real count is removed, so "12 x 70 g" stays in the name.
      .replace(/(?:^|\s)x\s*\d{1,2}(?=\s|$)/gi, function (match, offset, whole) {
        const rest = whole.slice(offset + match.length).trim();
        return UNIT_AFTER.test(rest) ? match : ' ';
      })
      .replace(/(?:^|\s)\d{1,2}\s*x(?=\s|$)/gi, function (match, offset, whole) {
        const rest = whole.slice(offset + match.length).trim();
        return (UNIT_AFTER.test(rest) || /^\d/.test(rest)) ? match : ' ';
      })
      .replace(/\bqty\.?\s*[:\-]?\s*\d{1,2}\b/gi, ' ')
      .replace(/\(\d{1,2}\)\s*$/, ' ')
      // Finally a bare amount sitting in the last column.
      .replace(/([\d,]+(?:\.\d{1,2})?)\s*$/, ' ')
      .replace(/[|•·>«»]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s\-–—.,:]+|[\s\-–—.,:]+$/g, '')
      .trim();
  }

  /* ======================= the parser ================================= */

  // Returns { rows, merged, skipped }.
  //   rows: [{ name, qty, totalPaise, kind: 'item' | 'fee' }]
  //   merged: how many exact duplicates were folded away
  SW.parseReceipt = function (text) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map(function (l) { return l.replace(/\s+/g, ' ').trim(); })
      .filter(function (l) { return l.length > 0; });

    const rows = [];
    let pending = [];      // name fragments awaiting a price on a later line
    let skipped = 0;

    function flushPending(totalPaise, qtyHint) {
      const name = cleanName(pending.join(' '));
      pending = [];
      if (!name) return false;
      push(name, qtyHint || quantityIn(name), totalPaise);
      return true;
    }

    function push(name, qty, totalPaise) {
      const nice = cleanName(name);
      if (!nice || totalPaise == null) return;
      rows.push({
        name: nice,
        qty: qty,
        totalPaise: totalPaise,
        kind: FEE.test(nice) ? 'fee' : 'item',
      });
    }

    lines.forEach(function (line) {
      if (NOISE.test(line)) {
        // A noise line also breaks any half-built item.
        if (pending.length) { pending = []; skipped++; }
        skipped++;
        return;
      }

      const prices = pricesIn(line);
      // Whether anything survives once currency markers and amounts are
      // stripped. "Rs 38" and "₹42" leave nothing, so they are price-only
      // lines; "500 g" leaves a weight, so it belongs to the name above it.
      const named = cleanName(line).length > 0;

      if (prices.length && named) {
        // Name and amount on the same line — the common case.
        // Last price wins: on a discounted row the struck MRP comes first
        // and the payable amount sits in the rightmost column.
        if (pending.length) flushPending(null);
        push(line, quantityIn(line), prices[prices.length - 1]);
        return;
      }

      if (prices.length && !named) {
        // A price on its own line, belonging to the name above it — which is
        // how Zepto and Blinkit lay their rows out.
        if (!flushPending(prices[prices.length - 1])) skipped++;
        return;
      }

      if (named) {
        // A name, or a weight line under one. Hold it.
        pending.push(line);
        // Never let a runaway block of prose become one giant item name.
        if (pending.length > 3) { pending.shift(); skipped++; }
        return;
      }

      skipped++;
    });

    if (pending.length) skipped++;

    // Fold away exact repeats: the same thing at the same price twice is
    // almost always the screenshot showing a row twice, not a double order.
    const seen = {};
    const deduped = [];
    let merged = 0;
    rows.forEach(function (r) {
      const key = r.name.toLowerCase() + '|' + r.qty + '|' + r.totalPaise;
      if (seen[key]) { merged++; return; }
      seen[key] = true;
      deduped.push(r);
    });

    // Fees last, in the order they were found.
    const items = deduped.filter(function (r) { return r.kind === 'item'; });
    const fees = deduped.filter(function (r) { return r.kind === 'fee'; });

    return { rows: items.concat(fees), merged: merged, skipped: skipped };
  };

  /* ======================= itemised split ============================ */

  // Turn item rows plus per-row participants into exact per-person totals.
  //   rows: [{ name, totalPaise, kind, who: [userId] }]
  // Item rows split equally among the people ticked on that row. Fee rows are
  // prorated across everyone by the size of their item subtotal, so whoever
  // ordered 15% of the basket carries 15% of the handling fee.
  SW.itemisedSplit = function (rows, allParticipants) {
    const subtotal = {};
    allParticipants.forEach(function (id) { subtotal[id] = 0; });

    let itemsTotal = 0;
    let feesTotal = 0;

    rows.forEach(function (r) {
      if (r.kind === 'fee') { feesTotal += r.totalPaise; return; }
      const who = (r.who || []).filter(function (id) { return subtotal[id] !== undefined; });
      if (!who.length) return;
      itemsTotal += r.totalPaise;
      const parts = SW.splitEqually(r.totalPaise, who.length);
      who.forEach(function (id, i) { subtotal[id] += parts[i]; });
    });

    const totals = {};
    allParticipants.forEach(function (id) { totals[id] = subtotal[id]; });

    if (feesTotal > 0) {
      // Prorate against item subtotals; if nothing was assigned, split even.
      const feeShare = SW.prorate(feesTotal, subtotal);
      Object.keys(feeShare).forEach(function (id) { totals[id] += feeShare[id]; });
    }

    return {
      totals: totals,
      subtotal: subtotal,
      itemsTotal: itemsTotal,
      feesTotal: feesTotal,
      grandTotal: itemsTotal + feesTotal,
    };
  };

  // A human-readable record of how it was carved up, saved as the note.
  SW.itemisedNote = function (rows, nameOf) {
    const parts = [];
    rows.forEach(function (r) {
      if (r.kind === 'fee') {
        parts.push(r.name + ' ' + SW.money(r.totalPaise) + ' (shared by order size)');
        return;
      }
      const who = (r.who || []);
      const label = who.length ? who.map(nameOf).join(', ') : 'nobody';
      parts.push(r.name + (r.qty > 1 ? ' ×' + r.qty : '') +
                 ' ' + SW.money(r.totalPaise) + ' (' + label + ')');
    });
    return 'Itemised — ' + parts.join('; ');
  };
})();

/* ==========================================================================
   Scanner UI — pick a screenshot, OCR it here, itemise, assign, apply
   ========================================================================== */

(function () {
  if (!SW.isConfigured) return;

  const esc = SW.escapeHtml;
  const TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

  // Loaded on first use only: the OCR engine pulls several megabytes of wasm
  // and language data, which nobody should pay for just to open the app.
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      const tag = document.createElement('script');
      tag.src = TESSERACT_SRC;
      tag.onload = resolve;
      tag.onerror = function () {
        reject(new Error('Could not load the scanner. Check your connection.'));
      };
      document.head.appendChild(tag);
    });
  }

  function initial(id) {
    const p = SW.person(id);
    const name = id === SW.ledger.me ? 'You' : (p.full_name || '?');
    return name.trim().charAt(0).toUpperCase() || '?';
  }
  function shortName(id) {
    if (id === SW.ledger.me) return 'You';
    return (SW.person(id).full_name || 'Someone').split(' ')[0];
  }

  function parseAmount(text) {
    const cleaned = String(text || '').replace(/[^0-9.]/g, '');
    if (!cleaned || cleaned === '.') return 0;
    const parts = cleaned.split('.');
    return SW.toPaise(parts.length > 1
      ? parts[0] + '.' + parts.slice(1).join('').slice(0, 2)
      : parts[0]);
  }

  /* ======================= the scanner sheet ========================= */

  // opts: { participants: [userId], onApply(result), onCancel() }
  //   result: { grandTotal, totals, note }
  SW.openScanner = function (opts) {
    const people = opts.participants.slice();
    let rows = [];
    let applied = false;

    SW.sheet({
      title: 'Scan a receipt',
      rawBody: '<div id="scan-stage"></div>',
      confirm: null,
      cancel: 'Cancel',
      onOpen: renderPick,
      onClose: function () { if (!applied && opts.onCancel) opts.onCancel(); },
    });

    function stage() { return document.getElementById('scan-stage'); }

    /* ---- stage 1: choose an image ---- */

    function renderPick() {
      stage().innerHTML =
        '<div class="scan-state">' +
          '<div class="scan-art">🧾</div>' +
          '<h3>Pick a screenshot</h3>' +
          '<p>A Zepto, Blinkit or Swiggy order screenshot works best. It is read ' +
             'on this phone and never uploaded or saved.</p>' +
          '<input type="file" id="scan-file" accept="image/*" hidden>' +
          '<button type="button" class="btn btn-primary" id="scan-paste" ' +
                  'style="max-width:280px">Paste the order text</button>' +
          '<button type="button" class="btn btn-ghost" id="scan-pick" ' +
                  'style="max-width:280px">Read a screenshot instead</button>' +
          '<span class="hint" style="max-width:32ch;text-align:center">Pasted text ' +
            'is read exactly. A screenshot has to be guessed at, so expect to ' +
            'correct a row or two.</span>' +
          '<button type="button" class="btn-text" id="scan-manual">' +
            'Or itemise by hand</button>' +
        '</div>';

      const file = document.getElementById('scan-file');
      document.getElementById('scan-pick').addEventListener('click', function () {
        file.click();
      });
      file.addEventListener('change', function () {
        const chosen = file.files && file.files[0];
        if (chosen) runOcr(chosen);
      });
      document.getElementById('scan-manual').addEventListener('click', function () {
        rows = [];
        renderItemise({ merged: 0, manual: true });
      });
      document.getElementById('scan-paste').addEventListener('click', renderPaste);
    }

    /* ---- stage 1b: paste it instead ---- */

    // A Zepto or Blinkit order confirmation is selectable text. Pasting it
    // skips OCR entirely, so nothing has to be guessed at — the same parser
    // does the work, just on characters instead of pixels.
    function renderPaste() {
      stage().innerHTML =
        '<div class="sheet-body">' +
          '<p style="color:var(--muted);font-size:14.5px">Copy the order from ' +
            'Zepto, Blinkit, Swiggy or an email and paste it here. Long-press ' +
            'the item list in the app and choose Copy.</p>' +
          '<textarea class="input" id="scan-text" rows="8" ' +
                    'placeholder="Onion 1 kg  ₹42&#10;Amul Butter 500 g  ₹265&#10;' +
                    'Handling Fee  ₹12" ' +
                    'style="resize:vertical;line-height:1.5;font-size:14px"></textarea>' +
          '<div class="field-error" id="scan-text-error"></div>' +
        '</div>' +
        '<div class="sheet-actions">' +
          '<button type="button" class="btn btn-primary" id="scan-text-go">' +
            'Read it</button>' +
          '<button type="button" class="btn-text" id="scan-text-back" ' +
                  'style="align-self:center;padding:8px">Back</button>' +
        '</div>';

      const box = document.getElementById('scan-text');
      box.focus();

      // Offer what is already on the clipboard, where the browser allows it.
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(function (text) {
          if (text && text.trim() && !box.value) box.value = text;
        }).catch(function () { /* refused, which is normal */ });
      }

      document.getElementById('scan-text-back').addEventListener('click', renderPick);
      document.getElementById('scan-text-go').addEventListener('click', function () {
        const text = box.value;
        if (!text.trim()) {
          return SW.setError('scan-text-error', 'Paste the order first.');
        }

        const parsed = SW.parseReceipt(text);
        if (!parsed.rows.length) {
          return SW.setError('scan-text-error',
            'No priced rows in that. Each line needs a name and an amount.');
        }

        rows = parsed.rows.map(function (r) {
          return {
            name: r.name, qty: r.qty, totalPaise: r.totalPaise, kind: r.kind,
            who: r.kind === 'fee' ? [] : people.slice(),
          };
        });
        renderItemise({ merged: parsed.merged });
      });
    }

    /* ---- stage 2: OCR ---- */

    async function runOcr(file) {
      stage().innerHTML =
        '<div class="scan-state">' +
          '<div class="scan-art">🔍</div>' +
          '<h3 id="scan-head">Reading the receipt</h3>' +
          '<p id="scan-hint">The first scan downloads the reader, so it takes a ' +
             'moment. After that it is quick.</p>' +
          '<div class="scan-bar"><span id="scan-prog"></span></div>' +
        '</div>';

      const bar = document.getElementById('scan-prog');
      function progress(pct) { if (bar) bar.style.width = Math.round(pct * 100) + '%'; }

      let worker;
      try {
        await loadTesseract();
        progress(0.08);

        worker = await window.Tesseract.createWorker('eng', 1, {
          logger: function (m) {
            if (m.status === 'recognizing text') progress(0.15 + m.progress * 0.85);
          },
        });

        const head = document.getElementById('scan-head');
        const hint = document.getElementById('scan-hint');
        if (head) head.textContent = 'Reading the receipt';
        if (hint) hint.textContent = 'Looking for item names and prices.';

        const result = await worker.recognize(file);
        progress(1);

        const parsed = SW.parseReceipt(result.data.text);
        rows = parsed.rows.map(function (r) {
          return {
            name: r.name,
            qty: r.qty,
            totalPaise: r.totalPaise,
            kind: r.kind,
            // Default an item to everyone, which is right more often than not
            // and is one tap to narrow.
            who: r.kind === 'fee' ? [] : people.slice(),
          };
        });
        renderItemise({ merged: parsed.merged });
      } catch (err) {
        stage().innerHTML =
          '<div class="scan-state">' +
            '<div class="scan-art">😕</div>' +
            '<h3>Could not read that</h3>' +
            '<p>' + esc(err.message || String(err)) + '</p>' +
            '<button type="button" class="btn btn-ghost" id="scan-retry" ' +
                    'style="max-width:280px">Try another image</button>' +
            '<button type="button" class="btn-text" id="scan-manual2">' +
              'Itemise by hand instead</button>' +
          '</div>';
        document.getElementById('scan-retry').addEventListener('click', renderPick);
        document.getElementById('scan-manual2').addEventListener('click', function () {
          rows = [];
          renderItemise({ merged: 0, manual: true });
        });
      } finally {
        // Free the wasm worker either way; the image itself is never kept.
        if (worker) { try { await worker.terminate(); } catch (e) { /* ignore */ } }
      }
    }

    /* ---- stage 3: the editable itemisation ---- */

    function renderItemise(meta) {
      meta = meta || {};

      if (!rows.length && !meta.manual) {
        stage().innerHTML =
          '<div class="scan-state">' +
            '<div class="scan-art">🤔</div>' +
            '<h3>No items found</h3>' +
            '<p>The reader could not pick out any priced rows. You can add them ' +
               'by hand, or try a clearer screenshot.</p>' +
            '<button type="button" class="btn btn-primary" id="scan-hand" ' +
                    'style="max-width:280px">Add items by hand</button>' +
            '<button type="button" class="btn-text" id="scan-again">Try another image</button>' +
          '</div>';
        document.getElementById('scan-hand').addEventListener('click', function () {
          rows = [{ name: '', qty: 1, totalPaise: 0, kind: 'item', who: people.slice() }];
          renderItemise({ manual: true });
        });
        document.getElementById('scan-again').addEventListener('click', renderPick);
        return;
      }

      stage().innerHTML =
        (meta.merged
          ? '<div class="scan-warn">Folded away ' + meta.merged +
            (meta.merged === 1 ? ' repeated row' : ' repeated rows') +
            '. Add it back below if it was a genuine second order.</div>'
          : '') +
        '<div class="card-head" style="display:flex;align-items:center;gap:8px">' +
          '<span style="flex:1">Tick who is in on each line</span>' +
        '</div>' +
        '<div class="item-list" id="scan-rows"></div>' +
        '<div style="padding:10px 14px">' +
          '<button type="button" class="btn btn-ghost" id="scan-add">Add an item</button>' +
        '</div>' +
        '<div class="itemise-foot" id="scan-foot"></div>' +
        '<div class="sheet-actions">' +
          '<button type="button" class="btn btn-primary" id="scan-apply">' +
            '<span class="btn-label">Use this split</span></button>' +
        '</div>';

      document.getElementById('scan-add').addEventListener('click', function () {
        rows.push({ name: '', qty: 1, totalPaise: 0, kind: 'item', who: people.slice() });
        renderRows();
        const last = document.querySelector('#scan-rows .item-row:last-child .ir-name');
        if (last) last.focus();
      });

      document.getElementById('scan-apply').addEventListener('click', apply);

      renderRows();
    }

    function renderRows() {
      const host = document.getElementById('scan-rows');
      host.innerHTML = rows.map(function (r, i) {
        const orphan = r.kind === 'item' && !r.who.length;
        return '<div class="item-row' +
                 (r.kind === 'fee' ? ' is-fee' : '') +
                 (orphan ? ' is-orphan' : '') + '" data-i="' + i + '">' +
          '<div class="ir-top">' +
            '<input class="ir-name" value="' + esc(r.name) + '" ' +
                   'placeholder="What is it?" aria-label="Item name">' +
            '<input class="ir-qty" type="text" inputmode="numeric" ' +
                   'value="' + (r.qty > 1 ? '×' + r.qty : '') + '" ' +
                   'placeholder="×1" aria-label="Quantity">' +
            '<span class="ir-eq" aria-hidden="true">=</span>' +
            '<input class="ir-price" type="text" inputmode="decimal" ' +
                   'value="' + (r.totalPaise ? SW.rupees(r.totalPaise) : '') + '" ' +
                   'placeholder="0.00" aria-label="Price">' +
            '<button type="button" class="ir-del" aria-label="Remove this line">×</button>' +
          '</div>' +
          (r.kind === 'fee'
            ? '<div class="fee-tag">Shared by order size' +
              '<button type="button" class="btn-text" data-unfee="' + i + '">' +
                'Assign it manually instead</button></div>'
            : '<div class="who-chips">' +
                people.map(function (id) {
                  return '<button type="button" class="who-chip' +
                    (r.who.indexOf(id) > -1 ? ' is-on' : '') + '" data-who="' + esc(id) + '">' +
                    '<span class="ini">' + esc(initial(id)) + '</span>' +
                    esc(shortName(id)) + '</button>';
                }).join('') +
                '<button type="button" class="who-all">' +
                  (r.who.length === people.length ? 'None' : 'All') + '</button>' +
              '</div>') +
        '</div>';
      }).join('');

      host.querySelectorAll('.item-row').forEach(function (el) {
        const i = parseInt(el.getAttribute('data-i'), 10);

        // Typing only updates the model and the footer, so focus is never
        // yanked away mid-edit by a re-render.
        el.querySelector('.ir-name').addEventListener('input', function () {
          rows[i].name = this.value;
        });
        el.querySelector('.ir-price').addEventListener('input', function () {
          rows[i].totalPaise = parseAmount(this.value);
          updateFoot();
        });
        el.querySelector('.ir-qty').addEventListener('input', function () {
          const q = parseInt(String(this.value).replace(/[^0-9]/g, ''), 10);
          rows[i].qty = q >= 1 && q <= 99 ? q : 1;
        });
        el.querySelector('.ir-del').addEventListener('click', function () {
          rows.splice(i, 1);
          if (!rows.length) rows.push({ name: '', qty: 1, totalPaise: 0, kind: 'item', who: people.slice() });
          renderRows();
        });

        el.querySelectorAll('[data-who]').forEach(function (chip) {
          chip.addEventListener('click', function () {
            const id = chip.getAttribute('data-who');
            const at = rows[i].who.indexOf(id);
            if (at > -1) rows[i].who.splice(at, 1);
            else rows[i].who.push(id);
            chip.classList.toggle('is-on', at === -1);
            el.classList.toggle('is-orphan', !rows[i].who.length);
            const all = el.querySelector('.who-all');
            if (all) all.textContent = rows[i].who.length === people.length ? 'None' : 'All';
            updateFoot();
          });
        });

        const all = el.querySelector('.who-all');
        if (all) all.addEventListener('click', function () {
          rows[i].who = rows[i].who.length === people.length ? [] : people.slice();
          renderRows();
          updateFoot();
        });

        const unfee = el.querySelector('[data-unfee]');
        if (unfee) unfee.addEventListener('click', function () {
          rows[i].kind = 'item';
          rows[i].who = people.slice();
          renderRows();
          updateFoot();
        });
      });

      updateFoot();
    }

    function compute() {
      return SW.itemisedSplit(rows, people);
    }

    function updateFoot() {
      const foot = document.getElementById('scan-foot');
      if (!foot) return;
      const s = compute();
      const orphans = rows.filter(function (r) {
        return r.kind === 'item' && r.totalPaise > 0 && !r.who.length;
      }).length;

      foot.innerHTML =
        '<div class="if-line"><span>Items</span>' +
          '<span class="v">' + SW.money(s.itemsTotal) + '</span></div>' +
        (s.feesTotal
          ? '<div class="if-line"><span>Fees, shared by order size</span>' +
            '<span class="v">' + SW.money(s.feesTotal) + '</span></div>'
          : '') +
        '<div class="if-line is-total"><span>Total</span>' +
          '<span class="v">' + SW.money(s.grandTotal) + '</span></div>' +
        (orphans
          ? '<div class="if-line" style="color:var(--owe)"><span>' + orphans +
            (orphans === 1 ? ' line has' : ' lines have') + ' nobody ticked</span>' +
            '<span class="v">excluded</span></div>'
          : '') +
        '<div class="if-people">' +
          people.map(function (id) {
            const v = s.totals[id] || 0;
            const pct = s.grandTotal ? Math.round((v / s.grandTotal) * 100) : 0;
            return '<div class="if-person">' +
              '<span class="n">' + esc(shortName(id)) + '</span>' +
              '<span class="pct">' + pct + '%</span>' +
              '<span class="v">' + SW.money(v) + '</span></div>';
          }).join('') +
        '</div>';
    }

    function apply() {
      const usable = rows.filter(function (r) { return r.totalPaise > 0 && r.name.trim(); });
      if (!usable.length) {
        return SW.toast('Add at least one line with a name and a price', 'error');
      }

      const s = SW.itemisedSplit(usable, people);
      if (s.grandTotal <= 0) {
        return SW.toast('Nothing is assigned to anyone yet', 'error');
      }

      applied = true;
      SW.closeSheet();
      opts.onApply({
        grandTotal: s.grandTotal,
        totals: s.totals,
        note: SW.itemisedNote(usable, shortName),
      });
    }
  };
})();
