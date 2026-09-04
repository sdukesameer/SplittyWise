// Runs before first paint so the page never flashes the wrong theme — or,
// as it turned out, the wrong accent. A separate file rather than an inline
// <script>, so the CSP need not allow inline script.
//
// The accent list lives here rather than in shell.js because this is the
// only file that runs early enough to apply it before the first frame.
// shell.js reads SW.ACCENTS from here, so there is one copy.
window.SW = window.SW || {};

SW.ACCENTS = [
  // One hex cannot hold its contrast on both a dark and a light ground, so
  // each accent carries a variant for each. These are the values that were
  // in shell.js; moving them here is a move, not a redesign.
  { key: 'teal',   light: '#0E9878', dark: '#1FC69E' },
  { key: 'indigo', light: '#4F46E5', dark: '#8B93F8' },
  { key: 'rose',   light: '#C2185B', dark: '#F06292' },
  { key: 'amber',  light: '#B26A00', dark: '#F0A85C' },
  { key: 'violet', light: '#7C3AED', dark: '#A78BFA' },
  { key: 'sky',    light: '#0369A1', dark: '#4CB5E8' },
];

SW.applyAccent = function (key) {
  const found = SW.ACCENTS.filter(function (a) { return a.key === key; })[0];
  const root = document.documentElement;

  // Only override when it is not the built-in accent, so the designed
  // palette is left exactly as it is by default.
  if (!found || key === 'teal') {
    root.style.removeProperty('--teal');
    root.style.removeProperty('--teal-press');
    root.style.removeProperty('--teal-soft');
  } else {
    const dark = root.getAttribute('data-theme') === 'dark' ||
      (!root.getAttribute('data-theme') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    const hex = dark ? found.dark : found.light;
    root.style.setProperty('--teal', hex);
    root.style.setProperty('--teal-press', hex);
    root.style.setProperty('--teal-soft', hex + '22');
  }

  document.querySelectorAll('[data-accent]').forEach(function (b) {
    b.classList.toggle('is-on', b.getAttribute('data-accent') === (key || 'teal'));
  });
};

SW.readAccent = function () {
  try { return localStorage.getItem('splittywise.accent') || 'teal'; }
  catch (e) { return 'teal'; }
};

(function () {
  try {
    const t = localStorage.getItem('splittywise.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    if (localStorage.getItem('splittywise.black') === '1') {
      document.documentElement.setAttribute('data-black', '1');
    }
  } catch (e) {
    // localStorage throws outright in some privacy modes; the default is fine.
  }

  // Before the first frame. Applying this from shell.js meant every launch
  // painted the default teal and then snapped to the saved accent — which
  // reads exactly like the colour resetting itself.
  try { SW.applyAccent(SW.readAccent()); } catch (e) { /* default is fine */ }
})();
