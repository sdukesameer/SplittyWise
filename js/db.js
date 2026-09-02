// ---------------------------------------------------------------------------
//  Supabase client
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  const cfg = window.SPLITTYWISE_CONFIG || {};
  const url = cfg.SUPABASE_URL || '';
  const key = cfg.SUPABASE_ANON_KEY || '';

  SW.isConfigured =
    url.startsWith('https://') &&
    !url.includes('YOUR-PROJECT-REF') &&
    key.length > 40 &&
    !key.includes('YOUR-ANON');

  if (!SW.isConfigured) {
    // Fail loudly and legibly rather than throwing an opaque network error
    // on the first query.
    document.addEventListener('DOMContentLoaded', function () {
      document.body.innerHTML =
        '<div style="max-width:34rem;margin:14vh auto;padding:0 1.5rem;' +
        'font-family:system-ui,sans-serif;color:#E8EFEC;line-height:1.6">' +
        '<h1 style="font-size:1.4rem;margin:0 0 .6rem">SplittyWise is not configured yet</h1>' +
        '<p style="color:#8A9A94;margin:0 0 1rem">Open <code>js/config.js</code> and paste your ' +
        'Supabase project URL and anon public key. Both are in your Supabase dashboard under ' +
        '<strong>Project Settings &rarr; API</strong>.</p>' +
        '<p style="color:#66766F;font-size:.9rem;margin:0">Step-by-step instructions are in ' +
        '<code>README.md</code>.</p></div>';
      document.body.style.background = '#141817';
    });
    return;
  }

  // createClient consumes and clears any auth params in the URL hash, so
  // stash the incoming hash first — that is how we know whether this page
  // load came from a password-recovery link or a dead one.
  SW.initialHash = window.location.hash || '';

  SW.db = window.supabase.createClient(url, key, {
    auth: {
      persistSession: true,       // survives an app reopen
      autoRefreshToken: true,
      detectSessionInUrl: true,   // consumes tokens from email links
      // Implicit rather than PKCE on purpose: email links are frequently
      // opened in a different browser than the one that requested them, and
      // PKCE cannot complete without the original browser's code verifier.
      flowType: 'implicit',
      storageKey: 'splittywise.auth',
    },
  });
})();
