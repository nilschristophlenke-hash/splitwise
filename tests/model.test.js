// tests/model.test.js
//
// Plain Node test script for SW.Model - no test framework, just a tiny
// hand-rolled assert helper. Run with:
//   node tests/model.test.js
// Prints PASS/FAIL per case, a final "X passed, Y failed" summary line,
// and exits with code 1 if anything failed (0 otherwise).

'use strict';

var Model = require('../js/model.js');

var passed = 0;
var failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log('PASS - ' + message);
  } else {
    failed += 1;
    console.log('FAIL - ' + message);
  }
}

function assertEqual(actual, expected, message) {
  var same = JSON.stringify(actual) === JSON.stringify(expected);
  var detail = same ? '' : ' (got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected) + ')';
  assert(same, message + detail);
}

function sum(arr) {
  return arr.reduce(function (a, b) { return a + b; }, 0);
}

// ===========================================================================
// parseAmount
// ===========================================================================

assertEqual(Model.parseAmount('12.50'), 1250, 'parseAmount("12.50") === 1250');
assertEqual(Model.parseAmount('12,50'), 1250, 'parseAmount("12,50") === 1250');
assertEqual(Model.parseAmount('€1.234,56'), 123456, 'parseAmount("€1.234,56") === 123456');
assertEqual(Model.parseAmount('0'), 0, 'parseAmount("0") === 0');
assertEqual(Model.parseAmount('abc'), null, 'parseAmount("abc") === null');
assertEqual(Model.parseAmount('-5.00'), null, 'parseAmount("-5.00") === null (negative rejected)');
assertEqual(Model.parseAmount('-3'), null, 'parseAmount("-3") === null (negative rejected)');

// ===========================================================================
// formatMoney / formatSigned
// ===========================================================================

assertEqual(Model.formatMoney(1250, 'EUR'), '€12.50', 'formatMoney(1250, "EUR") === "€12.50"');
assertEqual(Model.formatMoney(500, 'USD'), '$5.00', 'formatMoney(500, "USD") === "$5.00"');
assertEqual(Model.formatSigned(1250, 'EUR'), '+€12.50', 'formatSigned(1250, "EUR") === "+€12.50"');
assertEqual(Model.formatSigned(-1250, 'EUR'), '-€12.50', 'formatSigned(-1250, "EUR") === "-€12.50"');

// ===========================================================================
// splitExpense - equal, with an indivisible amount
// ===========================================================================

(function () {
  var result = Model.splitExpense(1000, 'equal', [
    { memberId: 'a' }, { memberId: 'b' }, { memberId: 'c' },
  ]);
  assert(result.ok, 'splitExpense equal returns ok:true');
  var cents = result.shares.map(function (s) { return s.shareCents; });
  assertEqual(cents, [334, 333, 333], 'splitExpense equal: €10.00 / 3 -> 334/333/333');
  assertEqual(sum(cents), 1000, 'splitExpense equal shares sum to the total amount');
})();

// ===========================================================================
// splitExpense - exact
// ===========================================================================

(function () {
  var result = Model.splitExpense(6000, 'exact', [
    { memberId: 'a', value: 2500 }, { memberId: 'b', value: 2000 }, { memberId: 'c', value: 1500 },
  ]);
  assert(result.ok, 'splitExpense exact returns ok:true when values sum correctly');
  assertEqual(sum(result.shares.map(function (s) { return s.shareCents; })), 6000, 'splitExpense exact shares sum to the total amount');

  var bad = Model.splitExpense(6000, 'exact', [
    { memberId: 'a', value: 2500 }, { memberId: 'b', value: 2000 },
  ]);
  assert(!bad.ok, 'splitExpense exact rejects values that do not sum to the total');
})();

// ===========================================================================
// splitExpense - percent
// ===========================================================================

(function () {
  var result = Model.splitExpense(9999, 'percent', [
    { memberId: 'a', value: 33.33 }, { memberId: 'b', value: 33.33 }, { memberId: 'c', value: 33.34 },
  ]);
  assert(result.ok, 'splitExpense percent returns ok:true when percentages sum to 100');
  assertEqual(sum(result.shares.map(function (s) { return s.shareCents; })), 9999, 'splitExpense percent shares sum to the total amount');
})();

