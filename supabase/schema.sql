-- supabase/schema.sql
--
-- Splitwise clone — multi-user backend schema for Supabase (Postgres + Auth + Realtime).
--
-- HOW TO USE: paste this whole file into the Supabase SQL editor and click "Run".
-- It is idempotent — every statement is safe to re-run, so if you edit this file
-- later you can just paste the new version in again. It uses:
--   create table if not exists ...
--   drop policy if exists ... / create policy ...
--   create or replace function ...
--   create index if not exists ...
--   a guarded block for the realtime publication
--
-- See SETUP.md for the full step-by-step walkthrough (project creation, Google
-- sign-in, config.js, troubleshooting).
--
-- -----------------------------------------------------------------------------
-- WHY THIS LOOKS THE WAY IT DOES (read this before editing policies)
--
-- A Row Level Security (RLS) policy on `group_members` that itself queries
-- `group_members` inside its USING clause makes Postgres recurse: evaluating
-- the policy triggers the policy again, forever, until Postgres gives up with
-- "infinite recursion detected in policy". We avoid this with two small
-- `security definer` helper functions (`is_group_member`, `is_group_owner`).
-- A `security definer` function runs with the privileges of the function's
-- owner (the project's postgres role), not the calling user, so it bypasses
-- RLS entirely for its own internal lookup — it can safely check
-- "does this row exist in group_members?" without ever re-entering a policy.
--
-- Every `security definer` function below follows one rule strictly: it only
-- ever reads or writes rows belonging to `auth.uid()` (the caller's own,
-- server-verified identity from their JWT) — never an id the caller passes in
-- as a plain argument. That is what makes `security definer` safe here instead
-- of a privilege-escalation bug: a caller cannot ask create_group() or
-- join_group_by_code() to act "as" anyone else, because those functions never
-- even look at a caller-supplied user id.
-- -----------------------------------------------------------------------------


-- =============================================================================
-- 1. TABLES
-- =============================================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 80),
  currency text not null default 'EUR' check (currency in ('EUR','USD','GBP','CHF')),
  invite_code text not null unique,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  type text not null default 'expense' check (type in ('expense','settlement')),
  description text not null,
  amount_cents bigint not null check (amount_cents > 0),
  paid_by uuid not null references auth.users(id),
  split_mode text not null check (split_mode in ('equal','exact','percent','shares')),
  category text not null default 'general',
  date date not null,
  note text default '',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.expense_participants (
  expense_id uuid not null references public.expenses(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  value numeric not null,
  primary key (expense_id, user_id)
);

-- Indexes for the lookups the app does constantly (all expenses in a group,
-- all participants of an expense, all groups a user belongs to).
create index if not exists idx_expenses_group_id on public.expenses(group_id);
create index if not exists idx_expense_participants_expense_id on public.expense_participants(expense_id);
create index if not exists idx_group_members_user_id on public.group_members(user_id);

-- Enable RLS on every table. With RLS on and no matching policy, a table
-- reads/writes as "zero rows" / "denied" by default — the policies below are
-- what open the specific, narrow holes the app actually needs.
alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_participants enable row level security;


-- =============================================================================
-- 2. HELPER FUNCTIONS (security definer — bypass RLS on purpose, read-only)
-- =============================================================================

-- is_group_member: does user `uid` belong to group `gid`?
-- security definer + bypassing RLS is exactly what stops the recursion
-- described above: this never re-triggers a group_members policy.
create or replace function public.is_group_member(gid uuid, uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.group_members m
    where m.group_id = gid and m.user_id = uid
  );
$$;

-- is_group_owner: same idea, restricted to the 'owner' role.
create or replace function public.is_group_owner(gid uuid, uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.group_members m
    where m.group_id = gid and m.user_id = uid and m.role = 'owner'
  );
$$;

-- These two are read-only boolean checks (they can never modify data), but
-- because they are security definer they are also reachable as RPC calls by
-- any authenticated client, not just from inside a policy. That would let a
-- signed-in user probe arbitrary (group_id, user_id) pairs for membership —
-- a very small information leak (a yes/no on an unguessable UUID pair), but
-- worth closing off. RLS policies still need EXECUTE on these to evaluate,
-- so we grant to `authenticated` only and revoke the default PUBLIC grant
-- (which would otherwise also cover the unauthenticated `anon` role).
revoke all on function public.is_group_member(uuid, uuid) from public;
grant execute on function public.is_group_member(uuid, uuid) to authenticated;

revoke all on function public.is_group_owner(uuid, uuid) from public;
grant execute on function public.is_group_owner(uuid, uuid) to authenticated;


-- =============================================================================
-- 3. POLICIES
-- =============================================================================

-- ---- profiles -----------------------------------------------------------
-- A user can see their own profile, and the profile of anyone they share at
-- least one group with (so avatars/names render in member lists). They can
-- only ever edit their own row. There is no INSERT policy: profile rows are
-- created exclusively by the handle_new_user() trigger below, which runs as
-- the table owner and so bypasses RLS — regular clients cannot insert into
-- profiles at all, only update their own existing row.

drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.group_members gm
      where gm.user_id = profiles.id
        and public.is_group_member(gm.group_id, auth.uid())
    )
  );

drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles
  for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---- groups ---------------------------------------------------------------
-- Membership-gated read; row-creation is normally done through the
-- create_group() RPC below (which also inserts the owner's membership row
-- atomically), but we still allow a direct insert as long as the caller
-- names themselves as created_by — a direct insert alone leaves the caller
-- with no group_members row, so they could never actually see the group
-- again (groups_select requires is_group_member), which is why the RPC is
-- the real path in the app.

drop policy if exists "groups_select" on public.groups;
create policy "groups_select" on public.groups
  for select
  using (public.is_group_member(id, auth.uid()));

drop policy if exists "groups_insert" on public.groups;
create policy "groups_insert" on public.groups
  for insert
  with check (created_by = auth.uid());

drop policy if exists "groups_update" on public.groups;
create policy "groups_update" on public.groups
  for update
  using (public.is_group_owner(id, auth.uid()))
  with check (public.is_group_owner(id, auth.uid()));

drop policy if exists "groups_delete" on public.groups;
create policy "groups_delete" on public.groups
  for delete
  using (public.is_group_owner(id, auth.uid()));

-- ---- group_members ---------------------------------------------------------
-- SELECT is membership-gated via the helper (never queries itself directly,
-- so no recursion). INSERT is the join path: a user must be able to add
-- themselves to a group whose other rows they cannot yet SELECT — so the
-- check is deliberately just "it's me" (`user_id = auth.uid()`), plus
-- pinning the role to 'member' so nobody can self-promote to 'owner' via a
-- raw insert (owner rows are only ever created by create_group(), below,
-- which runs with elevated privileges). DELETE allows leaving your own row,
-- or — if you are the group's owner — removing someone else's.

drop policy if exists "group_members_select" on public.group_members;
create policy "group_members_select" on public.group_members
  for select
  using (public.is_group_member(group_id, auth.uid()));

-- There is deliberately NO insert policy on this table.
--
-- With RLS enabled and no policy for a command, that command is denied - so
-- nobody can write a membership row directly. The only way in is
-- join_group_by_code(), which is `security definer`: it runs as the table's
-- owner and therefore bypasses RLS, but only ever inserts auth.uid(), and
-- only after matching the invite code.
--
-- An earlier version allowed a self-insert (`user_id = auth.uid()`), which
-- looked harmless because you could still only add yourself. It was not: it
-- let anyone holding a group's UUID add themselves and read every expense in
-- it, with no invite code needed. Verified against real Postgres - the
-- insert succeeded and the group became visible. It is easy to miss when
-- testing with `returning`, because `returning` additionally needs SELECT
-- rights and fails first, making the attack look blocked when it is not.
drop policy if exists "group_members_insert" on public.group_members;

