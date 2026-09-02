// ---------------------------------------------------------------------------
//  Locking the app behind Face ID or a fingerprint
//
//  It is a record of who owes whom, sitting unlocked on a home screen.
//  WebAuthn handles this without a password, using the platform
//  authenticator already on the device.
//
//  There is always a way past it: signing out. Being permanently locked out
//  of your own ledger by a lost credential would be far worse than the risk
//  this guards against.
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  if (!SW.isConfigured) return;

  const KEY = 'splittywise.lock';
  const CRED = 'splittywise.lockCred';

  const available = !!(window.PublicKeyCredential && navigator.credentials &&
                       window.isSecureContext);
  SW.lockAvailable = available;

  function enabled() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function credId() {
    try { return localStorage.getItem(CRED) || ''; } catch (e) { return ''; }
  }

  SW.lockEnabled = enabled;

  function b64ToBytes(b64) {
    const pad = b64.replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(pad + '==='.slice((pad.length + 3) % 4));
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function bytesToB64(buf) {
    const bytes = new Uint8Array(buf);
    let str = '';
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomBytes(n) {
    const b = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(b);
    return b;
  }

  /* ======================= turning it on ============================= */

  SW.enableLock = async function () {
    if (!available) {
      SW.toast('This device cannot do that', 'error');
      return false;
    }
    try {
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: randomBytes(32),
          rp: { name: 'SplittyWise' },
          user: {
            // Only ever used on this device, so the id need not be a secret.
            id: b64ToBytes(bytesToB64(new TextEncoder().encode(SW.user.id))),
            name: (SW.profile && SW.profile.email) || 'you',
            displayName: (SW.profile && SW.profile.full_name) || 'You',
          },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 },
                             { type: 'public-key', alg: -257 }],
          authenticatorSelection: {
            authenticatorAttachment: 'platform',
            userVerification: 'required',
            residentKey: 'preferred',
          },
          timeout: 60000,
          attestation: 'none',
        },
      });
      if (!cred) return false;

      localStorage.setItem(CRED, bytesToB64(cred.rawId));
      localStorage.setItem(KEY, '1');
      SW.toast('Lock turned on', 'ok');
      return true;
    } catch (err) {
      SW.toast(err.name === 'NotAllowedError'
        ? 'Cancelled'
        : 'Could not set that up on this device', 'error');
      return false;
    }
  };

  SW.disableLock = function () {
    try {
      localStorage.removeItem(KEY);
      localStorage.removeItem(CRED);
    } catch (e) { /* ignore */ }
    SW.toast('Lock turned off', 'ok');
  };

  /* ======================= getting past it =========================== */

  async function verify() {
    const id = credId();
    try {
      const got = await navigator.credentials.get({
        publicKey: {
          challenge: randomBytes(32),
          allowCredentials: id
            ? [{ type: 'public-key', id: b64ToBytes(id) }]
            : [],
          userVerification: 'required',
          timeout: 60000,
        },
      });
      return !!got;
    } catch (e) {
      return false;
    }
  }

  // Called at boot, before anything is painted. Resolves once the app may
  // be shown.
  SW.checkLock = function () {
    if (!enabled() || !available) return Promise.resolve(true);

    return new Promise(function (resolve) {
      SW.show('lock');
      SW.hideBoot();

      const unlock = document.getElementById('lock-unlock');
      const out = document.getElementById('lock-signout');

      async function attempt() {
        SW.busy(unlock, true);
        const ok = await verify();
        SW.busy(unlock, false);
        if (ok) return resolve(true);
        SW.toast('Not recognised — try again', 'error');
      }

      unlock.addEventListener('click', attempt);

      out.addEventListener('click', async function () {
        // The escape hatch. Without it a lost credential would mean a
        // permanently unreachable ledger.
        SW.disableLock();
        await SW.db.auth.signOut();
        window.location.reload();
      });

      // Ask straight away; iOS shows the sheet without a further tap.
      attempt();
    });
  };
})();
