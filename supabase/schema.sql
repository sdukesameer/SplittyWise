-- ============================================================================
--  SplittyWise — Supabase schema
--  Paste into Supabase Studio → SQL Editor → Run.  Safe to re-run.
--  Currency: INR only. Split modes: equal | exact.
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
--  1. TABLES
-- ============================================================================

create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null unique,
  full_name     text not null default '',
  avatar_emoji  text not null default '🙂',
  -- A UPI virtual payment address, so settling up can open a payment app
  -- with the amount already filled instead of only recording one.
  upi_id        text,
  -- An object in the `avatars` bucket. Capped at 100 KB by the client, so a
  -- few hundred people still cost only tens of megabytes.
  avatar_path   text,
  -- Which events reach you, and which parts of the expense form you want to
  -- see. Kept as JSON because both are lists of small flags that will grow.
  notify_prefs  jsonb not null default '{}'::jsonb,
  ui_prefs      jsonb not null default '{}'::jsonb,
  -- Email notifications are off until asked for, and the Netlify function
  -- that sends them stamps last_email_at so nobody gets a burst. See
  -- netlify/functions/notify-email.mjs and README 4.7.
  email_notify  boolean not null default false,
  last_email_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One row per friendship, canonically ordered (user_a < user_b) so a pair can
-- never be stored twice in opposite directions.
create table if not exists public.friendships (
  id          uuid primary key default gen_random_uuid(),
  user_a      uuid not null references public.profiles(id) on delete cascade,
  user_b      uuid not null references public.profiles(id) on delete cascade,
  created_by  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  constraint friendship_ordered check (user_a < user_b),
  constraint friendship_unique  unique (user_a, user_b)
);

create table if not exists public.groups (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(trim(name)) > 0),
  group_type      text not null default 'other'
                  check (group_type in ('trip','home','couple','event','other')),
  emoji           text not null default '👥',
  simplify_debts  boolean not null default true,
  cover_path      text,          -- object in the `covers` bucket
  -- 'paise' splits to the exact paise; 'rupee' rounds each share to a whole
  -- rupee and gives the remainder to the payer, for groups settling in cash.
  rounding        text not null default 'paise' check (rounding in ('paise','rupee')),
  whiteboard      text,          -- shared free-text notes for the group
  -- Day of the month everyone squares up on (1-31), reminded every month.
  -- A 31 in a short month falls back to that month's last day.
  settle_up_day   int check (settle_up_day between 1 and 31),
  created_by      uuid not null references public.profiles(id) on delete cascade,
  created_at      timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id   uuid not null references public.groups(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null default 'member' check (role in ('owner','member')),
  -- Which split mode new expenses in this group start on. Per member, not
  -- per group: it is a personal preference, as in the reference app.
  default_split_mode text not null default 'equal'
                     check (default_split_mode in ('equal','exact','percent','shares','adjust')),
  joined_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);

-- group_id null => a plain 1:1 expense between friends.
create table if not exists public.expenses (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid references public.groups(id) on delete cascade,
  payer_id      uuid not null references public.profiles(id),
  amount        numeric(12,2) not null check (amount > 0),
  description   text not null check (length(trim(description)) > 0),
  emoji         text not null default '🧾',
  category      text not null default 'general',
  split_mode    text not null default 'equal'
                check (split_mode in ('equal','exact','percent','shares','adjust')),
  expense_date  date not null default current_date,
  notes         text,
  created_by    uuid not null references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Set rather than removed, so a mistaken delete is recoverable.
  deleted_at    timestamptz
);

