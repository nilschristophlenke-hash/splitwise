# Setup guide — connecting Splitwise to Supabase

This turns the app from a single-device demo into a real multi-user app with
email-and-password sign-in. It assumes you have never used Supabase before,
and it should take about 10 minutes.

You will touch two places: **Supabase** (the database and auth backend) and
**this project's `js/config.js`** (so the app knows which Supabase project to
talk to). There is no third-party login provider to set up — accounts live in
your own database.

If you skip this whole guide, the app still works — it just falls back to
the old local-only demo mode (data stays in your browser, nobody else sees
it). Nothing breaks by not configuring Supabase.

---

## 1. Create a free Supabase project

1. Go to [supabase.com](https://supabase.com) and sign in (GitHub login is
   fine).
2. Click **New project**. Pick any organization, give it a name (e.g.
   `splitwise`), set a database password (save it somewhere — you probably
   won't need it again, but it's your project's master password), pick the
   region closest to you, and click **Create new project**. Wait ~2 minutes
   while it provisions.
3. Once it's ready, you're in the project dashboard. In the left sidebar,
   click the **gear icon → Project Settings**, then **API** (or **Data API**
   in newer dashboards).
4. You'll see two values you need later:
   - **Project URL** — looks like `https://xxxxxxxxxxxxxxxx.supabase.co`.
     For this project it is `https://yfswchnkhsgdyxgqzsqm.supabase.co`.
   - **anon / public key** — a long string starting with `eyJ...`.

   **This `anon` key is meant to be public.** It is safe to paste into
   `js/config.js` and commit to git — it identifies your project, it does
   not grant access to anything. Every real permission check happens in the
   database via Row Level Security (the policies in `supabase/schema.sql`).

   You will also see a **`service_role`** key on that same page. **Never**
   copy that one into this project, a commit, or anywhere client-side. It
   bypasses Row Level Security completely — anyone who has it can read and
   change every row in your database. This app never needs it.

---

## 2. Run the database schema

1. In the Supabase dashboard, click **SQL Editor** in the left sidebar, then
   **New query**.
2. Open `supabase/schema.sql` from this repo, select all, copy it.
3. Paste it into the SQL editor and click **Run** (or press Cmd/Ctrl+Enter).
4. You should see "Success. No rows returned." That's it — this one script
   creates all five tables (`profiles`, `groups`, `group_members`,
   `expenses`, `expense_participants`), turns on Row Level Security with the
   correct policies, creates the helper functions the app calls
   (`create_group`, `join_group_by_code`), and turns on realtime sync.

   This script is safe to run again later (after a `git pull`, say) if it
   changes — every statement in it is written to not fail on a second run.

---

## 3. Turn on email + password sign-in

This app uses Supabase's own email-and-password accounts. There is no Google
sign-in and no other outside identity provider — the only parties involved are
the person signing in and your own Supabase project.

### 3a. Check the provider is on

In the Supabase dashboard: **Authentication → Sign In / Providers → Email**.
It is enabled by default. Make sure **Enable email provider** is on.

### 3b. Decide about email confirmation

By default Supabase emails every new account a confirmation link, and the
person cannot sign in until they click it. That link is sent through
Supabase's shared test mail service, which is heavily rate-limited and often
lands in spam — for a small friend group it usually causes more problems than
it solves.

**Recommended for a friend group:** in **Authentication → Sign In / Providers
→ Email**, turn **Confirm email** *off*. New accounts then work immediately.

Be aware of what you are trading away: with confirmation off, nobody proves
they own the address they typed, so someone could sign up as
`your.friend@example.com` without having access to that mailbox. That matters
much less here than it would in most apps, because an account on its own gets
you nothing — you only ever see a group's expenses after someone shares that
group's invite code with you. If you would rather keep confirmation on, leave
it on and set up your own SMTP under **Project Settings → Auth → SMTP
Settings**, otherwise the confirmation emails will be unreliable.

### 3c. Set the site URL

**Authentication → URL Configuration:**

- **Site URL:** `https://splitwise-delta-wine.vercel.app`
- **Additional Redirect URLs:** add `http://localhost:8000` if you want to run
  it locally too.

Password sign-in does not redirect anywhere, so this matters far less than it
does for OAuth — but Supabase uses the Site URL in any email it does send, so
it is worth setting correctly.

## 4. Paste your keys into the app

1. Open `js/config.js` in this repo.
2. Paste in the **Project URL** and the **publishable** key from step 1.
   Newer projects name the keys `sb_publishable_…` and `sb_secret_…`; older
   ones call the same two things `anon` `public` and `service_role`. You want
   the first of each pair:
   ```js
   SW.Config = {
     SUPABASE_URL: 'https://yfswchnkhsgdyxgqzsqm.supabase.co',
     SUPABASE_ANON_KEY: 'sb_publishable_...your-key...',
   };
   ```
3. Save the file.

> **Only ever paste the publishable key here.** A key beginning
> `sb_secret_` (or a `service_role` key) bypasses every security rule in the
> database. This app is a static site, so anything in `config.js` is
> downloadable by anyone who visits — a secret key there would let any
> visitor read, change or delete every group's expenses.

---

## 5. Deploy

Vercel is already wired to this repo, so:

```bash
git add js/config.js
git commit -m "Configure Supabase"
git push
```

Vercel picks up the push and redeploys automatically — check the
[Vercel dashboard](https://vercel.com) if you want to watch it happen. Once
it's live, open https://splitwise-delta-wine.vercel.app and you should see
a sign-in screen asking for an email address and a password.

To test locally first, run a static server from the project root (e.g.
`python3 -m http.server 8000`) and open `http://localhost:8000` — this is
exactly why `http://localhost:8000/*` is in the redirect allow-list above.

---

## Troubleshooting

### "Invalid API key"

The key in `js/config.js` is wrong, or it is the wrong *kind* of key. It must
be the **publishable** key (`sb_publishable_…`, shown as `anon` `public` on
older projects). If you pasted a key starting `sb_secret_…`, remove it — see
the security note at the bottom.

### "Email not confirmed" when signing in

The account exists but Supabase is waiting for the confirmation link. Either
click the link in the email, or turn **Confirm email** off (step 3b) and try
again. Existing unconfirmed users can be confirmed by hand in
**Authentication → Users**.

### "Account created. Check your email…" but no email arrives

Supabase's built-in mail service is rate-limited and frequently filtered as
spam. Turn **Confirm email** off (step 3b), or configure your own SMTP.

### Sign-up says the user is already registered

That email already has an account — use **Sign in** instead. If you have
forgotten the password, delete the user in **Authentication → Users** and sign
up again (there is no password-reset flow in this app yet, because that would
need working email delivery).

### Signed in, but groups/expenses show up empty
This is almost always Row Level Security correctly doing its job, not a
bug — it means the current user genuinely has no rows they're allowed to
see yet. Check, in order:
1. Did step 2 actually run successfully? Open **SQL Editor** and run
   `select count(*) from public.groups;` — if this errors with something
   like "relation does not exist", the schema never ran; go back to step 2.
2. Is the signed-in user actually a member of any group? Run (as the
   project owner, this bypasses RLS so you can see everything):
   ```sql
   select g.name, gm.user_id, gm.role
   from public.group_members gm
   join public.groups g on g.id = gm.group_id;
   ```
   If the user's id isn't in there, they haven't created or joined a group
   yet — that's expected for a brand-new account, not a bug.
3. Confirm the `profiles` row exists for them:
   `select * from public.profiles where email = '...';` — if it's missing,
   the `on_auth_user_created` trigger didn't fire, which usually means step
   2's script didn't fully run (check for a red error partway through the
   SQL editor output and re-run it).

### General "did the schema really apply?" check
Run this in the SQL editor — it should list all five tables with RLS on:
```sql
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;
```
`rowsecurity` should read `true` for every row.

### Security reminder
- The **publishable** key (`sb_publishable_…`, or `anon` `public` on older
  projects) is designed to be public. It is meant to sit in client-side
  JavaScript and be visible in the browser's network tab — that is normal.
  It is safe only because the Row Level Security policies in
  `supabase/schema.sql` constrain what it can do.
- The **secret** key (`sb_secret_…`, or `service_role`) is the opposite: it
  bypasses Row Level Security entirely. It must never appear in this repo,
  in `config.js`, in a commit, or in a chat window. If it is ever exposed,
  assume it is compromised and roll it immediately in
  **Project Settings → API Keys**. Rolling it is cheap; a leaked secret key
  means anyone can read and delete the whole database.
