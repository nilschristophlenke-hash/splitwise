// Does the offline queue actually do what it claims: keep work on a dead
// network, retry it when the network returns, and NOT retry something the
// server refused on its merits.
const vm = require('vm');
const fs = require('fs');
const ROOT = require('path').join(__dirname, '..') + '/';

let pass = 0, fail = 0;
function ck(n, ok, x) {
  if (ok) { pass++; console.log('PASS  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (x === undefined ? '' : '  -> ' + JSON.stringify(x).slice(0, 200))); }
}

function build(rpcBehaviour) {
  const listeners = [];
  const ctx = {
    console, JSON, Math, Date, Number, Array, Object, String, Boolean, Promise, Error,
    isFinite, isNaN, parseFloat, parseInt, setTimeout, clearTimeout, structuredClone,
  };
  ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
  ctx.navigator = { onLine: true };
  ctx.localStorage = {
    _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; },
  };
  ctx.window.addEventListener = function (evt, fn) { listeners.push({ evt, fn }); };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(ROOT + 'js/model.js', 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(ROOT + 'js/store.js', 'utf8'), ctx);

  // Minimal stubs for what remote-store leans on.
  const calls = [];
  ctx.SW.Config = { isConfigured: () => true };
  ctx.SW.Auth = {
    client: () => ctx.__client,
    getUser: () => ({ id: 'u_me', email: 'me@example.com', name: 'Me' }),
    isSignedIn: () => true,
    onChange: () => () => {},
  };
  ctx.__client = {
    rpc(name, args) { calls.push({ name, args }); return rpcBehaviour(name, args, calls.length); },
    from() {
      const chain = {
        select() { return chain; }, insert() { return chain; }, update() { return chain; },
        delete() { return chain; }, eq() { return chain; }, in() { return chain; },
        single() { return Promise.resolve({ data: null, error: null }); },
        then(res) { return Promise.resolve({ data: [], error: null }).then(res); },
      };
      return chain;
    },
    channel() { return { on() { return this; }, subscribe() { return this; }, unsubscribe() {} }; },
    removeChannel() {},
  };
  vm.runInContext(fs.readFileSync(ROOT + 'js/remote-store.js', 'utf8'), ctx);
  return { ctx, calls, listeners };
}

const netErr = () => Promise.reject(new Error('Failed to fetch'));
const serverErr = () => Promise.resolve({ error: { code: 'P0001', message: 'The payer is not a member of this group.' } });
const okRow = () => Promise.resolve({ data: [{ id: 'e_server', created_at: '2026-09-08T10:00:00Z', updated_at: '2026-09-08T10:00:00Z' }], error: null });

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---- 1+2. drive the REAL store: a dead network must queue, a server
  //          refusal must not. No mirrored logic - the module decides.
  {
    let mode = 'ok';
    const behaviour = (name) => {
      if (name === 'create_group') {
        return Promise.resolve({ data: [{ id: 'g1', name: 'Trip', currency: 'EUR',
          invite_code: 'ABCDEFGHIJ', created_by: 'u_me', created_at: '2026-09-08T09:00:00Z' }], error: null });
      }
      if (name === 'create_expense') {
        if (mode === 'net') return netErr();
        if (mode === 'server') return serverErr();
        return okRow();
      }
      return Promise.resolve({ data: [], error: null });
    };
    const { ctx } = build(behaviour);
    const RS = ctx.SW.RemoteStore;
    const statuses = [];
    RS.onSyncStatus(s => statuses.push(s));

    ck('remote store exposes the queue API',
      typeof RS.pendingCount === 'function' && typeof RS.flushQueue === 'function');
    ck('queue starts empty', RS.pendingCount() === 0);

    const made = RS.dispatch({ type: 'ADD_GROUP', payload: { name: 'Trip', currency: 'EUR' } });
    await wait(60);
    ck('a group can be created in the harness', made && made.ok, made);
    const gid = RS.getState().groups[0] && RS.getState().groups[0].id;

    function addExpense(desc) {
      return RS.dispatch({ type: 'ADD_EXPENSE', payload: {
        groupId: gid, description: desc, amountCents: 1000, paidBy: 'u_me',
        splitMode: 'equal', participants: [{ memberId: 'u_me', value: 1 }],
        category: 'general', date: '2026-09-08', note: '' } });
    }

    // --- dead network ---
    mode = 'net';
    const r1 = addExpense('Offline dinner');
    await wait(80);
    ck('the expense is accepted locally while offline', r1 && r1.ok, r1);
    ck('a dead network parks the write in the queue', RS.pendingCount() === 1, RS.pendingCount());
    ck('the expense STAYS on screen instead of being discarded',
      RS.getState().expenses.some(e => e.description === 'Offline dinner'),
      RS.getState().expenses.map(e => e.description));
    ck('the user is told it is queued, not that it saved',
      statuses.some(s => s.state === 'queued'), statuses.map(s => s.state));

    // --- network returns ---
    mode = 'ok';
    RS.flushQueue();
    await wait(120);
    ck('reconnecting drains the queue', RS.pendingCount() === 0, RS.pendingCount());
    ck('the queued expense now carries the server id',
      RS.getState().expenses.some(e => e.id === 'e_server'),
      RS.getState().expenses.map(e => e.id));

    // --- server refuses on the merits ---
    mode = 'server';
    const r2 = addExpense('Rejected by server');
    await wait(120);
    ck('a server refusal is NOT queued for retry', RS.pendingCount() === 0, RS.pendingCount());
    ck('a server refusal rolls the expense back off screen',
      !RS.getState().expenses.some(e => e.description === 'Rejected by server'),
      RS.getState().expenses.map(e => e.description));
    ck('a server refusal surfaces as an error, not a queue',
      statuses.some(s => s.state === 'error'), statuses.slice(-3));
  }

  // ---- 3. going offline then online triggers a flush ----
  {
    const { ctx, listeners } = build(() => okRow());
    const online = listeners.find(l => l.evt === 'online');
    ck('the store listens for the browser coming back online', !!online);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e.message); process.exit(2); });