// ===========================================================================
// splitExpense - shares
// ===========================================================================

(function () {
  var result = Model.splitExpense(1800, 'shares', [
    { memberId: 'a', value: 1 }, { memberId: 'b', value: 2 },
  ]);
  assert(result.ok, 'splitExpense shares returns ok:true');
  assertEqual(result.shares.map(function (s) { return s.shareCents; }), [600, 1200], 'splitExpense shares 1:2 of €18.00 -> 600/1200');
  assertEqual(sum(result.shares.map(function (s) { return s.shareCents; })), 1800, 'splitExpense shares shares sum to the total amount');
})();

// ===========================================================================
// computeBalances
// ===========================================================================

(function () {
  var groups = [{
    id: 'g1', name: 'Test', currency: 'EUR',
    members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    createdAt: 0,
  }];
  var expenses = [{
    id: 'e1', groupId: 'g1', type: 'expense', description: 'x', amountCents: 3000,
    paidBy: 'a', splitMode: 'equal',
    participants: [{ memberId: 'a', value: 1 }, { memberId: 'b', value: 1 }, { memberId: 'c', value: 1 }],
    category: 'general', date: '2026-01-01', createdAt: 0, note: '',
  }];

  var balances = Model.computeBalances('g1', groups, expenses);
  assertEqual(balances, { a: 2000, b: -1000, c: -1000 }, 'computeBalances: known 3-person scenario');
  assertEqual(sum(Object.keys(balances).map(function (k) { return balances[k]; })), 0, 'computeBalances: balances always sum to zero');

  var emptyBalances = Model.computeBalances('does-not-exist', groups, expenses);
  assertEqual(emptyBalances, {}, 'computeBalances: unknown groupId returns an empty object');
})();

// ===========================================================================
// simplifyDebts
// ===========================================================================

(function () {
  var balances = { a: 2000, b: -1000, c: -1000 };
  var transfers = Model.simplifyDebts(balances);

  assert(transfers.length <= 2, 'simplifyDebts: produces at most n-1 transfers for 3 members');
  transfers.forEach(function (t) {
    assert(t.amountCents > 0, 'simplifyDebts: every transfer amount is positive');
  });

  // A transfer settles like a real settlement expense would: the payer
  // (from) is credited (their negative balance moves toward zero) and the
  // receiver (to) is debited (their positive balance moves toward zero).
  var net = { a: 0, b: 0, c: 0 };
  transfers.forEach(function (t) {
    net[t.from] += t.amountCents;
    net[t.to] -= t.amountCents;
  });
  var settled = {
    a: balances.a + net.a,
    b: balances.b + net.b,
    c: balances.c + net.c,
  };
  assertEqual(settled, { a: 0, b: 0, c: 0 }, 'simplifyDebts: applying the transfers settles everyone to zero');

  assertEqual(Model.simplifyDebts({ a: 0, b: 0 }), [], 'simplifyDebts: all-zero balances need no transfers');
})();

// ===========================================================================
// validateExpense
// ===========================================================================

(function () {
  var group = {
    id: 'g1', name: 'Test', currency: 'EUR',
    members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    createdAt: 0,
  };

  var badPercent = Model.validateExpense({
    description: 'x', amountCents: 1000, paidBy: 'a', splitMode: 'percent',
    participants: [{ memberId: 'a', value: 60 }, { memberId: 'b', value: 60 }],
  }, group);
  assert(!badPercent.ok, 'validateExpense rejects a percent split that does not sum to 100');

  var badPayer = Model.validateExpense({
    description: 'x', amountCents: 1000, paidBy: 'zzz', splitMode: 'equal',
    participants: [{ memberId: 'a', value: 1 }, { memberId: 'b', value: 1 }],
  }, group);
  assert(!badPayer.ok, 'validateExpense rejects a payer who is not a member');

  var zeroAmount = Model.validateExpense({
    description: 'x', amountCents: 0, paidBy: 'a', splitMode: 'equal',
    participants: [{ memberId: 'a', value: 1 }],
  }, group);
  assert(!zeroAmount.ok, 'validateExpense rejects a zero amount');

  var good = Model.validateExpense({
    description: 'x', amountCents: 1000, paidBy: 'a', splitMode: 'equal',
    participants: [{ memberId: 'a', value: 1 }, { memberId: 'b', value: 1 }],
  }, group);
  assert(good.ok, 'validateExpense accepts a valid draft');
})();

