const COLUMNS = [
  { status: 'backlog', label: 'Backlog' },
  { status: 'downloading', label: 'Downloading' },
  { status: 'playing', label: 'Playing' },
  { status: 'completed', label: 'Completed' },
  { status: 'dropped', label: 'Dropped' },
];

const board = document.getElementById('board');
const addForm = document.getElementById('add-form');
const titleInput = document.getElementById('title-input');
const platformInput = document.getElementById('platform-input');

const overlay = document.getElementById('detail-overlay');
const detailTitle = document.getElementById('detail-title');
const detailPlatform = document.getElementById('detail-platform');
const detailStatus = document.getElementById('detail-status');
const detailNotes = document.getElementById('detail-notes');
const detailSave = document.getElementById('detail-save');
const detailDelete = document.getElementById('detail-delete');
const detailClose = document.getElementById('detail-close');

const toast = document.getElementById('toast');

let games = [];
let activeGameId = null;
let dragGameId = null;

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 3500);
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function loadGames() {
  try {
    games = await api('/api/games');
  } catch (err) {
    console.error(err);
    games = [];
  }
  render();
}

function render() {
  board.innerHTML = '';
  for (const col of COLUMNS) {
    const colGames = games
      .filter((g) => g.status === col.status)
      .sort((a, b) => a.position - b.position);

    const columnEl = document.createElement('section');
    columnEl.className = 'column';
    columnEl.dataset.status = col.status;

    const header = document.createElement('div');
    header.className = 'column-header';
    header.innerHTML = `<span><span class="dot"></span>${col.label}</span><span class="count">${colGames.length}</span>`;
    columnEl.appendChild(header);

    const list = document.createElement('div');
    list.className = 'card-list';
    list.dataset.status = col.status;

    if (colGames.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = col.status === 'backlog' ? 'No games yet — add one above.' : 'Nothing here.';
      list.appendChild(empty);
    }

    for (const game of colGames) {
      list.appendChild(renderCard(game));
    }

    attachDropHandlers(list);
    columnEl.appendChild(list);
    board.appendChild(columnEl);
  }
}

function renderCard(game) {
  const card = document.createElement('div');
  card.className = 'card';
  card.draggable = true;
  card.dataset.id = String(game.id);

  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = game.title;
  card.appendChild(title);

  if (game.platform) {
    const platform = document.createElement('div');
    platform.className = 'card-platform';
    platform.textContent = game.platform;
    card.appendChild(platform);
  }

  if (game.notes) {
    const notes = document.createElement('div');
    notes.className = 'card-notes-preview';
    notes.textContent = game.notes;
    card.appendChild(notes);
  }

  card.addEventListener('click', () => openDetail(game.id));

  card.addEventListener('dragstart', (e) => {
    dragGameId = game.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    dragGameId = null;
  });

  return card;
}

function attachDropHandlers(list) {
  list.addEventListener('dragover', (e) => {
    e.preventDefault();
    list.classList.add('drag-over');
  });

  list.addEventListener('dragleave', () => {
    list.classList.remove('drag-over');
  });

  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    list.classList.remove('drag-over');
    if (dragGameId == null) return;
    const newStatus = list.dataset.status;
    const game = games.find((g) => g.id === dragGameId);
    if (!game) return;

    const targetCount = games.filter((g) => g.status === newStatus && g.id !== game.id).length;
    const optimistic = { ...game, status: newStatus, position: targetCount };
    games = games.map((g) => (g.id === game.id ? optimistic : g));
    render();

    try {
      const updated = await api(`/api/games/${game.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus, position: targetCount }),
      });
      games = games.map((g) => (g.id === updated.id ? updated : g));
      render();
    } catch (err) {
      console.error(err);
      await loadGames();
    }
  });
}

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = titleInput.value.trim();
  if (!title) return;
  const platform = platformInput.value.trim();

  const submitBtn = addForm.querySelector('button');
  submitBtn.disabled = true;
  try {
    const created = await api('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, platform, status: 'backlog' }),
    });
    games.push(created);
    render();
    titleInput.value = '';
    platformInput.value = '';
    titleInput.focus();
  } catch (err) {
    console.error(err);
    showToast('Could not add game: ' + err.message);
  } finally {
    submitBtn.disabled = false;
  }
});

function openDetail(id) {
  const game = games.find((g) => g.id === id);
  if (!game) return;
  activeGameId = id;
  detailTitle.value = game.title;
  detailPlatform.value = game.platform;
  detailStatus.value = game.status;
  detailNotes.value = game.notes;
  overlay.classList.remove('hidden');
  detailTitle.focus();
}

function disarmDelete() {
  clearTimeout(disarmDelete._t);
  detailDelete.classList.remove('confirm');
  detailDelete.textContent = 'Delete game';
}

function closeDetail() {
  disarmDelete();
  overlay.classList.add('hidden');
  activeGameId = null;
}

detailClose.addEventListener('click', closeDetail);
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) closeDetail();
});

detailSave.addEventListener('click', async () => {
  if (activeGameId == null) return;
  const title = detailTitle.value.trim();
  if (!title) {
    showToast('Title cannot be empty.');
    detailTitle.focus();
    return;
  }
  detailSave.disabled = true;
  try {
    const updated = await api(`/api/games/${activeGameId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        platform: detailPlatform.value.trim(),
        status: detailStatus.value,
        notes: detailNotes.value,
      }),
    });
    games = games.map((g) => (g.id === updated.id ? updated : g));
    render();
    closeDetail();
  } catch (err) {
    console.error(err);
    showToast('Could not save changes: ' + err.message);
  } finally {
    detailSave.disabled = false;
  }
});

detailDelete.addEventListener('click', async () => {
  if (activeGameId == null) return;
  // Two-click delete instead of a blocking confirm() dialog.
  if (!detailDelete.classList.contains('confirm')) {
    detailDelete.classList.add('confirm');
    detailDelete.textContent = 'Click again to delete';
    disarmDelete._t = setTimeout(disarmDelete, 3000);
    return;
  }
  disarmDelete();
  try {
    await api(`/api/games/${activeGameId}`, { method: 'DELETE' });
    games = games.filter((g) => g.id !== activeGameId);
    render();
    closeDetail();
  } catch (err) {
    console.error(err);
    showToast('Could not delete: ' + err.message);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !overlay.classList.contains('hidden')) {
    closeDetail();
  }
});

loadGames();