-- Who owes what on a given expense. Splits must sum to expenses.amount;
-- enforced in create_expense() / replace_expense_splits().
create table if not exists public.expense_splits (
  id          uuid primary key default gen_random_uuid(),
  expense_id  uuid not null references public.expenses(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  amount      numeric(12,2) not null check (amount >= 0),
  unique (expense_id, user_id)
);

-- Who actually put money in. Written for every expense, including the
-- ordinary one-payer case, so the balance engine has a single code path.
-- expenses.payer_id stays as the primary payer, for "Ali paid ₹1,200" labels
-- and for rows written before this table existed.
create table if not exists public.expense_payers (
  expense_id  uuid not null references public.expenses(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  amount      numeric(12,2) not null check (amount > 0),
  primary key (expense_id, user_id)
);

-- A share link. Random token rather than an encoded user id, so an invite
-- cannot be forged to make someone your friend without their say.
create table if not exists public.invites (
  token       text primary key,
  created_by  uuid not null references public.profiles(id) on delete cascade,
  group_id    uuid references public.groups(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days'
);

-- The shape of an expense plus a cadence. Rent, wifi and the maid never
-- change, so retyping them monthly is the app's most obvious pointless work.
-- The splits are stored exactly as create_expense() wants them.
create table if not exists public.recurring_expenses (
  id            uuid primary key default gen_random_uuid(),
  group_id      uuid references public.groups(id) on delete cascade,
  payer_id      uuid not null references public.profiles(id),
  amount        numeric(12,2) not null check (amount > 0),
  description   text not null check (length(trim(description)) > 0),
  emoji         text not null default '🧾',
  category      text not null default 'general',
  split_mode    text not null default 'equal',
  splits        jsonb not null,
  payers        jsonb,
  notes         text,
  cadence       text not null check (cadence in ('weekly','monthly','yearly')),
  day_of_month  int check (day_of_month between 1 and 31),
  next_run      date not null,
  last_run      date,
  runs          int not null default 0,
  active        boolean not null default true,
  created_by    uuid not null references public.profiles(id) on delete cascade,
  created_at    timestamptz not null default now()
);

-- Most disputes about an expense are a conversation, not a number, and that
-- conversation belongs next to the expense rather than lost in WhatsApp.
create table if not exists public.expense_comments (
  id          uuid primary key default gen_random_uuid(),
  expense_id  uuid not null references public.expenses(id) on delete cascade,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  body        text not null check (length(trim(body)) > 0 and length(body) <= 1000),
  created_at  timestamptz not null default now()
);

-- Your own categories, and a monthly cap on any of them. Rows exist for
-- two reasons: to add a category the built-in list does not cover, and to
-- hang a budget on one that it does. `expenses.category` stays plain text,
-- so nothing has to be migrated when a category is renamed or removed.
create table if not exists public.user_categories (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  name          text not null check (length(trim(name)) between 1 and 40),
  emoji         text not null default '🏷️',
  -- Paise per month. Null means no cap, which is not the same as zero.
  budget_paise  bigint check (budget_paise is null or budget_paise > 0),
  is_custom     boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  unique (user_id, name)
);

-- What you call somebody, which need not be what they call themselves.
-- Private to you: nobody is told their nickname.
create table if not exists public.nicknames (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  other_id   uuid not null references public.profiles(id) on delete cascade,
  nickname   text not null check (length(trim(nickname)) between 1 and 40),
  primary key (user_id, other_id)
);

-- A split you agreed once and should never have to re-derive. `config` holds
-- whatever that mode needs: exact amounts, percentages, shares or extras.
create table if not exists public.split_presets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  group_id    uuid references public.groups(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 40),
  mode        text not null check (mode in ('equal','exact','percent','shares','adjust')),
  config      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  unique (user_id, group_id, name)
);

-- What changed on an expense, and to what. "Ali changed Groceries" is not
-- checkable; "₹1,240 became ₹1,420" is.
create table if not exists public.expense_history (
  id          uuid primary key default gen_random_uuid(),
  expense_id  uuid not null references public.expenses(id) on delete cascade,
  actor_id    uuid references public.profiles(id) on delete set null,
  changed_at  timestamptz not null default now(),
  changes     jsonb not null
);

-- A payback. Never edits an expense; balances are (expenses - settlements).
create table if not exists public.settlements (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid references public.groups(id) on delete cascade,
  from_user   uuid not null references public.profiles(id),
  to_user     uuid not null references public.profiles(id),
  amount      numeric(12,2) not null check (amount > 0),
  note        text,
  settled_on  date not null default current_date,
  created_by  uuid not null references public.profiles(id),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint settlement_distinct check (from_user <> to_user)
);

create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  actor_id    uuid references public.profiles(id) on delete set null,
  type        text not null,
  title       text not null,
  body        text not null default '',
  group_id    uuid references public.groups(id) on delete cascade,
  expense_id  uuid references public.expenses(id) on delete cascade,
  is_read     boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Columns added after the first release. Safe to re-run.
alter table public.profiles       add column if not exists upi_id      text;
alter table public.profiles       add column if not exists avatar_path text;
alter table public.profiles       add column if not exists notify_prefs jsonb not null default '{}'::jsonb;
alter table public.profiles       add column if not exists ui_prefs     jsonb not null default '{}'::jsonb;
alter table public.groups         add column if not exists rounding     text not null default 'paise';

do $$
begin
  alter table public.groups drop constraint if exists groups_rounding_check;
  alter table public.groups add constraint groups_rounding_check
    check (rounding in ('paise','rupee'));
exception when undefined_table then null;
end $$;

-- Deleting is now recoverable for thirty days rather than immediate.
alter table public.expenses    add column if not exists deleted_at timestamptz;
alter table public.settlements add column if not exists deleted_at timestamptz;

-- Receipt images are no longer stored: a scan happens on the device and the
-- picture is discarded, so nothing accumulates. The column and its bucket
-- are removed rather than left to rot.
alter table public.expenses       drop column if exists receipt_path;
alter table public.groups        add column if not exists cover_path   text;
alter table public.groups        add column if not exists whiteboard   text;
alter table public.profiles      add column if not exists email_notify boolean not null default false;
alter table public.profiles      add column if not exists last_email_at timestamptz;
alter table public.groups        add column if not exists settle_up_on date;
alter table public.groups        add column if not exists settle_up_day int;

-- settle_up_on was a single calendar date, which is stale the day after it
-- passes. Carry its day-of-month across, then retire the column.
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'groups'
               and column_name = 'settle_up_on') then
    update public.groups
       set settle_up_day = extract(day from settle_up_on)::int
     where settle_up_on is not null and settle_up_day is null;
    alter table public.groups drop column settle_up_on;
  end if;
end $$;

alter table public.groups drop constraint if exists groups_settle_up_day_check;
alter table public.groups add constraint groups_settle_up_day_check
  check (settle_up_day is null or settle_up_day between 1 and 31);
alter table public.group_members add column if not exists default_split_mode text
                                 not null default 'equal';

do $$
begin
  alter table public.group_members drop constraint if exists group_members_default_split_mode_check;
  alter table public.group_members add constraint group_members_default_split_mode_check
    check (default_split_mode in ('equal','exact','percent','shares','adjust'));
exception when undefined_table then null;
end $$;

-- Widen the split-mode constraint on a database created before percentages,
-- shares and adjustments existed. Safe to re-run.
do $$
begin
  alter table public.expenses drop constraint if exists expenses_split_mode_check;
  alter table public.expenses add constraint expenses_split_mode_check
    check (split_mode in ('equal','exact','percent','shares','adjust'));
exception when undefined_table then null;
end $$;

-- ============================================================================
--  2. INDEXES
-- ============================================================================

create index if not exists idx_friendships_a       on public.friendships(user_a);
create index if not exists idx_friendships_b       on public.friendships(user_b);
create index if not exists idx_group_members_user  on public.group_members(user_id);
create index if not exists idx_expenses_group      on public.expenses(group_id);
create index if not exists idx_expenses_payer      on public.expenses(payer_id);
create index if not exists idx_expenses_date       on public.expenses(expense_date desc);
create index if not exists idx_splits_expense      on public.expense_splits(expense_id);
create index if not exists idx_payers_expense      on public.expense_payers(expense_id);
create index if not exists idx_payers_user         on public.expense_payers(user_id);
create index if not exists idx_invites_creator     on public.invites(created_by);
create index if not exists idx_recurring_due       on public.recurring_expenses(next_run)
  where active;
create index if not exists idx_recurring_creator   on public.recurring_expenses(created_by);
create index if not exists idx_comments_expense    on public.expense_comments(expense_id, created_at);
create index if not exists idx_user_categories     on public.user_categories(user_id, sort_order);
create index if not exists idx_nicknames           on public.nicknames(user_id);
create index if not exists idx_presets             on public.split_presets(user_id, group_id);
create index if not exists idx_history_expense     on public.expense_history(expense_id, changed_at desc);
-- Live rows only: every read filters on this.
create index if not exists idx_expenses_live       on public.expenses(group_id)
  where deleted_at is null;
create index if not exists idx_settlements_live    on public.settlements(group_id)
  where deleted_at is null;
create index if not exists idx_splits_user         on public.expense_splits(user_id);
create index if not exists idx_settle_from         on public.settlements(from_user);
create index if not exists idx_settle_to           on public.settlements(to_user);
create index if not exists idx_notif_user_unread   on public.notifications(user_id, is_read, created_at desc);

-- ============================================================================
--  3. SECURITY-DEFINER HELPERS
--
--  These live in `sw`, not `public`, because `public` is the schema the REST
--  API exposes. In `public` they were callable at /rest/v1/rpc/... by the
--  anon role, and none of them checks who is asking — they cannot, since RLS
--  policies call them. So `are_friends(a, b)` was a way for anyone, signed
--  in or not, to probe who knows whom.
--
--  Policies reference them schema-qualified, so nothing depends on
--  search_path.
-- ============================================================================

create schema if not exists sw;
grant usage on schema sw to authenticated;

-- Older runs put these in `public`. Drop them there so the exposed schema
-- stops carrying a copy.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('is_group_member','is_group_owner','are_friends',
                        'group_peers','has_split','can_see_expense','can_see_profile')
  loop
    execute 'drop function ' || r.sig || ' cascade';
  end loop;
end $$;
--  These exist so RLS policies can ask "is this person in that group?" without
--  re-entering the policy they were called from (Postgres RLS recursion).
--  Each is STABLE and pins search_path.
-- ============================================================================

-- "the 3rd", "the 21st". Used in reminder text.
create or replace function sw.ordinal_day(d int)
returns text language sql immutable set search_path = '' as $$
  select d::text || case
    when d % 100 in (11, 12, 13) then 'th'
    when d % 10 = 1 then 'st'
    when d % 10 = 2 then 'nd'
    when d % 10 = 3 then 'rd'
    else 'th' end;
$$;

create or replace function sw.is_group_member(gid uuid, uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = gid and gm.user_id = uid
  );
$$;

create or replace function sw.is_group_owner(gid uuid, uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.groups g
    where g.id = gid and g.created_by = uid
  );
$$;

create or replace function sw.are_friends(a uuid, b uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.friendships f
    where f.user_a = least(a, b) and f.user_b = greatest(a, b)
  );
$$;

-- Everyone who shares at least one group with uid (includes uid itself).
create or replace function sw.group_peers(uid uuid)
returns setof uuid language sql security definer stable set search_path = public as $$
  select distinct gm2.user_id
  from public.group_members gm1
  join public.group_members gm2 on gm2.group_id = gm1.group_id
  where gm1.user_id = uid;
$$;

create or replace function sw.has_split(eid uuid, uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.expense_splits s
    where s.expense_id = eid and s.user_id = uid
  );
$$;

create or replace function sw.can_see_expense(eid uuid, uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.expenses e
    where e.id = eid and (
         e.payer_id   = uid
      or e.created_by = uid
      or (e.group_id is not null and sw.is_group_member(e.group_id, uid))
      or sw.has_split(e.id, uid)
    )
  );
$$;

-- You may read a profile only if it is yours, a friend's, or a co-member's.
-- This is what stops the app from being an email-directory of every signup.
create or replace function sw.can_see_profile(target uuid, uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select target = uid
      or sw.are_friends(uid, target)
      or exists (select 1 from sw.group_peers(uid) p where p = target);
$$;

-- ============================================================================
--  4. ROW LEVEL SECURITY
-- ============================================================================

alter table public.profiles       enable row level security;
alter table public.friendships    enable row level security;
alter table public.groups         enable row level security;
alter table public.group_members  enable row level security;
alter table public.expenses       enable row level security;
alter table public.expense_splits enable row level security;
alter table public.expense_payers enable row level security;
alter table public.invites        enable row level security;
alter table public.recurring_expenses enable row level security;
alter table public.expense_comments enable row level security;
alter table public.user_categories enable row level security;
alter table public.nicknames       enable row level security;
alter table public.split_presets   enable row level security;
alter table public.expense_history enable row level security;
alter table public.settlements    enable row level security;
alter table public.notifications  enable row level security;

-- ---- profiles --------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (sw.can_see_profile(id, (select auth.uid())));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- ---- friendships -----------------------------------------------------------
drop policy if exists friendships_select on public.friendships;
create policy friendships_select on public.friendships
  for select to authenticated
  using ((select auth.uid()) in (user_a, user_b));

drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships
  for insert to authenticated
  with check (created_by = (select auth.uid()) and (select auth.uid()) in (user_a, user_b));

drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships
  for delete to authenticated
  using ((select auth.uid()) in (user_a, user_b));

-- ---- groups ----------------------------------------------------------------
drop policy if exists groups_select on public.groups;
create policy groups_select on public.groups
  for select to authenticated
  using (created_by = (select auth.uid()) or sw.is_group_member(id, (select auth.uid())));

drop policy if exists groups_insert on public.groups;
create policy groups_insert on public.groups
  for insert to authenticated
  with check (created_by = (select auth.uid()));

drop policy if exists groups_update on public.groups;
create policy groups_update on public.groups
  for update to authenticated
  using (sw.is_group_member(id, (select auth.uid())))
  with check (sw.is_group_member(id, (select auth.uid())));

drop policy if exists groups_delete on public.groups;
create policy groups_delete on public.groups
  for delete to authenticated
  using (created_by = (select auth.uid()));

-- ---- group_members ---------------------------------------------------------
drop policy if exists group_members_select on public.group_members;
create policy group_members_select on public.group_members
  for select to authenticated
  using (sw.is_group_member(group_id, (select auth.uid()))
      or sw.is_group_owner(group_id, (select auth.uid())));

-- Any member can add another member (Splitwise behaviour); the group creator
-- can seed the first row (themselves) before any membership exists.
drop policy if exists group_members_insert on public.group_members;
create policy group_members_insert on public.group_members
  for insert to authenticated
  with check (sw.is_group_member(group_id, (select auth.uid()))
           or sw.is_group_owner(group_id, (select auth.uid())));

-- Your own membership row is yours to change — that is where your personal
-- default split mode for the group lives.
drop policy if exists group_members_update on public.group_members;
create policy group_members_update on public.group_members
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Leave a group yourself, or be removed by the owner.
drop policy if exists group_members_delete on public.group_members;
create policy group_members_delete on public.group_members
  for delete to authenticated
  using (user_id = (select auth.uid()) or sw.is_group_owner(group_id, (select auth.uid())));

-- ---- expenses --------------------------------------------------------------
drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses
  for select to authenticated
  using (
       payer_id   = (select auth.uid())
    or created_by = (select auth.uid())
    or (group_id is not null and sw.is_group_member(group_id, (select auth.uid())))
    or sw.has_split(id, (select auth.uid()))
  );

drop policy if exists expenses_insert on public.expenses;
create policy expenses_insert on public.expenses
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (group_id is null or sw.is_group_member(group_id, (select auth.uid())))
  );

-- Anyone who can see a group expense can correct it, matching Splitwise.
-- For 1:1 expenses only the two parties can.
drop policy if exists expenses_update on public.expenses;
create policy expenses_update on public.expenses
  for update to authenticated
  using (
       created_by = (select auth.uid())
    or payer_id   = (select auth.uid())
    or (group_id is not null and sw.is_group_member(group_id, (select auth.uid())))
    or sw.has_split(id, (select auth.uid()))
  );

drop policy if exists expenses_delete on public.expenses;
create policy expenses_delete on public.expenses
  for delete to authenticated
  using (
       created_by = (select auth.uid())
    or payer_id   = (select auth.uid())
    or (group_id is not null and sw.is_group_member(group_id, (select auth.uid())))
  );

-- ---- expense_splits --------------------------------------------------------
drop policy if exists splits_select on public.expense_splits;
create policy splits_select on public.expense_splits
  for select to authenticated
  using (user_id = (select auth.uid()) or sw.can_see_expense(expense_id, (select auth.uid())));

-- Named per action rather than FOR ALL: a FOR ALL policy also covers
-- SELECT, so it stacked with splits_select and both ran on every read.
drop policy if exists splits_write on public.expense_splits;
drop policy if exists splits_write_insert on public.expense_splits;
create policy splits_write_insert on public.expense_splits
  for insert to authenticated
  with check (sw.can_see_expense(expense_id, (select auth.uid())));

drop policy if exists splits_write_update on public.expense_splits;
create policy splits_write_update on public.expense_splits
  for update to authenticated
  using (sw.can_see_expense(expense_id, (select auth.uid()))) with check (sw.can_see_expense(expense_id, (select auth.uid())));

drop policy if exists splits_write_delete on public.expense_splits;
create policy splits_write_delete on public.expense_splits
  for delete to authenticated
  using (sw.can_see_expense(expense_id, (select auth.uid())));

-- ---- expense_payers --------------------------------------------------------
drop policy if exists payers_select on public.expense_payers;
create policy payers_select on public.expense_payers
  for select to authenticated
  using (user_id = (select auth.uid()) or sw.can_see_expense(expense_id, (select auth.uid())));

drop policy if exists payers_write on public.expense_payers;
drop policy if exists payers_write_insert on public.expense_payers;
create policy payers_write_insert on public.expense_payers
  for insert to authenticated
  with check (sw.can_see_expense(expense_id, (select auth.uid())));

drop policy if exists payers_write_update on public.expense_payers;
create policy payers_write_update on public.expense_payers
  for update to authenticated
  using (sw.can_see_expense(expense_id, (select auth.uid()))) with check (sw.can_see_expense(expense_id, (select auth.uid())));

drop policy if exists payers_write_delete on public.expense_payers;
create policy payers_write_delete on public.expense_payers
  for delete to authenticated
  using (sw.can_see_expense(expense_id, (select auth.uid())));

-- ---- invites ---------------------------------------------------------------
-- Only your own invites are listable. Redeeming goes through
-- redeem_invite(), which is security definer, so a recipient never needs to
-- read the table and tokens cannot be enumerated.
drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites
  for select to authenticated using (created_by = (select auth.uid()));

drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites
  for insert to authenticated with check (created_by = (select auth.uid()));

drop policy if exists invites_delete on public.invites;
create policy invites_delete on public.invites
  for delete to authenticated using (created_by = (select auth.uid()));

-- ---- recurring_expenses ----------------------------------------------------
-- Visible to whoever set it up and to anyone in the group it posts into, so
-- nobody is surprised by a bill appearing that they cannot see the rule for.
drop policy if exists recurring_select on public.recurring_expenses;
create policy recurring_select on public.recurring_expenses
  for select to authenticated
  using (
    created_by = (select auth.uid())
    or payer_id = (select auth.uid())
    or (group_id is not null and sw.is_group_member(group_id, (select auth.uid())))
  );

drop policy if exists recurring_insert on public.recurring_expenses;
create policy recurring_insert on public.recurring_expenses
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (group_id is null or sw.is_group_member(group_id, (select auth.uid())))
  );

drop policy if exists recurring_update on public.recurring_expenses;
create policy recurring_update on public.recurring_expenses
  for update to authenticated
  using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));

drop policy if exists recurring_delete on public.recurring_expenses;
create policy recurring_delete on public.recurring_expenses
  for delete to authenticated using (created_by = (select auth.uid()));

-- ---- expense_comments ------------------------------------------------------
-- Anyone who can see the expense can read and add to the conversation, but
-- only the author can remove their own words.
drop policy if exists comments_select on public.expense_comments;
create policy comments_select on public.expense_comments
  for select to authenticated
  using (sw.can_see_expense(expense_id, (select auth.uid())));

