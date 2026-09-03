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

-- KNOWN TRADEOFF, deliberate: this policy lets any signed-in user insert
-- themselves into a group if they know that group's UUID, without presenting
-- the invite code. It is kept because join_group_by_code() relies on being
-- able to write this row, and a policy that fails closed would break joining
-- outright. The exposure is small - group UUIDs never appear in a URL or in
-- any page the client renders, so there is no ordinary way for one to leak -
-- but it is a real gap rather than a theoretical one, and it is written down
-- here rather than left silent. Tightening it means routing joins through the
-- RPC only, which is worth doing if group ids ever become visible anywhere.
drop policy if exists "group_members_insert" on public.group_members;
create policy "group_members_insert" on public.group_members
  for insert
  with check (user_id = auth.uid() and role = 'member');

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
