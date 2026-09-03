# SplittyWise

A Splitwise replica — split expenses with friends and groups, track who owes what,
and settle up. No paywall on expense search, charts, or CSV export.

Vanilla JavaScript, Supabase (Postgres + Auth + Storage + Realtime), deployed on
Netlify. No build step, no framework, no `npm install`.

Amounts are in **INR (₹)** throughout.

---

## Before you start

This repo is the whole application. It has no build step, so there is nothing
to compile — but it is **not** usable straight from a clone, because it needs
a database of its own. Budget about twenty minutes.

**You will need**

| | Why | Cost |
|---|---|---|
| A [Supabase](https://supabase.com) account | Database, login, file storage | Free tier is enough |
| A [Netlify](https://netlify.com) account | Hosting | Free tier is enough |
| `git` | Cloning this repo | — |
| Node 18+ | Only to run the tests. The app itself needs no Node | — |
| The [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) | Strongly recommended — applying a 2,000-line schema by pasting it into a browser is how a half-applied schema happens | Free |

**The shortest path that actually works**

```bash
git clone https://github.com/sdukesameer/SplittyWise
cd SplittyWise

# 1. Create a Supabase project in the dashboard, then:
supabase login
supabase link --project-ref YOUR-PROJECT-REF
./scripts/db apply          # creates every table, policy and function
./scripts/db audit          # 16 checks, every one must read PASS

# 2. Put YOUR project's URL and anon key in js/config.js  (section 3)
# 3. Set the auth redirect URLs in the dashboard             (section 4.1)
# 4. Serve it and sign up
python3 -m http.server 8000
```

Then deploy to Netlify (section 6). Sections 2 and 4 explain each step and
what to check.

> **`js/config.js` is committed with the original author's project URL and
> anon key.** The app will appear to work and write into somebody else's
> database. **Replace both values before you sign up** — section 3.

---

## Contents

- [Before you start](#before-you-start)
1. [What it does](#1-what-it-does)
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
12. [The admin console](#12-the-admin-console)
- [Appendix: upgrading an older copy](#appendix-upgrading-an-older-copy)

---

## 1. What it does

Sign up, log in, log out, email confirmation and password reset all work end
to end. Signing in lands on the app shell: four tabs (Friends, Groups,
Activity, Account), a bell with an unread count, and the Add-expense button.

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
typed. Groups carry a cover photo, a whiteboard, a monthly settle-up day and
your own default split. Invite links let someone join by signing up.

You are told about your own actions too, so Activity is a full record rather
than only what other people did — those arrive already read, so your own work
never sits on the bell as an unread badge. A group's settle-up day is a day
of the month, and the reminder comes round every month rather than passing
once. In an exact or percentage split, the one figure that has to follow from
the others is filled in for you. Email notifications are available for free —
see section 4.7.

### Running the tests

```bash
for t in tests/*.test.js; do node "$t"; done
```

Seventeen suites, no database and no browser needed:

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
| `autofill.test.js` | The one split figure that has to follow from the others — and every case where it must keep its hands off — plus ordinal days |
| `charthover.js` (in `wiring`) | That both pages share one hover helper, that it uses pointer events so a tap works, and that the hit areas are focusable |
| `wiring.test.js` | That the app is actually connected: every RPC exists with the arguments passed, every column selected exists, every button has a handler, every screen can render, every CSS token is defined at the base, the accessibility floor holds, the offline shell is complete, and nothing is labelled as destructive without something behind it |

The whole database is one file: `supabase/schema.sql` — 21 tables, 57
row-level-security policies, 9 private RLS helpers, 8 triggers and 27
indexes, about 2,400 lines. It is written to be re-run: applying it twice is
the same as applying it once.

---

## 2. Set up Supabase

You can do all of this in the dashboard, or from the command line with the
Supabase CLI. **If you have the CLI, use it** — applying a 2,000-line schema
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

### Creating the project

If you have not made one yet: [supabase.com/dashboard](https://supabase.com/dashboard)
→ **New project**. Pick any name, pick the region closest to you, and **write
the database password down** — you need it to link the CLI, and it is only
shown once. The project takes a minute or two to provision.

Leave it completely empty. The next step fills it in.

### In the dashboard

Everything the CLI does can be done by hand instead.

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

Expect exactly these twenty-one:

```
allowed_emails        groups
admin_audit           invites
app_settings          nicknames
banned_emails         notifications
error_reports         profiles
expense_comments      recurring_expenses
expense_history       settlements
expense_payers        split_presets
expense_splits        user_categories
expenses
friendships
group_members
```

The last five of those alphabetically — `admin_audit`, `allowed_emails`,
`app_settings`, `banned_emails` and `error_reports` — belong to the admin
console (section 12). Nothing a normal client does can write to any of them.

Anything **extra** is left over from something else and worth looking at —
audit check 13 flags it for you.

Then confirm row-level security is switched on for all of them — this is the
single most important check in the whole setup:

```sql
select tablename, rowsecurity from pg_tables
where schemaname = 'public' order by tablename;
```

**Every row must read `true`.** If any says `false`, that table is readable by
any signed-in user. Re-run the schema.

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
`PASS`.** It checks that RLS is on for every table, that each has
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

*Skip this on a fresh setup — there is nothing to delete.* See also
[Appendix: upgrading an older copy](#appendix-upgrading-an-older-copy).

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

**This step is mandatory, not configuration polish.** `js/config.js` is
committed with a working URL and anon key belonging to the original author's
project. Until you replace them, the app runs and looks fine while reading and
writing somebody else's database — and their RLS policies will let you create
an account there.

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
https://your-site-name.netlify.app/**
```

The `/**` wildcard matters — the password-reset link returns to `/#/reset`, and
without the wildcard Supabase rejects it and dumps the user on the Site URL with
no session.

> You will not know your Netlify URL until you have deployed once (section 6),
> so add the `localhost` line now and come back for the other after deploying —
> that is what [section 7](#7-point-supabase-at-your-live-url) is for. Netlify
> appends a suffix when a site name is already taken, so use the URL its
> dashboard actually shows rather than the one you asked for.

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

### 4.5 Email templates

Four ready to paste are in **`supabase/email-templates/`**, with a README of
their own explaining the constraints — inline styles only, light colours
stated explicitly, and the link repeated as text because some clients strip
the button.

| File | Template in Supabase |
|---|---|
| `confirm-signup.html` | Confirm signup |
| `reset-password.html` | Reset password |
| `change-email.html` | Change email address |
| `invite.html` | Invite user |

Paste each into **Authentication → Emails → Templates**. A Supabase template
is delivered exactly as written, so do not leave HTML comments in one — they
go out with the mail.

The defaults work too — just know that Supabase's shared sending domain means
the first mail to anyone will probably land in spam. At the scale of a few
friends, texting them to check their spam folder is a perfectly good
workaround.

If it becomes a nuisance, **Project Settings → Authentication → SMTP
Settings** accepts a free Brevo or Resend account and fixes deliverability
properly. That is separate from the notification email in 4.7, though the
same Brevo account can serve both.

### 4.6 Custom SMTP, and what it does and does not fix

**Custom SMTP is not required for custom HTML.** The templates in section 4.5
work on the built-in mail exactly as they do on your own SMTP —
**Authentication → Emails → Templates** is a separate setting and has no
dependency on this page. If the templates are what you are after, you are
already done.

What custom SMTP actually fixes is **deliverability** — mail arriving in the
inbox instead of spam — and the **rate limit**, which goes from a couple of
messages an hour to 30, adjustable after that. Deliverability is about who is
sending, not what the mail says, which is why no template can fix it.

#### Filling in that page with Brevo

You already have a Brevo account for section 4.7, so reuse it. In Brevo, go
to **SMTP & API → SMTP**, and copy from that page:

| Supabase field | What to put |
|---|---|
| **Sender email address** | The same address as your `EMAIL_FROM` — it must be a verified sender in Brevo, and yours already is if the notification mail works |
| **Sender name** | `SplittyWise` |
| **Host** | `smtp-relay.brevo.com` |
| **Port number** | `587` |
| **Username** | The **SMTP login** shown on Brevo's SMTP page. Not your account email, and definitely not the host — Brevo shows a specific value, often like `8xxxxx@smtp-brevo.com` |
| **Password** | An **SMTP key**, generated on that same page. **Not** the API key you put in Netlify — they are different credentials and the API key will not authenticate here |
| **Minimum interval per user** | Leave at `60`. It means somebody cannot request two password resets within a minute, which is what you want |

The two mistakes worth naming, because they are the ones people make: pasting
the **API key** into the password field, and putting the **host** into the
username field. Neither produces a useful error — the mail just stops.

Port 465 works too, with SSL; 587 is Brevo's own recommendation. Avoid 25.

#### Afterwards

Send yourself a password reset from the login screen to check it. Once this
is on, both kinds of mail leave from the same verified address: auth mail
through SMTP, and app notifications through the Brevo API (section 4.7).

Sources: Brevo's own
[SMTP relay](https://help.brevo.com/hc/en-us/articles/360001005870-SMTP-relay)
and [transactional email](https://help.brevo.com/hc/en-us/articles/7924908994450-Send-transactional-emails-using-Brevo-SMTP)
documentation.

#### What SMTP still cannot do

It carries **authentication mail only** — confirmations, resets, invites.
Supabase will not send arbitrary application mail whatever SMTP you give it,
which is why notifications go through section 4.7 instead.

### 4.7 Email notifications (optional, free)

Off by default and opt-in per person. A Supabase **Database Webhook** posts
each new notification row to a Netlify Function, which decides whether it is
worth an email and sends it through **Brevo** — 300 emails a day free, and
unlike Resend it does not need a domain of your own, just one verified
sender address.

The API key lives in Netlify's environment, never in the database.

**1. Get a Brevo key.** Sign up at [brevo.com](https://www.brevo.com), then
**Senders, Domains & Dedicated IPs → Senders** and add the address you want
mail to come from. Brevo emails you a confirmation link for it. Then
**SMTP & API → API Keys → Generate a new API key**.

**Do this after section 6**, since it needs a deployed site to receive the
webhook.

**2. Set the variables** in Netlify under **Site configuration →
Environment variables**:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://YOUR-REF.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API Keys → `service_role`. **Secret** — it bypasses every RLS policy. Netlify env vars are server-side only, which is why it is safe here and would not be in `js/config.js`. |
| `BREVO_API_KEY` | From step 1 |
| `EMAIL_FROM` | The sender address you verified |
| `EMAIL_FROM_NAME` | `SplittyWise` |
| `WEBHOOK_SECRET` | Any long random string — `openssl rand -hex 32` |
| `APP_URL` | *Optional.* Only needed for a custom domain — the function otherwise takes the site's address from the request it was called on, so a wrong or missing value cannot produce a broken link. Setting it to the example above is worse than leaving it unset |

Redeploy after setting them.

> Setting `SUPABASE_URL` makes Netlify's secret scanner fail the build,
> because that value is also in `js/config.js` — where it belongs.
> `netlify.toml` already exempts it; see
> [If the build fails on "Secrets scanning found secrets"](#if-the-build-fails-on-secrets-scanning-found-secrets).

**3. Point Supabase at it.** In the dashboard, **Database → Webhooks →
Enable webhooks**, then **Create a new hook**:

- Name: `email-notifications`
- Table: `notifications`, events: **Insert** only
- Type: **HTTP Request**, method **POST**
- URL: `https://your-site.netlify.app/.netlify/functions/notify-email`
- HTTP Headers: add `x-webhook-secret` with the same value as `WEBHOOK_SECRET`

> **Insert only — do not tick Update or Delete.** It is a natural thing to
> assume that Update means "also tell me when something changes", but the
> event is about the *notification row*, not the expense. A notification's
> text never changes once written; the only `update` one ever receives is
> `mark_all_notifications_read()` flipping `is_read`. So ticking Update
> means every unread row fires the webhook the moment you open the Activity
> tab — sixty unread notifications, sixty function invocations, nothing to
> say in any of them.
>
> An expense being **edited** does still reach you, because editing writes a
> brand new notification row (type `expense_updated`) and that is an Insert.
>
> If it is already ticked, untick it. The function refuses non-Insert events
> anyway — correctness there does not depend on getting this checkbox right —
> but the wasted invocations count against your Netlify quota.

**Want emails for edits and comments too?** `expense_updated`,
`expense_deleted` and `comment` are left out of `WORTH_AN_EMAIL` in
`netlify/functions/notify-email.mjs` on purpose — an app that emails on every
event trains people to filter it. Add them to that set if you disagree; the
per-type switches in the app then govern them like everything else.

**4. Turn it on** in the app: **Account → Notifications → Email me the
important ones**.

**5. Prove it works** with **Account → Send me a test email**, which appears
once the switch is on. This matters more than it sounds: the function skips
your own actions, so adding an expense yourself produces an Activity row and
no email — which looks exactly like a misconfiguration and is not one.

What it deliberately does *not* do:

- **No email for your own actions.** Those rows arrive already read, and the
  function skips them. If you add an expense and get an Activity entry but no
  email, that is this rule, not a fault. Someone *else* adding one that
  involves you does send one — provided they are not the only person with the
  switch on.
- **Only money and people events** — an expense added, a payment recorded, a
  nudge, the monthly settle-up day, a new friend, being added to a group. Not
  edits, deletions or comments.
- **At most one email per person every fifteen minutes**, stamped on
  `profiles.last_email_at` only after a successful send, so a failed send does
  not eat somebody's quiet window.
- **Nothing at all until configured.** With the variables unset the function
  returns 204, so an unconfigured deploy is quiet rather than broken.
- **Nothing from an unsigned request.** Without the matching
  `x-webhook-secret` header it returns 403, or the URL would be a way to make
  your app email arbitrary addresses.

The per-type switches under **Account → Notifications** govern email as well
as the bell, so muting a type mutes both.

If mail stops arriving, **Netlify → Logs → Functions** shows the reason —
a spent Brevo quota comes back as a 502 with Brevo's own message rather than
being swallowed.

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

1. Push your copy of this repo to GitHub.
2. In Netlify: **Add new site → Import an existing project → GitHub**, and
   pick the repo and the `main` branch.
3. Settings — `netlify.toml` in this repo already declares them, so leave the
   fields alone:
   - **Build command**: *(empty)*
   - **Publish directory**: `.`
4. **Deploy site**.

Deploys take a few seconds; there is nothing to compile. Every push to `main`
redeploys automatically.

### If the build fails on "Secrets scanning found secrets"

Netfliy fails a build if it finds the **value** of any environment variable
anywhere in your repo. `js/config.js` contains your Supabase URL and anon key
by design — they are the address the browser talks to and the key it talks
with, so they ship with the app. If you also set either as an environment
variable (section 4.7 asks for `SUPABASE_URL`), the scanner sees the same
string in both places and stops the build.

`netlify.toml` already handles this:

```toml
[build.environment]
  SECRETS_SCAN_OMIT_KEYS = "SUPABASE_URL,SUPABASE_ANON_KEY"
```

**`SUPABASE_SERVICE_ROLE_KEY` is deliberately not on that list.** That key
bypasses every RLS policy, must never appear in the repo, and the scanner
catching it would be a genuine save rather than a nuisance. If a build ever
fails naming *that* key, do not add it to the list — find and remove the
value, and rotate the key in Supabase.

### Alternative: drag and drop

For a one-off, Netlify's **Deploys** tab accepts a folder dragged straight onto
it. Fine for a quick look, but you lose auto-deploy on push.

---

## 7. Point Supabase at your live URL

**Do not skip this.** Auth links generated for `localhost` will not work on your
phone.

Netlify gives the site a URL as soon as it deploys — something like
`https://your-site-name.netlify.app`, shown at the top of the site's
dashboard. Copy it, then back in Supabase under **Authentication → URL
Configuration**:

- Change **Site URL** to your Netlify URL
- Keep **both** entries in Redirect URLs, so local development still works:

```
http://localhost:8000/**
https://your-site-name.netlify.app/**
```

The `/**` matters: it is what lets a confirmation link land on a specific
route rather than only the home page.

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
banner after a couple of seconds instead. This manual route is the only one
Safari offers.

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
| 12 | Add a friend by email, create a group, add an expense | Balances appear in red (you owe) or green (you are owed) |
| 13 | Open the bell | Your own action is listed, with no unread badge for it |
| 14 | Turn off wifi and add an expense | Queues on the device, and syncs when the connection returns |

### Confirm your data is actually private

The point of RLS is that it holds even against someone bypassing the app
entirely. Add one expense first so there is something to hide, then:

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

**No email arrived**
Check, in order: the switch is on under **Account → Notifications**; the
event is one of the six types 4.7 lists; it was not your own action; the last
email to you was over fifteen minutes ago; and the type is not muted. Then
**Netlify → Logs → Functions** — a 403 there means the webhook's
`x-webhook-secret` header does not match `WEBHOOK_SECRET`, and a 502 carries
Brevo's own message, usually a spent daily quota.

**The monthly settle-up reminder did not come**
It is raised when you open the app, not by a scheduler — there is nothing
running while your phone is closed. It appears the first time you open the
app on or after that day of the month, once per month. A group set to the
31st reminds on the last day of a shorter month rather than skipping it.
Set the day under the group's gear icon → **Settle-up day**.

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
tests/                  seventeen suites, no database or browser needed
icons/                  app icon: SVG source + 5 rendered PNG sizes
supabase/schema.sql     tables, RLS policies, RPCs, triggers, storage
netlify.toml            publish settings, redirects, security headers
netlify/functions/      one function: optional email notifications (4.7)
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

A notification's `is_read` carries a second meaning worth knowing: a row that
is inserted **already read** is one about your own action. It belongs in your
Activity as a record of what you did, but it must never badge your own bell —
and the email function uses the same flag to decide not to email you about
yourself.

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

## 12. The admin console

At `/admin` on your deployed site. Not linked from the app, not indexable,
and not in the offline cache — an ordinary user never downloads any of it.

### There is no admin password

The obvious design is a username of `admin` and a password in an environment
variable. It cannot work here, and it is worth being clear why: this is a
static site. `js/config.js` is delivered to the browser, and a Netlify
environment variable is only readable by a Netlify Function — never by the
page. Any password the page could check is a password the visitor already
has. And "sign in as anyone" needs the `service_role` key, which bypasses
every RLS policy; in a browser that is one devtools tab away from the whole
database.

So instead:

- **Admin is a flag on a real account.** `profiles.is_admin`. It inherits
  your own password rules, email confirmation and any MFA you turn on.
- **That flag cannot be set from a browser at all.** A trigger refuses any
  change to it that did not come from `admin_set_profile()`. `./scripts/db
  attack` proves this by trying.
- **Reads and writes go straight to Postgres** through the `admin_*`
  functions, using your own token. They are `security definer` and each
  checks `is_admin` on its first line, so the page needs nothing privileged.
- **Only auth operations use the service_role key**, inside
  `netlify/functions/admin.mjs`, because no SQL policy can reach Supabase's
  own auth tables. The key stays in Netlify's environment.
- **Every action is written to `admin_audit`**, which nobody can edit or
  delete, including you.

### 12.1 Signing in, and finding it

**Account → Admin**, on the chip beside your name. It is only rendered when
`profiles.is_admin` is true for you, and it is the only way in from an
installed app — a home-screen app has no address bar to type `/admin` into.
`/admin` is inside the manifest scope, so it opens in the same standalone
window, and the **App** link in the console's header comes back.

If you are already signed in to the app, `/admin` opens straight into the
console — both pages are the same origin and share one session, so there is
nothing to sign in to twice. The form only appears for someone who is not
signed in at all.

Signed in but not an admin? It says so and leaves your app session alone.
Opening `/admin` must never be a way to get logged out of SplittyWise.

### 12.2 Make yourself the first admin

Once, by hand — there is deliberately no other way in:

```bash
./scripts/db query "select set_config('splittywise.granting_admin','yes',false); \
  update public.profiles set is_admin = true where email = 'you@example.com'"
```

Or in the SQL Editor:

```sql
select set_config('splittywise.granting_admin', 'yes', false);
update public.profiles set is_admin = true where email = 'you@example.com';
```

The `set_config` line is what lifts the guard. Without it the update is
refused — which is the point.

After that, promote anyone else from the console itself.

### 12.3 Environment variables

The console's database half — Overview, People, Failures, Audit trail —
works with nothing configured at all, because it talks to Postgres directly
using your own token. The auth half needs exactly **two** variables in
Netlify under **Site configuration → Environment variables**:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://YOUR-REF.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API Keys → `service_role`. **Never commit this.** |

That is the same pair the email function in 4.7 uses, so setting them once
serves both.

`SUPABASE_ANON_KEY` is **not** required. The function needs an `apikey`
header when it verifies your token, and the `service_role` key is a valid one
— identity still comes from your bearer token, and a forged token is still
rejected. Set it if you like; it will be used in preference.

If a variable is missing, the action returns a message **naming that
variable**. An earlier version demanded all three and always reported
`SUPABASE_SERVICE_ROLE_KEY`, which sent someone who had already set it
looking in the wrong place.

See also
[the secret-scanning note](#if-the-build-fails-on-secrets-scanning-found-secrets),
which you will hit the first time you set `SUPABASE_URL`.

### 12.4 What it does

**Overview** — eight figures and thirty days of signups, expenses and
failures as one chart. "Active" means *wrote something*, not *opened the
app*: sessions are not tracked, and a number invented from nothing is worse
than no number. "New accounts" answers whether anybody can sign up right now
— open, invite only, or closed — which is the question a bare count of
blocked addresses did not answer.

**People** — search, then open anyone to see their groups, friends, every
expense with their share, their payments, and any failures their device has
reported. From there: rename, reset password, sign out everywhere, act as
them, grant or remove admin, block, or delete. Individual expenses can be
binned or restored, and a group deleted.

**Access** — three separate controls:

| Control | Effect |
|---|---|
| **New accounts** off | Nobody new can register at all |
| **Invite only** on | Only addresses on the allow list can register |
| **Blocked addresses** | Specific addresses can neither sign in nor register |

All three are enforced in `handle_new_user()`, which runs inside the
transaction that would create the account — so a client that skips the
signup form's check still cannot get past them. The form asks
`/.netlify/functions/signup-check` first only so the refusal can say *why*;
GoTrue reduces a trigger exception to "Database error saving new user",
which explains nothing. If that function is unreachable, signup proceeds and
the trigger still holds — a deploy without functions must not be one where
nobody can register.

**Failures** — what the app actually threw on somebody's phone, grouped by
message, because forty copies of one bug is one bug. The app reports these
itself; there is nothing to switch on. Capped at 50 per person per hour in
the schema, so a render loop that throws cannot write thousands of rows.

**Audit trail** — every administrative action, append-only.

Long lists collapse. A person's Groups, Friends, Expenses and Payments are
each a section that opens on demand and starts closed past six rows, so
somebody with a hundred expenses does not arrive as a hundred rows.

### Will the logs fill the database?

No, and the Overview's **Database** tile lets you check rather than take that
on trust. Measured on a live project: `admin_audit` 48 kB for 28 rows,
`error_reports` 64 kB, the whole database 14 MB against the free tier's
500 MB.

Everything diagnostic is on a retention schedule, applied by `purge_trash()`
— which already runs once a day, when whoever opens the app first opens it:

| Table | Kept for | Why |
|---|---|---|
| `error_reports` | 30 days | The one that could actually run away, since every device writes to it. A bug report older than a month is not useful |
| `notifications` | 90 days, **read only** | An unread one is never purged, however old — it is somebody's outstanding news |
| `admin_audit` | 365 days | A few hundred bytes per administrative action, and those are rare. A year, because the point of an audit trail is looking back at something that surfaced later |

Nothing anybody owns is touched: expenses, groups, splits and payments have
no retention at all. Only the trash empties, after thirty days, and only
your own.

### 12.5 Blocking versus deleting

Worth understanding before you use either.

**Blocking** does two things, and both are needed: a `banned_emails` row
stops a *new* account being created with that address, and `banned_until` on
the auth user stops the *existing* one signing in. Their sessions are ended
too — an access token already issued stays valid for its hour otherwise, so
without that the block waits for expiry. Every expense of theirs stays
exactly as it is, so **nobody else's balance moves.**

**Deleting** removes the account and everything cascading from it, which
**does change other people's balances** — their share of a shared expense
disappears with them. There is no undo. Block unless you specifically want
the data gone.

### 12.6 Acting as someone

This is the honest form of "log in as anyone": the console generates a
single-use sign-in link for their account. Following it signs **your
browser** in as them, replacing your own session — you are them until you
sign out and sign back in as yourself, and anything you do will look like
they did it.

It is recorded in the audit trail whether or not you follow the link.

There is no way to do this without becoming them, short of building a
parallel read-write interface to every screen in the app. Reading and
editing their data from the People tab covers most of what that would be
for.

### 12.7 Checking it holds

```bash
./scripts/db attack
```

Fifteen things an ordinary signed-in user must not be able to do — grant
themselves admin, write the ban list, reopen signups, call any `admin_*`
function, read the audit trail, forge a notification, blame someone else for
a crash, read a stranger's expenses — each tried for real and expected to
fail, plus two legitimate paths expected to succeed. Everything runs in one
statement that rolls itself back.

This exists because `./scripts/db audit` once reported PASS on an open hole:
the `is_admin` guard was in place and the audit could see it, but it compared
`current_setting(name, true)` to a string without `coalesce`, and
`NULL <> 'yes'` is `NULL`, which `if` treats as false. The trigger was inert
and a normal user could grant themselves admin. Checking that a mechanism
exists is not checking that it works.

---

## Appendix: upgrading an older copy

Everything here is irrelevant on a fresh setup. It matters only if you have
been running SplittyWise for a while and are pulling a newer version.

**Always re-apply the schema after pulling.**

```bash
git pull
./scripts/db apply
./scripts/db audit          # 16 checks, every one must read PASS
```

The schema is a single re-runnable file rather than a migration chain, so
this is the whole upgrade. It drops and recreates any function whose
signature changed, adds columns `if not exists`, and drops each policy
before creating it.

**Hard-reload the app afterwards.** The service worker pins the old shell
until its cache version changes and every tab is closed. On iOS Safari, close
every tab showing the site — a background tab is enough to keep the old
worker alive.

Two changes needed a hand:

| Change | What to do |
|---|---|
| The `receipts` bucket is gone — receipts are read on the device and the image is discarded | `./scripts/db empty-receipts`, then delete the bucket in the dashboard. [Details](#deleting-the-old-receipts-bucket) — Supabase refuses to let SQL delete a bucket |
| `groups.settle_up_on` (one fixed date) became `groups.settle_up_day` (a day of the month, reminded monthly) | Nothing. The schema copies the day across and drops the old column |

If a `git pull` brings a new `sw.js` cache version, that is deliberate — it
is how a stale shell is thrown away.

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

## What was built, in order

Kept as a record of how the app was put together, and as a map of where each
piece of behaviour lives.

| | | Where |
|---|---|---|
| Data model, RLS, app icon | | `supabase/schema.sql`, `icons/` |
| Auth — signup, login, reset | | `js/auth.js` |
| Shell, tab bar, theming, Account tab | | `js/shell.js`, `js/theme.js` |
| Friends and balances | | `js/friends.js`, `js/balances.js` |
| Groups | | `js/groups.js`, `js/groupsettings.js` |
| Expenses, splits, edit, delete | | `js/expense.js` |
| Settle up, debt simplification | | `js/settle.js`, `simplifyDebts()` |
| Itemised receipt scanning | | `js/scan.js` |
| Charts, search, CSV export | | `js/insights.js`, `js/search.js` |
| PWA install, offline, realtime | | `js/pwa.js`, `js/outbox.js`, `js/realtime.js`, `sw.js` |
| Deploy hardening, CSP, audit | | `netlify.toml`, `supabase/rls-audit.sql` |
| Five split modes | | `computeSplit()` in `js/balances.js` |
| Multiple payers, invite links | | `js/expense.js`, `js/invite.js` |
| Notes, cover photos, whiteboard | | `js/groupsettings.js`, `js/image.js` |
| Nudges, settled-history collapse | | `js/friends.js`, `js/shell.js` |
| Recurring expenses, trash, categories | | `js/recurring.js`, `js/trash.js`, `js/categories.js` |
| Voice entry, app lock | | `js/voice.js`, `js/lock.js` |
| Monthly settle-up day, self-notifications, email | | `run_due_settle_reminders()`, `netlify/functions/` |