drop policy if exists comments_insert on public.expense_comments;
create policy comments_insert on public.expense_comments
  for insert to authenticated
  with check (author_id = (select auth.uid()) and sw.can_see_expense(expense_id, (select auth.uid())));

drop policy if exists comments_delete on public.expense_comments;
create policy comments_delete on public.expense_comments
  for delete to authenticated using (author_id = (select auth.uid()));

-- ---- user_categories -------------------------------------------------------
-- Entirely private: a budget is nobody else's business, even inside a group.
drop policy if exists categories_all on public.user_categories;
create policy categories_all on public.user_categories
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---- nicknames and presets -------------------------------------------------
-- Both are entirely yours; nobody else can read either.
drop policy if exists nicknames_all on public.nicknames;
create policy nicknames_all on public.nicknames
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists presets_all on public.split_presets;
create policy presets_all on public.split_presets
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---- expense_history -------------------------------------------------------
-- Readable by anyone who can see the expense; written only by update_expense.
drop policy if exists history_select on public.expense_history;
create policy history_select on public.expense_history
  for select to authenticated
  using (sw.can_see_expense(expense_id, (select auth.uid())));

-- ---- settlements -----------------------------------------------------------
drop policy if exists settlements_select on public.settlements;
create policy settlements_select on public.settlements
  for select to authenticated
  using (
       (select auth.uid()) in (from_user, to_user)
    or (group_id is not null and sw.is_group_member(group_id, (select auth.uid())))
  );

drop policy if exists settlements_insert on public.settlements;
create policy settlements_insert on public.settlements
  for insert to authenticated
  with check (created_by = (select auth.uid()) and (select auth.uid()) in (from_user, to_user));

drop policy if exists settlements_delete on public.settlements;
create policy settlements_delete on public.settlements
  for delete to authenticated
  using (created_by = (select auth.uid()) or (select auth.uid()) in (from_user, to_user));

-- ---- notifications ---------------------------------------------------------
-- Read/flag your own only. Rows for OTHER people are written exclusively by
-- the security-definer functions below, never by the client.
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications
  for delete to authenticated using (user_id = (select auth.uid()));

-- ============================================================================
--  5. SIGNUP HOOK — mirror auth.users into profiles
-- ============================================================================

-- handle_new_user() is defined in section 12, because it also enforces the
-- ban list, the signups switch and invite-only mode — all of which live
-- there. Defining it twice in one file would mean whichever came last won,
-- silently, so it is defined once, later — and its trigger is created there
-- too, since `create trigger` needs the function to exist already and would
-- fail here on a database being set up for the first time.

-- ============================================================================
--  6. FRIENDS
-- ============================================================================

-- Look a person up by email and befriend them in one hop. SECURITY DEFINER
-- because the caller cannot (and must not be able to) SELECT profiles they
-- aren't already connected to — that would make emails enumerable.
-- Returns {ok:false, error:'no_user'|'self'|'already'} or {ok:true, ...profile}.
create or replace function public.add_friend_by_email(friend_email text)
returns json language plpgsql security definer set search_path = public as $$
declare
  me        uuid := auth.uid();
  my_name   text;
  target    public.profiles;
begin
  if me is null then raise exception 'Not authenticated'; end if;

  select * into target from public.profiles
  where email = lower(trim(friend_email));

  if target.id is null then return json_build_object('ok', false, 'error', 'no_user'); end if;
  if target.id = me   then return json_build_object('ok', false, 'error', 'self');    end if;
  if sw.are_friends(me, target.id) then
    return json_build_object('ok', false, 'error', 'already');
  end if;

  insert into public.friendships (user_a, user_b, created_by)
  values (least(me, target.id), greatest(me, target.id), me);

  select full_name into my_name from public.profiles where id = me;

  insert into public.notifications (user_id, actor_id, type, title, body)
  values (target.id, me, 'friend_added',
          my_name || ' added you as a friend',
          'You can start splitting expenses together.');

  return json_build_object(
    'ok', true,
    'id', target.id,
    'email', target.email,
    'full_name', target.full_name,
    'avatar_emoji', target.avatar_emoji
  );
end $$;

-- ============================================================================
--  7. GROUPS
-- ============================================================================

