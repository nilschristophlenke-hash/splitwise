// js/auth.js
//
// SW.Auth - thin wrapper around Supabase Auth (email + password).
//
// No third-party identity provider is involved: accounts live in this
// project's own Supabase database and nowhere else.
//
// Every function here is safe to call even when Supabase isn't configured
// yet (js/config.js left blank), or when the browser refuses storage
// access (private browsing, some embeds): the whole module degrades to a
// signed-out no-op instead of throwing, so the rest of the app can keep
// working in local demo mode without ever checking SW.Config.isConfigured()
// itself.
//
// Namespace: SW.Auth

var SW = SW || {};

SW.Auth = (function () {
  'use strict';

  var sbClient = null; // the shared supabase-js client, or null if unconfigured
  var currentUser = null; // { id, email, name, avatarUrl } | null
  var listeners = []; // onChange callbacks
  var initPromise = null;

  // -----------------------------------------------------------------
  // small helpers
  // -----------------------------------------------------------------

  // Turns a raw supabase-js user object into the small, flat shape the
  // rest of the app cares about.
  function mapUser(supabaseUser) {
    if (!supabaseUser) return null;
    var meta = supabaseUser.user_metadata || {};
    return {
      id: supabaseUser.id,
      email: supabaseUser.email || '',
      name: meta.full_name || meta.name || supabaseUser.email || 'Signed in',
      avatarUrl: meta.avatar_url || meta.picture || ''
    };
  }

  function notify() {
    listeners.forEach(function (fn) {
      try {
        fn(currentUser);
      } catch (err) {
        // a broken subscriber must never break auth itself
      }
    });
  }

  // Supabase-js parses the OAuth redirect (either "?code=..." for the PKCE
  // flow or "#access_token=..." for the older implicit flow) out of the
  // URL itself as soon as the client exists / getSession() is called. Once
  // that has happened we tidy the leftover params out of the address bar
  // so a page refresh doesn't try to reprocess a stale code and the URL
  // looks normal again.
  function cleanAuthParamsFromUrl() {
    try {
      if (!window.history || !window.history.replaceState) return;

      var url = new URL(window.location.href);
      var search = url.searchParams;
      var authParamNames = [
        'code', 'error', 'error_description', 'error_code',
        'access_token', 'refresh_token', 'expires_in', 'expires_at',
        'provider_token', 'provider_refresh_token', 'token_type', 'type'
      ];
      var changedSearch = false;
      authParamNames.forEach(function (name) {
        if (search.has(name)) {
          search.delete(name);
          changedSearch = true;
        }
      });

      // The implicit flow puts its params in the hash (#access_token=...)
      // rather than the query string. If there's a hash that looks like
      // it holds auth params, drop the whole hash.
      var hasHashParams = !!url.hash && url.hash.length > 1 && url.hash.indexOf('=') !== -1;

      if (changedSearch || hasHashParams) {
        var newSearch = search.toString();
        var cleanUrl = url.pathname + (newSearch ? '?' + newSearch : '');
        window.history.replaceState({}, document.title, cleanUrl);
      }
    } catch (err) {
      // URL/history APIs misbehaving must never crash sign-in.
    }
  }

  // -----------------------------------------------------------------
  // public API
  // -----------------------------------------------------------------

  // Lazily creates (and remembers) the shared supabase-js client. Returns
  // null whenever Supabase isn't configured or the client library/config
  // is unusable for any reason - callers never need to know why.
  function client() {
    if (sbClient) return sbClient;
    if (!SW.Config || !SW.Config.isConfigured()) return null;
    if (typeof supabase === 'undefined' || !supabase || typeof supabase.createClient !== 'function') {
      return null;
    }
    try {
      sbClient = supabase.createClient(SW.Config.SUPABASE_URL, SW.Config.SUPABASE_ANON_KEY);
    } catch (err) {
      // e.g. storage access blocked in this browsing context.
      sbClient = null;
    }
    return sbClient;
  }

  // Restores an existing session (if any), wires up onAuthStateChange so
  // currentUser stays fresh, and resolves once the initial session lookup
  // is done. Always resolves (never rejects) - worst case currentUser
  // stays null, i.e. signed out.
  function init() {
    if (initPromise) return initPromise;

    initPromise = new Promise(function (resolve) {
      var sb = client();
      if (!sb) {
        currentUser = null;
        resolve(null);
        return;
      }

      try {
        sb.auth.onAuthStateChange(function (_event, session) {
          currentUser = mapUser(session && session.user);
          notify();
        });
      } catch (err) {
        // Registration itself should never throw, but if it does we still
        // want getSession() below to have a chance to run.
      }

      var settle = function (session) {
        currentUser = mapUser(session && session.user);
        cleanAuthParamsFromUrl();
        resolve(currentUser);
      };

      try {
        sb.auth
          .getSession()
          .then(function (result) {
            settle(result && result.data && result.data.session);
          })
          .catch(function () {
            settle(null);
          });
      } catch (err) {
        settle(null);
      }
    });

    return initPromise;
  }

  // Synchronous read of whoever is currently signed in.
  function getUser() {
    return currentUser;
  }

  function isSignedIn() {
    return !!currentUser;
  }

  // Email + password sign-in, handled entirely by Supabase Auth. There is
  // no third-party identity provider involved: the only parties are the
  // person signing in and this project's own database.
  //
  // Both functions resolve to {ok:true} or {ok:false, error} and never
  // reject, so callers can branch without a try/catch of their own.
  function signInWithPassword(email, password) {
    var sb = client();
    if (!sb) {
      return Promise.resolve({ ok: false, error: 'Supabase is not configured yet.' });
    }
    try {
      return sb.auth
        .signInWithPassword({ email: String(email || '').trim(), password: String(password || '') })
        .then(function (result) {
          if (result && result.error) {
            return { ok: false, error: friendlyAuthError(result.error) };
          }
          return { ok: true };
        })
        .catch(function (err) {
          return { ok: false, error: (err && err.message) || String(err) };
        });
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err && err.message) || String(err) });
    }
  }

  // Creates an account. `name` is stored in the user's metadata as
  // full_name, which the handle_new_user() trigger copies into the
  // profiles table - that is what your friends see next to an expense.
  //
  // If the project still has "Confirm email" switched on, Supabase creates
  // the user but returns no session, so we say so plainly instead of
  // leaving the person staring at a form that looks like it failed.
  function signUp(email, password, name) {
    var sb = client();
    if (!sb) {
      return Promise.resolve({ ok: false, error: 'Supabase is not configured yet.' });
    }
    try {
      return sb.auth
        .signUp({
          email: String(email || '').trim(),
          password: String(password || ''),
          options: { data: { full_name: String(name || '').trim() } }
        })
        .then(function (result) {
          if (result && result.error) {
            return { ok: false, error: friendlyAuthError(result.error) };
          }
          var data = result && result.data;
          if (data && data.user && !data.session) {
            return {
              ok: false,
              needsConfirmation: true,
              error: 'Account created. Check your email for a confirmation link, then sign in.'
            };
          }
          return { ok: true };
        })
        .catch(function (err) {
          return { ok: false, error: (err && err.message) || String(err) };
        });
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err && err.message) || String(err) });
    }
  }

  // Supabase's raw messages are terse and occasionally alarming; these are
  // the ones people actually hit.
  function friendlyAuthError(error) {
    var message = (error && error.message) || String(error);
    if (/invalid login credentials/i.test(message)) {
      return 'That email and password do not match an account.';
    }
    if (/user already registered/i.test(message)) {
      return 'There is already an account with that email — sign in instead.';
    }
    if (/password should be at least/i.test(message)) {
      return 'Password must be at least 8 characters.';
    }
    if (/email not confirmed/i.test(message)) {
      return 'This account still needs to be confirmed by email before you can sign in.';
    }
    if (/rate limit|too many/i.test(message)) {
      return 'Too many attempts — wait a moment and try again.';
    }
    return message;
  }

  // Signs out and clears the local user immediately either way, so the UI
  // never gets stuck "signed in" because a network call failed.
  function signOut() {
    var sb = client();
    if (!sb) {
      currentUser = null;
      notify();
      return Promise.resolve({ ok: true });
    }
    try {
      return sb.auth
        .signOut()
        .then(function () {
          currentUser = null;
          notify();
          return { ok: true };
        })
        .catch(function (err) {
          currentUser = null;
          notify();
          return { ok: false, error: (err && err.message) || String(err) };
        });
    } catch (err) {
      currentUser = null;
      notify();
      return Promise.resolve({ ok: false, error: (err && err.message) || String(err) });
    }
  }

  // Subscribe to sign-in/sign-out changes. Returns an unsubscribe function.
  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function unsubscribe() {
      var idx = listeners.indexOf(fn);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  }

  return {
    client: client,
    init: init,
    getUser: getUser,
    isSignedIn: isSignedIn,
    signInWithPassword: signInWithPassword,
    signUp: signUp,
    signOut: signOut,
    onChange: onChange
  };
})();
