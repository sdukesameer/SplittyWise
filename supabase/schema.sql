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
  created_by      uuid not null references public.profiles(id) on delete cascade,
  created_at      timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id   uuid not null references public.groups(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null default 'member' check (role in ('owner','member')),
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
  receipt_path  text,
  notes         text,
  created_by    uuid not null references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
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
create index if not exists idx_splits_user         on public.expense_splits(user_id);
create index if not exists idx_settle_from         on public.settlements(from_user);
create index if not exists idx_settle_to           on public.settlements(to_user);
create index if not exists idx_notif_user_unread   on public.notifications(user_id, is_read, created_at desc);

-- ============================================================================
--  3. SECURITY-DEFINER HELPERS
--  These exist so RLS policies can ask "is this person in that group?" without
--  re-entering the policy they were called from (Postgres RLS recursion).
--  Each is STABLE and pins search_path.
-- ============================================================================

create or replace function public.is_group_member(gid uuid, uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = gid and gm.user_id = uid
  );
$$;

create or replace function public.is_group_owner(gid uuid, uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.groups g
    where g.id = gid and g.created_by = uid
  );
$$;

create or replace function public.are_friends(a uuid, b uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.friendships f
    where f.user_a = least(a, b) and f.user_b = greatest(a, b)
  );
$$;

-- Everyone who shares at least one group with uid (includes uid itself).
create or replace function public.group_peers(uid uuid)
returns setof uuid language sql security definer stable set search_path = public as $$
  select distinct gm2.user_id
  from public.group_members gm1
  join public.group_members gm2 on gm2.group_id = gm1.group_id
  where gm1.user_id = uid;
$$;

create or replace function public.has_split(eid uuid, uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.expense_splits s
    where s.expense_id = eid and s.user_id = uid
  );
$$;

create or replace function public.can_see_expense(eid uuid, uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.expenses e
    where e.id = eid and (
         e.payer_id   = uid
      or e.created_by = uid
      or (e.group_id is not null and public.is_group_member(e.group_id, uid))
      or public.has_split(e.id, uid)
    )
  );
$$;

-- You may read a profile only if it is yours, a friend's, or a co-member's.
-- This is what stops the app from being an email-directory of every signup.
create or replace function public.can_see_profile(target uuid, uid uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select target = uid
      or public.are_friends(uid, target)
      or exists (select 1 from public.group_peers(uid) p where p = target);
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
alter table public.settlements    enable row level security;
alter table public.notifications  enable row level security;

-- ---- profiles --------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (public.can_see_profile(id, auth.uid()));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- ---- friendships -----------------------------------------------------------
drop policy if exists friendships_select on public.friendships;
create policy friendships_select on public.friendships
  for select to authenticated
  using (auth.uid() in (user_a, user_b));

drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships
  for insert to authenticated
  with check (created_by = auth.uid() and auth.uid() in (user_a, user_b));

drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships
  for delete to authenticated
  using (auth.uid() in (user_a, user_b));

-- ---- groups ----------------------------------------------------------------
drop policy if exists groups_select on public.groups;
create policy groups_select on public.groups
  for select to authenticated
  using (created_by = auth.uid() or public.is_group_member(id, auth.uid()));

drop policy if exists groups_insert on public.groups;
create policy groups_insert on public.groups
  for insert to authenticated
  with check (created_by = auth.uid());

drop policy if exists groups_update on public.groups;
create policy groups_update on public.groups
  for update to authenticated
  using (public.is_group_member(id, auth.uid()))
  with check (public.is_group_member(id, auth.uid()));

drop policy if exists groups_delete on public.groups;
create policy groups_delete on public.groups
  for delete to authenticated
  using (created_by = auth.uid());

-- ---- group_members ---------------------------------------------------------
drop policy if exists group_members_select on public.group_members;
create policy group_members_select on public.group_members
  for select to authenticated
  using (public.is_group_member(group_id, auth.uid())
      or public.is_group_owner(group_id, auth.uid()));

-- Any member can add another member (Splitwise behaviour); the group creator
-- can seed the first row (themselves) before any membership exists.
drop policy if exists group_members_insert on public.group_members;
create policy group_members_insert on public.group_members
  for insert to authenticated
  with check (public.is_group_member(group_id, auth.uid())
           or public.is_group_owner(group_id, auth.uid()));

-- Leave a group yourself, or be removed by the owner.
drop policy if exists group_members_delete on public.group_members;
create policy group_members_delete on public.group_members
  for delete to authenticated
  using (user_id = auth.uid() or public.is_group_owner(group_id, auth.uid()));

-- ---- expenses --------------------------------------------------------------
drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses
  for select to authenticated
  using (
       payer_id   = auth.uid()
    or created_by = auth.uid()
    or (group_id is not null and public.is_group_member(group_id, auth.uid()))
    or public.has_split(id, auth.uid())
  );

drop policy if exists expenses_insert on public.expenses;
create policy expenses_insert on public.expenses
  for insert to authenticated
  with check (
    created_by = auth.uid()
    and (group_id is null or public.is_group_member(group_id, auth.uid()))
  );

-- Anyone who can see a group expense can correct it, matching Splitwise.
-- For 1:1 expenses only the two parties can.
drop policy if exists expenses_update on public.expenses;
create policy expenses_update on public.expenses
  for update to authenticated
  using (
       created_by = auth.uid()
    or payer_id   = auth.uid()
    or (group_id is not null and public.is_group_member(group_id, auth.uid()))
    or public.has_split(id, auth.uid())
  );

drop policy if exists expenses_delete on public.expenses;
create policy expenses_delete on public.expenses
  for delete to authenticated
  using (
       created_by = auth.uid()
    or payer_id   = auth.uid()
    or (group_id is not null and public.is_group_member(group_id, auth.uid()))
  );

-- ---- expense_splits --------------------------------------------------------
drop policy if exists splits_select on public.expense_splits;
create policy splits_select on public.expense_splits
  for select to authenticated
  using (user_id = auth.uid() or public.can_see_expense(expense_id, auth.uid()));

drop policy if exists splits_write on public.expense_splits;
create policy splits_write on public.expense_splits
  for all to authenticated
  using (public.can_see_expense(expense_id, auth.uid()))
  with check (public.can_see_expense(expense_id, auth.uid()));

-- ---- expense_payers --------------------------------------------------------
drop policy if exists payers_select on public.expense_payers;
create policy payers_select on public.expense_payers
  for select to authenticated
  using (user_id = auth.uid() or public.can_see_expense(expense_id, auth.uid()));

drop policy if exists payers_write on public.expense_payers;
create policy payers_write on public.expense_payers
  for all to authenticated
  using (public.can_see_expense(expense_id, auth.uid()))
  with check (public.can_see_expense(expense_id, auth.uid()));

-- ---- invites ---------------------------------------------------------------
-- Only your own invites are listable. Redeeming goes through
-- redeem_invite(), which is security definer, so a recipient never needs to
-- read the table and tokens cannot be enumerated.
drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites
  for select to authenticated using (created_by = auth.uid());

drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites
  for insert to authenticated with check (created_by = auth.uid());

drop policy if exists invites_delete on public.invites;
create policy invites_delete on public.invites
  for delete to authenticated using (created_by = auth.uid());

-- ---- settlements -----------------------------------------------------------
drop policy if exists settlements_select on public.settlements;
create policy settlements_select on public.settlements
  for select to authenticated
  using (
       auth.uid() in (from_user, to_user)
    or (group_id is not null and public.is_group_member(group_id, auth.uid()))
  );

drop policy if exists settlements_insert on public.settlements;
create policy settlements_insert on public.settlements
  for insert to authenticated
  with check (created_by = auth.uid() and auth.uid() in (from_user, to_user));

drop policy if exists settlements_delete on public.settlements;
create policy settlements_delete on public.settlements
  for delete to authenticated
  using (created_by = auth.uid() or auth.uid() in (from_user, to_user));

-- ---- notifications ---------------------------------------------------------
-- Read/flag your own only. Rows for OTHER people are written exclusively by
-- the security-definer functions below, never by the client.
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated using (user_id = auth.uid());

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications
  for delete to authenticated using (user_id = auth.uid());

-- ============================================================================
--  5. SIGNUP HOOK — mirror auth.users into profiles
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    lower(new.email),
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
  if public.are_friends(me, target.id) then
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
  if not public.is_group_member(p_group_id, me) then
    raise exception 'You are not a member of this group';
  end if;

  select * into target from public.profiles where email = lower(trim(p_email));
  if target.id is null then return json_build_object('ok', false, 'error', 'no_user'); end if;

  if public.is_group_member(p_group_id, target.id) then
    return json_build_object('ok', false, 'error', 'already');
  end if;

  insert into public.group_members (group_id, user_id) values (p_group_id, target.id);

  -- Sharing a group implies knowing each other, so mirror Splitwise and
  -- auto-friend them. Keeps 1:1 balances reachable after the group is gone.
  if target.id <> me and not public.are_friends(me, target.id) then
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
  if not public.is_group_member(p_group_id, me) then
    raise exception 'You are not a member of this group';
  end if;

  select full_name into my_name from public.profiles where id = me;
  select name      into gname   from public.groups   where id = p_group_id;

  foreach uid in array coalesce(p_user_ids, '{}'::uuid[])
  loop
    -- Only people you already know: a friend, or someone already sharing a
    -- group with you. Otherwise this would be a way to pull in strangers.
    if uid = me
       or public.is_group_member(p_group_id, uid)
       or not (public.are_friends(me, uid)
               or exists (select 1 from public.group_peers(me) g where g = uid))
    then
      skipped := skipped + 1;
      continue;
    end if;

    insert into public.group_members (group_id, user_id) values (p_group_id, uid)
    on conflict do nothing;

    if not public.are_friends(me, uid) then
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

  if p_group_id is not null and not public.is_group_member(p_group_id, me) then
    raise exception 'You are not a member of this group';
  end if;

  -- 12 random bytes, base64 made URL-safe. Random rather than an encoded
  -- user id, so a link cannot be forged to make someone your friend.
  tok := rtrim(replace(replace(encode(gen_random_bytes(12), 'base64'), '/', '_'), '+', '-'), '=');

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

  if not public.are_friends(me, inv.created_by) then
    insert into public.friendships (user_a, user_b, created_by)
    values (least(me, inv.created_by), greatest(me, inv.created_by), inv.created_by)
    on conflict do nothing;
  end if;

  if inv.group_id is not null and not public.is_group_member(inv.group_id, me) then
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
  p_receipt_path text    default null,
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
    if not public.is_group_member(p_group_id, me) then
      raise exception 'You are not a member of this group';
    end if;
    select u into bad from (
      select (s->>'user_id')::uuid as u from jsonb_array_elements(p_splits) s
      union
      select (s->>'user_id')::uuid from jsonb_array_elements(payers) s
    ) everyone
    where not public.is_group_member(p_group_id, u)
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
    where u <> me and not public.are_friends(me, u)
    limit 1;
    if bad is not null then
      raise exception 'User % is not one of your friends', bad;
    end if;
  end if;

  -- ---- write ---------------------------------------------------------------
  insert into public.expenses (
    group_id, payer_id, amount, description, emoji, category,
    split_mode, expense_date, notes, receipt_path, created_by
  ) values (
    p_group_id, payer, round(p_amount, 2), trim(p_description),
    coalesce(p_emoji, '🧾'), coalesce(p_category, 'general'),
    coalesce(p_split_mode, 'equal'), coalesce(p_expense_date, current_date),
    nullif(trim(coalesce(p_notes, '')), ''), p_receipt_path, me
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

  insert into public.notifications (user_id, actor_id, type, title, body, group_id, expense_id)
  select sp.user_id, me, 'expense_added',
         actor_name || ' added "' || trim(p_description) || '"',
         '₹' || to_char(round(p_amount, 2), 'FM999999990.00')
             || coalesce(' in ' || gname, '')
             || ' · your share ₹' || to_char(sp.amount, 'FM999999990.00'),
         p_group_id, eid
  from public.expense_splits sp
  where sp.expense_id = eid and sp.user_id <> me;

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
  p_receipt_path text default null,
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
begin
  if me is null then raise exception 'Not authenticated'; end if;
  if not public.can_see_expense(p_expense_id, me) then
    raise exception 'You cannot edit this expense';
  end if;

  select coalesce(p_payer_id, e.payer_id) into payer
    from public.expenses e where e.id = p_expense_id;

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
    if not public.is_group_member(p_group_id, me) then
      raise exception 'You are not a member of this group';
    end if;
    select u into bad from (
      select (s->>'user_id')::uuid as u from jsonb_array_elements(p_splits) s
      union
      select (s->>'user_id')::uuid from jsonb_array_elements(payers) s
    ) everyone
    where not public.is_group_member(p_group_id, u)
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
    where u <> me and not public.are_friends(me, u)
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
    receipt_path = coalesce(p_receipt_path, receipt_path),
    updated_at   = now()
  where id = p_expense_id;

  delete from public.expense_splits where expense_id = p_expense_id;
  insert into public.expense_splits (expense_id, user_id, amount)
  select p_expense_id, (s->>'user_id')::uuid, round((s->>'amount')::numeric, 2)
  from jsonb_array_elements(p_splits) s;

  delete from public.expense_payers where expense_id = p_expense_id;
  insert into public.expense_payers (expense_id, user_id, amount)
  select p_expense_id, (s->>'user_id')::uuid, round((s->>'amount')::numeric, 2)
  from jsonb_array_elements(payers) s;
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
  return null;
end $$;

drop trigger if exists on_settlement_created on public.settlements;
create trigger on_settlement_created
  after insert on public.settlements
  for each row execute function public.notify_settlement();

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
--  11. STORAGE — receipt images
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

-- Upload only under your own uid/ prefix; read anything you hold a link to
-- (the app hands out short-lived signed URLs, never public ones).
drop policy if exists receipts_insert on storage.objects;
create policy receipts_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists receipts_select on storage.objects;
create policy receipts_select on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts');

drop policy if exists receipts_delete on storage.objects;
create policy receipts_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================================
--  12. GRANTS
-- ============================================================================

grant execute on function public.add_friend_by_email(text)              to authenticated;
grant execute on function public.create_group(text, text, text)         to authenticated;
grant execute on function public.add_group_member_by_email(uuid, text)  to authenticated;
grant execute on function public.mark_all_notifications_read()          to authenticated;
grant execute on function public.add_group_members(uuid, uuid[])        to authenticated;
grant execute on function public.create_invite(uuid)                    to authenticated;
grant execute on function public.redeem_invite(text)                    to authenticated;
grant execute on function public.create_expense(
  numeric, text, jsonb, uuid, uuid, text, text, text, date, text, text, jsonb) to authenticated;
grant execute on function public.update_expense(
  uuid, numeric, text, jsonb, uuid, uuid, text, text, text, date, text, text, jsonb) to authenticated;

-- Helpers are called from policies, so authenticated needs execute on them.
grant execute on function public.is_group_member(uuid, uuid)  to authenticated;
grant execute on function public.is_group_owner(uuid, uuid)   to authenticated;
grant execute on function public.are_friends(uuid, uuid)      to authenticated;
grant execute on function public.group_peers(uuid)            to authenticated;
grant execute on function public.has_split(uuid, uuid)        to authenticated;
grant execute on function public.can_see_expense(uuid, uuid)  to authenticated;
grant execute on function public.can_see_profile(uuid, uuid)  to authenticated;

-- ============================================================================
--  13. REALTIME
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