-- Create a group and enrol the creator as owner atomically, so the group can
-- never exist with nobody in it.
create or replace function public.create_group(
  p_name        text,
  p_group_type  text default 'other',
  p_emoji       text default '👥'
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  me  uuid := auth.uid();
  gid uuid;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  if length(trim(coalesce(p_name, ''))) = 0 then
    raise exception 'Group name is required';
  end if;

  insert into public.groups (name, group_type, emoji, created_by)
  values (trim(p_name), coalesce(p_group_type, 'other'), coalesce(p_emoji, '👥'), me)
  returning id into gid;

  insert into public.group_members (group_id, user_id, role)
  values (gid, me, 'owner');

  return gid;
end $$;

create or replace function public.add_group_member_by_email(
  p_group_id uuid,
  p_email    text
) returns json language plpgsql security definer set search_path = public as $$
declare
  me       uuid := auth.uid();
  my_name  text;
  gname    text;
  target   public.profiles;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  if not sw.is_group_member(p_group_id, me) then
    raise exception 'You are not a member of this group';
  end if;

  select * into target from public.profiles where email = lower(trim(p_email));
  if target.id is null then return json_build_object('ok', false, 'error', 'no_user'); end if;

  if sw.is_group_member(p_group_id, target.id) then
    return json_build_object('ok', false, 'error', 'already');
  end if;

  insert into public.group_members (group_id, user_id) values (p_group_id, target.id);

  -- Sharing a group implies knowing each other, so mirror Splitwise and
  -- auto-friend them. Keeps 1:1 balances reachable after the group is gone.
  if target.id <> me and not sw.are_friends(me, target.id) then
    insert into public.friendships (user_a, user_b, created_by)
    values (least(me, target.id), greatest(me, target.id), me)
    on conflict do nothing;
  end if;

  select full_name into my_name from public.profiles where id = me;
  select name      into gname   from public.groups   where id = p_group_id;

  insert into public.notifications (user_id, actor_id, type, title, body, group_id)
  values (target.id, me, 'group_added',
          my_name || ' added you to ' || gname, 'Tap to see the group.', p_group_id);

  return json_build_object(
    'ok', true,
    'id', target.id,
    'email', target.email,
    'full_name', target.full_name,
    'avatar_emoji', target.avatar_emoji
  );
end $$;

-- Add several friends to a group at once, so nobody has to retype an email
-- address they already have as a friend.
create or replace function public.add_group_members(
  p_group_id uuid,
  p_user_ids uuid[]
) returns json language plpgsql security definer set search_path = public as $$
declare
  me       uuid := auth.uid();
  my_name  text;
  gname    text;
  uid      uuid;
  added    int := 0;
  skipped  int := 0;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  if not sw.is_group_member(p_group_id, me) then
    raise exception 'You are not a member of this group';
  end if;

  select full_name into my_name from public.profiles where id = me;
  select name      into gname   from public.groups   where id = p_group_id;

  foreach uid in array coalesce(p_user_ids, '{}'::uuid[])
  loop
    -- Only people you already know: a friend, or someone already sharing a
    -- group with you. Otherwise this would be a way to pull in strangers.
    if uid = me
       or sw.is_group_member(p_group_id, uid)
       or not (sw.are_friends(me, uid)
               or exists (select 1 from sw.group_peers(me) g where g = uid))
    then
      skipped := skipped + 1;
      continue;
    end if;

    insert into public.group_members (group_id, user_id) values (p_group_id, uid)
    on conflict do nothing;

    if not sw.are_friends(me, uid) then
      insert into public.friendships (user_a, user_b, created_by)
      values (least(me, uid), greatest(me, uid), me)
      on conflict do nothing;
    end if;

    insert into public.notifications (user_id, actor_id, type, title, body, group_id)
    values (uid, me, 'group_added',
            my_name || ' added you to ' || gname, 'Tap to see the group.', p_group_id);

    added := added + 1;
  end loop;

  return json_build_object('ok', true, 'added', added, 'skipped', skipped);
end $$;

-- ============================================================================
--  7b. INVITE LINKS
-- ============================================================================

-- Mint a share link. Optionally tied to a group, so opening it both befriends
-- the inviter and joins the group.
create or replace function public.create_invite(
  p_group_id uuid default null
) returns json language plpgsql security definer set search_path = public as $$
declare
  me    uuid := auth.uid();
  tok   text;
begin
  if me is null then raise exception 'Not authenticated'; end if;

  if p_group_id is not null and not sw.is_group_member(p_group_id, me) then
    raise exception 'You are not a member of this group';
  end if;

  -- 128 random bits as hex. Random rather than an encoded user id, so a
  -- link cannot be forged to make someone your friend.
  --
  -- gen_random_uuid() and not gen_random_bytes(): pgcrypto lives in the
  -- `extensions` schema on Supabase, and this function pins
  -- search_path = public, so gen_random_bytes was simply not visible —
  -- every "Invite with a link" failed with "function gen_random_bytes(integer)
  -- does not exist". gen_random_uuid is core Postgres, so it needs no
  -- extension and no widened search_path. Hex is already URL-safe.
  tok := replace(gen_random_uuid()::text, '-', '');

  insert into public.invites (token, created_by, group_id)
  values (tok, me, p_group_id);

  return json_build_object('ok', true, 'token', tok,
                           'expires_at', (now() + interval '14 days')::text);
end $$;

-- Redeem one. Security definer because the recipient has no read access to
-- invites at all, which is what stops tokens being enumerated.
create or replace function public.redeem_invite(
  p_token text
) returns json language plpgsql security definer set search_path = public as $$
declare
  me       uuid := auth.uid();
  inv      public.invites;
  inviter  public.profiles;
  my_name  text;
  gname    text;
  joined   boolean := false;
begin
  if me is null then raise exception 'Not authenticated'; end if;

  select * into inv from public.invites where token = trim(p_token);
  if inv.token is null then
    return json_build_object('ok', false, 'error', 'invalid');
  end if;
  if inv.expires_at < now() then
    return json_build_object('ok', false, 'error', 'expired');
  end if;
  if inv.created_by = me then
    return json_build_object('ok', false, 'error', 'self');
  end if;

  select * into inviter from public.profiles where id = inv.created_by;
  select full_name into my_name from public.profiles where id = me;

  if not sw.are_friends(me, inv.created_by) then
    insert into public.friendships (user_a, user_b, created_by)
    values (least(me, inv.created_by), greatest(me, inv.created_by), inv.created_by)
    on conflict do nothing;
  end if;

  if inv.group_id is not null and not sw.is_group_member(inv.group_id, me) then
    insert into public.group_members (group_id, user_id) values (inv.group_id, me)
    on conflict do nothing;
    select name into gname from public.groups where id = inv.group_id;
    joined := true;
  end if;

  -- Tell the inviter it worked, so they are not left wondering.
  insert into public.notifications (user_id, actor_id, type, title, body, group_id)
  values (inv.created_by, me, 'invite_accepted',
          my_name || ' joined from your invite',
          coalesce('Added to ' || gname, 'You are now friends.'), inv.group_id);

  return json_build_object('ok', true,
                           'inviter', inviter.full_name,
                           'group', gname,
                           'joined_group', joined);
end $$;

-- ============================================================================
--  8. EXPENSES
--  Written through an RPC so that the expense row, its splits, and the
--  notification fan-out either all land or none do. p_splits is
--  [{"user_id": "...", "amount": 123.45}, ...] and must sum to p_amount.
-- ============================================================================

-- Adding a parameter changes the signature, and `create or replace` would
-- leave the old one behind as an overload, making every call ambiguous.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'create_expense'
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;

create or replace function public.create_expense(
  p_amount       numeric,
  p_description  text,
  p_splits       jsonb,
  p_payer_id     uuid    default null,
  p_group_id     uuid    default null,
  p_emoji        text    default '🧾',
  p_category     text    default 'general',
  p_split_mode   text    default 'equal',
  p_expense_date date    default current_date,
  p_notes        text    default null,
  p_payers       jsonb   default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  me          uuid := auth.uid();
  payer       uuid := coalesce(p_payer_id, auth.uid());
  payers      jsonb;
  eid         uuid;
  split_total numeric(12,2);
  payer_total numeric(12,2);
  n_splits    int;
  n_payers    int;
  bad         uuid;
  actor_name  text;
  gname       text;
begin
  if me is null then raise exception 'Not authenticated'; end if;

  -- One payer is just the one-row case of many, so normalise immediately and
  -- keep a single code path from here on.
  payers := coalesce(p_payers, jsonb_build_array(
    jsonb_build_object('user_id', payer, 'amount', round(p_amount, 2))));

  -- ---- shape checks --------------------------------------------------------
  if p_splits is null or jsonb_typeof(p_splits) <> 'array' then
    raise exception 'p_splits must be a JSON array';
  end if;
  if jsonb_typeof(payers) <> 'array' then
    raise exception 'p_payers must be a JSON array';
  end if;

  select count(*), coalesce(sum((s->>'amount')::numeric), 0)
    into n_splits, split_total
    from jsonb_array_elements(p_splits) s;

  select count(*), coalesce(sum((s->>'amount')::numeric), 0)
    into n_payers, payer_total
    from jsonb_array_elements(payers) s;

  if n_splits = 0 then raise exception 'An expense needs at least one split'; end if;
  if n_payers = 0 then raise exception 'An expense needs at least one payer'; end if;

  if n_splits <> (
    select count(distinct (s->>'user_id')::uuid) from jsonb_array_elements(p_splits) s
  ) then
    raise exception 'The same person is listed twice in the split';
  end if;

  if n_payers <> (
    select count(distinct (s->>'user_id')::uuid) from jsonb_array_elements(payers) s
  ) then
    raise exception 'The same person is listed twice as a payer';
  end if;

  if split_total <> round(p_amount, 2) then
    raise exception 'Splits total %, expense is % — they must match',
      split_total, round(p_amount, 2);
  end if;

  if payer_total <> round(p_amount, 2) then
    raise exception 'Payments total %, expense is % — they must match',
      payer_total, round(p_amount, 2);
  end if;

  -- The primary payer, used for "Ali paid ₹1,200" labels, is whoever put in
  -- the most.
  select (s->>'user_id')::uuid into payer
    from jsonb_array_elements(payers) s
    order by (s->>'amount')::numeric desc, (s->>'user_id')
    limit 1;

  -- ---- authorisation -------------------------------------------------------
  if p_group_id is not null then
    if not sw.is_group_member(p_group_id, me) then
      raise exception 'You are not a member of this group';
    end if;
    select u into bad from (
      select (s->>'user_id')::uuid as u from jsonb_array_elements(p_splits) s
      union
      select (s->>'user_id')::uuid from jsonb_array_elements(payers) s
    ) everyone
    where not sw.is_group_member(p_group_id, u)
    limit 1;
    if bad is not null then
      raise exception 'User % is not a member of this group', bad;
    end if;
  else
    select u into bad from (
      select (s->>'user_id')::uuid as u from jsonb_array_elements(p_splits) s
      union
      select (s->>'user_id')::uuid from jsonb_array_elements(payers) s
    ) everyone
    where u <> me and not sw.are_friends(me, u)
    limit 1;
    if bad is not null then
      raise exception 'User % is not one of your friends', bad;
    end if;
  end if;

  -- ---- write ---------------------------------------------------------------
  insert into public.expenses (
    group_id, payer_id, amount, description, emoji, category,
    split_mode, expense_date, notes, created_by
  ) values (
    p_group_id, payer, round(p_amount, 2), trim(p_description),
    coalesce(p_emoji, '🧾'), coalesce(p_category, 'general'),
    coalesce(p_split_mode, 'equal'), coalesce(p_expense_date, current_date),
    nullif(trim(coalesce(p_notes, '')), ''), me
  ) returning id into eid;

  insert into public.expense_splits (expense_id, user_id, amount)
  select eid, (s->>'user_id')::uuid, round((s->>'amount')::numeric, 2)
  from jsonb_array_elements(p_splits) s;

  insert into public.expense_payers (expense_id, user_id, amount)
  select eid, (s->>'user_id')::uuid, round((s->>'amount')::numeric, 2)
  from jsonb_array_elements(payers) s;

  -- ---- notify everyone but the actor --------------------------------------
  select full_name into actor_name from public.profiles where id = me;
  if p_group_id is not null then
    select name into gname from public.groups where id = p_group_id;
  end if;

  -- Everyone on the split, the actor included. Your own row lands read, so
  -- it shows in Activity as a record of what you did without ever putting an
  -- unread badge on the bell for your own action.
  insert into public.notifications
    (user_id, actor_id, type, title, body, group_id, expense_id, is_read)
  select sp.user_id, me, 'expense_added',
         case when sp.user_id = me then 'You added "'
              else actor_name || ' added "' end || trim(p_description) || '"',
         '₹' || to_char(round(p_amount, 2), 'FM999999990.00')
             || coalesce(' in ' || gname, '')
             || ' · your share ₹' || to_char(sp.amount, 'FM999999990.00'),
         p_group_id, eid, sp.user_id = me
  from public.expense_splits sp
  where sp.expense_id = eid;

  -- Paid for it but left yourself off the split: still your expense to see.
  if not exists (select 1 from public.expense_splits
                 where expense_id = eid and user_id = me) then
    insert into public.notifications
      (user_id, actor_id, type, title, body, group_id, expense_id, is_read)
    values (me, me, 'expense_added',
            'You added "' || trim(p_description) || '"',
            '₹' || to_char(round(p_amount, 2), 'FM999999990.00')
                || coalesce(' in ' || gname, '') || ' · none of it yours',
            p_group_id, eid, true);
  end if;

  return eid;
end $$;

-- Edit an expense and swap its splits in one transaction. RLS on expenses
-- decides whether the caller is allowed to touch this row at all.
--
-- p_group_id is always sent by the client and always applied: null means the
-- expense is not in a group. Without it, moving an expense between groups
-- would rewrite the splits to the new members while leaving group_id on the
-- old group — participants who are not in their own expense's group.
--
-- Adding a parameter changes the signature, and `create or replace` would
-- leave the old one behind as an overload, making every RPC call ambiguous.
-- So drop every existing version first.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_expense'
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;

create or replace function public.update_expense(
  p_expense_id   uuid,
  p_amount       numeric,
  p_description  text,
  p_splits       jsonb,
  p_payer_id     uuid default null,
  p_group_id     uuid default null,
  p_emoji        text default null,
  p_category     text default null,
  p_split_mode   text default null,
  p_expense_date date default null,
  p_notes        text default null,
  p_payers       jsonb default null
) returns void language plpgsql security definer set search_path = public as $$
declare
  me          uuid := auth.uid();
  payer       uuid;
  payers      jsonb;
  split_total numeric(12,2);
  payer_total numeric(12,2);
  n_splits    int;
  bad         uuid;
  was_on      uuid[];
  actor_name  text;
  gname       text;
  before_row  public.expenses;
  diff        jsonb := '{}'::jsonb;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  if not sw.can_see_expense(p_expense_id, me) then
    raise exception 'You cannot edit this expense';
  end if;

  select * into before_row from public.expenses where id = p_expense_id;
  payer := coalesce(p_payer_id, before_row.payer_id);

  payers := coalesce(p_payers, jsonb_build_array(
    jsonb_build_object('user_id', payer, 'amount', round(p_amount, 2))));

  -- ---- shape checks --------------------------------------------------------
  if p_splits is null or jsonb_typeof(p_splits) <> 'array' then
    raise exception 'p_splits must be a JSON array';
  end if;

  select count(*), coalesce(sum((s->>'amount')::numeric), 0)
    into n_splits, split_total
    from jsonb_array_elements(p_splits) s;

  select coalesce(sum((s->>'amount')::numeric), 0) into payer_total
    from jsonb_array_elements(payers) s;

  if n_splits = 0 then raise exception 'An expense needs at least one split'; end if;

  if n_splits <> (
    select count(distinct (s->>'user_id')::uuid) from jsonb_array_elements(p_splits) s
  ) then
    raise exception 'The same person is listed twice in the split';
  end if;

  if split_total <> round(p_amount, 2) then
    raise exception 'Splits total %, expense is % — they must match',
      split_total, round(p_amount, 2);
  end if;

  if payer_total <> round(p_amount, 2) then
    raise exception 'Payments total %, expense is % — they must match',
      payer_total, round(p_amount, 2);
  end if;

  select (s->>'user_id')::uuid into payer
    from jsonb_array_elements(payers) s
    order by (s->>'amount')::numeric desc, (s->>'user_id')
    limit 1;

  -- ---- authorisation, same rules as creating one ---------------------------
  if p_group_id is not null then
    if not sw.is_group_member(p_group_id, me) then
      raise exception 'You are not a member of this group';
    end if;
    select u into bad from (
      select (s->>'user_id')::uuid as u from jsonb_array_elements(p_splits) s
      union
      select (s->>'user_id')::uuid from jsonb_array_elements(payers) s
    ) everyone
    where not sw.is_group_member(p_group_id, u)
    limit 1;
    if bad is not null then
      raise exception 'User % is not a member of this group', bad;
    end if;
  else
    select u into bad from (
      select (s->>'user_id')::uuid as u from jsonb_array_elements(p_splits) s
      union
      select (s->>'user_id')::uuid from jsonb_array_elements(payers) s
    ) everyone
    where u <> me and not sw.are_friends(me, u)
    limit 1;
    if bad is not null then
      raise exception 'User % is not one of your friends', bad;
    end if;
  end if;

  -- ---- write ---------------------------------------------------------------
  update public.expenses set
    amount       = round(p_amount, 2),
    description  = trim(p_description),
    payer_id     = payer,
    group_id     = p_group_id,
    emoji        = coalesce(p_emoji, emoji),
    category     = coalesce(p_category, category),
    split_mode   = coalesce(p_split_mode, split_mode),
    expense_date = coalesce(p_expense_date, expense_date),
    notes        = nullif(trim(coalesce(p_notes, '')), ''),
    updated_at   = now()
  where id = p_expense_id;

  -- Capture who was on it before, so people removed by this edit are told
  -- too — otherwise a share silently vanishes from their balance.
  select array_agg(user_id) into was_on
    from public.expense_splits where expense_id = p_expense_id;

  delete from public.expense_splits where expense_id = p_expense_id;
  insert into public.expense_splits (expense_id, user_id, amount)
  select p_expense_id, (s->>'user_id')::uuid, round((s->>'amount')::numeric, 2)
  from jsonb_array_elements(p_splits) s;

  delete from public.expense_payers where expense_id = p_expense_id;
  insert into public.expense_payers (expense_id, user_id, amount)
  select p_expense_id, (s->>'user_id')::uuid, round((s->>'amount')::numeric, 2)
  from jsonb_array_elements(payers) s;

  -- Only the fields that actually moved, so the history reads as a change
  -- rather than a snapshot.
  if before_row.amount <> round(p_amount, 2) then
    diff := diff || jsonb_build_object('amount',
      jsonb_build_object('from', before_row.amount, 'to', round(p_amount, 2)));
  end if;
  if before_row.description <> trim(p_description) then
    diff := diff || jsonb_build_object('description',
      jsonb_build_object('from', before_row.description, 'to', trim(p_description)));
  end if;
  if before_row.payer_id <> payer then
    diff := diff || jsonb_build_object('payer',
      jsonb_build_object('from', before_row.payer_id, 'to', payer));
  end if;
  if coalesce(before_row.group_id::text, '') <> coalesce(p_group_id::text, '') then
    diff := diff || jsonb_build_object('group',
      jsonb_build_object('from', before_row.group_id, 'to', p_group_id));
  end if;
  if before_row.expense_date <> coalesce(p_expense_date, before_row.expense_date) then
    diff := diff || jsonb_build_object('date',
      jsonb_build_object('from', before_row.expense_date,
                         'to', coalesce(p_expense_date, before_row.expense_date)));
  end if;
  if before_row.split_mode <> coalesce(p_split_mode, before_row.split_mode) then
    diff := diff || jsonb_build_object('split',
      jsonb_build_object('from', before_row.split_mode,
                         'to', coalesce(p_split_mode, before_row.split_mode)));
  end if;

  if diff <> '{}'::jsonb then
    insert into public.expense_history (expense_id, actor_id, changes)
    values (p_expense_id, me, diff);
  end if;

  select full_name into actor_name from public.profiles where id = me;
  if p_group_id is not null then
    select name into gname from public.groups where id = p_group_id;
  end if;

  insert into public.notifications
    (user_id, actor_id, type, title, body, group_id, expense_id, is_read)
  select uid, me, 'expense_updated',
         case when uid = me then 'You changed "'
              else actor_name || ' changed "' end || trim(p_description) || '"',
         '₹' || to_char(round(p_amount, 2), 'FM999999990.00')
             || coalesce(' in ' || gname, ''),
         p_group_id, p_expense_id, uid = me
  from (
    select unnest(coalesce(was_on, '{}'::uuid[])) as uid
    union
    select (s->>'user_id')::uuid from jsonb_array_elements(p_splits) s
    union
    select me
  ) touched;
end $$;

-- ============================================================================
--  8b. RECURRING EXPENSES
-- ============================================================================

-- Advance a date by one cadence step, keeping the intended day of the month.
-- Adding an interval repeatedly would drift: 31 Jan clamps to 28 Feb, and
-- from then on every later month is the 28th.
create or replace function public.next_occurrence(
  p_from     date,
  p_cadence  text,
  p_day      int default null
) returns date language plpgsql immutable set search_path = public as $$
declare
  first_of_next date;
  days_in       int;
begin
  if p_cadence = 'weekly' then return p_from + 7; end if;
  if p_cadence = 'yearly' then return (p_from + interval '1 year')::date; end if;

  first_of_next := (date_trunc('month', p_from) + interval '1 month')::date;
  days_in := extract(day from (date_trunc('month', first_of_next)
                               + interval '1 month - 1 day'))::int;
  return first_of_next
         + (least(coalesce(p_day, extract(day from p_from)::int), days_in) - 1);
end $$;

-- Post every rule of MINE that has come due, then advance it. Called from the
-- app at launch, which means recurring expenses work with no scheduler at
-- all; scoped to the caller's own rules so opening the app cannot trigger
-- anybody else's. Idempotent: next_run only ever moves forward.
create or replace function public.run_due_recurring()
returns json language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  r       public.recurring_expenses;
  posted  int := 0;
  guard   int;
begin
  if me is null then raise exception 'Not authenticated'; end if;

  for r in
    select * from public.recurring_expenses
    where created_by = me and active and next_run <= current_date
    order by next_run
  loop
    -- A rule dormant for months would otherwise post a burst of back-dated
    -- expenses; cap the catch-up at a year's worth per launch.
    guard := 0;
    while r.next_run <= current_date and guard < 60 loop
      perform public.create_expense(
        p_amount       => r.amount,
        p_description  => r.description,
        p_splits       => r.splits,
        p_payer_id     => r.payer_id,
        p_group_id     => r.group_id,
        p_emoji        => r.emoji,
        p_category     => r.category,
        p_split_mode   => r.split_mode,
        p_expense_date => r.next_run,
        p_notes        => r.notes,
        p_payers       => r.payers
      );
      posted := posted + 1;
      guard := guard + 1;
      r.next_run := public.next_occurrence(r.next_run, r.cadence, r.day_of_month);
    end loop;

    update public.recurring_expenses
    set next_run = r.next_run,
        last_run = current_date,
        runs = runs + guard
    where id = r.id;
  end loop;

  return json_build_object('ok', true, 'posted', posted);
end $$;

-- ============================================================================
--  9. SETTLEMENTS
-- ============================================================================

create or replace function public.notify_settlement()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor       uuid := new.created_by;
  other       uuid;
  actor_name  text;
  gname       text;
begin
  other := case when actor = new.from_user then new.to_user else new.from_user end;
  select full_name into actor_name from public.profiles where id = actor;
  if new.group_id is not null then
    select name into gname from public.groups where id = new.group_id;
  end if;

  insert into public.notifications (user_id, actor_id, type, title, body, group_id)
  values (
    other, actor, 'settlement',
    actor_name || case when actor = new.from_user
                       then ' paid you ₹' else ' recorded your payment of ₹' end
      || to_char(new.amount, 'FM999999990.00'),
    coalesce(new.note, '') || coalesce(' · ' || gname, ''),
    new.group_id
  );

  insert into public.notifications
    (user_id, actor_id, type, title, body, group_id, is_read)
  values (
    actor, actor, 'settlement',
    case when actor = new.from_user
         then 'You paid ' else 'You recorded a payment from ' end
      || coalesce((select full_name from public.profiles where id = other), 'someone')
      || ' ₹' || to_char(new.amount, 'FM999999990.00'),
    coalesce(new.note, '') || coalesce(' · ' || gname, ''),
    new.group_id, true
  );
  return null;
end $$;

-- Fires BEFORE the row goes, so the splits are still there to tell.
--
-- Neither expense_id nor group_id is set on the notification. Both columns
-- cascade, so a notification about a deletion would either delete itself or,
-- when a whole group goes, reference a group row that is being removed in
-- the same statement — which is a foreign key violation and surfaces as a
-- 409 from the API. The group's name is in the body text instead.
create or replace function public.notify_expense_deleted()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  me          uuid := auth.uid();
  actor_name  text;
  gname       text;
begin
  if me is null then return old; end if;

  -- Deleting a group cascades to every expense in it. One notification per
  -- expense would be noise, and notify_group_deleted has already said the
  -- group is gone, so stay quiet for those.
  if old.group_id is not null
     and coalesce(current_setting('splittywise.deleting_group', true), '')
         = old.group_id::text
  then
    return old;
  end if;

  select full_name into actor_name from public.profiles where id = me;
  if old.group_id is not null then
    select name into gname from public.groups where id = old.group_id;
  end if;

  insert into public.notifications (user_id, actor_id, type, title, body, is_read)
  select uid, me, 'expense_deleted',
         case when uid = me then 'You deleted "'
              else coalesce(actor_name, 'Someone') || ' deleted "' end
           || old.description || '"',
         '₹' || to_char(old.amount, 'FM999999990.00') || coalesce(' in ' || gname, ''),
         uid = me
  from (
    select user_id as uid from public.expense_splits where expense_id = old.id
    union
    select me
  ) touched
  where uid is not null;

  return old;
end $$;

drop trigger if exists on_expense_deleted on public.expenses;
create trigger on_expense_deleted
  before delete on public.expenses
  for each row execute function public.notify_expense_deleted();

-- "You created the group X" in your own activity feed.
create or replace function public.notify_group_created()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (user_id, actor_id, type, title, body, group_id)
  values (new.created_by, new.created_by, 'group_created',
          'You created ' || new.name, 'Add people to start splitting.', new.id);
  return new;
end $$;

drop trigger if exists on_group_created on public.groups;
create trigger on_group_created
  after insert on public.groups
  for each row execute function public.notify_group_created();

-- Again BEFORE, so the membership rows still exist, and with group_id left
-- null so the notification does not cascade away with the group.
create or replace function public.notify_group_deleted()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  me          uuid := auth.uid();
  actor_name  text;
begin
  -- Transaction-local, and read by notify_expense_deleted so the cascade
  -- does not emit one notification per expense in the group.
  perform set_config('splittywise.deleting_group', old.id::text, true);

  select full_name into actor_name from public.profiles where id = me;

  insert into public.notifications (user_id, actor_id, type, title, body)
  select gm.user_id, me, 'group_deleted',
         case when gm.user_id = me then 'You deleted ' || old.name
              else coalesce(actor_name, 'Someone') || ' deleted ' || old.name end,
         'Its expenses went with it.'
  from public.group_members gm
  where gm.group_id = old.id;

  return old;
end $$;

drop trigger if exists on_group_deleted on public.groups;
create trigger on_group_deleted
  before delete on public.groups
  for each row execute function public.notify_group_deleted();

create or replace function public.notify_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor_name  text;
  descr       text;
  gid         uuid;
begin
  select full_name into actor_name from public.profiles where id = new.author_id;
  select description, group_id into descr, gid
    from public.expenses where id = new.expense_id;

  insert into public.notifications
    (user_id, actor_id, type, title, body, group_id, expense_id, is_read)
  select distinct uid, new.author_id, 'comment',
         case when uid = new.author_id then 'You commented on "'
              else actor_name || ' commented on "' end || descr || '"',
         left(new.body, 120), gid, new.expense_id, uid = new.author_id
  from (
    select user_id as uid from public.expense_splits where expense_id = new.expense_id
    union
    select user_id from public.expense_payers where expense_id = new.expense_id
    union
    select author_id from public.expense_comments where expense_id = new.expense_id
    union
    select new.author_id
  ) everyone;

  return new;
end $$;

drop trigger if exists on_comment_created on public.expense_comments;
create trigger on_comment_created
  after insert on public.expense_comments
  for each row execute function public.notify_comment();

drop trigger if exists on_settlement_created on public.settlements;
create trigger on_settlement_created
  after insert on public.settlements
  for each row execute function public.notify_settlement();

-- Nudge someone who owes you. Rate limited to once every twelve hours per
-- person, because a reminder button with no limit is a way to harass people.
create or replace function public.nudge(
  p_user_id  uuid,
  p_group_id uuid default null,
  p_amount   numeric default null
) returns json language plpgsql security definer set search_path = public as $$
declare
  me       uuid := auth.uid();
  my_name  text;
  gname    text;
  recent   timestamptz;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  if p_user_id = me then
    return json_build_object('ok', false, 'error', 'self');
  end if;
  if not (sw.are_friends(me, p_user_id)
          or exists (select 1 from sw.group_peers(me) g where g = p_user_id)) then
    return json_build_object('ok', false, 'error', 'stranger');
  end if;

  select max(created_at) into recent
    from public.notifications
    where user_id = p_user_id and actor_id = me and type = 'nudge';

  if recent is not null and recent > now() - interval '12 hours' then
    return json_build_object('ok', false, 'error', 'too_soon');
  end if;

  select full_name into my_name from public.profiles where id = me;
  if p_group_id is not null then
    select name into gname from public.groups where id = p_group_id;
  end if;

  insert into public.notifications (user_id, actor_id, type, title, body, group_id)
  values (p_user_id, me, 'nudge',
          my_name || ' sent you a reminder',
          coalesce('You owe ₹' || to_char(p_amount, 'FM999999990.00'), 'You have a balance outstanding')
            || coalesce(' in ' || gname, ''),
          p_group_id);

  return json_build_object('ok', true);
end $$;

-- Deleting is now a soft delete, so the BEFORE DELETE trigger no longer
-- fires on the way out. This does the same job, and is also what restores.
create or replace function public.set_expense_deleted(
  p_expense_id uuid,
  p_deleted    boolean
) returns void language plpgsql security definer set search_path = public as $$
declare
  me          uuid := auth.uid();
  row_before  public.expenses;
  actor_name  text;
  gname       text;
begin
  if me is null then raise exception 'Not authenticated'; end if;
  if not sw.can_see_expense(p_expense_id, me) then
    raise exception 'You cannot change this expense';
  end if;

  select * into row_before from public.expenses where id = p_expense_id;
  if row_before.id is null then return; end if;

  update public.expenses
  set deleted_at = case when p_deleted then now() else null end,
      updated_at = now()
  where id = p_expense_id;

  select full_name into actor_name from public.profiles where id = me;
  if row_before.group_id is not null then
    select name into gname from public.groups where id = row_before.group_id;
  end if;

  insert into public.notifications
    (user_id, actor_id, type, title, body, group_id, is_read)
  select uid, me,
         case when p_deleted then 'expense_deleted' else 'expense_restored' end,
         case when uid = me
              then (case when p_deleted then 'You deleted "' else 'You restored "' end)
              else actor_name || case when p_deleted then ' deleted "'
                                      else ' restored "' end end
           || row_before.description || '"',
         '₹' || to_char(row_before.amount, 'FM999999990.00')
             || coalesce(' in ' || gname, ''),
         row_before.group_id, uid = me
  from (
    select user_id as uid from public.expense_splits where expense_id = p_expense_id
    union
    select me
  ) touched;
end $$;

-- Monthly settle-up reminders.
--
-- A group's settle_up_day is a day of the month, not a fixed date, so the
-- reminder comes round every month rather than passing once and going stale.
-- Called at launch alongside run_due_recurring(), and it only ever writes to
-- the caller's own feed: each member's own launch raises their own reminder,
-- so nobody's device can spam anybody else's bell.
--
-- Dedupe is per calendar month, so opening the app five times on the 5th
-- gives one reminder, and a month that is missed entirely is simply missed
-- rather than caught up on.
create or replace function public.run_due_settle_reminders()
returns int language plpgsql security definer set search_path = public as $$
declare
  me    uuid := auth.uid();
  made  int;
begin
  if me is null then return 0; end if;

  insert into public.notifications (user_id, actor_id, type, title, body, group_id)
  select me, null, 'settle_reminder',
         'Settle up in ' || g.name,
         'The ' || sw.ordinal_day(g.settle_up_day) ||
         ' has come round — square up with everyone.',
         g.id
  from public.groups g
  join public.group_members gm on gm.group_id = g.id and gm.user_id = me
  where g.settle_up_day is not null
    -- Today has reached the day. A 31 in a 30-day month lands on the 30th,
    -- so a short month still gets its reminder instead of skipping.
    and extract(day from current_date)::int >= least(
          g.settle_up_day,
          extract(day from (date_trunc('month', current_date)
                            + interval '1 month' - interval '1 day'))::int)
    and not exists (
      select 1 from public.notifications n
      where n.user_id = me
        and n.group_id = g.id
        and n.type = 'settle_reminder'
        and n.created_at >= date_trunc('month', current_date)
    );

  get diagnostics made = row_count;
  return made;
end $$;

-- Anything in your trash for more than thirty days goes for good. Called at
-- launch, so the bin empties itself without a scheduler.
create or replace function public.purge_trash()
returns json language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  gone_e  int;
  gone_s  int;
begin
  if me is null then raise exception 'Not authenticated'; end if;

  with removed as (
    delete from public.expenses
    where created_by = me
      and deleted_at is not null
      and deleted_at < now() - interval '30 days'
    returning 1
  ) select count(*) into gone_e from removed;

  with removed as (
    delete from public.settlements
    where created_by = me
      and deleted_at is not null
      and deleted_at < now() - interval '30 days'
    returning 1
  ) select count(*) into gone_s from removed;

  -- ---- retention, so the diagnostic tables cannot grow without limit ----
  --
  -- admin_audit is tiny: one row per administrative action, and those are
  -- rare — a few hundred bytes each, a few dozen a year for one owner. A
  -- year is kept because the point of an audit trail is being able to look
  -- back at something that surfaced later.
  --
  -- error_reports is the one that can actually run away: it is written by
  -- every device that throws. It is capped at 50 per person per hour by
  -- cap_error_reports(), and thirty days is far longer than a bug report
  -- stays useful.
  --
  -- Both run for everybody rather than per-caller, because they are not
  -- anybody's data — and this function is already called once a day, by
  -- whoever opens the app first.
  delete from public.error_reports where at < now() - interval '30 days';
  delete from public.admin_audit   where at < now() - interval '365 days';

  -- A read notification nobody will ever scroll back to is also just weight.
  delete from public.notifications
   where is_read and created_at < now() - interval '90 days';

  return json_build_object('ok', true, 'expenses', gone_e, 'settlements', gone_s);
end $$;

-- ============================================================================
--  10. NOTIFICATIONS — bulk helpers
-- ============================================================================

create or replace function public.mark_all_notifications_read()
returns void language sql security definer set search_path = public as $$
  update public.notifications
  set is_read = true
  where user_id = auth.uid() and is_read = false;
$$;

-- ============================================================================
--  11. STORAGE — avatars and group covers
--
--  Receipts are deliberately absent: a scan happens on the device and the
--  image is thrown away, so nothing piles up. What is stored is one small
--  picture per person and one per group, each capped at 100 KB by the
--  client, which keeps the whole bucket in the tens of megabytes.
-- ============================================================================

-- The old receipts bucket has to go through the dashboard: Supabase blocks
-- deleting from storage.objects and storage.buckets in SQL, to stop a bucket
-- being orphaned from its files. Its policies are ours, so those go here.
drop policy if exists receipts_insert on storage.objects;
drop policy if exists receipts_select on storage.objects;
drop policy if exists receipts_delete on storage.objects;

do $$
begin
  if exists (select 1 from storage.buckets where id = 'receipts') then
    raise notice 'A `receipts` bucket still exists. Nothing writes to it any '
                 'more. Delete it under Storage in the dashboard to reclaim '
                 'the space — see README section 2.5.';
  end if;
end $$;

-- Creating a bucket needs storage privileges the SQL editor usually has but
-- a restricted role may not. Wrapped so a refusal reports itself instead of
-- taking the rest of the schema down with it.
do $$
begin
  insert into storage.buckets (id, name, public)
  values ('avatars', 'avatars', false)
  on conflict (id) do nothing;
exception when insufficient_privilege or undefined_table then
  raise notice 'Could not create the `avatars` bucket from SQL. Create it '
               'under Storage in the dashboard, private, then re-run.';
end $$;

-- Upload only under your own uid/ prefix; anyone signed in may read, since
-- an avatar is shown to whoever you split with. Served through short-lived
-- signed URLs rather than publicly.
drop policy if exists avatars_insert on storage.objects;
create policy avatars_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists avatars_select on storage.objects;
create policy avatars_select on storage.objects
  for select to authenticated using (bucket_id = 'avatars');

drop policy if exists avatars_delete on storage.objects;
create policy avatars_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

do $$
begin
  insert into storage.buckets (id, name, public)
  values ('covers', 'covers', false)
  on conflict (id) do nothing;
exception when insufficient_privilege or undefined_table then
  raise notice 'Could not create the `covers` bucket from SQL. Create it '
               'under Storage in the dashboard, private, then re-run.';
end $$;

drop policy if exists covers_insert on storage.objects;
create policy covers_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'covers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists covers_select on storage.objects;
create policy covers_select on storage.objects
  for select to authenticated
  using (bucket_id = 'covers');

drop policy if exists covers_delete on storage.objects;
create policy covers_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'covers'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Renaming a category.
--
-- Expenses store their category as plain text, which is what lets a category
-- be deleted without migrating anything — but it also means a rename would
-- leave every existing expense pointing at a name that no longer exists.
-- Their charts would quietly split in two: some spending under the old name,
-- the rest under the new one.
--
-- So the rename carries them. Scoped to expenses the caller created, because
-- expenses.category is one shared column: renaming your own "Groceries" to
-- "Food" must not relabel an expense somebody else entered.
create or replace function public.rename_category(p_old text, p_new text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  old_nm  text := trim(p_old);
  new_nm  text := trim(p_new);
  moved   int;
begin
  if me is null then raise exception 'Not signed in.'; end if;
  if new_nm = '' then raise exception 'A category needs a name.'; end if;
  if old_nm = new_nm then return jsonb_build_object('ok', true, 'expenses', 0); end if;

  if exists (select 1 from public.user_categories
             where user_id = me and lower(name) = lower(new_nm)
               and lower(name) <> lower(old_nm)) then
    raise exception 'You already have a category called %.', new_nm;
  end if;

  update public.user_categories
     set name = new_nm
   where user_id = me and name = old_nm;

  if not found then raise exception 'No category called %.', old_nm; end if;

  update public.expenses
     set category = new_nm, updated_at = now()
   where created_by = me and category = old_nm and deleted_at is null;
  get diagnostics moved = row_count;

  -- Any budget on the old name follows it, and recurring rules too.
  update public.recurring_expenses
     set category = new_nm
   where created_by = me and category = old_nm;

  return jsonb_build_object('ok', true, 'expenses', moved, 'name', new_nm);
end $$;

-- ============================================================================
--  11b. UNDOING A PAYMENT
--
--  Settlements are never edited and never hard-deleted, because balances are
--  derived from (expenses - settlements) and rewriting history would move
--  figures nobody agreed to move. Undo is therefore a soft delete, and the
--  balance simply stops subtracting it.
--
--  Only the most recent payment in its own scope may be undone. Undoing an
--  older one would leave the newer ones sitting on top of a balance that no
--  longer explains them — "you paid the remaining 400" is nonsense once the
--  600 beneath it has gone. Scope is the pair *and* the group, because that
--  is what the screen showing the Undo button is listing.
--
--  Worth stating plainly, because it is the case the owner asked about:
--  settling 500 and then amending the expense down to 450 leaves a net of
--  -50, i.e. they now owe you 50. That is correct and needs no undo — the
--  balance is derived, so it self-corrects, and the 50 carries into the next
--  expense between you. Undo is for a payment recorded *in error*, not for a
--  payment whose expense later changed.
-- ============================================================================

create or replace function public.undo_settlement(p_settlement uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me       uuid := auth.uid();
  row_s    public.settlements;
  newest   uuid;
  other    uuid;
  my_name  text;
  gname    text;
begin
  if me is null then raise exception 'Not signed in.'; end if;

  select * into row_s from public.settlements where id = p_settlement;
  if row_s.id is null then raise exception 'No such payment.'; end if;
  if row_s.deleted_at is not null then
    raise exception 'That payment has already been undone.';
  end if;

  -- Only someone the money moved between, or whoever recorded it.
  if me not in (row_s.from_user, row_s.to_user, row_s.created_by) then
    raise exception 'That is not your payment to undo.';
  end if;

  -- The newest live payment between these two, in this same group scope.
  select id into newest
    from public.settlements
   where deleted_at is null
     and (group_id is null) = (row_s.group_id is null)
     and coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = coalesce(row_s.group_id, '00000000-0000-0000-0000-000000000000'::uuid)
     and least(from_user, to_user) = least(row_s.from_user, row_s.to_user)
     and greatest(from_user, to_user) = greatest(row_s.from_user, row_s.to_user)
   order by settled_on desc, created_at desc
   limit 1;

  if newest is distinct from p_settlement then
    raise exception 'Only the most recent payment can be undone. Undo the later one first.';
  end if;

  update public.settlements
     set deleted_at = now()
   where id = p_settlement;

  other := case when me = row_s.from_user then row_s.to_user else row_s.from_user end;
  select full_name into my_name from public.profiles where id = me;
  if row_s.group_id is not null then
    select name into gname from public.groups where id = row_s.group_id;
  end if;

  -- Both sides hear about it, including whoever did it — a payment being
  -- un-recorded moves somebody's balance, so silence is not an option.
  insert into public.notifications
    (user_id, actor_id, type, title, body, group_id, is_read)
  select uid, me, 'settlement_undone',
         case when uid = me then 'You undid a payment of ₹'
              else coalesce(my_name, 'Someone') || ' undid a payment of ₹' end
           || to_char(row_s.amount, 'FM999999990.00'),
         'The balance is back to what it was'
           || coalesce(' · ' || gname, '')
           || coalesce(' · ' || row_s.note, ''),
         row_s.group_id, uid = me
  from (select me as uid union select other) sides   --  is reserved
  where uid is not null;

  return jsonb_build_object(
    'id', p_settlement,
    'amount', row_s.amount,
    'other', other);
end $$;

-- ============================================================================
--  12. ADMINISTRATION
--
--  There is deliberately no separate "admin" account with a shared password.
--  This is a static site: js/config.js is delivered to the browser, so any
--  credential the page could check is a credential the visitor already has.
--  Admin is instead a flag on a real account, which means it inherits that
--  account's password rules, email confirmation and MFA.
--
--  Bootstrap the first one by hand, once:
--
--    update public.profiles set is_admin = true where email = 'you@example.com';
--
--  Everything below is gated on that flag inside the function body, not by
--  RLS on the caller. These functions are security definer because their
--  whole job is to see past RLS — so each one re-checks the caller on its
--  first line, and refusing is an exception, never an empty result.
-- ============================================================================

alter table public.profiles add column if not exists is_admin boolean not null default false;

-- Global switches. One row per setting, so a new one does not need a
-- migration. Read only through the functions below.
create table if not exists public.app_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null
);

insert into public.app_settings (key, value) values
  ('signups_enabled', '{"enabled": true}'::jsonb),
  ('invite_only',     '{"enabled": false}'::jsonb)
on conflict (key) do nothing;

-- Blocking an address does two things: it stops a new account being created
-- with it (the trigger below), and the admin API sets banned_until on any
-- existing account, which is what stops them logging in.
create table if not exists public.banned_emails (
  email      text primary key check (email = lower(email)),
  reason     text,
  banned_at  timestamptz not null default now(),
  banned_by  uuid references public.profiles(id) on delete set null
);

-- Who may create an account while invite_only is on. The admin's own
-- "create user" path writes here first, so it is not blocked by its own rule.
create table if not exists public.allowed_emails (
  email      text primary key check (email = lower(email)),
  note       text,
  added_at   timestamptz not null default now(),
  added_by   uuid references public.profiles(id) on delete set null
);

-- Every admin action, append-only. An admin panel without this is a panel
-- where nobody can say afterwards what was done or by whom.
create table if not exists public.admin_audit (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid references public.profiles(id) on delete set null,
  actor_email   text not null default '',
  action        text not null,
  target_email  text,
  target_id     uuid,
  detail        jsonb not null default '{}'::jsonb,
  at            timestamptz not null default now()
);

-- Client-side failures, so "any failures i can see" is answerable. The app
-- already surfaces an error as a toast; this keeps it after the toast is gone.
create table if not exists public.error_reports (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.profiles(id) on delete set null,
  message    text not null,
  source     text,
  line       int,
  col        int,
  stack      text,
  url        text,
  ua         text,
  at         timestamptz not null default now()
);

create index if not exists idx_admin_audit_at    on public.admin_audit (at desc);
create index if not exists idx_error_reports_at  on public.error_reports (at desc);
create index if not exists idx_error_reports_msg on public.error_reports (message);
create index if not exists idx_profiles_created  on public.profiles (created_at desc);

alter table public.app_settings   enable row level security;
alter table public.banned_emails  enable row level security;
alter table public.allowed_emails enable row level security;
alter table public.admin_audit    enable row level security;
alter table public.error_reports  enable row level security;

-- ---------------------------------------------------------------------------
--  Is the caller an admin? In `sw`, because policies call it and the REST
--  API must not expose it.
-- ---------------------------------------------------------------------------
create or replace function sw.is_admin(uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = uid), false);
$$;

-- These four tables are admin-only, and reachable only through the security
-- definer functions below. The policies exist so that a direct REST call with
-- an admin's own token can read them too, and so nothing is RLS-enabled with
-- no policy at all.
drop policy if exists app_settings_admin on public.app_settings;
create policy app_settings_admin on public.app_settings
  for select using (sw.is_admin((select auth.uid())));

drop policy if exists banned_emails_admin on public.banned_emails;
create policy banned_emails_admin on public.banned_emails
  for select using (sw.is_admin((select auth.uid())));

drop policy if exists allowed_emails_admin on public.allowed_emails;
create policy allowed_emails_admin on public.allowed_emails
  for select using (sw.is_admin((select auth.uid())));

drop policy if exists admin_audit_admin on public.admin_audit;
create policy admin_audit_admin on public.admin_audit
  for select using (sw.is_admin((select auth.uid())));

-- Anyone may report their own failure; only an admin may read them. Writing
-- one for somebody else is pointless and would let a client forge blame.
drop policy if exists error_reports_own_insert on public.error_reports;
create policy error_reports_own_insert on public.error_reports
  for insert with check (user_id = (select auth.uid()));

drop policy if exists error_reports_admin_read on public.error_reports;
create policy error_reports_admin_read on public.error_reports
  for select using (sw.is_admin((select auth.uid())));

-- A loop that throws on every frame would otherwise write thousands of rows.
-- Dropping the row silently is right here: the report is a courtesy, and
-- failing the client's insert would turn one bug into two.
create or replace function public.cap_error_reports()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.error_reports
      where user_id = new.user_id and at > now() - interval '1 hour') >= 50 then
    return null;
  end if;
  return new;
end $$;

drop trigger if exists on_error_report on public.error_reports;
create trigger on_error_report
  before insert on public.error_reports
  for each row execute function public.cap_error_reports();

-- ---------------------------------------------------------------------------
--  Signup gate
--
--  Authoritative, because it runs inside the transaction that creates the
--  user: raising here means no auth.users row and no profile. The client
--  asks netlify/functions/signup-check first only so it can say *why*.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  addr text := lower(new.email);
begin
  if exists (select 1 from public.banned_emails where email = addr) then
    raise exception 'This email address is blocked.' using errcode = 'check_violation';
  end if;

  if not coalesce((select (value->>'enabled')::boolean
                   from public.app_settings where key = 'signups_enabled'), true) then
    raise exception 'New accounts are closed.' using errcode = 'check_violation';
  end if;

  if coalesce((select (value->>'enabled')::boolean
               from public.app_settings where key = 'invite_only'), false)
     and not exists (select 1 from public.allowed_emails where email = addr) then
    raise exception 'This app is invite only.' using errcode = 'check_violation';
  end if;

  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    addr,
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'full_name'), ''),
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
--  Admin reads and writes
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
--  is_admin cannot be self-granted
--
--  profiles_update lets you update your own row, which is right for your
--  name and your UPI ID — and would have let anybody run
--
--    update profiles set is_admin = true where id = auth.uid()
--
--  straight from the browser console. RLS is row-level, not column-level,
--  so the policy cannot express "every column but this one". A trigger can.
--
--  Only admin_set_profile() may move the flag, and it sets a transaction
--  local marker first so this trigger knows the change came from there.
-- ---------------------------------------------------------------------------
create or replace function public.guard_admin_flag()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- coalesce is load-bearing: current_setting(name, true) is NULL when the
  -- setting has never been set, and `NULL <> 'yes'` is NULL, not true — so
  -- without it this `if` never fires and the guard silently permits
  -- everything. That exact bug let a normal user grant themselves admin.
  if new.is_admin is distinct from old.is_admin
     and coalesce(current_setting('splittywise.granting_admin', true), 'no') <> 'yes' then
    raise exception 'is_admin can only be changed by an administrator.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists on_profile_admin_guard on public.profiles;
