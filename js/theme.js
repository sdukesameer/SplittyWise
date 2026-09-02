// Runs before first paint so the page never flashes the wrong theme.
// A separate file rather than an inline <script>, so the CSP need not
// allow inline script.
(function () {
  try {
    var t = localStorage.getItem('splittywise.theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    if (localStorage.getItem('splittywise.black') === '1') {
      document.documentElement.setAttribute('data-black', '1');
    }
  } catch (e) {
    // localStorage throws outright in some privacy modes; the default is fine.
  }
})();
