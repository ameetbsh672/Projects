const state = {
  accounts: [],
  meta: { expenseCategories: [], incomeCategories: [], currentMonth: '' },
  editingTxId: null,
};

const fmt = (n) =>
  (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 2500);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

// ---------- Tabs ----------
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
    });
  });
}

// ---------- Loaders ----------
async function loadMeta() {
  state.meta = await api('/api/meta');
  document.getElementById('tx-date').value = new Date().toISOString().slice(0, 10);
}

async function loadAccounts() {
  state.accounts = await api('/api/accounts');
  renderAccountSelects();
  renderAccountsList();
}

function renderAccountSelects() {
  const accSelect = document.getElementById('tx-account');
  const transferSelect = document.getElementById('tx-transfer-account');
  const filterSelect = document.getElementById('tx-filter-account');
  const opts = state.accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');

  const prevAcc = accSelect.value;
  accSelect.innerHTML = opts;
  if (prevAcc) accSelect.value = prevAcc;

  const prevTransfer = transferSelect.value;
  transferSelect.innerHTML = opts;
  if (prevTransfer) transferSelect.value = prevTransfer;

  const prevFilter = filterSelect.value;
  filterSelect.innerHTML = '<option value="">All accounts</option>' + opts;
  filterSelect.value = prevFilter;
}

