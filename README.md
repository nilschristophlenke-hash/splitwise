# Splitwise (clone)

A shared-expense tracker: create a group, log who paid for what, split it four
different ways, and get back the shortest list of payments that settles everyone up.

Plus an **admin console** that documents the app's own logic — every workflow, the data
model, the algorithms, and a live view of the current state.

**No dependencies, no build step, no backend.** Plain HTML, CSS and JavaScript. Open
`index.html` and it works; data lives in your browser's `localStorage`.

---

## Running it

```bash
git clone git@github.com:nilschristophlenke-hash/splitwise.git
cd splitwise
python3 -m http.server 8000
# open http://localhost:8000
```

A static server is recommended over opening the file directly so `sessionStorage` and
`localStorage` behave consistently.

Run the tests:

```bash
node tests/model.test.js          # splitting, balances, debt simplification

cd tests && npm install && node rls.test.js
```

The second one applies `supabase/schema.sql` to a real Postgres (compiled to
WebAssembly, so nothing has to be installed or running) and then attacks the
row-level security policies as three different users: a group owner, a friend
who joins with the invite code, and a stranger. It asserts the stranger can
neither read nor write anything, cannot join by guessing a group's UUID, and
cannot escalate to owner.

Those are dev dependencies only, and they live in `tests/` — the app itself
still ships with no dependencies and no build step.

## Admin console

`/admin.html` — access code **`123`**.

> This gate is a demo. The check runs in the browser, so it keeps a casual visitor out of
> the docs view and nothing more. There is no server and no real authentication here.

It renders six sections, all generated from `js/workflows.js` rather than hand-written HTML:

| Section | What it shows |
|---|---|
| Overview | Architecture summary, the layer stack, design principles |
| Workflows | Every user-facing workflow as a numbered step-by-step flow diagram, with invariants and failure modes |
| Data model | Entity field tables and how they relate |
| Algorithms | Cent allocation and debt simplification — problem, approach, complexity, pseudocode, worked example |
| State machine | App states and the transitions between them |
| Live state | Real counts and balances, the raw state as JSON, and integrity checks that run on demand |

## Features

- Groups with members and a per-group currency
- Expenses split **equally**, by **exact amounts**, by **percentage**, or by **shares**
- Live split preview and validation while you type
- Balances per member, and suggested settlements that minimise the number of payments
- Settle up — records the payment and updates every balance
- Edit and delete expenses, with undo
- Export / import the whole dataset as JSON
- Dark mode, responsive layout, keyboard shortcuts (`n` = new expense, `Esc` = close)

## How it is put together

```
index.html        the app shell
admin.html        the admin / documentation console
css/styles.css    app styling and design tokens
css/admin.css     admin console styling
js/model.js       pure logic: splitting, balances, debt simplification, formatting
js/store.js       state, actions, localStorage persistence, subscriptions
js/workflows.js   machine-readable description of the app's own logic
js/app.js         app UI and rendering
js/admin.js       admin console UI and rendering
tests/model.test.js  unit tests for the model layer (run with node)
```

Four layers, each only talking to the one below it:

```
  View (app.js / admin.js)
       |  dispatch(action)          subscribe(state)
       v
  Store (store.js)  ── persists ──>  localStorage
       |  calls pure functions
       v
  Model (model.js)
```

Two rules keep the arithmetic honest:

1. **Money is stored as integer cents**, never as a float. `12.30` is `1230`. Formatting to
   `€12.30` happens only at the moment of rendering.
2. **A split always sums back to the total.** Dividing €10.00 three ways gives
   334 + 333 + 333 cents. The leftover cents are handed out by the largest-remainder
   method, so no cent is ever invented or lost.

## Deployment

Pushes to `main` run the tests and publish the site to GitHub Pages via
`.github/workflows/pages.yml`.

## Licence

MIT
