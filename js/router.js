// js/router.js
//
// SW.Router - tiny History API wrapper that gives the app shareable,
// bookmarkable URLs, and makes the browser's back/forward buttons work.
//
// The app only ever has three "places" a URL can point at:
//   - the bare app URL                  -> onRoot()
//   - a specific group: "?g=<groupId>"  -> onGroup(groupId)
//   - a pending invite: "?join=<code>"  -> onJoin(code)
//
// This module only reads/writes the URL and calls back into the handlers
// the app hands it in init() - it knows nothing about groups, expenses,
// or Supabase, and never touches the DOM. It never throws: if the History
// API is missing (some embedded webviews) or the URL is malformed, it
// just falls back to behaving like a plain page load with no params
// (onRoot()), the same way the app worked before this file existed.
//
// Namespace: SW.Router

var SW = SW || {};

SW.Router = (function () {
  'use strict';

  var currentHandlers = null; // { onGroup, onJoin, onRoot }, set by init()

  // -----------------------------------------------------------------
  // small helpers
  // -----------------------------------------------------------------

  // Reads the bits of the current URL this router cares about. Never
  // throws - any parsing trouble just looks like "no params set".
  function readLocation() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      return {
        join: params.get('join'),
        group: params.get('g')
      };
    } catch (err) {
      return { join: null, group: null };
    }
  }

  // Calls whichever handler matches the current URL, falling back to
  // onRoot() whenever nothing usable is set (including "URL parsing
  // failed" and "no handlers registered yet").
  function dispatchFromLocation() {
    if (!currentHandlers) return;
    var loc = readLocation();
    try {
      if (loc.join) {
        currentHandlers.onJoin(loc.join);
      } else if (loc.group) {
        currentHandlers.onGroup(loc.group);
      } else {
        currentHandlers.onRoot();
      }
    } catch (err) {
      // A handler throwing is a bug in the app's handler, not the
      // router's - but the router itself must stay usable (e.g. back/
      // forward still needs to work on the next navigation), so this is
      // swallowed here rather than left to bubble up out of a popstate
      // listener, where nothing would catch it.
    }
  }

  function onPopState() {
    dispatchFromLocation();
  }

  // -----------------------------------------------------------------
  // public API
  // -----------------------------------------------------------------

  // Parses the current URL, calls the one matching handler, and starts
  // listening for the back/forward buttons (popstate). Call this once at
  // startup, after the handlers it needs are ready to run.
  //
  // handlers: { onGroup(groupId), onJoin(code), onRoot() }. Any of the
  // three that's missing or not a function is treated as a no-op, so a
  // caller only needs to supply the ones it cares about.
  function init(handlers) {
    handlers = handlers || {};
    currentHandlers = {
      onGroup: typeof handlers.onGroup === 'function' ? handlers.onGroup : function () {},
      onJoin: typeof handlers.onJoin === 'function' ? handlers.onJoin : function () {},
      onRoot: typeof handlers.onRoot === 'function' ? handlers.onRoot : function () {}
    };

    try {
      if (window.addEventListener) {
        window.addEventListener('popstate', onPopState);
      }
    } catch (err) {
      // No addEventListener (very old/broken environment): the app still
      // works, it just won't react to the back/forward buttons.
    }

    dispatchFromLocation();
  }

  // Pushes a new "?g=<groupId>" history entry, e.g. when the user clicks
  // a group in the sidebar. This is what makes a group linkable/
  // bookmarkable and makes "back" return to the previous group.
  //
  // No-ops (does not throw) if the History API isn't available.
  function goToGroup(groupId) {
    try {
      if (!window.history || !window.history.pushState) return;
      var url = window.location.pathname + '?g=' + encodeURIComponent(groupId);
      window.history.pushState({ groupId: groupId }, '', url);
    } catch (err) {
      // Malformed groupId, or a browser refusing pushState - never throw.
    }
  }

  // Replaces the current history entry with the bare app URL (no query
  // string, no hash), without adding a new entry to the stack. Use this
  // once a "?join=<code>" link has been consumed (so refreshing doesn't
  // re-trigger the join step) or when closing out of a group view back to
  // the app's default screen.
  //
  // No-ops (does not throw) if the History API isn't available.
  function replaceRoot() {
    try {
      if (!window.history || !window.history.replaceState) return;
      window.history.replaceState({}, '', window.location.pathname);
    } catch (err) {
      // never throw.
    }
  }

  // Builds an absolute, shareable "join this group" link for the given
  // invite code - e.g. for a "Copy invite link" button next to the
  // existing "Copy code" one. Always includes the origin, so the link
  // works when pasted anywhere (chat apps, email), not just within this
  // site.
  function inviteUrl(code) {
    try {
      var origin = window.location.origin || '';
      var pathname = window.location.pathname || '';
      return origin + pathname + '?join=' + encodeURIComponent(code);
    } catch (err) {
      // window.location somehow unusable - still return something usable
      // rather than throwing, just without a guaranteed origin.
      return '?join=' + encodeURIComponent(code || '');
    }
  }

  return {
    init: init,
    goToGroup: goToGroup,
    replaceRoot: replaceRoot,
    inviteUrl: inviteUrl
  };
})();