// ===========================================================================
// Round trip: add expenses -> compute balances -> simplify -> apply
// settlements -> every balance is zero again.
// ===========================================================================

(function () {
  var groups = [{
    id: 'g1', name: 'Test', currency: 'EUR',
    members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }],
    createdAt: 0,
  }];

  var expenses = [
    {
      id: 'e1', groupId: 'g1', type: 'expense', description: 'dinner', amountCents: 4321,
      paidBy: 'a', splitMode: 'equal',
      participants: [{ memberId: 'a', value: 1 }, { memberId: 'b', value: 1 }, { memberId: 'c', value: 1 }],
      category: 'food', date: '2026-01-01', createdAt: 0, note: '',
    },
    {
      id: 'e2', groupId: 'g1', type: 'expense', description: 'taxi', amountCents: 1999,
      paidBy: 'b', splitMode: 'shares',
      participants: [{ memberId: 'a', value: 2 }, { memberId: 'b', value: 1 }, { memberId: 'c', value: 1 }],
      category: 'transport', date: '2026-01-02', createdAt: 0, note: '',
    },
  ];

  var balances = Model.computeBalances('g1', groups, expenses);
  var transfers = Model.simplifyDebts(balances);

  transfers.forEach(function (t, i) {
    expenses.push({
      id: 's' + i, groupId: 'g1', type: 'settlement', description: 'settle up', amountCents: t.amountCents,
      paidBy: t.from, splitMode: 'exact',
      participants: [{ memberId: t.to, value: t.amountCents }],
      category: 'general', date: '2026-01-03', createdAt: 0, note: '',
    });
  });

  var finalBalances = Model.computeBalances('g1', groups, expenses);
  assertEqual(finalBalances, { a: 0, b: 0, c: 0 }, 'round trip: recording the suggested settlements zeroes every balance');
})();

// ===========================================================================
// regression tests - each of these covers a bug that was actually found in
// this code and fixed. They exist so it cannot come back silently.
// ===========================================================================

(function regressionExactModeRounding() {
  // Was: exact mode rounded each participant's value on its own while the
  // validity check rounded the total, so 1.00 split as 33.5/33.5/33 was
  // accepted and then paid out 101 cents.
  var r = Model.splitExpense(100, 'exact', [
    { memberId: 'a', value: 33.5 },
    { memberId: 'b', value: 33.5 },
    { memberId: 'c', value: 33 },
  ]);
  var sum = r.ok ? r.shares.reduce(function (a, s) { return a + s.shareCents; }, 0) : -1;
  assert(r.ok && sum === 100, 'regression: fractional exact amounts still sum to the total (got ' + sum + ')');

  var r2 = Model.splitExpense(1000, 'exact', [
    { memberId: 'a', value: 333.4 },
    { memberId: 'b', value: 333.3 },
    { memberId: 'c', value: 333.3 },
  ]);
  var sum2 = r2.ok ? r2.shares.reduce(function (a, s) { return a + s.shareCents; }, 0) : -1;
  assert(r2.ok && sum2 === 1000, 'regression: fractional exact amounts round up to the total (got ' + sum2 + ')');
})();

(function regressionExactModeBalancesStayZero() {
  var groups = [{ id: 'g1', name: 'G', currency: 'EUR', members: [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' },
  ] }];
  var expenses = [{
    id: 'e1', groupId: 'g1', type: 'expense', description: 'x', amountCents: 100,
    paidBy: 'a', splitMode: 'exact',
    participants: [{ memberId: 'a', value: 33.5 }, { memberId: 'b', value: 33.5 }, { memberId: 'c', value: 33 }],
    category: 'general', date: '2026-01-01', createdAt: 0, note: '',
  }];
  var balances = Model.computeBalances('g1', groups, expenses);
  var total = Object.keys(balances).reduce(function (a, k) { return a + balances[k]; }, 0);
  assert(total === 0, 'regression: a fractional exact split leaves balances summing to zero (got ' + total + ')');
})();

