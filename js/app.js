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

  // t() is a short alias for SW.I18n.t() - this file calls it constantly,
  // so the full name would add a lot of noise.
  function t(key, params) {
    return SW.I18n.t(key, params);
  }

  // unit(count, key) picks the singular or plural form of a pluralized
  // dictionary entry, e.g. unit(3, 'unit.expense') -> "expenses".
  function unit(count, key) {
    return t(count === 1 ? key + '.one' : key + '.other');
  }

  // Server and model errors arrive in English. They are stable, known strings,
  // so the ones a person is actually likely to hit get mapped into whichever
  // language is active. Anything unrecognised passes through untouched rather
  // than being swallowed - a mystery English sentence beats a silent failure.
  var ERROR_KEYS = [
    [/exact amounts must add up/i, 'err.exactSum'],
    [/percentages must add up|percentages must sum/i, 'err.percentSum'],
    [/shares must be positive/i, 'err.sharesPositive'],
    [/each participant may only be listed once/i, 'err.duplicateParticipant'],
    [/at least one participant|needs at least one participant/i, 'err.needParticipant'],
    [/payer is not a member|payer must be a member/i, 'err.payerNotMember'],
    [/every participant must be a member/i, 'err.participantNotMember'],
    [/no group found for that invite code/i, 'err.badInviteCode'],
    [/somebody else changed this expense/i, 'err.editConflict'],
    [/that expense no longer exists/i, 'err.expenseGone'],
    [/only the group owner can delete/i, 'err.ownerOnlyDelete'],
    [/only the group owner can change the invite code/i, 'err.ownerOnlyRotate'],
    [/only the current owner can hand over/i, 'err.ownerOnlyTransfer'],
    [/this person appears in an expense/i, 'err.memberInExpense'],
    [/you own this group/i, 'err.ownerCannotLeave'],
    [/you are not a member of this group/i, 'err.notAMember'],
    [/you already own \d+ groups/i, 'err.groupLimit'],
    [/description is required/i, 'err.descriptionRequired'],
    [/amount must be a positive/i, 'err.amountPositive'],
    [/failed to fetch|network|load failed/i, 'err.network']
  ];

  function translateError(message) {
    var text = String(message || '').trim();
    if (!text) return text;
    for (var i = 0; i < ERROR_KEYS.length; i++) {
      if (ERROR_KEYS[i][0].test(text)) {
        var translated = t(ERROR_KEYS[i][1]);
        // t() returns the key itself when it is missing; do not show that.
        if (translated && translated !== ERROR_KEYS[i][1]) return translated;
      }
    }
    return text;
  }

  // Above this many rows the list is trimmed until the reader asks for more.
  // Chosen to be far beyond a normal friend group, so nobody ever meets it
  // by accident.
  var EXPENSE_RENDER_LIMIT = 150;

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

  // Month abbreviations for formatDateDisplay, one list per language. Kept
  // next to each other so it's obvious they have to stay in sync.
  var MONTH_NAMES = {
    en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    de: ['Jan', 'Feb', 'März', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']
  };

  // Turns "2026-09-03" into a locale-appropriate display date: "Sep 3, 2026"
  // in English, "3. Sep 2026" in German (day first, no comma - the dot after
  // the day is the German ordinal marker, not part of the month).
  function formatDateDisplay(iso) {
    if (!iso) return '';
    var parts = iso.split('-');
    if (parts.length !== 3) return iso;
    var lang = SW.I18n ? SW.I18n.getLang() : 'en';
    var months = MONTH_NAMES[lang] || MONTH_NAMES.en;
    var monthIndex = parseInt(parts[1], 10) - 1;
    var day = parseInt(parts[2], 10);
    var monthName = months[monthIndex] || parts[1];
    return lang === 'de'
      ? day + '. ' + monthName + ' ' + parts[0]
      : monthName + ' ' + day + ', ' + parts[0];
  }

  // --------------------------------------------------------------------
  // Money display. js/model.js's formatMoney/formatSigned always render
  // "€12.34" (symbol first, dot decimal) - correct for English, wrong for
  // German ("12,34 €": symbol after, comma decimal). We are not allowed to
  // touch js/model.js (it owns storage/calculation, not display), so this
  // is a display-only wrapper around it: same cents, same currency, just
  // reformatted for the active language before it reaches the page.
  // --------------------------------------------------------------------
  var CURRENCY_SYMBOLS = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF' };

  function fmtMoney(cents, currency) {
    if (SW.I18n && SW.I18n.getLang() === 'de') {
      var negative = cents < 0;
      var amountStr = (Math.abs(cents) / 100).toFixed(2).replace('.', ',');
      var symbol = CURRENCY_SYMBOLS[currency];
      var body = symbol !== undefined ? amountStr + ' ' + symbol : amountStr + ' ' + (currency || '?');
      return (negative ? '-' : '') + body;
    }
    return SW.Model.formatMoney(cents, currency);
  }

  function fmtSigned(cents, currency) {
    if (SW.I18n && SW.I18n.getLang() === 'de') {
      var sign = cents < 0 ? '-' : '+';
      return sign + fmtMoney(Math.abs(cents), currency);
    }
    return SW.Model.formatSigned(cents, currency);
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
    showAllExpenses: false,    // true once the reader asks for the full list
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

  // What the URL asked for, applied once the store has actually loaded -
  // a bookmarked group link arrives long before the groups do.
  var pendingGroupFromUrl = null;
  var pendingJoinCode = null;

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
      undoBtn.textContent = t('misc.undo');
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

  // Tab is already trapped, but a screen reader's browse mode can still walk
  // through the page behind a dialog. `inert` stops that properly.
  function setBackgroundInert(on) {
    var shell = qs('.app-shell');
    if (!shell) return;
    if (on) {
      shell.setAttribute('inert', '');
      shell.setAttribute('aria-hidden', 'true');
      shell.setAttribute('data-modal-blocked', '');
    } else {
      shell.removeAttribute('inert');
      shell.removeAttribute('aria-hidden');
      shell.removeAttribute('data-modal-blocked');
    }
  }

  function openModal(overlay) {
    ui.lastFocusedEl = document.activeElement;
    overlay.hidden = false;
    openModalStack.push(overlay);
    setBackgroundInert(true);
    document.addEventListener('keydown', trapKeydown);
  }

  function closeModal(overlay) {
    overlay.hidden = true;
    openModalStack = openModalStack.filter(function (o) {
      return o !== overlay;
    });
    if (openModalStack.length === 0) {
      setBackgroundInert(false);
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
      return byId[memberId] || t('misc.unknownMember');
    };
  }

  // Display names are free text and NOT unique, so two people called "Nils"
  // are indistinguishable in a payer dropdown or a balances row. In an app
  // about who owes whom that is a real problem, so when names collide each
  // gets a short suffix - their email if we have one, otherwise the tail of
  // their id. Unique names get nothing, so the common case stays clean.
  function memberHint(member) {
    if (!member) return '';
    if (member.email) return member.email;
    return '…' + String(member.id || '').slice(-4);
  }

  function makeDisambiguator(group) {
    var counts = {};
    group.members.forEach(function (m) {
      var key = String(m.name || '').trim().toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
    });
    return function (member) {
      if (!member) return '';
      var key = String(member.name || '').trim().toLowerCase();
      if ((counts[key] || 0) < 2) return '';
      return ' <span class="member-disambiguator">' + esc(memberHint(member)) + '</span>';
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
      select.innerHTML = '<option value="">' + esc(t('misc.noGroupSelected')) + '</option>';
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
      listEl.innerHTML = '<li class="group-sub" style="padding:10px 12px;">' + esc(t('sidebar.noGroupsYet')) + '</li>';
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
            '<span class="group-balance-figure ' + cls + '">' + esc(fmtSigned(net, g.currency)) + '</span>';
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
          ' ' +
          esc(unit(g.members.length, 'unit.member')) +
          ' · ' +
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
        if (SW.Router) SW.Router.goToGroup(btn.getAttribute('data-id'));
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
        '<div class="empty-state"><div class="empty-icon">👈</div><h3>' + esc(t('empty.selectGroupTitle')) + '</h3>' +
        '<p>' + esc(t('empty.selectGroupBody')) + '</p></div>';
      return;
    }

    // Replacing innerHTML throws away scroll position, keyboard focus and any
    // text selection inside the panel. That is fine when the user caused the
    // re-render, and jarring when a friend's change arrived over realtime
    // while they were part-way through something. Capture, replace, restore.
    var previousScroll = mainEl.scrollTop;
    var focusSnapshot = captureFocusWithin(mainEl);

    mainEl.innerHTML = renderGroupViewHTML(group, state);
    wireGroupView(group, state);

    mainEl.scrollTop = previousScroll;
    restoreFocus(focusSnapshot);
  }

  // The undo action used to live only inside a toast that removed itself
  // after a few seconds. Anything deleted also goes here, so it can still be
  // restored minutes later. This is a per-session, in-memory list; it is not
  // a server-side trash, and it says so in the dialog.
  var recentlyDeleted = [];
  var RECENTLY_DELETED_LIMIT = 25;

  function rememberDeleted(expense, groupName) {
    recentlyDeleted.unshift({
      expense: JSON.parse(JSON.stringify(expense)),
      groupName: groupName || '',
      deletedAt: Date.now()
    });
    if (recentlyDeleted.length > RECENTLY_DELETED_LIMIT) recentlyDeleted.length = RECENTLY_DELETED_LIMIT;
  }

  function restoreDeleted(expenseId) {
    var entry = recentlyDeleted.find(function (r) { return r.expense.id === expenseId; });
    if (!entry) return { ok: false, error: t('recentlyDeleted.emptyBody') };
    var e = entry.expense;
    var payload = {
      groupId: e.groupId,
      description: e.description,
      amountCents: e.amountCents,
      paidBy: e.paidBy,
      splitMode: e.splitMode,
      participants: e.participants,
      category: e.category,
      date: e.date,
      note: e.note,
      createdAt: e.createdAt
    };
    var result;
    if (e.type === 'settlement') {
      var receiver = (e.participants && e.participants[0]) || {};
      result = store().dispatch({ type: 'ADD_SETTLEMENT', payload: {
        groupId: e.groupId, from: e.paidBy, to: receiver.memberId,
        amountCents: e.amountCents, date: e.date, createdAt: e.createdAt } });
    } else {
      result = store().dispatch({ type: 'ADD_EXPENSE', payload: payload });
    }
    if (result && result.ok) {
      recentlyDeleted = recentlyDeleted.filter(function (r) { return r.expense.id !== expenseId; });
    }
    return result;
  }

  function renderRecentlyDeleted() {
    var list = qs('#recentlyDeletedList');
    var empty = qs('#recentlyDeletedEmpty');
    if (!list || !empty) return;

    if (recentlyDeleted.length === 0) {
      list.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.innerHTML = recentlyDeleted.map(function (r) {
      var currency = 'EUR';
      var g = (lastState && lastState.groups || []).find(function (x) { return x.id === r.expense.groupId; });
      if (g) currency = g.currency;
      return (
        '<li class="recently-deleted-row">' +
        '<span class="recently-deleted-name">' + esc(r.expense.description) + '</span> ' +
        '<span class="recently-deleted-meta">' + esc(fmtMoney(r.expense.amountCents, currency)) +
        (r.groupName ? ' · ' + esc(r.groupName) : '') + '</span>' +
        '<button type="button" class="btn btn-sm restore-expense-btn" data-id="' + esc(r.expense.id) + '">' +
        esc(t('common.restore')) + '</button>' +
        '</li>'
      );
    }).join('');

    qsa('.restore-expense-btn', list).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var result = restoreDeleted(btn.getAttribute('data-id'));
        if (result && result.ok) {
          showToast(t('toast.restored'));
          renderRecentlyDeleted();
        } else {
          showToast(translateError(result && result.error) || t('toast.restoreFailed'));
        }
      });
    });
  }

  // Remembers WHICH element had focus in a way that survives the element
  // itself being destroyed: by a stable selector rather than a reference.
  function captureFocusWithin(container) {
    var active = document.activeElement;
    if (!active || !container.contains(active) || active === document.body) return null;

    var selector = null;
    if (active.id) {
      selector = '#' + active.id;
    } else {
      // Rows and buttons carry data-id / data-member, which survive a repaint.
      var key = active.getAttribute('data-id') || active.getAttribute('data-member');
      var cls = (active.className || '').toString().trim().split(/\s+/)[0];
      if (key && cls) selector = '.' + cls + '[data-id="' + key + '"], .' + cls + '[data-member="' + key + '"]';
    }
    if (!selector) return null;

    return {
      selector: selector,
      start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
      end: typeof active.selectionEnd === 'number' ? active.selectionEnd : null
    };
  }

  function restoreFocus(snapshot) {
    if (!snapshot) return;
    var el;
    try {
      el = qs(snapshot.selector);
    } catch (err) {
      return; // a malformed selector must never break a render
    }
    if (!el || typeof el.focus !== 'function') return;
    el.focus();
    if (snapshot.start !== null && typeof el.setSelectionRange === 'function') {
      try {
        el.setSelectionRange(snapshot.start, snapshot.end);
      } catch (err) {
        // Not every input type supports a selection range; ignore.
      }
    }
  }

  function renderNoGroupsEmptyState() {
    return (
      '<div class="empty-state">' +
      '<div class="empty-icon">👥</div>' +
      '<h3>' + esc(t('empty.noGroupsTitle')) + '</h3>' +
      '<p>' + esc(t('empty.noGroupsBody')) + '</p>' +
      '<button type="button" class="btn btn-primary" id="emptyNewGroupBtn">' + esc(t('sidebar.newGroup')) + '</button>' +
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
      ' <button type="button" class="icon-btn" id="renameGroupBtn" aria-label="' + esc(t('group.rename')) + '">✏️</button>' +
      ' <button type="button" class="icon-btn" id="deleteGroupBtn" aria-label="' + esc(t('group.delete')) + '">🗑️</button>' +
      '</h1>' +
      '<div class="member-chips">' +
      renderMemberChips(group) +
      '</div>' +
      '<div class="group-meta">' +
      esc(group.currency) +
      ' · ' +
      esc(t('group.totalSpent')) +
      ' ' +
      esc(fmtMoney(totals.totalSpentCents, group.currency)) +
      ' · ' +
      totals.expenseCount +
      ' ' +
      esc(unit(totals.expenseCount, 'unit.expense')) +
      (totals.settlementCount
        ? ' · ' + totals.settlementCount + ' ' + esc(unit(totals.settlementCount, 'unit.settlement'))
        : '') +
      '</div>' +
      '</div>' +
      '<div class="group-actions">' +
      '<button type="button" class="btn" id="settleUpBtn">' + esc(t('group.settleUp')) + '</button>' +
      '<button type="button" class="btn btn-primary" id="addExpenseBtn">' + esc(t('group.addExpense')) + '</button>' +
      '</div>' +
      '</div>' +
      '<div class="panels-row">' +
      renderBalancesPanel(group, state) +
      renderSettlementsPanel(group, state) +
      '</div>' +
      '<div class="panel">' +
      '<h2>' + esc(t('panel.expenses')) + '</h2>' +
      renderExpenseList(group, expenses) +
      '</div>'
    );
  }

  function renderMemberChips(group) {
    var disambiguate = makeDisambiguator(group);
    var chips = group.members
      .map(function (m) {
        return (
          '<span class="chip">' +
          esc(m.name) + disambiguate(m) +
          ' <button type="button" class="icon-btn remove-member-btn" data-member="' +
          esc(m.id) +
          '" aria-label="' +
          esc(t('group.removeMemberAria', { name: m.name })) +
          '" style="width:18px;height:18px;font-size:11px;">✕</button></span>'
        );
      })
      .join('');
    // Offline you invent members by typing a name. Signed in, a member is a
    // real account, so the only way to add one is to share the invite code.
    var action = isRemote()
      ? ' <button type="button" class="btn btn-sm" id="inviteMemberBtn">' + esc(t('group.invite')) + '</button>' +
        ' <button type="button" class="btn btn-sm" id="viewMembersBtn">' + esc(t('members.title')) + '</button>'
      : ' <button type="button" class="btn btn-sm" id="addMemberBtn">' + esc(t('group.addMember')) + '</button>';
    return chips + action;
  }

  function renderBalancesPanel(group, state) {
    var balances = SW.Model.computeBalances(group.id, state.groups, state.expenses);
    var disambiguate = makeDisambiguator(group);
    var rows = group.members
      .map(function (m) {
        var net = balances[m.id] || 0;
        var cls = net > 0 ? 'positive' : net < 0 ? 'negative' : 'zero';
        return (
          '<div class="balance-row"><span>' +
          esc(m.name) + disambiguate(m) +
          '</span><span class="balance-figure ' +
          cls +
          '">' +
          esc(fmtSigned(net, group.currency)) +
          '</span></div>'
        );
      })
      .join('');
    return '<div class="panel"><h2>' + esc(t('panel.balances')) + '</h2>' + rows + '</div>';
  }

  function renderSettlementsPanel(group, state) {
    var balances = SW.Model.computeBalances(group.id, state.groups, state.expenses);
    var suggestions = SW.Model.simplifyDebts(balances);
    var memberName = makeMemberNameLookup(group);

    if (suggestions.length === 0) {
      return (
        '<div class="panel"><h2>' + esc(t('panel.suggestedSettlements')) + '</h2>' +
        '<p class="hint">' + esc(t('panel.allSettled')) + '</p></div>'
      );
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
          esc(fmtMoney(s.amountCents, group.currency)) +
          '</span>' +
          '<button type="button" class="btn btn-sm record-settlement-btn" data-idx="' +
          idx +
          '">' + esc(t('panel.record')) + '</button>' +
          '</div>'
        );
      })
      .join('');
    return '<div class="panel"><h2>' + esc(t('panel.suggestedSettlements')) + '</h2>' + rows + '</div>';
  }

  function renderExpenseList(group, expenses) {
    if (expenses.length === 0) {
      return (
        '<div class="empty-state">' +
        '<div class="empty-icon">🧾</div>' +
        '<h3>' + esc(t('empty.noExpensesTitle')) + '</h3>' +
        '<p>' + esc(t('empty.noExpensesBody')) + '</p>' +
        '<button type="button" class="btn btn-primary" id="emptyAddExpenseBtn">' + esc(t('expense.addTitle')) + '</button>' +
        '</div>'
      );
    }

    var sorted = expenses.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    var memberName = makeMemberNameLookup(group);

    // Only the most recent rows are painted. Balances are still computed from
    // EVERY expense - capping what is fetched would silently produce wrong
    // numbers, which is far worse than a long list. This caps only the DOM.
    var limit = ui.showAllExpenses ? sorted.length : EXPENSE_RENDER_LIMIT;
    var visible = sorted.slice(0, limit);
    var hidden = sorted.length - visible.length;

    var rows = visible
      .map(function (e) {
        return renderExpenseRow(group, e, memberName);
      })
      .join('');

    if (hidden > 0) {
      rows +=
        '<button type="button" class="btn btn-block" id="showAllExpensesBtn">' +
        esc(t('expense.showOlder', { count: hidden })) +
        '</button>';
    }
    return '<ul class="expense-list">' + rows + '</ul>';
  }

  function renderExpenseRow(group, expense, memberName) {
    if (expense.type === 'settlement') {
      var receiver = expense.participants[0] || {};
      var text = t('expense.settlementLine', {
        payer: memberName(expense.paidBy),
        receiver: memberName(receiver.memberId),
        amount: fmtMoney(expense.amountCents, group.currency)
      });
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
        ' · ' + esc(t('expense.settlementSuffix')) + '</div></div>' +
        '<div class="expense-row-actions">' +
        '<button type="button" class="icon-btn expense-delete-btn" data-id="' +
        esc(expense.id) +
        '" aria-label="' + esc(t('expense.deleteSettlementAria')) + '">🗑️</button>' +
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

    var shareText = t('expense.notInvolved');
    // "Not involved" on its own reads like a bug to whoever it happens to.
    // It is almost always because the expense predates them joining, so the
    // label carries that explanation rather than leaving them to guess.
    var shareTitle = t('expense.notInvolvedHint');
    var shareClass = '';
    var involved = currentUserId != null && (shareByMember.hasOwnProperty(currentUserId) || expense.paidBy === currentUserId);
    if (involved) {
      var paidPart = expense.paidBy === currentUserId ? expense.amountCents : 0;
      var owedPart = shareByMember[currentUserId] || 0;
      var net = paidPart - owedPart;
      if (net > 0) {
        shareText = t('expense.youLent', { amount: fmtMoney(net, group.currency) });
        shareClass = 'positive';
      } else if (net < 0) {
        shareText = t('expense.youOwe', { amount: fmtMoney(-net, group.currency) });
        shareClass = 'negative';
      } else {
        shareText = t('expense.settled');
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
      esc(t('expense.paidLine', { payer: memberName(expense.paidBy), amount: fmtMoney(expense.amountCents, group.currency) })) +
      ' · ' +
      esc(formatDateDisplay(expense.date)) +
      '</div>' +
      '</div>' +
      '<div class="expense-amounts">' +
      '<div class="expense-amount">' +
      esc(fmtMoney(expense.amountCents, group.currency)) +
      '</div>' +
      '<div class="expense-share ' +
      shareClass +
      (involved ? '' : ' expense-not-involved-hint') +
      '" title="' +
      esc(involved ? '' : shareTitle) +
      '">' +
      esc(shareText) +
      '</div>' +
      '</div>' +
      '<div class="expense-row-actions">' +
      '<button type="button" class="icon-btn expense-edit-btn" data-id="' +
      esc(expense.id) +
      '" aria-label="' + esc(t('expense.editAria')) + '">✏️</button>' +
      '<button type="button" class="icon-btn expense-delete-btn" data-id="' +
      esc(expense.id) +
      '" aria-label="' + esc(t('expense.deleteAria')) + '">🗑️</button>' +
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
          esc(fmtMoney(s.shareCents, lastState && getCurrentGroup(lastState) ? getCurrentGroup(lastState).currency : 'EUR')) +
          '</span></div>'
        );
      })
      .join('');
    var note = expense.note ? '<div class="note">' + esc(expense.note) + '</div>' : '';
    var modeLabel = t('splitMode.' + expense.splitMode) || expense.splitMode;
    return (
      '<div class="expense-detail">' +
      '<div class="expense-detail-row"><strong>' +
      esc(t('expense.splitHeading', { mode: modeLabel })) +
      '</strong><span></span></div>' +
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

    var showAllBtn = qs('#showAllExpensesBtn');
    if (showAllBtn) {
      showAllBtn.addEventListener('click', function () {
        ui.showAllExpenses = true;
        render(lastState);
      });
    }

    var emptyAddBtn = qs('#emptyAddExpenseBtn');
    if (emptyAddBtn) emptyAddBtn.addEventListener('click', function () { openExpenseModal(group, null); });

    var renameBtn = qs('#renameGroupBtn');
    if (renameBtn) {
      renameBtn.addEventListener('click', function () {
        openPrompt({
          title: t('group.rename'), label: t('group.nameLabel'), submitLabel: t('group.renameSubmit'),
          value: group.name
        }, function (name) {
          var result = store().dispatch({ type: 'RENAME_GROUP', payload: { groupId: group.id, name: name } });
          showToast(result && result.ok ? t('group.renamed') : translateError(result && result.error) || t('group.renameFailed'));
        });
      });
    }

    var deleteBtn = qs('#deleteGroupBtn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', function () {
        var count = (lastState ? lastState.expenses : []).filter(function (e) {
          return e.groupId === group.id;
        }).length;
        var shared = group.members.length > 1;
        openConfirm({
          title: t('group.deleteTitle'),
          confirmLabel: t('group.delete'),
          // Spelling out the blast radius, because this destroys other
          // people's records too, not just yours.
          bodyHtml:
            t('group.deleteBody.main', {
              name: '<strong>' + esc(group.name) + '</strong>',
              count: count,
              expenseWord: unit(count, 'unit.expense')
            }) +
            (shared
              ? t('group.deleteBody.sharedSuffix', { count: group.members.length, memberWord: unit(group.members.length, 'unit.member') })
              : '') +
            t('group.deleteBody.cannotUndo'),
          requireText: group.name,
          offerExport: true,
          exportName: group.name
        }, function () {
          var result = store().dispatch({ type: 'DELETE_GROUP', payload: { groupId: group.id } });
          showToast(result && result.ok ? t('group.deleted') : translateError(result && result.error) || t('group.deleteFailed'));
          if (result && result.ok && SW.Router) SW.Router.replaceRoot();
        });
      });
    }

    // Shared mode swaps "+ Member" for "Invite", since a member is an
    // account that has to join rather than a name you can type in.
    var membersBtn = qs('#viewMembersBtn');
    if (membersBtn) {
      membersBtn.addEventListener('click', function () {
        renderMembersModal(group);
        openModal(qs('#membersModal'));
      });
    }

    var inviteBtn = qs('#inviteMemberBtn');
    if (inviteBtn) {
      inviteBtn.addEventListener('click', function () {
        openInviteModal(group);
      });
    }

    var addMemberBtn = qs('#addMemberBtn');
    if (addMemberBtn) {
      addMemberBtn.addEventListener('click', function () {
        openPrompt({
          title: t('group.addMemberTitle'), label: t('common.name'), submitLabel: t('common.add'),
          placeholder: t('group.addMemberPlaceholder'),
          hint: t('group.addMemberHint')
        }, function (name) {
          var result = store().dispatch({ type: 'ADD_MEMBER', payload: { groupId: group.id, name: name } });
          showToast(result && result.ok ? t('group.memberAdded') : translateError(result && result.error) || t('group.memberAddFailed'));
        });
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
        showToast(result && result.ok ? t('group.memberRemoved') : translateError(result && result.error) || t('group.memberRemoveFailed'));
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
        showToast(result && result.ok ? t('settle.recorded') : translateError(result && result.error) || t('settle.recordFailed'));
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

    var groupForTrash = (state.groups || []).find(function (g) { return g.id === expense.groupId; });
    var result = store().dispatch({ type: 'DELETE_EXPENSE', payload: { expenseId: expenseId } });
    if (result && result.ok) {
      rememberDeleted(expense, groupForTrash ? groupForTrash.name : '');
    }
    if (!result || !result.ok) {
      showToast(translateError(result && result.error) || t('expense.deleteFailed'));
      return;
    }

    showToast(expense.type === 'settlement' ? t('expense.settlementDeletedToast') : t('expense.deletedToast'), {
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
              date: expense.date,
              createdAt: expense.createdAt
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
              note: expense.note,
              // Carry the original timestamp so it returns to its old place
              // in the list instead of reappearing at the top as if new.
              createdAt: expense.createdAt
            }
          });
        }
        // Restoring can legitimately fail - e.g. a member involved in this
        // expense was removed between the delete and the undo. Saying
        // "Restored" regardless would be a lie.
        if (restored && restored.ok) {
          showToast(t('expense.restored'));
        } else {
          showToast(translateError(restored && restored.error) || t('expense.restoreFailed'));
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
          var placeholder = mode === 'percent' ? '%' : mode === 'shares' ? t('splitMode.shares') : t('amount.placeholder');
          var modeLabel = t('splitMode.' + mode);
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
            esc(t('expense.participantValueAria', { name: m.name, mode: modeLabel })) +
            '" />';
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
      previewEl.innerHTML = '<em>' + esc(t('expense.previewNeedAmount')) + '</em>';
      errorEl.textContent = '';
      submitBtn.disabled = true;
      return;
    }
    if (participants.length === 0) {
      previewEl.innerHTML = '<em>' + esc(t('expense.previewNeedParticipant')) + '</em>';
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
          return '<li>' + esc(byId[s.memberId] || '?') + ': ' + esc(fmtMoney(s.shareCents, group.currency)) + '</li>';
        })
        .join('');
      previewEl.innerHTML = '<strong>' + esc(t('expense.previewHeading')) + '</strong><ul>' + items + '</ul>';
    } else {
      // split.error comes from js/model.js, which we don't own and which
      // only speaks English - shown as-is if present, our own fallback if not.
      previewEl.innerHTML = '<em>' + esc(split.error || t('expense.splitError')) + '</em>';
    }

    if (!validation.ok) {
      errorEl.textContent = validation.errors.join(' · ');
    } else if (!split.ok) {
      errorEl.textContent = split.error || t('expense.splitError');
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

    qs('#expenseModalTitle').textContent = expense ? t('expense.editTitle') : t('expense.addTitle');
    qs('#expenseSubmitBtn').textContent = expense ? t('expense.saveChangesSubmit') : t('expense.saveSubmit');
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

    qsa('.split-tab', qs('#splitTabs')).forEach(function (tabEl) {
      var active = tabEl.getAttribute('data-mode') === ui.splitMode;
      tabEl.classList.toggle('active', active);
      tabEl.setAttribute('aria-selected', active ? 'true' : 'false');
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
        qsa('.split-tab', qs('#splitTabs')).forEach(function (tabEl) {
          var active = tabEl === tab;
          tabEl.classList.toggle('active', active);
          tabEl.setAttribute('aria-selected', active ? 'true' : 'false');
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
        qs('#expenseFormError').textContent = translateError(result && result.error) || t('expense.saveFailed');
        return;
      }

      closeModal(qs('#expenseModalOverlay'));
      showToast(ui.editingExpenseId ? t('expense.updatedToast') : t('expense.addedToast'));
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
        errorEl.textContent = t('settle.amountInvalid');
        return;
      }
      if (from === to) {
        errorEl.textContent = t('settle.sameMember');
        return;
      }

      var result = store().dispatch({
        type: 'ADD_SETTLEMENT',
        payload: {
          groupId: group.id, from: from, to: to, amountCents: amountCents, date: date,
          // How the money actually moved. Optional, because sometimes it was
          // just cash across a table and nobody wants a form about it.
          settlementMethod: (qs('#settleMethodSelect') || {}).value || null
        }
      });
      if (!result || !result.ok) {
        errorEl.textContent = translateError(result && result.error) || t('settle.recordFailed');
        return;
      }
      closeModal(qs('#settleModalOverlay'));
      showToast(t('settle.recorded'));
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
        errorEl.textContent = t('group.nameRequired');
        return;
      }

      // Signed in, members are real accounts who join with the invite code,
      // so there are no names to type here. Offline, they are just strings.
      var payload = isRemote()
        ? { name: name, currency: currency }
        : { name: name, currency: currency, memberNames: memberNames };
      var release = guardSubmit(qs('#groupForm'), t('group.creating'));
      var result = store().dispatch({ type: 'ADD_GROUP', payload: payload });
      if (release) release();
      if (!result || !result.ok) {
        errorEl.textContent = translateError(result && result.error) || t('group.createFailed');
        return;
      }
      closeModal(qs('#groupModalOverlay'));
      showToast(t('group.created'));
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
      showToast(t('data.exported'));
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
          showToast(t('data.importRemoteBlocked'));
          e.target.value = '';
          return;
        }
        var result = store().importJSON(String(reader.result));
        showToast(result && result.ok ? t('data.imported') : translateError(result && result.error) || t('data.importFailed'));
        e.target.value = '';
      };
      reader.onerror = function () {
        showToast(t('data.readFailed'));
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
        showToast(t('data.resetRemoteBlocked'));
        closeDataMenu();
        return;
      }
      closeDataMenu();
      openConfirm({
        title: t('data.resetTitle'),
        confirmLabel: t('data.resetSubmit'),
        body: t('data.resetBody'),
        requireText: t('data.resetConfirmWord')
      }, function () {
        store().reset();
        showToast(t('data.resetDone'));
      });
    });

    qs('#demoBtn').addEventListener('click', function () {
      if (isRemote()) {
        showToast(t('data.demoRemoteBlocked'));
        closeDataMenu();
        return;
      }
      store().seedDemo();
      closeDataMenu();
      showToast(t('data.demoLoaded'));
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
    var name = user.name || user.email || t('auth.signedInFallback');

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

  // Stops a double-click on a slow connection posting the same expense twice.
  function guardSubmit(form, pendingLabel) {
    var btn = form.querySelector('button[type="submit"]');
    if (!btn || btn.disabled) return null;
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = pendingLabel || t('sync.saving');
    return function release() {
      btn.disabled = false;
      btn.textContent = original;
    };
  }

  // ---- in-app replacements for window.prompt / window.confirm -------------
  // The native ones cannot be styled, cannot be branded, and are genuinely
  // unpleasant on a phone. These reuse the existing modal plumbing, so they
  // get the focus trap and Escape handling for free.
  function openPrompt(opts, onSubmit) {
    var overlay = qs('#promptModal');
    qs('#promptTitle').textContent = opts.title || t('common.edit');
    qs('#promptLabel').textContent = opts.label || t('common.value');
    qs('#promptSubmitBtn').textContent = opts.submitLabel || t('common.save');
    qs('#promptHint').textContent = opts.hint || '';
    qs('#promptHint').hidden = !opts.hint;
    qs('#promptError').textContent = '';
    var input = qs('#promptInput');
    input.value = opts.value || '';
    input.placeholder = opts.placeholder || '';
    promptHandler = onSubmit;
    openModal(overlay);
    input.focus();
    input.select();
  }

  var promptHandler = null;

  // `requireText` turns this into a type-the-name-to-confirm dialog, for the
  // things that destroy other people's data as well as your own.
  function openConfirm(opts, onConfirm) {
    var overlay = qs('#confirmModal');
    qs('#confirmTitle').textContent = opts.title || t('common.areYouSure');
    qs('#confirmBody').innerHTML = opts.bodyHtml || esc(opts.body || '');
    qs('#confirmOkBtn').textContent = opts.confirmLabel || t('common.delete');
    qs('#confirmError').textContent = '';
    // Deleting a group destroys everyone's history with no server-side undo.
    // Offering a download first turns an irreversible act into a recoverable
    // one, at least for whoever clicks it.
    var exportBtn = qs('#exportBeforeDeleteBtn');
    if (exportBtn) {
      exportBtn.hidden = !opts.offerExport;
      exportBtn.onclick = opts.offerExport
        ? function () { downloadStateSnapshot(opts.exportName || 'splitwise'); }
        : null;
    }

    var row = qs('#confirmTypeRow');
    var input = qs('#confirmTypeInput');
    input.value = '';
    row.hidden = !opts.requireText;
    if (opts.requireText) {
      qs('#confirmTypeLabel').textContent = t('confirm.typeToConfirmLabel', { text: opts.requireText });
    }
    confirmHandler = onConfirm;
    confirmRequiredText = opts.requireText || null;
    openModal(overlay);
    // Focus lands on Cancel, never on the destructive button.
    var cancel = qs('#confirmCancelBtn');
    if (cancel) cancel.focus();
  }

  var confirmHandler = null;
  var confirmRequiredText = null;

  function wireDialogs() {
    qs('#promptForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var value = qs('#promptInput').value.trim();
      if (!value) {
        qs('#promptError').textContent = t('prompt.needValue');
        return;
      }
      var fn = promptHandler;
      closeModal(qs('#promptModal'));
      if (fn) fn(value);
    });

    qs('#confirmForm').addEventListener('submit', function (e) {
      e.preventDefault();
      if (confirmRequiredText) {
        var typed = qs('#confirmTypeInput').value.trim();
        if (typed !== confirmRequiredText) {
          qs('#confirmError').textContent = t('confirm.mismatch');
          return;
        }
      }
      var fn = confirmHandler;
      closeModal(qs('#confirmModal'));
      if (fn) fn();
    });

    var recentBtn = qs('#recentlyDeletedBtn');
    if (recentBtn) {
      recentBtn.addEventListener('click', function () {
        // closeDataMenu() is private to wireStaticEvents, so close it here.
        var menu = qs('#dataMenu');
        if (menu) menu.hidden = true;
        var menuBtn = qs('#dataMenuBtn');
        if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
        renderRecentlyDeleted();
        openModal(qs('#recentlyDeletedModal'));
      });
    }

    var dismiss = qs('#errorBannerDismiss');
    if (dismiss) dismiss.addEventListener('click', clearErrorBanner);
  }

  // ---- persistent failure banner -----------------------------------------
  // A toast that disappears after five seconds is the wrong way to tell
  // somebody their money did not save. This stays until they dismiss it or
  // a later write succeeds.
  function showErrorBanner(message) {
    var banner = qs('#errorBanner');
    var text = qs('#errorBannerText');
    if (!banner || !text) return;
    text.textContent = message;
    banner.hidden = false;
  }

  function clearErrorBanner() {
    var banner = qs('#errorBanner');
    if (banner) banner.hidden = true;
  }

  // ---- "Saving… / Saved / Offline" indicator ------------------------------
  var syncStatusTimer = null;
  var lastSyncStatus = null; // remembered so a language switch can redraw it

  function setSyncStatus(status) {
    lastSyncStatus = status;
    var el = qs('#syncStatus');
    if (!el) return;
    clearTimeout(syncStatusTimer);

    if (!status || status.state === 'idle') {
      el.hidden = true;
      return;
    }

    el.classList.toggle('is-error', status.state === 'error');
    el.hidden = false;

    // "N changes waiting to sync" - the offline queue made visible. Without
    // this the queue would be a silent promise.
    var queuedEl = qs('#queuedIndicator');
    if (queuedEl) {
      var queued = status.queued || 0;
      queuedEl.hidden = queued === 0;
      if (queued > 0) queuedEl.textContent = t('sync.queuedChanges', { count: queued });
    }

    if (status.state === 'queued') {
      el.hidden = false;
      el.classList.remove('is-error');
      el.textContent = t('sync.saving');
      return;
    }

    if (status.state === 'saving') {
      el.textContent = t('sync.saving');
    } else if (status.state === 'saved') {
      el.textContent = t('sync.saved');
      // A success means whatever failed before is no longer the current
      // state of the world, so the banner can go.
      clearErrorBanner();
      // "Saved" is reassurance, not information - let it fade out.
      syncStatusTimer = setTimeout(function () { el.hidden = true; }, 1500);
    } else {
      el.textContent = t('sync.notSaved');
      showErrorBanner(translateError(status.message) || t('sync.errorBannerDefault'));
    }
  }

  // ---- boot paths --------------------------------------------------------
  function showAuthScreen() {
    var screen = qs('#authScreen');
    if (screen) screen.hidden = false;
    renderAccount(null);
    warnAboutStrandedDemoData();
  }

  // Demo mode writes to localStorage. Signing up does NOT bring that data
  // with you - it just stops being visible, which is a horrible surprise if
  // you spent an evening entering real expenses. Say so before it happens,
  // but only when there is actually something to lose.
  function warnAboutStrandedDemoData() {
    var warn = qs('#demoDataWarning');
    if (!warn) return;
    var local = null;
    try {
      local = SW.Store.getState();
    } catch (err) {
      local = null;
    }
    if (!local || !local.groups || local.groups.length === 0) {
      warn.hidden = true;
      return;
    }
    var expenseCount = local.expenses ? local.expenses.length : 0;
    warn.textContent = t('auth.demoDataWarning', {
      groups: local.groups.length,
      groupWord: unit(local.groups.length, 'unit.group'),
      expenses: expenseCount,
      expenseWord: unit(expenseCount, 'unit.expense')
    });
    warn.hidden = false;
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
  var migrationOffered = false;

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
        applyPendingUrlIntent();
        // Only worth asking when they have nothing here yet and something
        // there - otherwise it is a pointless dialog every sign-in.
        if (!migrationOffered && SW.RemoteStore.getState().groups.length === 0) {
          migrationOffered = true;
          offerDemoMigration();
        }
      })
      .catch(function (err) {
        setSyncStatus({
          state: 'error',
          message: t('sync.loadGroupsFailedPrefix') + ((err && err.message) || t('sync.unknownError'))
        });
      });
  }

  // Runs once the groups are actually in memory, so a link to a group works
  // on a cold load and an invite link opens the join dialog ready to go.
  function applyPendingUrlIntent() {
    if (pendingJoinCode) {
      var input = qs('#joinCodeInput');
      if (input) input.value = pendingJoinCode;
      var err = qs('#joinError');
      if (err) err.textContent = '';
      openModal(qs('#joinModal'));
      pendingJoinCode = null;
      return;
    }
    if (pendingGroupFromUrl) {
      var res = store().dispatch({ type: 'SELECT_GROUP', payload: { groupId: pendingGroupFromUrl } });
      if (!res || !res.ok) {
        // The link points at a group this account cannot see. Say so rather
        // than silently showing them somebody else's group.
        showToast(t('auth.groupLinkUnavailable'));
        if (SW.Router) SW.Router.replaceRoot();
      }
      pendingGroupFromUrl = null;
    }
  }

  // Demo mode writes to localStorage; signing up used to silently abandon
  // all of it. Now, if there is local work worth keeping, the user is asked
  // once, and it is copied into their account as real groups and expenses.
  function localDataWorthKeeping() {
    var local = null;
    try {
      local = SW.Store.getState();
    } catch (err) {
      return null;
    }
    if (!local || !local.groups || !local.groups.length) return null;
    return local;
  }

  function offerDemoMigration() {
    var local = localDataWorthKeeping();
    var modal = qs('#migrateDemoModal');
    if (!local || !modal) return;

    var body = qs('#migrateDemoBody');
    if (body) {
      body.textContent = t('migrate.body', {
        groups: local.groups.length,
        expenses: local.expenses ? local.expenses.length : 0
      });
    }
    openModal(modal);

    var confirmBtn = qs('#migrateConfirmBtn');
    var skipBtn = qs('#migrateSkipBtn');

    function finish() {
      closeModal(modal);
    }

    if (skipBtn) {
      skipBtn.onclick = function () { finish(); };
    }
    if (confirmBtn) {
      confirmBtn.onclick = function () {
        confirmBtn.disabled = true;
        migrateLocalData(local).then(function (summary) {
          confirmBtn.disabled = false;
          finish();
          showToast(t('migrate.done', { groups: summary.groups, expenses: summary.expenses }));
        });
      };
    }
  }

  // Copies each local group and its expenses through the normal dispatch
  // path, so everything is validated exactly as if it had been typed in.
  // Members cannot come across - they were names, not accounts - so every
  // expense is re-pointed at the signed-in user.
  function migrateLocalData(local) {
    var me = SW.Auth.getUser();
    if (!me) return Promise.resolve({ groups: 0, expenses: 0 });

    var madeGroups = 0;
    var madeExpenses = 0;
    var chain = Promise.resolve();

    local.groups.forEach(function (g) {
      chain = chain.then(function () {
        var res = store().dispatch({ type: 'ADD_GROUP', payload: { name: g.name, currency: g.currency } });
        if (!res || !res.ok) return;
        madeGroups += 1;
        // Give the server a moment to hand back the real group id.
        return new Promise(function (resolve) { setTimeout(resolve, 700); }).then(function () {
          var state = store().getState();
          var created = state.groups.filter(function (x) { return x.name === g.name; }).pop();
          if (!created) return;
          (local.expenses || [])
            .filter(function (e) { return e.groupId === g.id && e.type !== 'settlement'; })
            .forEach(function (e) {
              var r = store().dispatch({ type: 'ADD_EXPENSE', payload: {
                groupId: created.id,
                description: e.description,
                amountCents: e.amountCents,
                paidBy: me.id,
                splitMode: 'equal',
                participants: [{ memberId: me.id, value: 1 }],
                category: e.category,
                date: e.date,
                note: e.note,
                createdAt: e.createdAt
              } });
              if (r && r.ok) madeExpenses += 1;
            });
        });
      });
    });

    return chain.then(function () {
      return { groups: madeGroups, expenses: madeExpenses };
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
      if (submit) submit.textContent = mode === 'signup' ? t('auth.createAccount') : t('auth.signIn');
      if (prompt) prompt.textContent = mode === 'signup' ? t('auth.alreadyHaveAccount') : t('auth.noAccountYet');
      if (switchBtn) switchBtn.textContent = mode === 'signup' ? t('auth.signIn') : t('auth.createOne');
      // Tells a password manager whether to offer a saved password or a new one.
      if (password) {
        password.setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
      }
    }

    // Re-apply the current mode's text when the language changes, so a
    // switch mid-form doesn't leave stale English/German text behind.
    SW.I18n.onChange(function () {
      setAuthMode(authMode);
    });

    // ---- password reset -------------------------------------------------
    // Without this a friend who forgets their password is locked out for
    // good: there is no other recovery path in the app.
    function showAuthPane(which) {
      var panes = { signin: '#authForm', reset: '#resetRequestForm', newpw: '#newPasswordForm' };
      Object.keys(panes).forEach(function (k) {
        var el = qs(panes[k]);
        if (el) el.hidden = k !== which;
      });
      // The mode toggle and the forgot link only make sense on the sign-in pane.
      ['#authSwitchPrompt', '#authSwitchBtn', '#authForgotBtn'].forEach(function (sel) {
        var el = qs(sel);
        if (el && el.parentElement) el.parentElement.hidden = which !== 'signin';
      });
    }

    var forgotBtn = qs('#authForgotBtn');
    if (forgotBtn) {
      forgotBtn.addEventListener('click', function () {
        var err = qs('#resetRequestError');
        var hint = qs('#resetRequestHint');
        if (err) err.textContent = '';
        if (hint) hint.hidden = true;
        var email = (qs('#authEmailInput') || {}).value || '';
        var target = qs('#resetEmailInput');
        if (target) target.value = email;
        showAuthPane('reset');
        if (target) target.focus();
      });
    }

    var backBtn = qs('#resetRequestBackBtn');
    if (backBtn) {
      backBtn.addEventListener('click', function () { showAuthPane('signin'); });
    }

    var resetForm = qs('#resetRequestForm');
    if (resetForm) {
      resetForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var err = qs('#resetRequestError');
        var hint = qs('#resetRequestHint');
        var email = (qs('#resetEmailInput') || {}).value || '';
        if (err) err.textContent = '';
        if (!email.trim()) {
          if (err) err.textContent = t('auth.enterEmail');
          return;
        }
        var release = guardSubmit(resetForm, t('auth.sendResetLink'));
        SW.Auth.requestPasswordReset(email).then(function (result) {
          if (release) release();
          // Deliberately the same message whether or not the address exists,
          // so this cannot be used to find out who has an account.
          if (hint) hint.hidden = false;
          if (!result || !result.ok) {
            if (err) err.textContent = translateError(result && result.error) || '';
          }
        });
      });
    }

    var newPwForm = qs('#newPasswordForm');
    if (newPwForm) {
      newPwForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var err = qs('#newPasswordError');
        var pw = (qs('#newPasswordInput') || {}).value || '';
        if (err) err.textContent = '';
        if (pw.length < 8) {
          if (err) err.textContent = t('auth.passwordTooShort');
          return;
        }
        var release = guardSubmit(newPwForm, t('auth.setNewPassword'));
        SW.Auth.completePasswordReset(pw).then(function (result) {
          if (release) release();
          if (result && result.ok) {
            showAuthPane('signin');
            showToast(t('auth.passwordUpdated'));
          } else if (err) {
            err.textContent = translateError(result && result.error) || '';
          }
        });
      });
    }

    // Expose for the boot path, which needs to show the new-password pane.
    SW.App.showAuthPane = showAuthPane;

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
          if (errorEl) errorEl.textContent = t('auth.enterEmail');
          return;
        }
        if (password.length < 8) {
          if (errorEl) errorEl.textContent = t('auth.passwordTooShort');
          return;
        }
        if (authMode === 'signup' && !name.trim()) {
          if (errorEl) errorEl.textContent = t('auth.enterName');
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
            errorEl.textContent = translateError(result && result.error) || t('auth.signInFailed');
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
            showToast(t('auth.signOutFailedPrefix') + ((err && err.message) || t('sync.unknownError')));
          });
      });
    }

    // ---- join a group with a code ----
    var joinBtn = qs('#joinGroupBtn');
    if (joinBtn) {
      joinBtn.addEventListener('click', function () {
        if (!isRemote()) {
          showToast(t('join.signInFirst'));
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
          if (errorEl) errorEl.textContent = t('join.codeRequired');
          return;
        }
        // Joining needs a round trip - the code has to be checked against
        // the server before we know whether it worked. So the modal stays
        // open, saying what it is doing, until the store reports back.
        var submitBtn = joinForm.querySelector('button[type="submit"]');
        var originalLabel = submitBtn ? submitBtn.textContent : '';
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = t('join.submitting');
        }

        function finished(outcome) {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalLabel;
          }
          if (outcome && outcome.ok) {
            closeModal(qs('#joinModal'));
            showToast(t('join.joined'));
            // Consume the invite link so refreshing does not reopen the dialog.
            if (SW.Router) SW.Router.replaceRoot();
          } else if (errorEl) {
            errorEl.textContent = translateError(outcome && outcome.error) || t('join.failed');
          }
        }

        var result = store().dispatch({
          type: 'JOIN_GROUP',
          payload: { code: code, onResult: finished }
        });

        // A store that rejects the action outright (offline mode, or a
        // malformed code) answers immediately and never calls back.
        if (!result || !result.ok) {
          finished({ ok: false, error: translateError(result && result.error) || t('join.failed') });
        }
      });
    }

    // ---- copy the invite code ----
    var copyBtn = qs('#copyInviteBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var codeEl = qs('#inviteCodeText');
        copyText(codeEl ? codeEl.textContent.trim() : '', t('invite.codeCopied'));
      });
    }

    var copyLinkBtn = qs('#copyInviteLinkBtn');
    if (copyLinkBtn) {
      copyLinkBtn.addEventListener('click', function () {
        copyText(inviteLinkForCurrentGroup, t('invite.linkCopied'));
      });
    }
  }

  var inviteLinkForCurrentGroup = '';

  function openInviteModal(group) {
    var codeEl = qs('#inviteCodeText');
    if (codeEl) codeEl.textContent = group.inviteCode || t('invite.noCode');
    // A link is one tap for the person receiving it; a bare code is a
    // copy-paste and an explanation.
    inviteLinkForCurrentGroup = (SW.Router && group.inviteCode)
      ? SW.Router.inviteUrl(group.inviteCode)
      : '';
    var linkBtn = qs('#copyInviteLinkBtn');
    if (linkBtn) linkBtn.hidden = !inviteLinkForCurrentGroup;
    openModal(qs('#inviteModal'));
  }

  function downloadStateSnapshot(name) {
    try {
      var json = store().exportJSON();
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'splitwise-' + String(name).replace(/[^a-z0-9]+/gi, '-').toLowerCase() +
        '-' + todayISO() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(t('toast.exported'));
    } catch (err) {
      showToast(t('toast.exportFailed'));
    }
  }

  // Who is in this group, when they joined, and how they got in. Makes the
  // invite code auditable: before this, a code was a bare secret with no way
  // to see who had used it.
  function renderMembersModal(group) {
    var list = qs('#membersList');
    var empty = qs('#membersEmpty');
    if (!list || !empty) return;

    if (!group || !group.members.length) {
      list.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    var disambiguate = makeDisambiguator(group);

    list.innerHTML = group.members.map(function (m) {
      var how = m.joinedVia === 'created' ? t('members.methodCreated')
        : m.joinedVia === 'invite_code' ? t('members.methodJoinedCode')
        : '';
      var when = m.joinedAt ? formatDateDisplay(String(m.joinedAt).slice(0, 10)) : '';
      var meta = [when ? t('members.joinedOn', { date: when }) : '', how]
        .filter(function (x) { return x; }).join(' · ');
      return (
        '<li class="member-row">' +
        '<span class="member-row-name">' + esc(m.name) + disambiguate(m) + '</span>' +
        (meta ? '<span class="member-row-meta">' + esc(meta) + '</span>' : '') +
        '</li>'
      );
    }).join('');
  }

  function copyText(text, okMessage) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { showToast(okMessage); },
        function () { showToast(t('invite.copyFailed')); }
      );
    } else {
      showToast(t('invite.copyManually', { text: text }));
    }
  }

  function init() {
    wireStaticEvents();
    wireAuthEvents();
    wireDialogs();

    // SW.I18n.applyStatic() already re-translates the [data-i18n] markup by
    // itself on every language switch. Everything this file builds from a
    // template string (the header, sidebar, group view...) does not go
    // through that - it has to be redrawn from state instead. The sync
    // status pill isn't part of state at all, so it gets its own refresh.
    SW.I18n.onChange(function () {
      if (lastState) render(lastState);
      if (lastSyncStatus) setSyncStatus(lastSyncStatus);
      warnAboutStrandedDemoData();
    });

    // Deep links: ?g=<id> opens a group, ?join=<code> lands a friend on the
    // join step with the code already filled in. Before this there was no way
    // to link to anything at all.
    if (window.SW && SW.Router) {
      SW.Router.init({
        onGroup: function (groupId) {
          pendingGroupFromUrl = groupId;
          store().dispatch({ type: 'SELECT_GROUP', payload: { groupId: groupId } });
        },
        onJoin: function (code) {
          pendingJoinCode = code;
        },
        onRoot: function () {}
      });
    }

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
        // A recovery session is signed in but temporary: the only thing to
        // do with it is set a new password, so that pane wins over the app.
        if (SW.Auth.isPasswordRecovery()) {
          showAuthScreen();
          if (SW.App.showAuthPane) SW.App.showAuthPane('newpw');
          var pw = qs('#newPasswordInput');
          if (pw) pw.focus();
          return;
        }
        if (SW.Auth.isSignedIn()) {
          startRemoteMode();
        } else {
          showAuthScreen();
        }
      })
      .catch(function () {
        // If the backend cannot even be reached, the app is still useful
        // offline - better that than a blank page.
        showToast(t('sync.serverUnreachable'));
        startLocalMode();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
