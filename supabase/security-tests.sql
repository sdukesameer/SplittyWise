-- ============================================================================
--  SplittyWise — behavioural security tests
--
--    ./scripts/db attack
--
--  rls-audit.sql inspects the shape of the database: is RLS on, does a
--  policy exist, is a trigger present. This file instead *tries things* as
--  an ordinary signed-in user, and checks it is stopped.
--
--  It exists because the audit once reported PASS on an open hole. The
--  is_admin guard was in place and the audit could see it — but it compared
--  current_setting(name, true) to a string without coalesce, and NULL <> 'yes'
--  is NULL, which `if` treats as false. The trigger was inert. Nothing but
--  trying the attack would have found it.
--
--  `set local role authenticated` is essential and not decoration. Setting
--  request.jwt.claims alone gives auth.uid() a value but leaves the
--  connection as `postgres`, for whom RLS does not apply at all — so every
--  RLS test would pass or fail for reasons unrelated to the policies. Ids
--  are therefore collected *before* the switch, while the rows are visible.
--
--  Everything runs in one statement that raises at the end, so nothing is
--  committed however it finishes. Results come out in the error message,
--  because the Management API does not return notices.
-- ============================================================================

do $$
declare
  victim   uuid;
  attacker uuid;
  probe    uuid;
  out      text := '';
  n        int;
  ok       boolean;
