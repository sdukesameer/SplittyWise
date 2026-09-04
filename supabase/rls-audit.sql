-- ============================================================================
--  SplittyWise — security and integrity audit
--
--  One query, so it works from the CLI as well as the dashboard: the
--  Management API only returns the last statement's rows, which is why an
--  earlier version appeared to run and showed a single line.
--
--    ./scripts/db audit
--
--  Every row must read PASS. Anything else is explained in `detail`.
-- ============================================================================

with expected_tables(name) as (
  values ('profiles'),('friendships'),('groups'),('group_members'),('expenses'),
         ('expense_splits'),('expense_payers'),('expense_comments'),
         ('settlements'),('notifications'),('invites'),('recurring_expenses'),
         ('user_categories'),('nicknames'),('split_presets'),('expense_history'),
         -- Administration
         ('app_settings'),('banned_emails'),('allowed_emails'),('admin_audit'),
         ('error_reports')
),

-- The admin tables no client may write to, whatever role it holds. Writes
-- happen only inside the security definer admin_* functions, which check
-- is_admin first. A stray insert/update/delete policy on any of these would
-- hand a signed-in user the ability to unban themselves.
admin_tables(name) as (
  values ('app_settings'),('banned_emails'),('allowed_emails'),('admin_audit')
),

-- 1. Row level security on every table. A single false here means any
--    signed-in user can read that table in full.
rls as (
  select
    'RLS enabled on every table' as check,
    case when count(*) filter (where not t.rowsecurity) = 0 then 'PASS' else 'FAIL' end as result,
    coalesce(string_agg(t.tablename, ', ') filter (where not t.rowsecurity),
             count(*)::text || ' tables') as detail
  from pg_tables t
  join expected_tables e on e.name = t.tablename
  where t.schemaname = 'public'
),

-- 2. Every expected table actually exists.
present as (
  select
    'every expected table exists' as check,
    case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
    coalesce(string_agg(e.name, ', '), 'all 21 present') as detail
  from expected_tables e
  where not exists (
    select 1 from pg_tables t
    where t.schemaname = 'public' and t.tablename = e.name
  )
),

-- 3. RLS with no policy denies everything, which is safe but breaks the app.
policied as (
  select
    'every RLS table has a policy' as check,
    case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
    coalesce(string_agg(t.tablename, ', '), 'all covered') as detail
  from pg_tables t
  where t.schemaname = 'public' and t.rowsecurity
    and not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public' and p.tablename = t.tablename
    )
),

-- 4. A security-definer function that does not pin search_path can be
--    tricked into resolving to a caller-supplied table.
pinned as (
  select
    'security definer functions pin search_path' as check,
    case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
    coalesce(string_agg(p.proname, ', '), 'all pinned') as detail
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'sw') and p.prosecdef
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
      where cfg like 'search_path=%'
    )
),

-- 4b. Nothing should be callable without signing in. Postgres grants
--     EXECUTE to PUBLIC by default, which made every RPC reachable by the
--     anon role — including the RLS helpers, which have no auth check of
--     their own because policies call them.
anon_exec as (
  select
    'nothing executable by anon' as check,
    case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
    coalesce(string_agg(distinct p.proname, ', '), 'none') as detail
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'sw')
    and p.prokind = 'f'
    and (has_function_privilege('anon', p.oid, 'execute')
         or has_function_privilege('public', p.oid, 'execute'))
),

-- 4c. The RLS helpers must not sit in the schema the API exposes.
helpers_private as (
  select
    'RLS helpers are out of the exposed schema' as check,
    case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
    coalesce(string_agg(p.proname, ', '), 'all in sw') as detail
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('is_group_member','is_group_owner','are_friends',
                      'group_peers','has_split','can_see_expense','can_see_profile')
),

-- 4d. A FOR ALL policy also covers SELECT, so it stacks with a dedicated
--     select policy and both run on every read.
overlapping as (
  select
    'no overlapping select policies' as check,
    case when count(*) = 0 then 'PASS' else 'WARN' end as result,
    coalesce(string_agg(tablename || ' (' || n::text || ')', ', '), 'none') as detail
  from (
    select tablename, count(*) as n
    from pg_policies
    where schemaname = 'public'
      and (cmd = 'SELECT' or cmd = 'ALL')
      and 'authenticated' = any (roles)
    group by tablename
    having count(*) > 1
  ) d
),

