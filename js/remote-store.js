// js/remote-store.js
//
// SW.RemoteStore - the Supabase-backed twin of SW.Store.
//
// js/app.js talks to either SW.Store (localStorage, single device) or
// SW.RemoteStore (Supabase, multi-user) through the exact same public API:
// init(), getState(), subscribe(fn), dispatch(action), exportJSON(),
// reset(). This module also adds onSyncStatus(fn), because a network write
// can fail after the UI has already moved on.
//
// The trick this file has to pull off is that dispatch() must still return
// {ok, error} SYNCHRONOUSLY, even though the real write happens over the
// network. It does that with optimistic writes:
//
//   1. Validate the action locally (the same SW.Model.validateExpense
//      SW.Store uses). If that fails, nothing happens and we return
//      {ok:false, error} right away.
//   2. Apply the change to an in-memory cache that mirrors SW.Store's
//      state shape, notify() subscribers, and return {ok:true}
//      immediately - the UI updates instantly, before the network has
//      even been asked.
//   3. Fire the Supabase write in the background. On success we reconcile
//      any temporary id with the real one from the server. On failure we
//      roll the cache back to how it looked before step 2, notify()
//      again, and report the failure through onSyncStatus(). The cache
//      must never keep showing something the server rejected.
//
// An expense lives in two tables (expenses + expense_participants). If the
// participants half of a write fails, we delete the expense row we just
// created so a half-written expense can never exist - see writeExpense().
//
// Every public function is wrapped so it can never throw: a broken network
// call, a missing SW.Auth session, or a malformed action all come back as
// {ok:false, error:...} or a message through onSyncStatus(), never an
// uncaught exception.

var SW = SW || {};