drop policy if exists "group_members_delete" on public.group_members;
create policy "group_members_delete" on public.group_members
  for delete
  using (user_id = auth.uid() or public.is_group_owner(group_id, auth.uid()));

-- ---- expenses ---------------------------------------------------------------
-- Any member of the group can read/write any expense in it (matches the
-- original single-device app, where any member could edit shared data).
-- created_by is additionally pinned to the caller so nobody can write an
-- expense "authored by" someone else.

drop policy if exists "expenses_select" on public.expenses;
create policy "expenses_select" on public.expenses
  for select
  using (public.is_group_member(group_id, auth.uid()));

drop policy if exists "expenses_insert" on public.expenses;
create policy "expenses_insert" on public.expenses
  for insert
  with check (
    public.is_group_member(group_id, auth.uid())
    and created_by = auth.uid()
  );

drop policy if exists "expenses_update" on public.expenses;
create policy "expenses_update" on public.expenses
  for update
  using (public.is_group_member(group_id, auth.uid()))
  with check (public.is_group_member(group_id, auth.uid()));

drop policy if exists "expenses_delete" on public.expenses;
create policy "expenses_delete" on public.expenses
  for delete
  using (public.is_group_member(group_id, auth.uid()));

-- ---- expense_participants ----------------------------------------------------
-- expense_participants has no group_id of its own, so every policy reaches
-- the owning group through a subquery join to expenses. If the caller can't
-- see the parent expense (not a group member), the subquery returns no row,
-- is_group_member(null, ...) is false, and access is denied — fails closed.

drop policy if exists "expense_participants_select" on public.expense_participants;
create policy "expense_participants_select" on public.expense_participants
  for select
  using (
    public.is_group_member(
      (select e.group_id from public.expenses e where e.id = expense_participants.expense_id),
      auth.uid()
    )
  );

drop policy if exists "expense_participants_insert" on public.expense_participants;
create policy "expense_participants_insert" on public.expense_participants
  for insert
  with check (
    public.is_group_member(
      (select e.group_id from public.expenses e where e.id = expense_participants.expense_id),
      auth.uid()
    )
  );

drop policy if exists "expense_participants_update" on public.expense_participants;
create policy "expense_participants_update" on public.expense_participants
  for update
  using (
    public.is_group_member(
      (select e.group_id from public.expenses e where e.id = expense_participants.expense_id),
      auth.uid()
    )
  )
  with check (
    public.is_group_member(
      (select e.group_id from public.expenses e where e.id = expense_participants.expense_id),
      auth.uid()
    )
  );

drop policy if exists "expense_participants_delete" on public.expense_participants;
create policy "expense_participants_delete" on public.expense_participants
  for delete
  using (
    public.is_group_member(
      (select e.group_id from public.expenses e where e.id = expense_participants.expense_id),
      auth.uid()
    )
  );


-- =============================================================================
-- 4. NEW-USER TRIGGER — creates the profiles row automatically
-- =============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', new.email),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
    set email = excluded.email,
        display_name = excluded.display_name,
        avatar_url = excluded.avatar_url;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- =============================================================================
-- 5. RPC FUNCTIONS — the two operations a user must be able to do before RLS
--    would otherwise let them see anything (create a group, join by code)
-- =============================================================================

-- generate_invite_code: a short, human-shareable, collision-checked code.
-- Excludes visually-ambiguous characters (0/O, 1/I) so it's easy to read
-- and retype. Not security-sensitive on its own (it only reads `groups` to
-- avoid a duplicate), so it keeps the default privileges.
create or replace function public.generate_invite_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  code text;
begin
  -- The invite code is an access-control secret: anyone holding it can join
  -- the group and read everyone's expenses. So it is generated the same way
  -- a password-reset token would be, not with random().
  --
  -- random() is a plain PRNG - fast, repeatable from its seed, and never
  -- meant to keep a secret. gen_random_uuid() draws on the platform's
  -- cryptographic random source instead. Its hex output also happens to
  -- avoid every look-alike character pair (there is no O or I in 0-9A-F),
  -- so a code is still safe to read down the phone.
  --
  -- 10 hex characters is about 1.1e12 possibilities. join_group_by_code()
  -- has no rate limit of its own beyond Supabase's, so the code has to be
  -- large enough that guessing is hopeless on its own merits; the previous
  -- 6-character version left only ~1e9, which is guessable given time.
  loop
    code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
    exit when not exists (select 1 from public.groups g where g.invite_code = code);
  end loop;
  return code;
