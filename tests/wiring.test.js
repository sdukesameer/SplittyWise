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

// Comments are not code, and neither is prose inside a string. Four checks
// have now failed by matching one: the "never commit this key" warning in
// config.js, an env var named in an error message, a comment reading
// "deliberately NOT signOut()", and a length cap that a growing comment
// pushed a select() out of range.
//
// noComments keeps string contents, for checks that need to read them.
// codeOnly blanks those too, for checks asserting something is ABSENT.
function noComments(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

// SQL comments start with -- and run to the end of the line. Same trap, a
// different language: a check for the absence of gen_random_bytes matched
// the comment explaining why it is not used.
function noSqlComments(src) {
  return String(src || '').replace(/--[^\n]*/g, ' ');
}

// CSS has only /* */ comments. Same trap a third time: the check that this
// stylesheet no longer contains `margin-left: 83px` matched the comment
// explaining why it does not.
function noCssComments(src) {
  return String(src || '').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function codeOnly(src) {
  return noComments(src)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

let fails = 0;
let ran = 0;
function check(label, ok, detail) {
  ran++;
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

// Columns added later by `alter table ... add column` count too. Reading only
// the create-table blocks made every such column look like it did not exist —
// profiles.is_admin and expenses.items both read as typos.
for (const m of schema.matchAll(
  /alter table\s+public\.(\w+)\s+add column\s+(?:if not exists\s+)?(\w+)/gi)) {
  const [, table, col] = m;
  if (tables[table] && !tables[table].includes(col)) tables[table].push(col);
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

// The revoke loop strips `authenticated` too, so the grant list is now the
// whole story: an RPC the client calls and the list omits fails at runtime.
// run_due_settle_reminders was in exactly that state — it worked only
// because Supabase's default ACL had granted it, and closing that hole
// revealed the gap.
const clientRpcs = new Set();
for (const src of Object.values(js)) {
  for (const m of src.matchAll(/rpc\('(\w+)'/g)) clientRpcs.add(m[1]);
}
const grantedTo = new Set(
  [...schema.matchAll(/grant execute on function public\.(\w+)\s*\(/g)].map((m) => m[1]));
const ungranted = [...clientRpcs].filter((r) => !grantedTo.has(r));
check('every RPC the client calls is granted to authenticated',
  ungranted.length === 0, ungranted);
console.log('  ' + clientRpcs.size + ' RPCs called by the client');
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
// Comments are stripped first: the gap between from('profiles') and
// .select() is explanatory prose, and a length cap on it made this check
// fail the moment that comment grew — which looks exactly like a missing
// column and is not one.
const profileSelect = (noComments(js['js/auth.js']).match(
  /from\('profiles'\)[\s\S]{0,200}?\.select\(((?:\s*'[^']*'\s*\+?)+)\)/) || [, ''])[1]
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

for (const [file, rawSrc] of Object.entries(js)) {
  // Comments stripped first. A `//` line inside a concatenated select string
  // stopped the pattern mid-expression and left a stray `+` looking like a
  // column named "+" — which reads as a missing column and is not one.
  const src = noComments(rawSrc);

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
// The admin console is a second page on purpose, so its module is loaded
// there and must NOT be in the app's bundle or its offline cache — an
// ordinary user should never download it.
const adminHtml = fs.readFileSync('admin.html', 'utf8');
const adminLoaded = [...adminHtml.matchAll(/<script src="(js\/[a-z]+\.js)"><\/script>/g)]
  .map(m => m[1]);

check('every module on disk is loaded by one of the two pages',
  jsFiles.every(f => loaded.includes(f) || adminLoaded.includes(f)),
  jsFiles.filter(f => !loaded.includes(f) && !adminLoaded.includes(f)));
check('the admin module is not in the app page',
  !loaded.includes('js/admin.js'));
check('nor in the offline cache',
  !cached.some(f => f.indexOf('admin') > -1), cached.filter(f => f.indexOf('admin') > -1));
check('the service worker leaves the console alone entirely',
  /indexOf\('\/admin'\) === 0/.test(fs.readFileSync('sw.js', 'utf8')));
check('and the console is not indexable',
  /noindex/.test(adminHtml) && /X-Robots-Tag/.test(fs.readFileSync('netlify.toml', 'utf8')));

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
// It used to only ever write to the caller. Now pg_cron calls it for
// everybody at local midnight, so what matters instead is that a signed-in
// user cannot reach the everybody version.
check('the launch path asks only for the caller',
  /return sw\.raise_settle_reminders\(me\)/.test(schema));
check('and the everybody version is not granted to signed-in users',
  !/grant execute on function sw\.raise_settle_reminders/.test(schema) &&
  !/grant execute on function public\.cron_settle_reminders/.test(schema));
check('a reminder is skipped when there is nothing to settle',
  /if body is null then continue; end if;/.test(schema) &&
  /if round\(mine, 2\) = 0 then return null; end if;/.test(schema));
check('the body says what to settle, not just the date',
  /'You owe ' \|\| sw\.money/.test(schema) &&
  /'You are owed ' \|\| sw\.money/.test(schema) &&
  /since you last settled here/.test(schema));
check('midnight is decided in a configurable timezone',
  /extract\(hour from local\)::int <> 0/.test(schema) &&
  /admin_set_timezone/.test(schema));
check('and the timezone is validated against Postgres’s own list',
  /from pg_timezone_names where name = wanted/.test(schema));
check('pg_cron is enabled and scheduled in separate blocks',
  (function () {
    // The first version put `create extension` and an unschedule in one
    // block; unschedule raises on a name it does not know, which rolled the
    // extension back with it, so pg_cron silently never installed.
    const ext = schema.indexOf('create extension if not exists pg_cron');
    const unsched = schema.indexOf("cron.unschedule('splittywise-settle-reminders')");
    const between = schema.slice(ext, unsched);
    return ext > -1 && unsched > ext && /end \$\$;/.test(between);
  })());
check('the SQL balance is cross-checked against the app’s',
  fs.existsSync('scripts/net-crosscheck.mjs') &&
  /nets\)/.test(fs.readFileSync('scripts/db', 'utf8')));
check('and it mirrors the payer_id fallback, or the two disagree',
  /else case when e\.payer_id = uid then e\.amount else 0 end/.test(schema));
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
  /!mixed && total < 0/.test(js['js/settle.js']));
// Showing nothing when the other person has no UPI ID read as "this app
// cannot open a payment app", rather than "we do not know where to send it".
check('and says why when there is no UPI id to send to',
  (js['js/settle.js'].match(/has not added a UPI ID/g) || []).length === 2);

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
// .mjs too: the receipt reader is an ES module, so its suite has to be one.
const suites = fs.readdirSync('tests')
  .filter(f => f.endsWith('.test.js') || f.endsWith('.test.mjs')).length;
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

/* ---------------- 27. administration ---------------- */

console.log('\n--- administration ---');
const adminJs = js['js/admin.js'];
const adminFn = fs.readFileSync('netlify/functions/admin.mjs', 'utf8');
// Declared here rather than beside the layout checks: `const` is hoisted
// but not initialised, so a later block reading it threw a ReferenceError
// that killed the run before the summary line — which looked like the suite
// passing quietly rather than crashing.
const adminCss = fs.readFileSync('css/admin.css', 'utf8');

// admin.html loads css/app.css as well as css/admin.css, so any attribute
// the app's stylesheet already styles will silently apply to the console
// too. data-pane was the first casualty: app.css hides it, so every tab
// button vanished while the panes survived on class specificity, and the
// console rendered with no navigation at all.
const appAttrs = [...css.matchAll(/\[(data-[a-z-]+)\]/g)].map(m => m[1]);
const consoleAttrs = [...(adminHtml + js['js/admin.js'])
  .matchAll(/\b(data-[a-z-]+)\s*=/g)].map(m => m[1]);
const collisions = [...new Set(consoleAttrs.filter(a => appAttrs.includes(a)))];
check('no console attribute is one the app stylesheet already styles',
  collisions.length === 0, { collisions, styledByApp: [...new Set(appAttrs)] });

// Same trap for the classes that carry layout, as opposed to the ones the
// console reuses on purpose (btn, input, field, switch, sheet…).
check('the console names its own panes and tabs distinctly',
  /data-adpane/.test(adminHtml) && /\.ad-pane\b/.test(
    fs.readFileSync('css/admin.css', 'utf8')));
check('every console tab has a pane, and the reverse',
  (function () {
    const tabs = [...adminHtml.matchAll(/class="ad-tab[^"]*"\s+data-adpane="([a-z]+)"/g)]
      .map(m => m[1]);
    const panes = [...adminHtml.matchAll(/class="ad-pane[^"]*"\s+data-adpane="([a-z]+)"/g)]
      .map(m => m[1]);
    return tabs.length >= 5 && tabs.every(t => panes.includes(t)) &&
           panes.every(pn => tabs.includes(pn));
  })());

check('there is no admin password anywhere',
  !/ADMIN_PASSWORD|admin_password/i.test(
    codeOnly(adminJs) + codeOnly(adminFn) + schema + toml));
check('the console signs in with a real Supabase account',
  /signInWithPassword/.test(adminJs));

// Both pages are the same origin and share localStorage — but only if they
// agree on the storage key. They did not, so the console could not see the
// session the app had already written, and an admin who was plainly signed
// in was asked to sign in again.
const appKey = (js['js/db.js'].match(/storageKey:\s*'([^']+)'/) || [])[1];
const conKey = (adminJs.match(/storageKey:\s*'([^']+)'/) || [])[1];
check('both pages read the session from the same storage key',
  !!appKey && appKey === conKey, { app: appKey, console: conKey });
check('and agree on the auth flow',
  (js['js/db.js'].match(/flowType:\s*'([^']+)'/) || [])[1] ===
  (adminJs.match(/flowType:\s*'([^']+)'/) || [])[1]);
check('an existing session goes straight into the console',
  /getSession\(\)\.then/.test(adminJs) && /return afterSignIn\(\)/.test(adminJs));
check('and the form is not shown while that is still being checked',
  /id="ad-boot"/.test(adminHtml) && /show\('boot'\)/.test(adminJs) === false &&
  /which !== 'boot'/.test(adminJs));

// The session is shared, so signing out here signs the person out of the
// app. Doing that because they opened a URL without being an admin was
// destructive; only an explicit button may do it.
const adminCode = codeOnly(adminJs);
const adminCheckFail = (adminCode.match(
  /catch \(err\) \{[\s\S]*?return setError\(/) || [''])[0];
check('a non-admin visitor is not signed out of the app',
  adminCheckFail.length > 0 && !/signOut/.test(adminCheckFail),
  adminCheckFail.slice(0, 120));
check('signing out is only ever an explicit choice',
  (adminCode.match(/signOut\(\)/g) || []).length === 2 &&
  /ad-signout/.test(adminJs) && /ad-use-other/.test(adminJs),
  (adminCode.match(/signOut\(\)/g) || []).length);
check('the console page never reads a server environment',
  !/process\.env/.test(adminJs) && /process\.env/.test(adminFn));
check('and the key is used only in the function',
  /SUPABASE_SERVICE_ROLE_KEY/.test(adminFn) &&
  !/apikey:\s*SUPABASE_SERVICE_ROLE_KEY|Bearer.*SERVICE_ROLE/.test(adminJs));
check('the function verifies the caller’s token before anything else',
  /auth\/v1\/user/.test(adminFn) && /is_admin !== true/.test(adminFn));
// An anonymous POST used to be answered with the deploy's configuration
// state, which is not an outsider's business. The cheapest check that needs
// no configuration has to come first.
check('an unsigned request is refused before the config is mentioned',
  adminFn.indexOf('if (!bearer)') > -1 &&
  adminFn.indexOf('Not configured:') > -1 &&
  adminFn.indexOf('if (!bearer)') < adminFn.indexOf('Not configured:'));
// The error used to assert one variable name regardless of which was
// actually missing, which sent someone who had already set that one looking
// in the wrong place.
check('a missing variable is named, not guessed',
  /missing\.push\('SUPABASE_URL'\)/.test(adminFn) &&
  /missing\.push\('SUPABASE_SERVICE_ROLE_KEY'\)/.test(adminFn) &&
  /missing\.join\(/.test(adminFn));
check('and the page repeats that message rather than inventing one',
  /body\.error \|\|/.test(adminCode) &&
  !/Set SUPABASE_SERVICE_ROLE_KEY in Netlify/.test(adminCode));
check('only the two variables that are genuinely needed are required',
  !/if \(!SUPABASE_ANON_KEY\)\s*missing/.test(adminFn) &&
  /SUPABASE_ANON_KEY \|\| SUPABASE_SERVICE_ROLE_KEY/.test(adminFn));

// create-user adds to the allow list so invite-only does not block the
// admin's own creation. Deleting or blocking has to take it back out, or a
// removed account stays permanently entitled to register again.
// Scoped to each case block: a file-wide search would pass just because
// create-user writes to the same table, which is the opposite of the point.
const caseBlock = (name) =>
  (adminFn.match(new RegExp("case '" + name + "': \\{[\\s\\S]*?\\n      \\}")) || [''])[0];

check('blocking an address clears its allow-list entry',
  /allowed_emails\?email=eq\./.test(caseBlock('ban')) &&
  /DELETE/.test(caseBlock('ban')), caseBlock('ban').length);
check('and so does deleting the account',
  /allowed_emails\?email=eq\./.test(caseBlock('delete-user')) &&
  /DELETE/.test(caseBlock('delete-user')), caseBlock('delete-user').length);
check('create-user still adds it, or invite-only blocks the admin itself',
  /allowed_emails/.test(caseBlock('create-user')) &&
  /merge-duplicates/.test(caseBlock('create-user')));

/* ---------------- 28b. offline, and what is new ---------------- */

console.log('\n--- offline and fresh rows ---');
check('Activity has an offline state of its own',
  /id="activity-offline"/.test(html) &&
  /navigator\.onLine/.test(js['js/shell.js']));
check('and being offline does not raise an error toast',
  /looksOffline/.test(js['js/shell.js']) &&
  /if \(!looksOffline\)/.test(js['js/shell.js']));
check('a dropped request counts as offline too',
  /failed to fetch\|networkerror\|load failed/i.test(js['js/shell.js']));
check('reconnecting reloads it without being asked',
  /addEventListener\('online'/.test(js['js/shell.js']));
check('the unread count stays quiet offline',
  /Offline the count cannot change/.test(js['js/shell.js']));
check('new rows are highlighted, and only once per session',
  /is-fresh/.test(js['js/shell.js']) && /seenActivity/.test(js['js/shell.js']));
check('and the highlight fades on its own',
  /is-fading/.test(js['js/shell.js']) && /\}, 5000\)/.test(js['js/shell.js']) &&
  /\.list-row\.is-fresh\.is-fading/.test(css));
check('the fade respects reduced motion',
  /prefers-reduced-motion[\s\S]{0,200}is-fading/.test(css));

/* ---------------- 28c. retention ---------------- */

console.log('\n--- retention ---');
check('error reports are purged after 30 days',
  /delete from public\.error_reports where at < now\(\) - interval '30 days'/.test(schema));
check('the audit trail after a year',
  /delete from public\.admin_audit\s+where at < now\(\) - interval '365 days'/.test(schema));
check('read notifications after 90 days',
  /is_read and created_at < now\(\) - interval '90 days'/.test(schema));
check('but an unread notification is never purged',
  /where is_read and created_at/.test(schema));
check('and the console shows the size, so the question is answerable',
  /db_bytes/.test(schema) && /bytes\(s\.db_bytes\)/.test(adminJs));

/* ---------------- 28d. links and mail ---------------- */

console.log('\n--- links and mail ---');
check('the mail sender is shared, not copied into each function',
  fs.existsSync('netlify/lib/mail.mjs') &&
  /from '\.\.\/lib\/mail\.mjs'/.test(adminFn) &&
  /from '\.\.\/lib\/mail\.mjs'/.test(
    fs.readFileSync('netlify/functions/notify-email.mjs', 'utf8')));
check('a single-use link can be emailed to the admin, not to its subject',
  /to: prof\.email/.test(adminFn));
check('and it can be copied',
  /clipboard\.writeText/.test(adminJs));
// Returning true from an onConfirm that opened a sheet closes the sheet it
// just opened. That is why "Act as them" appeared to do nothing at all.
check('the act-as sheet does not close the sheet it opens',
  /or SW\.sheet closes the sheet showLink\(\) has just opened/.test(adminJs));
check('there is a way to prove email works without waiting for an event',
  fs.existsSync('netlify/functions/email-test.mjs') &&
  /email-test/.test(js['js/shell.js']));
check('and it only ever mails the caller’s own address',
  /to: me\.email/.test(fs.readFileSync('netlify/functions/email-test.mjs', 'utf8')));
check('the switch says your own actions never email',
  /never for your own actions/.test(js['js/shell.js']));

/* ---------------- 28e. invite links ---------------- */

console.log('\n--- invite links ---');
// pgcrypto lives in the `extensions` schema on Supabase, and create_invite
// pins search_path = public — so gen_random_bytes was invisible and every
// invite failed with "function gen_random_bytes(integer) does not exist".
const schemaCode = noSqlComments(schema);
check('no schema function calls an extension-schema function',
  !/gen_random_bytes|uuid_generate_v4|pgp_sym_/.test(schemaCode));
check('the invite token comes from core Postgres',
  /replace\(gen_random_uuid\(\)::text, '-', ''\)/.test(schema));

/* ---------------- 28f. collapsible sections ---------------- */

console.log('\n--- long lists in the console ---');
check('a person’s sections collapse when they are long',
  /function section\(/.test(adminJs) && /<details class="ad-sect"/.test(adminJs));
check('and each keeps its own state',
  /\.ad-sect > summary/.test(adminCss));
check('groups, friends, expenses and payments all use it',
  (adminJs.match(/section\('/g) || []).length >= 4,
  (adminJs.match(/section\('/g) || []).length);

/* ---------------- 29. the console's layout ---------------- */

console.log('\n--- console layout ---');
// The grid's column counts and the number of tiles have to agree, or the
// last row goes ragged — which is what prompted the rework in the first
// place. Checked as arithmetic rather than as fixed numbers, so adding a
// tile fails here instead of quietly looking wrong.
const tileCount = (adminJs.match(/\{ k: '/g) || []).length;
const cols = [...adminCss.matchAll(/grid-template-columns: repeat\((\d+), minmax\(0, 1fr\)\)/g)]
  .map(m => Number(m[1]));
check('the stat grid declares fixed column counts', cols.length >= 2, cols);
check('the wide grid divides the tiles exactly (' + tileCount + ' tiles)',
  cols.some(c => tileCount % c === 0), { tileCount, cols });
check('and a leftover tile on a narrow screen stretches instead of stranding',
  /\.ad-stat:last-child:nth-child\(odd\) \{ grid-column: 1 \/ -1/.test(adminCss));
check('a tile is a grid, so its number lines up with its neighbours',
  /\.ad-stat \{[^}]*grid-template-rows/.test(adminCss));
check('list rows put their actions in a fixed column',
  /\.ad-item \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/.test(adminCss));
check('form actions are right-aligned with equal widths',
  /\.ad-form-actions \{[^}]*justify-content: flex-end/.test(adminCss) &&
  /\.ad-form-actions \.btn \{[^}]*min-width/.test(adminCss));
check('the per-person actions are an even grid, not a ragged row',
  /\.ad-actions-grid \{/.test(adminCss) && /ad-actions-grid/.test(adminJs));
check('the tab row lines up with the cards beneath it',
  (adminCss.match(/\.ad-tabs \{[\s\S]*?padding: 0 (\d+)px/) || [])[1] ===
  (adminCss.match(/\.ad-pane \{[^}]*padding: \d+px (\d+)px/) || [])[1]);
check('no inline heading styles are left in the console',
  !/style="font-size:12px;text-transform:uppercase/.test(adminJs));
check('sheet sub-headings use the shared class',
  /\.ad-sub \{/.test(adminCss) && /class="ad-sub"/.test(adminJs));

// Every admin_* function is security definer, so a missing caller check is
// unrestricted access. The live audit checks this too; this catches it
// before it is ever applied.
const adminFns = [...schema.matchAll(
  /create or replace function public\.(admin_\w+)\s*\(([\s\S]*?)\$\$;/g)];
check('every admin_* function is defined', adminFns.length >= 12, adminFns.length);
const unchecked = adminFns
  .filter(m => !/sw\.is_admin\(/.test(m[2]))
  .map(m => m[1]);
check('every admin_* function checks is_admin on entry',
  unchecked.length === 0, unchecked);

const definer = adminFns.filter(m => !/security definer/.test(m[0])).map(m => m[1]);
check('and every one is security definer', definer.length === 0, definer);

check('is_admin is guarded by a NULL-safe trigger',
  /coalesce\(current_setting\('splittywise\.granting_admin', true\), 'no'\)/.test(schema));
check('no current_setting comparison is left NULL-unsafe',
  [...schema.matchAll(/current_setting\([^)]*, true\)\s*(?:<>|=)/g)].length === 0,
  [...schema.matchAll(/current_setting\([^)]*, true\)\s*(?:<>|=)/g)].map(m => m[0]));

check('the signup gate is enforced in the trigger, not only the form',
  /banned_emails where email = addr/.test(schema) &&
  /signups_enabled/.test(schema) && /invite_only/.test(schema));
check('and the form degrades to allowing signup if it cannot check',
  /return null;\s*\/\/ offline, or running without the functions/.test(js['js/auth.js']));
check('client failures are reported for the console to show',
  /SW\.reportError/.test(js['js/ui.js']) && /error_reports/.test(js['js/ui.js']));
check('the attack suite switches role, or its RLS tests prove nothing',
  /set local role authenticated/.test(fs.readFileSync('supabase/security-tests.sql', 'utf8')));

/* ---------------- 28. undoing a payment ---------------- */

console.log('\n--- undoing a payment ---');
check('only the most recent payment can be undone, in the schema',
  /Only the most recent payment can be undone/.test(schema));
const undoFn = (schema.match(
  /create or replace function public\.undo_settlement[\s\S]*?\$\$;/) || [''])[0];
check('undo_settlement exists', undoFn.length > 0);
check('undo is a soft delete, never a delete',
  /set deleted_at = now\(\)/.test(undoFn) && !/delete\s+from/.test(undoFn));
check('it refuses anyone the money did not move between',
  /not in \(row_s\.from_user, row_s\.to_user, row_s\.created_by\)/.test(undoFn));
check('and refuses one that is already undone',
  /already been undone/.test(undoFn));
check('the client mirrors the same rule rather than inventing one',
  /SW\.undoableSettlement\s*=/.test(js['js/balances.js']) &&
  /undoableSettlement\(/.test(js['js/groups.js']) &&
  /undoableSettlement\(/.test(js['js/friends.js']));
check('both sides are notified',
  /'settlement_undone'/.test(schema) &&
  /settlement_undone/.test(js['js/shell.js']) &&
  /settlement_undone/.test(adminFn.length ? fs.readFileSync('netlify/functions/notify-email.mjs', 'utf8') : ''));
check('payments now appear on the group timeline',
  /SW\.groupSettlements\s*=/.test(js['js/balances.js']) &&
  /groupSettlements\(/.test(js['js/groups.js']));
check('the settled-history fold covers payments too',
  /SW\.settledCutoff\(rows\)/.test(js['js/groups.js']));
check('the undo chip has a handler on both timelines',
  /data-undo/.test(js['js/groups.js']) && /data-undo/.test(js['js/friends.js']) &&
  (js['js/friends.js'].match(/friend-ledger'\)\.addEventListener/) || []).length === 1);
check('and the chip is styled', /\.undo-chip\s*\{/.test(css));
check('the ledger selects deleted_at, or the client filter is vacuous',
  /created_at, deleted_at/.test(js['js/balances.js']));

/* ---------------- 30. text must wrap, not vanish ---------------- */

// A subtitle set to `white-space: nowrap` in a flex row whose text column
// had no `min-width: 0` refused to shrink, and shoved the switch beside it
// clean off the card — so "Round to whole rupees" had no visible toggle.
console.log('\n--- responsive text ---');

const ruleBodies = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(m => ({
  sel: m[1].trim().split('\n').pop().trim(),
  body: m[2],
}));

// Anything still truncating has to be a control whose layout wrapping would
// break — a chip or a segmented button — never a sentence.
const CHIPS = ['.header-action', '.chip', '.split-modes button', '.pending-chip',
               '.undo-chip', '.admin-chip'];
const truncating = ruleBodies
  .filter(r => /nowrap/.test(r.body))
  .map(r => r.sel)
  .filter(sel => !CHIPS.includes(sel));
check('no sentence is truncated instead of wrapping', truncating.length === 0, truncating);

// A flex child defaults to min-width:auto and will not shrink below its
// content, which is what pushed the switch out of view.
// Judged per selector across the whole file, not per rule: a media query
// that re-declares `flex` does not undo a `min-width: 0` set in the base
// rule, and flagging it would be a false positive.
const minWidthFor = {};
ruleBodies.forEach(r => {
  if (/min-width/.test(r.body)) minWidthFor[r.sel] = true;
});
const cannotShrink = [...new Set(ruleBodies
  .filter(r => /flex:\s*1\b/.test(r.body) && !minWidthFor[r.sel])
  .map(r => r.sel))]
  .filter(sel => !/\.input$|input\[|\.app-main|\.skel-lines|pb-spacer/.test(sel));
check('every flex text column can shrink', cannotShrink.length === 0, cannotShrink);

check('the switch rows in particular', /\.switch-row \.grow \{[^}]*min-width: 0/.test(css));
check('and long unbroken strings break rather than overflow',
  /\.set-sub \{[\s\S]{0,200}overflow-wrap: anywhere/.test(css));

/* ---------------- 31. reading a value off a chart ---------------- */

console.log('\n--- chart hover ---');
const hover = js['js/charthover.js'];
check('the helper is shared by both pages, not copied',
  /<script src="js\/charthover\.js">/.test(html) &&
  /<script src="js\/charthover\.js">/.test(adminHtml));
check('it is cached for offline use',
  cached.includes('js/charthover.js'));
check('and loaded before the charts that use it',
  html.indexOf('js/charthover.js') < html.indexOf('js/insights.js'));
check('pointer events, so a tap works as well as a hover',
  /pointermove/.test(hover) && /pointerdown/.test(hover) &&
  !/\bonmouseover|addEventListener\('mouseover'/.test(hover));
check('a touch does not dismiss on leave, having nowhere to go',
  /pointerType === 'mouse'/.test(hover));
check('the hit areas are focusable, so it works without a pointer',
  /tabindex="0"/.test(hover));
check('the tooltip is kept inside the chart',
  /Math\.max\(4, Math\.min\(/.test(hover));

check('the admin chart has one hit area per day',
  /SW\.chartHit\(i, PAD_L \+ step \* i/.test(adminJs) &&
  /attachChartHover\(host, tips\)/.test(adminJs));
check('and names all three series in the tooltip',
  (adminJs.match(/\['(expenses|signups|errors)'/g) || []).length >= 3);
check('the app’s month bars are hoverable too',
  /SW\.chartHit\(/.test(js['js/insights.js']) &&
  /attachChartHover\(barHost/.test(js['js/insights.js']));
check('the donut has none, because its legend already shows everything',
  /legend beneath it already prints/.test(js['js/insights.js']));

/* ---------------- 32. reaching the console from the app ---------------- */

console.log('\n--- the way into the console ---');
check('the Account tab links to it',
  /id="admin-link"/.test(html) && /href="admin\.html"/.test(html));
check('hidden unless you are an admin',
  /adminLink\.hidden = !p\.is_admin/.test(js['js/shell.js']));
check('and is_admin is selected, or the link never appears',
  selected.has('is_admin'));
check('it is a link, so the installed app opens it in the same window',
  /<a class="admin-chip"/.test(html));
check('/admin is inside the manifest scope',
  (function () {
    const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
    const scope = m.scope || '/';
    return scope === '/' || scope === './' || '/admin'.indexOf(scope) === 0;
  })());

/* ---------------- 33. this round's fixes ---------------- */

console.log('\n--- scope, links and categories ---');

// `db` is declared inside SW.loadLedger, so a sibling function using the
// bare name throws ReferenceError. Every avatar signing attempt did, and it
// only surfaced because that function reports its own failures.
const balances = js['js/balances.js'];
// Braces are counted on the comment- and string-stripped source. Counting
// them on the raw text ran off the end — a `{` inside a string literal never
// balances — so llEnd stayed at the file length, the avatar code was treated
// as being INSIDE loadLedger, and this check silently tested nothing.
const balancesCode = codeOnly(balances);
const llStart = balancesCode.indexOf('SW.loadLedger =');
let depth = 0, llEnd = -1;
for (let i = llStart; i < balancesCode.length; i++) {
  if (balancesCode[i] === '{') depth++;
  else if (balancesCode[i] === '}') { depth--; if (depth === 0) { llEnd = i; break; } }
}
check('loadLedger’s extent could be found at all', llStart > -1 && llEnd > llStart,
  { llStart, llEnd });
const outside = balancesCode.slice(0, llStart) + balancesCode.slice(llEnd);
check('no bare `db.` outside loadLedger, where it is declared',
  !/(^|[^.\w])db\./.test(outside),
  (outside.match(/(^|[^.\w])db\.\w+/g) || []).slice(0, 4));
check('avatar signing goes through SW.db',
  /SW\.db\.storage\.from\('avatars'\)/.test(balances));

// APP_URL set to the README's own example shipped emails linking to
// your-site.netlify.app, and nothing could detect that.
const mailLib = fs.readFileSync('netlify/lib/mail.mjs', 'utf8');
check('the site URL is taken from the request, not trusted from config',
  /export function siteUrl/.test(mailLib) && /new URL\(request\.url\)\.origin/.test(mailLib));
check('and a placeholder value is rejected',
  /your-site\|example\\\.com\|YOUR-\|localhost/.test(mailLib));
check('both mail functions use it',
  /siteUrl\(request\)/.test(fs.readFileSync('netlify/functions/notify-email.mjs', 'utf8')) &&
  /siteUrl\(request\)/.test(fs.readFileSync('netlify/functions/email-test.mjs', 'utf8')));

// Expenses store their category as text, so a rename that only touched
// user_categories would split somebody's charts in two.
check('renaming a category moves the expenses with it',
  /function public\.rename_category/.test(schema) &&
  /update public\.expenses\s*\n\s*set category = new_nm/.test(schema));
check('and only the ones you entered',
  /where created_by = me and category = old_nm/.test(schema));
check('the editor uses the RPC rather than writing the column',
  /rpc\('rename_category'/.test(js['js/categories.js']) &&
  !/update\(\{ name: name, emoji/.test(js['js/categories.js']));

// An extension throwing in the page arrives at our handlers looking like
// ours, and filled the Failures tab with reports from files we do not ship.
check('foreign errors are not reported as ours',
  /OUR_FILES/.test(js['js/ui.js']) && /chrome-extension:/.test(js['js/ui.js']));
check('and an error from one of our files still is',
  /ours\(source\) === false/.test(js['js/ui.js']));

check('the login email can be changed',
  /id="row-email"/.test(html) && /auth\.updateUser\(\{ email/.test(js['js/shell.js']));

// A Supabase template is delivered verbatim, so a comment in one is mailed.
const templates = fs.readdirSync('supabase/email-templates')
  .filter(f => f.endsWith('.html'));
check('there are auth email templates to paste', templates.length === 4, templates);
const dirty = templates.filter(f => {
  const t = fs.readFileSync('supabase/email-templates/' + f, 'utf8');
  return /<!--/.test(t) || /<style/.test(t) || !/\{\{\s*\.ConfirmationURL\s*\}\}/.test(t);
});
check('each is clean HTML with the confirmation link', dirty.length === 0, dirty);


/* ---------------- 34. this round ---------------- */

console.log('\n--- accent, microphone, admins ---');

// microphone=() is an EMPTY allowlist: it disables the feature for every
// origin including this one, so the browser refused without prompting.
const pp = (toml.match(/Permissions-Policy = "([^"]*)"/) || [, ''])[1];
check('the microphone is allowed for this origin', /microphone=\(self\)/.test(pp), pp);
check('and nothing is allowed for everyone', !/=\*/.test(pp), pp);
check('geolocation stays denied', /geolocation=\(\)/.test(pp), pp);

// The accent was defined in shell.js and applied only from there, so every
// launch painted the default first and then snapped to the saved colour.
const theme = js['js/theme.js'];
check('the accent list lives in the file that runs before first paint',
  /SW\.ACCENTS = \[/.test(theme));
check('and is applied there too',
  /SW\.applyAccent\(SW\.readAccent\(\)\)/.test(theme));
check('shell.js reuses it rather than keeping a second copy',
  /const ACCENTS = SW\.ACCENTS/.test(js['js/shell.js']) &&
  !/\{ key: 'teal',\s*light:/.test(js['js/shell.js']));
check('theme.js is loaded before shell.js',
  html.indexOf('js/theme.js') < html.indexOf('js/shell.js'));
check('theme.js is loaded first of all the app scripts',
  (function () {
    const scripts = [...html.matchAll(/<script src="(js\/[a-z]+\.js)"><\/script>/g)]
      .map((m) => m[1]);
    return scripts[0] === 'js/theme.js';
  })(), [...html.matchAll(/<script src="(js\/[a-z]+\.js)"><\/script>/g)].map((m) => m[1])[0]);
check('all six accents survived the move',
  ([...theme.matchAll(/\{ key: '\w+',\s*light: '#\w{6}',\s*dark: '#\w{6}' \}/g)] || []).length === 6);

// The profile header used to give the text 100% width, which pushed the
// avatar onto its own row and left the chip indented into empty space.
check('the narrow profile header does not push the avatar to its own row',
  !/\.profile-who \{ flex: 1 1 100%/.test(css));

// Then it was moved with `flex: 0 0 100%` and `margin-left: 83px` — 100% of
// the row *plus* an 83px indent, so on a 360px phone the chip hung exactly
// 83px off the right edge. This check used to assert that indent, so it
// passed while the chip was off the screen.
check('the admin chip is inside the person block, not beside it',
  /<div class="profile-who">[\s\S]*?class="admin-chip"[\s\S]*?<\/div>\s*<\/div>/
    .test(html));
check('so it needs no guess at how wide the phone is',
  !/margin-left:\s*83px/.test(noCssComments(css)) &&
  !/\.admin-chip \{[^}]*flex:\s*0 0 100%/.test(noCssComments(css)));
check('and it can never be wider than the space it has',
  /\.admin-chip \{[^}]*max-width:\s*100%/.test(css));

// Notifying admins runs inside the transaction that creates the user, so it
// has to be unable to fail the signup.
check('admins are told when somebody signs up',
  /'account_created'/.test(schema) && /where p\.is_admin and p\.id <> new\.id/.test(schema));
check('and it cannot take the signup down with it',
  /begin\s*\n\s*insert into public\.notifications[\s\S]{0,600}?exception when others then[\s\S]{0,200}?null;\s*\n\s*end;/.test(schema));
check('the new type has an icon, a switch and an email rule',
  /account_created: '/.test(js['js/shell.js']) &&
  /key: 'account_created'/.test(js['js/shell.js']) &&
  /'account_created'/.test(fs.readFileSync('netlify/functions/notify-email.mjs', 'utf8')));
const attackSql = fs.readFileSync('supabase/security-tests.sql', 'utf8');
check('and the attack suite proves the signup survives',
  /a signup survives a notification that cannot be written/.test(attackSql));
// Admins hear when an account is *created*. A signup that is turned away
// creates nothing, so there is nothing to announce — and announcing it would
// make the notification an alert about people who never got in.
check('a refused signup is proved to notify nobody',
  /a refused signup notifies nobody/.test(attackSql));
check('the notification is written after the gates, not before',
  (function () {
    // The body ends with `end $$;`, not `$$;` — matching the latter found
    // nothing, so this check quietly returned false rather than testing the
    // ordering it claims to.
    const fn = (noSqlComments(schema).match(
      /create or replace function public\.handle_new_user[\s\S]*?\nend \$\$;/) || [''])[0];
    if (!fn) return false;
    const gate = Math.max(fn.indexOf('banned_emails'), fn.indexOf('invite_only'));
    const tell = fn.indexOf("'account_created'");
    return gate > -1 && tell > gate;
  })());

/* ---------------- 35. the month in a repeating title ---------------- */

console.log('\n--- rolling the month ---');
check('the schema shifts month words in one pass',
  /function sw\.shift_month_words/.test(schema));
check('and the posting loop uses it, by the months between occurrences',
  /sw\.shift_month_words\(r\.description, shift_by\)/.test(schema) &&
  /extract\(month from r\.next_run\)/.test(schema));
check('the rule keeps its rolled title for next time',
  /set next_run = r\.next_run,\s*\n\s*description = r\.description/.test(schema));
check('the client mirrors it for the preview',
  /SW\.shiftMonthWords\s*=/.test(js['js/balances.js']) &&
  /SW\.monthsBetween\s*=/.test(js['js/balances.js']));
check('resuming a paused rule rolls the skipped months',
  /SW\.monthsBetween\(rule\.next_run, patch\.next_run\)/.test(js['js/recurring.js']));
check('the list says the month moves, and detects it by shifting',
  /shiftMonthWords\(r\.description, 1\) !== r\.description/.test(js['js/recurring.js']));
check('there is only one list of month names on each side',
  (schema.match(/'january'/g) || []).length === 1 &&
  (js['js/balances.js'].match(/'january'/g) || []).length === 1);
check('the two are cross-checked by a command, not by hope',
  fs.existsSync('scripts/month-crosscheck.mjs') &&
  /months\)/.test(fs.readFileSync('scripts/db', 'utf8')));
// The first year step computed one replacement from the first match, which
// was NULL when a title had no year — and a NULL replacement makes
// regexp_replace return NULL for the whole string. description is not null.
check('the year is shifted per run, not by one whole-string replace',
  !/regexp_replace\(out,[^)]*FM0000/.test(schema) &&
  /left\(chunk, 2\) in \('19', '20'\)/.test(schema));
check('and digits are their own kind of run',
  /\^\[\^A-Za-z0-9\]\+/.test(schema));

/* ---------------- 36. the itemisation, kept ---------------- */

console.log('\n--- itemised receipts ---');
check('the itemisation is stored on the expense',
  /add column if not exists items jsonb/.test(schema));
check('and both write paths take it',
  /p_items\s+jsonb\s+default null/.test(schema) &&
  (schema.match(/p_items/g) || []).length >= 4);
check('null leaves a stored itemisation alone, an empty list clears it',
  /if p_items is not null then/.test(schema) &&
  /jsonb_array_length\(p_items\) > 0 then p_items else null end/.test(schema));
check('the client selects it, or reopening would start blank',
  /notes, items, expense_date/.test(js['js/balances.js']));
check('and only sends it when the itemiser was opened',
  /f\.items === undefined \? undefined/.test(js['js/expense.js']));

check('itemising alone is allowed',
  !/itemising for yourself alone/.test(js['js/expense.js']) &&
  /Itemising alone is allowed/.test(js['js/expense.js']));
// This check used to pin the exact line that was broken — it asserted the
// call to renderRows(), which is what crashed. Matching the code as written
// is not the same as knowing the code works.
check('the scanner reopens from a saved itemisation',
  /opts\.items \|\| \[\]/.test(js['js/scan.js']));
check('and drops anybody no longer on the expense',
  /people\.indexOf\(id\) > -1/.test(js['js/scan.js']));
check('it hands the items back to be stored',
  /items: usable\.map/.test(js['js/scan.js']));
check('a stored itemisation stays reachable even with the row switched off',
  /shows\('scan'\) \|\| \(f\.items && f\.items\.length\)/.test(js['js/expense.js']));
check('and the expense page shows what was in it',
  /id="exp-items"/.test(html) && /What was in it/.test(js['js/expense.js']));

// Being put on an expense costs you money without you doing anything, which
// is a different message from "something changed".
check('somebody newly added is told they were added',
  /'added_to_expense'/.test(schema) && /added you to/.test(schema));
check('and told their share of the total',
  /Your share is/.test(schema));
check('while somebody already on it still hears "changed"',
  /when t\.was_there or t\.uid = me then 'expense_updated'/.test(schema));
check('the new type has an icon, a switch and an email rule',
  /added_to_expense: '/.test(js['js/shell.js']) &&
  /key: 'added_to_expense'/.test(js['js/shell.js']) &&
  /'added_to_expense'/.test(fs.readFileSync('netlify/functions/notify-email.mjs', 'utf8')));

/* ---------------- 37. reading a receipt ---------------- */

// A screenshot of a Blinkit order came back with every amount inflated by a
// leading "2" — the ₹ glyph, which Tesseract's English model has never seen.
// Nothing in one line can tell 235 from ₹35; the document can.
const scanJs = js['js/scan.js'];
check('the misread rupee sign is inferred across the whole receipt',
  /SW\.detectRupeeGlyph = function/.test(scanJs) &&
  /votes >= 4/.test(scanJs));
check('and only when no real currency mark survived anywhere',
  /if \(lines\.some\(function \(l\) \{ return REAL_MARK\.test\(l\); \}\)\) return null;/
    .test(scanJs));
check('a size row under an item is not a second item',
  /function isDescriptor/.test(scanJs) && /if \(isDescriptor\(base\)\)/.test(scanJs));
check('an order number welded to letters is not an amount',
  /\[A-Za-z\]\{2\}\|#/.test(scanJs));
check('the payable price is the smaller of a discounted pair',
  /function pickPrice/.test(scanJs) && /Math\.min\(prices\[0\], prices\[1\]\)/.test(scanJs));
check('the thumbnail junk in front of a name is stripped',
  /function stripLeadingJunk/.test(scanJs));

// One screen does not hold a ten-item order, which is why the first attempt
// produced half a receipt.
check('more than one screenshot can be picked',
  /input\.multiple = true/.test(scanJs) && /MAX_SHOTS/.test(scanJs));
check('and more can be added to a list already started',
  /id="scan-more"/.test(scanJs) && /readReceipt\(files, true\)/.test(scanJs));
check('an item seen in two overlapping screenshots is added once',
  /already on the list at the same price is the overlap/.test(codeOnly(scanJs)) ||
  /have\[key\]\) return;/.test(scanJs));

const scanFn = fs.readFileSync('netlify/functions/scan.mjs', 'utf8');
check('a vision model reads it when a key is configured',
  /GEMINI_API_KEY/.test(scanFn) && /responseSchema/.test(scanFn));
check('and it is told the struck-out price is not what was paid',
  /use the amount PAID/.test(scanFn));
check('money crosses the wire as rupees and lands as integer paise',
  /Math\.round\(price \* 100\)/.test(scanFn));
check('an unconfigured deploy still scans, on the device',
  /'unconfigured'/.test(scanFn) &&
  /res\.status === 501 \|\| res\.status === 404\) \{ cloudReader = 'no'; return null; \}/
    .test(scanJs));
// These two used to match the exact lines they described. Both then failed
// the moment those lines were fixed — after passing while the model name in
// them had been retired by Google for a week. What they check now is the
// contract; tests/scanfn.test.mjs runs the function and proves the behaviour.
check('so does one whose free quota is spent',
  /body\.fallback/.test(scanJs) && /fallback: true/.test(scanFn));
check('the screen says which reader it has before anything is picked',
  /request\.method === 'GET'/.test(scanFn) && /\bready:/.test(scanFn) &&
  /function probeCloud/.test(scanJs) &&
  /never uploaded/.test(scanJs));
check('and the function is run, not just read',
  fs.existsSync('tests/scanfn.test.mjs') &&
  /await scan\(one\(\)\)/.test(fs.readFileSync('tests/scanfn.test.mjs', 'utf8')));
check('including that a retired model name is not a dead end',
  /is no longer available to new users/
    .test(fs.readFileSync('tests/scanfn.test.mjs', 'utf8')));
check('and the README says where the picture goes',
  /GEMINI_API_KEY/.test(readme) && /the screenshots leave the phone/i.test(readme));

/* ---------------- 38. the month that just ended ---------------- */

const notifyFn = fs.readFileSync('netlify/functions/notify-email.mjs', 'utf8');

// Summing group positions missed an expense split with a friend outside any
// group, and told somebody who owed ₹208 that they were square.
check('the overall position counts expenses with no group',
  /create or replace function sw\.user_net/.test(schema) &&
  /overall  numeric := sw\.user_net\(uid\)/.test(schema));
check('and the rows add up to it, with the groupless part named',
  /Outside any group/.test(schema));
check('the summary is null when the month was empty and nothing is owed',
  /if cnt = 0 and round\(overall, 2\) = 0 then return null; end if;/.test(schema));
check('an expense somebody paid but took no share of still counts',
  /Counting only the ones/.test(noSqlComments(schema)) ||
  /or exists \(select 1 from public\.expense_splits es4/.test(schema));
check('it acts at local midnight on the 1st',
  /create or replace function public\.cron_month_summaries/.test(schema) &&
  /if extract\(day from current_date\)::int <> 1 then return 0; end if;/.test(schema));
check('the timezone is pinned before the day is read',
  (function () {
    const fn = (noSqlComments(schema).match(
      /create or replace function public\.cron_month_summaries[\s\S]*?\nend \$\$;/) || [''])[0];
    if (!fn) return false;
    return fn.indexOf("set_config('TimeZone'") < fn.indexOf('extract(day from current_date)');
  })());
check('a project with no pg_cron still gets it, from the caller alone',
  /create or replace function public\.run_due_month_summary/.test(schema) &&
  /grant execute on function public\.run_due_month_summary\(\)/.test(schema) &&
  /run_due_month_summary/.test(js['js/shell.js']));
check('but the job that writes into everybody is granted to nobody',
  !/grant execute on function public\.cron_month_summaries/.test(schema));
check('and the attack suite tries both doors',
  /the monthly summary job is out of a user/.test(attackSql) &&
  /summarising for everybody is out of reach/.test(attackSql));
check('the two implementations of the overall sum are compared',
  /sw\.user_net/.test(fs.readFileSync('scripts/net-crosscheck.mjs', 'utf8')) &&
  /SW\.overallNet\(SW\.friendBalances\(\)\)/
    .test(fs.readFileSync('scripts/net-crosscheck.mjs', 'utf8')));
check('the new type has an icon, a switch and an email rule',
  /month_summary: '/.test(js['js/shell.js']) &&
  /key: 'month_summary'/.test(js['js/shell.js']) &&
  /'month_summary'/.test(notifyFn));

// The emails these produce are the thing people actually see.
check('every email declares its charset',
  /<meta charset="utf-8">/.test(mailLib));
check('because without it a ₹ arrives as mojibake',
  /â‚¹/.test(mailLib));
check('money is coloured the way the app colours it',
  /const GOOD = '#0F8657'/.test(mailLib) && /const OWE = '#C9431A'/.test(mailLib));
check('only the reader\'s own position is coloured, not somebody else\'s',
  /function toneOf/.test(mailLib) && /is owed/.test(mailLib) === false ||
  /Md Sameer is owed/.test(mailLib));
check('a dark inbox gets the app\'s dark palette, not the client\'s guess',
  /prefers-color-scheme: dark/.test(mailLib) &&
  /\.m-good\{color:#35C88A!important\}/.test(mailLib));
check('and every colour is still inline, for clients that strip <style>',
  /class="m-ink" style="font-family:/.test(mailLib));
check('one figure is lifted out of the heading where it is the whole point',
  /HERO_FROM_TITLE/.test(notifyFn) && /hero: hero/.test(notifyFn));
// "Ali recorded your payment of ₹500" is money going out; "You recorded a
// payment from Ali" is money coming in. A rule that just matched "recorded"
// painted the second one red.
check('the direction is read from the reader\'s side, not the verb',
  /recorded your payment/.test(notifyFn) && /\^you paid/.test(notifyFn));
check('and an undone payment, which does not say whose, is left uncoloured',
  /row\.type === 'settlement' \? \(out \? 'owe' : 'good'\) : null/.test(notifyFn));
check('a summary is laid out as rows, not one run-together paragraph',
  /const LISTED = new Set\(\['settle_reminder', 'month_summary'\]\)/.test(notifyFn));
check('the button says what it does',
  /month_summary: 'Review your spending'/.test(notifyFn));

/* ---------------- 40. no paging over a test fixture ---------------- */

// Every ./scripts/db e2e run signs up a throwaway account, and every one of
// them reached every admin's phone. Seventy-six of the seventy-seven
// announcements on this project were for people who never existed.
check('an address that can never be a person is recognised',
  /create or replace function sw\.is_test_address/.test(schema));
check('and reserved domains are the definition, not a hardcoded suite prefix',
  /example\\\.\(com\|net\|org\)/.test(schema) &&
  /test\|example\|invalid\|localhost/.test(schema));
check('the admin announcement is skipped for one',
  /if not sw\.is_test_address\(addr\) then/.test(schema));
check('but only the announcement — the account is still created',
  (function () {
    const fn = (noSqlComments(schema).match(
      /create or replace function public\.handle_new_user[\s\S]*?\nend \$\$;/) || [''])[0];
    if (!fn) return false;
    // The profile insert must sit outside the guarded block.
    return fn.indexOf('insert into public.profiles') <
           fn.indexOf('if not sw.is_test_address');
  })());
check('the ones already sent are cleared, and safe to re-run',
  /delete from public\.notifications\s*\n\s*where type = 'account_created' and sw\.is_test_address\(body\);/
    .test(schema));
check('the attack suite proves a real address still reaches every admin',
  /while one that IS created reaches every admin/.test(attackSql) &&
  !/attack-welcome@example\.com/.test(attackSql));
check('and that a reserved one reaches nobody but still gets an account',
  /but a reserved test address wakes nobody/.test(attackSql) &&
  /and it still gets an account and a profile/.test(attackSql));
check('e2e asserts the inverse for its own throwaway signup',
  /a throwaway test signup wakes no admin/.test(fs.readFileSync('tests/e2e.mjs', 'utf8')));

// Storing the itemisation is only worth anything if it reopens. It did not:
// renderRows() writes into #scan-rows, which renderItemise() creates, so
// opening a saved one threw on a null element before drawing a single line.
check('a saved itemisation reopens through the stage that holds it',
  /if \(saved\.length\) \{ rows = saved; renderItemise\(/.test(scanJs));

/* ---------------- 39. adding a co-member as a friend ---------------- */

// add_group_member_by_email() friends the person doing the adding, and only
// them. So when one person builds a group, everybody in it knows the builder
// and nobody else — and 1:1 balances with the person next to you are out of
// reach until somebody types an address.
check('a co-member can be added as a friend from inside the group',
  /create or replace function public\.add_group_peer_as_friend/.test(schema) &&
  /grant execute on function public\.add_group_peer_as_friend/.test(schema));
check('the shared group is checked in the database, not taken from the client',
  /where group_id = p_group_id and user_id = me/.test(schema) &&
  /where group_id = p_group_id and user_id = p_user_id/.test(schema));
check('and both halves of that check give the same refusal',
  (function () {
    const fn = (noSqlComments(schema).match(
      /create or replace function public\.add_group_peer_as_friend[\s\S]*?\nend \$\$;/) || [''])[0];
    // One `not_shared` between the two existence checks, not two different
    // words — told apart, this answers "is X in group Y?" to anybody.
    return (fn.match(/'not_shared'/g) || []).length === 1;
  })());
check('the person added is told, and which group it came from',
  /'friend_added'[\s\S]{0,400}?p_group_id\n?\s*\);/.test(schema) ||
  /You are both in ' \|\| gname/.test(schema));

check('who is not a friend yet is worked out away from the view',
  /SW\.groupStrangers = function/.test(js['js/balances.js']) &&
  /SW\.groupStrangers\(gid\)/.test(js['js/groupsettings.js']));
check('and it is unit tested rather than only rendered',
  /groupStrangers/.test(fs.readFileSync('tests/groups.test.js', 'utf8')));
check('the card exists and starts hidden',
  /id="gs-strangers-card" hidden/.test(html));
check('its button is wired',
  /data-befriend/.test(js['js/groupsettings.js']) &&
  /add_group_peer_as_friend/.test(js['js/groupsettings.js']));
check('an "already" answer refreshes rather than shouting',
  /data\.error === 'already'/.test(js['js/groupsettings.js']));
check('and a real user proves the whole thing over HTTP',
  /so B can add D, with no email typed/.test(fs.readFileSync('tests/e2e.mjs', 'utf8')));

// A ReferenceError partway through printed a page of PASSes and then died
// before this line, which reads like a quiet success unless you notice the
// exit code. So the file counts its own check() calls and refuses to report
// success unless every one of them ran — self-maintaining, rather than a
// hardcoded number that goes stale the next time a check is added. Checks
// inside a loop only push `ran` higher, which is why this is >= and not ==.
const declared = fs.readFileSync(__filename, 'utf8')
  .split('\n').filter(function (l) { return /^\s*check\(/.test(l); }).length;

if (ran < declared) {
  console.log('\nONLY ' + ran + ' of ' + declared + ' CHECKS RAN — the suite ' +
    'did not finish. Something threw partway through.');
  process.exit(2);
}

console.log('\n' + ran + ' checks · ' +
  (fails ? fails + ' FAILURE(S)' : 'all checks passed'));
process.exit(fails ? 1 : 0);