(function regressionNonFiniteWeights() {
  // Infinity slipped past a `value > 0` test and produced NaN shares.
  var inf = Model.splitExpense(1000, 'shares', [
    { memberId: 'a', value: Infinity }, { memberId: 'b', value: 1 },
  ]);
  assert(!inf.ok, 'regression: Infinity is rejected as a share weight');

  var nan = Model.splitExpense(1000, 'percent', [
    { memberId: 'a', value: NaN }, { memberId: 'b', value: 50 },
  ]);
  assert(!nan.ok, 'regression: NaN is rejected as a percent weight');

  var group = { id: 'g1', members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
  var v = Model.validateExpense({
    description: 'x', amountCents: 1000, paidBy: 'a', splitMode: 'percent',
    participants: [{ memberId: 'a', value: NaN }, { memberId: 'b', value: 50 }],
  }, group);
  assert(!v.ok, 'regression: validateExpense also rejects a NaN percent (it used to slip through)');
})();

(function regressionNegativePercent() {
  var r = Model.splitExpense(1000, 'percent', [
    { memberId: 'a', value: 150.5 }, { memberId: 'b', value: -50.5 },
  ]);
  assert(!r.ok, 'regression: a negative percentage is rejected even though the total is 100');

  var e = Model.splitExpense(100, 'exact', [
    { memberId: 'a', value: 200 }, { memberId: 'b', value: -100 },
  ]);
  assert(!e.ok, 'regression: a negative exact amount is rejected even though the total matches');
})();

(function regressionDuplicateParticipants() {
  var group = { id: 'g1', members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] };
  var v = Model.validateExpense({
    description: 'x', amountCents: 900, paidBy: 'a', splitMode: 'equal',
    participants: [{ memberId: 'a', value: 1 }, { memberId: 'a', value: 1 }, { memberId: 'b', value: 1 }],
  }, group);
  assert(!v.ok, 'regression: the same member listed twice is rejected');
})();

(function regressionPercentTolerance() {
  // 33.33 x 3 is 99.98999999999998 in floating point, so a naive
  // "> 0.01" comparison rejected a sum that is exactly 0.01 away.
  var r = Model.splitExpense(1000, 'percent', [
    { memberId: 'a', value: 33.33 },
    { memberId: 'b', value: 33.33 },
    { memberId: 'c', value: 33.33 },
  ]);
  var sum = r.ok ? r.shares.reduce(function (a, s) { return a + s.shareCents; }, 0) : -1;
  assert(r.ok && sum === 1000, 'regression: 33.33/33.33/33.33 is accepted and still totals the full amount');
})();

(function regressionValidatorAgreesWithAllocator() {
  // The two used to encode the mode rules separately and drift apart.
  // Anything the validator accepts must be something the allocator can
  // actually split without losing a cent.
  var group = { id: 'g1', members: [
    { id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' },
  ] };
  var modes = ['equal', 'exact', 'percent', 'shares'];
  var disagreements = 0;
  for (var i = 0; i < 3000; i++) {
    var amount = 1 + Math.floor(Math.random() * 100000);
    var mode = modes[Math.floor(Math.random() * modes.length)];
    var ids = ['a', 'b', 'c'].slice(0, 1 + Math.floor(Math.random() * 3));
    var participants = ids.map(function (id) {
      var v = Math.random() < 0.15
        ? [0, -1, NaN, Infinity, 1.5][Math.floor(Math.random() * 5)]
        : Math.floor(Math.random() * 100);
      return { memberId: id, value: v };
    });
    var valid = Model.validateExpense({
      description: 'x', amountCents: amount, paidBy: 'a',
      splitMode: mode, participants: participants,
    }, group);
    if (!valid.ok) continue;
    var split = Model.splitExpense(amount, mode, participants);
    if (!split.ok) { disagreements += 1; continue; }
    var sum = split.shares.reduce(function (a, s) { return a + s.shareCents; }, 0);
    if (sum !== amount) disagreements += 1;
  }
  assert(disagreements === 0,
    'regression: over 3000 random drafts, everything the validator accepts splits exactly (' +
    disagreements + ' disagreements)');
})();

// ===========================================================================
// summary
// ===========================================================================

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
