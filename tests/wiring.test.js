// Run from the repo root:  node tests/wiring.test.js
//
// Checks that the app is actually wired together: that every RPC the client
// calls exists with the arguments it passes, that every column it selects
// exists, that every button does something, and that every screen can render.
// These are the failures that never throw — they just quietly do nothing.
const fs = require('fs');
const path = require('path');
const glob = (d, ext) => fs.readdirSync(d).filter(f => f.endsWith(ext)).map(f => d + '/' + f);
process.chdir(path.join(__dirname, '..'));

const html = fs.readFileSync('index.html', 'utf8');
const schema = fs.readFileSync('supabase/schema.sql', 'utf8');
const jsFiles = glob('js', '.js');
const js = Object.fromEntries(jsFiles.map(f => [f, fs.readFileSync(f, 'utf8')]));
const allJs = Object.values(js).join('\n');

let fails = 0;
function check(label, ok, detail) {
  if (!ok) fails++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + label +
    (ok || detail === undefined ? '' : '\n         ' + JSON.stringify(detail)));
}

/* ---------------- schema introspection ---------------- */

const tables = {};
for (const m of schema.matchAll(/create table if not exists public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
  tables[m[1]] = m[2].split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^(constraint|primary key|unique|check|foreign key)\b/i.test(l))
    .map(l => (l.match(/^(\w+)/) || [])[1])
    .filter(Boolean);
}

const functions = {};
for (const m of schema.matchAll(/create or replace function public\.(\w+)\s*\(([\s\S]*?)\)\s*returns/g)) {
  functions[m[1]] = [...m[2].matchAll(/(?:^|,)\s*(p_\w+)/g)].map(x => x[1]);
}

console.log('--- schema ---');
const NEEDED_TABLES = ['profiles','friendships','groups','group_members','expenses',
  'expense_splits','expense_payers','settlements','notifications','invites'];
check('every expected table parsed',
  NEEDED_TABLES.every(t => tables[t]), NEEDED_TABLES.filter(t => !tables[t]));
const NEEDED_FNS = ['create_expense','update_expense','create_group',
  'add_friend_by_email','add_group_member_by_email','add_group_members',
  'create_invite','redeem_invite','mark_all_notifications_read'];
check('every callable function parsed',
  NEEDED_FNS.every(f => functions[f]), NEEDED_FNS.filter(f => !functions[f]));

/* ---------------- 1. every RPC exists, with the args passed ---------------- */

console.log('\n--- RPCs the client calls ---');
const rpcCalls = [];
for (const [file, src] of Object.entries(js)) {
  for (const m of src.matchAll(/\.rpc\(\s*'(\w+)'\s*(?:,\s*(\{[\s\S]*?\n\s*\})|,\s*(\{[^{}]*\}))?/g)) {
    const body = m[2] || m[3] || '';
    rpcCalls.push({
      file, name: m[1],
      args: [...body.matchAll(/(p_\w+)\s*:/g)].map(x => x[1]),
    });
  }
}
// create_expense/update_expense build their args object separately.
const argObjects = [...allJs.matchAll(/const args = \{([\s\S]*?)\n      \};/g)]
  .flatMap(m => [...m[1].matchAll(/(p_\w+)\s*:/g)].map(x => x[1]));
const extraArgs = [...allJs.matchAll(/args\.(p_\w+)\s*=/g)].map(m => m[1]);

check('at least 6 distinct RPCs used',
  new Set(rpcCalls.map(c => c.name)).size >= 6,
  [...new Set(rpcCalls.map(c => c.name))]);

const missingFns = rpcCalls.filter(c => !functions[c.name]).map(c => c.name + ' (' + c.file + ')');
check('every RPC exists in schema.sql', missingFns.length === 0, missingFns);

const badArgs = [];
for (const c of rpcCalls) {
  if (!functions[c.name]) continue;
  // create_expense and update_expense share one args object built above, so
  // their arguments can only be validated against the union of both
  // signatures. That still catches a misspelled parameter name.
  const known = c.name.endsWith('_expense')
    ? [].concat(functions.create_expense || [], functions.update_expense || [])
    : functions[c.name];
  const passed = c.name.endsWith('_expense') ? c.args.concat(argObjects, extraArgs) : c.args;
  for (const a of new Set(passed)) {
    if (!known.includes(a) && a.startsWith('p_')) {
      // Only complain if this arg is plausibly for this function.
      if (c.name === 'create_expense' || c.name === 'update_expense' || c.args.includes(a)) {
        badArgs.push(c.name + ' <- ' + a);
      }
    }
  }
}
check('every RPC argument is a real parameter', badArgs.length === 0, badArgs);

/* ---------------- 1b. every grant matches its function ---------------- */

// `grant execute on function f(wrong, types)` is a hard error that aborts
// the whole schema script, and the signatures have changed several times.
console.log('\n--- grants ---');
const sigOf = {};
for (const m of schema.matchAll(
    /create or replace function public\.(\w+)\s*\(([\s\S]*?)\)\s*returns/g)) {
  const types = m[2].split(',')
    .map(x => x.trim())
    .filter(Boolean)
    // "p_amount numeric" / "gid uuid" / "p_day int default null"
    .map(x => (x.split(/\s+/)[1] || '').replace(/,$/, ''))
    .filter(Boolean);
  if (!(m[1] in sigOf)) sigOf[m[1]] = types;
}

const grantProblems = [];
for (const m of schema.matchAll(
    /grant execute on function public\.(\w+)\s*\(([^)]*)\)/g)) {
  const name = m[1];
  const granted = m[2].replace(/\n/g, ' ').split(',')
    .map(x => x.trim()).filter(Boolean);
  if (!(name in sigOf)) { grantProblems.push(name + ' is granted but never defined'); continue; }
  const defined = sigOf[name];
  if (granted.join(',') !== defined.join(',')) {
    grantProblems.push(name + ': granted (' + granted.join(', ') +
                       ') but defined (' + defined.join(', ') + ')');
  }
}
check('every grant signature matches its function',
  grantProblems.length === 0, grantProblems);