create trigger on_profile_admin_guard
  before update on public.profiles
  for each row execute function public.guard_admin_flag();

create or replace function public.admin_log(
  p_action text, p_target_email text default null,
  p_target_id uuid default null, p_detail jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if not sw.is_admin(me) then raise exception 'Not an administrator.'; end if;
  insert into public.admin_audit (actor_id, actor_email, action, target_email, target_id, detail)
  values (me, coalesce((select email from public.profiles where id = me), ''),
          p_action, lower(nullif(p_target_email, '')), p_target_id, coalesce(p_detail, '{}'::jsonb));
end $$;

-- The dashboard, in one round trip rather than a dozen.
create or replace function public.admin_stats()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); out jsonb;
begin
  if not sw.is_admin(me) then raise exception 'Not an administrator.'; end if;

  select jsonb_build_object(
    'users',           (select count(*) from public.profiles),
    'admins',          (select count(*) from public.profiles where is_admin),
    'banned',          (select count(*) from public.banned_emails),
    'groups',          (select count(*) from public.groups),
    'expenses',        (select count(*) from public.expenses where deleted_at is null),
    'expenses_binned', (select count(*) from public.expenses where deleted_at is not null),
    'settlements',     (select count(*) from public.settlements where deleted_at is null),
    'settled_paise',   (select coalesce(round(sum(amount) * 100), 0)::bigint
                        from public.settlements where deleted_at is null),
    'groups_reminding',(select count(*) from public.groups where settle_up_day is not null),
    -- Total value passing through the app. Not anyone's balance: the sum of
    -- every live expense, which is the only figure that is meaningful here.
    'volume_paise',    (select coalesce(round(sum(amount) * 100), 0)::bigint
                        from public.expenses where deleted_at is null),
    'errors_24h',      (select count(*) from public.error_reports
                        where at > now() - interval '24 hours'),
    'errors_total',    (select count(*) from public.error_reports),
    -- So "will this fill up the database?" is answerable by looking, rather
    -- than by being reassured.
    'audit_rows',      (select count(*) from public.admin_audit),
    'db_bytes',        pg_database_size(current_database()),
    'kept_bytes',      pg_total_relation_size('public.admin_audit')
                     + pg_total_relation_size('public.error_reports')
                     + pg_total_relation_size('public.notifications'),
    -- "Active" means wrote something, not opened the app: we do not track
    -- sessions, and inventing a number would be worse than not having one.
    'active_7d',       (select count(distinct created_by) from public.expenses
                        where created_at > now() - interval '7 days'),
    'active_30d',      (select count(distinct created_by) from public.expenses
                        where created_at > now() - interval '30 days'),
    'signups_enabled', coalesce((select (value->>'enabled')::boolean
                                 from public.app_settings where key = 'signups_enabled'), true),
    'invite_only',     coalesce((select (value->>'enabled')::boolean
                                 from public.app_settings where key = 'invite_only'), false),
    'allowed_emails',  (select count(*) from public.allowed_emails),
    -- Thirty days of counts, zero-filled, so a gap shows as a gap.
    'series',          (select coalesce(jsonb_agg(jsonb_build_object(
                            'day', d::date,
                            'signups', (select count(*) from public.profiles
                                        where created_at::date = d::date),
                            'expenses', (select count(*) from public.expenses
                                         where created_at::date = d::date),
                            'errors', (select count(*) from public.error_reports
                                       where at::date = d::date)
                          ) order by d), '[]'::jsonb)
                        from generate_series(current_date - 29, current_date, '1 day') d)
  ) into out;

  return out;
