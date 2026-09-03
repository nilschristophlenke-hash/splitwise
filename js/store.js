// js/store.js
//
// SW.Store - the single source of truth for application state.
//
// It owns loading/saving state to localStorage, validating and applying
// actions (dispatch), and notifying subscribers (the UI layers) after
// every successful change. js/app.js and js/admin.js must only talk to
// state through this public API - never read/write localStorage directly,
// and never mutate the object returned by getState().
//
// This file references `localStorage`, but every access to it is wrapped
// in try/catch: private-browsing modes can throw on access, and in
// non-browser environments (like Node, where this file can still be
// loaded) `localStorage` doesn't exist at all.

var SW = SW || {};

SW.Store = (function () {
  'use strict';

  var STORAGE_KEY = 'splitwise.state.v1';

  // The store's private, mutable state. Everything the outside world sees
  // is a deep copy of this, handed out by getState().
  var state = null;

  // Subscriber callbacks, called with a fresh state snapshot after every
  // successful mutation.
  var listeners = [];

  // ---------------------------------------------------------------------
  // small helpers
  // ---------------------------------------------------------------------

  function deepClone(value) {
    // structuredClone is the modern, safe way to deep-copy plain data.
    // Fall back to a JSON round-trip where it isn't available.
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(value);
      } catch (err) {
        // fall through to the JSON approach below
      }
    }
    return JSON.parse(JSON.stringify(value));
  }

  function emptyState() {
    return {
      version: 1,
      groups: [],
      expenses: [],
      activity: [],
      ui: { currentGroupId: null, currentUserId: null },
    };
  }

  function findGroup(groupId) {
    return state.groups.find(function (g) { return g.id === groupId; }) || null;
  }

  function findExpenseAndGroup(expenseId) {
    for (var i = 0; i < state.expenses.length; i++) {
      if (state.expenses[i].id === expenseId) {
        var expense = state.expenses[i];
        return { expense: expense, group: findGroup(expense.groupId) };
      }
    }
    return null;
  }

  function addActivity(kind, text) {
    state.activity.unshift({
      id: SW.Model.uid('a'),
      ts: Date.now(),
      kind: kind,
      text: text,
    });
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------------
  // localStorage access - always guarded.
  // ---------------------------------------------------------------------

  function persist() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      // Storage full, disabled, or unavailable (e.g. private browsing) -
      // the app keeps working in-memory, it just won't survive a reload.
    }
  }

  function loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return null;
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      var check = validateStateShape(parsed);
      return check.ok ? parsed : null;
    } catch (err) {
      return null;
    }
  }

  // ---------------------------------------------------------------------
  // state shape validation - used when loading from storage and by
  // IMPORT_STATE, so a corrupt/incompatible blob can never clobber a
  // working state.
  // ---------------------------------------------------------------------

  function validateStateShape(candidate) {
    if (!candidate || typeof candidate !== 'object') {
      return { ok: false, error: 'State must be an object.' };
    }
    if (candidate.version !== 1) {
      return { ok: false, error: 'Unsupported or missing state version.' };
    }
    if (
      !Array.isArray(candidate.groups) ||
      !Array.isArray(candidate.expenses) ||
      !Array.isArray(candidate.activity)
    ) {
      return { ok: false, error: 'State is missing groups/expenses/activity arrays.' };
    }
    if (!candidate.ui || typeof candidate.ui !== 'object') {
      return { ok: false, error: 'State is missing a ui object.' };
    }
    for (var i = 0; i < candidate.groups.length; i++) {
      var g = candidate.groups[i];
      if (!g || typeof g.id !== 'string' || typeof g.name !== 'string' || !Array.isArray(g.members)) {
        return { ok: false, error: 'Malformed group in state.' };
      }
    }
    for (var j = 0; j < candidate.expenses.length; j++) {
      var e = candidate.expenses[j];
      if (!e || typeof e.id !== 'string' || typeof e.groupId !== 'string' || !Array.isArray(e.participants)) {
        return { ok: false, error: 'Malformed expense in state.' };
      }
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // demo data - group "Lisbon Flat" with 3 members, one expense per
  // split mode, and one settlement.
  // ---------------------------------------------------------------------

  function buildDemoState() {
    var nils = { id: SW.Model.uid('m'), name: 'Nils' };
    var mara = { id: SW.Model.uid('m'), name: 'Mara' };
    var tomas = { id: SW.Model.uid('m'), name: 'Tomás' };
    var groupId = SW.Model.uid('g');

    var demo = emptyState();
    demo.groups.push({
      id: groupId,
      name: 'Lisbon Flat',
      currency: 'EUR',
      members: [nils, mara, tomas],
      createdAt: Date.now(),
    });
    demo.ui.currentGroupId = groupId;
    demo.ui.currentUserId = nils.id;

    function pushExpense(description, amountCents, paidBy, splitMode, participants, category, daysAgo) {
      var createdAt = Date.now() - daysAgo * 86400000;
      demo.expenses.push({
        id: SW.Model.uid('e'),
        groupId: groupId,
        type: 'expense',
        description: description,
        amountCents: amountCents,
        paidBy: paidBy,
        splitMode: splitMode,
        participants: participants,
        category: category,
        date: new Date(createdAt).toISOString().slice(0, 10),
        createdAt: createdAt,
        note: '',
      });
      demo.activity.push({
        id: SW.Model.uid('a'),
        ts: createdAt,
        kind: 'expense',
        text: description + ' added to Lisbon Flat.',
      });
    }

    pushExpense('Groceries', 4230, nils.id, 'equal', [
      { memberId: nils.id, value: 1 },
      { memberId: mara.id, value: 1 },
      { memberId: tomas.id, value: 1 },
    ], 'food', 6);

    pushExpense('Dinner out', 6000, mara.id, 'exact', [
      { memberId: nils.id, value: 2500 },
      { memberId: mara.id, value: 2000 },
      { memberId: tomas.id, value: 1500 },
    ], 'food', 5);

    pushExpense('September rent', 90000, tomas.id, 'percent', [
      { memberId: nils.id, value: 35 },
      { memberId: mara.id, value: 35 },
      { memberId: tomas.id, value: 30 },
    ], 'rent', 4);

    pushExpense('Airport taxi', 1800, nils.id, 'shares', [
      { memberId: nils.id, value: 1 },
      { memberId: mara.id, value: 2 },
    ], 'transport', 2);

    var settleAt = Date.now() - 86400000;
    demo.expenses.push({
      id: SW.Model.uid('e'),
      groupId: groupId,
      type: 'settlement',
      description: 'Mara paid Nils',
      amountCents: 1500,
      paidBy: mara.id,
      splitMode: 'exact',
      participants: [{ memberId: nils.id, value: 1500 }],
      category: 'general',
      date: new Date(settleAt).toISOString().slice(0, 10),
      createdAt: settleAt,
      note: '',
    });
    demo.activity.push({
      id: SW.Model.uid('a'),
      ts: settleAt,
      kind: 'settlement',
      text: 'Mara paid Nils ' + SW.Model.formatMoney(1500, 'EUR') + '.',
    });

    demo.activity.sort(function (a, b) { return b.ts - a.ts; });
    return demo;
  }

  // ---------------------------------------------------------------------
  // action handlers - one per action type. Each assumes `state` already
  // exists, and returns {ok:true, ...} or {ok:false, error}. dispatch()
  // is responsible for persisting/notifying after a handler succeeds.
  // ---------------------------------------------------------------------

  var handlers = {
    ADD_GROUP: function (payload) {
      var name = String(payload.name || '').trim();
      if (!name) return { ok: false, error: 'Group name is required.' };

      var currency = String(payload.currency || 'EUR').trim().toUpperCase() || 'EUR';

      var rawNames = Array.isArray(payload.memberNames) ? payload.memberNames : [];
      var memberNames = rawNames.map(function (n) { return String(n).trim(); }).filter(Boolean);
      if (memberNames.length === 0) {
        return { ok: false, error: 'At least one member name is required.' };
      }

      var group = {
        id: SW.Model.uid('g'),
        name: name,
        currency: currency,
        members: memberNames.map(function (n) { return { id: SW.Model.uid('m'), name: n }; }),
        createdAt: Date.now(),
      };

      state.groups.push(group);
      state.ui.currentGroupId = group.id; // creator's first member is members[0]
      addActivity('group', 'Created group "' + name + '".');
      return { ok: true, groupId: group.id };
    },

    RENAME_GROUP: function (payload) {
      var group = findGroup(payload.groupId);
      if (!group) return { ok: false, error: 'Group not found.' };
      var name = String(payload.name || '').trim();
      if (!name) return { ok: false, error: 'Group name is required.' };
      var oldName = group.name;
      group.name = name;
      addActivity('group', 'Renamed group "' + oldName + '" to "' + name + '".');
      return { ok: true };
    },

    DELETE_GROUP: function (payload) {
      var group = findGroup(payload.groupId);
      if (!group) return { ok: false, error: 'Group not found.' };

      state.groups = state.groups.filter(function (g) { return g.id !== group.id; });
      state.expenses = state.expenses.filter(function (e) { return e.groupId !== group.id; });
      if (state.ui.currentGroupId === group.id) {
        state.ui.currentGroupId = state.groups.length ? state.groups[0].id : null;
      }
      addActivity('group', 'Deleted group "' + group.name + '".');
      return { ok: true };
    },

    SELECT_GROUP: function (payload) {
      var group = findGroup(payload.groupId);
      if (!group) return { ok: false, error: 'Group not found.' };
      state.ui.currentGroupId = group.id;
      return { ok: true };
    },

    ADD_MEMBER: function (payload) {
      var group = findGroup(payload.groupId);
      if (!group) return { ok: false, error: 'Group not found.' };
      var name = String(payload.name || '').trim();
      if (!name) return { ok: false, error: 'Member name is required.' };

      var member = { id: SW.Model.uid('m'), name: name };
      group.members.push(member);
      addActivity('member', 'Added ' + name + ' to "' + group.name + '".');
      return { ok: true, memberId: member.id };
    },

    REMOVE_MEMBER: function (payload) {
      var group = findGroup(payload.groupId);
      if (!group) return { ok: false, error: 'Group not found.' };
      var member = group.members.find(function (m) { return m.id === payload.memberId; });
      if (!member) return { ok: false, error: 'Member not found.' };

      var usedInExpense = state.expenses.some(function (e) {
        if (e.groupId !== group.id) return false;
        if (e.paidBy === member.id) return true;
        return e.participants.some(function (p) { return p.memberId === member.id; });
      });
      if (usedInExpense) {
        return { ok: false, error: 'Cannot remove ' + member.name + ' - they appear in an existing expense.' };
      }

      group.members = group.members.filter(function (m) { return m.id !== member.id; });
      addActivity('member', 'Removed ' + member.name + ' from "' + group.name + '".');
      return { ok: true };
    },

    ADD_EXPENSE: function (payload) {
      var group = findGroup(payload.groupId);
      if (!group) return { ok: false, error: 'Group not found.' };

      var draft = {
        description: payload.description,
        amountCents: payload.amountCents,
        paidBy: payload.paidBy,
        splitMode: payload.splitMode,
        participants: payload.participants,
      };
      var validation = SW.Model.validateExpense(draft, group);
      if (!validation.ok) return { ok: false, error: validation.errors.join(' ') };

      var expense = {
        id: SW.Model.uid('e'),
        groupId: group.id,
        type: 'expense',
        description: String(draft.description).trim(),
        amountCents: draft.amountCents,
        paidBy: draft.paidBy,
        splitMode: draft.splitMode,
        participants: draft.participants,
        category: payload.category || 'general',
        date: payload.date || todayISO(),
        createdAt: Date.now(),
        note: payload.note || '',
      };
      state.expenses.push(expense);

      var payer = group.members.find(function (m) { return m.id === expense.paidBy; });
      addActivity(
        'expense',
        (payer ? payer.name : 'Someone') + ' added "' + expense.description + '" (' +
          SW.Model.formatMoney(expense.amountCents, group.currency) + ').'
      );
      return { ok: true, expenseId: expense.id };
    },

    UPDATE_EXPENSE: function (payload) {
      var found = findExpenseAndGroup(payload.expenseId);
      if (!found) return { ok: false, error: 'Expense not found.' };
      var expense = found.expense;
      var group = found.group;
      var patch = payload.patch || {};

      var draft = {
        description: patch.description !== undefined ? patch.description : expense.description,
        amountCents: patch.amountCents !== undefined ? patch.amountCents : expense.amountCents,
        paidBy: patch.paidBy !== undefined ? patch.paidBy : expense.paidBy,
        splitMode: patch.splitMode !== undefined ? patch.splitMode : expense.splitMode,
        participants: patch.participants !== undefined ? patch.participants : expense.participants,
      };
      var validation = SW.Model.validateExpense(draft, group);
      if (!validation.ok) return { ok: false, error: validation.errors.join(' ') };

      expense.description = String(draft.description).trim();
      expense.amountCents = draft.amountCents;
      expense.paidBy = draft.paidBy;
      expense.splitMode = draft.splitMode;
      expense.participants = draft.participants;
      if (patch.category !== undefined) expense.category = patch.category;
      if (patch.date !== undefined) expense.date = patch.date;
      if (patch.note !== undefined) expense.note = patch.note;

      addActivity('expense', 'Updated "' + expense.description + '".');
      return { ok: true };
    },

    DELETE_EXPENSE: function (payload) {
      var found = findExpenseAndGroup(payload.expenseId);
      if (!found) return { ok: false, error: 'Expense not found.' };
      var expense = found.expense;

      state.expenses = state.expenses.filter(function (e) { return e.id !== expense.id; });
      var kind = expense.type === 'settlement' ? 'settlement' : 'expense';
      addActivity(kind, 'Deleted "' + expense.description + '".');
      return { ok: true };
    },

    ADD_SETTLEMENT: function (payload) {
      var group = findGroup(payload.groupId);
      if (!group) return { ok: false, error: 'Group not found.' };

      var fromMember = group.members.find(function (m) { return m.id === payload.from; });
      var toMember = group.members.find(function (m) { return m.id === payload.to; });
      if (!fromMember) return { ok: false, error: 'Payer is not a member of this group.' };
      if (!toMember) return { ok: false, error: 'Recipient is not a member of this group.' };
      if (payload.from === payload.to) return { ok: false, error: 'A settlement needs two different members.' };
      if (!Number.isInteger(payload.amountCents) || payload.amountCents <= 0) {
        return { ok: false, error: 'Settlement amount must be a positive whole number of cents.' };
      }

      var settlement = {
        id: SW.Model.uid('e'),
        groupId: group.id,
        type: 'settlement',
        description: fromMember.name + ' paid ' + toMember.name,
        amountCents: payload.amountCents,
        paidBy: payload.from,
        splitMode: 'exact',
        participants: [{ memberId: payload.to, value: payload.amountCents }],
        category: 'general',
        date: payload.date || todayISO(),
        createdAt: Date.now(),
        note: '',
      };
      state.expenses.push(settlement);
      addActivity(
        'settlement',
        fromMember.name + ' paid ' + toMember.name + ' ' + SW.Model.formatMoney(payload.amountCents, group.currency) + '.'
      );
      return { ok: true, expenseId: settlement.id };
    },

    SET_CURRENT_USER: function (payload) {
      var memberId = payload.memberId;
      if (memberId === null || memberId === undefined) {
        state.ui.currentUserId = null;
        return { ok: true };
      }
      var exists = state.groups.some(function (g) {
        return g.members.some(function (m) { return m.id === memberId; });
      });
      if (!exists) return { ok: false, error: 'Member not found.' };
      state.ui.currentUserId = memberId;
      return { ok: true };
    },

    IMPORT_STATE: function (payload) {
      var check = validateStateShape(payload.state);
      if (!check.ok) return check;
      state = deepClone(payload.state);
      addActivity('system', 'Imported state from a JSON file.');
      return { ok: true };
    },
  };

  // ---------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------

  function init() {
    var loaded = loadFromStorage();
    state = loaded || buildDemoState();
    if (!loaded) persist();
    notify();
  }

  function getState() {
    return deepClone(state);
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function unsubscribe() {
      listeners = listeners.filter(function (l) { return l !== fn; });
    };
  }

  function notify() {
    var snapshot = getState();
    listeners.forEach(function (fn) {
      try {
        fn(snapshot);
      } catch (err) {
        // A broken subscriber must not break the store for everyone else.
      }
    });
  }

  function dispatch(action) {
    try {
      if (!action || typeof action !== 'object' || typeof action.type !== 'string') {
        return { ok: false, error: 'Action must be an object with a string "type".' };
      }
      var handler = handlers[action.type];
      if (!handler) {
        return { ok: false, error: 'Unknown action type: ' + action.type };
      }
      var result = handler(action.payload || {});
      if (result && result.ok) {
        persist();
        notify();
      }
      return result;
    } catch (err) {
      return { ok: false, error: 'Unexpected error: ' + (err && err.message ? err.message : String(err)) };
    }
  }

  function exportJSON() {
    return JSON.stringify(state, null, 2);
  }

  function importJSON(str) {
    var parsed;
    try {
      parsed = JSON.parse(str);
    } catch (err) {
      return { ok: false, error: 'That file is not valid JSON.' };
    }
    return dispatch({ type: 'IMPORT_STATE', payload: { state: parsed } });
  }

  function reset() {
    state = emptyState();
    persist();
    notify();
  }

  function seedDemo() {
    state = buildDemoState();
    persist();
    notify();
  }

  return {
    init: init,
    getState: getState,
    subscribe: subscribe,
    dispatch: dispatch,
    exportJSON: exportJSON,
    importJSON: importJSON,
    reset: reset,
    seedDemo: seedDemo,
  };
})();
