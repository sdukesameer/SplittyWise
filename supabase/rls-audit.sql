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
         ('user_categories'),('nicknames'),('split_presets'),('expense_history')
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
    coalesce(string_agg(e.name, ', '), 'all 16 present') as detail
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
union all select * from realtime;

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