end $$;

-- One page of people, newest first, with enough to act on.
create or replace function public.admin_users(
  p_search text default null, p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); q text; out jsonb;
begin
  if not sw.is_admin(me) then raise exception 'Not an administrator.'; end if;
  q := '%' || lower(trim(coalesce(p_search, ''))) || '%';

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.created_at desc), '[]'::jsonb)
    into out
  from (
    select p.id, p.email, p.full_name, p.is_admin, p.created_at, p.avatar_emoji,
           p.email_notify,
           exists (select 1 from public.banned_emails b where b.email = p.email) as banned,
           (select count(*) from public.expenses e
             where e.created_by = p.id and e.deleted_at is null) as expenses,
           (select count(*) from public.group_members gm where gm.user_id = p.id) as groups,
           (select max(e.created_at) from public.expenses e where e.created_by = p.id) as last_write
    from public.profiles p
    where p_search is null or trim(p_search) = ''
       or lower(p.email) like q or lower(p.full_name) like q
    order by p.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    offset greatest(0, coalesce(p_offset, 0))
  ) t;

  return out;
end $$;

-- Everything about one person, which is the "see their data" half of the ask.
create or replace function public.admin_user_detail(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); out jsonb;
begin
  if not sw.is_admin(me) then raise exception 'Not an administrator.'; end if;

  select jsonb_build_object(
    'profile', (select row_to_json(p)::jsonb from public.profiles p where p.id = p_user),
    'groups',  (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', g.id, 'name', g.name, 'emoji', g.emoji,
                  'members', (select count(*) from public.group_members m where m.group_id = g.id)
                ) order by g.created_at desc), '[]'::jsonb)
                from public.groups g
                join public.group_members gm on gm.group_id = g.id and gm.user_id = p_user),
    'friends', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', pr.id, 'email', pr.email, 'name', pr.full_name)), '[]'::jsonb)
                from public.friendships f
                join public.profiles pr on pr.id = case when f.user_a = p_user
                                                        then f.user_b else f.user_a end
                where p_user in (f.user_a, f.user_b)),
    'expenses', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', e.id, 'description', e.description, 'amount', e.amount,
                  'date', e.expense_date, 'emoji', e.emoji, 'group_id', e.group_id,
                  'deleted_at', e.deleted_at,
                  'share', (select s.amount from public.expense_splits s
                            where s.expense_id = e.id and s.user_id = p_user)
                ) order by e.expense_date desc, e.created_at desc), '[]'::jsonb)
                from public.expenses e
                where exists (select 1 from public.expense_splits s
                              where s.expense_id = e.id and s.user_id = p_user)
                   or e.created_by = p_user),
    'settlements', (select coalesce(jsonb_agg(jsonb_build_object(
                  'id', s.id, 'from_user', s.from_user, 'to_user', s.to_user,
                  'amount', s.amount, 'on', s.settled_on, 'note', s.note)
                  order by s.settled_on desc), '[]'::jsonb)
                from public.settlements s
                where p_user in (s.from_user, s.to_user) and s.deleted_at is null),
    'errors', (select coalesce(jsonb_agg(jsonb_build_object(
                  'message', r.message, 'at', r.at, 'source', r.source)
                  order by r.at desc), '[]'::jsonb)
                from public.error_reports r where r.user_id = p_user)
  ) into out;

  if out->'profile' is null or out->>'profile' is null then
    raise exception 'No such person.';
  end if;
  return out;
