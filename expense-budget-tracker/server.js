const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const PORT = 4737;
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'data.db');

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'checking',
    starting_balance REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    transfer_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    date TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('income','expense','transfer')),
    category TEXT NOT NULL DEFAULT 'Uncategorized',
    amount REAL NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL UNIQUE,
    monthly_limit REAL NOT NULL
  );
`);

const seedAccounts = db.prepare('SELECT COUNT(*) AS c FROM accounts').get();
if (seedAccounts.c === 0) {
  const insertAccount = db.prepare(
    'INSERT INTO accounts (name, type, starting_balance) VALUES (?, ?, ?)'
  );
  insertAccount.run('Checking', 'checking', 1500);
  insertAccount.run('Savings', 'savings', 4000);
  insertAccount.run('Cash', 'cash', 100);
}

const EXPENSE_CATEGORIES = [
  'Groceries', 'Rent/Mortgage', 'Utilities', 'Transportation', 'Dining Out',
  'Entertainment', 'Healthcare', 'Shopping', 'Insurance', 'Subscriptions',
  'Travel', 'Education', 'Other'
];
const INCOME_CATEGORIES = ['Salary', 'Freelance', 'Interest', 'Gift', 'Other Income'];

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function accountBalance(accountId) {
  const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!acct) return null;
  let balance = acct.starting_balance;

  const income = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE account_id = ? AND type = 'income'")
    .get(accountId).s;
  const expense = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE account_id = ? AND type = 'expense'")
    .get(accountId).s;
  const transferOut = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE account_id = ? AND type = 'transfer'")
    .get(accountId).s;
  const transferIn = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE transfer_account_id = ? AND type = 'transfer'")
    .get(accountId).s;

  balance += income - expense - transferOut + transferIn;
  return balance;
}

function accountsWithBalances() {
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY id').all();
  return accounts.map((a) => ({ ...a, balance: accountBalance(a.id) }));
}

function listTransactions(query) {
  let sql = `SELECT t.*, a.name AS account_name, ta.name AS transfer_account_name
             FROM transactions t
             JOIN accounts a ON a.id = t.account_id
             LEFT JOIN accounts ta ON ta.id = t.transfer_account_id
             WHERE 1=1`;
  const params = [];
  if (query.account_id) {
    sql += ' AND t.account_id = ?';
    params.push(Number(query.account_id));
  }
  if (query.month) {
    sql += " AND strftime('%Y-%m', t.date) = ?";
    params.push(query.month);
  }
  sql += ' ORDER BY t.date DESC, t.id DESC';
  return db.prepare(sql).all(...params);
}

function budgetProgress(month) {
  const budgets = db.prepare('SELECT * FROM budgets ORDER BY category').all();
  const spentRows = db
    .prepare(
      "SELECT category, COALESCE(SUM(amount),0) AS spent FROM transactions WHERE type = 'expense' AND strftime('%Y-%m', date) = ? GROUP BY category"
    )
    .all(month);
  const spentMap = Object.fromEntries(spentRows.map((r) => [r.category, r.spent]));
  return budgets.map((b) => ({
    ...b,
    spent: spentMap[b.category] || 0,
    remaining: b.monthly_limit - (spentMap[b.category] || 0),
  }));
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
};

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(ROOT, path.normalize(filePath).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] !== 'api') {
    return serveStatic(req, res);
  }

  try {
    // /api/meta
    if (parts[1] === 'meta' && req.method === 'GET') {
      return sendJson(res, 200, {
        expenseCategories: EXPENSE_CATEGORIES,
        incomeCategories: INCOME_CATEGORIES,
        currentMonth: currentMonth(),
      });
    }

    // /api/accounts
    if (parts[1] === 'accounts' && !parts[2] && req.method === 'GET') {
      return sendJson(res, 200, accountsWithBalances());
    }
    if (parts[1] === 'accounts' && !parts[2] && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.name) return sendJson(res, 400, { error: 'name is required' });
      const result = db
        .prepare('INSERT INTO accounts (name, type, starting_balance) VALUES (?, ?, ?)')
        .run(body.name, body.type || 'checking', Number(body.starting_balance) || 0);
      const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(result.lastInsertRowid));
      return sendJson(res, 201, { ...acct, balance: accountBalance(acct.id) });
    }
    if (parts[1] === 'accounts' && parts[2] && req.method === 'PUT') {
      const id = Number(parts[2]);
      const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
      if (!existing) return sendJson(res, 404, { error: 'account not found' });
      const body = await readBody(req);
      db.prepare('UPDATE accounts SET name = ?, type = ?, starting_balance = ? WHERE id = ?').run(
        body.name ?? existing.name,
        body.type ?? existing.type,
        body.starting_balance !== undefined ? Number(body.starting_balance) : existing.starting_balance,
        id
      );
      const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
      return sendJson(res, 200, { ...acct, balance: accountBalance(id) });
    }
    if (parts[1] === 'accounts' && parts[2] && req.method === 'DELETE') {
      const id = Number(parts[2]);
      const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
      if (!existing) return sendJson(res, 404, { error: 'account not found' });
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true });
    }

    // /api/transactions
    if (parts[1] === 'transactions' && !parts[2] && req.method === 'GET') {
      const query = Object.fromEntries(url.searchParams.entries());
      return sendJson(res, 200, listTransactions(query));
    }
    if (parts[1] === 'transactions' && !parts[2] && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.account_id || !body.date || !body.type || body.amount === undefined) {
        return sendJson(res, 400, { error: 'account_id, date, type, amount are required' });
      }
      if (!['income', 'expense', 'transfer'].includes(body.type)) {
        return sendJson(res, 400, { error: 'invalid type' });
      }
      if (body.type === 'transfer' && !body.transfer_account_id) {
        return sendJson(res, 400, { error: 'transfer_account_id is required for transfers' });
      }
      const result = db
        .prepare(
          `INSERT INTO transactions (account_id, transfer_account_id, date, type, category, amount, description)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          Number(body.account_id),
          body.type === 'transfer' ? Number(body.transfer_account_id) : null,
          body.date,
          body.type,
          body.category || (body.type === 'transfer' ? 'Transfer' : 'Uncategorized'),
          Math.abs(Number(body.amount)),
          body.description || ''
        );
      const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(result.lastInsertRowid));
      return sendJson(res, 201, tx);
    }
    if (parts[1] === 'transactions' && parts[2] && req.method === 'PUT') {
      const id = Number(parts[2]);
      const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
      if (!existing) return sendJson(res, 404, { error: 'transaction not found' });
      const body = await readBody(req);
      db.prepare(
        `UPDATE transactions SET account_id = ?, transfer_account_id = ?, date = ?, type = ?, category = ?, amount = ?, description = ?
         WHERE id = ?`
      ).run(
        body.account_id !== undefined ? Number(body.account_id) : existing.account_id,
        body.type === 'transfer' ? Number(body.transfer_account_id) : (body.transfer_account_id ?? existing.transfer_account_id),
        body.date ?? existing.date,
        body.type ?? existing.type,
        body.category ?? existing.category,
        body.amount !== undefined ? Math.abs(Number(body.amount)) : existing.amount,
        body.description ?? existing.description,
        id
      );
      const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
      return sendJson(res, 200, tx);
    }
    if (parts[1] === 'transactions' && parts[2] && req.method === 'DELETE') {
      const id = Number(parts[2]);
      const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
      if (!existing) return sendJson(res, 404, { error: 'transaction not found' });
      db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true });
    }

    // /api/budgets
    if (parts[1] === 'budgets' && !parts[2] && req.method === 'GET') {
      const month = url.searchParams.get('month') || currentMonth();
      return sendJson(res, 200, budgetProgress(month));
    }
    if (parts[1] === 'budgets' && !parts[2] && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.category || body.monthly_limit === undefined) {
        return sendJson(res, 400, { error: 'category and monthly_limit are required' });
      }
      db.prepare(
        `INSERT INTO budgets (category, monthly_limit) VALUES (?, ?)
         ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit`
      ).run(body.category, Number(body.monthly_limit));
      const budget = db.prepare('SELECT * FROM budgets WHERE category = ?').get(body.category);
      return sendJson(res, 201, budget);
    }
    if (parts[1] === 'budgets' && parts[2] && req.method === 'DELETE') {
      const id = Number(parts[2]);
      const existing = db.prepare('SELECT * FROM budgets WHERE id = ?').get(id);
      if (!existing) return sendJson(res, 404, { error: 'budget not found' });
      db.prepare('DELETE FROM budgets WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true });
    }

    // /api/summary
    if (parts[1] === 'summary' && req.method === 'GET') {
      const month = url.searchParams.get('month') || currentMonth();
      const accounts = accountsWithBalances();
      const totalBalance = accounts.reduce((sum, a) => sum + a.balance, 0);
      const monthIncome = db
        .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type = 'income' AND strftime('%Y-%m', date) = ?")
        .get(month).s;
      const monthExpense = db
        .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type = 'expense' AND strftime('%Y-%m', date) = ?")
        .get(month).s;
      const byCategory = db
        .prepare(
          "SELECT category, COALESCE(SUM(amount),0) AS total FROM transactions WHERE type = 'expense' AND strftime('%Y-%m', date) = ? GROUP BY category ORDER BY total DESC"
        )
        .all(month);
      return sendJson(res, 200, {
        totalBalance,
        monthIncome,
        monthExpense,
        net: monthIncome - monthExpense,
        byCategory,
        budgets: budgetProgress(month),
        month,
      });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: 'internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Expense/Budget/Accounts tracker running at http://localhost:${PORT}`);
});
