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

/* ---------------- 11. no leftover placeholders ---------------- */

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

console.log('\n' + (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
