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
amounts, by percentage, by shares, or by adjustment. More than one person can
have paid. Settling up can open a UPI app with the amount already filled,
expenses can repeat on a schedule, and adding one works with no signal at
all — it queues on the phone and syncs later.

The amount field takes arithmetic (`240+80*2`), the accent colour and a
true-black theme are yours to pick, and a balance can be shared as text
straight into WhatsApp.

An order can be pasted as text rather than scanned, which parses exactly
instead of being guessed at. Things you enter twice become one-tap
templates. Categories are yours to add, and any of them can carry a monthly
cap. People and groups can have a photo, kept under 100 KB.

Splits can round to whole rupees for a group that settles in cash, and an
uneven split you agreed once can be saved and reused. A group that always
splits the same way opens that way. Deleting is recoverable for thirty days,
an expense records what changed and to what, friends can be renamed, and the
app can be locked behind Face ID. An expense can be spoken rather than
typed. Groups carry a cover photo, a whiteboard, a settle-up date and
your own default split. Invite links let someone join by signing up.

### Running the tests

```bash
for t in tests/*.test.js; do node "$t"; done
```

Sixteen suites, no database and no browser needed:

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
| `payers.test.js` | Multiple payers: one payer still behaves identically, and several net into the fewest transfers |
| `history.test.js` | Folding away settled history, shared groups, and scoping charts and exports by group, friend and month |
| `upi.test.js` | UPI link building, and recurrence dates that must not drift |
| `templates.test.js` | Templates built from habit, and what is deliberately left out |
| `rounding.test.js` | Whole-rupee rounding still landing on the total, and inferring a group's usual people |
| `voice.test.js` | Spoken amounts in words as well as digits, and never inventing one |
| `calc.test.js` | Arithmetic in the amount field, including what it must refuse |
| `wiring.test.js` | That the app is actually connected: every RPC exists with the arguments passed, every column selected exists, every button has a handler, every screen can render, every CSS token is defined at the base, the accessibility floor holds, and the offline shell is complete |

The full database — 8 tables, 27 row-level-security policies, 6 write RPCs — is
already in `supabase/schema.sql` and supports every later phase.

---

## 2. Set up Supabase

You can do all of this in the dashboard, or from the command line with the
Supabase CLI. **If you have the CLI, use it** — applying an 1,800-line schema
by pasting it into a browser is how a half-applied schema happens.

### With the CLI

