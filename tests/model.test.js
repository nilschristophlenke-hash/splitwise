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
// summary
// ===========================================================================

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
