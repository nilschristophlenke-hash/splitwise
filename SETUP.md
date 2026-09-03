# Setup guide — connecting Splitwise to Supabase

This turns the app from a single-device demo into a real multi-user app with
Google sign-in. It assumes you have never used Supabase before, and it should
take about 15 minutes.

You will touch three places: **Supabase** (the database + auth backend),
**Google Cloud** (so "Continue with Google" works), and **this project's
`js/config.js`** (so the app knows which Supabase project to talk to).

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

## 3. Turn on Google sign-in

This has two halves: a Google Cloud OAuth client (so Google knows about your
app), and telling Supabase about it.

### 3a. Create the Google OAuth client

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
   Create a new project (top-left project dropdown → **New Project**) or
   pick an existing one you're happy to use for this.
2. Go to **APIs & Services → OAuth consent screen**.
   - User type: **External** (unless you have a Google Workspace org and
     want to restrict it).
   - Fill in an app name (e.g. "Splitwise"), your email as support/contact
     email, and save. You can leave scopes at the default (email, profile).
   - If prompted about "Publishing status", **Testing** is fine to start —
     add your own Google account under **Test users** so you can sign in
     while it's unpublished. Click **Publish app** later if you want anyone
     to be able to sign in without being added as a test user.
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth client
   ID**.
   - Application type: **Web application**.
   - Name: anything, e.g. "Splitwise web".
   - **Authorized redirect URIs** — this is the field that must be exact.
     Add exactly this one URL (swap in your own project ref if it differs
     from the one below):

     ```
     https://yfswchnkhsgdyxgqzsqm.supabase.co/auth/v1/callback
     ```

     This is **Supabase's** callback address, not your site's address —
     Google sends the user back to Supabase first, and Supabase then
     forwards them on to your app. Do not put your Vercel URL here.
   - Leave "Authorized JavaScript origins" empty — it isn't needed for this
     flow.
   - Click **Create**. You'll be shown a **Client ID** and **Client
     secret** — keep this tab open, you need both in the next step.

### 3b. Enable the provider in Supabase

1. Back in the Supabase dashboard: **Authentication → Providers**, find
   **Google** in the list and click it to expand.
2. Toggle it **Enabled**.
3. Paste the **Client ID** and **Client secret** from step 3a.
4. Click **Save**.

### 3c. Tell Supabase which URLs are allowed to receive a login redirect

1. Still in **Authentication**, go to **URL Configuration**.
2. **Site URL**: set this to your live site:
   ```
   https://splitwise-delta-wine.vercel.app
   ```
3. **Additional Redirect URLs**: add each of these on its own line —
   ```
   https://splitwise-delta-wine.vercel.app/*
   http://localhost:8000/*
   ```
   The `/*` wildcard covers the page whether it's loaded as `/` or
   `/index.html`. Add `http://127.0.0.1:8000/*` too if you sometimes use
   that address instead of `localhost` when testing locally.
4. Click **Save**.

---

## 4. Paste your keys into the app

1. Open `js/config.js` in this repo.
2. Paste in the **Project URL** and **anon key** from step 1:
   ```js
   SW.Config = {
     SUPABASE_URL: 'https://yfswchnkhsgdyxgqzsqm.supabase.co',
     SUPABASE_ANON_KEY: 'eyJ...your-anon-key...',
   };
   ```
3. Save the file. (Reminder: the anon key is fine to commit — see step 1.
   Never put a `service_role` key in this file.)

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
a sign-in screen with a "Continue with Google" button.

To test locally first, run a static server from the project root (e.g.
`python3 -m http.server 8000`) and open `http://localhost:8000` — this is
exactly why `http://localhost:8000/*` is in the redirect allow-list above.

---

## Troubleshooting

### `Error 400: redirect_uri_mismatch` on the Google screen
Google is refusing the request because the redirect URI Supabase sent it
doesn't exactly match what's in your Google Cloud OAuth client. Almost
always this means the **Authorized redirect URIs** field in Google Cloud
(step 3a) doesn't exactly equal:
```
https://<your-project-ref>.supabase.co/auth/v1/callback
```
Check for a typo, a missing/extra trailing slash, or `http` vs `https`.
Changes in Google Cloud can take a few minutes to take effect.

### "requested path is invalid" after logging in with Google
This is Supabase, not Google, refusing the redirect — it means the page
you landed back on isn't in Supabase's **Authentication → URL
Configuration → Additional Redirect URLs** list (step 3c). Double check the
Site URL and the additional redirect URLs match exactly where the app is
actually hosted, including using the `/*` wildcard so both `/` and
`/index.html` are covered, and that you added `http://localhost:8000/*` if
you're testing locally.

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
- The **anon** key is designed to be public. It's meant to sit in
  client-side JavaScript and be visible in the browser's network tab —
  that's normal and expected.
- The **service_role** key is not designed to be public. It skips Row Level
  Security entirely. It should never appear in this repo, in `config.js`,
  or in any file you commit. If you ever paste it in by accident, treat it
  as compromised: go to Project Settings → API and roll (regenerate) it.