SW.RemoteStore = (function () {
  'use strict';

  var ALLOWED_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF'];

  // The module's private, mutable cache. Everything handed to the outside
  // world is a deep copy of this, exactly like SW.Store.
  var state = emptyState();

  var listeners = [];      // subscribe(fn) callbacks - state changes
  var syncListeners = [];  // onSyncStatus(fn) callbacks - save progress

  var realtimeChannel = null;
  var pendingRefetchGroupIds = {};
  var refetchTimer = null;
  var authWatchStarted = false;

  // ---------------------------------------------------------------------
  // small helpers (same shape as SW.Store's)
  // ---------------------------------------------------------------------

  function deepClone(value) {
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

  // Returns the new entry so callers can remove exactly this entry again
  // if the background write that caused it ends up failing.
  function addActivity(kind, text) {
    var entry = { id: SW.Model.uid('a'), ts: Date.now(), kind: kind, text: text };
    state.activity.unshift(entry);
    return entry;
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  function uniq(values) {
    var seen = {};
    var out = [];
    values.forEach(function (v) {
      if (!seen[v]) {
        seen[v] = true;
        out.push(v);
      }
    });
    return out;
  }

  // Supabase/Postgres errors, plain JS errors and plain strings all show
  // up in the various catch() blocks below - this pulls a human message
  // out of whichever one we got.
  function errMsg(err) {
    if (!err) return 'Unknown error.';
    if (typeof err === 'string') return err;
    return err.message || err.error_description || err.msg || String(err);
  }

  // ---------------------------------------------------------------------
  // DB row -> app state mapping (snake_case columns -> camelCase shape)
  // ---------------------------------------------------------------------

  function mapMember(memberRow, profileRow) {
    return {
      id: memberRow.user_id,
      name: (profileRow && (profileRow.display_name || profileRow.email)) || 'Member',
      avatarUrl: (profileRow && profileRow.avatar_url) || null,
    };
  }

  function mapGroup(groupRow, members) {
    return {
      id: groupRow.id,
      name: groupRow.name,
      currency: groupRow.currency,
      inviteCode: groupRow.invite_code,
      ownerId: groupRow.created_by,
      members: members,
      createdAt: groupRow.created_at ? new Date(groupRow.created_at).getTime() : Date.now(),
    };
  }

  function mapExpense(expenseRow, participants) {
    return {
      id: expenseRow.id,
      groupId: expenseRow.group_id,
      type: expenseRow.type,
      description: expenseRow.description,
      amountCents: Number(expenseRow.amount_cents),
      paidBy: expenseRow.paid_by,
      splitMode: expenseRow.split_mode,
      participants: participants,
      category: expenseRow.category,
      date: expenseRow.date,
      createdAt: expenseRow.created_at ? new Date(expenseRow.created_at).getTime() : Date.now(),
      note: expenseRow.note || '',
    };
  }

  // Builds an activity feed out of the expenses/settlements we actually
  // have. There is no activity table in the schema, so this is the only
  // history available for group/member events that happened on another
  // device or before this session started - those simply don't appear
  // here. Activity entries created during THIS session (see addActivity
  // above) cover the rest.
  function buildActivityFromExpenses(expenses, groups) {
    var currencyByGroup = {};
    groups.forEach(function (g) { currencyByGroup[g.id] = g.currency; });

    var entries = expenses.map(function (e) {
      var currency = currencyByGroup[e.groupId] || 'EUR';
      var kind = e.type === 'settlement' ? 'settlement' : 'expense';
      var text = e.type === 'settlement'
        ? (e.description + ' ' + SW.Model.formatMoney(e.amountCents, currency) + '.')
        : (e.description + ' added (' + SW.Model.formatMoney(e.amountCents, currency) + ').');
      return { id: 'a_' + e.id, ts: e.createdAt, kind: kind, text: text };
    });
    entries.sort(function (a, b) { return b.ts - a.ts; });
    return entries;
  }

  // ---------------------------------------------------------------------
  // fetching - shared between the initial load and a realtime refetch of
  // one group. `groupRows` is already RLS-filtered by Postgres: a select
  // on `groups` only ever returns groups the caller belongs to.
  // ---------------------------------------------------------------------

  function loadGroupsAndExpenses(client, groupRows) {
    var groupIds = groupRows.map(function (g) { return g.id; });
    if (groupIds.length === 0) {
      return Promise.resolve({ groups: [], expenses: [] });
    }

    return Promise.all([
      client.from('group_members').select('*').in('group_id', groupIds),
      client.from('expenses').select('*').in('group_id', groupIds),
    ]).then(function (results) {
      var memberRes = results[0];
      var expenseRes = results[1];
      if (memberRes.error) throw memberRes.error;
      if (expenseRes.error) throw expenseRes.error;

      var memberRows = memberRes.data || [];
      var expenseRows = expenseRes.data || [];
      var userIds = uniq(memberRows.map(function (m) { return m.user_id; }));
      var expenseIds = expenseRows.map(function (e) { return e.id; });

      var profilesPromise = userIds.length
        ? client.from('profiles').select('*').in('id', userIds)
        : Promise.resolve({ data: [], error: null });
      var participantsPromise = expenseIds.length
        ? client.from('expense_participants').select('*').in('expense_id', expenseIds)
        : Promise.resolve({ data: [], error: null });

      return Promise.all([profilesPromise, participantsPromise]).then(function (results2) {
        var profileRes = results2[0];
        var participantRes = results2[1];
        if (profileRes.error) throw profileRes.error;
        if (participantRes.error) throw participantRes.error;

        var profileById = {};
        (profileRes.data || []).forEach(function (p) { profileById[p.id] = p; });

        var membersByGroup = {};
        memberRows.forEach(function (m) {
          if (!membersByGroup[m.group_id]) membersByGroup[m.group_id] = [];
          membersByGroup[m.group_id].push(mapMember(m, profileById[m.user_id]));
        });

        var participantsByExpense = {};
        (participantRes.data || []).forEach(function (p) {
          if (!participantsByExpense[p.expense_id]) participantsByExpense[p.expense_id] = [];
          participantsByExpense[p.expense_id].push({ memberId: p.user_id, value: Number(p.value) });
        });

        var groups = groupRows.map(function (g) {
          return mapGroup(g, membersByGroup[g.id] || []);
        });
        var expenses = expenseRows.map(function (e) {
          return mapExpense(e, participantsByExpense[e.id] || []);
        });
        expenses.sort(function (a, b) { return a.createdAt - b.createdAt; });

        return { groups: groups, expenses: expenses };
      });
    });
  }

  // Replaces (or removes) one group's slice of the cache with freshly
  // fetched data. Used after init and after every realtime-triggered
  // refetch.
  function mergeGroupResult(groupId, result) {
    state.groups = state.groups.filter(function (g) { return g.id !== groupId; });
    state.expenses = state.expenses.filter(function (e) { return e.groupId !== groupId; });
    result.groups.forEach(function (g) { state.groups.push(g); });
    result.expenses.forEach(function (e) { state.expenses.push(e); });

    // An empty result means the group is gone or we're no longer a
    // member (RLS just quietly returns nothing) - drop the current
    // selection if it pointed there.
    if (result.groups.length === 0 && state.ui.currentGroupId === groupId) {
      state.ui.currentGroupId = state.groups.length ? state.groups[0].id : null;
    }
  }

  function refetchGroup(client, groupId) {
    client.from('groups').select('*').eq('id', groupId).then(function (res) {
      if (res.error) throw res.error;
      var groupRows = res.data || [];
      return loadGroupsAndExpenses(client, groupRows).then(function (result) {
        mergeGroupResult(groupId, result);
        notify();
      });
    }).catch(function (err) {
      notifySyncStatus('error', 'Could not refresh a group: ' + errMsg(err));
    });
  }

  // ---------------------------------------------------------------------
  // realtime - one shared channel, listening on all four tables. A burst
  // of related row events (e.g. an expense insert plus its participant
  // inserts) is debounced into a single refetch per affected group.
  // ---------------------------------------------------------------------

  function scheduleRefetch(client, groupId) {
    pendingRefetchGroupIds[groupId] = true;
    if (refetchTimer) clearTimeout(refetchTimer);
    refetchTimer = setTimeout(function () {
      var ids = Object.keys(pendingRefetchGroupIds);
      pendingRefetchGroupIds = {};
      refetchTimer = null;
      ids.forEach(function (id) { refetchGroup(client, id); });
    }, 300);
  }

  function onRealtimeEvent(client, table, payload) {
    var row = (payload.new && Object.keys(payload.new).length) ? payload.new : payload.old;
    if (!row) return;

    var groupId = null;
    if (table === 'groups') {
      groupId = row.id;
    } else if (table === 'group_members' || table === 'expenses') {
      groupId = row.group_id;
    } else if (table === 'expense_participants') {
      var expense = state.expenses.find(function (e) { return e.id === row.expense_id; });
      groupId = expense ? expense.groupId : null;
    }
    if (!groupId) return;

    // Only refetch groups we already know about; a brand new membership
    // discovered purely through a realtime event (rather than through
    // JOIN_GROUP or an app restart) is out of scope here.
    var isKnownGroup = state.groups.some(function (g) { return g.id === groupId; });
    if (!isKnownGroup) return;

    scheduleRefetch(client, groupId);
  }

  function subscribeRealtime(client) {
    unsubscribeRealtime();
    var channel = client.channel('remote-store-sync');
    ['expenses', 'expense_participants', 'group_members', 'groups'].forEach(function (table) {
      channel = channel.on('postgres_changes', { event: '*', schema: 'public', table: table }, function (payload) {
        onRealtimeEvent(client, table, payload);
      });
    });
    channel.subscribe();
    realtimeChannel = channel;
  }

  function unsubscribeRealtime() {
    if (refetchTimer) {
      clearTimeout(refetchTimer);
      refetchTimer = null;
    }
    pendingRefetchGroupIds = {};
    if (realtimeChannel) {
      try {
        realtimeChannel.unsubscribe();
      } catch (err) {
        // already gone - nothing to clean up
      }
      realtimeChannel = null;
    }
  }

  // Sign-out can happen at any time (another tab, a token expiring, the
  // user clicking "Sign out"). Whenever SW.Auth reports nobody is signed
  // in any more, drop the realtime subscription and the cache with it.
  function watchAuthChanges() {
    if (authWatchStarted) return;
    authWatchStarted = true;
    if (SW.Auth && typeof SW.Auth.onChange === 'function') {
      SW.Auth.onChange(function (user) {
        if (!user) {
          unsubscribeRealtime();
          state = emptyState();
          notify();
        }
      });
    }
  }

  // ---------------------------------------------------------------------
  // shared write helpers
  // ---------------------------------------------------------------------

  // Inserts an expense (or settlement - same table) and its participants.
  // If the participants half fails, the expense row is deleted again so a
  // half-written expense can never be seen by anyone. On full success the
  // cached row's temporary id is swapped for the real one.
  function writeExpense(client, user, expense, tempId, activityEntryId) {
    var row = {
      group_id: expense.groupId,
      type: expense.type,
      description: expense.description,
      amount_cents: expense.amountCents,
      paid_by: expense.paidBy,
      split_mode: expense.splitMode,
      category: expense.category,
      date: expense.date,
      note: expense.note,
      created_by: user.id,
    };

    client.from('expenses').insert(row).select().single().then(function (res) {
      if (res.error) throw res.error;
      var savedRow = res.data;
      var participantRows = expense.participants.map(function (p) {
        return { expense_id: savedRow.id, user_id: p.memberId, value: p.value };
      });

      return client.from('expense_participants').insert(participantRows).then(function (partRes) {
        if (partRes.error) {
          // Half-written expense: the row exists but its split doesn't.
          // Delete it again rather than leave it visible with no split.
          return client.from('expenses').delete().eq('id', savedRow.id).then(function () {
            throw partRes.error;
          });
        }
        var cached = state.expenses.find(function (e) { return e.id === tempId; });
        if (cached) {
          cached.id = savedRow.id;
          cached.createdAt = savedRow.created_at ? new Date(savedRow.created_at).getTime() : cached.createdAt;
        }
        notify();
        notifySyncStatus('saved', 'Saved.');
      });
    }).catch(function (err) {
      state.expenses = state.expenses.filter(function (e) { return e.id !== tempId; });
      if (activityEntryId) {
        state.activity = state.activity.filter(function (a) { return a.id !== activityEntryId; });
      }
      notify();
      notifySyncStatus('error', 'Could not save the expense: ' + errMsg(err));
    });
  }

  // Updates an existing expense row and, if the split changed, replaces
  // its participants. If the new participants fail to write, the old
  // participants are put back and the base fields are reverted too, on a
  // best-effort basis - there is no single transaction to fall back on
  // here (unlike ADD_EXPENSE, this isn't a fresh row we can just delete).
  function updateExpenseRemote(client, expense, before, activityEntryId, participantsChanged) {
    var fieldsRow = {
      description: expense.description,
      amount_cents: expense.amountCents,
      paid_by: expense.paidBy,
      split_mode: expense.splitMode,
      category: expense.category,
      date: expense.date,
      note: expense.note,
    };

    function rollback(err) {
      var fallbackRow = {
        description: before.description,
        amount_cents: before.amountCents,
        paid_by: before.paidBy,
        split_mode: before.splitMode,
        category: before.category,
        date: before.date,
        note: before.note,
      };
      client.from('expenses').update(fallbackRow).eq('id', before.id).then(function () {}, function () {});

      var found = findExpenseAndGroup(before.id);
      if (found) {
        var e = found.expense;
        e.description = before.description;
        e.amountCents = before.amountCents;
        e.paidBy = before.paidBy;
        e.splitMode = before.splitMode;
        e.participants = before.participants;
        e.category = before.category;
        e.date = before.date;
        e.note = before.note;
      }
      if (activityEntryId) {
        state.activity = state.activity.filter(function (a) { return a.id !== activityEntryId; });
      }
      notify();
      notifySyncStatus('error', 'Could not save changes: ' + errMsg(err));
    }

    client.from('expenses').update(fieldsRow).eq('id', expense.id).select().then(function (res) {
      if (res.error) throw res.error;
      if (!res.data || res.data.length === 0) {
        throw new Error('You do not have permission to edit this expense.');
      }
      if (!participantsChanged) {
        notifySyncStatus('saved', 'Saved.');
        return null;
      }
      return client.from('expense_participants').delete().eq('expense_id', expense.id).then(function (delRes) {
        if (delRes.error) throw delRes.error;
        var newRows = expense.participants.map(function (p) {
          return { expense_id: expense.id, user_id: p.memberId, value: p.value };
        });
        return client.from('expense_participants').insert(newRows).then(function (insRes) {
          if (insRes.error) {
            var oldRows = before.participants.map(function (p) {
              return { expense_id: expense.id, user_id: p.memberId, value: p.value };
            });
            return client.from('expense_participants').insert(oldRows).then(function () {
              throw insRes.error;
            });
          }
          notifySyncStatus('saved', 'Saved.');
        });
      });
    }).catch(rollback);
  }

  // ---------------------------------------------------------------------
  // action handlers - mirrors SW.Store's handlers object. Each one
  // validates, applies the optimistic change to `state`, and kicks off
  // the background Supabase write. dispatch() is responsible for
  // notifying subscribers of the synchronous part of the change.
  // ---------------------------------------------------------------------

  var handlers = {
    ADD_GROUP: function (payload, client, user) {
      var name = String(payload.name || '').trim();
      if (!name) return { ok: false, error: 'Group name is required.' };

      var currency = String(payload.currency || 'EUR').trim().toUpperCase() || 'EUR';
      if (ALLOWED_CURRENCIES.indexOf(currency) === -1) {
        return { ok: false, error: 'Currency must be one of ' + ALLOWED_CURRENCIES.join(', ') + '.' };
      }

      var tempId = SW.Model.uid('g');
      var previousGroupId = state.ui.currentGroupId;
      var group = {
        id: tempId,
        name: name,
        currency: currency,
        inviteCode: '…', // the server generates the real code
        ownerId: user.id,
        members: [{ id: user.id, name: user.name || user.email || 'You', avatarUrl: user.avatarUrl || null }],
        createdAt: Date.now(),
      };
      state.groups.push(group);
      state.ui.currentGroupId = tempId;
      addActivity('group', 'Created group "' + name + '".');
      notifySyncStatus('saving', 'Creating group…');

      client.rpc('create_group', { p_name: name, p_currency: currency }).then(function (res) {
        if (res.error) throw res.error;
        var row = Array.isArray(res.data) ? res.data[0] : res.data;
        if (!row) throw new Error('The server did not return the new group.');

        var cached = state.groups.find(function (g) { return g.id === tempId; });
        if (cached) {
          cached.id = row.id;
          cached.name = row.name;
          cached.currency = row.currency;
          cached.inviteCode = row.invite_code;
          cached.ownerId = row.created_by;
          cached.createdAt = row.created_at ? new Date(row.created_at).getTime() : Date.now();
        }
        if (state.ui.currentGroupId === tempId) state.ui.currentGroupId = row.id;
        notify();
        notifySyncStatus('saved', 'Saved.');
      }).catch(function (err) {
        state.groups = state.groups.filter(function (g) { return g.id !== tempId; });
        if (state.ui.currentGroupId === tempId) state.ui.currentGroupId = previousGroupId;
        notify();
        notifySyncStatus('error', 'Could not create the group: ' + errMsg(err));
      });

      return { ok: true, groupId: tempId };
    },

    // There is nothing sensible to show optimistically for a group we
    // cannot even read yet (RLS blocks it until we're a member), so this
    // one just kicks off the RPC and reports success/failure entirely
    // through onSyncStatus() plus the eventual state change.
    JOIN_GROUP: function (payload, client) {
      var code = String(payload.code || '').trim();
      if (!code) return { ok: false, error: 'An invite code is required.' };

      notifySyncStatus('saving', 'Joining group…');

      // Joining is the one action that cannot be applied optimistically:
      // until the server resolves the code we do not know which group it is,
      // or whether the code is even real. So instead of pretending it
      // succeeded, we report the outcome through this callback and let the
      // caller keep its modal open until we actually know.
      var report = typeof payload.onResult === 'function' ? payload.onResult : function () {};

      // The parameter really is called p_code: PostgREST matches RPC
      // arguments by name, so `code` silently resolves to no function at all.
      client.rpc('join_group_by_code', { p_code: code }).then(function (res) {
        if (res.error) throw res.error;
        var groupId = Array.isArray(res.data) ? res.data[0] : res.data;
        if (groupId && typeof groupId === 'object') {
          groupId = groupId.id || groupId.group_id || groupId.join_group_by_code;
        }
        if (!groupId) throw new Error('The server did not return a group id.');

        return client.from('groups').select('*').eq('id', groupId).then(function (groupRes) {
          if (groupRes.error) throw groupRes.error;
          var groupRows = groupRes.data || [];
          return loadGroupsAndExpenses(client, groupRows).then(function (result) {
            mergeGroupResult(groupId, result);
            if (result.groups.length) state.ui.currentGroupId = groupId;
            notify();
            notifySyncStatus('saved', 'Joined.');
            report({ ok: true });
          });
        });
      }).catch(function (err) {
        var message = errMsg(err);
        notifySyncStatus('error', 'Could not join that group: ' + message);
        report({ ok: false, error: message });
      });

      // "The request is on its way", not "you are in the group".
      return { ok: true, pending: true };
    },

    RENAME_GROUP: function (payload, client) {
      var group = findGroup(payload.groupId);
      if (!group) return { ok: false, error: 'Group not found.' };
      var name = String(payload.name || '').trim();
      if (!name) return { ok: false, error: 'Group name is required.' };

      var oldName = group.name;
      group.name = name;
      addActivity('group', 'Renamed group "' + oldName + '" to "' + name + '".');
      notifySyncStatus('saving', 'Saving…');

      client.from('groups').update({ name: name }).eq('id', group.id).select().then(function (res) {
        if (res.error) throw res.error;
        if (!res.data || res.data.length === 0) {
          throw new Error('Only the group owner can rename this group.');
        }
        notifySyncStatus('saved', 'Saved.');
      }).catch(function (err) {
        var g = findGroup(group.id);
        if (g) g.name = oldName;
        notify();
        notifySyncStatus('error', 'Could not rename the group: ' + errMsg(err));
      });

      return { ok: true };
    },

    DELETE_GROUP: function (payload, client) {
      var group = findGroup(payload.groupId);
      if (!group) return { ok: false, error: 'Group not found.' };

      var groupSnapshot = deepClone(group);
      var expensesSnapshot = deepClone(state.expenses.filter(function (e) { return e.groupId === group.id; }));
      var previousCurrentGroupId = state.ui.currentGroupId;

      state.groups = state.groups.filter(function (g) { return g.id !== group.id; });
      state.expenses = state.expenses.filter(function (e) { return e.groupId !== group.id; });
      if (state.ui.currentGroupId === group.id) {
        state.ui.currentGroupId = state.groups.length ? state.groups[0].id : null;
      }
      addActivity('group', 'Deleted group "' + group.name + '".');
      notifySyncStatus('saving', 'Deleting…');

      client.from('groups').delete().eq('id', group.id).select().then(function (res) {
        if (res.error) throw res.error;
        if (!res.data || res.data.length === 0) {
          throw new Error('Only the group owner can delete this group.');
        }
        notifySyncStatus('saved', 'Saved.');
      }).catch(function (err) {
        state.groups.push(groupSnapshot);
        expensesSnapshot.forEach(function (e) { state.expenses.push(e); });
        state.ui.currentGroupId = previousCurrentGroupId;
        notify();
        notifySyncStatus('error', 'Could not delete the group: ' + errMsg(err));
      });

      return { ok: true };
    },

    SELECT_GROUP: function (payload) {
      var group = findGroup(payload.groupId);
      if (!group) return { ok: false, error: 'Group not found.' };
      state.ui.currentGroupId = group.id;
      return { ok: true };
    },

    // Members join with an invite code now - there is no free-text
    // "add member" flow any more.
    ADD_MEMBER: function () {
      return { ok: false, error: 'Members join with an invite code.' };
    },

    REMOVE_MEMBER: function (payload, client) {
      var group = findGroup(payload.groupId);
      if (!group) return { ok: false, error: 'Group not found.' };
      var userId = payload.userId;
      var member = group.members.find(function (m) { return m.id === userId; });
      if (!member) return { ok: false, error: 'Member not found.' };

      var usedInExpense = state.expenses.some(function (e) {
        if (e.groupId !== group.id) return false;
        if (e.paidBy === member.id) return true;
        return e.participants.some(function (p) { return p.memberId === member.id; });
      });
      if (usedInExpense) {
        return { ok: false, error: 'Cannot remove ' + member.name + ' - they appear in an existing expense.' };
      }

      var memberIndex = group.members.indexOf(member);
      group.members = group.members.filter(function (m) { return m.id !== member.id; });
      addActivity('member', 'Removed ' + member.name + ' from "' + group.name + '".');
      notifySyncStatus('saving', 'Saving…');

      client.from('group_members').delete().eq('group_id', group.id).eq('user_id', userId).select().then(function (res) {
        if (res.error) throw res.error;
        if (!res.data || res.data.length === 0) {
          throw new Error('Only the group owner can remove members.');
        }
        notifySyncStatus('saved', 'Saved.');
      }).catch(function (err) {
        var g = findGroup(group.id);
        if (g) g.members.splice(memberIndex, 0, member);
        notify();
        notifySyncStatus('error', 'Could not remove ' + member.name + ': ' + errMsg(err));
      });

      return { ok: true };
    },

    LEAVE_GROUP: function (payload, client, user) {
      var group = findGroup(payload.groupId);
      if (!group) return { ok: false, error: 'Group not found.' };

      var groupSnapshot = deepClone(group);
      var expensesSnapshot = deepClone(state.expenses.filter(function (e) { return e.groupId === group.id; }));
      var previousCurrentGroupId = state.ui.currentGroupId;

      state.groups = state.groups.filter(function (g) { return g.id !== group.id; });
      state.expenses = state.expenses.filter(function (e) { return e.groupId !== group.id; });
      if (state.ui.currentGroupId === group.id) {
        state.ui.currentGroupId = state.groups.length ? state.groups[0].id : null;
      }
      addActivity('member', 'Left "' + group.name + '".');
      notifySyncStatus('saving', 'Leaving…');

      client.from('group_members').delete().eq('group_id', group.id).eq('user_id', user.id).select().then(function (res) {
        if (res.error) throw res.error;
        if (!res.data || res.data.length === 0) {
          throw new Error('Could not leave the group.');
        }
        notifySyncStatus('saved', 'Saved.');
      }).catch(function (err) {
        state.groups.push(groupSnapshot);
        expensesSnapshot.forEach(function (e) { state.expenses.push(e); });
        state.ui.currentGroupId = previousCurrentGroupId;
        notify();
        notifySyncStatus('error', 'Could not leave the group: ' + errMsg(err));
      });

      return { ok: true };
    },

    ADD_EXPENSE: function (payload, client, user) {
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

      var tempId = SW.Model.uid('e');
      var expense = {
        id: tempId,
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
      var activityEntry = addActivity(
        'expense',
        (payer ? payer.name : 'Someone') + ' added "' + expense.description + '" (' +
          SW.Model.formatMoney(expense.amountCents, group.currency) + ').'
      );
      notifySyncStatus('saving', 'Saving…');

      writeExpense(client, user, expense, tempId, activityEntry.id);

      return { ok: true, expenseId: tempId };
    },

    UPDATE_EXPENSE: function (payload, client) {
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

      var before = deepClone(expense);

      expense.description = String(draft.description).trim();
      expense.amountCents = draft.amountCents;
      expense.paidBy = draft.paidBy;
      expense.splitMode = draft.splitMode;
      expense.participants = draft.participants;
      if (patch.category !== undefined) expense.category = patch.category;
      if (patch.date !== undefined) expense.date = patch.date;
      if (patch.note !== undefined) expense.note = patch.note;

      var activityEntry = addActivity('expense', 'Updated "' + expense.description + '".');
      notifySyncStatus('saving', 'Saving…');

      updateExpenseRemote(client, expense, before, activityEntry.id, patch.participants !== undefined);

      return { ok: true };
    },

    DELETE_EXPENSE: function (payload, client) {
      var found = findExpenseAndGroup(payload.expenseId);
      if (!found) return { ok: false, error: 'Expense not found.' };
      var expense = found.expense;

      var snapshot = deepClone(expense);
      state.expenses = state.expenses.filter(function (e) { return e.id !== expense.id; });
      var kind = expense.type === 'settlement' ? 'settlement' : 'expense';
      var activityEntry = addActivity(kind, 'Deleted "' + expense.description + '".');
      notifySyncStatus('saving', 'Deleting…');

      client.from('expenses').delete().eq('id', expense.id).select().then(function (res) {
        if (res.error) throw res.error;
        if (!res.data || res.data.length === 0) {
          throw new Error('You do not have permission to delete this expense.');
        }
        notifySyncStatus('saved', 'Saved.');
      }).catch(function (err) {
        state.expenses.push(snapshot);
        state.activity = state.activity.filter(function (a) { return a.id !== activityEntry.id; });
        notify();
        notifySyncStatus('error', 'Could not delete the expense: ' + errMsg(err));
      });

      return { ok: true };
    },

    ADD_SETTLEMENT: function (payload, client, user) {
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

      var tempId = SW.Model.uid('e');
      var settlement = {
        id: tempId,
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
      var activityEntry = addActivity(
        'settlement',
        fromMember.name + ' paid ' + toMember.name + ' ' + SW.Model.formatMoney(payload.amountCents, group.currency) + '.'
      );
      notifySyncStatus('saving', 'Saving…');

      writeExpense(client, user, settlement, tempId, activityEntry.id);

      return { ok: true, expenseId: tempId };
    },
  };

  // ---------------------------------------------------------------------
  // public API
  // ---------------------------------------------------------------------

  function init() {
    return new Promise(function (resolve) {
      unsubscribeRealtime();
      state = emptyState();

      var client = SW.Auth && SW.Auth.client ? SW.Auth.client() : null;
      var user = SW.Auth && SW.Auth.getUser ? SW.Auth.getUser() : null;
      if (!client || !user) {
        notify();
        resolve();
        return;
      }

      state.ui.currentUserId = user.id;
      watchAuthChanges();

      client.from('groups').select('*').then(function (res) {
        if (res.error) throw res.error;
        var groupRows = res.data || [];
        return loadGroupsAndExpenses(client, groupRows).then(function (result) {
          state.groups = result.groups;
          state.expenses = result.expenses;
          state.activity = buildActivityFromExpenses(result.expenses, result.groups);
          if (!state.groups.some(function (g) { return g.id === state.ui.currentGroupId; })) {
            state.ui.currentGroupId = state.groups.length ? state.groups[0].id : null;
          }
          subscribeRealtime(client);
          notify();
          resolve();
        });
      }).catch(function (err) {
        notifySyncStatus('error', 'Could not load your groups: ' + errMsg(err));
        notify();
        resolve();
      });
    });
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

  function onSyncStatus(fn) {
    if (typeof fn !== 'function') return function () {};
    syncListeners.push(fn);
    return function unsubscribe() {
      syncListeners = syncListeners.filter(function (l) { return l !== fn; });
    };
  }

  function notifySyncStatus(stateName, message) {
    syncListeners.forEach(function (fn) {
      try {
        fn({ state: stateName, message: message || '' });
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
      // hasOwnProperty rather than a plain lookup - see SW.Store.dispatch
      // for why (inherited names like "toString" would otherwise match).
      if (!Object.prototype.hasOwnProperty.call(handlers, action.type)) {
        return { ok: false, error: 'Unknown action type: ' + action.type };
      }
      var handler = handlers[action.type];
      if (typeof handler !== 'function') {
        return { ok: false, error: 'Unknown action type: ' + action.type };
      }

      var client = SW.Auth && SW.Auth.client ? SW.Auth.client() : null;
      var user = SW.Auth && SW.Auth.getUser ? SW.Auth.getUser() : null;
      if (!client || !user) {
        return { ok: false, error: 'You are not signed in.' };
      }

      var result = handler(action.payload || {}, client, user);
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        return { ok: false, error: 'Handler for ' + action.type + ' returned no result.' };
      }
      if (result.ok) notify();
      return result;
    } catch (err) {
      return { ok: false, error: 'Unexpected error: ' + (err && err.message ? err.message : String(err)) };
    }
  }

  function exportJSON() {
    return JSON.stringify(state, null, 2);
  }

  // Clears the in-memory cache only - this never deletes anything on the
  // server. Also tears down the realtime subscription, since a reset is
  // how the app tells this module "stop caring about the signed-in user's
  // data" (e.g. on sign-out).
  function reset() {
    unsubscribeRealtime();
    state = emptyState();
    notify();
  }

  return {
    init: init,
    getState: getState,
    subscribe: subscribe,
    dispatch: dispatch,
    exportJSON: exportJSON,
    reset: reset,
    onSyncStatus: onSyncStatus,
  };
})();