console.log('  ' + Object.keys(sigOf).length + ' functions defined');

// Supabase refuses a direct delete from the storage tables, and it aborts
// the script when it happens.
check('no direct delete from the storage tables',
  !/delete\s+from\s+storage\./i.test(schema));

/* ---------------- 1b2. the profile select covers what is read ------------- */

// A column that exists in the schema but is not in the select list reads as
// undefined, which looks exactly like "the user never set it". That is how a
// saved photo, UPI ID and both preference blobs reverted on every reopen.
console.log('\n--- profile columns ---');
const profileSelect = (js['js/auth.js'].match(
  /from\('profiles'\)[\s\S]{0,400}?\.select\(((?:\s*'[^']*'\s*\+?)+)\)/) || [, ''])[1]
  .replace(/'\s*\+\s*'/g, '').replace(/'/g, '');
const selected = new Set(profileSelect.split(',').map(x => x.trim()).filter(Boolean));

const readCols = new Set();
for (const src of Object.values(js)) {
  for (const m of src.matchAll(/SW\.profile(?:\s*\|\|\s*\{\})?\)?\.([a-z_]+)/g)) {
    readCols.add(m[1]);
  }
}
// Read off the local `p` alias in renderAccount too.
for (const m of (js['js/shell.js'] || '').matchAll(/\bp\.(avatar_path|upi_id|notify_prefs|ui_prefs|avatar_emoji|full_name|email)\b/g)) {
  readCols.add(m[1]);
}
const notSelected = [...readCols].filter(c => !selected.has(c));
check('every profile column the app reads is selected',
  notSelected.length === 0, notSelected);
console.log('  selects ' + selected.size + ', reads ' + readCols.size);

/* ---------------- 1c. delete triggers cannot reference cascading rows ------- */

// notifications.expense_id and .group_id both cascade. A BEFORE DELETE
// trigger that writes either one references a row being removed in the same
// statement, which is a foreign key violation and reaches the client as a
// 409. This is what broke deleting a group that had expenses in it.
console.log('\n--- delete triggers ---');
const deleteTriggerFns = [];
for (const m of schema.matchAll(
    /create trigger \w+\s+before delete on public\.\w+\s+for each row execute function public\.(\w+)\(\)/g)) {
  deleteTriggerFns.push(m[1]);
}
const cascadeRefs = [];
for (const fn of deleteTriggerFns) {
  const body = (schema.match(
    new RegExp('create or replace function public\\.' + fn +
               '\\(\\)[\\s\\S]*?\\nend \\$\\$;')) || [''])[0];
  const insert = (body.match(/insert into public\.notifications\s*\(([^)]*)\)/) || [, ''])[1];
  for (const col of ['group_id', 'expense_id']) {
    if (insert.indexOf(col) > -1) cascadeRefs.push(fn + ' writes ' + col);
  }
}
check(deleteTriggerFns.length + ' before-delete triggers, none writing a cascading column',
  cascadeRefs.length === 0, cascadeRefs);

/* ---------------- 2. every selected / written column exists ---------------- */

console.log('\n--- columns the client touches ---');
const colProblems = [];

for (const [file, src] of Object.entries(js)) {
  // .from('t').select('a, b, nested(x, y)')
  for (const m of src.matchAll(/\.from\('(\w+)'\)\s*\.select\(\s*((?:'[^']*'\s*\+?\s*)+)/g)) {
    const table = m[1];
    if (!tables[table]) { colProblems.push(file + ': unknown table ' + table); continue; }
    const raw = m[2].replace(/'\s*\+\s*'/g, '').replace(/'/g, '');
    // Pull nested selects out and validate them against their own table.
    const nested = [...raw.matchAll(/(\w+)\(([^)]*)\)/g)];
    let flat = raw;
    for (const n of nested) {
      flat = flat.replace(n[0], '');
      const nt = tables[n[1]];
      if (!nt) { colProblems.push(file + ': unknown nested table ' + n[1]); continue; }
      for (const c of n[2].split(',').map(x => x.trim()).filter(Boolean)) {
        if (!nt.includes(c)) colProblems.push(file + ': ' + n[1] + '.' + c);
      }
    }
    for (const c of flat.split(',').map(x => x.trim()).filter(Boolean)) {
      if (c === '*' || c.startsWith('{')) continue;
      if (!tables[table].includes(c)) colProblems.push(file + ': ' + table + '.' + c);
    }
  }

  // .from('t').insert({ ... }) / .update({ ... })
  for (const m of src.matchAll(/\.from\('(\w+)'\)\s*\n?\s*\.(insert|update)\(\s*\{([\s\S]*?)\}\)/g)) {
    const table = m[1];
    if (!tables[table]) { colProblems.push(file + ': unknown table ' + table); continue; }
    for (const c of [...m[3].matchAll(/^\s*(\w+)\s*:/gm)].map(x => x[1])) {
      if (!tables[table].includes(c)) colProblems.push(file + ': ' + table + '.' + c + ' (write)');
    }
  }

  // .eq('col', ...) immediately following a .from('t')
  for (const m of src.matchAll(/\.from\('(\w+)'\)([\s\S]{0,400}?)(?=\n\n|\n  \}|$)/g)) {
    const table = m[1];
    if (!tables[table]) continue;
    for (const e of [...m[2].matchAll(/\.eq\('(\w+)'/g)].map(x => x[1])) {
      if (!tables[table].includes(e)) colProblems.push(file + ': ' + table + '.' + e + ' (filter)');
    }
  }
}
check('every column referenced exists', colProblems.length === 0, [...new Set(colProblems)]);

/* ---------------- 3. every button does something ---------------- */

console.log('\n--- interactive elements ---');
const buttonIds = [...html.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map(m => m[1]);
// Buttons carrying data-go are handled by a delegated listener in ui.js.
const delegated = new Set(
  [...html.matchAll(/<button[^>]*\bid="([^"]+)"[^>]*\bdata-go=/g)].map(m => m[1])
    .concat([...html.matchAll(/<button[^>]*\bdata-go=[^>]*\bid="([^"]+)"/g)].map(m => m[1]))
);
const orphanButtons = buttonIds.filter(id =>
  !delegated.has(id) &&
  !allJs.includes("getElementById('" + id + "')") &&
  !allJs.includes('#' + id)
);
check(buttonIds.length + ' buttons with ids, all handled',
  orphanButtons.length === 0, orphanButtons);

// Delegated controls: every data-* hook used in markup must be read somewhere.
const dataHooks = [...new Set([...html.matchAll(/\sdata-([a-z-]+)=/g)].map(m => m[1]))]
  .filter(h => !['theme', 'screen', 'view', 'pane', 'pane-btn'].includes(h));
const unreadHooks = dataHooks.filter(h => !allJs.includes('data-' + h));
check('every data-* hook in markup is read by some module',
  unreadHooks.length === 0, unreadHooks);

/* ---------------- 4. every screen and view can render ---------------- */

console.log('\n--- screens and views ---');
const screens = [...new Set([...html.matchAll(/data-screen="([a-z-]+)"/g)].map(m => m[1]))];
const uiScreens = (js['js/ui.js'].match(/const SCREENS = \[([^\]]*)\]/) || [, ''])[1]
  .split(',').map(s => s.trim().replace(/'/g, '')).filter(Boolean);
check('every screen is registered in ui.js',
  screens.every(s => uiScreens.includes(s)), screens.filter(s => !uiScreens.includes(s)));

const views = [...new Set([...html.matchAll(/data-view="([a-z-]+)"/g)].map(m => m[1]))];
const registered = [...js['js/shell.js'].matchAll(/^\s+'?([a-z-]+)'?:\s+\{ tab:/gm)].map(m => m[1]);
const hooks = [...new Set([...allJs.matchAll(/SW\.viewHooks(?:\.|\[')([a-z-]+)/g)].map(m => m[1]))];
check('every view is registered in shell.js',
  views.every(v => registered.includes(v)), views.filter(v => !registered.includes(v)));
check('every view has a render hook',
  views.every(v => hooks.includes(v)), views.filter(v => !hooks.includes(v)));

const paramRoutes = (js['js/auth.js'].match(/PARAM_ROUTES = \{([^}]*)\}/s) || [, ''])[1];
const appViews = (js['js/auth.js'].match(/APP_VIEWS = \[([^\]]*)\]/) || [, ''])[1];
const routable = views.filter(v =>
  appViews.includes("'" + v + "'") || paramRoutes.includes("'" + v + "'"));
check('every view is reachable by a route',
  routable.length === views.length, views.filter(v => !routable.includes(v)));

/* ---------------- 5. element ids resolve ---------------- */

console.log('\n--- element ids ---');
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const runtimeIds = new Set([...allJs.matchAll(/id="(\w[\w-]*)"/g)].map(m => m[1])
  .concat([...allJs.matchAll(/\bid = '([\w-]+)'/g)].map(m => m[1])));

// A module that builds an id from a variable — `id="' + id + '"` — can
// create any of the id-shaped literals it holds, so those count as
// generated. Without this the check reports elements that do exist.
for (const src of Object.values(js)) {
  if (!/id="'\s*\+/.test(src)) continue;
  for (const m of src.matchAll(/'([a-z][a-z0-9]*(?:-[a-z0-9]+)+)'/g)) {
    runtimeIds.add(m[1]);
  }
}
const unresolved = [];
for (const [file, src] of Object.entries(js)) {
  for (const id of [...src.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1])) {
    if (!htmlIds.has(id) && !runtimeIds.has(id)) unresolved.push(file + ': #' + id);
  }
}
check('every getElementById resolves to static or generated markup',
  unresolved.length === 0, unresolved);

/* ---------------- 6. svg symbols ---------------- */

const defined = new Set([...html.matchAll(/<(?:symbol|g) id="([^"]+)"/g)].map(m => m[1]));
const usedSym = new Set([...html.matchAll(/<use href="#([^"]+)"/g)].map(m => m[1])
  .concat([...allJs.matchAll(/<use href="#([a-z-]+)"/g)].map(m => m[1])));
check('every <use> points at a defined symbol',
  [...usedSym].every(s => defined.has(s)), [...usedSym].filter(s => !defined.has(s)));

/* ---------------- 7. offline shell is complete ---------------- */

console.log('\n--- offline shell ---');
const loaded = [...html.matchAll(/<script src="(js\/[a-z]+\.js)"><\/script>/g)].map(m => m[1]);
const cached = [...fs.readFileSync('sw.js', 'utf8').matchAll(/'\.\/(js\/[a-z]+\.js)'/g)].map(m => m[1]);
check('every script on the page is cached by the service worker',
  loaded.every(f => cached.includes(f)), loaded.filter(f => !cached.includes(f)));
check('every cached script exists on disk',
  cached.every(f => fs.existsSync(f)), cached.filter(f => !fs.existsSync(f)));
check('every module on disk is loaded by the page',
  jsFiles.every(f => loaded.includes(f)), jsFiles.filter(f => !loaded.includes(f)));

/* ---------------- 8. no spinner shows unless its button is busy ---------------- */

console.log('\n--- loading states ---');
const css = fs.readFileSync('css/app.css', 'utf8');
check('spinners are hidden inside any button, not only .btn',
  /button \.spinner \{ display: none/.test(css));
check('.is-loading reveals them',
  /button\.is-loading \.spinner \{ display: block/.test(css));
// Every button carrying a spinner must be driven through SW.busy.
const spinnerButtons = [...html.matchAll(/<button[^>]*\bid="([^"]+)"[^>]*>(?:(?!<\/button>)[\s\S])*?class="spinner"/g)]
  .map(m => m[1]);
const undriven = spinnerButtons.filter(id =>
  !new RegExp("busy\\(\\s*(this|document\\.getElementById\\('" + id + "'\\)|btn)").test(allJs));
check(spinnerButtons.length + ' spinner buttons are driven by SW.busy',
  undriven.length === 0, undriven);

/* ---------------- 9. every SW.* call resolves ---------------- */

// Cross-module calls are the quietest failure in the app: most are written
// as `if (SW.thing) SW.thing()`, so a misspelled name does nothing at all
// and raises nothing.
console.log('\n--- cross-module calls ---');
const swDefined = new Set();
for (const src of Object.values(js)) {
  for (const m of src.matchAll(/SW\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) swDefined.add(m[1]);
  // Properties hung off SW by assignment inside object literals, e.g.
  // SW.viewHooks.friends = fn
  for (const m of src.matchAll(/SW\.(viewHooks)\b/g)) swDefined.add(m[1]);
}
// Set by the harness rather than assigned in js/.
['user', 'profile', 'session', 'db', 'ledger', 'isConfigured', 'initialHash',
 'currentScreen', 'isTouch', 'activityStale', 'currentFriendId', 'currentGroupId',
 'currentExpenseId', 'APP_VIEWS', 'MIN_PASSWORD', 'CATEGORIES', 'SPLIT_MODES',
 'EMOJI_GROUPS'].forEach(n => swDefined.add(n));

const called = new Map();
for (const [file, src] of Object.entries(js)) {
  for (const m of src.matchAll(/SW\.([A-Za-z_$][\w$]*)/g)) {
    if (!called.has(m[1])) called.set(m[1], file);
  }
}
const unresolvedCalls = [...called.entries()]
  .filter(([name]) => !swDefined.has(name))
  .map(([name, file]) => file + ': SW.' + name);
check('every SW.* reference is assigned somewhere',
  unresolvedCalls.length === 0, unresolvedCalls);
console.log('  ' + swDefined.size + ' names defined, ' + called.size + ' referenced');

/* ---------------- 10. stacked text actually stacks ---------------- */

// These are rendered as <span> pairs inside a flex item. The parent gets
// blockified but the children do not, so without an explicit display they
// flow inline and the subtitle lands beside the title instead of under it.
console.log('\n--- stacked title/subtitle pairs ---');
const mustBlock = ['row-title', 'row-sub', 'ledger-title', 'ledger-sub',
                   'pl-text', 'pl-sub', 'set-title', 'set-sub'];
const notBlock = mustBlock.filter(cls => {
  const rule = new RegExp('\\.' + cls + '\\b[^{]*\\{([^}]*)\\}', 'g');
  let found = false;
  for (const m of css.matchAll(rule)) if (/display:\s*block/.test(m[1])) found = true;
  return !found;
});
check('every stacked pair is display:block', notBlock.length === 0, notBlock);

// And a check switched on by its own class must have a rule for that.
check('.sp-check.is-on is styled', /\.sp-check\.is-on/.test(css));

/* ---------------- 11. local helpers are defined where used ---------------- */

// A module using esc() without defining it throws a ReferenceError that
// kills the whole handler, and nothing in the SW.* check catches it because
// the name is a local. This is the bug that broke the UPI sheet.
console.log('\n--- local helpers ---');
const HELPERS = ['esc', 'db', 'today', 'parseAmount'];
const undefinedLocals = [];
for (const [file, src] of Object.entries(js)) {
  for (const name of HELPERS) {
    const uses = (src.match(new RegExp('\\b' + name + '\\(', 'g')) || []).length;
    if (!uses) continue;
    const declared = new RegExp(
      '(?:const|let|var|function)\\s+' + name + '\\b').test(src);
    if (!declared) undefinedLocals.push(file + ': ' + name + '() used ' + uses + 'x');
  }
  // `db` is used as a value rather than called. Only a BARE `db.` counts —
  // `SW.db.auth` is qualified and needs no local.
  const usesBareDb = /(^|[^.\w])db\./m.test(src.replace(/SW\.db/g, 'SW_DB'));
  if (usesBareDb && !/(?:const|let|var)\s+db\b/.test(src)) {
    undefinedLocals.push(file + ': db never declared');
  }
}
check('every local helper used is declared in that module',
  undefinedLocals.length === 0, undefinedLocals);

check('uncaught errors are surfaced to the user',
  /addEventListener\('error'/.test(js['js/ui.js']) &&
  /unhandledrejection/.test(js['js/ui.js']));

/* ---------------- 12. every CSS token is defined at the base ---------------- */

// A token whose only definition sits inside a media query or a [data-theme]
// block does not exist for the default "system" viewer, and the page then
// renders one theme's text on the other theme's ground.
console.log('\n--- theme tokens ---');
// Every bare `:root { }` block, not just the first — the palette is declared
// across a few of them. `:root:not(...)` and `:root[data-theme=...]` do not
// match this pattern, which is the point.
const baseTokens = new Set();
for (const block of css.matchAll(/:root\s*\{([\s\S]*?)\}/g)) {
  for (const t of block[1].matchAll(/(--[\w-]+)\s*:/g)) baseTokens.add(t[1]);
}
// Declared anywhere at all, including inside a media or [data-theme] block.
const anyTokens = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
const usedTokens = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map(m => m[1]));

const undefinedTokens = [...usedTokens].filter(t => !anyTokens.has(t));
check('every var() resolves to a declaration', undefinedTokens.length === 0, undefinedTokens);

const themeOnly = [...usedTokens].filter(t => anyTokens.has(t) && !baseTokens.has(t));
check('no token is defined only inside a theme block',
  themeOnly.length === 0, themeOnly);
console.log('  ' + baseTokens.size + ' tokens at :root, ' + usedTokens.size + ' used');

// The body must paint its own ground, or it borrows the host page's.
check('body sets an explicit background token',
  /body\s*\{[^}]*background:\s*var\(--/.test(css));

// color-mix() is Safari 16.2+. Where it sets a background, an older Safari
// drops the declaration and the element turns transparent, so each one needs
// a plain colour immediately before it.
const cssLines = css.split('\n');
const unguardedMix = cssLines.filter(function (line, i) {
  if (!/background[^:]*:\s*color-mix/.test(line)) return false;
  return !/background/.test(cssLines[i - 1] || '');
}).map(function (l) { return l.trim().slice(0, 60); });
check('every color-mix background has a fallback before it',
  unguardedMix.length === 0, unguardedMix);

/* ---------------- 13. accessibility floor ---------------- */

console.log('\n--- accessibility ---');
check('keyboard focus is visible', /:focus-visible/.test(css));
check('reduced motion is respected', /prefers-reduced-motion/.test(css));
const inputsNoLabel = [...html.matchAll(/<input(?![^>]*type="hidden")[^>]*>/g)]
  .map(m => m[0])
  .filter(tag => !/aria-label=/.test(tag) && !/\bid="([^"]+)"/.test(tag));
check('every input is labelled or has an id a label points at',
  inputsNoLabel.length === 0, inputsNoLabel.map(t => t.slice(0, 60)));
check('the page declares a language', /<html lang="/.test(html));
check('viewport allows zoom',
  !/user-scalable\s*=\s*no/.test(html) && !/maximum-scale\s*=\s*1/.test(html));

/* ---------------- 14. no leftover placeholders ---------------- */

console.log('\n--- placeholders ---');
const stale = [];
for (const [file, src] of Object.entries(js)) {
  for (const m of src.matchAll(/'[^']*\b(arrives in phase|coming soon|not implemented|TODO)\b[^']*'/gi)) {
    stale.push(file + ': ' + m[0]);
  }
}
if (/phase \d+ of \d+/i.test(html)) stale.push('index.html: phase counter in the UI');
if (/data-todo/.test(html)) stale.push('index.html: data-todo stub');
check('no placeholder text left in the app', stale.length === 0, stale);

/* ---------------- 15. buttons that only look destructive ---------------- */

// A sheet's `cancel:` is only a label on the close button. Two sheets said
// "Delete this category" and "Remove the date" on a button that did nothing
// but close — no error, no clue. Anything that reads as destructive has to
// go through destroy/onDestroy, which actually runs something.
console.log('\n--- destructive actions ---');

const fakeDestroy = [];
for (const [file, src] of Object.entries(js)) {
  for (const m of src.matchAll(/cancel:\s*([^\n]*)/g)) {
    if (/\b(delete|remove|discard|turn\s+\w+\s+off|clear)\b/i.test(m[1])) {
      fakeDestroy.push(file + ': cancel: ' + m[1].trim().slice(0, 60));
    }
  }
}
check('no cancel button is labelled as if it destroys something',
  fakeDestroy.length === 0, fakeDestroy);

const orphanDestroy = [];
for (const [file, src] of Object.entries(js)) {
  const declares = (src.match(/\bdestroy:/g) || []).length;
  const handles = (src.match(/\bonDestroy:/g) || []).length;
  if (declares !== handles) {
    orphanDestroy.push(file + ': ' + declares + ' destroy: vs ' + handles + ' onDestroy:');
  }
}
check('every destroy: label has an onDestroy: to run', orphanDestroy.length === 0,
  orphanDestroy);
check('SW.sheet implements the destroy button',
  /opts\.destroy\s*&&\s*opts\.onDestroy/.test(js['js/ui.js']) &&
  /active\.onDestroy\(/.test(js['js/ui.js']));
check('the destructive button has a style of its own', /\.btn-danger\s*\{/.test(css));

/* ---------------- 16. the settle-up day ---------------- */

console.log('\n--- settle-up day ---');
check('settle_up_day replaced the one-off date in the schema',
  /settle_up_day\s+int/.test(schema) && tables.groups.includes('settle_up_day'));
check('the old settle_up_on column is migrated, then dropped',
  /update public\.groups[\s\S]{0,200}settle_up_day = extract\(day from settle_up_on\)/.test(schema) &&
  /alter table public\.groups drop column settle_up_on/.test(schema));
const staleDate = Object.entries(js)
  .filter(([, src]) => /settle_up_on/.test(src))
  .map(([f]) => f);
check('no client code still reads settle_up_on', staleDate.length === 0, staleDate);
check('the reminder function exists', !!functions.run_due_settle_reminders ||
  /function public\.run_due_settle_reminders\(\)/.test(schema));
check('and the client calls it at launch',
  /rpc\('run_due_settle_reminders'\)/.test(allJs));
check('it only ever writes to the caller’s own feed',
  /insert into public\.notifications[\s\S]{0,120}select me, null, 'settle_reminder'/.test(schema));
check('it dedupes per calendar month',
  /date_trunc\('month', current_date\)/.test(schema));
check('a day past the end of a short month still fires',
  /least\(\s*g\.settle_up_day/.test(schema));
check('the two ordinal helpers agree',
  /function sw\.ordinal_day/.test(schema) && /SW\.ordinalDay\s*=/.test(allJs));

/* ---------------- 17. you hear about your own actions ---------------- */

console.log('\n--- self-notifications ---');

// Every fan-out used to end `where ... <> me`, which is why adding an
// expense left no trace in your own Activity.
const stillExcludes = [...schema.matchAll(/where[^;]*?\buser_id <> me\b/g)].map(m => m[0].trim());
check('no notification fan-out excludes the actor any more',
  stillExcludes.length === 0, stillExcludes);
check('your own rows land already read, so the bell stays quiet',
  /is_read\)/.test(schema) && /sp\.user_id = me\b/.test(schema));
check('and read as your own doing',
  /'You added "'/.test(schema) && /'You changed "'/.test(schema));
check('the feed can be told to hide them',
  /own_actions/.test(js['js/shell.js']));
check('the unread count applies the same rule as the feed',
  /select\('type, actor_id'\)/.test(js['js/shell.js']) &&
  /\.filter\(visible\)/.test(js['js/shell.js']));

// A type with no icon falls back to a bell, which is how settle_reminder
// and comment sat there looking like nudges.
const emittedTypes = new Set();
for (const m of schema.matchAll(/type, [\w, ]*?\)\s*(?:values\s*\(|select[\s\S]{0,80}?)[^;]*?'(\w+)'\s*,/g)) {
  emittedTypes.add(m[1]);
}
const iconMap = (js['js/shell.js'].match(/const TYPE_EMOJI = \{([\s\S]*?)\};/) || [, ''])[1];
const noIcon = [...emittedTypes].filter(t => !iconMap.includes(t + ':'));
check('every notification type the schema emits has an icon', noIcon.length === 0, noIcon);

/* ---------------- 18. exporting is a download ---------------- */

console.log('\n--- export ---');
check('export asks before it downloads',
  /opts\.confirmed/.test(js['js/insights.js']) &&
  /confirm: 'Download'/.test(js['js/insights.js']));
check('and says how many rows it is about to write',
  /rowCount/.test(js['js/insights.js']));

/* ---------------- 19. icons say what they do ---------------- */

console.log('\n--- icons ---');
const gear = (html.match(/id="ic-gear"[\s\S]*?<\/symbol>/) || [''])[0];
check('the settings icon is a cog, not a brightness dial',
  gear.includes('19.14') && !/M12 3v2\.2/.test(gear));

/* ---------------- 20. the itemised row reads as a sum ---------------- */

console.log('\n--- itemised rows ---');
check('quantity and amount are joined by an =',
  /class="ir-eq"/.test(js['js/scan.js']) && /\.ir-eq\s*\{/.test(css));

/* ---------------- 21. new ids exist ---------------- */

console.log('\n--- new controls exist in the markup ---');
['ins-headline', 'ins-eyebrow', 'ins-subline', 'ins-stats',
 'email-switch', 'email-notify-sub'].forEach(id => {
  check('#' + id + ' is in index.html', html.includes('id="' + id + '"'));
});
check('the day picker is built where the sheet expects it',
  /id="gs-f-day"/.test(js['js/groupsettings.js']));
check('email notifications are opt-in in the schema',
  /email_notify\s+boolean not null default false/.test(schema));
check('the client selects email_notify, or the switch would reset',
  /email_notify/.test(js['js/auth.js']));
check('the email function refuses an unsigned webhook',
  /x-webhook-secret/.test(fs.readFileSync('netlify/functions/notify-email.mjs', 'utf8')));
check('and never emails you about your own action',
  /if \(row\.is_read\) return/.test(fs.readFileSync('netlify/functions/notify-email.mjs', 'utf8')));

/* ---------------- 22. making a category where you need one ---------------- */

console.log('\n--- categories ---');
check('a custom category can actually be deleted',
  /from\('user_categories'\)\.delete\(\)/.test(js['js/categories.js']));
check('one can be created from the expense form',
  /data-newcat/.test(js['js/expense.js']) && /SW\.addCategory\(/.test(js['js/expense.js']));
check('and the expense form is put back afterwards',
  /goingToNew/.test(js['js/expense.js']));

/* ---------------- 23. filling in the forced figure ---------------- */

console.log('\n--- the derived split field ---');
check('the rule lives in balances.js, where it is testable',
  /SW\.deriveBlank\s*=/.test(js['js/balances.js']));
check('the expense form uses it rather than its own copy',
  /SW\.deriveBlank\(/.test(js['js/expense.js']));
check('typing in the filled field hands it back to you',
  /if \(f\.autofilled === id\) f\.autofilled = null;/.test(js['js/expense.js']));
check('switching split mode forgets it',
  /f\.autofilled = null;/.test(js['js/expense.js']));

/* ---------------- 24. settling everything by UPI ---------------- */

console.log('\n--- settle all ---');
check('settle-all offers the payment app when it is all one way',
  /sa-upi/.test(js['js/settle.js']));
check('and not when the debts run both ways',
  /!mixed && total < 0 && p\.upi_id/.test(js['js/settle.js']));

/* ---------------- 25. the README cannot go stale ---------------- */

// It told a fresh reader to "expect exactly these eight" tables when there
// were sixteen, which reads as a broken setup rather than a stale document.
console.log('\n--- the README matches the schema ---');
const readme = fs.readFileSync('README.md', 'utf8');
const tableNames = Object.keys(tables);
const missingFromReadme = tableNames.filter(t => !readme.includes(t));
check('every table is named in the README', missingFromReadme.length === 0,
  missingFromReadme);
const claimed = (readme.match(/(\d+) tables/) || [])[1];
check('the README’s table count is right (' + tableNames.length + ')',
  Number(claimed) === tableNames.length, { claimed, actual: tableNames.length });
const policies = (schema.match(/create policy/g) || []).length;
const claimedPolicies = (readme.match(/(\d+)\s*\n?row-level-security policies/) ||
                         readme.match(/(\d+) row-level-security policies/) || [])[1];
check('and its policy count is right (' + policies + ')',
  Number(claimedPolicies) === policies, { claimed: claimedPolicies, actual: policies });
const suites = fs.readdirSync('tests').filter(f => f.endsWith('.test.js')).length;
const words = ['zero','one','two','three','four','five','six','seven','eight',
  'nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen',
  'seventeen','eighteen','nineteen','twenty'];
check('the suite count in the README is right (' + suites + ')',
  readme.toLowerCase().includes(words[suites] + ' suites'), words[suites] + ' suites');

// Nothing in the repo should still address the original author.
const addressed = [];
for (const m of readme.matchAll(/^.*\b(as you said|you said you|your MyExpenseTracker)\b.*$/gim)) {
  addressed.push(m[0].trim().slice(0, 70));
}
check('the README is written for a stranger, not its author',
  addressed.length === 0, addressed);
check('and says to replace the committed Supabase credentials',
  /replace both values/i.test(readme));

/* ---------------- 26. the secret scanner ---------------- */

console.log('\n--- Netlify secret scanning ---');
const toml = fs.readFileSync('netlify.toml', 'utf8');
const omit = (toml.match(/SECRETS_SCAN_OMIT_KEYS\s*=\s*"([^"]*)"/) || [, ''])[1];
check('the public Supabase keys are exempt, or the build fails',
  omit.includes('SUPABASE_URL'));
check('and the service_role key is NOT exempt',
  !omit.includes('SERVICE_ROLE'));
// The previous version of this check matched the warning comment in
// config.js telling you never to commit that key — a false positive that
// would have been silenced rather than fixed. Look for a real key: a JWT
// whose base64 payload claims the service_role.
const leaked = [];
for (const [file, src] of Object.entries({ ...js, 'index.html': html,
                                           'netlify.toml': toml })) {
  for (const m of src.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})/g)) {
    let claims = '';
    try { claims = Buffer.from(m[1], 'base64url').toString('utf8'); } catch (e) { /* not a JWT */ }
    if (/service_role/.test(claims)) leaked.push(file);
  }
}
check('no service_role key is committed anywhere', leaked.length === 0, leaked);

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
