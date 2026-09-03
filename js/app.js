// ============================================================================
// Splitwise Clone — App UI (Agent B)
//
// This file wires the DOM (index.html) to the pure logic in js/model.js and
// the state container in js/store.js. It never touches localStorage directly
// and never mutates state by hand — every change goes through
// store().dispatch(). Whenever the store changes, store().subscribe(render)
// re-renders the parts of the page that depend on state, so the UI is always
// a reflection of "state + a little bit of local UI-only state" (which modal
// is open, which expense row is expanded, what the in-progress expense form
// looks like).
// ============================================================================

var SW = SW || {};
SW.App = SW.App || {};

(function () {
  'use strict';

  // --------------------------------------------------------------------
  // Tiny DOM helpers
  // --------------------------------------------------------------------

  // qs/qsa are short for querySelector / querySelectorAll (scoped to an
  // optional root element, defaulting to the whole document).
  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  // esc() escapes a value so it is safe to drop into innerHTML. We never
  // insert a user-supplied string (group name, member name, description,
  // note...) into the page without passing it through this first.
  //
  // It escapes the five characters that matter in HTML. The quotes are the
  // important part: this string gets dropped into attribute values like
  // aria-label="..." and value="...", and a stray double quote there would
  // let a crafted member name close the attribute and add its own event
  // handler. (Escaping via a detached element's textContent looks tidier
  // but only escapes & < >, which is exactly the hole described above.)
  function esc(value) {
    if (value === null || value === undefined) {
      return '';
    }
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var CATEGORY_ICONS = {
    general: '🧾',
    food: '🍔',
    rent: '🏠',
    transport: '🚗',
    fun: '🎉',
    utilities: '💡',
    travel: '✈️'
  };

  function todayISO() {
    var d = new Date();
    var mm = String(d.getMonth() + 1);
    if (mm.length < 2) mm = '0' + mm;
    var dd = String(d.getDate());
    if (dd.length < 2) dd = '0' + dd;
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  // Turns "2026-09-03" into "Sep 3, 2026" for friendlier display.
  function formatDateDisplay(iso) {
    if (!iso) return '';
    var parts = iso.split('-');
    if (parts.length !== 3) return iso;
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var monthIndex = parseInt(parts[1], 10) - 1;
    var day = parseInt(parts[2], 10);
    var monthName = months[monthIndex] || parts[1];
    return monthName + ' ' + day + ', ' + parts[0];
  }

  // --------------------------------------------------------------------
  // Local, non-persisted UI state.
  //
  // Everything the *store* owns (groups, expenses, current group/user)
  // flows in through render(state). Everything below is purely about how
  // the page currently looks (which row is expanded, what's typed into a
  // still-open form) and lives only in memory.
  // --------------------------------------------------------------------
  var ui = {
    expandedExpenseIds: {},    // expenseId -> true, for the expandable rows
    editingExpenseId: null,    // set while the expense modal is in edit mode
    splitMode: 'equal',        // active tab in the expense modal
    selectedParticipants: {},  // memberId -> true, checkboxes in the expense modal
    participantValues: {},     // memberId -> raw string typed for exact/percent/shares
    lastFocusedEl: null        // element to restore focus to when a modal closes
  };

  // --------------------------------------------------------------------
  // Which store is live.
  //
  // Two stores implement the same API: SW.Store keeps everything in this
  // browser's localStorage, and SW.RemoteStore keeps it in Supabase so a
  // whole friend group shares one set of books. Everything below this point
  // goes through store() and does not care which one it got.
  // --------------------------------------------------------------------
  var activeStore = null;

  function store() {
    return activeStore || SW.Store;
  }

  function isRemote() {
    return !!(SW.RemoteStore && activeStore === SW.RemoteStore);
  }

  // True when there is a Supabase project configured to talk to at all.
  function backendAvailable() {
    return !!(window.SW && SW.Config && SW.Config.isConfigured() && SW.Auth && SW.Auth.client());
  }

  var lastState = null;              // most recent state passed to render()
  var currentGroupForModal = null;   // group the expense modal is currently editing for
  var currentGroupForSettle = null;  // group the settle-up modal is currently open for
  var openModalStack = [];           // overlay elements currently open, for focus trapping

  // --------------------------------------------------------------------
  // Toasts
  // --------------------------------------------------------------------
  function showToast(message, opts) {
    opts = opts || {};
    var region = qs('#toastRegion');
    var toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');

    var msgEl = document.createElement('span');
    msgEl.textContent = message;
    toastEl.appendChild(msgEl);

    var timeoutId;
    if (typeof opts.undo === 'function') {
      var undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.textContent = 'Undo';
      undoBtn.addEventListener('click', function () {
        clearTimeout(timeoutId);
        toastEl.remove();
        opts.undo();
      });
      toastEl.appendChild(undoBtn);
    }

    region.appendChild(toastEl);
    timeoutId = setTimeout(function () {
      toastEl.remove();
    }, opts.duration || 5000);
  }

  // --------------------------------------------------------------------
  // Generic modal open/close with a focus trap.
  // --------------------------------------------------------------------
  function getFocusable(container) {
    return qsa(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      container
    ).filter(function (el) {
      return el.offsetParent !== null;
    });
  }

  function trapKeydown(e) {
    if (e.key !== 'Tab') return;
    var overlay = openModalStack[openModalStack.length - 1];
    if (!overlay) return;
    var focusable = getFocusable(overlay);
    if (focusable.length === 0) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function openModal(overlay) {
    ui.lastFocusedEl = document.activeElement;
    overlay.hidden = false;
    openModalStack.push(overlay);
    document.addEventListener('keydown', trapKeydown);
  }

  function closeModal(overlay) {
    overlay.hidden = true;
    openModalStack = openModalStack.filter(function (o) {
      return o !== overlay;
    });
    if (openModalStack.length === 0) {
      document.removeEventListener('keydown', trapKeydown);
    }
    if (ui.lastFocusedEl && typeof ui.lastFocusedEl.focus === 'function') {
      ui.lastFocusedEl.focus();
    }
  }

  function closeTopModal() {
    var overlay = openModalStack[openModalStack.length - 1];
    if (overlay) closeModal(overlay);
  }

  // --------------------------------------------------------------------
  // Small state lookups shared by several render functions
  // --------------------------------------------------------------------
  function getCurrentGroup(state) {
    if (!state || !state.ui || !state.ui.currentGroupId) return null;
    return (
      state.groups.find(function (g) {
        return g.id === state.ui.currentGroupId;
      }) || null
    );
  }

  function makeMemberNameLookup(group) {
    var byId = {};
    group.members.forEach(function (m) {
      byId[m.id] = m.name;
    });
    return function (memberId) {
      return byId[memberId] || 'Unknown';
    };
  }

  function computeExpenseSplit(expense) {
    var result = SW.Model.splitExpense(expense.amountCents, expense.splitMode, expense.participants);
    return result.ok ? result.shares : [];
  }

  // ========================================================================
  // RENDER — the whole app is re-drawn from state on every store change.
  // ========================================================================

  function render(state) {
    lastState = state;
    renderHeader(state);
    renderSidebar(state);
    renderMain(state);
  }

  // ---- Header: current-user selector -------------------------------------
  function renderHeader(state) {
    var select = qs('#currentUserSelect');
    var group = getCurrentGroup(state);
    if (!group) {
      select.innerHTML = '<option value="">No group selected</option>';
      select.disabled = true;
      return;
    }
    select.disabled = false;
    select.innerHTML = group.members
      .map(function (m) {
        return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>';
      })
      .join('');
    var hasCurrent = group.members.some(function (m) {
      return m.id === state.ui.currentUserId;
    });
    select.value = hasCurrent ? state.ui.currentUserId : group.members.length > 0 ? group.members[0].id : '';
  }

  // ---- Sidebar: group list -------------------------------------------------
  function renderSidebar(state) {
    var listEl = qs('#groupList');

    if (state.groups.length === 0) {
      listEl.innerHTML = '<li class="group-sub" style="padding:10px 12px;">No groups yet.</li>';
      return;
    }

    listEl.innerHTML = state.groups
      .map(function (g) {
        var balances = SW.Model.computeBalances(g.id, state.groups, state.expenses);
        var net = state.ui.currentUserId != null ? balances[state.ui.currentUserId] : undefined;
        var figureHtml = '<span class="group-balance-figure zero">—</span>';
        if (net !== undefined) {
          var cls = net > 0 ? 'positive' : net < 0 ? 'negative' : 'zero';
          figureHtml =
            '<span class="group-balance-figure ' + cls + '">' + esc(SW.Model.formatSigned(net, g.currency)) + '</span>';
        }
        var active = g.id === state.ui.currentGroupId;
        return (
          '<li class="group-list-item' +
          (active ? ' active' : '') +
          '">' +
          '<button type="button" class="group-btn" data-id="' +
          esc(g.id) +
          '">' +
          '<span class="group-name-row"><span class="gname">' +
          esc(g.name) +
          '</span>' +
          figureHtml +
          '</span>' +
          '<span class="group-sub">' +
          g.members.length +
          ' members · ' +
          esc(g.currency) +
          '</span>' +
          '</button>' +
          '</li>'
        );
      })
      .join('');

    qsa('.group-btn', listEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        store().dispatch({ type: 'SELECT_GROUP', payload: { groupId: btn.getAttribute('data-id') } });
      });
    });
  }

  // ---- Main panel: empty states or the group view --------------------------
  function renderMain(state) {
    var mainEl = qs('#mainPanel');

    if (state.groups.length === 0) {
      mainEl.innerHTML = renderNoGroupsEmptyState();
      wireNoGroupsEmptyState();
      return;
    }

    var group = getCurrentGroup(state);
    if (!group) {
      mainEl.innerHTML =
        '<div class="empty-state"><div class="empty-icon">👈</div><h3>Select a group</h3>' +
        '<p>Choose a group from the sidebar to see its expenses and balances.</p></div>';
      return;
    }

    // Replacing innerHTML resets scrollTop, which would otherwise throw the
    // reader back to the top of a long expense list every time anything
    // changed - including just expanding a row to see its breakdown.
    var previousScroll = mainEl.scrollTop;
    mainEl.innerHTML = renderGroupViewHTML(group, state);
    wireGroupView(group, state);
    mainEl.scrollTop = previousScroll;
  }

  function renderNoGroupsEmptyState() {
    return (
      '<div class="empty-state">' +
      '<div class="empty-icon">👥</div>' +
      '<h3>No groups yet</h3>' +
      '<p>Create a group to start splitting expenses with friends.</p>' +
      '<button type="button" class="btn btn-primary" id="emptyNewGroupBtn">+ New group</button>' +
      '</div>'
    );
  }

  function wireNoGroupsEmptyState() {
    var btn = qs('#emptyNewGroupBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        qs('#newGroupBtn').click();
      });
    }
  }

  // ---- Group view -----------------------------------------------------------
  function renderGroupViewHTML(group, state) {
    var totals = SW.Model.groupTotals(group.id, state.groups, state.expenses);
    var expenses = state.expenses.filter(function (e) {
      return e.groupId === group.id;
    });

    return (
      '<div class="group-view-header">' +
      '<div>' +
      '<h1 id="groupNameHeading">' +
      esc(group.name) +
      ' <button type="button" class="icon-btn" id="renameGroupBtn" aria-label="Rename group">✏️</button>' +
      ' <button type="button" class="icon-btn" id="deleteGroupBtn" aria-label="Delete group">🗑️</button>' +
      '</h1>' +
      '<div class="member-chips">' +
      renderMemberChips(group) +
      '</div>' +
      '<div class="group-meta">' +
      esc(group.currency) +
      ' · Total spent: ' +
      esc(SW.Model.formatMoney(totals.totalSpentCents, group.currency)) +
      ' · ' +
      totals.expenseCount +
      ' expense' +
      (totals.expenseCount === 1 ? '' : 's') +
      (totals.settlementCount ? ' · ' + totals.settlementCount + ' settlement' + (totals.settlementCount === 1 ? '' : 's') : '') +
      '</div>' +
      '</div>' +
      '<div class="group-actions">' +
      '<button type="button" class="btn" id="settleUpBtn">Settle up</button>' +
      '<button type="button" class="btn btn-primary" id="addExpenseBtn">+ Add expense</button>' +
      '</div>' +
      '</div>' +
      '<div class="panels-row">' +
      renderBalancesPanel(group, state) +
      renderSettlementsPanel(group, state) +
      '</div>' +
      '<div class="panel">' +
      '<h2>Expenses</h2>' +
      renderExpenseList(group, expenses) +
      '</div>'
    );
  }

  function renderMemberChips(group) {
    var chips = group.members
      .map(function (m) {
        return (
          '<span class="chip">' +
          esc(m.name) +
          ' <button type="button" class="icon-btn remove-member-btn" data-member="' +
          esc(m.id) +
          '" aria-label="Remove ' +
          esc(m.name) +
          '" style="width:18px;height:18px;font-size:11px;">✕</button></span>'
        );
      })
      .join('');
    // Offline you invent members by typing a name. Signed in, a member is a
    // real account, so the only way to add one is to share the invite code.
    var action = isRemote()
      ? ' <button type="button" class="btn btn-sm" id="inviteMemberBtn">Invite</button>'
      : ' <button type="button" class="btn btn-sm" id="addMemberBtn">+ Member</button>';
    return chips + action;
  }

  function renderBalancesPanel(group, state) {
    var balances = SW.Model.computeBalances(group.id, state.groups, state.expenses);
    var rows = group.members
      .map(function (m) {
        var net = balances[m.id] || 0;
        var cls = net > 0 ? 'positive' : net < 0 ? 'negative' : 'zero';
        return (
          '<div class="balance-row"><span>' +
          esc(m.name) +
          '</span><span class="balance-figure ' +
          cls +
          '">' +
          esc(SW.Model.formatSigned(net, group.currency)) +
          '</span></div>'
        );
      })
      .join('');
    return '<div class="panel"><h2>Balances</h2>' + rows + '</div>';
  }

  function renderSettlementsPanel(group, state) {
    var balances = SW.Model.computeBalances(group.id, state.groups, state.expenses);
    var suggestions = SW.Model.simplifyDebts(balances);
    var memberName = makeMemberNameLookup(group);

    if (suggestions.length === 0) {
      return '<div class="panel"><h2>Suggested settlements</h2><p class="hint">Everyone is settled up. 🎉</p></div>';
    }

    var rows = suggestions
      .map(function (s, idx) {
        return (
          '<div class="settlement-row">' +
          '<span>' +
          esc(memberName(s.from)) +
          ' → ' +
          esc(memberName(s.to)) +
          ': ' +
          esc(SW.Model.formatMoney(s.amountCents, group.currency)) +
          '</span>' +
          '<button type="button" class="btn btn-sm record-settlement-btn" data-idx="' +
          idx +
          '">Record</button>' +
          '</div>'
        );
      })
      .join('');
    return '<div class="panel"><h2>Suggested settlements</h2>' + rows + '</div>';
  }

  function renderExpenseList(group, expenses) {
    if (expenses.length === 0) {
      return (
        '<div class="empty-state">' +
        '<div class="empty-icon">🧾</div>' +
        '<h3>No expenses yet</h3>' +
        '<p>Add your first expense to start splitting costs.</p>' +
        '<button type="button" class="btn btn-primary" id="emptyAddExpenseBtn">Add expense</button>' +
        '</div>'
      );
    }

    var sorted = expenses.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    var memberName = makeMemberNameLookup(group);
    var rows = sorted
      .map(function (e) {
        return renderExpenseRow(group, e, memberName);
      })
      .join('');
    return '<ul class="expense-list">' + rows + '</ul>';
  }

  function renderExpenseRow(group, expense, memberName) {
    if (expense.type === 'settlement') {
      var receiver = expense.participants[0] || {};
      var text =
        memberName(expense.paidBy) + ' paid ' + memberName(receiver.memberId) + ' ' + SW.Model.formatMoney(expense.amountCents, group.currency);
      return (
        '<li class="expense-item settlement-item">' +
        '<div class="expense-row" data-id="' +
        esc(expense.id) +
        '">' +
        '<div class="expense-icon" aria-hidden="true">🤝</div>' +
        '<div class="expense-main"><div class="expense-desc">' +
        esc(text) +
        '</div>' +
        '<div class="expense-sub">' +
        esc(formatDateDisplay(expense.date)) +
        ' · Settlement</div></div>' +
        '<div class="expense-row-actions">' +
        '<button type="button" class="icon-btn expense-delete-btn" data-id="' +
        esc(expense.id) +
        '" aria-label="Delete settlement">🗑️</button>' +
        '</div>' +
        '</div>' +
        '</li>'
      );
    }

    var expanded = !!ui.expandedExpenseIds[expense.id];
    var shares = computeExpenseSplit(expense);
    var shareByMember = {};
    shares.forEach(function (s) {
      shareByMember[s.memberId] = s.shareCents;
    });
    var icon = CATEGORY_ICONS[expense.category] || CATEGORY_ICONS.general;
    var currentUserId = lastState && lastState.ui ? lastState.ui.currentUserId : null;

    var shareText = 'Not involved';
    var shareClass = '';
    var involved = currentUserId != null && (shareByMember.hasOwnProperty(currentUserId) || expense.paidBy === currentUserId);
    if (involved) {
      var paidPart = expense.paidBy === currentUserId ? expense.amountCents : 0;
      var owedPart = shareByMember[currentUserId] || 0;
      var net = paidPart - owedPart;
      if (net > 0) {
        shareText = 'You lent ' + SW.Model.formatMoney(net, group.currency);
        shareClass = 'positive';
      } else if (net < 0) {
        shareText = 'You owe ' + SW.Model.formatMoney(-net, group.currency);
        shareClass = 'negative';
      } else {
        shareText = 'Settled';
      }
    }

    var detail = expanded ? renderExpenseDetail(expense, shares, memberName) : '';

    return (
      '<li class="expense-item">' +
      '<div class="expense-row" data-id="' +
      esc(expense.id) +
      '" role="button" tabindex="0" aria-expanded="' +
      (expanded ? 'true' : 'false') +
      '">' +
      '<div class="expense-icon" aria-hidden="true">' +
      icon +
      '</div>' +
      '<div class="expense-main">' +
      '<div class="expense-desc">' +
      esc(expense.description) +
      '</div>' +
      '<div class="expense-sub">' +
      esc(memberName(expense.paidBy)) +
      ' paid ' +
      esc(SW.Model.formatMoney(expense.amountCents, group.currency)) +
      ' · ' +
      esc(formatDateDisplay(expense.date)) +
      '</div>' +
      '</div>' +
      '<div class="expense-amounts">' +
      '<div class="expense-amount">' +
      esc(SW.Model.formatMoney(expense.amountCents, group.currency)) +
      '</div>' +
      '<div class="expense-share ' +
      shareClass +
      '">' +
      esc(shareText) +
      '</div>' +
      '</div>' +
      '<div class="expense-row-actions">' +
      '<button type="button" class="icon-btn expense-edit-btn" data-id="' +
      esc(expense.id) +
      '" aria-label="Edit expense">✏️</button>' +
      '<button type="button" class="icon-btn expense-delete-btn" data-id="' +
      esc(expense.id) +
      '" aria-label="Delete expense">🗑️</button>' +
      '</div>' +
      '</div>' +
      detail +
      '</li>'
    );
  }

  function renderExpenseDetail(expense, shares, memberName) {
    var rows = shares
      .map(function (s) {
        return (
          '<div class="expense-detail-row"><span>' +
          esc(memberName(s.memberId)) +
          '</span><span>' +
          esc(SW.Model.formatMoney(s.shareCents, lastState && getCurrentGroup(lastState) ? getCurrentGroup(lastState).currency : 'EUR')) +
          '</span></div>'
        );
      })
      .join('');
    var note = expense.note ? '<div class="note">' + esc(expense.note) + '</div>' : '';
    return (
      '<div class="expense-detail">' +
      '<div class="expense-detail-row"><strong>Split (' +
      esc(expense.splitMode) +
      ')</strong><span></span></div>' +
      rows +
      note +
      '</div>'
    );
  }

  // ---- Wiring for the group view (buttons that only exist once the group
  // view HTML has been injected) -------------------------------------------
  function wireGroupView(group, state) {
    var mainEl = qs('#mainPanel');

    var addBtn = qs('#addExpenseBtn');
    if (addBtn) addBtn.addEventListener('click', function () { openExpenseModal(group, null); });

    var settleBtn = qs('#settleUpBtn');
    if (settleBtn) settleBtn.addEventListener('click', function () { openSettleModal(group); });

    var emptyAddBtn = qs('#emptyAddExpenseBtn');
    if (emptyAddBtn) emptyAddBtn.addEventListener('click', function () { openExpenseModal(group, null); });

    var renameBtn = qs('#renameGroupBtn');
    if (renameBtn) {
      renameBtn.addEventListener('click', function () {
        var name = window.prompt('Rename group', group.name);
        if (name === null) return;
        var trimmed = name.trim();
        if (!trimmed) return;
        var result = store().dispatch({ type: 'RENAME_GROUP', payload: { groupId: group.id, name: trimmed } });
        showToast(result && result.ok ? 'Group renamed' : (result && result.error) || 'Could not rename group.');
      });
    }

    var deleteBtn = qs('#deleteGroupBtn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', function () {
        if (!window.confirm('Delete "' + group.name + '" and all its expenses? This cannot be undone.')) return;
        var result = store().dispatch({ type: 'DELETE_GROUP', payload: { groupId: group.id } });
        showToast(result && result.ok ? 'Group deleted' : (result && result.error) || 'Could not delete group.');
      });
    }

    // Shared mode swaps "+ Member" for "Invite", since a member is an
    // account that has to join rather than a name you can type in.
    var inviteBtn = qs('#inviteMemberBtn');
    if (inviteBtn) {
      inviteBtn.addEventListener('click', function () {
        openInviteModal(group);
      });
    }

    var addMemberBtn = qs('#addMemberBtn');
    if (addMemberBtn) {
      addMemberBtn.addEventListener('click', function () {
        var name = window.prompt('New member name');
        if (name === null) return;
        var trimmed = name.trim();
        if (!trimmed) return;
        var result = store().dispatch({ type: 'ADD_MEMBER', payload: { groupId: group.id, name: trimmed } });
        showToast(result && result.ok ? 'Member added' : (result && result.error) || 'Could not add member.');
      });
    }

    qsa('.remove-member-btn', mainEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var memberId = btn.getAttribute('data-member');
        // The local store calls it memberId, the remote store userId (there
        // it really is an auth user id). Sending both keeps one call site.
        var result = store().dispatch({
          type: 'REMOVE_MEMBER',
          payload: { groupId: group.id, memberId: memberId, userId: memberId }
        });
        showToast(result && result.ok ? 'Member removed' : (result && result.error) || 'Cannot remove: member appears in an expense.');
      });
    });

    // Suggested settlements — recompute so button index maps back to a suggestion.
    var balances = SW.Model.computeBalances(group.id, state.groups, state.expenses);
    var suggestions = SW.Model.simplifyDebts(balances);
    qsa('.record-settlement-btn', mainEl).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-idx'), 10);
        var s = suggestions[idx];
        if (!s) return;
        var result = store().dispatch({
          type: 'ADD_SETTLEMENT',
          payload: { groupId: group.id, from: s.from, to: s.to, amountCents: s.amountCents, date: todayISO() }
        });
        showToast(result && result.ok ? 'Settlement recorded' : (result && result.error) || 'Could not record settlement.');
      });
    });

    qsa('.expense-row[role="button"]', mainEl).forEach(function (row) {
      row.addEventListener('click', function () {
        var id = row.getAttribute('data-id');
        ui.expandedExpenseIds[id] = !ui.expandedExpenseIds[id];
        renderMain(lastState);
      });
      row.addEventListener('keydown', function (evt) {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          row.click();
        }
      });
    });

    qsa('.expense-edit-btn', mainEl).forEach(function (btn) {
      btn.addEventListener('click', function (evt) {
        evt.stopPropagation();
        var id = btn.getAttribute('data-id');
        var expense = state.expenses.find(function (e) { return e.id === id; });
        if (expense) openExpenseModal(group, expense);
      });
    });

    qsa('.expense-delete-btn', mainEl).forEach(function (btn) {
      btn.addEventListener('click', function (evt) {
        evt.stopPropagation();
        deleteExpenseWithUndo(btn.getAttribute('data-id'));
      });
    });
  }

  function deleteExpenseWithUndo(expenseId) {
    var state = store().getState();
    var expense = state.expenses.find(function (e) { return e.id === expenseId; });
    if (!expense) return;

    var result = store().dispatch({ type: 'DELETE_EXPENSE', payload: { expenseId: expenseId } });
    if (!result || !result.ok) {
      showToast((result && result.error) || 'Could not delete.');
      return;
    }

    showToast(expense.type === 'settlement' ? 'Settlement deleted' : 'Expense deleted', {
      undo: function () {
        var restored;
        if (expense.type === 'settlement') {
          var receiver = expense.participants[0] || {};
          restored = store().dispatch({
            type: 'ADD_SETTLEMENT',
            payload: {
              groupId: expense.groupId,
              from: expense.paidBy,
              to: receiver.memberId,
              amountCents: expense.amountCents,
              date: expense.date
            }
          });
        } else {
          restored = store().dispatch({
            type: 'ADD_EXPENSE',
            payload: {
              groupId: expense.groupId,
              description: expense.description,
              amountCents: expense.amountCents,
              paidBy: expense.paidBy,
              splitMode: expense.splitMode,
              participants: expense.participants,
              category: expense.category,
              date: expense.date,
              note: expense.note
            }
          });
        }
        // Restoring can legitimately fail - e.g. a member involved in this
        // expense was removed between the delete and the undo. Saying
        // "Restored" regardless would be a lie.
        if (restored && restored.ok) {
          showToast('Restored');
        } else {
          showToast((restored && restored.error) || 'Could not restore.');
        }
      }
    });
  }

  // ========================================================================
  // Add / Edit expense modal
  // ========================================================================

  function buildParticipantsArray() {
    var ids = Object.keys(ui.selectedParticipants).filter(function (id) {
      return ui.selectedParticipants[id];
    });
    return ids.map(function (id) {
      var raw = ui.participantValues[id];
      var value = 1;
      if (ui.splitMode === 'exact') {
        var cents = SW.Model.parseAmount(raw || '');
        value = cents === null ? 0 : cents;
      } else if (ui.splitMode === 'percent' || ui.splitMode === 'shares') {
        var num = parseFloat(raw);
        value = isNaN(num) ? 0 : num;
      }
      return { memberId: id, value: value };
    });
  }

  function renderParticipantsList(group) {
    var container = qs('#participantsList');
    var mode = ui.splitMode;

    container.innerHTML = group.members
      .map(function (m) {
        var checked = !!ui.selectedParticipants[m.id];
        var valueInput = '';
        if (mode !== 'equal') {
          var raw = ui.participantValues[m.id] != null ? ui.participantValues[m.id] : '';
          var placeholder = mode === 'percent' ? '%' : mode === 'shares' ? 'shares' : '0.00';
          valueInput =
            '<input type="text" inputmode="decimal" class="value-input" data-member="' +
            esc(m.id) +
            '" value="' +
            esc(raw) +
            '" placeholder="' +
            esc(placeholder) +
            '" ' +
            (checked ? '' : 'disabled') +
            ' aria-label="' +
            esc(m.name) +
            ' ' +
            esc(mode) +
            ' value" />';
        }
        return (
          '<div class="participant-row">' +
          '<label><input type="checkbox" class="participant-check" data-member="' +
          esc(m.id) +
          '" ' +
          (checked ? 'checked' : '') +
          ' /> ' +
          esc(m.name) +
          '</label>' +
          valueInput +
          '</div>'
        );
      })
      .join('');

    qsa('.participant-check', container).forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = cb.getAttribute('data-member');
        ui.selectedParticipants[id] = cb.checked;
        if (cb.checked && ui.splitMode === 'shares' && !ui.participantValues[id]) {
          ui.participantValues[id] = '1';
        }
        renderParticipantsList(group);
        updateSplitPreview(group);
      });
    });

    qsa('.value-input', container).forEach(function (inp) {
      inp.addEventListener('input', function () {
        var id = inp.getAttribute('data-member');
        ui.participantValues[id] = inp.value;
        updateSplitPreview(group);
      });
    });
  }

  function updateSplitPreview(group) {
    var amountCents = SW.Model.parseAmount(qs('#expenseAmountInput').value || '');
    var participants = buildParticipantsArray();
    var previewEl = qs('#splitPreview');
    var errorEl = qs('#expenseFormError');
    var submitBtn = qs('#expenseSubmitBtn');

    if (amountCents === null) {
      previewEl.innerHTML = '<em>Enter a valid amount to see the split preview.</em>';
      errorEl.textContent = '';
      submitBtn.disabled = true;
      return;
    }
    if (participants.length === 0) {
      previewEl.innerHTML = '<em>Select at least one participant.</em>';
      errorEl.textContent = '';
      submitBtn.disabled = true;
      return;
    }

    var draft = {
      description: qs('#expenseDescInput').value.trim(),
      amountCents: amountCents,
      paidBy: qs('#expensePaidBySelect').value,
      splitMode: ui.splitMode,
      participants: participants,
      category: qs('#expenseCategorySelect').value,
      date: qs('#expenseDateInput').value
    };

    var validation = SW.Model.validateExpense(draft, group);
    var split = SW.Model.splitExpense(amountCents, ui.splitMode, participants);

    if (split.ok) {
      var byId = {};
      group.members.forEach(function (m) { byId[m.id] = m.name; });
      var items = split.shares
        .map(function (s) {
          return '<li>' + esc(byId[s.memberId] || '?') + ': ' + esc(SW.Model.formatMoney(s.shareCents, group.currency)) + '</li>';
        })
        .join('');
      previewEl.innerHTML = '<strong>Split preview</strong><ul>' + items + '</ul>';
    } else {
      previewEl.innerHTML = '<em>' + esc(split.error || 'Unable to compute split.') + '</em>';
    }

    if (!validation.ok) {
      errorEl.textContent = validation.errors.join(' · ');
    } else if (!split.ok) {
      errorEl.textContent = split.error || 'Unable to compute split.';
    } else {
      errorEl.textContent = '';
    }

    submitBtn.disabled = !(validation.ok && split.ok);
  }

  function openExpenseModal(group, expense) {
    currentGroupForModal = group;
    ui.editingExpenseId = expense ? expense.id : null;
    ui.splitMode = expense ? expense.splitMode : 'equal';
    ui.selectedParticipants = {};
    ui.participantValues = {};

    if (expense) {
      expense.participants.forEach(function (p) {
        ui.selectedParticipants[p.memberId] = true;
        if (expense.splitMode === 'exact') {
          ui.participantValues[p.memberId] = (p.value / 100).toFixed(2);
        } else {
          ui.participantValues[p.memberId] = String(p.value);
        }
      });
    } else {
      group.members.forEach(function (m) {
        ui.selectedParticipants[m.id] = true;
      });
    }

    qs('#expenseModalTitle').textContent = expense ? 'Edit expense' : 'Add expense';
    qs('#expenseSubmitBtn').textContent = expense ? 'Save changes' : 'Save expense';
    qs('#expenseIdInput').value = expense ? expense.id : '';
    qs('#expenseDescInput').value = expense ? expense.description : '';
    qs('#expenseAmountInput').value = expense ? (expense.amountCents / 100).toFixed(2) : '';
    qs('#expenseCategorySelect').value = expense ? expense.category : 'general';
    qs('#expenseDateInput').value = expense ? expense.date : todayISO();
    qs('#expenseNoteInput').value = expense ? expense.note || '' : '';
    qs('#expenseFormError').textContent = '';

    var payerSelect = qs('#expensePaidBySelect');
    payerSelect.innerHTML = group.members
      .map(function (m) {
        return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>';
      })
      .join('');
    var fallbackPayer =
      lastState && lastState.ui && group.members.some(function (m) { return m.id === lastState.ui.currentUserId; })
        ? lastState.ui.currentUserId
        : group.members[0].id;
    payerSelect.value = expense ? expense.paidBy : fallbackPayer;

    qsa('.split-tab', qs('#splitTabs')).forEach(function (t) {
      var active = t.getAttribute('data-mode') === ui.splitMode;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    renderParticipantsList(group);
    updateSplitPreview(group);

    openModal(qs('#expenseModalOverlay'));
    qs('#expenseDescInput').focus();
  }

  // ========================================================================
  // Settle up modal
  // ========================================================================

  function openSettleModal(group) {
    currentGroupForSettle = group;
    var fromSelect = qs('#settleFromSelect');
    var toSelect = qs('#settleToSelect');
    var options = group.members
      .map(function (m) {
        return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>';
      })
      .join('');
    fromSelect.innerHTML = options;
    toSelect.innerHTML = options;
    if (group.members.length > 1) {
      fromSelect.value = group.members[0].id;
      toSelect.value = group.members[1].id;
    }
    qs('#settleAmountInput').value = '';
    qs('#settleDateInput').value = todayISO();
    qs('#settleFormError').textContent = '';
    openModal(qs('#settleModalOverlay'));
    fromSelect.focus();
  }

  // ========================================================================
  // One-time event wiring (elements that already exist in index.html)
  // ========================================================================

  function wireStaticEvents() {
    // Modal close buttons + overlay click-outside-to-close.
    qsa('[data-close-modal]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var overlay = btn.closest('.modal-overlay');
        if (overlay) closeModal(overlay);
      });
    });
    qsa('.modal-overlay').forEach(function (overlay) {
      overlay.addEventListener('mousedown', function (e) {
        if (e.target === overlay) closeModal(overlay);
      });
    });

    // Split-mode tabs inside the expense modal.
    qsa('.split-tab', qs('#splitTabs')).forEach(function (tab) {
      tab.addEventListener('click', function () {
        if (!currentGroupForModal) return;
        ui.splitMode = tab.getAttribute('data-mode');
        qsa('.split-tab', qs('#splitTabs')).forEach(function (t) {
          var active = t === tab;
          t.classList.toggle('active', active);
          t.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        if (ui.splitMode === 'shares') {
          Object.keys(ui.selectedParticipants).forEach(function (id) {
            if (ui.selectedParticipants[id] && !ui.participantValues[id]) ui.participantValues[id] = '1';
          });
        }
        renderParticipantsList(currentGroupForModal);
        updateSplitPreview(currentGroupForModal);
      });
    });

    // Any change to the top-level expense fields refreshes the live preview.
    ['expenseAmountInput', 'expenseDescInput', 'expensePaidBySelect', 'expenseCategorySelect', 'expenseDateInput'].forEach(function (id) {
      var el = qs('#' + id);
      el.addEventListener('input', function () {
        if (currentGroupForModal) updateSplitPreview(currentGroupForModal);
      });
      el.addEventListener('change', function () {
        if (currentGroupForModal) updateSplitPreview(currentGroupForModal);
      });
    });

    qs('#expenseForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var group = currentGroupForModal;
      if (!group) return;

      var amountCents = SW.Model.parseAmount(qs('#expenseAmountInput').value);
      var participants = buildParticipantsArray();
      var payload = {
        description: qs('#expenseDescInput').value.trim(),
        amountCents: amountCents,
        paidBy: qs('#expensePaidBySelect').value,
        splitMode: ui.splitMode,
        participants: participants,
        category: qs('#expenseCategorySelect').value,
        date: qs('#expenseDateInput').value,
        note: qs('#expenseNoteInput').value.trim()
      };

      var result;
      if (ui.editingExpenseId) {
        result = store().dispatch({ type: 'UPDATE_EXPENSE', payload: { expenseId: ui.editingExpenseId, patch: payload } });
      } else {
        payload.groupId = group.id;
        result = store().dispatch({ type: 'ADD_EXPENSE', payload: payload });
      }

      if (!result || !result.ok) {
        qs('#expenseFormError').textContent = (result && result.error) || 'Could not save expense.';
        return;
      }

      closeModal(qs('#expenseModalOverlay'));
      showToast(ui.editingExpenseId ? 'Expense updated' : 'Expense added');
    });

    qs('#settleForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var group = currentGroupForSettle;
      if (!group) return;

      var amountCents = SW.Model.parseAmount(qs('#settleAmountInput').value);
      var from = qs('#settleFromSelect').value;
      var to = qs('#settleToSelect').value;
      var date = qs('#settleDateInput').value;
      var errorEl = qs('#settleFormError');

      if (amountCents === null || amountCents <= 0) {
        errorEl.textContent = 'Enter a valid amount.';
        return;
      }
      if (from === to) {
        errorEl.textContent = '"From" and "To" must be different members.';
        return;
      }

      var result = store().dispatch({
        type: 'ADD_SETTLEMENT',
        payload: { groupId: group.id, from: from, to: to, amountCents: amountCents, date: date }
      });
      if (!result || !result.ok) {
        errorEl.textContent = (result && result.error) || 'Could not record settlement.';
        return;
      }
      closeModal(qs('#settleModalOverlay'));
      showToast('Settlement recorded');
    });

    qs('#newGroupBtn').addEventListener('click', function () {
      qs('#groupForm').reset();
      qs('#groupFormError').textContent = '';
      // Typing member names is meaningless once members are real accounts:
      // in shared mode people join with the invite code instead.
      var membersRow = qs('#groupMembersRow');
      if (membersRow) membersRow.hidden = isRemote();
      openModal(qs('#groupModalOverlay'));
      qs('#groupNameInput').focus();
    });

    qs('#groupForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var name = qs('#groupNameInput').value.trim();
      var currency = qs('#groupCurrencySelect').value;
      var rawMembers = qs('#groupMembersInput').value;
      var memberNames = rawMembers
        .split(',')
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length > 0; });
      var errorEl = qs('#groupFormError');

      if (!name) {
        errorEl.textContent = 'Group name is required.';
        return;
      }

      // Signed in, members are real accounts who join with the invite code,
      // so there are no names to type here. Offline, they are just strings.
      var payload = isRemote()
        ? { name: name, currency: currency }
        : { name: name, currency: currency, memberNames: memberNames };
      var result = store().dispatch({ type: 'ADD_GROUP', payload: payload });
      if (!result || !result.ok) {
        errorEl.textContent = (result && result.error) || 'Could not create group.';
        return;
      }
      closeModal(qs('#groupModalOverlay'));
      showToast('Group created');
    });

    qs('#currentUserSelect').addEventListener('change', function (e) {
      store().dispatch({ type: 'SET_CURRENT_USER', payload: { memberId: e.target.value } });
    });

    // Data menu (export / import / reset / demo).
    var dataMenuBtn = qs('#dataMenuBtn');
    var dataMenu = qs('#dataMenu');

    function closeDataMenu() {
      dataMenu.hidden = true;
      dataMenuBtn.setAttribute('aria-expanded', 'false');
    }

    dataMenuBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = dataMenu.hidden;
      dataMenu.hidden = !willOpen;
      dataMenuBtn.setAttribute('aria-expanded', String(willOpen));
    });

    document.addEventListener('click', function (e) {
      if (!dataMenu.hidden && !dataMenu.contains(e.target) && e.target !== dataMenuBtn) {
        closeDataMenu();
      }
    });

    qs('#exportBtn').addEventListener('click', function () {
      var json = store().exportJSON();
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'splitwise-export-' + todayISO() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      closeDataMenu();
      showToast('Exported data');
    });

    qs('#importBtn').addEventListener('click', function () {
      qs('#importFileInput').click();
    });

    qs('#importFileInput').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        if (isRemote()) {
          showToast('Importing a file is only available in demo mode.');
          e.target.value = '';
          return;
        }
        var result = store().importJSON(String(reader.result));
        showToast(result && result.ok ? 'Data imported' : (result && result.error) || 'Import failed: invalid file.');
        e.target.value = '';
      };
      reader.onerror = function () {
        showToast('Could not read file.');
        e.target.value = '';
      };
      reader.readAsText(file);
      closeDataMenu();
    });

    qs('#resetBtn').addEventListener('click', function () {
      // In shared mode this button would be a foot-gun: the data is not
      // yours alone, and reset() only clears the local cache anyway, so it
      // would look destructive while changing nothing for anyone else.
      if (isRemote()) {
        showToast('Reset is only available in demo mode. Delete a group instead.');
        closeDataMenu();
        return;
      }
      if (!window.confirm('Reset all data? This deletes every group and expense and cannot be undone.')) return;
      store().reset();
      closeDataMenu();
      showToast('All data reset');
    });

    qs('#demoBtn').addEventListener('click', function () {
      if (isRemote()) {
        showToast('Demo data is only available in demo mode.');
        closeDataMenu();
        return;
      }
      store().seedDemo();
      closeDataMenu();
      showToast('Demo data loaded');
    });

    // Keyboard shortcuts: "n" opens add-expense, "Esc" closes modals / menus.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (openModalStack.length > 0) {
          closeTopModal();
          return;
        }
        if (!dataMenu.hidden) closeDataMenu();
        return;
      }
      if (e.key === 'n' || e.key === 'N') {
        var tag = document.activeElement && document.activeElement.tagName;
        var typing =
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          (document.activeElement && document.activeElement.isContentEditable);
        if (typing || openModalStack.length > 0) return;
        var group = getCurrentGroup(lastState);
        if (group) {
          e.preventDefault();
          openExpenseModal(group, null);
        }
      }
    });
  }

  // ========================================================================
  // Boot
  // ========================================================================

  // ---- account chip in the header ---------------------------------------
  function renderAccount(user) {
    var control = qs('#accountControl');
    var select = qs('#currentUserSelect');
    if (!control) return;

    if (!user) {
      control.hidden = true;
      if (select) select.hidden = false;
      return;
    }

    control.hidden = false;
    // The user-picker only means something offline, where "who am I" is a
    // guess. Signed in, the answer is not up for debate.
    if (select) select.hidden = true;

    var avatar = qs('#accountAvatar');
    var initials = qs('#accountInitials');
    var nameEl = qs('#accountName');
    var name = user.name || user.email || 'Signed in';

    if (nameEl) nameEl.textContent = name;

    if (user.avatarUrl && avatar) {
      avatar.src = user.avatarUrl;
      avatar.alt = '';
      avatar.hidden = false;
      if (initials) initials.hidden = true;
    } else {
      if (avatar) avatar.hidden = true;
      if (initials) {
        initials.textContent = name.trim().charAt(0).toUpperCase() || '?';
        initials.hidden = false;
      }
    }
  }

  // ---- "Saving… / Saved / Offline" indicator ------------------------------
  var syncStatusTimer = null;

  function setSyncStatus(status) {
    var el = qs('#syncStatus');
    if (!el) return;
    clearTimeout(syncStatusTimer);

    if (!status || status.state === 'idle') {
      el.hidden = true;
      return;
    }

    el.classList.toggle('is-error', status.state === 'error');
    el.hidden = false;

    if (status.state === 'saving') {
      el.textContent = 'Saving…';
    } else if (status.state === 'saved') {
      el.textContent = 'Saved';
      // "Saved" is reassurance, not information - let it fade out.
      syncStatusTimer = setTimeout(function () { el.hidden = true; }, 1500);
    } else {
      el.textContent = status.message || 'Not saved — check your connection';
      showToast(status.message || 'Could not save your change.');
    }
  }

  // ---- boot paths --------------------------------------------------------
  function showAuthScreen() {
    var screen = qs('#authScreen');
    if (screen) screen.hidden = false;
    renderAccount(null);
  }

  function hideAuthScreen() {
    var screen = qs('#authScreen');
    if (screen) screen.hidden = true;
  }

  var subscribed = false;

  function subscribeOnce() {
    if (subscribed) return;
    store().subscribe(render);
    subscribed = true;
  }

  // Demo mode: everything stays in this browser, exactly as before Supabase
  // existed. This is also the fallback whenever the backend is unreachable.
  function startLocalMode() {
    activeStore = SW.Store;
    subscribed = false;
    hideAuthScreen();
    renderAccount(null);
    setSyncStatus(null);
    SW.Store.init();
    subscribeOnce();
    render(SW.Store.getState());
  }

  // Shared mode: one set of books for the whole group, in Supabase.
  function startRemoteMode() {
    activeStore = SW.RemoteStore;
    subscribed = false;
    hideAuthScreen();
    renderAccount(SW.Auth.getUser());

    if (typeof SW.RemoteStore.onSyncStatus === 'function') {
      SW.RemoteStore.onSyncStatus(setSyncStatus);
    }
    subscribeOnce();
    render(SW.RemoteStore.getState());

    setSyncStatus({ state: 'saving' });
    SW.RemoteStore.init()
      .then(function () {
        setSyncStatus({ state: 'saved' });
        render(SW.RemoteStore.getState());
      })
      .catch(function (err) {
        setSyncStatus({
          state: 'error',
          message: 'Could not load your groups: ' + ((err && err.message) || 'unknown error')
        });
      });
  }

  function wireAuthEvents() {
    // The sign-in card doubles as the sign-up card; authMode says which.
    var authMode = 'signin';

    function setAuthMode(mode) {
      authMode = mode;
      var nameRow = qs('#authNameRow');
      var submit = qs('#authSubmitBtn');
      var prompt = qs('#authSwitchPrompt');
      var switchBtn = qs('#authSwitchBtn');
      var password = qs('#authPasswordInput');
      var error = qs('#authError');

      if (error) error.textContent = '';
      if (nameRow) nameRow.hidden = mode !== 'signup';
      if (submit) submit.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
      if (prompt) prompt.textContent = mode === 'signup' ? 'Already have an account?' : 'No account yet?';
      if (switchBtn) switchBtn.textContent = mode === 'signup' ? 'Sign in' : 'Create one';
      // Tells a password manager whether to offer a saved password or a new one.
      if (password) {
        password.setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
      }
    }

    var switchBtn = qs('#authSwitchBtn');
    if (switchBtn) {
      switchBtn.addEventListener('click', function () {
        setAuthMode(authMode === 'signup' ? 'signin' : 'signup');
        var focusEl = authMode === 'signup' ? qs('#authNameInput') : qs('#authEmailInput');
        if (focusEl) focusEl.focus();
      });
    }

    var authForm = qs('#authForm');
    if (authForm) {
      authForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var errorEl = qs('#authError');
        var submitBtn = qs('#authSubmitBtn');
        var email = (qs('#authEmailInput') || {}).value || '';
        var password = (qs('#authPasswordInput') || {}).value || '';
        var name = (qs('#authNameInput') || {}).value || '';

        if (errorEl) errorEl.textContent = '';

        if (!email.trim()) {
          if (errorEl) errorEl.textContent = 'Enter your email address.';
          return;
        }
        if (password.length < 8) {
          if (errorEl) errorEl.textContent = 'Password must be at least 8 characters.';
          return;
        }
        if (authMode === 'signup' && !name.trim()) {
          if (errorEl) errorEl.textContent = 'Enter the name your friends will see.';
          return;
        }

        if (submitBtn) submitBtn.disabled = true;
        var pending = authMode === 'signup'
          ? SW.Auth.signUp(email, password, name)
          : SW.Auth.signInWithPassword(email, password);

        pending.then(function (result) {
          if (submitBtn) submitBtn.disabled = false;
          if (result && result.ok) {
            // onChange swaps the app into shared mode; just clear the form.
            authForm.reset();
            return;
          }
          if (errorEl) {
            errorEl.textContent = (result && result.error) || 'Could not sign in.';
          }
          // Account made but not yet usable: put them on the sign-in tab.
          if (result && result.needsConfirmation) setAuthMode('signin');
        });
      });
    }

    var demoBtn = qs('#tryDemoBtn');
    if (demoBtn) {
      demoBtn.addEventListener('click', function () {
        startLocalMode();
      });
    }

    var signOutBtn = qs('#signOutBtn');
    if (signOutBtn) {
      signOutBtn.addEventListener('click', function () {
        SW.Auth.signOut()
          .then(function () {
            if (SW.RemoteStore && typeof SW.RemoteStore.reset === 'function') {
              SW.RemoteStore.reset();
            }
            activeStore = null;
            subscribed = false;
            showAuthScreen();
          })
          .catch(function (err) {
            showToast('Could not sign out: ' + ((err && err.message) || 'unknown error'));
          });
      });
    }

    // ---- join a group with a code ----
    var joinBtn = qs('#joinGroupBtn');
    if (joinBtn) {
      joinBtn.addEventListener('click', function () {
        if (!isRemote()) {
          showToast('Sign in to join a friend\'s group.');
          return;
        }
        var err = qs('#joinError');
        if (err) err.textContent = '';
        var input = qs('#joinCodeInput');
        if (input) input.value = '';
        openModal(qs('#joinModal'));
        if (input) input.focus();
      });
    }

    var joinForm = qs('#joinModalForm');
    if (joinForm) {
      joinForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = qs('#joinCodeInput');
        var errorEl = qs('#joinError');
        var code = input ? input.value.trim() : '';
        if (!code) {
          if (errorEl) errorEl.textContent = 'Enter the invite code your friend sent you.';
          return;
        }
        // Joining needs a round trip - the code has to be checked against
        // the server before we know whether it worked. So the modal stays
        // open, saying what it is doing, until the store reports back.
        var submitBtn = joinForm.querySelector('button[type="submit"]');
        var originalLabel = submitBtn ? submitBtn.textContent : '';
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Joining…';
        }

        function finished(outcome) {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalLabel;
          }
          if (outcome && outcome.ok) {
            closeModal(qs('#joinModal'));
            showToast('Joined the group');
          } else if (errorEl) {
            errorEl.textContent = (outcome && outcome.error) || 'Could not join that group.';
          }
        }

        var result = store().dispatch({
          type: 'JOIN_GROUP',
          payload: { code: code, onResult: finished }
        });

        // A store that rejects the action outright (offline mode, or a
        // malformed code) answers immediately and never calls back.
        if (!result || !result.ok) {
          finished({ ok: false, error: (result && result.error) || 'Could not join that group.' });
        }
      });
    }

    // ---- copy the invite code ----
    var copyBtn = qs('#copyInviteBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var codeEl = qs('#inviteCodeText');
        var code = codeEl ? codeEl.textContent.trim() : '';
        if (!code) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(
            function () { showToast('Invite code copied'); },
            function () { showToast('Could not copy — select the code and copy it manually.'); }
          );
        } else {
          showToast('Copy the code manually: ' + code);
        }
      });
    }
  }

  function openInviteModal(group) {
    var codeEl = qs('#inviteCodeText');
    if (codeEl) codeEl.textContent = group.inviteCode || '(no code)';
    openModal(qs('#inviteModal'));
  }

  function init() {
    wireStaticEvents();
    wireAuthEvents();

    // No Supabase project configured: behave exactly like the old app.
    if (!backendAvailable()) {
      startLocalMode();
      return;
    }

    // Reflect later sign-ins and sign-outs, including a session restored
    // from a previous visit.
    SW.Auth.onChange(function () {
      if (SW.Auth.isSignedIn()) {
        if (!isRemote()) startRemoteMode();
      } else if (isRemote()) {
        activeStore = null;
        subscribed = false;
        showAuthScreen();
      }
    });

    SW.Auth.init()
      .then(function () {
        if (SW.Auth.isSignedIn()) {
          startRemoteMode();
        } else {
          showAuthScreen();
        }
      })
      .catch(function () {
        // If the backend cannot even be reached, the app is still useful
        // offline - better that than a blank page.
        showToast('Could not reach the server — starting in demo mode.');
        startLocalMode();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