function renderAccountsList() {
  const el = document.getElementById('accounts-list');
  if (state.accounts.length === 0) {
    el.innerHTML = '<p class="empty-state">No accounts yet. Add one above.</p>';
    return;
  }
  el.innerHTML = state.accounts
    .map(
      (a) => `
      <div class="account-row">
        <div class="account-info">
          <span class="account-name">${escapeHtml(a.name)}</span>
          <span class="account-type">${escapeHtml(a.type)}</span>
        </div>
        <div class="account-row-actions">
          <span class="account-balance ${a.balance < 0 ? 'negative' : ''}">${fmt(a.balance)}</span>
          <button type="button" class="secondary" data-delete-account="${a.id}">Delete</button>
        </div>
      </div>`
    )
    .join('');

  el.querySelectorAll('[data-delete-account]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!armDelete(btn)) return;
      try {
        await api(`/api/accounts/${btn.dataset.deleteAccount}`, { method: 'DELETE' });
        showToast('Account deleted');
        await refreshAll();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

// Two-click delete instead of a blocking confirm() dialog.
function armDelete(btn) {
  if (btn.classList.contains('confirm')) return true;
  const label = btn.textContent;
  btn.classList.add('confirm');
  btn.textContent = 'Delete account + transactions?';
  setTimeout(() => {
    btn.classList.remove('confirm');
    btn.textContent = label;
  }, 3000);
  return false;
}

function populateCategorySelect(select, type) {
  const cats = type === 'income' ? state.meta.incomeCategories : state.meta.expenseCategories;
  select.innerHTML = cats.map((c) => `<option value="${c}">${c}</option>`).join('');
}

function updateTxFormForType() {
  const type = document.getElementById('tx-type').value;
  const transferWrap = document.getElementById('tx-transfer-account-wrap');
  const categoryWrap = document.getElementById('tx-category-wrap');
  if (type === 'transfer') {
    transferWrap.classList.remove('hidden');
    categoryWrap.classList.add('hidden');
  } else {
    transferWrap.classList.add('hidden');
    categoryWrap.classList.remove('hidden');
    populateCategorySelect(document.getElementById('tx-category'), type);
  }
}

async function loadBudgetCategorySelect() {
  const select = document.getElementById('budget-category');
  select.innerHTML = state.meta.expenseCategories.map((c) => `<option value="${c}">${c}</option>`).join('');
}

async function loadTransactions() {
  const all = await api('/api/transactions');
  renderTxList(document.getElementById('recent-transactions'), all.slice(0, 8));

  const filterVal = document.getElementById('tx-filter-account').value;
  const filtered = filterVal ? all.filter((t) => String(t.account_id) === filterVal) : all;
  renderTxList(document.getElementById('all-transactions'), filtered, true);
}

function renderTxList(container, txs, showAll = false) {
  if (txs.length === 0) {
    container.innerHTML = '<p class="empty-state">No transactions yet.</p>';
    return;
  }
  container.innerHTML = txs
    .map((t) => {
      const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '−' : '';
      const metaText =
        t.type === 'transfer'
          ? `${escapeHtml(t.account_name)} → ${escapeHtml(t.transfer_account_name || '?')}`
          : `${escapeHtml(t.account_name)} · ${escapeHtml(t.category)}`;
      return `
      <div class="tx-row">
        <span class="tx-date">${formatDate(t.date)}</span>
        <div class="tx-main">
          <span class="tx-desc">${escapeHtml(t.description) || (t.type === 'transfer' ? 'Transfer' : t.category)}</span>
          <span class="tx-meta">${metaText}</span>
        </div>
        <span class="tx-amount ${t.type}">${sign}${fmt(t.amount)}</span>
        ${showAll ? `<div class="tx-actions">
          <button type="button" data-edit-tx="${t.id}">Edit</button>
          <button type="button" data-delete-tx="${t.id}">Delete</button>
        </div>` : '<span></span>'}
        <span></span>
      </div>`;
    })
    .join('');

  container.querySelectorAll('[data-delete-tx]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/transactions/${btn.dataset.deleteTx}`, { method: 'DELETE' });
        showToast('Transaction deleted');
        await refreshAll();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
  container.querySelectorAll('[data-edit-tx]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const all = await api('/api/transactions');
      const tx = all.find((t) => t.id === Number(btn.dataset.editTx));
      if (tx) startEditTx(tx);
    });
  });
}

function startEditTx(tx) {
  state.editingTxId = tx.id;
  document.getElementById('tx-form-title').textContent = 'Edit transaction';
  document.getElementById('tx-submit-btn').textContent = 'Save changes';
  document.getElementById('tx-cancel-btn').classList.remove('hidden');
  document.getElementById('tx-type').value = tx.type;
  updateTxFormForType();
  document.getElementById('tx-date').value = tx.date;
  document.getElementById('tx-amount').value = tx.amount;
  document.getElementById('tx-account').value = tx.account_id;
  document.getElementById('tx-description').value = tx.description;
  if (tx.type === 'transfer') {
    document.getElementById('tx-transfer-account').value = tx.transfer_account_id;
  } else {
    document.getElementById('tx-category').value = tx.category;
  }
  document.querySelector('.tab-btn[data-view="transactions"]').click();
  document.getElementById('tx-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetTxForm() {
  state.editingTxId = null;
  document.getElementById('tx-form-title').textContent = 'Add transaction';
  document.getElementById('tx-submit-btn').textContent = 'Add transaction';
  document.getElementById('tx-cancel-btn').classList.add('hidden');
  document.getElementById('tx-form').reset();
  document.getElementById('tx-date').value = new Date().toISOString().slice(0, 10);
  updateTxFormForType();
}

async function loadBudgets() {
  const budgets = await api('/api/budgets');
  renderBudgetList(document.getElementById('budgets-list'), budgets, true);
  renderBudgetList(document.getElementById('dashboard-budgets'), budgets, false);
}

function renderBudgetList(container, budgets, showDelete) {
  if (budgets.length === 0) {
    container.innerHTML = '<p class="empty-state">No budgets set.</p>';
    return;
  }
  container.innerHTML = budgets
    .map((b) => {
      const pct = b.monthly_limit > 0 ? Math.min(100, (b.spent / b.monthly_limit) * 100) : 0;
      const overCls = b.spent > b.monthly_limit ? 'over' : pct > 80 ? 'warn' : '';
      return `
      <div class="budget-row">
        <div class="budget-row-top">
          <span class="name">${escapeHtml(b.category)}</span>
          <span class="figures">${fmt(b.spent)} / ${fmt(b.monthly_limit)}</span>
        </div>
        <div class="bar-track"><div class="bar-fill ${overCls}" style="width:${pct}%"></div></div>
        ${showDelete ? `<div class="budget-row-actions"><button type="button" class="secondary" data-delete-budget="${b.id}">Remove</button></div>` : ''}
      </div>`;
    })
    .join('');

  container.querySelectorAll('[data-delete-budget]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/budgets/${btn.dataset.deleteBudget}`, { method: 'DELETE' });
        showToast('Budget removed');
        await refreshAll();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  });
}

async function loadSummary() {
  const summary = await api('/api/summary');
  document.getElementById('stat-total-balance').textContent = fmt(summary.totalBalance);
  document.getElementById('stat-income').textContent = fmt(summary.monthIncome);
  document.getElementById('stat-expense').textContent = fmt(summary.monthExpense);
  document.getElementById('stat-net').textContent = fmt(summary.net);

  const container = document.getElementById('category-breakdown');
  if (summary.byCategory.length === 0) {
    container.innerHTML = '<p class="empty-state">No expenses yet this month.</p>';
  } else {
    const max = Math.max(...summary.byCategory.map((c) => c.total));
    container.innerHTML = summary.byCategory
      .map(
        (c) => `
        <div class="category-row">
          <div class="category-row-top">
            <span class="name">${escapeHtml(c.category)}</span>
            <span class="amount">${fmt(c.total)}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${(c.total / max) * 100}%"></div></div>
        </div>`
      )
      .join('');
  }
}

// ---------- Helpers ----------
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ---------- Form handlers ----------
function setupForms() {
  document.getElementById('tx-type').addEventListener('change', updateTxFormForType);

  document.getElementById('tx-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = document.getElementById('tx-type').value;
    const payload = {
      type,
      date: document.getElementById('tx-date').value,
      amount: Number(document.getElementById('tx-amount').value),
      account_id: Number(document.getElementById('tx-account').value),
      description: document.getElementById('tx-description').value,
    };
    if (type === 'transfer') {
      payload.transfer_account_id = Number(document.getElementById('tx-transfer-account').value);
      if (payload.transfer_account_id === payload.account_id) {
        showToast('Choose two different accounts for a transfer', true);
        return;
      }
    } else {
      payload.category = document.getElementById('tx-category').value;
    }

    try {
      if (state.editingTxId) {
        await api(`/api/transactions/${state.editingTxId}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Transaction updated');
      } else {
        await api('/api/transactions', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Transaction added');
      }
      resetTxForm();
      await refreshAll();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('tx-cancel-btn').addEventListener('click', resetTxForm);

  document.getElementById('tx-filter-account').addEventListener('change', loadTransactions);

  document.getElementById('account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      name: document.getElementById('account-name').value.trim(),
      type: document.getElementById('account-type').value,
      starting_balance: Number(document.getElementById('account-starting-balance').value) || 0,
    };
    if (!payload.name) return;
    try {
      await api('/api/accounts', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Account added');
      document.getElementById('account-form').reset();
      document.getElementById('account-starting-balance').value = 0;
      await refreshAll();
    } catch (err) {
      showToast(err.message, true);
    }
  });

  document.getElementById('budget-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      category: document.getElementById('budget-category').value,
      monthly_limit: Number(document.getElementById('budget-limit').value),
    };
    try {
      await api('/api/budgets', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Budget saved');
      document.getElementById('budget-form').reset();
      await refreshAll();
    } catch (err) {
      showToast(err.message, true);
    }
  });
}

async function refreshAll() {
  await loadAccounts();
  await loadTransactions();
  await loadBudgets();
  await loadSummary();
}

async function init() {
  setupTabs();
  setupForms();
  await loadMeta();
  updateTxFormForType();
  await loadBudgetCategorySelect();
  await refreshAll();
}

init().catch((err) => showToast(err.message, true));
