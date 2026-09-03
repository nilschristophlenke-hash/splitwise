// Executes supabase/schema.sql against real Postgres (PGlite/WASM) and then
// attacks the Row Level Security policies as three different users.
//
// The point is not "does the SQL parse" — it is "can a stranger read, change
// or delete another group's expenses". Those policies are the only thing
// standing between a friend group's finances and anyone with an account.
let PGlite;
try {
  PGlite = require('@electric-sql/pglite').PGlite;
} catch (err) {
  console.log('SKIP - @electric-sql/pglite is not installed.');
  console.log('       Run `npm install` inside tests/ to enable the security tests.');
  process.exit(0);
}
const fs = require('fs');
const path = require('path');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))); }
}

const A = '11111111-1111-1111-1111-111111111111'; // group owner
const B = '22222222-2222-2222-2222-222222222222'; // friend who joins
const C = '33333333-3333-3333-3333-333333333333'; // stranger

(async () => {
  const db = await PGlite.create();

  // ---- emulate the parts of Supabase the schema depends on ----
  await db.exec(`
    create schema if not exists auth;
    create role anon;
    create role authenticated;
    create role service_role;

    create table auth.users (
      id uuid primary key,
      email text,
      raw_user_meta_data jsonb default '{}'::jsonb
    );

    -- Supabase derives this from the request JWT; here it comes from a
    -- session setting so the test can "become" each user in turn.
    create or replace function auth.uid() returns uuid
      language sql stable
      as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;

    create publication supabase_realtime;
  `);

  // ---- run the real schema ----
  try {
    await db.exec(SCHEMA);
    check('schema.sql executes against real Postgres without error', true);
  } catch (e) {
    check('schema.sql executes against real Postgres without error', false, e.message);
    console.log('\nCannot continue — schema did not apply.');
    process.exit(1);
  }

  // Supabase grants these automatically on tables in `public`; reproduce it,
  // otherwise every query below fails on table permissions rather than RLS.
  await db.exec(`
    grant usage on schema public to anon, authenticated;
    grant all on all tables in schema public to authenticated;
    grant all on all sequences in schema public to authenticated;
  `);

  // ---- create the three users (the trigger should mirror them to profiles) ----
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${A}', 'a@example.com', '{"full_name":"Ann"}'),
      ('${B}', 'b@example.com', '{"full_name":"Bob"}'),
      ('${C}', 'c@example.com', '{"full_name":"Cid"}');
  `);
  const profs = await db.query('select id, display_name from public.profiles order by display_name');
  check('handle_new_user trigger created a profile per user',
    profs.rows.length === 3 && profs.rows[0].display_name === 'Ann', profs.rows);

  // ---- helper: run statements as a given signed-in user ----
  async function as(uid, sql, params) {
    await db.exec(`set role authenticated; select set_config('test.uid', '${uid}', false);`);
    try {
      return { ok: true, res: await db.query(sql, params) };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      await db.exec(`reset role;`);
    }
  }

  // ---- A creates a group ----
  const created = await as(A, `select * from public.create_group('Lisbon Flat', 'EUR')`);
  check('a signed-in user can create a group', created.ok, created.error);
  if (!created.ok) { console.log('\nStopping.'); process.exit(1); }
  const group = created.res.rows[0];
  const gid = group.id;
  const code = group.invite_code;
  check('invite code is 10 characters (was 6)', code && code.length === 10, code);

  const ownerRow = await db.query(`select role from public.group_members where group_id=$1 and user_id=$2`, [gid, A]);
  check('creator is recorded as owner', ownerRow.rows[0] && ownerRow.rows[0].role === 'owner', ownerRow.rows);

  // ---- A adds an expense split between A and B ----
  const exp = await as(A, `
    insert into public.expenses (group_id, description, amount_cents, paid_by, split_mode, category, date, created_by)
    values ($1, 'Groceries', 4230, $2, 'equal', 'food', '2026-09-03', $2) returning id`, [gid, A]);
  check('group member can add an expense', exp.ok, exp.error);
  const eid = exp.ok ? exp.res.rows[0].id : null;
  if (eid) {
    const parts = await as(A, `
      insert into public.expense_participants (expense_id, user_id, value)
      values ($1,$2,1),($1,$3,1)`, [eid, A, B]);
    check('group member can add expense participants', parts.ok, parts.error);
  }

  // ================= THE ACTUAL SECURITY TESTS =================
  console.log('\n--- isolation: a stranger must see nothing ---');

  const cGroups = await as(C, `select id from public.groups`);
  check('stranger sees zero groups', cGroups.ok && cGroups.res.rows.length === 0, cGroups.res && cGroups.res.rows);

  const cExp = await as(C, `select id from public.expenses`);
  check('stranger sees zero expenses', cExp.ok && cExp.res.rows.length === 0, cExp.res && cExp.res.rows);

  const cParts = await as(C, `select expense_id from public.expense_participants`);
  check('stranger sees zero expense participants', cParts.ok && cParts.res.rows.length === 0, cParts.res && cParts.res.rows);

  const cMembers = await as(C, `select user_id from public.group_members`);
  check('stranger sees zero group memberships', cMembers.ok && cMembers.res.rows.length === 0, cMembers.res && cMembers.res.rows);

  console.log('\n--- isolation: a stranger must not be able to write ---');

  const cInsert = await as(C, `
    insert into public.expenses (group_id, description, amount_cents, paid_by, split_mode, category, date, created_by)
    values ($1, 'Fraud', 999999, $2, 'equal', 'general', '2026-09-03', $2) returning id`, [gid, C]);
  check('stranger cannot insert an expense into a group they are not in', !cInsert.ok, cInsert.res && cInsert.res.rows);

  const cUpdate = await as(C, `update public.expenses set amount_cents = 1 where id = $1 returning id`, [eid]);
  check("stranger cannot modify another group's expense",
    cUpdate.ok && cUpdate.res.rows.length === 0, cUpdate.res && cUpdate.res.rows);

  const cDelete = await as(C, `delete from public.expenses where id = $1 returning id`, [eid]);
  check("stranger cannot delete another group's expense",
    cDelete.ok && cDelete.res.rows.length === 0, cDelete.res && cDelete.res.rows);

  const cRename = await as(C, `update public.groups set name = 'Hijacked' where id = $1 returning id`, [gid]);
  check('stranger cannot rename a group', cRename.ok && cRename.res.rows.length === 0, cRename.res && cRename.res.rows);

  const cDropGroup = await as(C, `delete from public.groups where id = $1 returning id`, [gid]);
  check('stranger cannot delete a group', cDropGroup.ok && cDropGroup.res.rows.length === 0, cDropGroup.res && cDropGroup.res.rows);

  console.log('\n--- privilege escalation attempts ---');

  const cOwner = await as(C, `
    insert into public.group_members (group_id, user_id, role) values ($1,$2,'owner') returning role`, [gid, C]);
  check('cannot self-insert as owner', !cOwner.ok, cOwner.res && cOwner.res.rows);

  // No RETURNING here, deliberately. RETURNING needs SELECT rights and fails
  // first, which makes a successful insert look blocked. This is exactly how
  // the earlier self-insert hole hid from testing.
  const cSneak = await as(C, `
    insert into public.group_members (group_id, user_id, role) values ($1,$2,'member')`, [gid, C]);
  const cSneakRows = await db.query(
    `select count(*)::int as n from public.group_members where group_id=$1 and user_id=$2`, [gid, C]);
  check('cannot join by knowing the group UUID, without the invite code',
    !cSneak.ok && cSneakRows.rows[0].n === 0, { inserted: cSneak.ok, rows: cSneakRows.rows[0].n });

  const cSeesAfterSneak = await as(C, `select id from public.groups`);
  check('and therefore still cannot see the group',
    cSeesAfterSneak.ok && cSeesAfterSneak.res.rows.length === 0,
    cSeesAfterSneak.res && cSeesAfterSneak.res.rows);

  const cAddOther = await as(C, `
    insert into public.group_members (group_id, user_id, role) values ($1,$2,'member') returning user_id`, [gid, A]);
  check('cannot add somebody else to a group', !cAddOther.ok, cAddOther.res && cAddOther.res.rows);

  const cBadCode = await as(C, `select public.join_group_by_code('ZZZZZZZZZZ')`);
  check('joining with a wrong code is rejected', !cBadCode.ok, cBadCode.res && cBadCode.res.rows);

  const cSpoof = await as(C, `select * from public.create_group('Spoofed', 'EUR')`);
  const spoofed = cSpoof.ok ? cSpoof.res.rows[0] : null;
  if (spoofed) {
    const owners = await db.query(`select user_id from public.group_members where group_id=$1`, [spoofed.id]);
    check('create_group always makes the CALLER the owner (no spoofing)',
      owners.rows.length === 1 && owners.rows[0].user_id === C, owners.rows);
  } else {
    check('create_group always makes the CALLER the owner (no spoofing)', false, cSpoof.error);
  }

  console.log('\n--- joining with the invite code ---');

  const bBefore = await as(B, `select id from public.groups`);
  check('friend sees nothing before joining', bBefore.ok && bBefore.res.rows.length === 0, bBefore.res && bBefore.res.rows);

  const bJoin = await as(B, `select public.join_group_by_code($1) as gid`, [code]);
  check('friend can join with the invite code', bJoin.ok, bJoin.error);

  const bAfter = await as(B, `select id, name from public.groups`);
  check('friend sees the group after joining',
    bAfter.ok && bAfter.res.rows.length === 1 && bAfter.res.rows[0].name === 'Lisbon Flat',
    bAfter.res && bAfter.res.rows);

  const bExp = await as(B, `select description, amount_cents from public.expenses`);
  check('friend sees the shared expenses after joining',
    bExp.ok && bExp.res.rows.length === 1 && Number(bExp.res.rows[0].amount_cents) === 4230,
    bExp.res && bExp.res.rows);

  const bProfiles = await as(B, `select display_name from public.profiles order by display_name`);
  check('friend can see co-members\' names (needed to render the UI)',
    bProfiles.ok && bProfiles.res.rows.some(r => r.display_name === 'Ann'),
    bProfiles.res && bProfiles.res.rows);

  const bAddExp = await as(B, `
    insert into public.expenses (group_id, description, amount_cents, paid_by, split_mode, category, date, created_by)
    values ($1, 'Dinner', 6000, $2, 'equal', 'food', '2026-09-03', $2) returning id`, [gid, B]);
  check('friend can add an expense once joined', bAddExp.ok, bAddExp.error);

  const bJoinTwice = await as(B, `select public.join_group_by_code($1) as gid`, [code]);
  check('joining twice is a harmless no-op', bJoinTwice.ok, bJoinTwice.error);
  const memberCount = await db.query(`select count(*)::int as n from public.group_members where group_id=$1`, [gid]);
  check('joining twice did not duplicate the membership row', memberCount.rows[0].n === 2, memberCount.rows);

  // stranger STILL sees nothing after all that activity
  const cFinal = await as(C, `select id from public.expenses where group_id = $1`, [gid]);
  check('stranger still sees nothing after others have been active',
    cFinal.ok && cFinal.res.rows.length === 0, cFinal.res && cFinal.res.rows);

  console.log('\n--- impersonation via forged created_by / paid_by ---');
  const bForge = await as(B, `
    insert into public.expenses (group_id, description, amount_cents, paid_by, split_mode, category, date, created_by)
    values ($1, 'Forged', 100, $2, 'equal', 'general', '2026-09-03', $2) returning id`, [gid, A]);
  check('cannot author an expense as somebody else', !bForge.ok, bForge.res && bForge.res.rows);

  console.log('\n--- leaving and removal ---');
  const bLeave = await as(B, `delete from public.group_members where group_id=$1 and user_id=$2 returning user_id`, [gid, B]);
  check('a member can leave a group', bLeave.ok && bLeave.res.rows.length === 1, bLeave.res && bLeave.res.rows);
  const bAfterLeave = await as(B, `select id from public.groups`);
  check('after leaving, the group is no longer visible',
    bAfterLeave.ok && bAfterLeave.res.rows.length === 0, bAfterLeave.res && bAfterLeave.res.rows);

  console.log('\n--- idempotency ---');
  try { await db.exec(SCHEMA); check('schema.sql can be re-run safely', true); }
  catch (e) { check('schema.sql can be re-run safely', false, e.message); }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e.message); process.exit(2); });