end;
$$;

-- create_group: inserts the group AND the creator's 'owner' membership row
-- in one transaction, so a group can never exist without its owner row (and
-- vice versa). Only ever acts on auth.uid() — there is no caller-supplied
-- user id anywhere in this function, so it cannot be used to create a group
-- "owned" by anyone but the person calling it.
create or replace function public.create_group(p_name text, p_currency text)
returns public.groups
language plpgsql
security definer
set search_path = public
as $$
declare
  new_group public.groups;
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to create a group.';
  end if;

  -- The publishable key is public by design, so anyone can call this. A cap
  -- keeps one bored person from filling the database.
  if (select count(*) from public.group_members
      where user_id = auth.uid() and role = 'owner') >= 50 then
    raise exception 'You already own 50 groups, which is the limit.';
  end if;

  v_code := public.generate_invite_code();

  insert into public.groups (name, currency, invite_code, created_by)
  values (p_name, coalesce(nullif(p_currency, ''), 'EUR'), v_code, auth.uid())
  returning * into new_group;

  insert into public.group_members (group_id, user_id, role)
  values (new_group.id, auth.uid(), 'owner');

  return new_group;
end;
$$;

-- join_group_by_code: looks the group up by its invite code (something the
-- caller cannot do themselves via a plain SELECT, since groups_select
-- requires membership they don't have yet) and inserts the caller — and
-- only the caller — as a 'member'. Raises a clean error for an unknown
-- code, and is a no-op (not an error) if already a member.
create or replace function public.join_group_by_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_id uuid;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to join a group.';
  end if;

  select id into v_group_id
  from public.groups
  where invite_code = upper(trim(p_code));

  if v_group_id is null then
    raise exception 'No group found for that invite code.';
  end if;

  insert into public.group_members (group_id, user_id, role)
  values (v_group_id, auth.uid(), 'member')
  on conflict (group_id, user_id) do nothing;

  return v_group_id;
end;
$$;

-- Lock these two down explicitly: only signed-in (authenticated) callers may
-- invoke them. (Anonymous callers would simply hit the "must be signed in"
-- exception above anyway — this is belt-and-suspenders.)
revoke all on function public.create_group(text, text) from public;
grant execute on function public.create_group(text, text) to authenticated;

revoke all on function public.join_group_by_code(text) from public;
grant execute on function public.join_group_by_code(text) to authenticated;


-- =============================================================================
-- 6. REALTIME — so a friend's change shows up without a reload
-- =============================================================================

-- ALTER PUBLICATION ... ADD TABLE errors out if the table is already a
-- member of the publication, which would break re-running this script. This
-- guards each table with an existence check against pg_publication_tables
-- instead of relying on catching a specific error code.
do $$
declare
  t text;
begin
  foreach t in array array['groups', 'group_members', 'expenses', 'expense_participants'] loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;


-- =============================================================================
-- 7. INTEGRITY HARDENING
--
-- Everything above this point controls WHO can touch a row. Nothing above
-- controls whether the row makes SENSE. That gap was real: the API happily
-- accepted a 100.00 expense split into 10.00 + 20.00, an expense with no
-- participants at all, and an expense paid by somebody who was not even in
-- the group.
--
-- The app's central promise - that a split always adds back up to the total -
-- was enforced only in JavaScript, which means it was not enforced at all.
-- Anything talking to the REST API directly bypassed it.
--
-- The fix is to stop writing to these tables directly. Expenses are created
-- and updated through the two functions below, which validate first, write
-- both tables in one transaction, and are the ONLY way in: the direct
-- insert/update policies are dropped at the end of this section.
-- =============================================================================

-- ---- bounds ---------------------------------------------------------------
-- A bigint holds far more than JavaScript can read back accurately: anything
-- above 2^53 silently loses precision on the way to the browser. Money that
-- changes value when you read it is worse than money you cannot store, so the
-- ceiling sits well below that (1e11 cents = one billion, in any currency).
alter table public.expenses drop constraint if exists expenses_amount_sane;
alter table public.expenses add constraint expenses_amount_sane
  check (amount_cents > 0 and amount_cents <= 100000000000);

alter table public.expenses drop constraint if exists expenses_description_sane;
alter table public.expenses add constraint expenses_description_sane
  check (length(trim(description)) between 1 and 200);

alter table public.expenses drop constraint if exists expenses_note_sane;
alter table public.expenses add constraint expenses_note_sane
  check (note is null or length(note) <= 2000);

-- Dates outside this window are typos, not history.
alter table public.expenses drop constraint if exists expenses_date_sane;
alter table public.expenses add constraint expenses_date_sane
  check (date >= date '2000-01-01' and date <= current_date + interval '1 year');

alter table public.expense_participants drop constraint if exists participants_value_sane;
alter table public.expense_participants add constraint participants_value_sane
  check (value >= 0 and value <= 100000000000);

-- ---- concurrency ----------------------------------------------------------
-- Without this, two people editing the same expense both succeed and one
-- edit vanishes with nobody told. update_expense() below refuses to write
-- unless the caller saw the current version.
alter table public.expenses add column if not exists updated_at timestamptz not null default now();

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists expenses_touch_updated_at on public.expenses;
create trigger expenses_touch_updated_at
  before update on public.expenses
  for each row execute function public.touch_updated_at();

-- ---- shared validation ----------------------------------------------------
-- Raises with a readable message on the first problem it finds. Called by
-- both create_expense and update_expense so the rules cannot drift apart.
create or replace function public.assert_expense_valid(
  p_group_id uuid,
  p_amount_cents bigint,
  p_paid_by uuid,
  p_split_mode text,
  p_participants jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
  v_sum numeric;
  v_distinct int;
  v_non_members int;
begin
  if p_participants is null or jsonb_typeof(p_participants) <> 'array' then
    raise exception 'Participants must be a list.';
  end if;

  select count(*) into v_count from jsonb_array_elements(p_participants);
  if v_count = 0 then
    raise exception 'An expense needs at least one participant.';
  end if;

  -- Everyone involved must actually be in the group. Otherwise a member can
  -- create a debt for any account in the system - someone who cannot see the
  -- group and would never be told.
  if not public.is_group_member(p_group_id, p_paid_by) then
    raise exception 'The payer is not a member of this group.';
  end if;

  select count(*) into v_non_members
  from jsonb_array_elements(p_participants) e
  where not public.is_group_member(p_group_id, (e->>'user_id')::uuid);
  if v_non_members > 0 then
    raise exception 'Every participant must be a member of this group.';
  end if;

  -- The same person twice would be charged two shares while somebody else
  -- silently gets none.
  select count(distinct (e->>'user_id')) into v_distinct
  from jsonb_array_elements(p_participants) e;
  if v_distinct <> v_count then
    raise exception 'Each participant may only be listed once.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_participants) e
    where (e->>'value') is null or (e->>'value')::numeric < 0
  ) then
    raise exception 'Participant values must be non-negative numbers.';
  end if;

  select coalesce(sum((e->>'value')::numeric), 0) into v_sum
  from jsonb_array_elements(p_participants) e;

  -- The whole point of this function.
  if p_split_mode = 'exact' then
    if v_sum <> p_amount_cents then
      raise exception 'Exact amounts must add up to the total (got %, expected %).', v_sum, p_amount_cents;
    end if;
  elsif p_split_mode = 'percent' then
    if abs(v_sum - 100) > 0.0100001 then
      raise exception 'Percentages must add up to 100 (got %).', v_sum;
    end if;
  elsif p_split_mode = 'shares' then
    if exists (
      select 1 from jsonb_array_elements(p_participants) e
      where (e->>'value')::numeric <= 0
    ) then
      raise exception 'Shares must be positive numbers.';
    end if;
  elsif p_split_mode <> 'equal' then
    raise exception 'Unknown split mode: %.', p_split_mode;
  end if;
end;
$$;

-- ---- create ---------------------------------------------------------------
create or replace function public.create_expense(
  p_group_id uuid,
  p_type text,
  p_description text,
  p_amount_cents bigint,
  p_paid_by uuid,
  p_split_mode text,
  p_category text,
  p_date date,
  p_note text,
  p_participants jsonb
)
returns public.expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expense public.expenses;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;
  if not public.is_group_member(p_group_id, auth.uid()) then
    raise exception 'You are not a member of this group.';
  end if;

  perform public.assert_expense_valid(p_group_id, p_amount_cents, p_paid_by, p_split_mode, p_participants);

  insert into public.expenses
    (group_id, type, description, amount_cents, paid_by, split_mode, category, date, note, created_by)
  values
    (p_group_id, coalesce(p_type, 'expense'), p_description, p_amount_cents, p_paid_by,
     p_split_mode, coalesce(p_category, 'general'), coalesce(p_date, current_date),
     coalesce(p_note, ''), auth.uid())
  returning * into v_expense;

  insert into public.expense_participants (expense_id, user_id, value)
  select v_expense.id, (e->>'user_id')::uuid, (e->>'value')::numeric
  from jsonb_array_elements(p_participants) e;

  return v_expense;
end;
$$;

-- ---- update ---------------------------------------------------------------
-- p_expected_updated_at implements optimistic concurrency: pass the
-- updated_at you last saw, and the write is refused if somebody changed the
-- row in the meantime. Pass null to force the write.
create or replace function public.update_expense(
  p_expense_id uuid,
  p_description text,
  p_amount_cents bigint,
  p_paid_by uuid,
  p_split_mode text,
  p_category text,
  p_date date,
  p_note text,
  p_participants jsonb,
  p_expected_updated_at timestamptz default null
)
returns public.expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.expenses;
  v_updated public.expenses;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  select * into v_existing from public.expenses where id = p_expense_id;
  if v_existing.id is null then
    raise exception 'That expense no longer exists.';
  end if;
  if not public.is_group_member(v_existing.group_id, auth.uid()) then
    raise exception 'You are not a member of this group.';
  end if;

  if p_expected_updated_at is not null and v_existing.updated_at <> p_expected_updated_at then
    raise exception 'Somebody else changed this expense while you were editing it. Reload and try again.';
  end if;

  perform public.assert_expense_valid(v_existing.group_id, p_amount_cents, p_paid_by, p_split_mode, p_participants);

  update public.expenses set
    description = p_description,
    amount_cents = p_amount_cents,
    paid_by = p_paid_by,
    split_mode = p_split_mode,
    category = coalesce(p_category, category),
    date = coalesce(p_date, date),
    note = coalesce(p_note, '')
  where id = p_expense_id
  returning * into v_updated;

  delete from public.expense_participants where expense_id = p_expense_id;
  insert into public.expense_participants (expense_id, user_id, value)
  select p_expense_id, (e->>'user_id')::uuid, (e->>'value')::numeric
  from jsonb_array_elements(p_participants) e;

  return v_updated;
end;
$$;

-- ---- invite codes are revocable now ---------------------------------------
-- A code that can never be changed is permanent access to your finances the
-- moment somebody screenshots it into a group chat.
create or replace function public.rotate_invite_code(p_group_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if not public.is_group_owner(p_group_id, auth.uid()) then
    raise exception 'Only the group owner can change the invite code.';
  end if;
  v_code := public.generate_invite_code();
  update public.groups set invite_code = v_code where id = p_group_id;
  return v_code;
end;
$$;

-- ---- leaving a group ------------------------------------------------------
-- Two things went wrong before: somebody could walk away from a debt, and
-- the owner could leave, stranding a group nobody could manage.
create or replace function public.guard_membership_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_count int;
begin
  -- The whole group is being deleted by delete_group(); nothing to guard.
  if coalesce(current_setting('app.deleting_group', true), '') = old.group_id::text then
    return old;
  end if;

  if exists (
    select 1 from public.expenses e
    where e.group_id = old.group_id
      and (e.paid_by = old.user_id
           or exists (select 1 from public.expense_participants p
                      where p.expense_id = e.id and p.user_id = old.user_id))
  ) then
    raise exception 'This person appears in an expense. Settle up and delete their expenses first, or delete the group.';
  end if;

  if old.role = 'owner' then
    select count(*) into v_owner_count
    from public.group_members
    where group_id = old.group_id and role = 'owner' and user_id <> old.user_id;
    if v_owner_count = 0 then
      raise exception 'You own this group. Hand ownership to someone else or delete the group.';
    end if;
  end if;

  return old;
end;
$$;

drop trigger if exists group_members_guard_removal on public.group_members;
create trigger group_members_guard_removal
  before delete on public.group_members
  for each row execute function public.guard_membership_removal();

-- Deleting the whole group is still allowed and still cascades - the trigger
-- above must not block that, so it is disabled for the cascade path by
-- deleting memberships first inside this function.
create or replace function public.delete_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_group_owner(p_group_id, auth.uid()) then
    raise exception 'Only the group owner can delete this group.';
  end if;
  delete from public.expense_participants
    where expense_id in (select id from public.expenses where group_id = p_group_id);
  delete from public.expenses where group_id = p_group_id;
  -- Tell the removal guard to stand down for THIS group in THIS transaction.
  -- `alter table ... disable trigger` would have been simpler and badly
  -- wrong: it is table-wide, so another member leaving a different group at
  -- that moment would slip past the guard entirely.
  perform set_config('app.deleting_group', p_group_id::text, true);
  delete from public.group_members where group_id = p_group_id;
  delete from public.groups where id = p_group_id;
end;
$$;

create or replace function public.transfer_ownership(p_group_id uuid, p_new_owner uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_group_owner(p_group_id, auth.uid()) then
    raise exception 'Only the current owner can hand over a group.';
  end if;
  if not public.is_group_member(p_group_id, p_new_owner) then
    raise exception 'That person is not in this group.';
  end if;
  update public.group_members set role = 'member'
    where group_id = p_group_id and user_id = auth.uid();
  update public.group_members set role = 'owner'
    where group_id = p_group_id and user_id = p_new_owner;
end;
$$;

-- ---- close the direct write paths -----------------------------------------
-- With these gone, expenses can only be written through the validated
-- functions above. Reads and deletes stay as they were.
drop policy if exists "expenses_insert" on public.expenses;
drop policy if exists "expenses_update" on public.expenses;
drop policy if exists "expense_participants_insert" on public.expense_participants;
drop policy if exists "expense_participants_update" on public.expense_participants;

revoke all on function public.create_expense(uuid, text, text, bigint, uuid, text, text, date, text, jsonb) from public;
grant execute on function public.create_expense(uuid, text, text, bigint, uuid, text, text, date, text, jsonb) to authenticated;
revoke all on function public.update_expense(uuid, text, bigint, uuid, text, text, date, text, jsonb, timestamptz) from public;
grant execute on function public.update_expense(uuid, text, bigint, uuid, text, text, date, text, jsonb, timestamptz) to authenticated;
revoke all on function public.rotate_invite_code(uuid) from public;
grant execute on function public.rotate_invite_code(uuid) to authenticated;
revoke all on function public.delete_group(uuid) from public;
grant execute on function public.delete_group(uuid) to authenticated;
revoke all on function public.transfer_ownership(uuid, uuid) from public;
grant execute on function public.transfer_ownership(uuid, uuid) to authenticated;
revoke all on function public.assert_expense_valid(uuid, bigint, uuid, text, jsonb) from public;
