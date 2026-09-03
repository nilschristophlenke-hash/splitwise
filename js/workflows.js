// js/workflows.js
//
// SW.Workflows - a structured, in-code description of how this app
// actually works: its architecture, data model, workflows, algorithms
// and conceptual state machine. It is consumed only by admin.js to
// render the "Overview / Workflows / Data model / Algorithms / State
// machine" sections of the admin console - it has no effect on the app
// itself.
//
// This file is written LAST, after js/model.js and js/store.js exist, so
// that everything below describes real, tested behaviour rather than
// intentions. If you change model.js or store.js, update this file too.

var SW = SW || {};

SW.Workflows = (function () {
  'use strict';

  // =========================================================================
  // ARCHITECTURE
  // =========================================================================

  var ARCHITECTURE = {
    summary:
      "Nils' Splitwise clone is a single-page vanilla-JS app with a strict one-way data " +
      'flow: views dispatch actions into SW.Store, SW.Store validates and applies them ' +
      '(delegating all money math to SW.Model), persists the result to localStorage, and ' +
      'notifies subscribers, which re-render. SW.Model is pure and has zero dependencies ' +
      'on the DOM or storage, so its logic is unit-tested directly in Node with no build ' +
      'step or framework; SW.Workflows is this separate, hand-written registry that the ' +
      'admin console renders to document how all of the above actually behaves.',
    layers: [
      {
        name: 'View - main app',
        files: ['index.html', 'css/styles.css', 'js/app.js'],
        responsibility:
          'Renders the sidebar, group view, modals and toasts from state; collects user ' +
          'input; dispatches actions. Never reads/writes localStorage and never mutates ' +
          'state objects directly - it only calls SW.Model and SW.Store.',
      },
      {
        name: 'View - admin console',
        files: ['admin.html', 'css/admin.css', 'js/admin.js'],
        responsibility:
          'A read-only introspection UI behind a client-side demo password gate. Renders ' +
          'SW.Workflows (this file) as documentation, and SW.Store.getState() plus ' +
          'SW.Model as live data - counts, balances, and integrity checks.',
      },
      {
        name: 'Store',
        files: ['js/store.js'],
        responsibility:
          'The single source of truth. Holds state in memory, exposes dispatch(action) ' +
          'to validate and apply changes, persists to localStorage after every successful ' +
          'mutation, and calls subscribers with a fresh, immutable-ish snapshot.',
      },
      {
        name: 'Model',
        files: ['js/model.js'],
        responsibility:
          'Pure, dependency-free functions: amount parsing/formatting, split calculation ' +
          '(largest-remainder), balance computation, and debt simplification (greedy ' +
          'min-cash-flow). No DOM, no storage - safe to require() and unit test in Node.',
      },
      {
        name: 'Workflows registry',
        files: ['js/workflows.js'],
        responsibility:
          "This file. A data description of the app's own workflows, data model and " +
          'algorithms, consumed only by the admin console for documentation purposes.',
      },
      {
        name: 'Persistence',
        files: ['localStorage'],
        responsibility:
          "Browser key/value storage under the key 'splitwise.state.v1'. Every read and " +
          'write is wrapped in try/catch by SW.Store, since private-browsing modes and ' +
          'quota limits can throw, and the key does not exist at all in Node.',
      },
    ],
    principles: [
      'Single source of truth in SW.Store - views never read or write localStorage directly.',
      'Money is always an integer number of cents; floats only ever appear transiently as ' +
        'split weights (percent values, share counts) on the way into splitExpense().',
      'SW.Model is pure and DOM-free, so its logic is unit-testable in plain Node with no framework.',
      'SW.Store.dispatch never throws - it always returns {ok:true, ...} or {ok:false, error}.',
      'Every successful mutating dispatch appends a human-readable ActivityItem.',
      'getState() hands out a deep copy (structuredClone, or a JSON round-trip fallback), ' +
        'never a live reference, so a view cannot accidentally corrupt the store.',
      'Deterministic algorithms (largest-remainder split, greedy min-cash-flow) so the same ' +
        'input always produces the same output - which is exactly what makes them testable.',
    ],
  };

  // =========================================================================
  // DATA_MODEL
  // =========================================================================

  var DATA_MODEL = [
    {
      entity: 'State (root)',
      fields: [
        { name: 'version', type: 'number', note: 'Schema version, currently 1. IMPORT_STATE rejects anything else.' },
        { name: 'groups', type: 'Group[]', note: 'Every group the user is part of.' },
        { name: 'expenses', type: 'Expense[]', note: 'Every expense AND settlement, across all groups.' },
        { name: 'activity', type: 'ActivityItem[]', note: 'A flat, newest-first human-readable log.' },
        { name: 'ui', type: '{ currentGroupId, currentUserId }', note: 'Transient view state, persisted along with the rest.' },
      ],
      relations: ['has many Group', 'has many Expense', 'has many ActivityItem'],
    },
    {
      entity: 'Group',
      fields: [
        { name: 'id', type: 'string', note: '"g_" + 8 random base36 chars.' },
        { name: 'name', type: 'string', note: 'e.g. "Lisbon Flat".' },
        { name: 'currency', type: 'string', note: 'e.g. "EUR" - drives the symbol used by formatMoney.' },
        { name: 'members', type: 'Member[]', note: 'Embedded array, not a separate top-level collection.' },
        { name: 'createdAt', type: 'number', note: 'Milliseconds since epoch.' },
      ],
      relations: ['has many Member (embedded)', 'has many Expense (linked by expense.groupId)'],
    },
    {
      entity: 'Member',
      fields: [
        { name: 'id', type: 'string', note: '"m_" + 8 random base36 chars.' },
        { name: 'name', type: 'string', note: 'Display name, e.g. "Nils".' },
      ],
      relations: ['embedded inside exactly one Group.members array'],
    },
    {
      entity: 'Expense',
      fields: [
        { name: 'id', type: 'string', note: '"e_" + 8 random base36 chars. Shared id space with settlements.' },
        { name: 'groupId', type: 'string', note: 'References Group.id.' },
        { name: 'type', type: '"expense" | "settlement"', note: 'A settlement is an Expense with a fixed shape (see below).' },
        { name: 'description', type: 'string', note: 'e.g. "Groceries", or "Mara paid Nils" for a settlement.' },
        { name: 'amountCents', type: 'integer', note: 'Always the whole amount, in cents. Never a float.' },
        { name: 'paidBy', type: 'string', note: 'References a Group.members[].id.' },
        { name: 'splitMode', type: '"equal"|"exact"|"percent"|"shares"', note: 'How amountCents is divided among participants.' },
        { name: 'participants', type: '{memberId, value}[]', note: 'value means shareCents (exact), percentage (percent), share count (shares), or is ignored (equal).' },
        { name: 'category', type: 'string', note: 'general|food|rent|transport|fun|utilities|travel.' },
        { name: 'date', type: 'string', note: 'ISO date, e.g. "2026-09-03".' },
        { name: 'createdAt', type: 'number', note: 'Milliseconds since epoch, used for tie-breaking display order.' },
        { name: 'note', type: 'string', note: 'Optional free-text note.' },
      ],
      relations: [
        'belongs to one Group (groupId)',
        'paidBy references a Group.members entry',
        'each participants[].memberId references a Group.members entry',
      ],
    },
    {
      entity: 'ActivityItem',
      fields: [
        { name: 'id', type: 'string', note: '"a_" + 8 random base36 chars.' },
        { name: 'ts', type: 'number', note: 'Milliseconds since epoch.' },
        { name: 'kind', type: '"group"|"expense"|"settlement"|"member"|"system"', note: 'What kind of thing happened.' },
        { name: 'text', type: 'string', note: 'A ready-to-render human-readable sentence, e.g. "Mara paid Nils €15.00.".' },
      ],
      relations: ['not linked back to its source record by id - it is a flat, append-only log'],
    },
  ];

  // =========================================================================
  // LIST - every user-triggerable (or otherwise notable) workflow
  // =========================================================================

  var LIST = [
    {
      id: 'app-boot',
      title: 'App boot',
      trigger: 'Loading index.html (or admin.html) in a browser',
      purpose: 'Get from a cold page load to a rendered UI backed by real, validated state.',
      steps: [
        { n: 1, actor: 'View', action: 'Load scripts in order', detail: 'Classic <script> tags load js/model.js, js/store.js, js/workflows.js, then js/app.js (or js/admin.js), so SW.Model and SW.Store exist before the view code runs.', file: 'index.html' },
        { n: 2, actor: 'View', action: 'SW.Store.subscribe(render)', detail: 'The view registers a render callback so every future state change repaints the UI.', file: 'js/app.js' },
        { n: 3, actor: 'Store', action: 'SW.Store.init()', detail: 'Tries to load and shape-validate "splitwise.state.v1" from localStorage; on any failure (missing, corrupt JSON, wrong version/shape) it falls back to buildDemoState() instead.', file: 'js/store.js' },
        { n: 4, actor: 'Store', action: 'notify()', detail: 'Calls every subscriber once with the initial state snapshot, triggering the first render.', file: 'js/store.js' },
      ],
      invariants: [
        'state always has version, groups, expenses, activity and ui after init()',
        'init() never throws, even if localStorage is unavailable or holds garbage',
      ],
      failureModes: [
        { case: 'localStorage throws (private mode) or holds corrupt/old-version JSON', handling: 'loadFromStorage() catches the error / fails validateStateShape() and returns null; init() falls back to buildDemoState(), so the app always ends up with valid state.' },
      ],
    },
    {
      id: 'create-group',
      title: 'Create a group',
      trigger: 'User submits the "New group" modal',
      purpose: "Create a group with its initial member roster and switch the app's focus to it.",
      steps: [
        { n: 1, actor: 'View', action: 'Collect form fields', detail: 'Name, currency, and a comma-separated member-names field split into an array.', file: 'js/app.js' },
        { n: 2, actor: 'View', action: 'dispatch ADD_GROUP', detail: 'dispatch({type:"ADD_GROUP", payload:{name, currency, memberNames}}).', file: 'js/app.js' },
        { n: 3, actor: 'Store', action: 'handlers.ADD_GROUP', detail: 'Trims and validates the name and member names (at least one non-empty name required); builds Member objects with fresh uid("m") ids.', file: 'js/store.js' },
        { n: 4, actor: 'Store', action: 'Commit', detail: 'Pushes the new Group, sets ui.currentGroupId to it, appends an activity item, persists, and notifies.', file: 'js/store.js' },
      ],
      invariants: [
        'a created group always has at least 1 member',
        'state.ui.currentGroupId equals the new group\'s id after a successful ADD_GROUP',
      ],
      failureModes: [
        { case: 'empty group name, or zero non-empty member names', handling: 'dispatch returns {ok:false, error} before touching state; the modal shows the error and nothing is created.' },
      ],
    },
    {
      id: 'add-member',
      title: 'Add a member to a group',
      trigger: 'User submits "Add member" from within a group',
      purpose: "Grow an existing group's roster.",
      steps: [
        { n: 1, actor: 'View', action: 'Collect the new member\'s name', detail: 'A single text field in the group view.', file: 'js/app.js' },
        { n: 2, actor: 'View', action: 'dispatch ADD_MEMBER', detail: 'dispatch({type:"ADD_MEMBER", payload:{groupId, name}}).', file: 'js/app.js' },
        { n: 3, actor: 'Store', action: 'handlers.ADD_MEMBER', detail: 'Confirms the group exists and the trimmed name is non-empty, then appends a new {id, name} to group.members.', file: 'js/store.js' },
      ],
      invariants: ['every member has a unique id of the form "m_xxxxxxxx"'],
      failureModes: [
        { case: 'groupId does not exist', handling: '{ok:false, error:"Group not found."}' },
        { case: 'empty name', handling: '{ok:false, error:"Member name is required."}' },
      ],
    },
    {
      id: 'add-expense',
      title: 'Add an expense',
      trigger: 'User submits the Add/Edit expense modal in "add" mode',
      purpose: 'Record a shared expense together with how it should be split.',
      steps: [
        { n: 1, actor: 'View', action: 'Collect form fields', detail: 'Description, amount text, payer, category, date, split-mode tab, and per-participant checkboxes/values.', file: 'js/app.js' },
        { n: 2, actor: 'Model', action: 'parseAmount(amountText)', detail: 'Converts the typed amount ("12,50", "€12.50", ...) into integer cents, or null if unparseable.', file: 'js/model.js' },
        { n: 3, actor: 'View', action: 'dispatch ADD_EXPENSE', detail: 'dispatch({type:"ADD_EXPENSE", payload:{groupId, description, amountCents, paidBy, splitMode, participants, category, date, note}}).', file: 'js/app.js' },
        { n: 4, actor: 'Store', action: 'handlers.ADD_EXPENSE', detail: 'Builds a draft object and calls SW.Model.validateExpense(draft, group).', file: 'js/store.js' },
        { n: 5, actor: 'Model', action: 'validateExpense', detail: 'Checks description, amountCents > 0, paidBy is a member, at least one participant who is all a member, and mode-specific sum rules.', file: 'js/model.js' },
        { n: 6, actor: 'Store', action: 'Commit or reject', detail: 'If invalid, returns {ok:false, error} without mutating state. If valid, pushes a new Expense (type:"expense"), appends an activity item, persists, notifies.', file: 'js/store.js' },
      ],
      invariants: [
        'every stored Expense passes SW.Model.validateExpense against its own group',
        'amountCents is always a positive integer',
      ],
      failureModes: [
        { case: 'percent split does not sum to 100% (±0.01 tolerance)', handling: 'validateExpense adds an error; dispatch returns {ok:false}; nothing is persisted; the modal shows the message.' },
        { case: 'payer is not a member of the group', handling: 'same - rejected before any mutation.' },
        { case: 'amount field does not parse (parseAmount returns null)', handling: 'the view treats it as amountCents:NaN, which validateExpense also rejects with "Amount must be a positive whole number of cents."' },
      ],
    },
    {
      id: 'split-calculation',
      title: 'Split calculation',
      trigger: "Any time shares must be derived from an expense's (amountCents, splitMode, participants) - the live preview in the expense modal, and every computeBalances pass",
      purpose: 'Turn an amount plus a split mode into exact per-member cent shares that always sum to the total, with no floating-point drift.',
      steps: [
        { n: 1, actor: 'Model', action: 'splitExpense(amountCents, splitMode, participants)', detail: 'For "exact", the caller-supplied cent values are used directly after confirming they sum to amountCents. For "equal"/"shares"/"percent", each participant gets a weight (1, share count, or percentage).', file: 'js/model.js' },
        { n: 2, actor: 'Model', action: 'Floor + largest-remainder', detail: 'Computes each participant\'s exact real-valued share, floors it, sums the floors, and hands the few leftover cents one at a time to the participants with the largest fractional remainder (ties broken by participant order).', file: 'js/model.js' },
      ],
      invariants: [
        'sum(shareCents) === amountCents exactly, for every split mode',
        'every shareCents value is an integer',
      ],
      failureModes: [
        { case: 'exact values do not sum to amountCents', handling: '{ok:false, error}' },
        { case: 'percent values do not sum to 100 (±0.01)', handling: '{ok:false, error}' },
        { case: 'a shares value is <= 0', handling: '{ok:false, error}' },
      ],
    },
    {
      id: 'compute-balances',
      title: 'Compute group balances',
      trigger: "Rendering a group's balances panel, and internally by memberBalanceSummary/groupTotals-adjacent UI",
      purpose: "Derive every member's net position (creditor/debtor) in a group from its expenses and settlements.",
      steps: [
        { n: 1, actor: 'Model', action: 'computeBalances(groupId, groups, expenses)', detail: 'Starts every member of the group at 0.', file: 'js/model.js' },
        { n: 2, actor: 'Model', action: 'Apply each expense/settlement', detail: 'Calls splitExpense to get that record\'s shares; credits paidBy +amountCents; debits each participant -shareCents. A record whose split fails is skipped entirely, so credits and debits can never drift out of balance.', file: 'js/model.js' },
      ],
      invariants: [
        'every member of the group appears as a key, even at 0',
        'sum of all balances is exactly 0',
      ],
      failureModes: [
        { case: 'groupId does not exist', handling: 'returns {} (an empty balances object).' },
      ],
    },
    {
      id: 'simplify-debts',
      title: 'Simplify debts',
      trigger: "Balances panel building its 'Suggested settlements' list, or memberBalanceSummary computing owes/owed",
      purpose: 'Reduce a web of pairwise debts to the smallest possible set of point-to-point transfers.',
      steps: [
        { n: 1, actor: 'Model', action: 'simplifyDebts(balances)', detail: 'Builds a working list of {id, amount} for every member with a non-zero balance.', file: 'js/model.js' },
        { n: 2, actor: 'Model', action: 'Greedy match loop', detail: 'Repeatedly sorts by amount desc (ties by memberId), matches the largest creditor with the largest debtor, transfers min(credit, |debt|) between them, drops whichever side hit zero, and repeats until nobody is left.', file: 'js/model.js' },
      ],
      invariants: [
        'every returned amountCents is > 0',
        'applying every returned transfer back onto the input balances zeroes all of them',
        'at most n-1 transfers for n members with a non-zero balance',
        'output ordering is fully deterministic for the same input',
      ],
      failureModes: [
        { case: 'balances are already all zero', handling: 'returns an empty array immediately.' },
      ],
    },
    {
      id: 'settle-up',
      title: 'Settle up',
      trigger: 'User submits the "Settle up" modal, or clicks "Record" on a suggested settlement',
      purpose: 'Log a direct payment between two members as a special Expense (type:"settlement").',
      steps: [
        { n: 1, actor: 'View', action: 'Collect/prefill fields', detail: 'From, to, amount, date - prefilled from a suggested settlement when triggered via "Record".', file: 'js/app.js' },
        { n: 2, actor: 'View', action: 'dispatch ADD_SETTLEMENT', detail: 'dispatch({type:"ADD_SETTLEMENT", payload:{groupId, from, to, amountCents, date}}).', file: 'js/app.js' },
        { n: 3, actor: 'Store', action: 'handlers.ADD_SETTLEMENT', detail: 'Confirms from and to are two distinct members of the group and amountCents is a positive integer.', file: 'js/store.js' },
        { n: 4, actor: 'Store', action: 'Commit', detail: 'Appends an Expense with type:"settlement", splitMode:"exact", participants:[{memberId:to, value:amountCents}], paidBy:from; appends an activity item; persists; notifies.', file: 'js/store.js' },
      ],
      invariants: [
        'a settlement always has exactly one participant (the receiver), whose value equals amountCents',
        'settlements feed into computeBalances exactly like ordinary expenses',
      ],
      failureModes: [
        { case: 'from === to', handling: '{ok:false, error:"A settlement needs two different members."}' },
        { case: 'from or to is not a member of the group', handling: '{ok:false, error}' },
        { case: 'amountCents is not a positive integer', handling: '{ok:false, error}' },
      ],
    },
    {
      id: 'delete-expense',
      title: 'Delete an expense or settlement',
      trigger: 'User confirms delete on an expense/settlement row',
      purpose: 'Remove a single record from a group, with an Undo available via the toast.',
      steps: [
        { n: 1, actor: 'View', action: 'dispatch DELETE_EXPENSE', detail: 'dispatch({type:"DELETE_EXPENSE", payload:{expenseId}}); the view keeps a copy of the deleted record for its Undo toast (Undo re-adds it via ADD_EXPENSE/ADD_SETTLEMENT-equivalent data, entirely a view-layer concern).', file: 'js/app.js' },
        { n: 2, actor: 'Store', action: 'handlers.DELETE_EXPENSE', detail: 'Looks the expense up by id across all groups; returns {ok:false} if it no longer exists.', file: 'js/store.js' },
        { n: 3, actor: 'Store', action: 'Commit', detail: 'Filters it out of state.expenses, appends an activity item (kind "expense" or "settlement"), persists, notifies.', file: 'js/store.js' },
      ],
      invariants: ["deleting one expense never touches other expenses or the group's member list"],
      failureModes: [
        { case: 'expenseId does not exist (e.g. already deleted)', handling: '{ok:false, error:"Expense not found."} - nothing removed.' },
      ],
    },
    {
      id: 'persistence',
      title: 'Persistence to localStorage',
      trigger: 'Every dispatch() call whose handler returns {ok:true}, plus explicit reset()/seedDemo()',
      purpose: 'Keep localStorage in sync with in-memory state without ever letting a storage failure break the app.',
      steps: [
        { n: 1, actor: 'Store', action: 'persist()', detail: "JSON.stringify(state) into localStorage['splitwise.state.v1'], wrapped in try/catch.", file: 'js/store.js' },
        { n: 2, actor: 'Store', action: 'notify()', detail: 'Hands every subscriber a deep copy of the new state (structuredClone, with a JSON round-trip fallback).', file: 'js/store.js' },
      ],
      invariants: [
        'a failed dispatch (ok:false) never calls persist() or notify()',
        'getState() never returns a reference a caller could use to mutate the store\'s internals',
      ],
      failureModes: [
        { case: 'localStorage.setItem throws (private mode, quota exceeded)', handling: 'caught and ignored - the app keeps running in-memory only, for the rest of that session.' },
        { case: 'localStorage is undefined (e.g. running under Node)', handling: 'persist()/loadFromStorage() short-circuit to a no-op / null.' },
      ],
    },
    {
      id: 'import-export',
      title: 'Import / export state',
      trigger: 'User clicks "Export JSON", or chooses a file via "Import JSON"',
      purpose: 'Move the whole app state in and out as a single JSON file, for backup or transfer between devices.',
      steps: [
        { n: 1, actor: 'Store', action: 'exportJSON()', detail: 'Returns JSON.stringify(state, null, 2); the view wraps it in a Blob and triggers a download.', file: 'js/store.js' },
        { n: 2, actor: 'View', action: 'Read the chosen file', detail: 'Reads the file\'s text and calls SW.Store.importJSON(text).', file: 'js/app.js' },
        { n: 3, actor: 'Store', action: 'importJSON(str)', detail: 'JSON.parses the string (catching parse errors), then dispatches IMPORT_STATE with the parsed object.', file: 'js/store.js' },
        { n: 4, actor: 'Store', action: 'handlers.IMPORT_STATE', detail: 'Runs validateStateShape (version === 1; groups/expenses/activity arrays present; every group/expense has the required fields) before ever replacing the live state.', file: 'js/store.js' },
      ],
      invariants: [
        'state is only ever replaced by a candidate that passed validateStateShape',
        'a rejected import leaves the current state completely untouched',
      ],
      failureModes: [
        { case: 'the chosen file is not valid JSON', handling: 'importJSON returns {ok:false, error:"That file is not valid JSON."}' },
        { case: 'valid JSON but the wrong shape/version', handling: 'IMPORT_STATE returns {ok:false, error} from validateStateShape; state is unchanged.' },
      ],
    },
    {
      id: 'admin-auth',
      title: 'Admin console login gate',
      trigger: 'Loading admin.html in a new browser session, or submitting the admin password field',
      purpose: 'Put a very simple, explicitly-not-secure speed bump in front of the admin/introspection console.',
      steps: [
        { n: 1, actor: 'View', action: 'Check sessionStorage on load', detail: 'If sessionStorage["splitwise.admin"] === "1", skip straight to the console.', file: 'js/admin.js' },
        { n: 2, actor: 'View', action: 'Compare password on submit', detail: 'Compares the typed value to the literal string "123".', file: 'js/admin.js' },
        { n: 3, actor: 'View', action: 'Grant or deny', detail: 'On match: sets sessionStorage["splitwise.admin"] = "1" and reveals the console. On mismatch: shakes the card and shows an error; the session stays locked.', file: 'js/admin.js' },
        { n: 4, actor: 'View', action: 'Log out', detail: 'Clears sessionStorage["splitwise.admin"], returning to the gate.', file: 'js/admin.js' },
      ],
      invariants: [
        'the check is purely client-side and the UI states this plainly - it is a demo gate, not real authentication',
        'the gate re-appears on every new browser session, since it uses sessionStorage rather than localStorage',
      ],
      failureModes: [
        { case: 'wrong password', handling: 'the card shakes and shows an error message; sessionStorage is left untouched.' },
      ],
    },
  ];

  // =========================================================================
  // ALGORITHMS
  // =========================================================================

  var ALGORITHMS = [
    {
      id: 'largest-remainder',
      name: 'Largest-remainder cent allocation',
      problem:
        'Split an integer number of cents across N participants, proportional to arbitrary ' +
        'positive weights (equal shares, share counts, or percentages), without losing or ' +
        'inventing a single cent to floating-point rounding.',
      approach:
        'Compute every participant\'s exact real-valued share (amountCents * weight / ' +
        'totalWeight). Floor each one to get a first-pass integer allocation - this can only ' +
        'ever under-allocate, never over-allocate. The few cents left over (amountCents minus ' +
        'the sum of the floors) are then handed out one at a time to the participants with the ' +
        'largest fractional remainder, in order, breaking ties by original participant order. ' +
        'This guarantees the final sum is exactly amountCents, and spreads the rounding "loss" ' +
        'as fairly as possible.',
      complexity: 'O(n log n) - dominated by sorting participants by fractional remainder.',
      pseudocode:
        'function largestRemainderSplit(amountCents, weights):\n' +
        '  totalWeight = sum(weights)\n' +
        '  raw[i] = amountCents * weights[i] / totalWeight   // exact, fractional\n' +
        '  floor[i] = floor(raw[i])\n' +
        '  remainder = amountCents - sum(floor)\n' +
        '  order = indices sorted by (raw[i] - floor[i]) descending, ties by i ascending\n' +
        '  for k in 0..remainder-1:\n' +
        '    floor[order[k]] += 1\n' +
        '  return floor   // sum(floor) === amountCents, always',
      worked_example:
        '€10.00 (1000 cents) split equally 3 ways -> raw shares 333.33/333.33/333.33 -> floors ' +
        '333/333/333 (sum 999) -> 1 cent left over -> the first participant has the largest ' +
        'remainder (tie broken by order) and gets it -> final shares 334/333/333 = 1000.',
    },
    {
      id: 'min-cash-flow',
      name: 'Greedy minimum cash-flow debt simplification',
      problem:
        "Given each member's net balance in a group, find a small set of point-to-point " +
        'transfers that settles everyone to zero, instead of naively settling every ' +
        'pairwise IOU that produced those balances.',
      approach:
        'Repeatedly take the current largest creditor (most positive balance) and largest ' +
        'debtor (most negative balance), transfer min(creditor\'s credit, debtor\'s debt) ' +
        'between them, and drop whichever side hit exactly zero. Repeat until no non-zero ' +
        'balances remain. Sorting is by balance descending, ties broken by memberId, so the ' +
        'same input always produces the same output.',
      complexity:
        'O(n^2 log n) worst case (up to n-1 rounds, each re-sorting up to n remaining ' +
        'entries) for n members - more than fast enough at Splitwise-clone group sizes.',
      pseudocode:
        'function simplifyDebts(balances):\n' +
        '  people = [{id, amount} for id, amount in balances if amount != 0]\n' +
        '  transfers = []\n' +
        '  while people is not empty:\n' +
        '    sort people by amount descending, ties by id ascending\n' +
        '    creditor = people[0]           // largest positive balance\n' +
        '    debtor   = people[last]        // largest negative balance\n' +
        '    if creditor.amount <= 0 or debtor.amount >= 0: break\n' +
        '    amount = min(creditor.amount, -debtor.amount)\n' +
        '    transfers.push({from: debtor.id, to: creditor.id, amountCents: amount})\n' +
        '    creditor.amount -= amount\n' +
        '    debtor.amount   += amount\n' +
        '    remove any entries whose amount is now 0\n' +
        '  return transfers   // at most n-1 transfers',
      worked_example:
        'Balances A:+2000, B:-1000, C:-1000 -> round 1: creditor A, debtor B (tie with C ' +
        'broken by id) -> transfer 1000 from B to A -> B settles to 0 and drops out -> ' +
        'round 2: A:+1000, C:-1000 -> transfer 1000 from C to A -> both settle to 0. ' +
        'Result: 2 transfers for 3 members (n-1).',
    },
  ];

  // =========================================================================
  // STATE_MACHINE - the app's conceptual UI lifecycle (not a literal
  // stored field, but the states the view logic in js/app.js/js/admin.js
  // actually moves through).
  // =========================================================================

  var STATE_MACHINE = {
    states: [
      { id: 'boot', label: 'Booting' },
      { id: 'ready', label: 'Ready (idle, panels reflect current state)' },
      { id: 'modal_open', label: 'Modal open (new group / add-edit expense / settle up)' },
      { id: 'validation_error', label: 'Modal open, showing validation errors' },
      { id: 'admin_locked', label: 'Admin console: locked behind the password gate' },
      { id: 'admin_unlocked', label: 'Admin console: unlocked for this session' },
    ],
    transitions: [
      { from: 'boot', to: 'ready', on: 'SW.Store.init() completes and calls notify() for the first time' },
      { from: 'ready', to: 'modal_open', on: 'user opens New group / Add expense / Settle up (or presses "n")' },
      { from: 'modal_open', to: 'ready', on: 'dispatch returns {ok:true} on submit, or the user cancels / presses Esc' },
      { from: 'modal_open', to: 'validation_error', on: 'live validateExpense/parseAmount finds a problem, or dispatch returns {ok:false}' },
      { from: 'validation_error', to: 'modal_open', on: 'user edits a field and the live validity message recomputes' },
      { from: 'validation_error', to: 'ready', on: 'user fixes the problem and submits successfully, or cancels / presses Esc' },
      { from: 'ready', to: 'ready', on: 'any other successful dispatch (rename/delete/select group, settle up, import, reset, seed demo) triggers notify() and a re-render' },
      { from: 'admin_locked', to: 'admin_unlocked', on: 'submitted password === "123"' },
      { from: 'admin_unlocked', to: 'admin_locked', on: 'user clicks "Log out", or a new browser session starts (sessionStorage is empty)' },
    ],
  };

  // =========================================================================

  return {
    ARCHITECTURE: ARCHITECTURE,
    DATA_MODEL: DATA_MODEL,
    LIST: LIST,
    ALGORITHMS: ALGORITHMS,
    STATE_MACHINE: STATE_MACHINE,
  };
})();

// Node/CommonJS footer, matching js/model.js, so this registry can also
// be required/inspected from Node tooling if needed. Never runs in the
// browser, since `module` is undefined there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SW.Workflows;
}
