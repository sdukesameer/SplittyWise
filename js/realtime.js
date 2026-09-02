// ---------------------------------------------------------------------------
//  Realtime — a friend's expense shows up without a refresh
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const db = SW.db;
  let channel = null;
  let lastSync = 0;

  // Anything that changes money needs the ledger refetched; a friend request
  // only needs the bell.
  const LEDGER_TYPES = ['expense_added', 'settlement', 'group_added'];

  SW.startRealtime = function () {
    if (!SW.user || channel) return;

    channel = db
      .channel('sw-notifications-' + SW.user.id)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: 'user_id=eq.' + SW.user.id,
      }, function (payload) {
        const n = payload.new || {};

        if (SW.refreshUnread) SW.refreshUnread();
        if (n.title) SW.toast(n.title);

        if (LEDGER_TYPES.indexOf(n.type) > -1 && SW.refreshLedger) {
          SW.refreshLedger();
        }
        // If the user is sitting on the Activity tab, repaint it too.
        if (SW.activeView && SW.activeView() === 'activity' && SW.viewHooks.activity) {
          SW.activityStale = true;
          SW.viewHooks.activity();
        }
      })
      .subscribe();
  };

  SW.stopRealtime = function () {
    if (!channel) return;
    db.removeChannel(channel);
    channel = null;
  };

  // Realtime can drop silently — a sleeping phone, a lost tunnel. Coming back
  // to the app always resyncs, so a missed message is at worst stale until
  // the next glance rather than lost.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    if (!SW.user) return;

    const now = Date.now();
    if (now - lastSync < 4000) return;   // debounce rapid tab switching
    lastSync = now;

    if (SW.refreshUnread) SW.refreshUnread();
    if (SW.refreshLedger) SW.refreshLedger();
  });
})();
