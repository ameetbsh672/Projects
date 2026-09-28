const START_HOUR = 6;
const END_HOUR = 22; // inclusive, so 6:00 through 22:00

const scheduleList = document.getElementById('scheduleList');
const taskForm = document.getElementById('taskForm');
const taskInput = document.getElementById('taskInput');
const taskPriority = document.getElementById('taskPriority');
const taskList = document.getElementById('taskList');
const emptyTasks = document.getElementById('emptyTasks');
const datePicker = document.getElementById('datePicker');
const dateLabel = document.getElementById('dateLabel');
const prevDayBtn = document.getElementById('prevDay');
const nextDayBtn = document.getElementById('nextDay');
const todayBtn = document.getElementById('todayBtn');

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

let currentDate = todayISO();
let blocksByHour = {};
let saveTimers = {};

function todayISO() {
  const d = new Date();
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 10);
}

function formatHour(h) {
  const period = h >= 12 ? 'PM' : 'AM';
  let display = h % 12;
  if (display === 0) display = 12;
  return `${display} ${period}`;
}

function formatDateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

function buildScheduleSkeleton() {
  scheduleList.innerHTML = '';
  for (let h = START_HOUR; h <= END_HOUR; h++) {
    const row = document.createElement('div');
    row.className = 'hour-row';
    row.dataset.hour = h;

    const label = document.createElement('div');
    label.className = 'hour-label';
    label.textContent = formatHour(h);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'hour-input';
    input.placeholder = '';
    input.dataset.hour = h;
    input.maxLength = 200;

    input.addEventListener('input', () => scheduleSave(h, input.value));
    input.addEventListener('blur', () => saveBlock(h, input.value));

    row.appendChild(label);
    row.appendChild(input);
    scheduleList.appendChild(row);
  }
  markCurrentHour();
}

function markCurrentHour() {
  const isToday = currentDate === todayISO();
  const nowHour = new Date().getHours();
  document.querySelectorAll('.hour-row').forEach((row) => {
    const h = Number(row.dataset.hour);
    row.classList.toggle('is-current', isToday && h === nowHour);
  });
}

function scheduleSave(hour, text) {
  clearTimeout(saveTimers[hour]);
  saveTimers[hour] = setTimeout(() => saveBlock(hour, text), 700);
}

async function saveBlock(hour, text) {
  clearTimeout(saveTimers[hour]);
  try {
    await fetch('/api/blocks', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: currentDate, hour, text }),
    });
  } catch (err) {
    console.error('Failed to save block', err);
  }
}

function renderBlocks(blocks) {
  blocksByHour = {};
  blocks.forEach((b) => { blocksByHour[b.hour] = b.text; });
  document.querySelectorAll('.hour-input').forEach((input) => {
    const h = Number(input.dataset.hour);
    input.value = blocksByHour[h] || '';
  });
}

function renderTasks(tasks) {
  taskList.innerHTML = '';
  emptyTasks.hidden = tasks.length > 0;

  const sorted = [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done - b.done;
    if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) {
      return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    }
    return a.position - b.position;
  });

  sorted.forEach((task) => {
    const item = document.createElement('div');
    item.className = 'task-item' + (task.done ? ' done' : '');
    item.dataset.id = task.id;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'task-checkbox';
    checkbox.checked = !!task.done;
    checkbox.addEventListener('change', () => updateTask(task.id, { done: checkbox.checked }));

    const title = document.createElement('input');
    title.type = 'text';
    title.className = 'task-title';
    title.value = task.title;
    title.maxLength = 200;
    title.addEventListener('blur', () => {
      if (title.value.trim() && title.value.trim() !== task.title) {
        updateTask(task.id, { title: title.value.trim() });
      } else {
        title.value = task.title;
      }
    });
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') title.blur();
    });

    const badge = document.createElement('span');
    badge.className = `priority-badge ${task.priority}`;
    badge.textContent = task.priority;
    badge.title = 'Click to cycle priority';
    badge.style.cursor = 'pointer';
    badge.addEventListener('click', () => {
      const order = ['high', 'normal', 'low'];
      const next = order[(order.indexOf(task.priority) + 1) % order.length];
      updateTask(task.id, { priority: next });
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = '×';
    deleteBtn.setAttribute('aria-label', 'Delete task');
    deleteBtn.addEventListener('click', () => deleteTask(task.id));

    item.appendChild(checkbox);
    item.appendChild(title);
    item.appendChild(badge);
    item.appendChild(deleteBtn);
    taskList.appendChild(item);
  });
}

async function loadDay(date) {
  currentDate = date;
  datePicker.value = date;
  dateLabel.textContent = formatDateLabel(date);
  buildScheduleSkeleton();
  taskList.innerHTML = '';
  emptyTasks.hidden = true;

  try {
    const res = await fetch(`/api/day?date=${date}`);
    const data = await res.json();
    renderBlocks(data.blocks || []);
    renderTasks(data.tasks || []);
  } catch (err) {
    console.error('Failed to load day', err);
    emptyTasks.hidden = false;
    emptyTasks.textContent = 'Could not load data. Is the server running?';
  }
}

async function addTask(title, priority) {
  taskForm.querySelector('.add-btn').disabled = true;
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: currentDate, title, priority }),
    });
    if (res.ok) {
      await refreshTasks();
    }
  } catch (err) {
    console.error('Failed to add task', err);
  } finally {
    taskForm.querySelector('.add-btn').disabled = false;
  }
}

async function updateTask(id, changes) {
  try {
    await fetch(`/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes),
    });
    await refreshTasks();
  } catch (err) {
    console.error('Failed to update task', err);
  }
}

async function deleteTask(id) {
  try {
    await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
    await refreshTasks();
  } catch (err) {
    console.error('Failed to delete task', err);
  }
}

async function refreshTasks() {
  try {
    const res = await fetch(`/api/day?date=${currentDate}`);
    const data = await res.json();
    renderTasks(data.tasks || []);
  } catch (err) {
    console.error('Failed to refresh tasks', err);
  }
}

taskForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = taskInput.value.trim();
  if (!title) return;
  addTask(title, taskPriority.value);
  taskInput.value = '';
  taskInput.focus();
});

prevDayBtn.addEventListener('click', () => shiftDay(-1));
nextDayBtn.addEventListener('click', () => shiftDay(1));
todayBtn.addEventListener('click', () => loadDay(todayISO()));
datePicker.addEventListener('change', () => {
  if (datePicker.value) loadDay(datePicker.value);
});

function shiftDay(delta) {
  const [y, m, d] = currentDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  loadDay(iso);
}

setInterval(markCurrentHour, 60000);

loadDay(currentDate);