Twice, ever:

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF
```

The ref is in your dashboard URL: `supabase.com/dashboard/project/YOUR-REF`.
Linking asks for the database password — the one set when the project was
created, resettable under **Project Settings → Database**.

Then everything else is one command each:

```bash
./scripts/db apply       # apply supabase/schema.sql, safe to re-run
./scripts/db audit       # the security and integrity audit, all PASS
./scripts/db advisors    # Supabase's own security and performance checks
./scripts/db buckets     # which storage buckets exist
./scripts/db dump        # back up schema and data into backups/
./scripts/db query "select count(*) from expenses"
```

`./scripts/db` on its own lists them.

> **Do not use `supabase db push` here.** It pushes
> `supabase/migrations/`, which this project does not have — so it reports
> nothing to push, which reads like success while the schema never reached
> the server. `supabase db pull` is worse: it would generate a migration and
> leave you with two diverging sources of truth. `./scripts/db warn` explains
> this at the prompt.
>
> This project keeps one re-runnable `schema.sql` on purpose. Every function
> whose signature changed is dropped before being recreated, every column is
> added `if not exists`, and every policy is dropped before being created —
> so applying it twice is the same as applying it once.

Dumps land in `backups/`, which is gitignored: they contain real people's
expenses.

### Running a local copy

`supabase start` brings up the whole stack in Docker on ports 54321–54329.
It is genuinely useful for trying a destructive change safely, but it is a
second environment to keep in step: apply the schema with
`supabase db query --local -f supabase/schema.sql`, then point
`js/config.js` at the local URL and anon key that `supabase status` prints.
Remember to point it back.

### In the dashboard

You said you already created an empty project named **Splittywise**. These steps
fill it in.

#### 2.1 Run the schema

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

> **Re-run this whenever you pull.** The schema has changed repeatedly, and
> the script is written to be re-run: every function whose signature changed
> is dropped before being recreated, every column is added with
> `if not exists`, and every policy is dropped before being created.
>
> The most recent run drops `expenses.receipt_path`. The `receipts` bucket
> itself has to go through the dashboard — see
> [Deleting the old receipts bucket](#deleting-the-old-receipts-bucket).
>
> Creating the `avatars` and `covers` buckets is wrapped so that a role
> without storage privileges reports it and the rest of the schema still
> applies. If you see a notice about either bucket, create it under
> **Storage** as private and re-run.

#### 2.2 Confirm it worked

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

#### 2.3 Confirm realtime is on

The schema adds `notifications` to the realtime publication, which is what
makes a friend's expense appear on your phone without a refresh. Confirm it:

```sql
select tablename from pg_publication_tables
where pubname = 'supabase_realtime' and schemaname = 'public';
```

`notifications` should be listed. If it is not, check
**Database → Replication** in the dashboard and enable it for that table.

#### 2.4 Run the security audit

```
supabase/rls-audit.sql
```

Paste it into the SQL Editor and run it. **Every result column must say
`PASS`.** It checks that RLS is on for all eight tables, that each has
policies, that security-definer functions pin `search_path`, that the
image buckets are private, that clients cannot write notifications for
other people, and that every expense's splits sum to its total.

It also runs from the CLI as one command:

```bash
./scripts/db audit        # 16 checks, every row must read PASS
./scripts/db advisors     # Supabase's own linter
```

`advisors` will report about twenty findings of one kind — *Signed-In Users
Can Execute SECURITY DEFINER Function* — and that is expected. Those
functions **are** the app's API: `create_expense` has to be security definer
so it can write a notification for somebody else, and each one authorises
its caller on the first line. What matters is that nothing is callable
*without* signing in, which is check 5 of the audit.

The RLS helpers used to be part of that problem. They live in a private `sw`
schema now, not `public`, because `public` is what the REST API exposes and
none of them can check who is asking — RLS policies call them, so they have
no caller to check. In `public`, `are_friends(a, b)` was a way for anyone at
all to probe who knows whom.

Worth re-running after any schema change, and occasionally in normal use.
Check 8 catches ledger corruption that would otherwise be invisible, and
checks 11 and 12 list anything in the database this app did not create —
including an old function left behind as an overload, which is the one thing
that can make an RPC call ambiguous.

#### 2.5 Confirm the storage buckets

Click **Storage** in the sidebar. You should see exactly two buckets, both
marked private:

| Bucket | Holds | Size |
|---|---|---|
| `avatars` | One picture per person | ≤ 100 KB each |
| `covers` | One picture per group | ≤ 100 KB each |

**There is deliberately no bucket for receipts.** A receipt is read on the
device and the image is thrown away — what gets saved is the itemised split
and a note, not a photograph. That is what keeps storage in the tens of
megabytes rather than the gigabytes.

Both caps are enforced on the device before upload, by re-encoding the
picture rather than refusing it: every photo off a phone camera is several
megabytes, so "too big" would be useless advice. A 4 MB camera photo becomes
roughly a 40 KB avatar that looks identical at the size it is shown.

#### Deleting the old receipts bucket

If you ran an earlier version, a `receipts` bucket may still be there with
files in it. **The schema cannot remove it** — Supabase refuses a direct
`delete` from the storage tables, to stop a bucket being orphaned from its
files. The script notices it and prints a reminder instead.

With the CLI, emptying it is one command:

```bash
./scripts/db empty-receipts
```

It asks for confirmation, because it permanently deletes files. Deleting the
now-empty **bucket** still has to happen in the dashboard: **Storage** →
**receipts** → **⋮** → **Delete bucket**.

By hand instead:

1. **Storage** in the sidebar → select **receipts**.
2. Select all files inside it and delete them.
3. Use the bucket's **⋮** menu → **Delete bucket**.

Nothing writes to it any more, so this is purely reclaiming space. If the
reminder still appears afterwards, the bucket is still there.

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

### 4.3 Leaked password protection

**Authentication → Sign In / Providers → Email** → enable
**Prevent use of leaked passwords**. It checks new passwords against
HaveIBeenPwned. It is off by default and it is the one thing
`./scripts/db advisors` will keep reporting until you turn it on.

### 4.4 Password policy

Same page. Set **Minimum password length** to `8`, matching the app's own check.

### 4.5 Email templates (optional)

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

**Something works in desktop Chrome but not on an iPhone**
Two causes are worth checking first. `color-mix()` needs Safari 16.2, so on
an older iOS any element relying on it loses that one declaration — every
such rule now carries a plain colour before it, so the effect is a slightly
flatter surface rather than an invisible one. And an uncaught script error
used to be completely silent on a phone; the app now shows it as a red
toast naming the file and line, which is what to quote if something
misbehaves.

**The bell badge is not counting something**
Check **Account → Notifications**. A muted event type is still recorded in
Activity but does not contribute to the badge, which is the point — a badge
that counts everything is a badge people learn to ignore.

**Face ID is turned on and the credential is gone**
The lock screen always offers **Sign out instead**, which clears it. Being
permanently locked out of your own ledger would be far worse than the risk
the lock guards against, so there is always a way past it.

**`Direct deletion from storage tables is not allowed`**
An older copy of the schema tried to delete the `receipts` bucket in SQL.
Pull the current version — it prints a reminder instead — and remove the
bucket by hand as above.

**A picture will not upload**
It is re-encoded on the device until it fits under 100 KB. A very large or
very detailed image can fail that after several attempts, and the toast says
so. Anything from a phone camera compresses easily; a screenshot of a dense
page may not.

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
scripts/db              the handful of Supabase CLI commands this needs
js/config.js            your two Supabase values — the only file you edit
js/db.js                Supabase client
js/ui.js                screens, toasts, bottom sheet, form plumbing
js/auth.js              signup, login, logout, password reset, session, routing
js/balances.js          money, generated avatars, the balance engine
js/shell.js             tabs, header, theme, Account tab, Activity feed
js/friends.js           friends list, add/remove, filters, one friend's page
js/emoji.js             description-to-icon guessing, and the picker
js/image.js             squeezes a picture under 100 KB before upload
js/categories.js        your own categories, and monthly caps
js/trash.js             deleted things, and restoring them
js/voice.js             speaking an expense instead of typing it
js/lock.js              Face ID or fingerprint on the installed app
js/expense.js           add/edit form, splitting, one expense's page
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

## The one thing still outstanding

Balances are derived from the whole ledger on the device, which is why they
can never drift — but it means `loadLedger` fetches every live expense at
each launch. That is imperceptible at a few hundred and a noticeable pause
approaching a couple of thousand.

Paginating the fetch is not enough on its own: a partial ledger produces a
wrong balance, silently. Doing it properly means computing pairwise balances
in Postgres and having the phone read totals rather than build them, after
which the expense lists can page freely. That is the remaining work, and it
is deliberately not started — the client engine is heavily tested, and
replacing it before the size actually calls for it would trade certainty for
speed nobody needs yet.

The soft-delete filter (`deleted_at is null`) and the per-user index on it
are already in place, so the query that summarisation would replace is at
least the right shape.

## Roadmap

All fifteen phases are complete.

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
| 12 | Ad-hoc people picker, multiple payers, invite link | Done |
| 13 | Notes, group rename/delete, cover photo, whiteboard | Done |
| 14 | Activity detail, settled-history collapse, nudges | Done |
| 15 | Per-group export, friend charts, chart navigator | Done |
