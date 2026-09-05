// ---------------------------------------------------------------------------
//  Receipt scanning — read a screenshot, then an editable itemisation
//
//  Two readers. Where a key is configured the screenshots go to a vision
//  model, which understands that the right-hand column is money and that a
//  crossed-out number is the old price. Where one is not, Tesseract reads
//  them on the device and the parser below picks the result apart.
//
//  Tesseract is honest-to-goodness character recognition, not a layout model
//  — it does not even know the ₹ glyph — so the parser is deliberately
//  forgiving and everything either reader produces is editable before it is
//  applied. No image is stored by either path; what gets saved is the
//  itemisation and a note.
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
    // Screenshot chrome. A phone screenshot of an order carries the app's
    // header and footer and the phone's own status bar, and every one of
    // those lines ends in a number that is not an amount.
    '^order\\s*[#:]', '^order\\s*(again|details|placed)', '^\\d+\\s*items?\\b',
    '^items?\\s*in\\s*order', '^(get|need)\\s*help', '^rate\\s*(order|us)',
    '^repeat\\s*order', '^track\\s*order', '^view\\s*(invoice|bill|details)',
    '^download\\s*invoice', '^\\d{1,2}:\\d{2}\\s*(am|pm)?\\b',
    '^\\d+(\\.\\d+)?\\s*(kb|mb)/s\\b', '^delivered\\b', '^refund',
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

  // The same words, plus the filler around them, for deciding whether a line
  // is *only* a size — "1 pc • 1 unit", "250 - 275 g • 2 units".
  const SIZE_WORD = /^(g|gm|gms|kg|kgs|ml|l|ltr|litre|lit|pc|pcs|piece|pieces|pack|packs|packet|no|nos|unit|units|dozen|combo|sachet|bottle|can|box|bag|approx|each|of|per|x|gram|grams|kilo|kilos|litres|liters)$/i;

  // Zepto, Blinkit and Instamart all print the size on its own row beneath
  // the item, with the struck-out MRP beside it. That row is not an item and
  // its amount is not what anybody paid.
  function isDescriptor(name) {
    const words = String(name).split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    let sawSize = false;
    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
      if (!w) continue;
      if (/^\d+(\.\d+)?$/.test(w)) continue;
      if (SIZE_WORD.test(w)) { sawSize = true; continue; }
      const glued = w.match(/^(\d+(?:\.\d+)?)([A-Za-z]+)$/);   // "275g"
      if (glued && SIZE_WORD.test(glued[2])) { sawSize = true; continue; }
      return false;
    }
    return sawSize;
  }

  /* ======================= the missing rupee ========================= */

  // Tesseract's English model has never been shown a ₹, so it substitutes
  // whatever glyph it thinks is closest — and it is perfectly consistent
  // about it within one screenshot. On a Blinkit order it reads every ₹ as
  // a "2", which silently turns ₹35 into 235 and a ₹469 basket into ₹53,727.
  //
  // Nothing in the line itself can tell 235 from ₹35. The whole document can:
  // if not one real currency mark survived anywhere, and every amount in the
  // right-hand column carries the same leading character, and that character
  // is one a ₹ plausibly collapses into — then that character IS the ₹.
  const MISREAD = /^[2356789zZsS$%?!|*&€¥£RrFfTtEe\]\}"']$/;
  const REAL_MARK = /₹|₨|\brs\.?\s*\d|\binr\b/i;

  // Only the amount column counts as evidence: one stray character, then at
  // least two digits, at the end of a line. A genuine bare "45" is one digit
  // after its first, so it never votes.
  const COLUMN = /(?:^|\s)(\S)(\d\d[\d,]*(?:\.\d{1,2})?)\s*$/;

  function escapeRe(ch) { return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  SW.detectRupeeGlyph = function (lines) {
    if (lines.some(function (l) { return REAL_MARK.test(l); })) return null;
    let glyph = null;
    let votes = 0;
    for (let i = 0; i < lines.length; i++) {
      if (NOISE.test(lines[i])) continue;
      const m = lines[i].match(COLUMN);
      if (!m) continue;
      if (!MISREAD.test(m[1])) return null;         // one dissenter is enough
      if (glyph === null) glyph = m[1];
      else if (glyph !== m[1]) return null;
      votes++;
    }
    return votes >= 4 ? glyph : null;
  };

  // Rewrite only the run of amounts at the end of a line, so a "200 g" in
  // the middle of a name is left alone while a struck MRP sitting beside the
  // payable amount is not.
  function restoreRupees(lines, glyph) {
    const g = escapeRe(glyph);
    const tail = new RegExp('((?:(?:^|\\s)' + g + '\\d\\d[\\d,]*(?:\\.\\d{1,2})?)+)\\s*$');
    const one = new RegExp('(^|\\s)' + g + '(\\d)', 'g');
    return lines.map(function (l) {
      return l.replace(tail, function (run) { return run.replace(one, '$1₹$2'); });
    });
  }

  /* ======================= prices and quantities ====================== */

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
    // column — unless it is welded to letters, which makes it a reference
    // rather than an amount. "Order #HGTKKOIU49669" is not ₹49,669. A single
    // letter in front is fine: that is a ₹ the reader did not recognise.
    const trailing = line.match(/(\S*?)([\d,]+(?:\.\d{1,2})?)\s*$/);
    if (trailing && !/[A-Za-z]{2}|#/.test(trailing[1]) && !/^[xX×]$/.test(trailing[1])) {
      const v = toPaise(trailing[2]);
      if (v !== null) found.push(v);
    }
    return found;
  }

  // A discounted row carries two amounts: what it cost, and the struck-out
  // MRP. Which comes first depends on the app — Blinkit puts the payable
  // above the MRP, Swiggy after it — but the payable is always the smaller
  // of the two. A line doing arithmetic ("2 x 50 = 100") is left alone.
  function pickPrice(prices, line) {
    if (prices.length === 2 && !/\d\s*[x×@=]\s*[\d₹]/i.test(line)) {
      return Math.min(prices[0], prices[1]);
    }
    return prices[prices.length - 1];
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
              line.match(/(?:^|\s)(\d{1,2})\s*units?\b/i) ||
              line.match(/\((\d{1,2})\)\s*$/);
    if (!m) return 1;
    const q = parseInt(m[1], 10);
    return q >= 1 && q <= 99 ? q : 1;
  }

  // The item thumbnail in a Zepto or Blinkit screenshot is read as a short
  // run of nonsense to the left of the name: "& Bottle Gourd", "t3 Baby
  // Apple Shimla", "© ..& Tomato Local". Everything before the first real
  // word goes, as long as a real name is left behind.
  function stripLeadingJunk(name) {
    const words = name.split(' ');
    let i = 0;
    while (i < words.length - 1 && !/^[A-Za-z]{3,}/.test(words[i])) i++;
    const rest = words.slice(i).join(' ');
    return /[A-Za-z]{3}/.test(rest) ? rest : name;
  }

  function bareName(text) {
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

  function cleanName(text) {
    return stripLeadingJunk(bareName(text));
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

    // Put the rupee sign back before anything is read, if the reader lost it.
    const glyph = SW.detectRupeeGlyph(lines);
    const readable = glyph ? restoreRupees(lines, glyph) : lines;

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
      if (!nice || totalPaise == null) return -1;
      rows.push({
        name: nice,
        qty: qty,
        totalPaise: totalPaise,
        kind: FEE.test(nice) ? 'fee' : 'item',
      });
      return rows.length - 1;
    }

    // A long product name wraps, and the half that spills onto the next line
    // lands beside the struck-out MRP: "Ganesh Whole Wheat Chakki Pure Atta |"
    // then "No Maida  ₹56". Without this that ₹56 becomes a "Maida" nobody
    // bought. The separator left hanging at the wrap is what gives it away.
    const WRAP_END = /[|/&]\s*$/;
    let continueInto = -1;

    function looksLikeContinuation(name) {
      const words = name.split(' ').filter(Boolean);
      return words.length > 0 && words.length <= 4 && !/\d/.test(name);
    }

    readable.forEach(function (line) {
      if (NOISE.test(line)) {
        // A noise line also breaks any half-built item.
        if (pending.length) { pending = []; skipped++; }
        skipped++;
        return;
      }

      const prices = pricesIn(line);
      const base = bareName(line);

      if (continueInto > -1) {
        const carry = continueInto;
        continueInto = -1;
        if (!pending.length && looksLikeContinuation(base)) {
          rows[carry].name = cleanName(rows[carry].name + ' ' + base);
          rows[carry].kind = FEE.test(rows[carry].name) ? 'fee' : 'item';
          skipped++;                 // its amount was the MRP, not a price
          return;
        }
      }

      // Whether anything survives once currency markers and amounts are
      // stripped. "Rs 38" and "₹42" leave nothing, so they are price-only
      // lines; "500 g" leaves a weight, so it belongs to the name above it.
      const named = base.length > 0;

      if (prices.length && named) {
        const amount = pickPrice(prices, line);

        // A size row carrying an amount — "1 pc • 1 unit  ₹99". If a name is
        // still waiting then this is its size and its price. If not, the item
        // above already took its price and this is the struck-out MRP printed
        // underneath it, which nobody paid.
        if (isDescriptor(base)) {
          if (pending.length) { pending.push(base); flushPending(amount); }
          else skipped++;
          return;
        }

        // Name and amount on the same line — the common case.
        if (pending.length) flushPending(null);
        const at = push(line, quantityIn(line), amount);
        if (at > -1 && WRAP_END.test(line.replace(/(?:₹|₨|rs\.?|inr|r5)?\s*[\d,]+(?:\.\d{1,2})?\s*$/i, ''))) {
          continueInto = at;
        }
        return;
      }

      if (prices.length && !named) {
        // A price on its own line, belonging to the name above it — which is
        // how Zepto and Blinkit lay their rows out.
        if (!flushPending(pickPrice(prices, line))) skipped++;
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

    return { rows: items.concat(fees), merged: merged, skipped: skipped, glyph: glyph };
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
  const CLOUD_URL = '/.netlify/functions/scan';
  const MAX_SHOTS = 5;

  // Remembered for the session so a deploy with no key asks once, not every
  // time somebody scans.
  let cloudReader = 'unknown';       // 'unknown' | 'yes' | 'no'

  // A detached input, so the picker can be opened from anywhere without a
  // hidden element having to already exist on the screen.
  function pickFiles(onPicked) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', function () {
      const files = Array.prototype.slice.call(input.files || []);
      document.body.removeChild(input);
      if (files.length) onPicked(files.slice(0, MAX_SHOTS));
    });
    input.click();
  }

  function toBase64(blob) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onerror = function () { reject(new Error('Could not read that image.')); };
      fr.onload = function () {
        // "data:image/jpeg;base64,AAAA" — only the payload goes over the wire.
        const s = String(fr.result || '');
        resolve(s.slice(s.indexOf(',') + 1));
      };
      fr.readAsDataURL(blob);
    });
  }

  // Asked once, before the picker is drawn, so the screen can say where the
  // picture actually goes.
  function probeCloud() {
    if (cloudReader !== 'unknown') return Promise.resolve(cloudReader);
    return fetch(CLOUD_URL, { method: 'GET' })
      .then(function (r) { return r.ok ? r.json() : { ready: false }; })
      .then(function (b) { cloudReader = b.ready ? 'yes' : 'no'; return cloudReader; })
      .catch(function () { return 'unknown'; });
  }

  // Why the good reader was not the one used, when it was configured. A
  // silent fallback is what made "the key is set but nothing uses it" so hard
  // to see: the model name had been retired and the app said nothing.
  let cloudNote = '';

  // Returns rows, or null if this deploy has no reader configured — in which
  // case the caller falls back to on-device OCR rather than failing.
  async function readInCloud(files) {
    cloudNote = '';
    if (cloudReader === 'no') return null;

    const images = [];
    for (let i = 0; i < files.length; i++) {
      // Full-page screenshots are tall; 1600px keeps small print legible while
      // staying well inside what a function body can carry.
      const blob = await SW.prepareImage(files[i], { maxDim: 1600, maxBytes: 900 * 1024 });
      images.push({ mime: 'image/jpeg', data: await toBase64(blob) });
    }

    const res = await fetch(CLOUD_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ images: images }),
    });

    if (res.status === 501 || res.status === 404) { cloudReader = 'no'; return null; }
    const body = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      // Recoverable — no quota, a refusal, a model that has been retired.
      // Fall back, but say that is what happened.
      if (body.fallback) {
        cloudNote = body.error || 'The reader could not be used just now.';
        return null;
      }
      throw new Error(body.error || 'The reader could not read that.');
    }
    cloudReader = 'yes';
    const got = Array.isArray(body.rows) ? body.rows : [];
    // Nothing found is not an answer worth keeping: let the on-device reader
    // have a go before telling somebody their receipt has no items in it.
    if (!got.length) {
      cloudNote = 'Nothing was found in those, so they were read here instead.';
      return null;
    }
    return got;
  }

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

  // opts: { participants: [userId], items, onApply(result), onCancel() }
  //   result: { grandTotal, totals, note, items }
  //
  // `items` on the way in is a previously saved itemisation, which opens
  // straight into the editor rather than asking for a screenshot again —
  // that is the whole point of storing it: an egg bought for one person can
  // be shared out weeks later without re-scanning anything.
  SW.openScanner = function (opts) {
    const people = opts.participants.slice();
    let rows = [];
    let applied = false;

    // Anybody on a saved line who is no longer part of the expense is
    // dropped, or a removed person would keep a share of the egg.
    const saved = (opts.items || []).map(function (r) {
      return {
        name: String(r.name || ''),
        qty: Number(r.qty) || 1,
        totalPaise: Number(r.totalPaise) || 0,
        kind: r.kind === 'fee' ? 'fee' : 'item',
        who: (r.who || []).filter(function (id) { return people.indexOf(id) > -1; }),
      };
    }).filter(function (r) { return r.name || r.totalPaise; });

    SW.sheet({
      title: saved.length ? 'Edit the items' : 'Scan a receipt',
      rawBody: '<div id="scan-stage"></div>',
      confirm: null,
      cancel: 'Cancel',
      onOpen: function () {
        // renderItemise, not renderRows: the rows go inside a stage that has
        // to be built first. Calling renderRows here threw on a null #scan-rows
        // — so reopening a saved itemisation, the whole point of storing one,
        // died before it drew anything.
        if (saved.length) { rows = saved; renderItemise({ merged: 0, manual: true }); }
        else renderPick();
      },
      onClose: function () { if (!applied && opts.onCancel) opts.onCancel(); },
    });

    function stage() { return document.getElementById('scan-stage'); }

    /* ---- stage 1: choose an image ---- */

    function renderPick() {
      stage().innerHTML =
        '<div class="scan-state">' +
          '<div class="scan-art">🧾</div>' +
          '<h3>Pick your screenshots</h3>' +
          '<p>A Zepto, Blinkit, Instamart, BigBasket or Swiggy order screen ' +
             'works. Pick more than one if the order does not fit on a single ' +
             'screen — they are read together as one order.</p>' +
          '<button type="button" class="btn btn-primary" id="scan-pick" ' +
                  'style="max-width:280px">Read screenshots</button>' +
          '<button type="button" class="btn btn-ghost" id="scan-paste" ' +
                  'style="max-width:280px">Paste the order text instead</button>' +
          '<span class="hint" style="max-width:34ch;text-align:center" ' +
                'id="scan-where">Pasted text is read exactly, so reach for it ' +
            'if a scan comes out wrong.</span>' +
          '<button type="button" class="btn-text" id="scan-manual">' +
            'Or itemise by hand</button>' +
        '</div>';

      document.getElementById('scan-pick').addEventListener('click', function () {
        pickFiles(function (files) { readReceipt(files, false); });
      });
      document.getElementById('scan-manual').addEventListener('click', function () {
        rows = [];
        renderItemise({ merged: 0, manual: true });
      });
      document.getElementById('scan-paste').addEventListener('click', renderPaste);

      // Say where the picture goes, once we know. Until then the line above
      // claims nothing either way.
      probeCloud().then(function (state) {
        const where = document.getElementById('scan-where');
        if (!where || state === 'unknown') return;
        where.textContent = state === 'yes'
          ? 'The screenshots are sent to be read and are not stored. ' +
            'Pasting the text instead keeps them on this phone.'
          : 'Screenshots are read on this phone and never uploaded. Pasted ' +
            'text is read exactly, so reach for it if a scan comes out wrong.';
      });
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

    /* ---- stage 2: read the images ---- */

    // Two readers. The cloud one understands that the right-hand column is
    // money and that a crossed-out number is the old price; Tesseract only
    // knows shapes. So try the first, and quietly use the second when this
    // deploy has no key, the free quota is spent, or the network is not
    // there — because a scanner that refuses to scan is worse than one that
    // needs a row corrected.
    async function readReceipt(files, append) {
      const many = files.length > 1;
      stage().innerHTML =
        '<div class="scan-state">' +
          '<div class="scan-art">🔍</div>' +
          '<h3 id="scan-head">Reading ' + (many ? 'the screenshots' : 'the receipt') + '</h3>' +
          '<p id="scan-hint">Picking out item names and prices.</p>' +
          '<div class="scan-bar"><span id="scan-prog"></span></div>' +
        '</div>';

      const bar = document.getElementById('scan-prog');
      function progress(pct) { if (bar) bar.style.width = Math.round(pct * 100) + '%'; }
      function say(text) {
        const hint = document.getElementById('scan-hint');
        if (hint) hint.textContent = text;
      }

      let found = null;
      let meta = { merged: 0 };

      try {
        progress(0.12);
        found = await readInCloud(files);
        if (found) { progress(1); meta.by = 'cloud'; }
      } catch (err) {
        return failed(err);
      }

      if (!found) {
        try {
          say('Reading it on this phone. The first scan downloads the reader.');
          const parsed = await readOnDevice(files, progress, say);
          found = parsed.rows;
          meta.merged = parsed.merged;
          meta.glyph = parsed.glyph;
          meta.note = cloudNote;
        } catch (err) {
          return failed(err);
        }
      }

      const fresh = found.map(function (r) {
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

      if (append) {
        // A second batch of screenshots of the same order: anything already
        // on the list at the same price is the overlap between them.
        const have = {};
        rows.forEach(function (r) { have[r.name.toLowerCase() + '|' + r.totalPaise] = true; });
        let added = 0;
        fresh.forEach(function (r) {
          const key = r.name.toLowerCase() + '|' + r.totalPaise;
          if (have[key]) return;
          have[key] = true;
          rows.push(r);
          added++;
        });
        meta.added = added;
      } else {
        rows = fresh;
      }

      renderItemise(meta);
    }

    function failed(err) {
      stage().innerHTML =
        '<div class="scan-state">' +
          '<div class="scan-art">😕</div>' +
          '<h3>Could not read that</h3>' +
          '<p>' + esc(err.message || String(err)) + '</p>' +
          '<button type="button" class="btn btn-ghost" id="scan-retry" ' +
                  'style="max-width:280px">Try other screenshots</button>' +
          '<button type="button" class="btn-text" id="scan-manual2">' +
            'Itemise by hand instead</button>' +
        '</div>';
      document.getElementById('scan-retry').addEventListener('click', renderPick);
      document.getElementById('scan-manual2').addEventListener('click', function () {
        rows = [];
        renderItemise({ merged: 0, manual: true });
      });
    }

    // One worker for all of the images: loading it is the slow part, and the
    // pages are read into a single block of text so an item split across two
    // screenshots still has its name and its price together.
    async function readOnDevice(files, progress, say) {
      let worker;
      try {
        await loadTesseract();
        progress(0.18);

        worker = await window.Tesseract.createWorker('eng', 1, {
          logger: function (m) {
            if (m.status === 'recognizing text') progress(0.25 + m.progress * 0.7);
          },
        });

        const pages = [];
        for (let i = 0; i < files.length; i++) {
          if (files.length > 1) say('Reading screenshot ' + (i + 1) + ' of ' + files.length + '.');
          const result = await worker.recognize(files[i]);
          pages.push(result.data.text);
        }
        progress(1);
        return SW.parseReceipt(pages.join('\n'));
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
            '<button type="button" class="btn-text" id="scan-again">Try other screenshots</button>' +
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
        // Tesseract does not know the ₹ glyph and puts something else in its
        // place. That is undone before the amounts are read, but it is worth
        // saying so, because it is the one failure that looks like a price.
        (meta.glyph
          ? '<div class="scan-warn">The reader saw every ₹ as ' +
            '"' + esc(meta.glyph) + '", which has been undone. Worth a glance ' +
            'down the amounts.</div>'
          : '') +
        (meta.note
          ? '<div class="scan-warn">' + esc(meta.note) + '</div>'
          : '') +
        (meta.added === 0
          ? '<div class="scan-warn">Nothing new in those — every line was ' +
            'already on the list.</div>'
          : meta.added
            ? '<div class="scan-warn">Added ' + meta.added +
              (meta.added === 1 ? ' more line' : ' more lines') + '.</div>'
            : '') +
        '<div class="card-head" style="display:flex;align-items:center;gap:8px">' +
          '<span style="flex:1">Tick who is in on each line</span>' +
        '</div>' +
        '<div class="item-list" id="scan-rows"></div>' +
        '<div style="padding:10px 14px;display:flex;flex-wrap:wrap;gap:8px">' +
          '<button type="button" class="btn btn-ghost" id="scan-add" ' +
                  'style="flex:1 1 140px">Add an item</button>' +
          '<button type="button" class="btn btn-ghost" id="scan-more" ' +
                  'style="flex:1 1 140px">Add more screenshots</button>' +
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

      document.getElementById('scan-more').addEventListener('click', function () {
        pickFiles(function (files) { readReceipt(files, true); });
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
        // Stored on the expense so this screen can be reopened later and the
        // lines reassigned without scanning anything again.
        items: usable.map(function (r) {
          return {
            name: r.name, qty: r.qty, totalPaise: r.totalPaise,
            kind: r.kind, who: (r.who || []).slice(),
          };
        }),
      });
    }
  };
})();
