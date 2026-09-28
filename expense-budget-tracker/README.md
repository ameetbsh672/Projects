# Ledger — Expenses, Budgets & Accounts

A local expense tracker: manage multiple accounts, log income/expense/transfer transactions, and set monthly category budgets with progress bars. All data is stored in a SQLite file (`data.db`) in this folder.

## Run it

```
node server.js
```

Then open http://localhost:4737 in your browser.

## Notes

- Starts you off with three sample accounts (Checking, Savings, Cash) — delete or edit them as you like.
- Expense/income category lists are defined in `server.js` near the top (`EXPENSE_CATEGORIES` / `INCOME_CATEGORIES`) if you want to add or rename categories.
- Account balances are computed from each account's starting balance plus its transaction history — nothing is stored as a running total, so edits/deletes always stay consistent.
- Your data lives entirely in `data.db` — copy it to back up, or open it with any SQLite browser to inspect/query directly.
