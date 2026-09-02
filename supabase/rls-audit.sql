-- ============================================================================
--  SplittyWise — security audit
--  Paste into Supabase Studio -> SQL Editor -> Run.
--  Read the output: it should say PASS on every line.
-- ============================================================================

-- 1. Every table must have row level security switched on. A single `false`
--    here means any signed-in user can read that table in full.
select
  case when bool_and(rowsecurity) then 'PASS' else 'FAIL' end as result,
  'RLS enabled on all public tables' as check,
  count(*) filter (where not rowsecurity) as failures
from pg_tables
where schemaname = 'public'
  and tablename in ('profiles','friendships','groups','group_members',
                    'expenses','expense_splits','settlements','notifications');

-- 2. Which ones, if any, are unprotected.
select tablename, rowsecurity
from pg_tables
where schemaname = 'public' and not rowsecurity
order by tablename;

-- 3. Every table must actually carry policies. RLS with no policy denies
--    everything, which is safe but breaks the app.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'every RLS table has at least one policy' as check,
  string_agg(tablename, ', ') as tables_without_policies
from pg_tables t
where t.schemaname = 'public'
  and t.rowsecurity
  and not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = t.tablename
  );

-- 4. Policy inventory, for eyeballing.
select tablename, policyname, cmd, roles::text
from pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;

-- 5. Security-definer functions must pin search_path, or a caller could
--    shadow the tables they resolve to.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'all security definer functions pin search_path' as check,
  string_agg(p.proname, ', ') as unpinned
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosecdef
  and not exists (
    select 1 from unnest(coalesce(p.proconfig, '{}')) cfg
    where cfg like 'search_path=%'
  );

-- 6. The receipts bucket must not be public, or any URL leaks every receipt.
select
  case when not public then 'PASS' else 'FAIL' end as result,
  'receipts bucket is private' as check
from storage.buckets where id = 'receipts';

-- 7. Nobody should be able to write notifications for another person.
--    Only the security-definer functions do that.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'no client INSERT policy on notifications' as check
from pg_policies
where schemaname = 'public' and tablename = 'notifications' and cmd = 'INSERT';

-- 8. Expense splits must always sum to their expense. A mismatch is money
--    appearing or vanishing from the ledger.
select
  case when count(*) = 0 then 'PASS' else 'FAIL' end as result,
  'every expense''s splits sum to its total' as check,
  count(*) as mismatched_expenses
from (
  select e.id, e.amount, coalesce(sum(s.amount), 0) as split_sum
  from public.expenses e
  left join public.expense_splits s on s.expense_id = e.id
  group by e.id, e.amount
  having e.amount <> coalesce(sum(s.amount), 0)
) bad;

-- 9. Show any mismatches so they can be corrected.
select e.id, e.description, e.amount as expense_total,
       coalesce(sum(s.amount), 0) as splits_total
from public.expenses e
left join public.expense_splits s on s.expense_id = e.id
group by e.id, e.description, e.amount
having e.amount <> coalesce(sum(s.amount), 0)
order by e.created_at desc;