end $$;

-- Editing somebody's profile. Email is deliberately not editable here: it is
-- the login identity, lives in auth.users, and changing only this copy would
-- put the two out of step. The admin function does that through the auth API.
create or replace function public.admin_set_profile(
  p_user uuid, p_full_name text default null, p_upi_id text default null,
  p_is_admin boolean default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); target_email text;
begin
  if not sw.is_admin(me) then raise exception 'Not an administrator.'; end if;
  select email into target_email from public.profiles where id = p_user;
  if target_email is null then raise exception 'No such person.'; end if;

  -- Taking your own admin rights away locks you out of this panel with no
  -- way back except SQL, so it is refused rather than confirmed.
  if p_user = me and p_is_admin = false then
    raise exception 'You cannot remove your own admin rights.';
  end if;

  -- Transaction local, so it is gone the moment this function returns and
  -- cannot be left switched on for anything else.
  perform set_config('splittywise.granting_admin', 'yes', true);

  update public.profiles set
    full_name  = coalesce(nullif(trim(p_full_name), ''), full_name),
    upi_id     = case when p_upi_id is null then upi_id
                      else nullif(trim(p_upi_id), '') end,
    is_admin   = coalesce(p_is_admin, is_admin),
    updated_at = now()
  where id = p_user;

  perform set_config('splittywise.granting_admin', 'no', true);

  perform public.admin_log('profile_edited', target_email, p_user,
    jsonb_build_object('full_name', p_full_name, 'upi_id', p_upi_id, 'is_admin', p_is_admin));

  return (select row_to_json(p)::jsonb from public.profiles p where p.id = p_user);