begin
  -- ---- gathered as postgres, before RLS starts applying -----------------
  select id into victim   from public.profiles order by created_at limit 1;
  select id into attacker from public.profiles where id <> victim
                          order by created_at limit 1;
  if victim is null then raise exception 'SKIP - no accounts to test with'; end if;
  if attacker is null then attacker := victim; end if;

  -- An audit row to look for later, so "cannot read the audit trail" is not
  -- passing merely because the table happens to be empty.
  insert into public.admin_audit (actor_id, actor_email, action)
  values (victim, 'probe@example.com', 'probe') returning id into probe;

  perform set_config('request.jwt.claims',
    json_build_object('sub', attacker::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  out := out || 'running as ' || current_user || ', auth.uid() = ' ||
                coalesce(auth.uid()::text, 'null') || E'\n\n';

  -- ---- 1. granting yourself admin ---------------------------------------
  begin
    update public.profiles set is_admin = true where id = attacker;
    select is_admin into ok from public.profiles where id = attacker;
    out := out || format('FAIL - self-granting admin went through (is_admin=%s)', ok) || E'\n';
  exception when others then
    out := out || 'PASS - self-granting admin is refused (' || SQLSTATE || ')' || E'\n';
  end;

  -- ---- 2. writing the ban list ------------------------------------------
  begin
    insert into public.banned_emails (email) values ('attacker-probe@example.com');
    out := out || 'FAIL - a normal user can add to the ban list' || E'\n';
  exception when others then
    out := out || 'PASS - the ban list is not client-writable (' || SQLSTATE || ')' || E'\n';
  end;

  begin
    delete from public.banned_emails;
    get diagnostics n = row_count;
    out := out || format('%s - the ban list cannot be emptied (%s rows deleted)',
      case when n = 0 then 'PASS' else 'FAIL' end, n) || E'\n';
  exception when others then
    out := out || 'PASS - the ban list cannot be emptied (' || SQLSTATE || ')' || E'\n';
  end;

  -- ---- 3. re-opening signups --------------------------------------------
  begin
    update public.app_settings set value = '{"enabled": true}'::jsonb
     where key = 'signups_enabled';
    get diagnostics n = row_count;
    out := out || format('%s - app_settings is not client-writable (%s rows)',
      case when n = 0 then 'PASS' else 'FAIL' end, n) || E'\n';
  exception when others then
    out := out || 'PASS - app_settings is not client-writable (' || SQLSTATE || ')' || E'\n';
  end;

  -- ---- 4. calling the admin API as a normal user ------------------------
  begin
    perform public.admin_stats();
    out := out || 'FAIL - admin_stats() ran for a non-admin' || E'\n';
  exception when others then
    out := out || 'PASS - admin_stats() refuses a non-admin' || E'\n';
  end;

  begin
    perform public.admin_users(null, 10, 0);
    out := out || 'FAIL - admin_users() ran for a non-admin' || E'\n';
  exception when others then
    out := out || 'PASS - admin_users() refuses a non-admin' || E'\n';
  end;

  begin
    perform public.admin_set_setting('signups_enabled', true);
    out := out || 'FAIL - admin_set_setting() ran for a non-admin' || E'\n';
  exception when others then
    out := out || 'PASS - admin_set_setting() refuses a non-admin' || E'\n';
  end;

  begin
    perform public.admin_user_detail(victim);
    out := out || 'FAIL - admin_user_detail() exposed somebody to a non-admin' || E'\n';
  exception when others then
    out := out || 'PASS - admin_user_detail() refuses a non-admin' || E'\n';
  end;

  begin
    perform public.admin_set_profile(victim, 'Renamed', null, true);
    out := out || 'FAIL - admin_set_profile() ran for a non-admin' || E'\n';
  exception when others then
    out := out || 'PASS - admin_set_profile() refuses a non-admin' || E'\n';
  end;

  -- ---- 5. reading the audit trail ---------------------------------------
  select count(*) into n from public.admin_audit where id = probe;
  out := out || format('%s - the admin audit trail is unreadable (%s of 1 planted rows seen)',
    case when n = 0 then 'PASS' else 'FAIL' end, n) || E'\n';

  -- ---- 6. forging a notification for somebody else ----------------------
  begin
    insert into public.notifications (user_id, actor_id, type, title, body)
    values (victim, attacker, 'nudge', 'Pay me', 'now');
    out := out || 'FAIL - a client can forge a notification' || E'\n';
  exception when others then
    out := out || 'PASS - notifications cannot be forged (' || SQLSTATE || ')' || E'\n';
  end;

  -- ---- 7. blaming somebody else for a crash -----------------------------
  if attacker <> victim then
    begin
      insert into public.error_reports (user_id, message) values (victim, 'not mine');
      out := out || 'FAIL - an error can be filed against another account' || E'\n';
    exception when others then
      out := out || 'PASS - an error report cannot name somebody else (' || SQLSTATE || ')' || E'\n';
    end;
  end if;

  -- ---- 8. reading a stranger's ledger -----------------------------------
  --
  -- Being in the group is a legitimate way to see an expense you are not
  -- splitting — you need the group's whole ledger to make sense of its
  -- balance. The first version of this test ignored that and reported a
  -- leak for an expense in the attacker's own group, which is not one.
  --
  -- What must never be visible is an expense with no connection at all: not
  -- on the split, not created by them, and not in a group they belong to.
  select count(*) into n from public.expenses e
   where not exists (select 1 from public.expense_splits s
                     where s.expense_id = e.id and s.user_id = attacker)
     and e.created_by <> attacker
     and not exists (select 1 from public.group_members gm
                     where gm.group_id = e.group_id and gm.user_id = attacker);
  out := out || format('%s - an expense with no connection to you is invisible (%s visible)',
    case when n = 0 then 'PASS' else 'FAIL' end, n) || E'\n';

  -- And the same for the split rows, which carry who owes what.
  select count(*) into n from public.expense_splits s
   where s.user_id <> attacker
     and not exists (select 1 from public.expense_splits mine
                     where mine.expense_id = s.expense_id and mine.user_id = attacker)
     and not exists (select 1 from public.expenses e
                     join public.group_members gm on gm.group_id = e.group_id
                     where e.id = s.expense_id and gm.user_id = attacker);
  out := out || format('%s - so are its split rows (%s visible)',
    case when n = 0 then 'PASS' else 'FAIL' end, n) || E'\n';

  -- A profile you share nothing with must stay private, or the app is an
  -- email-address directory.
  select count(*) into n from public.profiles pr
   where pr.id <> attacker
     and not sw.are_friends(attacker, pr.id)
     and not exists (select 1 from public.group_members a
                     join public.group_members b on b.group_id = a.group_id
                     where a.user_id = attacker and b.user_id = pr.id);
  out := out || format('%s - a stranger''s profile is invisible (%s visible)',
    case when n = 0 then 'PASS' else 'FAIL' end, n) || E'\n';

  -- ---- 9. the legitimate paths must still work --------------------------
  begin
    update public.profiles set full_name = 'Still Editable' where id = attacker;
    get diagnostics n = row_count;
    out := out || format('%s - your own name is still editable (%s rows)',
      case when n = 1 then 'PASS' else 'FAIL' end, n) || E'\n';
  exception when others then
    out := out || 'FAIL - the admin guard is too broad: ' || SQLERRM || E'\n';
  end;

  reset role;

  perform set_config('splittywise.granting_admin', 'yes', true);
  begin
    update public.profiles set is_admin = true where id = victim;
    select is_admin into ok from public.profiles where id = victim;
    out := out || format('%s - the admin path can still set the flag (is_admin=%s)',
      case when ok then 'PASS' else 'FAIL' end, ok) || E'\n';
  exception when others then
    out := out || 'FAIL - admin_set_profile could never grant admin: ' || SQLERRM || E'\n';
  end;

  -- ---- 10. a courtesy notification must never fail a signup -------------
  --
  -- handle_new_user() runs inside the transaction that creates the user, so
  -- anything raising in it takes the signup down. That is how a mail
  -- misconfiguration once became "500, account not created", and telling
  -- every admin about a new account put another insert on that same path.
  reset role;
  declare
    probe_id uuid := gen_random_uuid();
  begin
    alter table public.notifications
      add constraint probe_break_notifications
      check (type <> 'account_created') not valid;

    begin
      insert into auth.users (id, instance_id, aud, role, email,
                              encrypted_password, email_confirmed_at,
                              raw_user_meta_data, created_at, updated_at)
      values (probe_id, '00000000-0000-0000-0000-000000000000', 'authenticated',
              'authenticated', 'attack-signup-probe@example.com', 'x', now(),
              '{"full_name":"Attack Probe"}'::jsonb, now(), now());
      out := out || 'PASS - a signup survives a notification that cannot be written' || E'\n';
    exception when others then
      out := out || format('FAIL - a failed notification took the signup down: %s',
        SQLERRM) || E'\n';
    end;

    select count(*) into n from public.profiles where id = probe_id;
    out := out || format('%s - and the person still gets a profile (%s)',
      case when n = 1 then 'PASS' else 'FAIL' end, n) || E'\n';

    alter table public.notifications drop constraint probe_break_notifications;
  end;

  -- ---- 11. a refused signup tells nobody --------------------------------
  --
  -- Admins hear when an account is *created*. A signup that is turned away —
  -- banned address, signups closed, invite-only — creates nothing, so there
  -- is nothing to announce, and announcing it would turn the notification
  -- into an alert about people who never got in.
  declare
    watcher  uuid;
    before_n int;
    after_n  int;
    pid      uuid;
  begin
    select id into watcher from public.profiles where is_admin limit 1;
    if watcher is null then
      out := out || 'SKIP - no admin to watch' || E'\n';
    else
      select count(*) into before_n from public.notifications
       where type = 'account_created' and user_id = watcher;

      insert into public.banned_emails (email) values ('attack-blocked@example.com');
      begin
        insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                                email_confirmed_at, raw_user_meta_data, created_at, updated_at)
        values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
                'authenticated', 'authenticated', 'attack-blocked@example.com', 'x',
                now(), '{}'::jsonb, now(), now());
        out := out || 'FAIL - a banned address created an account' || E'\n';
      exception when others then
        out := out || 'PASS - a banned address creates no account' || E'\n';
      end;

      update public.app_settings set value = '{"enabled": false}'::jsonb
       where key = 'signups_enabled';
      begin
        insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                                email_confirmed_at, raw_user_meta_data, created_at, updated_at)
        values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
                'authenticated', 'authenticated', 'attack-closed@example.com', 'x',
                now(), '{}'::jsonb, now(), now());
        out := out || 'FAIL - an account was created while signups were closed' || E'\n';
      exception when others then
        out := out || 'PASS - no account is created while signups are closed' || E'\n';
      end;

      select count(*) into after_n from public.notifications
       where type = 'account_created' and user_id = watcher;
      out := out || format('%s - and a refused signup notifies nobody (%s then %s)',
        case when after_n = before_n then 'PASS' else 'FAIL' end,
        before_n, after_n) || E'\n';

      update public.app_settings set value = '{"enabled": true}'::jsonb
       where key = 'signups_enabled';

      pid := gen_random_uuid();
      insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                              email_confirmed_at, raw_user_meta_data, created_at, updated_at)
      values (pid, '00000000-0000-0000-0000-000000000000', 'authenticated',
              'authenticated', 'attack-welcome@example.com', 'x', now(),
              '{"full_name":"Attack Welcome"}'::jsonb, now(), now());
      select count(*) into after_n from public.notifications
       where type = 'account_created' and user_id = watcher and actor_id = pid;
      out := out || format('%s - while one that IS created reaches every admin (%s)',
        case when after_n = 1 then 'PASS' else 'FAIL' end, after_n) || E'\n';
    end if;
  end;

  raise exception E'\n%', out;
end $$;
