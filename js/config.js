// js/config.js
//
// SW.Config - the one place that holds your Supabase project's connection
// details. This file is committed to the repo, so treat it as public: only
// ever put the PROJECT URL and the ANON (public) KEY here.
//
// -----------------------------------------------------------------------
// How to fill this in
// -----------------------------------------------------------------------
// 1. Create a free project at https://supabase.com.
// 2. In the Supabase dashboard: Project Settings -> API.
//      - "Project URL"       -> paste into SUPABASE_URL below
//        (looks like https://yfswchnkhsgdyxgqzsqm.supabase.co)
//      - "anon" "public" key -> paste into SUPABASE_ANON_KEY below
//        (a long string starting with "eyJ...")
// 3. Save this file and reload the page.
//
// See SETUP.md for the full walkthrough (running the schema, turning on
// email + password sign-in, etc).
//
// -----------------------------------------------------------------------
// Why it's safe to commit the anon key, but NOT the service_role key
// -----------------------------------------------------------------------
// The "anon" key is designed by Supabase to be public. It identifies your
// project, not a user - anyone can already see it in your deployed site's
// JS anyway. Real security comes from Row Level Security (RLS) policies on
// the database tables (see supabase/schema.sql), not from hiding this key.
//
// The "service_role" key is the opposite: it bypasses RLS entirely and
// must NEVER appear in client-side code, this file, or any commit. It has
// no business being anywhere in this repository.
//
// -----------------------------------------------------------------------
// Demo mode
// -----------------------------------------------------------------------
// While SUPABASE_URL and SUPABASE_ANON_KEY are left as empty strings (the
// default below), the app treats Supabase as "not configured" and boots
// straight into the local, single-device demo (SW.Store / localStorage) -
// no sign-in required, nothing breaks.

var SW = SW || {};

SW.Config = {
  SUPABASE_URL: 'https://yfswchnkhsgdyxgqzsqm.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_eQQzJqj2-63bel_M1OnxrA_6tAk7IV9'
};

// isConfigured() is true only once BOTH values above have been filled in
// with non-empty strings. Everything else in the app (SW.Auth,
// js/remote-store.js) checks this before trying to talk to Supabase, so
// leaving either value blank keeps the app fully working in local demo
// mode.
SW.Config.isConfigured = function () {
  return (
    typeof SW.Config.SUPABASE_URL === 'string' &&
    SW.Config.SUPABASE_URL.trim().length > 0 &&
    typeof SW.Config.SUPABASE_ANON_KEY === 'string' &&
    SW.Config.SUPABASE_ANON_KEY.trim().length > 0
  );
};