end $$;

-- Bin or restore anybody's expense, and delete a group.
create or replace function public.admin_set_expense_deleted(p_expense uuid, p_deleted boolean)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); d text;
begin
  if not sw.is_admin(me) then raise exception 'Not an administrator.'; end if;
  select description into d from public.expenses where id = p_expense;
  if d is null then raise exception 'No such expense.'; end if;

  update public.expenses
     set deleted_at = case when p_deleted then now() else null end, updated_at = now()
   where id = p_expense;

  perform public.admin_log(
    case when p_deleted then 'expense_binned' else 'expense_restored' end,
    null, p_expense, jsonb_build_object('description', d));
end $$;

create or replace function public.admin_delete_group(p_group uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); n text;
begin
  if not sw.is_admin(me) then raise exception 'Not an administrator.'; end if;
  select name into n from public.groups where id = p_group;
  if n is null then raise exception 'No such group.'; end if;

  perform public.admin_log('group_deleted', null, p_group, jsonb_build_object('name', n));
  delete from public.groups where id = p_group;
end $$;

-- Global switches.
create or replace function public.admin_set_setting(p_key text, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if not sw.is_admin(me) then raise exception 'Not an administrator.'; end if;
  if p_key not in ('signups_enabled', 'invite_only') then
    raise exception 'Unknown setting %.', p_key;
  end if;

  insert into public.app_settings (key, value, updated_at, updated_by)
  values (p_key, jsonb_build_object('enabled', p_enabled), now(), me)
  on conflict (key) do update
    set value = excluded.value, updated_at = now(), updated_by = me;

  perform public.admin_log('setting_changed', null, null,
    jsonb_build_object('key', p_key, 'enabled', p_enabled));

  return jsonb_build_object('key', p_key, 'enabled', p_enabled);
end $$;

-- The signup allowlist, for invite-only mode.
create or replace function public.admin_allow_email(p_email text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); addr text := lower(trim(p_email));
begin
  if not sw.is_admin(me) then raise exception 'Not an administrator.'; end if;
  if addr !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That is not an email address.'; end if;

  insert into public.allowed_emails (email, note, added_by)
  values (addr, nullif(trim(p_note), ''), me)
  on conflict (email) do update set note = excluded.note, added_by = me;

  perform public.admin_log('email_allowed', addr, null, '{}'::jsonb);
end $$;

create or replace function public.admin_disallow_email(p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); addr text := lower(trim(p_email));
begin
  if not sw.is_admin(me) then raise exception 'Not an administrator.'; end if;
  delete from public.allowed_emails where email = addr;
  perform public.admin_log('email_disallowed', addr, null, '{}'::jsonb);
end $$;

create or replace function public.admin_lists()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if not sw.is_admin(me) then raise exception 'Not an administrator.'; end if;
  return jsonb_build_object(
    'banned',  (select coalesce(jsonb_agg(jsonb_build_object(
                  'email', b.email, 'reason', b.reason, 'at', b.banned_at,
                  'by', (select email from public.profiles p where p.id = b.banned_by),
                  'has_account', exists (select 1 from public.profiles p where p.email = b.email))
                  order by b.banned_at desc), '[]'::jsonb) from public.banned_emails b),
    'allowed', (select coalesce(jsonb_agg(jsonb_build_object(
                  'email', a.email, 'note', a.note, 'at', a.added_at,
                  'signed_up', exists (select 1 from public.profiles p where p.email = a.email))
                  order by a.added_at desc), '[]'::jsonb) from public.allowed_emails a)
  );
end $$;

-- Failures, grouped, because forty copies of one bug is one bug.
create or replace function public.admin_errors(p_limit int default 100)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if not sw.is_admin(me) then raise exception 'Not an administrator.'; end if;
  return jsonb_build_object(
    'grouped', (select coalesce(jsonb_agg(row_to_json(g)::jsonb order by g.n desc), '[]'::jsonb)
                from (select r.message, count(*) as n, max(r.at) as last_at,
                             count(distinct r.user_id) as people,
                             (array_agg(r.source order by r.at desc))[1] as source,
                             (array_agg(r.stack  order by r.at desc))[1] as stack
                      from public.error_reports r
                      group by r.message
                      order by count(*) desc
                      limit greatest(1, least(coalesce(p_limit, 100), 500))) g),
    'recent',  (select coalesce(jsonb_agg(jsonb_build_object(
                  'message', r.message, 'at', r.at, 'source', r.source, 'line', r.line,
                  'url', r.url, 'ua', r.ua,
                  'who', (select email from public.profiles p where p.id = r.user_id))
                  order by r.at desc), '[]'::jsonb)
                from (select * from public.error_reports order by at desc limit 50) r)
  );
end $$;

create or replace function public.admin_clear_errors()
returns int language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); n int;
begin
  if not sw.is_admin(me) then raise exception 'Not an administrator.'; end if;
  delete from public.error_reports;
  get diagnostics n = row_count;
  perform public.admin_log('errors_cleared', null, null, jsonb_build_object('rows', n));
  return n;
end $$;

create or replace function public.admin_audit_log(p_limit int default 200)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if not sw.is_admin(me) then raise exception 'Not an administrator.'; end if;
  return (select coalesce(jsonb_agg(row_to_json(a)::jsonb order by a.at desc), '[]'::jsonb)
          from (select * from public.admin_audit
                order by at desc
                limit greatest(1, least(coalesce(p_limit, 200), 1000))) a);
end $$;

-- ============================================================================
--  13. GRANTS
--
--  Postgres grants EXECUTE on a new function to PUBLIC by default, which is
--  how every one of these became callable by the anon role. Revoked first,
--  then granted to `authenticated` only.
-- ============================================================================

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig, n.nspname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'sw') and p.prokind = 'f'
  loop
    execute 'revoke all on function ' || r.sig || ' from public';
    execute 'revoke all on function ' || r.sig || ' from anon';
  end loop;
end $$;

grant execute on function public.add_friend_by_email(text)              to authenticated;
grant execute on function public.create_group(text, text, text)         to authenticated;
grant execute on function public.add_group_member_by_email(uuid, text)  to authenticated;
grant execute on function public.mark_all_notifications_read()          to authenticated;
grant execute on function public.add_group_members(uuid, uuid[])        to authenticated;
grant execute on function public.create_invite(uuid)                    to authenticated;
grant execute on function public.redeem_invite(text)                    to authenticated;
grant execute on function public.nudge(uuid, uuid, numeric)              to authenticated;
grant execute on function public.run_due_recurring()                     to authenticated;
grant execute on function public.set_expense_deleted(uuid, boolean)      to authenticated;
grant execute on function public.purge_trash()                           to authenticated;
grant execute on function public.next_occurrence(date, text, int)        to authenticated;
grant execute on function public.create_expense(
  numeric, text, jsonb, uuid, uuid, text, text, text, date, text, jsonb) to authenticated;
grant execute on function public.update_expense(
  uuid, numeric, text, jsonb, uuid, uuid, text, text, text, date, text, jsonb) to authenticated;

-- Admin functions. Every one refuses a non-admin caller on its first line,
-- so granting them to `authenticated` is safe: what stops a normal user is
-- the check inside, not the grant.
grant execute on function public.rename_category(text, text)               to authenticated;
grant execute on function public.undo_settlement(uuid)                     to authenticated;

grant execute on function public.admin_stats()                             to authenticated;
grant execute on function public.admin_users(text, int, int)               to authenticated;
grant execute on function public.admin_user_detail(uuid)                   to authenticated;
grant execute on function public.admin_set_profile(uuid, text, text, boolean) to authenticated;
grant execute on function public.admin_set_expense_deleted(uuid, boolean)  to authenticated;
grant execute on function public.admin_delete_group(uuid)                  to authenticated;
grant execute on function public.admin_set_setting(text, boolean)          to authenticated;
grant execute on function public.admin_allow_email(text, text)             to authenticated;
grant execute on function public.admin_disallow_email(text)                to authenticated;
grant execute on function public.admin_lists()                             to authenticated;
grant execute on function public.admin_errors(int)                         to authenticated;
grant execute on function public.admin_clear_errors()                      to authenticated;
grant execute on function public.admin_audit_log(int)                      to authenticated;
grant execute on function public.admin_log(text, text, uuid, jsonb)        to authenticated;

-- Helpers are called from policies, so authenticated needs execute on them.
grant execute on function sw.is_admin(uuid)               to authenticated;
grant execute on function sw.is_group_member(uuid, uuid)  to authenticated;
grant execute on function sw.is_group_owner(uuid, uuid)   to authenticated;
grant execute on function sw.are_friends(uuid, uuid)      to authenticated;
grant execute on function sw.group_peers(uuid)            to authenticated;
grant execute on function sw.has_split(uuid, uuid)        to authenticated;
grant execute on function sw.can_see_expense(uuid, uuid)  to authenticated;
grant execute on function sw.can_see_profile(uuid, uuid)  to authenticated;

-- ============================================================================
--  14. REALTIME
--  Lets the app receive a notification the moment it is written, instead of
--  polling. RLS still applies: a client only ever receives its own rows.
-- ============================================================================

do $$
begin
  alter publication supabase_realtime add table public.notifications;
exception
  when duplicate_object then null;   -- already added, which is fine
  when undefined_object then
    raise notice 'supabase_realtime publication not found — skipping';
end $$;
