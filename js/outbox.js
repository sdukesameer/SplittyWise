// ---------------------------------------------------------------------------
//  The local database: an outbox for offline writes, and a ledger cache
//
//  Outbox — adding expenses and payments while offline
//
//  The service worker already lets the app open with no signal, but every
//  write failed, which is backwards: the moment you most need to add an
//  expense is standing in a restaurant on bad mobile data.
//
//  A queued write is held in IndexedDB and shown in the ledger straight away,
//  marked as not yet synced, so balances are right immediately and the row
//  does not vanish on reload.
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  const DB_NAME = 'splittywise';
  const STORE = 'outbox';
  const CACHE = 'ledger';
  const VERSION = 2;

  // A cached ledger older than this is thrown away rather than shown; a
  // week-old set of balances is worse than a spinner.
  const CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

  let dbPromise = null;
  let flushing = false;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('No IndexedDB'));
      const req = window.indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(CACHE)) {
          db.createObjectStore(CACHE, { keyPath: 'userId' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    }).catch(function (err) {
      // Private browsing and some locked-down profiles refuse IndexedDB.
      // Offline queueing is then simply unavailable, which is survivable.
      dbPromise = null;
      throw err;
    });
    return dbPromise;
  }

  function tx(mode, fn, which) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        const name = which || STORE;
        const t = db.transaction(name, mode);
        const store = t.objectStore(name);
        const out = fn(store);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
      });
    });
  }

  function localId() {
    return 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  /* ======================= queue ===================================== */

  SW.outbox = {
    // kind: 'create_expense' | 'settlement'
    // args: exactly what the online path would have sent
    // optimistic: a row shaped like the real one, for immediate display
    async add(kind, args, optimistic) {
      const entry = {
        id: localId(),
        kind: kind,
        args: args,
        optimistic: optimistic || null,
        queuedAt: new Date().toISOString(),
      };
      // Stamp the id onto the optimistic row so the ledger and the queue
      // refer to the same thing.
      if (entry.optimistic) entry.optimistic.id = entry.id;
      await tx('readwrite', function (store) { store.put(entry); }, STORE);
      SW.outbox.render();
      return entry.id;
    },

    async all() {
      try {
        const rows = await tx('readonly', function (store) { return store.getAll(); }, STORE);
        return (rows || []).sort(function (a, b) {
          return a.queuedAt < b.queuedAt ? -1 : 1;
        });
      } catch (e) {
        return [];
      }
    },

    async remove(id) {
      await tx('readwrite', function (store) { store.delete(id); }, STORE);
    },

    async count() {
      return (await SW.outbox.all()).length;
    },

    // Add the queued rows to a freshly loaded ledger, so a pending expense
    // counts towards balances instead of disappearing until it syncs.
    async applyPending() {
      if (!SW.ledger) return;
      const rows = await SW.outbox.all();

      rows.forEach(function (entry) {
        if (entry.kind !== 'create_expense' || !entry.optimistic) return;
        const already = SW.ledger.expenses.some(function (e) { return e.id === entry.id; });
        if (!already) SW.ledger.expenses.unshift(entry.optimistic);
      });

      rows.forEach(function (entry) {
        if (entry.kind !== 'settlement' || !entry.optimistic) return;
        const already = SW.ledger.settlements.some(function (s) { return s.id === entry.id; });
        if (!already) SW.ledger.settlements.unshift(entry.optimistic);
      });

      if (SW.bumpLedger) SW.bumpLedger();
    },

    /* ---- sending ---- */

    async flush(opts) {
      if (flushing) return;
      if (!SW.user) return;
      if (!navigator.onLine) return;

      const rows = await SW.outbox.all();
      if (!rows.length) return;

      flushing = true;
      let sent = 0;
      let dropped = 0;

      try {
        for (let i = 0; i < rows.length; i++) {
          const entry = rows[i];
          let error = null;

          try {
            if (entry.kind === 'create_expense') {
              ({ error } = await SW.db.rpc('create_expense', entry.args));
            } else if (entry.kind === 'settlement') {
              ({ error } = await SW.db.from('settlements').insert(entry.args));
            } else {
              error = { message: 'Unknown queued write' };
            }
          } catch (thrown) {
            error = thrown;
          }

          if (!error) {
            await SW.outbox.remove(entry.id);
            sent++;
            continue;
          }

          if (isOffline(error)) {
            // Still no usable connection: stop and keep the queue in order.
            break;
          }

          // The server refused it — a deleted group, someone removed from it,
          // an amount that no longer adds up. Retrying forever would block
          // everything behind it, so drop it and say so.
          await SW.outbox.remove(entry.id);
          dropped++;
          SW.toast('Could not sync "' +
            ((entry.args && entry.args.p_description) || 'a payment') + '": ' +
            (error.message || 'rejected'), 'error');
        }
      } finally {
        flushing = false;
      }

      if (sent) {
        if (SW.refreshLedger) await SW.refreshLedger();
        if (SW.refreshUnread) SW.refreshUnread();
        if (!opts || !opts.quiet) {
          SW.toast(sent === 1 ? 'Synced 1 saved entry' : 'Synced ' + sent + ' saved entries', 'ok');
        }
      } else if (dropped && SW.refreshLedger) {
        await SW.refreshLedger();
      }

      SW.outbox.render();
    },

    async render() {
      const chip = document.getElementById('offline-chip');
      if (!chip) return;
      const n = await SW.outbox.count();
      chip.hidden = n === 0;
      chip.textContent = navigator.onLine
        ? n + ' waiting · tap to sync'
        : n + ' saved offline';
    },
  };

  /* ======================= ledger cache ============================== */

  // Boot latency was entirely the ledger round trip: a blank skeleton until
  // Supabase answered. The cache paints last known balances immediately and
  // the fresh fetch replaces them, so the app opens instantly and corrects
  // itself a moment later.
  //
  // Keyed by user id, so signing into another account never shows the
  // previous one's figures, and dropped on sign-out.
  SW.cache = {
    async save(ledger) {
      if (!ledger || !ledger.me) return;
      try {
        await tx('readwrite', function (store) {
          store.put({
            userId: ledger.me,
            savedAt: Date.now(),
            // Only the raw rows: everything else is derived on load, so
            // caching it would just be a second source of truth.
            data: {
              me: ledger.me,
              friendIds: ledger.friendIds,
              people: ledger.people,
              groups: ledger.groups,
              members: ledger.members,
              myMembership: ledger.myMembership,
              expenses: ledger.expenses.filter(function (e) { return !e.pending; }),
              settlements: ledger.settlements.filter(function (s) { return !s.pending; }),
            },
          });
        }, CACHE);
      } catch (e) {
        // Storage refused or full: the app works, it is just slower to open.
      }
    },

    async load(userId) {
      if (!userId) return null;
      try {
        const row = await tx('readonly', function (store) {
          return store.get(userId);
        }, CACHE);
        if (!row || !row.data) return null;
        if (Date.now() - (row.savedAt || 0) > CACHE_MAX_AGE_MS) {
          SW.cache.clear(userId);
          return null;
        }
        return row.data;
      } catch (e) {
        return null;
      }
    },

    async clear(userId) {
      try {
        await tx('readwrite', function (store) {
          if (userId) store.delete(userId);
          else store.clear();
        }, CACHE);
      } catch (e) { /* nothing to do */ }
    },
  };

  // A failed fetch, rather than a rejection from the server.
  function isOffline(error) {
    if (!navigator.onLine) return true;
    const msg = String((error && error.message) || error || '').toLowerCase();
    return msg.indexOf('failed to fetch') > -1 ||
           msg.indexOf('networkerror') > -1 ||
           msg.indexOf('network request failed') > -1 ||
           msg.indexOf('load failed') > -1;
  }
  SW.isOfflineError = isOffline;

  /* ======================= triggers ================================== */

  window.addEventListener('online', function () {
    SW.toast('Back online — syncing');
    SW.outbox.flush();
  });
  window.addEventListener('offline', function () {
    SW.outbox.render();
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') SW.outbox.flush({ quiet: true });
  });

  const chip = document.getElementById('offline-chip');
  if (chip) chip.addEventListener('click', function () {
    if (!navigator.onLine) return SW.toast('Still offline — it will go when you reconnect');
    SW.outbox.flush();
  });
})();
