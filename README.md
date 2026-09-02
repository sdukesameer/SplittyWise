# SplittyWise

A Splitwise replica — split expenses with friends and groups, track who owes what,
and settle up. No paywall on expense search, charts, or CSV export.

Vanilla JavaScript, Supabase (Postgres + Auth + Storage + Realtime), deployed on
Netlify. No build step, no framework, no `npm install`.

Amounts are in **INR (₹)** throughout.

---

## Contents

1. [What works today](#1-what-works-today)
2. [Set up Supabase](#2-set-up-supabase)
3. [Connect the app](#3-connect-the-app)
4. [Configure authentication](#4-configure-authentication)
5. [Run it locally](#5-run-it-locally)
6. [Deploy to Netlify](#6-deploy-to-netlify)
7. [Point Supabase at your live URL](#7-point-supabase-at-your-live-url)
8. [Install on iPhone and Android](#8-install-on-iphone-and-android)
9. [Verify it works](#9-verify-it-works)
10. [Troubleshooting](#10-troubleshooting)
11. [How it is put together](#11-how-it-is-put-together)

---

## 1. What works today

**All 10 phases are complete.** Sign up, log in, log out, email
confirmation and password reset all work end to end. Signing in lands on the
app shell: four tabs (Friends, Groups, Activity, Account), a bell with an
unread count, and the Add-expense button.

Add friends by email, create groups, add an expense and split it equally or
by exact amounts, see who owes whom, and settle up with partial payments.
Every balance is derived from the ledger, never stored.

Receipts can be scanned on-device to itemise an order: tick who was in on
each line, and fees are shared out by the size of each person's order.

Spending charts by category and month, expense search, CSV export, live
notifications, and it installs to the home screen on both iPhone and
Android.

Expenses split five ways: equally (with anyone tickable out), by exact
amounts, by percentage, by shares, or by adjustment.

### Running the tests

```bash
for t in tests/*.test.js; do node "$t"; done
```

Nine suites, no database and no browser needed:

| Suite | Covers |
|---|---|
| `balances.test.js` | Pairwise netting, per-group breakdown, payer's own split excluded, settlements both ways, ₹ formatting |
| `splits.test.js` | Equal splits sum back to the total exactly, over 71,430 total/participant combinations |
| `groups.test.js` | Member nets sum to zero, who-paid vs whose-share, debt simplification clears every balance |
| `emoji.test.js` | Description-to-icon guessing and rule precedence |
| `prorate.test.js` | Fees allocated by order size, landing on the total exactly |
| `scan.test.js` | Receipt parsing from realistic OCR output, and itemised splits |
| `insights.test.js` | Categories, monthly buckets, search, and CSV including formula-injection guarding |
| `splitmodes.test.js` | All five split modes, checked against the reference app's own on-screen numbers |
| `wiring.test.js` | That the app is actually connected: every RPC exists with the arguments passed, every column selected exists, every button has a handler, every screen can render, and the offline shell is complete |

The full database — 8 tables, 27 row-level-security policies, 6 write RPCs — is
already in `supabase/schema.sql` and supports every later phase.

---

## 2. Set up Supabase

You said you already created an empty project named **Splittywise**. These steps
fill it in.

### 2.1 Run the schema

1. Open your project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. In the left sidebar click **SQL Editor**.
3. Click **+ New query**.
4. Open `supabase/schema.sql` from this repo, copy **the whole file**, and paste it in.
5. Click **Run** (or press `Cmd/Ctrl + Enter`).

You should see `Success. No rows returned`. That is correct — the script creates
structure, not data.

The script is safe to re-run. Every statement is either `if not exists` or
`drop … / create …`, so if you edit it later you can paste the whole thing again
without wiping your expenses.

> **Re-run this if you have run an older copy.** `update_expense` gained a
> `p_group_id` parameter, so editing an expense can move it between groups.
> Without the update, changing "Split with" on an existing expense rewrites
> its splits but leaves it in the old group. The script drops the old version
> before recreating it, so re-running is safe.

### 2.2 Confirm it worked

In the SQL Editor, run:

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by table_name;
```

Expect exactly these eight:

```
expense_splits
expenses
friendships
group_members
groups
notifications
profiles
settlements
```

Then confirm row-level security is switched on for all of them — this is the
single most important check in the whole setup:

```sql
select tablename, rowsecurity from pg_tables
where schemaname = 'public' order by tablename;
```

**Every row must read `true`.** If any says `false`, your data is readable by any
signed-in user. Re-run the schema.

### 2.3 Confirm realtime is on

The schema adds `notifications` to the realtime publication, which is what
makes a friend's expense appear on your phone without a refresh. Confirm it:

```sql
select tablename from pg_publication_tables
where pubname = 'supabase_realtime' and schemaname = 'public';
```

`notifications` should be listed. If it is not, check
**Database → Replication** in the dashboard and enable it for that table.

### 2.4 Run the security audit

```
supabase/rls-audit.sql
```

Paste it into the SQL Editor and run it. **Every result column must say
`PASS`.** It checks that RLS is on for all eight tables, that each has
policies, that security-definer functions pin `search_path`, that the
receipts bucket is private, that clients cannot write notifications for
other people, and that every expense's splits sum to its total.

Worth re-running after any schema change, and occasionally in normal use —
check 8 catches ledger corruption that would otherwise be invisible.

### 2.5 Confirm the storage bucket

Click **Storage** in the sidebar. You should see a bucket called **receipts**,
marked private. The schema created it. Receipt photos land here in phase 5.

---

## 3. Connect the app

1. In Supabase, go to **Project Settings** (gear icon, bottom of sidebar) → **API**.
2. Copy two values:
   - **Project URL** — looks like `https://abcdefghijklm.supabase.co`
   - **Project API keys → `anon` `public`** — a long string starting `eyJ…`
3. Open `js/config.js` in this repo and paste them in:

```js
window.SPLITTYWISE_CONFIG = {
  SUPABASE_URL: 'https://abcdefghijklm.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJI...',
};
```

### Is it safe to commit that key?

**Yes, the `anon` key is meant to be public.** It is embedded in every Supabase
web app and grants nothing beyond what your RLS policies allow — which is why
step 2.2 matters so much.

**Never commit the `service_role` key.** It sits right below the anon key in the
same dashboard page and it bypasses RLS completely. It has no use in this app.

---

## 4. Configure authentication

All of this is under **Authentication** in the sidebar.

### 4.1 URL configuration

Go to **Authentication → URL Configuration**.

**Site URL** — where confirmation and reset links send people. While developing:

```
http://localhost:8000
```

**Redirect URLs** — the allowlist of addresses a link may return to. Add both,
one per line:

```
http://localhost:8000/**
https://splittywise.netlify.app/**
```

The `/**` wildcard matters — the password-reset link returns to `/#/reset`, and
without the wildcard Supabase rejects it and dumps the user on the Site URL with
no session.

> Replace `splittywise.netlify.app` with your real Netlify domain if it differs —
> Netlify sometimes appends a suffix when a name is taken.

### 4.2 Email confirmation — pick one

Go to **Authentication → Sign In / Providers → Email**.

**While building, turn `Confirm email` OFF.** Supabase's built-in email service
allows only a handful of messages per hour on the free tier, and you will burn
through that in ten minutes of testing. With it off, signup logs you straight in.

**Before sharing with friends, turn `Confirm email` ON.** It stops a typo'd
address from creating an account your friends can never find — and since people
find each other by email in this app, that matters.

The app handles both. With confirmation on it shows a "check your email" screen
with a resend button; with it off it goes straight to the app.

### 4.3 Password policy

Same page. Set **Minimum password length** to `8`, matching the app's own check.

### 4.4 Email templates (optional)

Under **Authentication → Emails → Templates** you can rebrand the **Confirm
signup** and **Reset password** messages. The defaults work fine — just know
that Supabase's shared sending domain means the first mail to anyone will
probably land in spam. As you said, texting them to check spam is a fine
workaround at this scale.

If it ever becomes a nuisance, **Project Settings → Authentication → SMTP
Settings** accepts a free Resend or Brevo account and fixes deliverability
properly.

---

## 5. Run it locally

The app must be served over HTTP. Opening `index.html` directly as a `file://`
URL breaks Supabase auth, because tokens are stored per-origin and `file://`
has no usable origin.

From the repo root:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

Any static server works — `npx serve -l 8000`, `php -S localhost:8000`, VS Code's
Live Server. Just keep the port at **8000** so it matches the redirect URLs from
step 4.1, or add your port there too.

---

## 6. Deploy to Netlify

You already created the **Splittywise** site. To connect it to this repo:

1. Push this repo to GitHub.
2. In Netlify, open your site → **Site configuration → Build & deploy →
   Continuous deployment** → **Link repository**.
3. Pick this GitHub repo and the `main` branch.
4. Settings — `netlify.toml` in this repo already declares them, so leave them alone:
   - **Build command**: *(empty)*
   - **Publish directory**: `.`
5. **Deploy site**.

Deploys take a few seconds; there is nothing to compile. Every push to `main`
redeploys automatically.

### Alternative: drag and drop

For a one-off, Netlify's **Deploys** tab accepts a folder dragged straight onto
it. Fine for a quick look, but you lose auto-deploy on push.

---

## 7. Point Supabase at your live URL

**Do not skip this.** Auth links generated for `localhost` will not work on your
phone.

Back in **Authentication → URL Configuration**:

- Change **Site URL** to `https://splittywise.netlify.app`
- Keep **both** entries in Redirect URLs, so local development still works:

```
http://localhost:8000/**
https://splittywise.netlify.app/**
```

---

## 8. Install on iPhone and Android

It installs as a real app: fullscreen, its own icon, and it opens even with no
signal (the app shell is cached; balances need a connection to refresh).

### iPhone

1. Open the site in **Safari** — this does not work in Chrome on iOS.
2. Tap the **Share** button (square with an up arrow).
3. Scroll down, tap **Add to Home Screen**.
4. Tap **Add**.

iOS never shows an install prompt of its own, so the app displays a hint
banner after a couple of seconds instead. This manual route is the only one,
and it is the same flow as your MyExpenseTracker.

### Android

1. Open the site in **Chrome**.
2. Accept the **Install** banner the app shows, or use **⋮ → Add to Home screen**.

### After a deploy

The service worker updates itself on the next launch. If an installed copy
looks stale, force-quit it and reopen. Bumping `CACHE` in `sw.js` guarantees
the old shell is discarded.

---

## 9. Verify it works

Run through this once after deploying. Every step should pass.

| # | Do this | Expect |
|---|---|---|
| 1 | Load the site | Login screen, no console errors |
| 2 | Sign up with a real email | Lands in the app, or shows "Confirm your email" |
| 3 | Check email, click the link | Lands back in the app, logged in |
| 4 | Force-quit and reopen | Still logged in — no password re-entry |
| 5 | Log out | Returns to the login screen |
| 6 | Log in with the **wrong** password | *"That email and password do not match."* |
| 7 | Tap **Forgot?**, submit your email | "Check your email" screen |
| 8 | Open the reset link | Goes straight to **Set a new password** |
| 9 | Set a new password | *"Password updated"*, lands in the app |
| 10 | Log in with the **old** password | Rejected |
| 11 | Log in with the **new** password | Works |

### Confirm your data is actually private

The point of RLS is that it holds even against someone bypassing the app. After
phase 3 you will have real data to test with; the check is:

1. Sign up a second account in a private window.
2. From that second account, query the first account's expenses directly:

```bash
curl 'https://YOUR-REF.supabase.co/rest/v1/expenses?select=*' \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Authorization: Bearer SECOND_ACCOUNTS_ACCESS_TOKEN"
```

It must return `[]`. Anything else means a policy is wrong.

---

## 10. Troubleshooting

**"SplittyWise is not configured yet"**
`js/config.js` still has placeholders. Redo [step 3](#3-connect-the-app).

**Blank screen, console says `Failed to fetch`**
The Project URL is wrong or the project is paused. Free Supabase projects pause
after a week of inactivity — the dashboard shows a **Restore** button.

**Confirmation or reset email never arrives**
Check spam first. If genuinely absent, you have hit the free tier's hourly send
limit — wait an hour, or turn off email confirmation while testing
([step 4.2](#42-email-confirmation--pick-one)).

**Reset link opens the app but not the password screen**
Your Redirect URLs are missing the `/**` wildcard. See
[step 4.1](#41-url-configuration).

**"This reset link has expired"**
Reset links are single-use and last one hour. Request another. Note that some
email clients pre-fetch links, which silently consumes them — if this happens
every time, copy the link and paste it into the browser instead of tapping it.

**Logged in but "Your profile row is missing"**
The signup trigger did not fire. Re-run `supabase/schema.sql`, then repair the
existing user:

```sql
insert into public.profiles (id, email, full_name)
select id, lower(email), coalesce(raw_user_meta_data->>'full_name', split_part(email,'@',1))
from auth.users
on conflict (id) do nothing;
```

**Changes not showing after a deploy**
Hard-reload: `Cmd/Ctrl + Shift + R`. On an installed home-screen app,
force-quit and reopen — the service worker picks up the new version on
launch. If it persists, bump `CACHE` in `sw.js` and redeploy.

**Something broke right after deploying, and the console mentions CSP**
The Content-Security-Policy in `netlify.toml` blocked a request. Open the
browser console, find which directive it names, and add that one host to
that directive. To rule it out entirely, comment out the whole `[[headers]]`
block containing the CSP and redeploy — but put it back afterwards.

**Receipt scanning does nothing / stalls at 8%**
The first scan downloads roughly 4 MB of OCR engine and language data. On a
slow connection give it a minute. If it fails outright, the CSP may be
blocking `cdn.jsdelivr.net` or `tessdata.projectnaptha.com`.

**CSV export does nothing on an installed iPhone app**
iOS in standalone mode blocks downloads a page starts itself. Open the site
in Safari proper and export from there.

**A group only has me in it**
Open the group and tap **Add people**, or the gear icon → *Add someone by
email*. They need a SplittyWise account already. Adding them to a group also
makes you friends, so your 1:1 balance survives leaving the group later.

**"That group needs at least two people"**
A group of one cannot split anything. Add someone first — the group page says
so and offers the button.

**The bell does not update live**
Realtime is not enabled for `notifications`. See
[step 2.3](#23-confirm-realtime-is-on). The app still resyncs whenever you
bring it back to the foreground, so nothing is lost either way.

---

## 11. How it is put together

```
index.html              every screen, as hidden <section data-screen> blocks
css/app.css             design tokens + components, dark-first
js/config.js            your two Supabase values — the only file you edit
js/db.js                Supabase client
js/ui.js                screens, toasts, bottom sheet, form plumbing
js/auth.js              signup, login, logout, password reset, session, routing
js/balances.js          money, generated avatars, the balance engine
js/shell.js             tabs, header, theme, Account tab, Activity feed
js/friends.js           friends list, add/remove, filters, one friend's page
js/emoji.js             description-to-icon guessing, and the picker
js/expense.js           add/edit form, splitting, receipts, one expense's page
js/groups.js            groups list, one group's page, membership, settings
js/settle.js            recording payments, and the plan to clear a group
js/scan.js              on-device OCR, receipt parsing, itemised assignment
js/insights.js          hand-drawn SVG charts and CSV export
js/search.js            expense search
js/realtime.js          live notifications, and resync on foreground
js/pwa.js               service worker registration and install prompts
js/theme.js             applies the saved theme before first paint
manifest.json           web app manifest
sw.js                   service worker: app shell cache, offline fallback
supabase/rls-audit.sql  security and ledger-integrity audit
tests/                  seven suites, no database or browser needed
icons/                  app icon: SVG source + 5 rendered PNG sizes
supabase/schema.sql     tables, RLS policies, RPCs, triggers, storage
netlify.toml            publish settings, redirects, security headers
```

### The database

| Table | Holds |
|---|---|
| `profiles` | Name, email, avatar emoji. Created by trigger on signup |
| `friendships` | One row per pair, canonically ordered so a pair cannot be stored twice |
| `groups` | Name, type, emoji, debt-simplification preference |
| `group_members` | Membership and role. Most RLS policies lean on this |
| `expenses` | Amount, description, emoji, date, payer. Null `group_id` means a 1:1 expense |
| `expense_splits` | Who owes what on one expense. Always sums to the expense amount |
| `settlements` | Paybacks, kept separate from expenses so history is never rewritten |
| `notifications` | Feeds the bell and the Activity tab. Written only server-side |

### Two decisions worth knowing

**Balances are never stored.** They are derived from expenses minus settlements
every time. A stored total would eventually drift out of sync with the rows it
summarises; a derived one cannot.

**Writes go through RPCs, not table inserts.** Adding an expense means writing
the expense, its splits, and a notification for each participant. `create_expense()`
does all of it in one transaction, so a half-written expense — money owed to
nobody — is impossible. The same reason applies to `create_group()` and
`add_friend_by_email()`.

### Why profile reads are locked down

`profiles` is readable only for yourself, your friends, and people you share a
group with. Without that, any signed-in user could dump every email address in
the database. Adding a friend by email therefore goes through
`add_friend_by_email()`, a `security definer` function that can look up one
address without exposing the table.

---

## Roadmap

Phases 0 to 11 are complete. Phases 12 to 15 close the remaining gaps
against the reference app.

| Phase | | Status |
|---|---|---|
| 0 | Data model, RLS, app icon | Done |
| 1 | Auth — signup, login, reset | Done |
| 2 | Shell, tab bar, theming, Account tab | Done |
| 3 | Friends and balances | Done |
| 4 | Groups | Done |
| 5 | Expenses, splits, edit, delete | Done |
| 6 | Settle up, debt simplification | Done |
| 7 | Itemised receipt scanning | Done |
| 8 | Charts, search, CSV export | Done |
| 9 | PWA install, offline, realtime notifications | Done |
| 10 | Deploy hardening, CSP, security audit | Done |
| 11 | Five split modes, per-person include toggles | Done |
| 12 | Ad-hoc people picker, multiple payers, invite link | Next |
| 13 | Notes, group rename/delete, cover photo, whiteboard | |
| 14 | Activity detail, settled-history collapse, nudges | |
| 15 | Per-group export, friend charts, chart navigator | |
