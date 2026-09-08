// js/workflows.js
//
// A machine-readable description of how this app actually works. The admin
// console renders it; nothing here is hand-written HTML, so the docs and the
// diagrams cannot drift apart from each other.
//
// They CAN still drift from the code, which is the real risk with a file like
// this. Two habits keep it honest:
//   1. Everything below names a real function in a real file. If you rename
//      something, this file is part of the change.
//   2. Known gaps are written down as gaps, not quietly omitted. A document
//      that only lists what works is marketing, not documentation.
//
// Shape:
//   JOURNEY  - one continuous path from an empty app to everyone settled up.
//              This is the spine. Each stage names the branches hanging off it.
//   LIST     - every branch and every cross-cutting concern, in full detail.
//   Plus the data model, the two real algorithms, and the state machine.

var SW = SW || {};

SW.Workflows = (function () {
  'use strict';

  // =======================================================================
  // Architecture
  // =======================================================================

  var ARCHITECTURE = {
    summary:
      'A shared expense tracker with no build step and no runtime dependencies: ' +
      'plain HTML, CSS and classic scripts on one global namespace. It runs in ' +
      'two modes against the same UI - a local demo kept in this browser, and a ' +
      'shared mode backed by Supabase where a whole friend group works from one ' +
      'set of books. The arithmetic lives in a pure module that never touches the ' +
      'DOM, the network or storage, which is why it can be tested exhaustively.',
    layers: [
      {
        name: 'View',
        files: ['index.html', 'js/app.js', 'css/styles.css'],
        responsibility:
          'Renders state and turns clicks into actions. Holds no truth of its ' +
          'own beyond which modal is open and what is half-typed into a form. ' +
          'Talks to whichever store is active through one store() accessor, and ' +
          'does not know or care which one it got.',
      },
      {
        name: 'Presentation',
        files: ['js/i18n.js', 'js/router.js'],
        responsibility:
          'Language (English/German, including money and date formatting) and ' +
          'URLs (deep links to a group, invite links that carry a join code). ' +
          'Both are additive: the app works with either missing.',
      },
      {
        name: 'Identity',
        files: ['js/auth.js', 'js/config.js'],
        responsibility:
          'Email-and-password accounts through Supabase Auth. No third-party ' +
          'identity provider is involved. Degrades to a signed-out no-op when no ' +
          'backend is configured, which is what makes demo mode possible.',
      },
      {
        name: 'Store',
        files: ['js/store.js', 'js/remote-store.js'],
        responsibility:
          'Two implementations of one API (init/getState/subscribe/dispatch). ' +
          'SW.Store keeps everything in localStorage; SW.RemoteStore keeps it in ' +
          'Supabase and adds optimistic writes, rollback and realtime updates.',
      },
      {
        name: 'Model',
        files: ['js/model.js'],
        responsibility:
          'Pure functions: parsing money, splitting an amount, computing ' +
          'balances, minimising the number of payments. No DOM, no storage, no ' +
          'network, no clock. Same input, same output, always.',
      },
      {
        name: 'Database',
        files: ['supabase/schema.sql'],
        responsibility:
          'Postgres with row-level security deciding who may see what, and ' +
          'validated functions deciding what is allowed to be written at all. ' +
          'This layer is the authority on both questions - the client is a ' +
          'convenience, not a gatekeeper.',
      },
    ],
    principles: [
      'Money is an integer number of cents, everywhere, always. Formatting to "€12.30" happens only at the moment of rendering.',
      'A split adds back up to the total, exactly. Enforced in the database, not only in the browser.',
      'The client validates for a fast, kind error message. The server validates because the client can be bypassed.',
      'One store API, two implementations, so the UI never branches on which backend it is talking to.',
      'Optimistic writes: apply locally, show it instantly, and roll back loudly if the server disagrees.',
      'Known gaps are documented as gaps. Silence would be worse than the gap.',
    ],
  };

  // =======================================================================
  // The journey - one path, from an empty app to everyone settled up
  // =======================================================================

  var JOURNEY = {
    id: 'master',
    title: 'From an empty app to everyone settled up',
    summary:
      'Every feature in this app exists to move a group along one path: strangers ' +
      'with an unopened link at one end, and a group where nobody owes anybody ' +
      'anything at the other. The eight stages below are that path. Everything ' +
      'else - joining, editing, rotating an invite code, switching language, ' +
      'recovering a password - is a branch hanging off one of them, and every ' +
      'branch eventually rejoins the spine or ends the journey deliberately.',

    stages: [
      // ------------------------------------------------------------------
      {
        id: 'arrive',
        n: 1,
        title: 'Arrive',
        purpose:
          'Work out which world the visitor is in before showing them anything: ' +
          'a configured backend or not, a live session or not, and what the URL ' +
          'is asking for.',
        entry: 'Someone loads index.html.',
        exit: 'The app knows which store is active and what the URL wants.',
        steps: [
          { n: 1, actor: 'View', action: 'init()', detail: 'Wires static events, dialogs and the router, then decides the mode.', file: 'js/app.js' },
          { n: 2, actor: 'Config', action: 'SW.Config.isConfigured()', detail: 'True only when both a Supabase URL and a publishable key are present.', file: 'js/config.js' },
          { n: 3, actor: 'Router', action: 'SW.Router.init()', detail: 'Reads ?join=<code> or ?g=<id> and remembers the intent for later - the data has not loaded yet.', file: 'js/router.js' },
          { n: 4, actor: 'Identity', action: 'SW.Auth.init()', detail: 'Restores an existing session, then cleans OAuth/recovery parameters out of the address bar.', file: 'js/auth.js' },
          { n: 5, actor: 'View', action: 'startLocalMode() or showAuthScreen()', detail: 'No backend configured means demo mode immediately. Configured but signed out means the sign-in screen.', file: 'js/app.js' },
        ],
        invariants: [
          'The app always boots into something usable - a blank page is never an acceptable outcome of a failed backend.',
          'Language is decided before the first paint, so nothing flashes English at a German visitor.',
        ],
        edgeCases: [
          { case: 'No Supabase project configured at all', handling: 'Falls straight into local demo mode. This is how the app behaves for anyone who clones the repo without credentials.', status: 'handled' },
          { case: 'Backend configured but unreachable (offline, project paused)', handling: 'SW.Auth.init() rejects, a toast explains, and the app starts in demo mode rather than showing a dead sign-in form.', status: 'handled' },
          { case: 'Deep link ?g=<id> on a cold load, before groups exist in memory', handling: 'The intent is parked in pendingGroupFromUrl and applied by applyPendingUrlIntent() once the store finishes loading.', status: 'handled' },
          { case: 'Deep link ?g=<id> for a group this account cannot see', handling: 'SELECT_GROUP fails, a toast says the link is not available on this account, and the URL is reset. It never silently shows a different group.', status: 'handled' },
          { case: 'Invite link ?join=<code> while signed out', handling: 'The code is held until after sign-in, then the join dialog opens pre-filled.', status: 'handled' },
          { case: 'Return from a password-reset email (type=recovery)', handling: 'SW.Auth.isPasswordRecovery() is captured at script load, before the URL is cleaned, and the set-new-password form is shown.', status: 'handled' },
          { case: 'localStorage unavailable (private mode, storage disabled)', handling: 'Every access is wrapped; the app runs in memory for the session and simply does not persist.', status: 'handled' },
        ],
        branches: ['demo-mode', 'deep-links', 'backend-unreachable'],
      },

      // ------------------------------------------------------------------
      {
        id: 'identify',
        n: 2,
        title: 'Become someone',
        purpose:
          'Turn an anonymous visitor into a named account, because "who owes ' +
          'whom" is meaningless without a stable who.',
        entry: 'A backend is configured and nobody is signed in.',
        exit: 'There is a session, a user id and a display name.',
        steps: [
          { n: 1, actor: 'View', action: 'Sign-in card', detail: 'One card doubles as sign-up; a link toggles between the two modes and swaps the password autocomplete hint.', file: 'js/app.js' },
          { n: 2, actor: 'View', action: 'Client-side checks', detail: 'Email present, password at least 8 characters, and a display name when signing up - checked before any network call.', file: 'js/app.js' },
          { n: 3, actor: 'Identity', action: 'SW.Auth.signUp / signInWithPassword', detail: 'Supabase Auth. Terse server messages are mapped to sentences a person can act on by friendlyAuthError().', file: 'js/auth.js' },
          { n: 4, actor: 'Database', action: 'handle_new_user() trigger', detail: 'Mirrors the new auth user into public.profiles, copying full_name from the sign-up metadata.', file: 'supabase/schema.sql' },
          { n: 5, actor: 'View', action: 'startRemoteMode()', detail: 'Swaps SW.Store for SW.RemoteStore, shows the account chip, hides the demo user picker.', file: 'js/app.js' },
        ],
        invariants: [
          'ui.currentUserId in shared mode is always the signed-in account - it is not a guess and not user-selectable.',
          'A failed sign-in never leaves the submit button disabled.',
        ],
        edgeCases: [
          { case: 'Password shorter than 8 characters', handling: 'Rejected in the browser before any request is sent.', status: 'handled' },
          { case: 'Email already registered', handling: 'friendlyAuthError() turns the raw message into "There is already an account with that email — sign in instead."', status: 'handled' },
          { case: '"Confirm email" is switched on in Supabase', handling: 'Sign-up returns a user but no session. That exact case is detected and reported as "Account created. Check your email…" rather than looking like a silent failure.', status: 'handled' },
          { case: 'Wrong password', handling: 'Mapped to "That email and password do not match an account."', status: 'handled' },
          { case: 'Too many attempts', handling: 'Supabase rate-limits; the message is mapped to a plain "wait a moment and try again".', status: 'handled' },
          { case: 'Forgotten password', handling: 'A reset flow exists (requestPasswordReset / completePasswordReset). Delivery goes through Supabase\'s shared mailer unless SMTP is configured, so it is rate-limited and often lands in spam.', status: 'known-gap' },
          { case: 'Nobody proves they own the email address', handling: 'Email confirmation is deliberately off so friends can join without fighting the mailer. An account alone grants nothing - a group is only visible after someone shares its invite code - but the address itself is unverified.', status: 'known-gap' },
          { case: 'Two people choose the same display name', handling: 'Closed. When two members of a group share a name, each is shown a short disambiguator - their email, or the tail of their id - next to it in the member chips and the balances panel. Unique names get nothing, so the common case stays clean.', status: 'handled' },
        ],
        branches: ['sign-up', 'sign-in', 'password-reset', 'sign-out'],
      },

      // ------------------------------------------------------------------
      {
        id: 'form-group',
        n: 3,
        title: 'Form the group',
        purpose: 'Create the shared book, or get into someone else\'s.',
        entry: 'Signed in (or in demo mode) with no group selected.',
        exit: 'The account is a member of at least one group.',
        steps: [
          { n: 1, actor: 'View', action: 'New group / Join with code', detail: 'Two doors into the same place. In shared mode the "type member names" field is hidden - members are accounts, not strings.', file: 'js/app.js' },
          { n: 2, actor: 'Store', action: "dispatch ADD_GROUP or JOIN_GROUP", detail: 'ADD_GROUP applies optimistically; JOIN_GROUP cannot, because until the server resolves the code there is no way to know which group it means.', file: 'js/remote-store.js' },
          { n: 3, actor: 'Database', action: 'create_group() / join_group_by_code()', detail: 'Both are security definer. create_group writes the group and the owner membership in one transaction; join_group_by_code is the only way a membership row can be written at all.', file: 'supabase/schema.sql' },
          { n: 4, actor: 'Store', action: 'Reconcile', detail: 'The temporary client id is replaced with the server id, or the optimistic row is rolled back and the failure surfaced.', file: 'js/remote-store.js' },
        ],
        invariants: [
          'A group always has exactly one owner, created in the same transaction as the group itself.',
          'A membership row can only ever be written for auth.uid(), and only by presenting a valid invite code.',
        ],
        edgeCases: [
          { case: 'Empty group name', handling: 'Rejected in the form; the database also constrains name length 1-80.', status: 'handled' },
          { case: 'Wrong or expired invite code', handling: 'join_group_by_code raises "No group found for that invite code."; the join dialog stays open and shows it.', status: 'handled' },
          { case: 'Joining a group you are already in', handling: 'on conflict do nothing - a harmless no-op, not an error, and it cannot duplicate the membership row.', status: 'handled' },
          { case: 'Guessing a group UUID to get in without a code', handling: 'There is deliberately no insert policy on group_members, so a direct write is denied. The RPC is the only door, and it checks the code.', status: 'handled' },
          { case: 'One account creating unlimited groups', handling: 'create_group caps ownership at 50 per account, because the publishable key is public and anyone can call it.', status: 'handled' },
          { case: 'Joining takes a round trip and can fail', handling: 'JOIN_GROUP returns {ok:true, pending:true} and reports the real outcome through an onResult callback. The modal says "Joining…" until the answer arrives. It used to close and claim success while the request was still failing.', status: 'handled' },
        ],
        branches: ['create-group', 'join-by-code', 'select-group', 'rename-group', 'delete-group'],
      },

      // ------------------------------------------------------------------
      {
        id: 'assemble',
        n: 4,
        title: 'Get everyone in',
        purpose:
          'Assemble the group before money starts moving. This stage is early on ' +
          'purpose: an expense only splits between people who are already members, ' +
          'so latecomers are silently left out of everything logged before them.',
        entry: 'A group exists with at least its owner in it.',
        exit: 'Everyone who will share costs is a member.',
        steps: [
          { n: 1, actor: 'View', action: 'Invite', detail: 'Shows the invite code and offers a shareable link (?join=<code>) that lands a friend on the join step with the code already filled in.', file: 'js/app.js' },
          { n: 2, actor: 'Router', action: 'SW.Router.inviteUrl(code)', detail: 'Builds the absolute link. A link is one tap for the receiver; a bare code is a copy-paste and an explanation.', file: 'js/router.js' },
          { n: 3, actor: 'Friend', action: 'Opens the link, signs up, joins', detail: 'Rejoins the spine at stage 2, then stage 3.', file: 'js/app.js' },
          { n: 4, actor: 'Database', action: 'is_group_member()', detail: 'From here on, every read and every write in this group is gated on membership.', file: 'supabase/schema.sql' },
        ],
        invariants: [
          'Membership decides visibility completely: a non-member sees zero rows in every table, not a filtered view.',
          'A group can never be left without an owner.',
        ],
        edgeCases: [
          { case: 'Invite code shared too widely (screenshot in a group chat)', handling: 'The owner can rotate it. The old code stops working immediately.', status: 'handled' },
          { case: 'A member owes money and tries to leave', handling: 'A trigger refuses while they appear in any expense in that group, so nobody can walk away from a debt by leaving.', status: 'handled' },
          { case: 'The owner tries to leave', handling: 'Refused unless ownership is handed over first, so a group cannot be stranded with nobody able to manage or delete it.', status: 'handled' },
          { case: 'Someone joins after expenses already exist', handling: 'Closed. The row still reads \"Not involved\", which is accurate, but it now carries an explanation that an expense only splits between the people who were already in the group when it was added.', status: 'handled' },
          { case: 'Nobody is told when a friend joins or adds an expense', handling: 'Still open. Changes from other people arrive live over realtime while the app is open, but there are no push or email notifications, so nothing reaches anyone who has the app closed.', status: 'known-gap' },
        ],
        branches: ['invite-and-share', 'rotate-invite-code', 'transfer-ownership', 'leave-group', 'remove-member', 'add-member-demo'],
      },

      // ------------------------------------------------------------------
      {
        id: 'record',
        n: 5,
        title: 'Record what was spent',
        purpose:
          'Capture one payment and how it divides. This is the stage the whole ' +
          'app exists for, and the one with the most ways to go wrong.',
        entry: 'A group with members.',
        exit: 'A stored expense whose shares add up to its amount, exactly.',
        steps: [
          { n: 1, actor: 'View', action: 'Collect the form', detail: 'Description, amount, payer, category, date, split mode and per-participant values.', file: 'js/app.js' },
          { n: 2, actor: 'Model', action: 'parseAmount()', detail: 'Turns typed text into integer cents. Accepts "12,50", "1.234,56", "€12.50"; returns null for anything else, including negatives.', file: 'js/model.js' },
          { n: 3, actor: 'Model', action: 'splitExpense()', detail: 'Live preview while typing, so the division is visible before submitting.', file: 'js/model.js' },
          { n: 4, actor: 'Model', action: 'validateExpense()', detail: 'Delegates the mode rules to splitExpense so the validator and the allocator cannot disagree - a divergence that once let an exact split of 1.00 pay out 1.01.', file: 'js/model.js' },
          { n: 5, actor: 'Store', action: 'dispatch ADD_EXPENSE', detail: 'Applies to the local cache, notifies subscribers, returns {ok:true} synchronously so the UI updates instantly.', file: 'js/remote-store.js' },
          { n: 6, actor: 'Database', action: 'create_expense()', detail: 'Re-validates everything and writes the expense and its participants in one transaction. Direct writes to those tables are not permitted.', file: 'supabase/schema.sql' },
          { n: 7, actor: 'Store', action: 'Reconcile or roll back', detail: 'On success the temporary id is swapped for the server id. On failure the optimistic row is removed and a banner appears.', file: 'js/remote-store.js' },
        ],
        invariants: [
          'sum(shareCents) === amountCents, for every split mode, with no exceptions.',
          'No cent is invented or lost: leftovers are distributed by largest remainder, deterministically.',
          'Nothing is ever half-written: the expense and its participants land together or not at all.',
        ],
        edgeCases: [
          { case: 'Unparseable amount ("abc", empty, negative)', handling: 'parseAmount returns null; the form refuses to submit and says why.', status: 'handled' },
          { case: 'An indivisible amount (10.00 three ways)', handling: 'Largest-remainder allocation gives 3.34 / 3.33 / 3.33. The leftover cent goes to whoever lost most to rounding, and the same input always produces the same answer.', status: 'handled' },
          { case: 'Exact amounts that do not add up to the total', handling: 'Refused by the client and again by the database, which reports the actual and expected totals.', status: 'handled' },
          { case: 'Percentages that do not reach 100', handling: 'Refused. The tolerance is a named constant (0.0100001) so that a sum exactly 0.01 away still passes despite binary floating point.', status: 'handled' },
          { case: 'Infinity or NaN as a share weight', handling: 'Rejected. Both slip past a naive "value > 0" test and would poison every later calculation.', status: 'handled' },
          { case: 'A negative share that still sums correctly', handling: 'Rejected - it would credit someone instead of charging them.', status: 'handled' },
          { case: 'The same person listed twice as a participant', handling: 'Rejected in both layers; they would be charged two shares while somebody else got none.', status: 'handled' },
          { case: 'Payer or participant is not in the group', handling: 'Rejected by the database. Otherwise a member could create a debt for any account in the system - somebody who cannot see the group and would never be told.', status: 'handled' },
          { case: 'An amount larger than JavaScript can read back accurately', handling: 'Capped below 2^53. Money that changes value when you read it is worse than money you cannot store.', status: 'handled' },
          { case: 'Absurd dates or a 50,000-character description', handling: 'Constrained in the database: dates within a sane window, description 1-200 characters, note up to 2000.', status: 'handled' },
          { case: 'Double-clicking submit on a slow connection', handling: 'The submit button disables while the write is in flight.', status: 'handled' },
          { case: 'Two people editing the same expense at once', handling: 'update_expense refuses a write based on a stale version and says so, instead of letting the second edit silently overwrite the first.', status: 'handled' },
          { case: 'The write fails after the optimistic update', handling: 'The cache is rolled back and a persistent banner appears. It stays until dismissed or until a later write succeeds - unlike a toast, which vanishes whether or not anyone saw it.', status: 'handled' },
          { case: 'Changes made while offline', handling: 'Closed. A write that fails with no answer from the server is kept on screen and parked in a retry queue, which drains when the browser reports it is back online. A write the server REFUSED is never queued - retrying it would fail identically forever - so it rolls back and says why. The header shows how many changes are waiting.', status: 'handled' },
          { case: 'Who edited an expense, and what it said before', handling: 'Closed. expenses.updated_by records who, and an append-only expense_history table records every create, update and delete with the previous values and a timestamp. It is readable by group members and writable by nobody directly - only the validated functions and a delete trigger write to it.', status: 'handled' },
        ],
        branches: ['add-expense', 'split-calculation', 'edit-expense', 'delete-expense', 'validation-rejection', 'edit-conflict'],
      },

      // ------------------------------------------------------------------
      {
        id: 'reconcile',
        n: 6,
        title: 'Turn records into balances',
        purpose: 'Answer one question for each member: am I up or down, and by how much?',
        entry: 'At least one expense in the group.',
        exit: 'A net figure per member, summing to exactly zero.',
        steps: [
          { n: 1, actor: 'Model', action: 'computeBalances()', detail: 'Credits the payer the full amount, debits each participant their share, for every expense and settlement in the group.', file: 'js/model.js' },
          { n: 2, actor: 'Model', action: 'Skip the unusable', detail: 'A record whose split cannot be computed is skipped entirely rather than half-applied, so credits and debits never drift apart.', file: 'js/model.js' },
          { n: 3, actor: 'View', action: 'Balances panel', detail: 'Positive is money owed to you, negative is money you owe. Colour is never the only signal - the sign and the words carry it too.', file: 'js/app.js' },
        ],
        invariants: [
          'The sum of all balances in a group is exactly zero. Every cent charged was paid by someone.',
          'Every member of the group appears, including those sitting at exactly zero.',
        ],
        edgeCases: [
          { case: 'A settlement', handling: 'Treated as an ordinary expense of type "settlement" paid by the payer to a single participant, so it flows through the same arithmetic instead of needing a parallel code path.', status: 'handled' },
          { case: 'An expense that cannot be split (only reachable via imported demo data now)', handling: 'Skipped in the balance maths, and the admin console flags it as a record counted in totals but contributing nothing.', status: 'handled' },
          { case: 'A member who is in an expense but no longer in the group', handling: 'Cannot happen any more - the removal guard refuses while they appear in any expense. It was previously possible and produced an "Unknown" debtor in the settlements list.', status: 'handled' },
          { case: 'Very many expenses', handling: 'Closed for rendering, which was the visible cost: the list paints the most recent 150 rows with a control to show the rest. Balances are still computed from EVERY expense - capping what is fetched would silently produce wrong numbers, which is far worse than a long list.', status: 'handled' },
        ],
        branches: ['compute-balances'],
      },

      // ------------------------------------------------------------------
      {
        id: 'minimise',
        n: 7,
        title: 'Reduce it to the fewest payments',
        purpose:
          'Six people owing each other in a tangle should not mean fifteen bank ' +
          'transfers. Turn the balances into the shortest list of payments that ' +
          'clears them.',
        entry: 'Balances that are not all zero.',
        exit: 'A list of concrete "A pays B €X" instructions.',
        steps: [
          { n: 1, actor: 'Model', action: 'simplifyDebts()', detail: 'Repeatedly matches the largest creditor with the largest debtor and transfers the smaller of the two amounts.', file: 'js/model.js' },
          { n: 2, actor: 'Model', action: 'Deterministic ordering', detail: 'Sorted by amount descending, ties broken by member id, so the same balances always produce the same suggestions.', file: 'js/model.js' },
          { n: 3, actor: 'View', action: 'Suggested settlements', detail: 'Each with a Record button that pre-fills the settlement.', file: 'js/app.js' },
        ],
        invariants: [
          'At most n-1 transfers for n people.',
          'Applying every suggested transfer brings every balance to exactly zero.',
          'No transfer is ever zero or negative.',
        ],
        edgeCases: [
          { case: 'Everyone already at zero', handling: 'No transfers, and the panel says so rather than showing an empty box.', status: 'handled' },
          { case: 'Ties between equal debtors', handling: 'Broken by member id so the output is stable between renders and between devices.', status: 'handled' },
          { case: 'Rounding across many members', handling: 'Verified by fuzzing: 5,000 random balance sets all settle to exactly zero within the n-1 bound.', status: 'handled' },
          { case: 'The suggestion is not the fairest, only the shortest', handling: 'The algorithm minimises the number of payments, not who pays whom. It can ask you to pay someone you never directly transacted with. Correct, and occasionally surprising.', status: 'handled' },
        ],
        branches: ['simplify-debts'],
      },

      // ------------------------------------------------------------------
      {
        id: 'settle',
        n: 8,
        title: 'Settle up',
        purpose: 'Record the real-world payment that clears a debt.',
        entry: 'A suggested settlement, or any payment between two members.',
        exit: 'A settlement record, and balances that moved toward zero.',
        steps: [
          { n: 1, actor: 'View', action: 'Settle up / Record', detail: 'Either from the suggestions list, pre-filled, or entered by hand.', file: 'js/app.js' },
          { n: 2, actor: 'Store', action: 'dispatch ADD_SETTLEMENT', detail: 'Builds an expense with type "settlement", exact split, and the receiver as the single participant.', file: 'js/remote-store.js' },
          { n: 3, actor: 'Database', action: 'create_expense()', detail: 'The same validated path as any other expense. Settlements are not a special case in the schema.', file: 'supabase/schema.sql' },
          { n: 4, actor: 'Model', action: 'computeBalances()', detail: 'Both sides move by the settled amount, and the group total is unchanged.', file: 'js/model.js' },
        ],
        invariants: [
          'A settlement moves money between exactly two people and changes no one else\'s balance.',
          'Recording every suggested settlement leaves every member at exactly zero.',
        ],
        edgeCases: [
          { case: 'Settling more than is owed', handling: 'Allowed - it simply flips the direction of the balance. Real payments are sometimes round numbers.', status: 'handled' },
          { case: 'Settling a debt someone already paid', handling: 'Both are recorded and the balance goes negative, which is visible and correctable by deleting one.', status: 'handled' },
          { case: 'Deleting a settlement', handling: 'Supported, with undo, and the balance returns to what it was.', status: 'handled' },
          { case: 'How the money actually moved', handling: 'Closed. A settlement can record how it was paid - cash, bank transfer, PayPal, Revolut or other - constrained in the database so the field can only be set on an actual settlement.', status: 'handled' },
        ],
        branches: ['settle-up', 'record-suggested'],
      },
    ],

    terminal: {
      id: 'settled',
      title: 'Everyone is settled up',
      description:
        'Every member sits at exactly zero. The group has no outstanding debt in ' +
        'either direction, the suggestions panel is empty, and the expense history ' +
        'remains as a record of what happened. This is the state the whole app is ' +
        'built to reach - and the group can stay here, or start the loop again at ' +
        'stage 5 with the next shared cost.',
      invariants: [
        'Every balance in the group is exactly 0.',
        'simplifyDebts() returns an empty list.',
        'The sum of everything paid still equals the sum of everything owed - settling changes who holds the money, never how much there was.',
      ],
    },
  };

  // =======================================================================
  // Branches and cross-cutting concerns
  // =======================================================================

  var LIST = [
    // ---------------- stage 1: arrive ----------------
    {
      id: 'demo-mode',
      stage: 'arrive',
      kind: 'branch',
      title: 'Try it without an account',
      trigger: 'A visitor clicks "Try the demo without an account", or no backend is configured.',
      purpose: 'Let someone use the whole app immediately, with no sign-up and no server.',
      steps: [
        { n: 1, actor: 'View', action: 'startLocalMode()', detail: 'Points store() at SW.Store and hides the account chip.', file: 'js/app.js' },
        { n: 2, actor: 'Store', action: 'SW.Store.init()', detail: 'Loads from localStorage or seeds the demo group.', file: 'js/store.js' },
        { n: 3, actor: 'Store', action: 'Members are strings', detail: 'In demo mode a member is a typed name, not an account, so ADD_MEMBER works here and only here.', file: 'js/store.js' },
      ],
      invariants: ['Demo data never leaves this browser and is never sent anywhere.'],
      failureModes: [
        { case: 'localStorage throws or is full', handling: 'Caught; the app keeps working in memory for the session.' },
      ],
      edgeCases: [
        { case: 'Someone enters real expenses in demo mode, then signs up', handling: 'Closed. If there is local demo data when an account first signs in with no groups of its own, the app offers to copy it across. Members cannot come with it - they were names, not accounts - so the expenses are re-pointed at the signed-in user, and everything goes through the normal validated path.', status: 'handled' },
      ],
    },
    {
      id: 'deep-links',
      stage: 'arrive',
      kind: 'branch',
      title: 'Open a link to a group or an invite',
      trigger: 'A URL carrying ?g=<groupId> or ?join=<code>.',
      purpose: 'Make groups linkable and invites one tap instead of a copy-paste plus an explanation.',
      steps: [
        { n: 1, actor: 'Router', action: 'SW.Router.init()', detail: 'Parses the URL and calls onGroup or onJoin; ?join wins if both are present.', file: 'js/router.js' },
        { n: 2, actor: 'View', action: 'Park the intent', detail: 'Stored in pendingGroupFromUrl / pendingJoinCode, because a link arrives long before the data does.', file: 'js/app.js' },
        { n: 3, actor: 'View', action: 'applyPendingUrlIntent()', detail: 'Runs once the store has loaded: selects the group, or opens the join dialog pre-filled.', file: 'js/app.js' },
        { n: 4, actor: 'Router', action: 'goToGroup / replaceRoot', detail: 'Selecting a group pushes a URL so the back button works; a consumed invite is cleared so a refresh does not reopen it.', file: 'js/router.js' },
      ],
      invariants: ['A malformed URL or a missing History API degrades to the normal root view rather than throwing.'],
      failureModes: [
        { case: 'The linked group is not visible to this account', handling: 'A toast says so and the URL resets - it never falls through to somebody else\'s group.' },
      ],
    },
    {
      id: 'backend-unreachable',
      stage: 'arrive',
      kind: 'branch',
      title: 'The backend cannot be reached',
      trigger: 'SW.Auth.init() rejects - offline, DNS failure, or a paused Supabase project.',
      purpose: 'Fail into something usable instead of a dead form.',
      steps: [
        { n: 1, actor: 'Identity', action: 'init() rejects', detail: 'Every auth method resolves rather than throwing, so this is a rejected promise, not an exception.', file: 'js/auth.js' },
        { n: 2, actor: 'View', action: 'Toast plus startLocalMode()', detail: 'Says the server could not be reached and starts demo mode.', file: 'js/app.js' },
      ],
      invariants: ['A blank page is never an acceptable outcome.'],
      failureModes: [
        { case: 'The backend recovers later in the session', handling: 'Not detected automatically; a reload picks it up.', },
      ],
    },

    // ---------------- stage 2: identify ----------------
    {
      id: 'sign-up',
      stage: 'identify',
      kind: 'branch',
      title: 'Create an account',
      trigger: 'The sign-in card is switched to "Create one" and submitted.',
      purpose: 'Make a durable identity that balances can be attached to.',
      steps: [
        { n: 1, actor: 'View', action: 'Name, email, password', detail: 'The name is what friends see next to an expense, so it is asked for up front rather than derived from an email.', file: 'js/app.js' },
        { n: 2, actor: 'Identity', action: 'SW.Auth.signUp()', detail: 'Passes the name as full_name in the user metadata.', file: 'js/auth.js' },
        { n: 3, actor: 'Database', action: 'handle_new_user()', detail: 'Trigger copies id, email, full_name and avatar into public.profiles.', file: 'supabase/schema.sql' },
      ],
      invariants: ['A profile row exists for every auth user, created by the database rather than by the client.'],
      failureModes: [
        { case: 'Email already registered', handling: 'Mapped to a plain sentence suggesting sign-in instead.' },
        { case: 'Confirmation required but no SMTP', handling: 'Reported explicitly rather than appearing to do nothing.' },
      ],
    },
    {
      id: 'sign-in',
      stage: 'identify',
      kind: 'branch',
      title: 'Sign in',
      trigger: 'Email and password submitted in sign-in mode.',
      purpose: 'Restore an identity and its groups.',
      steps: [
        { n: 1, actor: 'Identity', action: 'signInWithPassword()', detail: 'Supabase Auth; no third-party provider is involved.', file: 'js/auth.js' },
        { n: 2, actor: 'View', action: 'onChange fires', detail: 'startRemoteMode() swaps the store and loads the account\'s groups.', file: 'js/app.js' },
        { n: 3, actor: 'Store', action: 'SW.RemoteStore.init()', detail: 'Fetches groups, memberships, expenses and participants, then subscribes to realtime changes.', file: 'js/remote-store.js' },
      ],
      invariants: ['A session restored on reload produces the same view as a fresh sign-in.'],
      failureModes: [
        { case: 'Wrong credentials', handling: 'One clear message; the button re-enables.' },
        { case: 'Loading the groups fails', handling: 'The error banner explains, and the app stays signed in rather than bouncing to the sign-in screen.' },
      ],
    },
    {
      id: 'password-reset',
      stage: 'identify',
      kind: 'branch',
      title: 'Recover a forgotten password',
      trigger: '"Forgot password?", or returning from a reset email.',
      purpose: 'Stop a forgotten password meaning a permanently lost account.',
      steps: [
        { n: 1, actor: 'Identity', action: 'requestPasswordReset(email)', detail: 'Sends a reset link back to this page.', file: 'js/auth.js' },
        { n: 2, actor: 'Identity', action: 'isPasswordRecovery()', detail: 'Captured at script load, before the URL is cleaned, and also from the PASSWORD_RECOVERY auth event.', file: 'js/auth.js' },
        { n: 3, actor: 'Identity', action: 'completePasswordReset(newPassword)', detail: 'Sets the new password and continues into the app.', file: 'js/auth.js' },
      ],
      invariants: ['The recovery signal survives the URL cleanup that strips auth parameters from the address bar.'],
      failureModes: [
        { case: 'The email never arrives', handling: 'Supabase\'s shared mailer is rate-limited and frequently filtered as spam. Configuring SMTP is the real fix.' },
      ],
      edgeCases: [
        { case: 'Reset email delivery in the current configuration', handling: 'Unreliable. The flow is correct but depends on a mailer that is not fit for the job until SMTP is configured.', status: 'known-gap' },
      ],
    },
    {
      id: 'sign-out',
      stage: 'identify',
      kind: 'branch',
      title: 'Sign out',
      trigger: 'The Sign out button.',
      purpose: 'End the session and leave nothing readable behind.',
      steps: [
        { n: 1, actor: 'Identity', action: 'SW.Auth.signOut()', detail: 'Clears the local user immediately either way, so the UI cannot get stuck signed in because a network call failed.', file: 'js/auth.js' },
        { n: 2, actor: 'Store', action: 'SW.RemoteStore.reset()', detail: 'Clears the in-memory cache and unsubscribes from realtime. It never deletes rows.', file: 'js/remote-store.js' },
        { n: 3, actor: 'View', action: 'showAuthScreen()', detail: 'Re-gates the app.', file: 'js/app.js' },
      ],
      invariants: ['Signing out never destroys server data - only the local view of it.'],
      failureModes: [
        { case: 'The sign-out request fails', handling: 'The local session is cleared regardless; the user is not trapped in the app.' },
      ],
    },

    // ---------------- stage 3: form the group ----------------
    {
      id: 'create-group',
      stage: 'form-group',
      kind: 'branch',
      title: 'Create a group',
      trigger: 'The New group form is submitted.',
      purpose: 'Open a shared book and become its owner.',
      steps: [
        { n: 1, actor: 'View', action: 'Name and currency', detail: 'The member-names field is hidden in shared mode - members are accounts who join with a code.', file: 'js/app.js' },
        { n: 2, actor: 'Store', action: 'dispatch ADD_GROUP', detail: 'Optimistic: the group appears immediately with a temporary id.', file: 'js/remote-store.js' },
        { n: 3, actor: 'Database', action: 'create_group()', detail: 'Writes the group and the owner membership together, and generates the invite code server-side.', file: 'supabase/schema.sql' },
      ],
      invariants: [
        'The creator is always the owner - the function acts only on auth.uid() and takes no user id from the caller.',
        'A group and its owner row are created in one transaction; neither can exist without the other.',
      ],
      failureModes: [
        { case: 'Already owns 50 groups', handling: 'Refused with a plain message.' },
        { case: 'The write fails', handling: 'The optimistic group is removed and the banner explains.' },
      ],
    },
    {
      id: 'join-by-code',
      stage: 'form-group',
      kind: 'branch',
      title: 'Join with an invite code',
      trigger: '"Join with code", or opening an invite link.',
      purpose: 'The only way into somebody else\'s group.',
      steps: [
        { n: 1, actor: 'View', action: 'Code entered', detail: 'Pre-filled when arriving from an invite link.', file: 'js/app.js' },
        { n: 2, actor: 'Store', action: 'dispatch JOIN_GROUP', detail: 'Returns {ok:true, pending:true} and reports the true outcome via onResult - it cannot be optimistic.', file: 'js/remote-store.js' },
        { n: 3, actor: 'Database', action: 'join_group_by_code()', detail: 'Security definer, because the caller cannot select a group before belonging to it. Inserts only auth.uid().', file: 'supabase/schema.sql' },
        { n: 4, actor: 'Store', action: 'Fetch and merge', detail: 'Loads the group and its expenses and selects it.', file: 'js/remote-store.js' },
      ],
      invariants: ['A user can only ever add themselves, and only with a valid code.'],
      failureModes: [
        { case: 'Unknown code', handling: '"No group found for that invite code." The dialog stays open.' },
        { case: 'Already a member', handling: 'A harmless no-op.' },
      ],
    },
    {
      id: 'select-group',
      stage: 'form-group',
      kind: 'branch',
      title: 'Switch between groups',
      trigger: 'Clicking a group in the sidebar, or a ?g= link.',
      purpose: 'Change which book is on screen.',
      steps: [
        { n: 1, actor: 'Store', action: 'dispatch SELECT_GROUP', detail: 'Sets ui.currentGroupId.', file: 'js/store.js' },
        { n: 2, actor: 'Store', action: 'adoptCurrentUserFor()', detail: 'In demo mode, re-points "who am I" at a member of the new group. Without this the header shows one person while the state points at another and every share reads "not involved".', file: 'js/store.js' },
        { n: 3, actor: 'Router', action: 'goToGroup()', detail: 'Pushes a URL so the group is linkable and the back button works.', file: 'js/router.js' },
      ],
      invariants: ['ui.currentUserId is always a member of the selected group.'],
      failureModes: [{ case: 'Group not found', handling: 'Rejected; the view does not change.' }],
    },
    {
      id: 'rename-group',
      stage: 'form-group',
      kind: 'branch',
      title: 'Rename a group',
      trigger: 'The pencil icon on the group header.',
      purpose: 'Fix a name without rebuilding the group.',
      steps: [
        { n: 1, actor: 'View', action: 'In-app prompt dialog', detail: 'Replaced window.prompt, which could not be styled and was unpleasant on a phone.', file: 'js/app.js' },
        { n: 2, actor: 'Store', action: 'dispatch RENAME_GROUP', detail: 'Optimistic, with rollback on failure.', file: 'js/remote-store.js' },
      ],
      invariants: ['A group name is 1-80 characters, enforced by a database constraint as well as the form.'],
      failureModes: [{ case: 'Not permitted by row-level security', handling: 'Rolled back and reported.' }],
    },
    {
      id: 'delete-group',
      stage: 'form-group',
      kind: 'branch',
      title: 'Delete a group',
      trigger: 'The bin icon, then a type-the-name confirmation.',
      purpose: 'Remove a finished group and everything in it.',
      steps: [
        { n: 1, actor: 'View', action: 'Confirmation dialog', detail: 'States how many expenses will be destroyed and that it affects every member, and requires typing the group name. Focus starts on Cancel, never on the destructive button.', file: 'js/app.js' },
        { n: 2, actor: 'Store', action: 'dispatch DELETE_GROUP', detail: 'Optimistic, with a full snapshot kept for rollback.', file: 'js/remote-store.js' },
        { n: 3, actor: 'Database', action: 'delete_group()', detail: 'Owner only. Clears participants, expenses and memberships, then the group, in one transaction.', file: 'supabase/schema.sql' },
      ],
      invariants: ['Only the owner can delete. Nothing is left orphaned afterwards.'],
      failureModes: [
        { case: 'A non-owner attempts it', handling: 'Refused by the database and rolled back locally.' },
      ],
      edgeCases: [
        { case: 'Deletion is irreversible', handling: 'Softened rather than removed. The dialog still requires typing the group name, and now also offers to download a full copy first, so an irreversible act is at least a recoverable one for whoever takes the file. There is still no server-side undo.', status: 'handled' },
        { case: 'The removal guard could have blocked the cascade', handling: 'delete_group sets a transaction-local flag the guard checks. Disabling the trigger instead would have been table-wide, so somebody leaving a different group at that moment would have slipped past it.', status: 'handled' },
      ],
    },

    // ---------------- stage 4: assemble ----------------
    {
      id: 'invite-and-share',
      stage: 'assemble',
      kind: 'branch',
      title: 'Invite a friend',
      trigger: 'The Invite button on a group.',
      purpose: 'Get the code, or a link carrying it, to another person.',
      steps: [
        { n: 1, actor: 'View', action: 'openInviteModal()', detail: 'Shows the code and, when the router is available, a shareable link.', file: 'js/app.js' },
        { n: 2, actor: 'Router', action: 'inviteUrl(code)', detail: 'origin + pathname + ?join=<code>.', file: 'js/router.js' },
        { n: 3, actor: 'View', action: 'Copy', detail: 'Clipboard API with a spoken fallback if it is unavailable or blocked.', file: 'js/app.js' },
      ],
      invariants: ['The code shown is always the group\'s current code, so a rotated code is never handed out by mistake.'],
      failureModes: [{ case: 'Clipboard blocked', handling: 'The code is shown for manual copying instead of silently doing nothing.' }],
      edgeCases: [
        { case: 'The invite is a bare secret with no per-person tracking', handling: 'Closed. group_members records joined_via (created, or invite_code) alongside joined_at, groups records invite_code_rotated_at, and a members list shows who joined, when and how. The code is still shared rather than per-person, but its use is now visible and revocable.', status: 'handled' },
      ],
    },
    {
      id: 'rotate-invite-code',
      stage: 'assemble',
      kind: 'branch',
      title: 'Revoke an invite code',
      trigger: 'The owner rotates the code after it has been shared too widely.',
      purpose: 'Take back access that was handed out by a screenshot.',
      steps: [
        { n: 1, actor: 'Store', action: 'dispatch ROTATE_INVITE_CODE', detail: 'Reports the new code through onResult.', file: 'js/remote-store.js' },
        { n: 2, actor: 'Database', action: 'rotate_invite_code()', detail: 'Owner only; generates a fresh code and replaces the old one.', file: 'supabase/schema.sql' },
      ],
      invariants: [
        'The old code stops working the instant the new one is written.',
        'Codes are 10 characters drawn from gen_random_uuid(), not random(), because a code is an access secret and random() is a predictable PRNG.',
      ],
      failureModes: [{ case: 'A non-owner attempts it', handling: '"Only the group owner can change the invite code."' }],
    },
    {
      id: 'transfer-ownership',
      stage: 'assemble',
      kind: 'branch',
      title: 'Hand over a group',
      trigger: 'The owner transfers ownership to another member.',
      purpose: 'Let the owner leave without stranding the group.',
      steps: [
        { n: 1, actor: 'Store', action: 'dispatch TRANSFER_OWNERSHIP', detail: 'Reports through onResult.', file: 'js/remote-store.js' },
        { n: 2, actor: 'Database', action: 'transfer_ownership()', detail: 'Demotes the caller and promotes a named member, both of whom must already be in the group.', file: 'supabase/schema.sql' },
      ],
      invariants: ['There is exactly one owner before and after.'],
      failureModes: [
        { case: 'The target is not a member', handling: '"That person is not in this group."' },
        { case: 'A non-owner attempts it', handling: '"Only the current owner can hand over a group."' },
      ],
    },
    {
      id: 'leave-group',
      stage: 'assemble',
      kind: 'branch',
      title: 'Leave a group',
      trigger: 'A member removes their own membership.',
      purpose: 'Exit a group you are finished with.',
      steps: [
        { n: 1, actor: 'Database', action: 'guard_membership_removal()', detail: 'A before-delete trigger that refuses if the member appears in any expense, or if they are the last owner.', file: 'supabase/schema.sql' },
      ],
      invariants: [
        'Nobody can walk away from a debt: appearing in any expense blocks leaving.',
        'A group can never be left ownerless.',
      ],
      failureModes: [
        { case: 'They appear in an expense', handling: '"This person appears in an expense. Settle up and delete their expenses first, or delete the group."' },
        { case: 'They are the only owner', handling: '"You own this group. Hand ownership to someone else or delete the group."' },
      ],
    },
    {
      id: 'remove-member',
      stage: 'assemble',
      kind: 'branch',
      title: 'Remove somebody else',
      trigger: 'The owner removes a member.',
      purpose: 'Take out someone added by mistake.',
      steps: [
        { n: 1, actor: 'Store', action: 'dispatch REMOVE_MEMBER', detail: 'The local store calls the field memberId and the remote store userId; the view sends both so there is one call site.', file: 'js/app.js' },
        { n: 2, actor: 'Database', action: 'Delete policy plus the guard', detail: 'The policy allows removing yourself or, as owner, anyone; the trigger still refuses if they appear in an expense.', file: 'supabase/schema.sql' },
      ],
      invariants: ['The same debt guard applies however the removal is initiated.'],
      failureModes: [{ case: 'They appear in an expense', handling: 'Refused with the same message as leaving.' }],
    },
    {
      id: 'add-member-demo',
      stage: 'assemble',
      kind: 'branch',
      title: 'Add a member by name (demo only)',
      trigger: 'The "+ Member" button, which only appears in demo mode.',
      purpose: 'Let the demo have several people without inventing accounts.',
      steps: [
        { n: 1, actor: 'Store', action: 'dispatch ADD_MEMBER', detail: 'Local store only. In shared mode the same action returns "Members join with an invite code."', file: 'js/store.js' },
      ],
      invariants: ['In shared mode a member is always a real account.'],
      failureModes: [{ case: 'Dispatched in shared mode', handling: 'Refused with an explanation rather than silently ignored.' }],
    },

    // ---------------- stage 5: record ----------------
    {
      id: 'add-expense',
      stage: 'record',
      kind: 'branch',
      title: 'Add an expense',
      trigger: 'The Add expense form is submitted, or "n" is pressed.',
      purpose: 'Record one payment and how it divides.',
      steps: [
        { n: 1, actor: 'Model', action: 'parseAmount()', detail: 'Text to integer cents; null when it is not a number.', file: 'js/model.js' },
        { n: 2, actor: 'Model', action: 'validateExpense()', detail: 'Description, positive amount, payer in the group, at least one participant, no duplicates, and the mode rules via splitExpense.', file: 'js/model.js' },
        { n: 3, actor: 'Store', action: 'Optimistic apply', detail: 'Cached, rendered and returned {ok:true} synchronously.', file: 'js/remote-store.js' },
        { n: 4, actor: 'Database', action: 'create_expense()', detail: 'Re-validates and writes both tables in one transaction.', file: 'supabase/schema.sql' },
      ],
      invariants: ['The shares always add up to the amount, in both layers.'],
      failureModes: [
        { case: 'Amount does not parse', handling: 'amountCents is null and validateExpense refuses; nothing is sent.' },
        { case: 'The server rejects it', handling: 'The optimistic row is removed and the banner shows the server\'s reason.' },
      ],
    },
    {
      id: 'split-calculation',
      stage: 'record',
      kind: 'branch',
      title: 'Divide the amount',
      trigger: 'Any time shares must be derived - the live preview, and every balance calculation.',
      purpose: 'Turn an amount plus a mode plus participants into whole cents that add up exactly.',
      steps: [
        { n: 1, actor: 'Model', action: 'Reduce to weights', detail: 'Equal is all ones; shares and percent use the given values; exact is already in cents.', file: 'js/model.js' },
        { n: 2, actor: 'Model', action: 'allocateLargestRemainder()', detail: 'Everyone gets their floor; leftover cents go one each to the largest fractional remainders, ties by input order.', file: 'js/model.js' },
      ],
      invariants: [
        'sum(shares) === amountCents, in all four modes.',
        'Deterministic: the same input always produces the same division.',
      ],
      failureModes: [
        { case: 'Non-finite or negative values', handling: 'Rejected before any allocation.' },
        { case: 'Percentages off by more than the tolerance', handling: 'Rejected with the actual sum.' },
      ],
      edgeCases: [
        { case: 'Exact mode used to round each value on its own', handling: 'Fixed: all four modes now share one allocator. Previously 1.00 split as 33.5/33.5/33 paid out 1.01 and broke the zero-sum invariant.', status: 'handled' },
      ],
    },
    {
      id: 'edit-expense',
      stage: 'record',
      kind: 'branch',
      title: 'Edit an expense',
      trigger: 'The pencil icon on an expense row.',
      purpose: 'Correct a wrong amount, payer or split.',
      steps: [
        { n: 1, actor: 'View', action: 'Modal in edit mode', detail: 'Pre-filled from the stored expense, keyed by ui.editingExpenseId.', file: 'js/app.js' },
        { n: 2, actor: 'Store', action: 'dispatch UPDATE_EXPENSE', detail: 'Optimistic, keeping the previous version for rollback.', file: 'js/remote-store.js' },
        { n: 3, actor: 'Database', action: 'update_expense()', detail: 'Re-validates, and refuses if updated_at does not match the version the editor started from.', file: 'supabase/schema.sql' },
      ],
      invariants: ['An edit either applies completely or not at all - the expense and its participants move together.'],
      failureModes: [
        { case: 'Someone else edited it first', handling: '"Somebody else changed this expense while you were editing it. Reload and try again."' },
        { case: 'The expense was deleted meanwhile', handling: '"That expense no longer exists."' },
      ],
    },
    {
      id: 'delete-expense',
      stage: 'record',
      kind: 'branch',
      title: 'Delete an expense, with undo',
      trigger: 'The bin icon on an expense row.',
      purpose: 'Remove a mistake without a confirmation dialog for every small thing.',
      steps: [
        { n: 1, actor: 'Store', action: 'dispatch DELETE_EXPENSE', detail: 'Optimistic removal.', file: 'js/remote-store.js' },
        { n: 2, actor: 'View', action: 'Undo toast', detail: 'Re-adds the expense through the normal create path if pressed.', file: 'js/app.js' },
      ],
      invariants: ['Undo reports honestly: it says "Restored" only when the restore actually succeeded.'],
      failureModes: [
        { case: 'The restore fails validation', handling: 'For example a participant left the group meanwhile. The real error is shown instead of a false "Restored".' },
      ],
      edgeCases: [
        { case: 'Undo does not restore the original record', handling: 'Closed. The original createdAt is passed back through, so a restored expense returns to its place in the list instead of reappearing at the top as if it were new.', status: 'handled' },
        { case: 'The undo lives in a toast', handling: 'Closed. Everything deleted also goes to a Recently deleted list in the Data menu, restorable long after the toast has gone. It is per-session and in memory - not a server-side trash - and the dialog says so.', status: 'handled' },
      ],
    },
    {
      id: 'validation-rejection',
      stage: 'record',
      kind: 'branch',
      title: 'A write is refused',
      trigger: 'Any invalid expense, in the browser or at the database.',
      purpose: 'Refuse bad data in a way that tells the person what to change.',
      steps: [
        { n: 1, actor: 'Model', action: 'validateExpense()', detail: 'Fast, local, and phrased for a person.', file: 'js/model.js' },
        { n: 2, actor: 'Database', action: 'assert_expense_valid()', detail: 'The authority. Runs on create and update, and cannot be bypassed by talking to the API directly.', file: 'supabase/schema.sql' },
        { n: 3, actor: 'View', action: 'Message plus banner', detail: 'Inline in the form when it is a form error; a persistent banner when a background write failed.', file: 'js/app.js' },
      ],
      invariants: ['The client and the database enforce the same rules; the client exists for speed and tone, not for safety.'],
      failureModes: [
        { case: 'Only the client had validated', handling: 'That was the situation until recently: the API accepted a 100.00 expense split into 10.00 + 20.00. The rules now live in the database.' },
      ],
    },
    {
      id: 'edit-conflict',
      stage: 'record',
      kind: 'branch',
      title: 'Two people edit at once',
      trigger: 'Two members submit edits to the same expense.',
      purpose: 'Refuse the second write rather than letting it silently erase the first.',
      steps: [
        { n: 1, actor: 'Store', action: 'Send the version seen', detail: 'The updated_at the editor loaded is sent as p_expected_updated_at.', file: 'js/remote-store.js' },
        { n: 2, actor: 'Database', action: 'Compare and refuse', detail: 'A mismatch raises rather than overwriting.', file: 'supabase/schema.sql' },
        { n: 3, actor: 'View', action: 'Roll back and explain', detail: 'The optimistic change reverts and the banner asks the user to reload.', file: 'js/app.js' },
      ],
      invariants: ['An edit is only ever applied on top of the version its author actually saw.'],
      failureModes: [
        { case: 'Realtime has not yet delivered the other change', handling: 'The refusal still fires; the check is on the server, not on what the client happens to know.' },
      ],
    },

    // ---------------- stages 6-8 ----------------
    {
      id: 'compute-balances',
      stage: 'reconcile',
      kind: 'branch',
      title: 'Compute balances',
      trigger: 'Every render of a group, and every integrity check.',
      purpose: 'Reduce a list of expenses to one number per person.',
      steps: [
        { n: 1, actor: 'Model', action: 'Seed every member at zero', detail: 'So people with no activity still appear.', file: 'js/model.js' },
        { n: 2, actor: 'Model', action: 'Credit the payer, debit the shares', detail: 'For every expense and settlement in the group.', file: 'js/model.js' },
      ],
      invariants: ['The values always sum to exactly zero.', 'A record that cannot be split is skipped whole, never half-applied.'],
      failureModes: [{ case: 'A malformed record', handling: 'Skipped, and surfaced by the admin integrity check as counted-but-not-applied.' }],
    },
    {
      id: 'simplify-debts',
      stage: 'minimise',
      kind: 'branch',
      title: 'Minimise the number of payments',
      trigger: 'Rendering the suggested settlements.',
      purpose: 'Fewest transfers that clear every balance.',
      steps: [
        { n: 1, actor: 'Model', action: 'Sort and match', detail: 'Largest creditor against largest debtor, transfer the smaller magnitude, drop anyone at zero, repeat.', file: 'js/model.js' },
      ],
      invariants: ['At most n-1 transfers.', 'Applying them all zeroes everyone.'],
      failureModes: [{ case: 'All balances already zero', handling: 'Returns an empty list and the panel says everyone is settled.' }],
    },
    {
      id: 'settle-up',
      stage: 'settle',
      kind: 'branch',
      title: 'Record a settlement',
      trigger: 'The Settle up form.',
      purpose: 'Log a real payment between two people.',
      steps: [
        { n: 1, actor: 'Store', action: 'dispatch ADD_SETTLEMENT', detail: 'Becomes an expense of type "settlement" with the receiver as the only participant.', file: 'js/remote-store.js' },
        { n: 2, actor: 'Database', action: 'create_expense()', detail: 'The same validated path as any expense.', file: 'supabase/schema.sql' },
      ],
      invariants: ['A settlement changes exactly two balances.'],
      failureModes: [{ case: 'Payer and receiver are the same person', handling: 'Refused - it would be a no-op record.' }],
    },
    {
      id: 'record-suggested',
      stage: 'settle',
      kind: 'branch',
      title: 'Record a suggested settlement',
      trigger: 'The Record button beside a suggestion.',
      purpose: 'Turn the computed suggestion into a stored fact in one click.',
      steps: [
        { n: 1, actor: 'View', action: 'Recompute, then dispatch', detail: 'The suggestions are recomputed at click time so a stale index cannot record the wrong payment.', file: 'js/app.js' },
      ],
      invariants: ['Recording every suggestion in turn leaves the group at all zeroes.'],
      failureModes: [{ case: 'Balances changed since the render', handling: 'The recomputation means the button acts on current data, not on what was on screen.' }],
    },

    // ---------------- cross-cutting ----------------
    {
      id: 'persistence',
      stage: null,
      kind: 'cross-cutting',
      title: 'Where the data lives',
      trigger: 'Every successful mutation.',
      purpose: 'Keep the books after the tab closes.',
      steps: [
        { n: 1, actor: 'Store', action: 'localStorage (demo)', detail: 'The whole state as JSON under splitwise.state.v1, every access guarded.', file: 'js/store.js' },
        { n: 2, actor: 'Store', action: 'Supabase (shared)', detail: 'Rows in Postgres; the client keeps a cache and reconciles against it.', file: 'js/remote-store.js' },
      ],
      invariants: ['A corrupt or unsupported stored blob is rejected rather than allowed to half-load.'],
      failureModes: [
        { case: 'Storage full or disabled', handling: 'Caught; the session continues in memory.' },
        { case: 'A newer state version', handling: 'Rejected, falling back to demo data. There is no migration path.' },
      ],
    },
    {
      id: 'optimistic-writes',
      stage: null,
      kind: 'cross-cutting',
      title: 'Optimistic writes and rollback',
      trigger: 'Every mutating action in shared mode.',
      purpose: 'Feel instant on a slow connection without lying about what was saved.',
      steps: [
        { n: 1, actor: 'Store', action: 'Validate, apply, notify, return', detail: 'All synchronous, so the view updates in the same frame.', file: 'js/remote-store.js' },
        { n: 2, actor: 'Store', action: 'Write in the background', detail: 'Then reconcile the temporary id, or roll the cache back and report.', file: 'js/remote-store.js' },
      ],
      invariants: ['The cache never keeps something the server rejected.'],
      failureModes: [
        { case: 'The rollback happens after the user has moved on', handling: 'The banner persists rather than a toast, so the failure is still visible later.' },
      ],
      edgeCases: [
        { case: 'dispatch() reports "ok" before the server has agreed', handling: 'Deliberate, and the reason joining had to be excluded from it: for an action that cannot be applied locally, an immediate "ok" is a lie. Joining reports through a callback instead.', status: 'handled' },
      ],
    },
    {
      id: 'realtime-sync',
      stage: null,
      kind: 'cross-cutting',
      title: 'Seeing a friend\'s changes',
      trigger: 'Any row change in a group you belong to.',
      purpose: 'Two people on the same trip should not have to refresh.',
      steps: [
        { n: 1, actor: 'Store', action: 'Subscribe', detail: 'One channel across expenses, participants, memberships and groups.', file: 'js/remote-store.js' },
        { n: 2, actor: 'Store', action: 'Debounced refetch', detail: 'Roughly 300ms, so a burst of related row events causes one refetch.', file: 'js/remote-store.js' },
      ],
      invariants: ['Realtime is subject to the same row-level security as any read; it cannot leak another group.'],
      failureModes: [{ case: 'The socket drops', handling: 'The client reconnects; a reload always recovers.' }],
      edgeCases: [
        { case: 'A refetch mid-edit', handling: 'Closed. A re-render now captures and restores keyboard focus and text selection, not just scroll position, so a change arriving from a friend over realtime no longer throws away what you were typing.', status: 'handled' },
      ],
    },
    {
      id: 'security-model',
      stage: null,
      kind: 'cross-cutting',
      title: 'Who can see and write what',
      trigger: 'Every request, without exception.',
      purpose: 'One group\'s finances must be invisible to everyone outside it.',
      steps: [
        { n: 1, actor: 'Database', action: 'is_group_member()', detail: 'A security definer helper, so a policy on group_members does not recurse into itself.', file: 'supabase/schema.sql' },
        { n: 2, actor: 'Database', action: 'Policies per table', detail: 'Reads gated on membership; writes to expenses only through validated functions.', file: 'supabase/schema.sql' },
        { n: 3, actor: 'Tests', action: 'tests/rls.test.js', detail: 'Runs the real schema against Postgres compiled to WebAssembly and attacks it as owner, friend and stranger.', file: 'tests/rls.test.js' },
      ],
      invariants: [
        'A stranger sees zero rows in every table - not a filtered view, nothing at all.',
        'Nobody can self-promote to owner or add somebody else to a group.',
        'The publishable key is safe in client code only because these policies constrain it.',
      ],
      failureModes: [
        { case: 'A permissive self-insert on group_members', handling: 'Removed. It let anyone holding a group UUID add themselves with no invite code. It hid from testing because a RETURNING clause needs read rights and failed first, making the attack look blocked.' },
      ],
    },
    {
      id: 'language',
      stage: null,
      kind: 'cross-cutting',
      title: 'English and German',
      trigger: 'The EN/DE control, or the browser language on first visit.',
      purpose: 'A German friend should not meet an English sign-up form.',
      steps: [
        { n: 1, actor: 'Presentation', action: 'SW.I18n.t()', detail: '204 keys per language, full parity, with a fallback chain that never renders "undefined".', file: 'js/i18n.js' },
        { n: 2, actor: 'Presentation', action: 'applyStatic()', detail: 'Walks data-i18n attributes for markup that is not re-rendered.', file: 'js/i18n.js' },
        { n: 3, actor: 'View', action: 'Re-render on change', detail: 'Money becomes "12,50 €" and dates "3. Sep 2026" in German.', file: 'js/app.js' },
      ],
      invariants: [
        'Formatting is a display concern only: SW.Model.formatMoney and the cent arithmetic are untouched by language.',
        'A missing key falls back to English, then to the key itself, rather than throwing.',
      ],
      failureModes: [{ case: 'localStorage unavailable', handling: 'The choice simply does not persist.' }],
      edgeCases: [
        { case: 'The admin console is English only', handling: 'Deliberate. It is developer documentation, not something a friend will open.', status: 'handled' },
        { case: 'Error text from Supabase and from js/model.js', handling: 'Closed. The error messages a person is actually likely to hit are mapped into the active language. Anything unrecognised passes through in English rather than being swallowed - a mystery sentence beats a silent failure.', status: 'handled' },
      ],
    },
    {
      id: 'import-export',
      stage: null,
      kind: 'cross-cutting',
      title: 'Export and import (demo only)',
      trigger: 'The Data menu.',
      purpose: 'Get demo data out, and back in.',
      steps: [
        { n: 1, actor: 'Store', action: 'exportJSON()', detail: 'The whole state, pretty-printed, downloaded as a file.', file: 'js/store.js' },
        { n: 2, actor: 'Store', action: 'importJSON()', detail: 'Validates the shape and version before replacing anything.', file: 'js/store.js' },
      ],
      invariants: ['A malformed file can never partially overwrite good data.'],
      failureModes: [{ case: 'Attempted in shared mode', handling: 'Refused - the data is not yours alone.' }],
      edgeCases: [
        { case: 'Shared data cannot be exported', handling: 'This was documentation error, not a missing feature: export was never gated to demo mode and has always worked for shared groups. Only import, reset and load-demo are demo-only, because those overwrite data that is not yours alone.', status: 'handled' },
      ],
    },
    {
      id: 'admin-console',
      stage: null,
      kind: 'cross-cutting',
      title: 'This console',
      trigger: 'Opening admin.html and entering the demo code.',
      purpose: 'Show the app\'s own logic, and check that the live data still obeys it.',
      steps: [
        { n: 1, actor: 'Admin', action: 'Demo gate', detail: 'The code is 123, checked in the browser. The page states plainly that this is not security.', file: 'js/admin.js' },
        { n: 2, actor: 'Admin', action: 'Render from SW.Workflows', detail: 'Every diagram is generated from this file, so the documentation cannot drift from itself.', file: 'js/admin.js' },
        { n: 3, actor: 'Admin', action: 'Integrity checks', detail: 'Genuinely re-run against live state: balances sum to zero, no record skipped, no orphans, no duplicate ids.', file: 'js/admin.js' },
      ],
      invariants: ['The integrity checks can actually fail - verified by pointing them at deliberately corrupted data.'],
      failureModes: [{ case: 'SW.Workflows missing a field', handling: 'Degrades to a muted message rather than throwing.' }],
      edgeCases: [
        { case: 'The gate is cosmetic', handling: 'The code is readable in the source and bypassable in dev tools. It keeps a casual visitor out of a documentation page; it protects nothing. Live state shown here is only ever the viewer\'s own data, which row-level security already governs.', status: 'known-gap' },
        { case: 'The activity feed is reconstructed, not recorded', handling: 'Closed. expense_history is a real, append-only record written by the database, so the feed reflects what actually happened rather than being inferred from current rows.', status: 'handled' },
      ],
    },
  ];

  // =======================================================================
  // Data model
  // =======================================================================

  var DATA_MODEL = [
    {
      entity: 'profiles (db)',
      fields: [
        { name: 'id', type: 'uuid', note: 'Primary key, references auth.users.' },
        { name: 'email', type: 'text', note: 'Copied from the auth user by a trigger.' },
        { name: 'display_name', type: 'text', note: 'From full_name in the sign-up metadata. Not unique - see the identity gap.' },
        { name: 'avatar_url', type: 'text', note: 'Unused by the current UI; initials are shown instead.' },
      ],
      relations: ['one per auth user', 'visible to anyone sharing a group with them'],
    },
    {
      entity: 'groups (db)',
      fields: [
        { name: 'id', type: 'uuid', note: 'Primary key.' },
        { name: 'name', type: 'text', note: '1-80 characters, constrained in the database.' },
        { name: 'currency', type: 'text', note: 'EUR, USD, GBP or CHF. Fixed at creation.' },
        { name: 'invite_code', type: 'text', note: 'Unique, 10 characters from a cryptographic source. Rotatable by the owner.' },
        { name: 'created_by', type: 'uuid', note: 'Always auth.uid() - the function takes no caller-supplied id.' },
      ],
      relations: ['has many group_members', 'has many expenses'],
    },
    {
      entity: 'group_members (db)',
      fields: [
        { name: 'group_id', type: 'uuid', note: 'Part of the composite key.' },
        { name: 'user_id', type: 'uuid', note: 'Part of the composite key, so a duplicate join is impossible.' },
        { name: 'role', type: 'text', note: 'owner or member. Owner rows are only ever written by create_group or transfer_ownership.' },
      ],
      relations: ['joins profiles to groups', 'the sole basis for every visibility decision'],
    },
    {
      entity: 'expenses (db)',
      fields: [
        { name: 'id', type: 'uuid', note: 'Primary key.' },
        { name: 'type', type: 'text', note: 'expense or settlement - both flow through the same arithmetic.' },
        { name: 'amount_cents', type: 'bigint', note: 'Positive, capped below the point where JavaScript loses integer precision.' },
        { name: 'paid_by', type: 'uuid', note: 'Must be a member, enforced by assert_expense_valid.' },
        { name: 'split_mode', type: 'text', note: 'equal, exact, percent or shares.' },
        { name: 'date', type: 'date', note: 'Constrained to a sane window.' },
        { name: 'updated_at', type: 'timestamptz', note: 'Maintained by a trigger; carried by the client for conflict detection.' },
      ],
      relations: ['belongs to a group', 'has many expense_participants', 'writable only through create_expense / update_expense'],
    },
    {
      entity: 'expense_participants (db)',
      fields: [
        { name: 'expense_id', type: 'uuid', note: 'Part of the composite key.' },
        { name: 'user_id', type: 'uuid', note: 'Part of the composite key, so nobody can appear twice.' },
        { name: 'value', type: 'numeric', note: 'Meaning depends on split_mode: cents for exact, a percentage, a share count, or ignored for equal.' },
      ],
      relations: ['belongs to an expense', 'written only inside the validated functions'],
    },
    {
      entity: 'State (client)',
      fields: [
        { name: 'groups', type: 'Group[]', note: 'Each with members embedded, so the view needs no joins.' },
        { name: 'expenses', type: 'Expense[]', note: 'camelCase mirror of the rows; settlements included.' },
        { name: 'activity', type: 'ActivityItem[]', note: 'Real in demo mode; reconstructed in shared mode.' },
        { name: 'ui', type: '{currentGroupId, currentUserId}', note: 'In shared mode currentUserId is always the signed-in account.' },
      ],
      relations: ['identical shape from both stores, which is what lets the view ignore which one is active'],
    },
  ];

  // =======================================================================
  // Algorithms
  // =======================================================================

  var ALGORITHMS = [
    {
      id: 'largest-remainder',
      name: 'Largest-remainder cent allocation',
      problem:
        'Dividing an amount that does not divide evenly. 10.00 between three ' +
        'people is 3.3333… each, and cents are indivisible - so somebody has to ' +
        'get the extra cent, and the total must still come out at 10.00.',
      approach:
        'Give everyone the floor of their exact share, then hand the leftover ' +
        'cents out one at a time to whoever lost the most to flooring, ties broken ' +
        'by input order. Every split mode funnels through this one function, ' +
        'including exact mode - rounding each value separately is what previously ' +
        'let a split of 1.00 pay out 1.01.',
      complexity: 'O(n log n), dominated by sorting the remainders.',
      pseudocode:
        'raw[i]    = amountCents * weight[i] / totalWeight\n' +
        'floors[i] = floor(raw[i])\n' +
        'remainder = amountCents - sum(floors)\n' +
        'order     = indices sorted by (raw[i] - floors[i]) descending, ties by i\n' +
        'for k in 0 .. remainder-1:\n' +
        '    floors[order[k]] += 1\n' +
        'return floors            // sums to exactly amountCents',
      worked_example:
        '10.00 three ways: raw = 333.33 each, floors = 333/333/333 = 999, ' +
        'remainder = 1 cent, all three fractions are equal so the tie goes to the ' +
        'first participant. Result 3.34 / 3.33 / 3.33 = 10.00 exactly. Verified by ' +
        'fuzzing 20,000 random splits across all four modes with no cent lost or invented.',
    },
    {
      id: 'min-cash-flow',
      name: 'Greedy minimum cash flow',
      problem:
        'Six people owing each other in a tangle should not mean fifteen ' +
        'transfers. Given each person\'s net balance, find a short list of payments ' +
        'that clears everyone.',
      approach:
        'Repeatedly match the largest creditor with the largest debtor and move ' +
        'the smaller of the two amounts. One party hits zero and drops out each ' +
        'round, so at most n-1 transfers are produced. Ordering is fixed - amount ' +
        'descending, ties by member id - so the same balances always produce the ' +
        'same suggestions on every device.',
      complexity: 'O(n^2 log n) worst case; n is the size of a friend group.',
      pseudocode:
        'people = [{id, amount}] where amount != 0\n' +
        'while people is not empty:\n' +
        '    sort by amount descending, ties by id ascending\n' +
        '    creditor = people[0]\n' +
        '    debtor   = people[last]\n' +
        '    if creditor.amount <= 0 or debtor.amount >= 0: break\n' +
        '    amount = min(creditor.amount, -debtor.amount)\n' +
        '    emit transfer debtor -> creditor of amount\n' +
        '    creditor.amount -= amount; debtor.amount += amount\n' +
        '    drop anyone now at zero\n' +
        'return transfers          // at most n-1',
      worked_example:
        'A:+2000, B:-1000, C:-1000. Round 1: creditor A; sorting ties ascending by ' +
        'id puts B before C, and the debtor is the LAST entry, so C is picked. C ' +
        'pays A 1000 and drops out. Round 2: A:+1000, B:-1000, B pays A 1000. Two ' +
        'transfers for three people. Verified against the real function: ' +
        '[{from:C,to:A,1000},{from:B,to:A,1000}].',
    },
    {
      id: 'optimistic-write',
      name: 'Optimistic write with rollback',
      problem:
        'A shared backend means every change is a network round trip. Waiting for ' +
        'the server before showing anything makes the app feel broken on a train; ' +
        'showing it and never checking makes the app lie.',
      approach:
        'Validate locally, apply to the cache, notify the view and return success ' +
        'synchronously - then write in the background. On success reconcile the ' +
        'temporary id with the server id. On failure restore the pre-change ' +
        'snapshot, notify again, and raise a persistent banner. The exception is ' +
        'any action whose outcome cannot be known locally - joining by code - ' +
        'which reports through a callback instead of claiming success.',
      complexity: 'O(1) per action locally; one round trip in the background.',
      pseudocode:
        'result = validateLocally(action)\n' +
        'if not result.ok: return result          // nothing touched\n' +
        'snapshot = deepClone(affected slice of state)\n' +
        'applyToCache(action); notify(); \n' +
        'server.write(action)\n' +
        '  .then(row => { reconcileIds(row); status("saved") })\n' +
        '  .catch(err => { restore(snapshot); notify(); banner(err) })\n' +
        'return {ok: true}                        // synchronous',
      worked_example:
        'Adding an expense offline: it appears instantly, the write fails, the row ' +
        'is removed again and the banner says it was not saved. Nothing is queued ' +
        'for retry - which is a known gap, but the user is told rather than left ' +
        'believing it saved.',
    },
  ];

  // =======================================================================
  // State machine
  // =======================================================================

  var STATE_MACHINE = {
    states: [
      { id: 'boot', label: 'Booting' },
      { id: 'demo', label: 'Demo mode (local)' },
      { id: 'signed_out', label: 'Signed out' },
      { id: 'recovering', label: 'Password recovery' },
      { id: 'loading', label: 'Loading groups' },
      { id: 'ready', label: 'Ready (shared)' },
      { id: 'modal_open', label: 'Dialog open' },
      { id: 'saving', label: 'Saving' },
      { id: 'save_failed', label: 'Save failed' },
      { id: 'settled', label: 'All settled up' },
    ],
    transitions: [
      { from: 'boot', to: 'demo', on: 'no backend configured, or unreachable' },
      { from: 'boot', to: 'signed_out', on: 'backend configured, no session' },
      { from: 'boot', to: 'loading', on: 'session restored' },
      { from: 'boot', to: 'recovering', on: 'arrived from a password-reset link' },
      { from: 'signed_out', to: 'demo', on: '"Try the demo without an account"' },
      { from: 'signed_out', to: 'loading', on: 'sign-in or sign-up succeeds' },
      { from: 'recovering', to: 'loading', on: 'new password set' },
      { from: 'loading', to: 'ready', on: 'groups and expenses loaded' },
      { from: 'loading', to: 'save_failed', on: 'the load fails' },
      { from: 'ready', to: 'modal_open', on: 'add expense, settle up, invite, join, confirm' },
      { from: 'modal_open', to: 'ready', on: 'submit, cancel or Escape' },
      { from: 'ready', to: 'saving', on: 'any mutating action' },
      { from: 'saving', to: 'ready', on: 'the server accepts' },
      { from: 'saving', to: 'save_failed', on: 'the server refuses; the cache rolls back' },
      { from: 'save_failed', to: 'ready', on: 'a later write succeeds, or the banner is dismissed' },
      { from: 'ready', to: 'settled', on: 'every balance in the group reaches zero' },
      { from: 'settled', to: 'ready', on: 'a new expense is added' },
      { from: 'ready', to: 'signed_out', on: 'sign out' },
      { from: 'demo', to: 'signed_out', on: 'the sign-in screen is opened' },
    ],
  };

  return {
    ARCHITECTURE: ARCHITECTURE,
    JOURNEY: JOURNEY,
    LIST: LIST,
    DATA_MODEL: DATA_MODEL,
    ALGORITHMS: ALGORITHMS,
    STATE_MACHINE: STATE_MACHINE,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SW.Workflows;
}