-- 4e. auth.uid() called bare in a policy is re-evaluated for every row.
initplan as (
  select
    'policies evaluate auth.uid() once' as check,
    case when count(*) = 0 then 'PASS' else 'WARN' end as result,
    coalesce(string_agg(tablename || '.' || policyname, ', '), 'all wrapped') as detail
  from pg_policies
  where schemaname = 'public'
    and (
      (qual is not null and qual like '%auth.uid()%'
       and qual not like '%( SELECT auth.uid()%')
      or (with_check is not null and with_check like '%auth.uid()%'
          and with_check not like '%( SELECT auth.uid()%')
    )
),

-- 5. A public image bucket means any URL leaks every picture.
buckets as (
  select
    'image buckets are private' as check,
    case when count(*) filter (where b.public) = 0 then 'PASS' else 'FAIL' end as result,
    coalesce(string_agg(b.id || case when b.public then ' (PUBLIC!)' else '' end, ', '),
             'no buckets yet') as detail
  from storage.buckets b
),

-- 6. Receipts are not stored at all; the bucket should be gone.
receipts as (
  select
    'no receipts bucket' as check,
    case when count(*) = 0 then 'PASS' else 'WARN' end as result,
    case when count(*) = 0 then 'absent, as intended'
         else 'still present — delete it under Storage, see README 2.5' end as detail
  from storage.buckets where id = 'receipts'
),

-- 7. Only the security-definer functions may write notifications; a client
--    INSERT policy would let anyone forge one for somebody else.
notif as (
  select
    'clients cannot write notifications' as check,
    case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
    coalesce(string_agg(policyname, ', '), 'no client insert policy') as detail
  from pg_policies
  where schemaname = 'public' and tablename = 'notifications' and cmd = 'INSERT'
),

-- 8. Splits must sum to their expense. A mismatch is money appearing or
--    vanishing, and nothing else would ever report it.
splits as (
  select
    'every expense''s splits sum to its total' as check,
    case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
    case when count(*) = 0 then 'all balanced'
         else count(*)::text || ' mismatched — see the query at the end' end as detail
  from (
    select e.id
    from public.expenses e
    left join public.expense_splits s on s.expense_id = e.id
    where e.deleted_at is null
    group by e.id, e.amount
    having e.amount <> coalesce(sum(s.amount), 0)
  ) bad
),

-- 9. And so must the payments.
payments as (
  select
    'every expense''s payments sum to its total' as check,
    case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
    case when count(*) = 0 then 'all balanced'
         else count(*)::text || ' mismatched' end as detail
  from (
    select e.id
    from public.expenses e
    join public.expense_payers pp on pp.expense_id = e.id
    where e.deleted_at is null
    group by e.id, e.amount
    having e.amount <> sum(pp.amount)
  ) bad
),

-- 10. Anything in `public` this app did not create.
strays as (
  select
    'no unexpected tables' as check,
    case when count(*) = 0 then 'PASS' else 'WARN' end as result,
    coalesce(string_agg(t.tablename, ', '), 'none') as detail
  from pg_tables t
  where t.schemaname = 'public'
    and not exists (select 1 from expected_tables e where e.name = t.tablename)
),

-- 11. `create or replace` cannot replace a function whose arguments changed,
--     so an older version can survive as an overload and make calls
--     ambiguous. This is the one that breaks an RPC silently.
overloads as (
  select
    'no duplicate function signatures' as check,
    case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
    coalesce(string_agg(proname || ' x' || n, ', '), 'none') as detail
  from (
    select p.proname, count(*) as n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
    group by p.proname
    having count(*) > 1
  ) d
),

-- 12. Realtime, which is what makes the bell update without a refresh.
realtime as (
  select
    'notifications published for realtime' as check,
    case when count(*) > 0 then 'PASS' else 'WARN' end as result,
    case when count(*) > 0 then 'publishing'
         else 'not published — Database / Replication in the dashboard' end as detail
  from pg_publication_tables
  where pubname = 'supabase_realtime' and schemaname = 'public'
    and tablename = 'notifications'
),

