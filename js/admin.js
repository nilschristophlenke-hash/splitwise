// js/admin.js
//
// The admin console: a read-only documentation/introspection page that
// renders everything it shows DYNAMICALLY from SW.Workflows (plus a live
// look at SW.Store / SW.Model). Nothing about the workflows, data model,
// algorithms or state machine is hard-coded into this file or into
// admin.html — if SW.Workflows changes, this page changes with it.
//
// This file only touches the DOM; it never mutates SW.Store.

var SW = SW || {};

(function () {
  'use strict';

  // ----------------------------------------------------------------------
  // Tiny DOM helpers
  // ----------------------------------------------------------------------

  // Escape a value before it goes into innerHTML. Every piece of dynamic
  // text in this file (workflow titles, file names, JSON dumps, etc.) is
  // technically "user data" in the sense that it comes from another file
  // we don't control the exact contents of, so we escape everything.
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

  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(null, args);
      }, wait);
    };
  }

  // Small inline-SVG icons. Kept as tiny helper functions instead of files
  // so the page stays a single self-contained trio (no network requests).
  function downArrowIcon() {
    return (
      '<svg viewBox="0 0 24 24" width="18" height="18" class="arrow-icon" aria-hidden="true">' +
      '<path d="M12 3 V19 M6 13 L12 19 L18 13" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    );
  }

  function chevronIcon() {
    return (
      '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
      '<path d="M6 9 L12 15 L18 9" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    );
  }

  // Turn an actor name like "localStorage" or "View" into a CSS-safe,
  // predictable class suffix ("localstorage", "view").
  function actorSlug(actor) {
    return String(actor || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }

  // ----------------------------------------------------------------------
  // Login gate
  //
  // Password is the literal string "123". This is a demo gate, stated
  // plainly to the user in admin.html — the check happens entirely on
  // the client and is trivially bypassable via dev tools. It exists only
  // to keep this page out of casual view.
  // ----------------------------------------------------------------------

  var SESSION_KEY = 'splitwise.admin';
  var DEMO_PASSWORD = '123';

  function isAuthed() {
    try {
      return sessionStorage.getItem(SESSION_KEY) === '1';
    } catch (e) {
      // sessionStorage can throw in some private-browsing modes.
      return false;
    }
  }

  function setAuthed() {
    try {
      sessionStorage.setItem(SESSION_KEY, '1');
    } catch (e) {
      // If we can't persist it, the gate just re-appears on nav — acceptable
      // for a demo gate.
    }
  }

  function clearAuthed() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch (e) {
      // no-op
    }
  }

  function initGate() {
    var gate = qs('#login-gate');
    var app = qs('#admin-app');
    var form = qs('#login-form');
    var card = qs('#login-card') || form; // form IS the card element
    var input = qs('#login-password');
    var errorEl = qs('#login-error');
    var logoutBtn = qs('#logout-btn');

    function reveal() {
      gate.hidden = true;
      app.hidden = false;
      bootStoreOnce();
      showSection('overview');
    }

    if (isAuthed()) {
      reveal();
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (input.value === DEMO_PASSWORD) {
        setAuthed();
        errorEl.hidden = true;
        input.value = '';
        reveal();
      } else {
        errorEl.hidden = false;
        input.value = '';
        input.focus();
        // Restart the shake animation even if it's already mid-run.
        card.classList.remove('shake');
        // Force a reflow so re-adding the class re-triggers the animation.
        void card.offsetWidth;
        card.classList.add('shake');
      }
    });

    logoutBtn.addEventListener('click', function () {
      clearAuthed();
      app.hidden = true;
      gate.hidden = false;
      input.value = '';
      input.focus();
    });
  }

  // Load the shared app state once, so "Live state" reflects whatever is
  // in localStorage (the same key the main app reads/writes). Safe to call
  // more than once; guarded so a missing/broken Store never breaks the page.
  var storeBooted = false;
  function bootStoreOnce() {
    if (storeBooted) return;
    storeBooted = true;
    try {
      if (SW.Store && typeof SW.Store.init === 'function') {
        SW.Store.init();
      }
    } catch (e) {
      // Live state section will report this itself when it tries to read.
    }
  }

  // ----------------------------------------------------------------------
  // Navigation
  // ----------------------------------------------------------------------

  function initNav() {
    qsa('.nav-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        showSection(btn.getAttribute('data-section'));
      });
    });

    // Data model and state machine diagrams measure box positions with
    // getBoundingClientRect(), so redraw them if the window is resized
    // while they're the visible section.
    window.addEventListener(
      'resize',
      debounce(function () {
        var active = qs('.nav-btn.active');
        var target = active ? active.getAttribute('data-section') : null;
        if (target === 'data' || target === 'state') {
          renderSection(target);
        }
      }, 200)
    );
  }

  function showSection(target) {
    qsa('.nav-btn').forEach(function (btn) {
      var isActive = btn.getAttribute('data-section') === target;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-current', isActive ? 'page' : 'false');
    });
    qsa('.admin-section').forEach(function (section) {
      section.hidden = section.id !== 'section-' + target;
    });
    renderSection(target);
  }

  // Sections that draw measured diagrams (data model's ER sketch, the
  // state machine) need to be visible (not display:none) when they
  // measure box positions, so we render them fresh every time they're
  // opened rather than once up front. Cheap enough to just always re-render.
  function renderSection(target) {
    switch (target) {
      case 'overview':
        renderOverview();
        break;
      case 'workflows':
        renderWorkflows();
        break;
      case 'data':
        renderDataModel();
        break;
      case 'algorithms':
        renderAlgorithms();
        break;
      case 'state':
        renderStateMachine();
        break;
      case 'live':
        renderLiveState();
        break;
      default:
        break;
    }
  }

  // ----------------------------------------------------------------------
  // Section 1: Overview
  // ----------------------------------------------------------------------

  function renderOverview() {
    var root = qs('#section-overview .section-body');
    if (!root) return;

    var arch = (SW.Workflows && SW.Workflows.ARCHITECTURE) || {};
    var layers = arch.layers || [];
    var principles = arch.principles || [];

    var layerHtml = layers
      .map(function (layer, i) {
        var files = layer.files || [];
        var box =
          '<div class="layer-box">' +
          '<div class="layer-name">' + esc(layer.name || 'Layer ' + (i + 1)) + '</div>' +
          (files.length
            ? '<div class="layer-files">' + files.map(esc).join(', ') + '</div>'
            : '') +
          '<div class="layer-resp">' + esc(layer.responsibility || '') + '</div>' +
          '</div>';
        var arrow =
          i < layers.length - 1
            ? '<div class="layer-arrow">' + downArrowIcon() + '</div>'
            : '';
        return box + arrow;
      })
      .join('');

    var principlesHtml = principles.length
      ? '<h3 class="subhead">Principles</h3><ul class="principles-list">' +
        principles.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') +
        '</ul>'
      : '';

    root.innerHTML =
      '<p class="lead">' +
      esc(arch.summary || 'No architecture summary available (SW.Workflows.ARCHITECTURE not loaded yet).') +
      '</p>' +
      '<h3 class="subhead">Layer stack</h3>' +
      '<div class="layer-stack">' +
      (layerHtml || '<p class="muted">No layers documented.</p>') +
      '</div>' +
      principlesHtml;
  }

  // ----------------------------------------------------------------------
  // Section 2: Workflows
  // ----------------------------------------------------------------------

  var workflowSearchTerm = '';

  function renderWorkflows() {
    var root = qs('#section-workflows .section-body');
    if (!root) return;

    var list = (SW.Workflows && SW.Workflows.LIST) || [];

    root.innerHTML =
      '<div class="search-bar">' +
      '<input type="search" id="workflow-search" placeholder="Search workflows (title, trigger, purpose, steps)…" ' +
      'aria-label="Search workflows" value="' + esc(workflowSearchTerm) + '" />' +
      '<span class="search-count" id="workflow-count"></span>' +
      '</div>' +
      '<div class="workflow-list" id="workflow-cards"></div>';

    var input = qs('#workflow-search', root);
    input.addEventListener('input', function (e) {
      workflowSearchTerm = e.target.value;
      paintWorkflowCards(list);
    });

    paintWorkflowCards(list);
  }

  function workflowMatches(wf, term) {
    if (!term) return true;
    var needle = term.toLowerCase();
    var steps = wf.steps || [];
    var failureModes = wf.failureModes || [];
    var haystack = [
      wf.id,
      wf.title,
      wf.trigger,
      wf.purpose,
      (wf.invariants || []).join(' '),
      failureModes.map(function (f) { return (f.case || '') + ' ' + (f.handling || ''); }).join(' '),
      steps.map(function (s) { return [s.actor, s.action, s.detail, s.file].join(' '); }).join(' '),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.indexOf(needle) !== -1;
  }

  function paintWorkflowCards(list) {
    var container = qs('#workflow-cards');
    var countEl = qs('#workflow-count');
    if (!container) return;

    if (!list.length) {
      container.innerHTML = '<p class="muted">SW.Workflows.LIST is empty or not loaded yet.</p>';
      if (countEl) countEl.textContent = '';
      return;
    }

    var filtered = list.filter(function (wf) {
      return workflowMatches(wf, workflowSearchTerm);
    });

    if (countEl) {
      countEl.textContent = filtered.length + ' / ' + list.length + ' workflows';
    }

    if (!filtered.length) {
      container.innerHTML = '<p class="muted">No workflows match "' + esc(workflowSearchTerm) + '".</p>';
      return;
    }

    container.innerHTML = filtered.map(workflowCardHtml).join('');

    qsa('.workflow-card', container).forEach(function (card) {
      var header = qs('.workflow-card-header', card);
      header.addEventListener('click', function () {
        var willOpen = !card.classList.contains('open');
        card.classList.toggle('open', willOpen);
        header.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      });
    });
  }

  function workflowCardHtml(wf) {
    var steps = wf.steps || [];
    var invariants = wf.invariants || [];
    var failureModes = wf.failureModes || [];

    var stepsHtml = steps
      .map(function (step, i) {
        var isLast = i === steps.length - 1;
        var n = step.n !== undefined && step.n !== null ? step.n : i + 1;
        return (
          '<li class="flow-step">' +
          '<div class="flow-step-marker"><span class="flow-step-n">' + esc(n) + '</span></div>' +
          '<div class="flow-step-body">' +
          '<div class="flow-step-top">' +
          '<span class="actor-badge actor-' + esc(actorSlug(step.actor)) + '">' +
          esc(step.actor || 'Unknown') +
          '</span>' +
          '<span class="flow-step-action">' + esc(step.action || '') + '</span>' +
          '</div>' +
          (step.detail ? '<div class="flow-step-detail">' + esc(step.detail) + '</div>' : '') +
          (step.file ? '<div class="flow-step-file"><code>' + esc(step.file) + '</code></div>' : '') +
          '</div>' +
          (!isLast ? '<div class="flow-step-arrow">' + downArrowIcon() + '</div>' : '') +
          '</li>'
        );
      })
      .join('');

    var invariantsHtml = invariants.length
      ? '<h4 class="subhead-sm">Invariants</h4><ul class="invariants-list">' +
        invariants.map(function (inv) { return '<li>' + esc(inv) + '</li>'; }).join('') +
        '</ul>'
      : '';

    var failuresHtml = failureModes.length
      ? '<h4 class="subhead-sm">Failure modes</h4><table class="failure-table"><tbody>' +
        failureModes
          .map(function (f) {
            return (
              '<tr><td class="fail-case">' + esc(f.case || '') + '</td>' +
              '<td class="fail-handling">' + esc(f.handling || '') + '</td></tr>'
            );
          })
          .join('') +
        '</tbody></table>'
      : '';

    return (
      '<article class="workflow-card" id="wf-' + esc(wf.id || '') + '">' +
      '<button type="button" class="workflow-card-header" aria-expanded="false">' +
      '<span class="workflow-title">' + esc(wf.title || wf.id || 'Untitled workflow') + '</span>' +
      '<span class="workflow-trigger">' + esc(wf.trigger || '') + '</span>' +
      '<span class="workflow-toggle-icon">' + chevronIcon() + '</span>' +
      '</button>' +
      '<div class="workflow-card-body">' +
      (wf.purpose ? '<p class="workflow-purpose">' + esc(wf.purpose) + '</p>' : '') +
      (steps.length
        ? '<ol class="flow-diagram">' + stepsHtml + '</ol>'
        : '<p class="muted">No steps documented.</p>') +
      invariantsHtml +
      failuresHtml +
      '</div>' +
      '</article>'
    );
  }

  // ----------------------------------------------------------------------
  // Section 3: Data model
  // ----------------------------------------------------------------------

  function renderDataModel() {
    var root = qs('#section-data .section-body');
    if (!root) return;

    var entities = (SW.Workflows && SW.Workflows.DATA_MODEL) || [];

    if (!entities.length) {
      root.innerHTML = '<p class="muted">SW.Workflows.DATA_MODEL is empty or not loaded yet.</p>';
      return;
    }

    var tablesHtml = entities
      .map(function (ent) {
        var fields = ent.fields || [];
        var relations = ent.relations || [];
        return (
          '<div class="entity-block">' +
          '<h3 class="entity-name">' + esc(ent.entity || 'Entity') + '</h3>' +
          '<table class="field-table"><thead><tr><th>Field</th><th>Type</th><th>Note</th></tr></thead><tbody>' +
          fields
            .map(function (f) {
              return (
                '<tr><td><code>' + esc(f.name || '') + '</code></td>' +
                '<td>' + esc(f.type || '') + '</td>' +
                '<td>' + esc(f.note || '') + '</td></tr>'
              );
            })
            .join('') +
          '</tbody></table>' +
          (relations.length
            ? '<ul class="relations-list">' +
              relations.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') +
              '</ul>'
            : '') +
          '</div>'
        );
      })
      .join('');

    root.innerHTML =
      '<h3 class="subhead">Entities</h3>' +
      '<div class="entity-tables">' + tablesHtml + '</div>' +
      '<h3 class="subhead">Entity-relationship sketch</h3>' +
      '<div class="er-sketch-wrap">' +
      '<div class="er-boxes" id="er-boxes"></div>' +
      '<svg class="er-lines" id="er-lines"></svg>' +
      '</div>';

    drawERSketch(entities);
  }

  // Draws entity boxes, then measures their rendered positions and draws
  // SVG connector lines between entities whose relation text mentions
  // another known entity name (e.g. "has many Expense (by groupId)" links
  // Group -> Expense). Pure inline SVG, no libraries.
  function drawERSketch(entities) {
    var boxesContainer = qs('#er-boxes');
    var svg = qs('#er-lines');
    if (!boxesContainer || !svg) return;

    var names = entities.map(function (e) { return e.entity; }).filter(Boolean);

    boxesContainer.innerHTML = entities
      .map(function (ent) {
        var fields = ent.fields || [];
        var fieldNames = fields.slice(0, 5).map(function (f) { return esc(f.name); }).join(', ');
        return (
          '<div class="er-box" data-entity="' + esc(ent.entity || '') + '">' +
          '<div class="er-box-title">' + esc(ent.entity || 'Entity') + '</div>' +
          '<div class="er-box-fields">' + fieldNames + (fields.length > 5 ? ', …' : '') + '</div>' +
          '</div>'
        );
      })
      .join('');

    // Build an edge list from relation text: for each entity's relations,
    // find which other known entity names are mentioned.
    var edges = [];
    entities.forEach(function (ent) {
      (ent.relations || []).forEach(function (rel) {
        names.forEach(function (other) {
          if (other && other !== ent.entity && rel.indexOf(other) !== -1) {
            edges.push({ from: ent.entity, to: other, label: rel });
          }
        });
      });
    });

    // Wait a frame so the boxes are laid out before we measure them.
    requestAnimationFrame(function () {
      var wrapRect = boxesContainer.getBoundingClientRect();
      if (!wrapRect.width || !wrapRect.height) return; // section not visible

      svg.setAttribute('width', wrapRect.width);
      svg.setAttribute('height', wrapRect.height);
      svg.setAttribute('viewBox', '0 0 ' + wrapRect.width + ' ' + wrapRect.height);

      var centers = {};
      qsa('.er-box', boxesContainer).forEach(function (box) {
        var r = box.getBoundingClientRect();
        centers[box.getAttribute('data-entity')] = {
          x: r.left - wrapRect.left + r.width / 2,
          y: r.top - wrapRect.top + r.height / 2,
        };
      });

      var markerDefs =
        '<defs><marker id="er-arrow" viewBox="0 0 10 10" refX="9" refY="5" ' +
        'markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
        '<path d="M0,0 L10,5 L0,10 z" fill="var(--accent)"></path></marker></defs>';

      var lines = edges
        .map(function (edge) {
          var a = centers[edge.from];
          var b = centers[edge.to];
          if (!a || !b) return '';
          return (
            '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" ' +
            'class="er-line" marker-end="url(#er-arrow)"><title>' + esc(edge.label) + '</title></line>'
          );
        })
        .join('');

      svg.innerHTML = markerDefs + lines;
    });
  }

  // ----------------------------------------------------------------------
  // Section 4: Algorithms
  // ----------------------------------------------------------------------

  function renderAlgorithms() {
    var root = qs('#section-algorithms .section-body');
    if (!root) return;

    var algos = (SW.Workflows && SW.Workflows.ALGORITHMS) || [];

    if (!algos.length) {
      root.innerHTML = '<p class="muted">SW.Workflows.ALGORITHMS is empty or not loaded yet.</p>';
      return;
    }

    root.innerHTML = algos
      .map(function (a) {
        return (
          '<article class="algo-card">' +
          '<h3 class="algo-name">' + esc(a.name || a.id || 'Algorithm') + '</h3>' +
          (a.complexity ? '<span class="algo-complexity">' + esc(a.complexity) + '</span>' : '') +
          (a.problem ? '<h4 class="subhead-sm">Problem</h4><p>' + esc(a.problem) + '</p>' : '') +
          (a.approach ? '<h4 class="subhead-sm">Approach</h4><p>' + esc(a.approach) + '</p>' : '') +
          (a.pseudocode
            ? '<h4 class="subhead-sm">Pseudocode</h4><pre class="pseudocode">' + esc(a.pseudocode) + '</pre>'
            : '') +
          (a.worked_example
            ? '<h4 class="subhead-sm">Worked example</h4><p class="worked-example">' + esc(a.worked_example) + '</p>'
            : '') +
          '</article>'
        );
      })
      .join('');
  }

  // ----------------------------------------------------------------------
  // Section 5: State machine
  // ----------------------------------------------------------------------

  function renderStateMachine() {
    var root = qs('#section-state .section-body');
    if (!root) return;

    var sm = (SW.Workflows && SW.Workflows.STATE_MACHINE) || {};
    var states = sm.states || [];
    var transitions = sm.transitions || [];

    if (!states.length) {
      root.innerHTML = '<p class="muted">SW.Workflows.STATE_MACHINE is empty or not loaded yet.</p>';
      return;
    }

    var tableHtml =
      '<table class="field-table"><thead><tr><th>From</th><th>To</th><th>On</th></tr></thead><tbody>' +
      transitions
        .map(function (t) {
          return (
            '<tr><td>' + esc(t.from || '') + '</td><td>' + esc(t.to || '') + '</td>' +
            '<td>' + esc(t.on || '') + '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table>';

    root.innerHTML =
      '<div class="sm-wrap"><div class="sm-boxes" id="sm-boxes"></div><svg class="sm-lines" id="sm-lines"></svg></div>' +
      '<h3 class="subhead">Transition table</h3>' +
      tableHtml;

    drawStateMachine(states, transitions);
  }

  function drawStateMachine(states, transitions) {
    var boxesContainer = qs('#sm-boxes');
    var svg = qs('#sm-lines');
    if (!boxesContainer || !svg) return;

    boxesContainer.innerHTML = states
      .map(function (s) {
        return (
          '<div class="sm-box" data-state="' + esc(s.id || '') + '"><span>' +
          esc(s.label || s.id || 'State') + '</span></div>'
        );
      })
      .join('');

    requestAnimationFrame(function () {
      var wrapRect = boxesContainer.getBoundingClientRect();
      if (!wrapRect.width || !wrapRect.height) return; // section not visible

      svg.setAttribute('width', wrapRect.width);
      svg.setAttribute('height', wrapRect.height);
      svg.setAttribute('viewBox', '0 0 ' + wrapRect.width + ' ' + wrapRect.height);

      var centers = {};
      qsa('.sm-box', boxesContainer).forEach(function (box) {
        var r = box.getBoundingClientRect();
        centers[box.getAttribute('data-state')] = {
          x: r.left - wrapRect.left + r.width / 2,
          y: r.top - wrapRect.top + r.height / 2,
        };
      });

      var markerDefs =
        '<defs><marker id="sm-arrow" viewBox="0 0 10 10" refX="9" refY="5" ' +
        'markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
        '<path d="M0,0 L10,5 L0,10 z" fill="var(--accent)"></path></marker></defs>';

      var lines = transitions
        .map(function (t) {
          var a = centers[t.from];
          var b = centers[t.to];
          if (!a || !b) return '';

          if (t.from === t.to) {
            // Self-transition: draw a small loop above the box.
            var loop =
              'M' + (a.x - 22) + ',' + (a.y - 28) +
              ' C' + (a.x - 46) + ',' + (a.y - 70) + ' ' + (a.x + 46) + ',' + (a.y - 70) + ' ' +
              (a.x + 22) + ',' + (a.y - 28);
            return (
              '<path d="' + loop + '" class="sm-line" fill="none" marker-end="url(#sm-arrow)">' +
              '<title>' + esc(t.on || '') + '</title></path>'
            );
          }

          return (
            '<line x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" ' +
            'class="sm-line" marker-end="url(#sm-arrow)"><title>' + esc(t.on || '') + '</title></line>'
          );
        })
        .join('');

      svg.innerHTML = markerDefs + lines;
    });
  }

  // ----------------------------------------------------------------------
  // Section 6: Live state
  // ----------------------------------------------------------------------

  function statTile(label, value) {
    return (
      '<div class="stat-tile"><div class="stat-value">' + esc(value) + '</div>' +
      '<div class="stat-label">' + esc(label) + '</div></div>'
    );
  }

  function renderLiveState() {
    var root = qs('#section-live .section-body');
    if (!root) return;

    if (!SW.Store || typeof SW.Store.getState !== 'function') {
      root.innerHTML = '<p class="muted">SW.Store is not loaded yet — live state is unavailable.</p>';
      return;
    }

    bootStoreOnce();

    var state;
    try {
      state = SW.Store.getState();
    } catch (e) {
      root.innerHTML = '<p class="muted">SW.Store.getState() threw: ' + esc(e.message) + '</p>';
      return;
    }

    if (!state) {
      root.innerHTML = '<p class="muted">SW.Store.getState() returned nothing.</p>';
      return;
    }

    var groups = state.groups || [];
    var expenses = state.expenses || [];
    var memberCount = groups.reduce(function (sum, g) { return sum + (g.members || []).length; }, 0);
    var expenseCount = expenses.filter(function (e) { return e.type !== 'settlement'; }).length;
    var settlementCount = expenses.filter(function (e) { return e.type === 'settlement'; }).length;

    var statsHtml =
      '<div class="stat-grid">' +
      statTile('Groups', groups.length) +
      statTile('Members', memberCount) +
      statTile('Expenses', expenseCount) +
      statTile('Settlements', settlementCount) +
      '</div>';

    var balancesHtml =
      groups
        .map(function (g) {
          var balances = {};
          try {
            if (SW.Model && typeof SW.Model.computeBalances === 'function') {
              balances = SW.Model.computeBalances(g.id, groups, expenses) || {};
            }
          } catch (e) {
            balances = {};
          }

          var rows = (g.members || [])
            .map(function (m) {
              var net = balances[m.id] || 0;
              var cls = net > 0 ? 'balance-positive' : net < 0 ? 'balance-negative' : '';
              var formatted =
                SW.Model && typeof SW.Model.formatSigned === 'function'
                  ? SW.Model.formatSigned(net, g.currency)
                  : String(net);
              return (
                '<tr><td>' + esc(m.name) + '</td><td class="' + cls + '">' + esc(formatted) + '</td></tr>'
              );
            })
            .join('');

          return (
            '<div class="group-balance-block">' +
            '<h4 class="subhead-sm">' + esc(g.name) + '</h4>' +
            '<table class="field-table"><thead><tr><th>Member</th><th>Net balance</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table>' +
            '</div>'
          );
        })
        .join('') || '<p class="muted">No groups yet.</p>';

    var jsonHtml =
      '<details class="json-details"><summary>Raw state (click to expand)</summary>' +
      '<pre class="json-pretty">' + esc(safeStringify(state)) + '</pre>' +
      '</details>';

    root.innerHTML =
      statsHtml +
      '<h3 class="subhead">Per-group balances</h3>' +
      balancesHtml +
      '<h3 class="subhead">Raw state</h3>' +
      jsonHtml +
      '<h3 class="subhead">Integrity checks</h3>' +
      '<div id="integrity-panel"></div>';

    runIntegrityChecks(state);
  }

  function safeStringify(state) {
    try {
      return JSON.stringify(state, null, 2);
    } catch (e) {
      return 'Could not stringify state: ' + e.message;
    }
  }

  // Runs real assertions against the current state, right now, and reports
  // PASS/FAIL — this is not a static description of checks, it actually
  // executes them via SW.Model.
  function runIntegrityChecks(state) {
    var panel = qs('#integrity-panel');
    if (!panel) return;

    if (!SW.Model) {
      panel.innerHTML = '<p class="muted">SW.Model is not loaded yet — cannot run integrity checks.</p>';
      return;
    }

    var groups = state.groups || [];
    var expenses = state.expenses || [];
    var checks = [];

    // 1. Balances sum to zero, per group.
    (function () {
      var allOk = true;
      var details = [];
      groups.forEach(function (g) {
        try {
          var balances =
            typeof SW.Model.computeBalances === 'function'
              ? SW.Model.computeBalances(g.id, groups, expenses)
              : {};
          var sum = Object.keys(balances).reduce(function (s, k) { return s + balances[k]; }, 0);
          if (sum !== 0) {
            allOk = false;
            details.push(g.name + ': sum=' + sum);
          }
        } catch (e) {
          allOk = false;
          details.push(g.name + ': threw ' + e.message);
        }
      });
      checks.push({
        name: 'Balances sum to zero (every group)',
        pass: allOk,
        detail: details.join('; '),
      });
    })();

    // 2. Every expense's shares sum to its amount.
    (function () {
      var allOk = true;
      var details = [];
      expenses.forEach(function (e) {
        try {
          if (typeof SW.Model.splitExpense !== 'function') {
            allOk = false;
            details.push('SW.Model.splitExpense missing');
            return;
          }
          var result = SW.Model.splitExpense(e.amountCents, e.splitMode, e.participants);
          if (!result || !result.ok) {
            allOk = false;
            details.push(e.id + ': ' + (result && result.error ? result.error : 'split failed'));
            return;
          }
          var sum = result.shares.reduce(function (s, sh) { return s + sh.shareCents; }, 0);
          if (sum !== e.amountCents) {
            allOk = false;
            details.push(e.id + ': shares sum ' + sum + ' ≠ amount ' + e.amountCents);
          }
        } catch (err) {
          allOk = false;
          details.push(e.id + ': threw ' + err.message);
        }
      });
      checks.push({
        name: "Every expense's shares sum to its amount",
        pass: allOk,
        detail: details.join('; '),
      });
    })();

    // 3. No orphan expenses: groupId, paidBy and every participant resolve
    //    to a real group / real member of that group.
    (function () {
      var allOk = true;
      var details = [];
      var groupById = {};
      groups.forEach(function (g) { groupById[g.id] = g; });

      expenses.forEach(function (e) {
        var g = groupById[e.groupId];
        if (!g) {
          allOk = false;
          details.push(e.id + ': unknown group ' + e.groupId);
          return;
        }
        var memberIds = (g.members || []).map(function (m) { return m.id; });
        if (memberIds.indexOf(e.paidBy) === -1) {
          allOk = false;
          details.push(e.id + ': paidBy ' + e.paidBy + ' is not a member of ' + g.name);
        }
        (e.participants || []).forEach(function (p) {
          if (memberIds.indexOf(p.memberId) === -1) {
            allOk = false;
            details.push(e.id + ': participant ' + p.memberId + ' is not a member of ' + g.name);
          }
        });
      });

      checks.push({
        name: 'No orphan expenses (group / payer / participants all resolve)',
        pass: allOk,
        detail: details.join('; '),
      });
    })();

    // 4. Member ids are unique within each group.
    (function () {
      var allOk = true;
      var details = [];
      groups.forEach(function (g) {
        var ids = (g.members || []).map(function (m) { return m.id; });
        var unique = {};
        ids.forEach(function (id) { unique[id] = true; });
        if (Object.keys(unique).length !== ids.length) {
          allOk = false;
          details.push(g.name + ': duplicate member ids');
        }
      });
      checks.push({
        name: 'Member ids unique within each group',
        pass: allOk,
        detail: details.join('; '),
      });
    })();

    // 5. No duplicate expense ids across the whole store.
    (function () {
      var ids = expenses.map(function (e) { return e.id; });
      var unique = {};
      ids.forEach(function (id) { unique[id] = true; });
      var ok = Object.keys(unique).length === ids.length;
      checks.push({
        name: 'No duplicate expense ids',
        pass: ok,
        detail: ok ? '' : 'duplicate ids found among ' + ids.length + ' expenses',
      });
    })();

    panel.innerHTML = checks
      .map(function (c) {
        return (
          '<div class="integrity-row">' +
          '<span class="badge ' + (c.pass ? 'badge-pass' : 'badge-fail') + '">' +
          (c.pass ? 'PASS' : 'FAIL') +
          '</span>' +
          '<span class="integrity-name">' + esc(c.name) + '</span>' +
          (!c.pass && c.detail ? '<span class="integrity-detail">' + esc(c.detail) + '</span>' : '') +
          '</div>'
        );
      })
      .join('');
  }

  // ----------------------------------------------------------------------
  // Boot
  // ----------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    initGate();
    initNav();
  });
})();
