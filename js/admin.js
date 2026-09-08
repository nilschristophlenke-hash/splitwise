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

  // An elbow/curve connector used to visually tie a branch pill back to the
  // spine node it hangs off. Purely decorative — it never needs measuring,
  // so it stays cheap and never breaks on resize the way the ER/state-machine
  // sketches (which DO measure box positions) could.
  function elbowIcon() {
    return (
      '<svg viewBox="0 0 24 24" width="16" height="16" class="elbow-icon" aria-hidden="true">' +
      '<path d="M4 2 V12 Q4 18 10 18 H20" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    );
  }

  // Warning triangle used to flag known-gap edge cases wherever they show up.
  function warningIcon() {
    return (
      '<svg viewBox="0 0 24 24" width="14" height="14" class="warning-icon" aria-hidden="true">' +
      '<path d="M12 3 L22 20 H2 Z" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linejoin="round"/><line x1="12" y1="9" x2="12" y2="14" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1" fill="currentColor"/></svg>'
    );
  }

  // Checkmark used on the journey's terminal ("everyone settled up") node.
  function checkIcon() {
    return (
      '<svg viewBox="0 0 24 24" width="20" height="20" class="check-icon" aria-hidden="true">' +
      '<path d="M4 12 L10 18 L20 6" fill="none" stroke="currentColor" stroke-width="2.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>'
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
      showSection('journey');
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
      case 'journey':
        renderJourney();
        break;
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
  // Shared renderers for "workflow-shaped" data (steps / invariants /
  // failure modes / edge cases). Used by the Workflows section's cards AND
  // by the Journey section's stage detail, branch detail and cross-cutting
  // cards, so all four places render this data identically.
  // ----------------------------------------------------------------------

  // Renders just the <li> items of a steps list (caller wraps in <ol class="flow-diagram">).
  function stepsListHtml(steps) {
    steps = Array.isArray(steps) ? steps : [];
    return steps
      .map(function (step, i) {
        if (!step) return '';
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
  }

  function invariantsSectionHtml(invariants) {
    invariants = Array.isArray(invariants) ? invariants : [];
    if (!invariants.length) return '';
    return (
      '<h4 class="subhead-sm">Invariants</h4><ul class="invariants-list">' +
      invariants.map(function (inv) { return '<li>' + esc(inv) + '</li>'; }).join('') +
      '</ul>'
    );
  }

  function failureModesSectionHtml(failureModes) {
    failureModes = Array.isArray(failureModes) ? failureModes : [];
    if (!failureModes.length) return '';
    return (
      '<h4 class="subhead-sm">Failure modes</h4><table class="failure-table"><tbody>' +
      failureModes
        .map(function (f) {
          if (!f) return '';
          return (
            '<tr><td class="fail-case">' + esc(f.case || '') + '</td>' +
            '<td class="fail-handling">' + esc(f.handling || '') + '</td></tr>'
          );
        })
        .join('') +
      '</tbody></table>'
    );
  }

  // Edge cases are the honesty mechanism of the whole console: a known-gap
  // row gets a loud, unmistakable warning treatment (not a subtle tint) so
  // it can never quietly blend in with the handled ones.
  function edgeCasesSectionHtml(edgeCases) {
    edgeCases = Array.isArray(edgeCases) ? edgeCases : [];
    if (!edgeCases.length) return '';
    var rows = edgeCases
      .map(function (ec) {
        if (!ec) return '';
        var isGap = ec.status === 'known-gap';
        return (
          '<tr class="' + (isGap ? 'edgecase-row edgecase-row-gap' : 'edgecase-row edgecase-row-handled') + '">' +
          '<td class="edgecase-status">' +
          '<span class="' + (isGap ? 'edgecase-badge edgecase-badge-gap' : 'edgecase-badge edgecase-badge-handled') + '">' +
          (isGap ? warningIcon() : '') +
          (isGap ? 'KNOWN GAP' : 'HANDLED') +
          '</span></td>' +
          '<td class="edgecase-case">' + esc(ec.case || '') + '</td>' +
          '<td class="edgecase-handling">' + esc(ec.handling || '') + '</td>' +
          '</tr>'
        );
      })
      .join('');
    return (
      '<h4 class="subhead-sm">Edge cases</h4>' +
      '<table class="edgecase-table"><thead><tr><th>Status</th><th>Case</th><th>Handling</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>'
    );
  }

  // Counts known-gap edge cases in a list, for the little warning flags
  // shown on stage nodes / branch pills / cross-cutting cards.
  function countKnownGaps(edgeCases) {
    edgeCases = Array.isArray(edgeCases) ? edgeCases : [];
    return edgeCases.filter(function (ec) { return ec && ec.status === 'known-gap'; }).length;
  }

  function gapFlagHtml(count) {
    if (!count) return '';
    return (
      '<span class="gap-flag" title="' + esc(count) + ' known gap' + (count === 1 ? '' : 's') + '">' +
      warningIcon() + esc(count) +
      '</span>'
    );
  }

  // The full body of a workflow-shaped record: purpose, steps, invariants,
  // failure modes, edge cases. Used for LIST entries both in the Workflows
  // section and (via id lookup) as Journey branch/cross-cutting detail.
  function workflowDetailBodyHtml(wf) {
    if (!wf) return '<p class="muted">Workflow not found.</p>';
    var steps = Array.isArray(wf.steps) ? wf.steps : [];
    return (
      (wf.purpose ? '<p class="workflow-purpose">' + esc(wf.purpose) + '</p>' : '') +
      (steps.length
        ? '<ol class="flow-diagram">' + stepsListHtml(steps) + '</ol>'
        : '<p class="muted">No steps documented.</p>') +
      invariantsSectionHtml(wf.invariants) +
      failureModesSectionHtml(wf.failureModes) +
      edgeCasesSectionHtml(wf.edgeCases)
    );
  }

  // Toggles one collapsible detail panel open/closed, keeping its trigger
  // button's aria-expanded in sync. Shared by every expandable thing in the
  // Journey section (stage nodes, branch pills, cross-cutting cards).
  function toggleDetail(btn, detail) {
    if (!detail) return;
    var willOpen = !detail.classList.contains('open');
    detail.classList.toggle('open', willOpen);
    if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  }

  // ----------------------------------------------------------------------
  // Section 0: Journey — the master spine
  //
  // Renders SW.Workflows.JOURNEY as one continuous vertical flow: stages in
  // order, ending in the terminal "everyone settled up" node. Each stage's
  // branches (workflow ids from SW.Workflows.LIST) hang off it in an
  // indented rail with an elbow connector, so it's always obvious which
  // stage a branch belongs to. Cross-cutting LIST entries (stage: null)
  // render as a separate band below the spine.
  // ----------------------------------------------------------------------

  function renderJourney() {
    var root = qs('#section-journey .section-body');
    if (!root) return;

    var journey = SW.Workflows && SW.Workflows.JOURNEY;
    var list = (SW.Workflows && SW.Workflows.LIST) || [];

    if (!journey || !Array.isArray(journey.stages) || !journey.stages.length) {
      root.innerHTML = '<p class="muted">SW.Workflows.JOURNEY is missing, malformed, or not loaded yet.</p>';
      return;
    }

    // Map every LIST entry by id so stage.branches (an array of ids) can
    // look up the full workflow record to render inline.
    var byId = {};
    list.forEach(function (wf) {
      if (wf && wf.id) byId[wf.id] = wf;
    });

    var allEdgeCases = [];
    journey.stages.forEach(function (stage) {
      if (stage && Array.isArray(stage.edgeCases)) {
        allEdgeCases = allEdgeCases.concat(stage.edgeCases);
      }
    });
    list.forEach(function (wf) {
      if (wf && Array.isArray(wf.edgeCases)) {
        allEdgeCases = allEdgeCases.concat(wf.edgeCases);
      }
    });
    var handledCount = allEdgeCases.filter(function (ec) { return ec && ec.status === 'handled'; }).length;
    var gapCount = countKnownGaps(allEdgeCases);

    var summaryHtml =
      (journey.summary ? '<p class="lead">' + esc(journey.summary) + '</p>' : '') +
      '<div class="journey-gap-summary">' +
      '<span class="gap-chip gap-chip-handled">' + esc(handledCount) + ' edge case' +
      (handledCount === 1 ? '' : 's') + ' handled</span>' +
      '<span class="gap-chip gap-chip-gap">' + (gapCount ? warningIcon() : '') + esc(gapCount) +
      ' known gap' + (gapCount === 1 ? '' : 's') + '</span>' +
      '</div>';

    var spineHtml = journey.stages
      .map(function (stage, i) {
        return journeyStageHtml(stage, i === journey.stages.length - 1, byId);
      })
      .join('');

    var terminalHtml = journeyTerminalHtml(journey.terminal);

    var crossCutting = list.filter(function (wf) { return wf && wf.kind === 'cross-cutting'; });
    var crossCuttingHtml = crossCutting.length ? journeyCrossCuttingHtml(crossCutting) : '';

    root.innerHTML =
      '<div class="journey-summary">' + summaryHtml + '</div>' +
      '<div class="journey-spine">' + spineHtml + terminalHtml + '</div>' +
      crossCuttingHtml;

    wireJourneyInteractions(root);
  }

  function journeyStageHtml(stage, isLast, byId) {
    if (!stage) return '';
    var id = stage.id || '';
    var n = stage.n !== undefined && stage.n !== null ? stage.n : '';
    var branches = Array.isArray(stage.branches) ? stage.branches : [];
    var stageGapCount = countKnownGaps(stage.edgeCases);

    var branchesHtml = branches
      .map(function (branchId) {
        var wf = byId[branchId];
        if (!wf) {
          return (
            '<div class="journey-branch journey-branch-missing">' +
            elbowIcon() +
            '<span class="journey-branch-title muted">unknown workflow: ' + esc(branchId) + '</span>' +
            '</div>'
          );
        }
        var wfGapCount = countKnownGaps(wf.edgeCases);
        return (
          '<div class="journey-branch">' +
          '<button type="button" class="journey-branch-btn" aria-expanded="false" data-branch-id="' + esc(wf.id) + '">' +
          elbowIcon() +
          '<span class="journey-branch-title">' + esc(wf.title || wf.id) + '</span>' +
          gapFlagHtml(wfGapCount) +
          '<span class="journey-branch-chevron">' + chevronIcon() + '</span>' +
          '</button>' +
          '<div class="journey-branch-detail">' + workflowDetailBodyHtml(wf) + '</div>' +
          '</div>'
        );
      })
      .join('');

    var entryExitHtml =
      (stage.entry || stage.exit)
        ? '<div class="journey-entry-exit">' +
          (stage.entry ? '<div><h4 class="subhead-sm">Entry condition</h4><p>' + esc(stage.entry) + '</p></div>' : '') +
          (stage.exit ? '<div><h4 class="subhead-sm">Exit condition</h4><p>' + esc(stage.exit) + '</p></div>' : '') +
          '</div>'
        : '';

    var detailHtml =
      entryExitHtml +
      (Array.isArray(stage.steps) && stage.steps.length
        ? '<h4 class="subhead-sm">Steps</h4><ol class="flow-diagram">' + stepsListHtml(stage.steps) + '</ol>'
        : '') +
      invariantsSectionHtml(stage.invariants) +
      edgeCasesSectionHtml(stage.edgeCases);

    return (
      '<div class="journey-stage" id="journey-stage-' + esc(id) + '">' +
      '<div class="journey-stage-row">' +
      '<div class="journey-stage-spine">' +
      '<div class="journey-node-circle">' + esc(n) + '</div>' +
      (isLast ? '' : '<div class="journey-connector"></div>') +
      '</div>' +
      '<div class="journey-stage-content">' +
      '<button type="button" class="journey-node-header" aria-expanded="false">' +
      '<span class="journey-node-title">' + esc(stage.title || id || 'Stage') + '</span>' +
      '<span class="journey-node-purpose">' + esc(stage.purpose || '') + '</span>' +
      gapFlagHtml(stageGapCount) +
      '<span class="journey-node-chevron">' + chevronIcon() + '</span>' +
      '</button>' +
      '<div class="journey-stage-detail">' + detailHtml + '</div>' +
      (branches.length
        ? '<div class="journey-branches-rail"><div class="journey-branches-label">Branches</div>' + branchesHtml + '</div>'
        : '') +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function journeyTerminalHtml(terminal) {
    if (!terminal) return '';
    return (
      '<div class="journey-terminal">' +
      '<div class="journey-stage-row">' +
      '<div class="journey-stage-spine"><div class="journey-node-circle journey-terminal-circle">' + checkIcon() + '</div></div>' +
      '<div class="journey-stage-content">' +
      '<div class="journey-terminal-title">' + esc(terminal.title || terminal.id || 'Settled') + '</div>' +
      (terminal.description ? '<p class="journey-terminal-desc">' + esc(terminal.description) + '</p>' : '') +
      invariantsSectionHtml(terminal.invariants) +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function journeyCrossCuttingHtml(entries) {
    var cardsHtml = entries
      .map(function (wf) {
        var gapCount = countKnownGaps(wf.edgeCases);
        return (
          '<div class="cross-cutting-card">' +
          '<button type="button" class="cross-cutting-header" aria-expanded="false" data-cross-id="' + esc(wf.id || '') + '">' +
          '<span class="cross-cutting-title">' + esc(wf.title || wf.id || 'Untitled') + '</span>' +
          (wf.trigger ? '<span class="cross-cutting-trigger">' + esc(wf.trigger) + '</span>' : '') +
          gapFlagHtml(gapCount) +
          '<span class="cross-cutting-chevron">' + chevronIcon() + '</span>' +
          '</button>' +
          '<div class="cross-cutting-detail">' + workflowDetailBodyHtml(wf) + '</div>' +
          '</div>'
        );
      })
      .join('');

    return (
      '<div class="journey-crosscutting">' +
      '<h3 class="subhead">Cross-cutting concerns</h3>' +
      '<p class="journey-crosscutting-desc">These apply at every stage, rather than at one point on the spine.</p>' +
      '<div class="cross-cutting-list">' + cardsHtml + '</div>' +
      '</div>'
    );
  }

  function wireJourneyInteractions(root) {
    qsa('.journey-node-header', root).forEach(function (btn) {
      var content = btn.parentElement;
      var detail = content ? qs('.journey-stage-detail', content) : null;
      btn.addEventListener('click', function () {
        toggleDetail(btn, detail);
      });
    });

    qsa('.journey-branch-btn', root).forEach(function (btn) {
      var wrap = btn.parentElement;
      var detail = wrap ? qs('.journey-branch-detail', wrap) : null;
      btn.addEventListener('click', function () {
        toggleDetail(btn, detail);
      });
    });

    qsa('.cross-cutting-header', root).forEach(function (btn) {
      var card = btn.parentElement;
      var detail = card ? qs('.cross-cutting-detail', card) : null;
      btn.addEventListener('click', function () {
        toggleDetail(btn, detail);
      });
    });
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
    var edgeCases = wf.edgeCases || [];
    var haystack = [
      wf.id,
      wf.title,
      wf.trigger,
      wf.purpose,
      (wf.invariants || []).join(' '),
      failureModes.map(function (f) { return (f.case || '') + ' ' + (f.handling || ''); }).join(' '),
      edgeCases.map(function (ec) { return (ec.case || '') + ' ' + (ec.handling || ''); }).join(' '),
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

  // Renders one workflow's card using the same shared step/invariant/
  // failure-mode/edge-case renderers the Journey section uses, so a
  // workflow's LIST entry looks the same whether it's found here or
  // expanded as a Journey branch / cross-cutting card.
  function workflowCardHtml(wf) {
    return (
      '<article class="workflow-card" id="wf-' + esc(wf.id || '') + '">' +
      '<button type="button" class="workflow-card-header" aria-expanded="false">' +
      '<span class="workflow-title">' + esc(wf.title || wf.id || 'Untitled workflow') + '</span>' +
      '<span class="workflow-trigger">' + esc(wf.trigger || '') + '</span>' +
      '<span class="workflow-toggle-icon">' + chevronIcon() + '</span>' +
      '</button>' +
      '<div class="workflow-card-body">' + workflowDetailBodyHtml(wf) + '</div>' +
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
        // Everything else here treats missing/odd data defensively; a
        // non-string relation would be the one thing left that throws.
        if (typeof rel !== 'string') return;
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
    // Two assertions in one, because the zero-sum half alone is close to a
    // tautology: computeBalances credits the payer the full amount and
    // debits shares that splitExpense guarantees add up to that same
    // amount, so it nets to zero almost no matter how bad the data is.
    // What CAN go wrong is an expense being silently skipped - splitExpense
    // rejects it, computeBalances ignores it, and the record then shows in
    // the expense list and the "total spent" figure while contributing
    // nothing to anyone's balance. That is the failure this catches.
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
            details.push(g.name + ': balances sum to ' + sum + ', not 0');
          }

          var skipped = expenses.filter(function (e) {
            if (e.groupId !== g.id) return false;
            var split = SW.Model.splitExpense(e.amountCents, e.splitMode, e.participants);
            return !split.ok;
          });
          if (skipped.length) {
            allOk = false;
            details.push(
              g.name + ': ' + skipped.length + ' record(s) counted in totals but ' +
              'skipped in balances (' + skipped.map(function (e) {
                return e.description;
              }).join(', ') + ')'
            );
          }
        } catch (e) {
          allOk = false;
          details.push(g.name + ': threw ' + e.message);
        }
      });
      checks.push({
        name: 'Balances sum to zero, and no record is skipped',
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