-- 12b. Anything a signed-in user can call must check who is calling.
--
--      Supabase's default ACL grants EXECUTE on every new function in public
--      to anon AND authenticated. The revoke loop in schema.sql strips both,
--      so the explicit grant list is the whole story — but a function that
--      is granted and does not look at its caller is an open door. Every one
--      on the list should reference auth.uid(), sw.is_admin, or be a pure
--      helper that takes the caller as an argument.
authed_unguarded as (
  select
    'every function a user can call checks its caller' as check,
    case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
    coalesce(string_agg(proname, ', '), 'none') as detail
  from (
    select p.proname, pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'sw')
      and p.prokind = 'f'
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) f
  where def not like '%auth.uid()%'
    and def not like '%sw.is_admin%'
    -- Pure helpers: they compute from their arguments and read nothing the
    -- caller is not already entitled to through RLS.
    and proname not in ('next_occurrence', 'ordinal_day', 'shift_month_words',
                        'money', 'group_member_net', 'settle_summary',
                        'is_group_member', 'is_group_owner', 'are_friends',
                        'group_peers', 'has_split', 'can_see_expense',
                        'can_see_profile', 'settle_reminder_body')
),

-- 13. No client may write the admin tables. Writes happen only inside the
--     security definer admin_* functions, each of which checks is_admin on
--     its first line. A stray insert or update policy on any of these would
--     let a signed-in user unban themselves or grant themselves admin.
admin_writes as (
  select
    'admin tables are not client-writable' as check,
    case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
    coalesce(string_agg(p.tablename || '.' || p.policyname, ', '), 'none') as detail
  from pg_policies p
  join admin_tables a on a.name = p.tablename
  where p.schemaname = 'public' and p.cmd <> 'SELECT'
),

-- 14. The admin flag itself. profiles is updatable by its owner, so the
--     update policy must not let somebody set their own is_admin — that
--     would make the whole panel self-service.
-- The first version of this checked only that the trigger existed, and
-- reported PASS while the hole was wide open: the guard compared
-- current_setting(name, true) to a string without coalesce, and NULL <> 'yes'
-- is NULL, so it never fired. A check that confirms a mechanism is present
-- but not that it works is worse than no check, because it is trusted.
-- `./scripts/db attack` proves the behaviour; this catches the regression.
admin_flag as (
  select
    'is_admin cannot be self-granted' as check,
    case when count(*) = 1 then 'PASS' else 'FAIL' end as result,
    case when count(*) = 1 then 'trigger present and NULL-safe'
         when count(*) = 0 then 'no guard — anyone could set their own is_admin'
         else 'guard present but its NULL comparison is unsafe' end as detail
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_proc pr on pr.oid = t.tgfoid
  where c.relname = 'profiles'
    and t.tgname = 'on_profile_admin_guard'
    -- Without coalesce the comparison yields NULL and the guard is inert.
    and pg_get_functiondef(pr.oid) like '%coalesce(current_setting%'
),

-- 15. Every admin function must refuse a non-admin caller. They are
--     security definer, so a missing check is unrestricted access.
admin_checked as (
  select
    'every admin_* function checks the caller' as check,
    case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
    coalesce(string_agg(p.proname, ', '), 'none') as detail
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname like 'admin\_%'
    and pg_get_functiondef(p.oid) not like '%is_admin%'
)

select * from rls
union all select * from present
union all select * from policied
union all select * from pinned
union all select * from anon_exec
union all select * from helpers_private
union all select * from overlapping
union all select * from initplan
union all select * from buckets
union all select * from receipts
union all select * from notif
union all select * from splits
union all select * from payments
union all select * from strays
union all select * from overloads
union all select * from realtime
union all select * from authed_unguarded
union all select * from admin_writes
union all select * from admin_flag
union all select * from admin_checked;

-- ---------------------------------------------------------------------------
--  If check 8 or 9 ever fails, run this in the dashboard to see which rows.
--
--  select e.id, e.description, e.amount as expense_total,
--         coalesce(sum(s.amount), 0) as splits_total
--    from public.expenses e
--    left join public.expense_splits s on s.expense_id = e.id
--   where e.deleted_at is null
--   group by e.id, e.description, e.amount
--  having e.amount <> coalesce(sum(s.amount), 0)
--   order by e.created_at desc;
-- ---------------------------------------------------------------------------
