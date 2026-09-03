// js/model.js
//
// SW.Model - pure, dependency-free functions for money and math.
//
// Nothing in this file touches the DOM, localStorage, or the network, and
// nothing in it depends on the order functions are called in. Every
// function here takes plain data in and returns plain data out, which is
// what lets tests/model.test.js exercise all of it directly in Node.
//
// Money rule: cents are always integers. We never store or compare money
// as a float. Floats only ever show up transiently as *weights* (percent
// values, share counts) on the way into splitExpense().

var SW = SW || {};

SW.Model = (function () {
  'use strict';

  // -----------------------------------------------------------------------
  // uid - short random id, e.g. uid('g') -> "g_4f8k2p1a"
  // -----------------------------------------------------------------------

  function uid(prefix) {
    var chars = '';
    for (var i = 0; i < 8; i++) {
      chars += Math.floor(Math.random() * 36).toString(36);
    }
    return prefix + '_' + chars;
  }

  // -----------------------------------------------------------------------
  // parseAmount - turn user-typed text into integer cents, or null.
  //
  // Accepts plain numbers ("12.5"), German/European style ("12,50",
  // "1.234,56"), a leading currency symbol ("€12.50"), and thousands
  // separators. Rejects garbage ("abc") and negative amounts (a user
  // typing a negative amount is treated as an error, not a valid entry -
  // negatives never make sense as an expense amount).
  // -----------------------------------------------------------------------

  function parseAmount(str) {
    if (typeof str !== 'string') return null;
    var s = str.trim();
    if (!s) return null;

    // Strip known currency symbols/codes so "€12.50" or "CHF 12.50" parse.
    s = s.replace(/€|\$|£|¥/g, '').replace(/\bCHF\b/gi, '').trim();
    if (!s) return null;

    // After stripping symbols, only digits, '.', ',', internal whitespace
    // and an optional leading '-' are allowed. Anything else (letters,
    // stray punctuation) means the input isn't a number at all.
    if (!/^-?[0-9.,\s]+$/.test(s)) return null;
    s = s.replace(/\s/g, '');

    var hasComma = s.indexOf(',') !== -1;
    var hasDot = s.indexOf('.') !== -1;
    var normalized;

    if (hasComma && hasDot) {
      // Whichever separator appears LAST is the decimal point; the other
      // one is a thousands grouping separator and gets removed.
      var lastComma = s.lastIndexOf(',');
      var lastDot = s.lastIndexOf('.');
      if (lastComma > lastDot) {
        // European style: "1.234,56" -> dot groups thousands, comma decimal.
        normalized = s.replace(/\./g, '').replace(',', '.');
      } else {
        // US style: "1,234.56" -> comma groups thousands, dot decimal.
        normalized = s.replace(/,/g, '');
      }
    } else if (hasComma) {
      // Only a comma: treat it as a decimal point when it looks like one
      // (exactly one comma, 1-2 digits after it), otherwise as a
      // thousands separator to be dropped.
      var parts = s.split(',');
      normalized = (parts.length === 2 && parts[1].length <= 2)
        ? parts[0] + '.' + parts[1]
        : s.replace(/,/g, '');
    } else {
      // Only a dot, or no separator at all - already in a parseable shape.
      normalized = s;
    }

    if (normalized === '' || normalized === '-') return null;
    var value = Number(normalized);
    if (!isFinite(value)) return null;
    if (value < 0) return null;

    return Math.round(value * 100);
  }

  // -----------------------------------------------------------------------
  // formatMoney / formatSigned
  // -----------------------------------------------------------------------

  var CURRENCY_SYMBOLS = { EUR: '€', USD: '$', GBP: '£', CHF: 'CHF ' };

  function formatMoney(cents, currency) {
    var negative = cents < 0;
    var absCents = Math.abs(cents);
    var amountStr = (absCents / 100).toFixed(2);
    var symbol = CURRENCY_SYMBOLS[currency];
    var body = symbol !== undefined ? symbol + amountStr : (currency || '?') + ' ' + amountStr;
    return (negative ? '-' : '') + body;
  }

  function formatSigned(cents, currency) {
    var sign = cents < 0 ? '-' : '+';
    return sign + formatMoney(Math.abs(cents), currency);
  }

  // -----------------------------------------------------------------------
  // splitExpense - the largest-remainder method.
  //
  // Every split mode reduces to "give each participant a non-negative
  // weight, then divide amountCents proportionally to those weights,
  // rounding so the cents add back up to exactly amountCents." Exact mode
  // is the one exception: the caller already supplied the per-person cent
  // amounts, so there's nothing to allocate - we just validate they sum
  // correctly and pass them through.
  // -----------------------------------------------------------------------

  function splitExpense(amountCents, splitMode, participants) {
    if (!Number.isInteger(amountCents) || amountCents < 0) {
      return { ok: false, error: 'amountCents must be a non-negative integer.' };
    }
    if (!Array.isArray(participants) || participants.length === 0) {
      return { ok: false, error: 'At least one participant is required.' };
    }

    if (splitMode === 'exact') {
      var exactSum = 0;
      for (var i = 0; i < participants.length; i++) exactSum += participants[i].value;
      if (Math.round(exactSum) !== amountCents) {
        return { ok: false, error: 'Exact amounts must sum to the total amount.' };
      }
      return {
        ok: true,
        shares: participants.map(function (p) {
          return { memberId: p.memberId, shareCents: Math.round(p.value) };
        }),
      };
    }

    var weights;
    if (splitMode === 'equal') {
      weights = participants.map(function () { return 1; });
    } else if (splitMode === 'shares') {
      weights = participants.map(function (p) { return p.value; });
      if (weights.some(function (w) { return !(w > 0); })) {
        return { ok: false, error: 'Shares must be positive numbers.' };
      }
    } else if (splitMode === 'percent') {
      weights = participants.map(function (p) { return p.value; });
      var percentSum = weights.reduce(function (a, b) { return a + b; }, 0);
      if (Math.abs(percentSum - 100) > 0.01) {
        return { ok: false, error: 'Percentages must sum to 100.' };
      }
    } else {
      return { ok: false, error: 'Unknown splitMode: ' + splitMode };
    }

    var totalWeight = weights.reduce(function (a, b) { return a + b; }, 0);
    if (!(totalWeight > 0)) {
      return { ok: false, error: 'Total weight must be positive.' };
    }

    // 1) Exact (fractional) share of each participant, and its floor.
    var raw = weights.map(function (w) { return (amountCents * w) / totalWeight; });
    var floors = raw.map(Math.floor);
    var allocated = floors.reduce(function (a, b) { return a + b; }, 0);
    var remainder = amountCents - allocated;

    // 2) Hand out the leftover cents to whoever lost the most to
    //    flooring, largest fractional remainder first; ties go to
    //    whichever participant appears earlier in the input array.
    var order = raw.map(function (r, i) { return { i: i, frac: r - floors[i] }; });
    order.sort(function (a, b) {
      if (b.frac !== a.frac) return b.frac - a.frac;
      return a.i - b.i;
    });

    var shareCents = floors.slice();
    for (var k = 0; k < remainder; k++) {
      shareCents[order[k].i] += 1;
    }

    return {
      ok: true,
      shares: participants.map(function (p, idx) {
        return { memberId: p.memberId, shareCents: shareCents[idx] };
      }),
    };
  }

  // -----------------------------------------------------------------------
  // validateExpense
  // -----------------------------------------------------------------------

  function validateExpense(draft, group) {
    var errors = [];

    if (!draft || typeof draft !== 'object') {
      return { ok: false, errors: ['An expense draft is required.'] };
    }
    if (!group || typeof group !== 'object' || !Array.isArray(group.members)) {
      return { ok: false, errors: ['A group is required to validate against.'] };
    }

    var memberIds = group.members.map(function (m) { return m.id; });

    if (!draft.description || !String(draft.description).trim()) {
      errors.push('Description is required.');
    }
    if (!Number.isInteger(draft.amountCents) || draft.amountCents <= 0) {
      errors.push('Amount must be a positive whole number of cents.');
    }
    if (memberIds.indexOf(draft.paidBy) === -1) {
      errors.push('Payer must be a member of the group.');
    }

    var participants = Array.isArray(draft.participants) ? draft.participants : [];
    if (participants.length === 0) {
      errors.push('At least one participant is required.');
    }
    var everyoneIsAMember = participants.every(function (p) {
      return memberIds.indexOf(p.memberId) !== -1;
    });
    if (participants.length > 0 && !everyoneIsAMember) {
      errors.push('All participants must be members of the group.');
    }

    if (participants.length > 0 && everyoneIsAMember) {
      if (draft.splitMode === 'exact') {
        var sum = participants.reduce(function (a, p) { return a + p.value; }, 0);
        if (Math.round(sum) !== draft.amountCents) {
          errors.push('Exact amounts must add up to the total amount.');
        }
      } else if (draft.splitMode === 'percent') {
        var pctSum = participants.reduce(function (a, p) { return a + p.value; }, 0);
        if (Math.abs(pctSum - 100) > 0.01) {
          errors.push('Percentages must add up to 100.');
        }
      } else if (draft.splitMode === 'shares') {
        var allPositive = participants.every(function (p) { return p.value > 0; });
        if (!allPositive) {
          errors.push('Shares must be positive numbers.');
        }
      } else if (draft.splitMode !== 'equal') {
        errors.push('Unknown split mode: ' + draft.splitMode);
      }
    }

    return { ok: errors.length === 0, errors: errors };
  }

  // -----------------------------------------------------------------------
  // computeBalances
  // -----------------------------------------------------------------------

  function computeBalances(groupId, groups, expenses) {
    var group = (groups || []).find(function (g) { return g.id === groupId; });
    var balances = {};
    if (!group) return balances;

    group.members.forEach(function (m) { balances[m.id] = 0; });

    var groupExpenses = (expenses || []).filter(function (e) { return e.groupId === groupId; });

    groupExpenses.forEach(function (e) {
      var result = splitExpense(e.amountCents, e.splitMode, e.participants);
      // A malformed expense (shouldn't happen for anything that went
      // through validateExpense) is skipped entirely rather than only
      // half-applied, so credits and debits never drift out of balance.
      if (!result.ok) return;

      if (!(e.paidBy in balances)) balances[e.paidBy] = 0;
      balances[e.paidBy] += e.amountCents;

      result.shares.forEach(function (s) {
        if (!(s.memberId in balances)) balances[s.memberId] = 0;
        balances[s.memberId] -= s.shareCents;
      });
    });

    return balances;
  }

  // -----------------------------------------------------------------------
  // simplifyDebts - greedy minimum cash-flow.
  // -----------------------------------------------------------------------

  function simplifyDebts(balances) {
    var people = Object.keys(balances || {})
      .map(function (id) { return { id: id, amount: balances[id] }; })
      .filter(function (p) { return p.amount !== 0; });

    var transfers = [];

    while (people.length > 0) {
      // Deterministic order: largest balance first, ties by memberId.
      people.sort(function (a, b) {
        if (b.amount !== a.amount) return b.amount - a.amount;
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      });

      var creditor = people[0];
      var debtor = people[people.length - 1];
      if (!(creditor.amount > 0) || !(debtor.amount < 0)) break;

      var amount = Math.min(creditor.amount, -debtor.amount);
      if (!(amount > 0)) break;

      transfers.push({ from: debtor.id, to: creditor.id, amountCents: amount });
      creditor.amount -= amount;
      debtor.amount += amount;

      people = people.filter(function (p) { return p.amount !== 0; });
    }

    return transfers;
  }

  // -----------------------------------------------------------------------
  // memberBalanceSummary
  // -----------------------------------------------------------------------

  function memberBalanceSummary(memberId, groupId, groups, expenses) {
    var balances = computeBalances(groupId, groups, expenses);
    var net = balances[memberId] || 0;
    var transfers = simplifyDebts(balances);

    var owes = transfers
      .filter(function (t) { return t.from === memberId; })
      .map(function (t) { return { to: t.to, amountCents: t.amountCents }; });

    var owed = transfers
      .filter(function (t) { return t.to === memberId; })
      .map(function (t) { return { from: t.from, amountCents: t.amountCents }; });

    return { net: net, owes: owes, owed: owed };
  }

  // -----------------------------------------------------------------------
  // groupTotals
  // -----------------------------------------------------------------------

  function groupTotals(groupId, groups, expenses) {
    var group = (groups || []).find(function (g) { return g.id === groupId; });
    var perMemberPaid = {};
    if (group) {
      group.members.forEach(function (m) { perMemberPaid[m.id] = 0; });
    }

    var totalSpentCents = 0;
    var expenseCount = 0;
    var settlementCount = 0;

    (expenses || [])
      .filter(function (e) { return e.groupId === groupId; })
      .forEach(function (e) {
        if (e.type === 'settlement') {
          settlementCount += 1;
          return;
        }
        expenseCount += 1;
        totalSpentCents += e.amountCents;
        if (!(e.paidBy in perMemberPaid)) perMemberPaid[e.paidBy] = 0;
        perMemberPaid[e.paidBy] += e.amountCents;
      });

    return {
      totalSpentCents: totalSpentCents,
      expenseCount: expenseCount,
      settlementCount: settlementCount,
      perMemberPaid: perMemberPaid,
    };
  }

  // -----------------------------------------------------------------------

  return {
    uid: uid,
    parseAmount: parseAmount,
    formatMoney: formatMoney,
    formatSigned: formatSigned,
    splitExpense: splitExpense,
    validateExpense: validateExpense,
    computeBalances: computeBalances,
    simplifyDebts: simplifyDebts,
    memberBalanceSummary: memberBalanceSummary,
    groupTotals: groupTotals,
  };
})();

// Node/CommonJS footer - lets tests/model.test.js (and any other Node
// tooling) `require('../js/model.js')` and get SW.Model directly. This
// branch never runs in the browser, since `module` is undefined there.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SW.Model;
}
