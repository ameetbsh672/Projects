'use strict';

const $ = (id) => document.getElementById(id);

const form = $('add-form');
const urlInput = $('url');
const qualitySelect = $('quality');
const submitBtn = $('submit');
const errorBox = $('error');
const listEl = $('list');
const emptyEl = $('empty');
const playlistRow = $('playlist-row');
const playlistCheck = $('playlist');
const settingsPanel = $('settings');
const settingsToggle = $('settings-toggle');
const dirInput = $('download-dir');
const defaultQualitySelect = $('default-quality');

const ACTIVE = ['queued', 'fetching', 'downloading'];
const PLAYLIST_RE = /[?&]list=|\/playlist\b/;
const STATUS_LABEL = {
  queued: 'Queued',
  fetching: 'Reading info',
  downloading: 'Downloading',
  done: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
};

let pollTimer = null;
// Kept only as a rendering cache — the server's SQLite rows are the source of
// truth, and every mutation re-reads from the API rather than patching this.
let downloads = [];

// ---------------------------------------------------------------- helpers

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = !message;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function qualityLabel(id) {
  const opt = [...qualitySelect.options].find((o) => o.value === id);
  return opt ? opt.textContent : id;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------- rendering

const bulkEl = $('bulk');
const cancelAllBtn = $('cancel-all');
const deleteAllBtn = $('delete-all');
const deleteFilesCheck = $('delete-files');
let confirmTimer = null;

function renderBulk() {
  const active = downloads.filter((d) => ACTIVE.includes(d.status)).length;
  bulkEl.hidden = downloads.length === 0;
  $('bulk-count').textContent = `${downloads.length} item${downloads.length === 1 ? '' : 's'}${active ? ` · ${active} active` : ''}`;
  cancelAllBtn.disabled = active === 0;
}

function resetDeleteConfirm() {
  clearTimeout(confirmTimer);
  deleteAllBtn.dataset.confirm = '';
  deleteAllBtn.textContent = 'Delete all';
}

cancelAllBtn.addEventListener('click', async () => {
  cancelAllBtn.disabled = true;
  await act('/api/downloads/cancel-all', 'POST');
});

deleteAllBtn.addEventListener('click', async () => {
  if (!deleteAllBtn.dataset.confirm) {
    deleteAllBtn.dataset.confirm = '1';
    deleteAllBtn.textContent = deleteFilesCheck.checked ? 'Confirm: delete entries + files' : 'Confirm: delete all entries';
    confirmTimer = setTimeout(resetDeleteConfirm, 4000);
    return;
  }
  resetDeleteConfirm();
  deleteAllBtn.disabled = true;
  await act(`/api/downloads${deleteFilesCheck.checked ? '?file=1' : ''}`, 'DELETE');
  deleteAllBtn.disabled = false;
  deleteFilesCheck.checked = false;
});

deleteFilesCheck.addEventListener('change', resetDeleteConfirm);

function render() {
  renderBulk();
  emptyEl.hidden = downloads.length > 0;
  listEl.replaceChildren(...downloads.map(card));
}

function card(d) {
  const root = el('article', 'card');
  root.dataset.id = d.id;

  const head = el('div', 'card-head');
  const left = el('div');
  left.append(el('h2', 'title', d.title || (d.is_playlist ? 'Playlist' : d.url)));

  const bits = [];
  if (d.is_playlist) bits.push('Reading the playlist…');
  if (d.playlist_title) bits.push(`${d.playlist_title} · #${d.playlist_index}`);
  if (d.uploader) bits.push(d.uploader);
  const dur = formatDuration(d.duration);
  if (dur) bits.push(dur);
  bits.push(qualityLabel(d.quality));
  const size = formatBytes(d.filesize);
  if (size) bits.push(size);
  left.append(el('p', 'meta', bits.join(' · ')));

  head.append(left, el('span', `badge ${d.status}`, STATUS_LABEL[d.status] || d.status));
  root.append(head);

  // A queued row isn't moving yet, so it gets no progress bar — an animated one
  // would read as "downloading", and a long playlist would leave dozens of them
  // animating at once.
  if (d.status === 'downloading' || d.status === 'fetching') {
    const bar = el('div', 'bar');
    if (d.status !== 'downloading' || !d.percent) bar.classList.add('indeterminate');
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(0, Math.min(100, d.percent || 0))}%`;
    bar.append(fill);
    root.append(bar);

    const line = el('div', 'progress-line');
    line.append(
      el('span', null, d.status === 'downloading' ? `${(d.percent || 0).toFixed(1)}%` : 'Starting…'),
      el('span', null, [d.speed, d.eta ? `ETA ${d.eta}` : null].filter(Boolean).join(' · '))
    );
    root.append(line);
  }

  if (d.status === 'error' && d.error) root.append(el('p', 'fail', d.error));
  if (d.status === 'done' && d.filepath) root.append(el('p', 'path', d.filepath));

  const actions = el('div', 'actions');
  if (ACTIVE.includes(d.status)) {
    actions.append(button('Cancel', () => act(`/api/downloads/${d.id}/cancel`, 'POST')));
  } else {
    if (d.status === 'done' && d.filepath) {
      const link = document.createElement('a');
      link.href = `/api/downloads/${d.id}/file`;
      link.textContent = 'Save a copy';
      actions.append(link);
      actions.append(button('Copy path', () => navigator.clipboard?.writeText(d.filepath)));
    }
    if (d.status !== 'done') {
      actions.append(button(d.status === 'cancelled' ? 'Resume' : 'Retry', () => act(`/api/downloads/${d.id}/retry`, 'POST')));
    }
    const remove = button('Remove', () => act(`/api/downloads/${d.id}`, 'DELETE'));
    remove.className = 'danger';
    actions.append(remove);
    if (d.status === 'done' && d.filepath) {
      const del = button('Delete file', () => act(`/api/downloads/${d.id}?file=1`, 'DELETE'));
      del.className = 'danger';
      actions.append(del);
    }
  }
  root.append(actions);
  return root;
}

function button(label, onClick) {
  const b = el('button', null, label);
  b.type = 'button';
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await onClick();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

async function act(path, method) {
  showError('');
  try {
    await api(path, { method });
    await refresh();
  } catch (err) {
    showError(err.message);
  }
}

// ---------------------------------------------------------------- polling

async function refresh() {
  downloads = await api('/api/downloads');
  render();
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(pollTimer);
  // Poll fast while something is moving, and slowly otherwise so an idle tab
  // isn't hammering the server for rows that can't change on their own.
  const delay = downloads.some((d) => ACTIVE.includes(d.status)) ? 800 : 10000;
  pollTimer = setTimeout(() => {
    refresh().catch(() => schedulePoll());
  }, delay);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh().catch(() => {});
});

// ---------------------------------------------------------------- events

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  const url = urlInput.value.trim();
  if (!url) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Adding…';
  try {
    await api('/api/downloads', {
      method: 'POST',
      body: JSON.stringify({
        url,
        quality: qualitySelect.value,
        playlist: !playlistRow.hidden && playlistCheck.checked,
      }),
    });
    urlInput.value = '';
    syncPlaylistToggle();
    await refresh();
  } catch (err) {
    showError(err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Download';
    urlInput.focus();
  }
});

// The toggle only appears for URLs that actually carry a playlist, and ticks
// itself the first time it appears — a `list=` parameter on a plain watch link
// is ambiguous, so the choice stays the user's to undo.
function syncPlaylistToggle() {
  const isPlaylist = PLAYLIST_RE.test(urlInput.value);
  if (isPlaylist && playlistRow.hidden) playlistCheck.checked = true;
  playlistRow.hidden = !isPlaylist;
}

urlInput.addEventListener('input', syncPlaylistToggle);

settingsToggle.addEventListener('click', () => {
  const open = settingsPanel.hidden;
  settingsPanel.hidden = !open;
  settingsToggle.setAttribute('aria-expanded', String(open));
});

$('save-settings').addEventListener('click', async () => {
  showError('');
  try {
    const saved = await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        download_dir: dirInput.value,
        default_quality: defaultQualitySelect.value,
      }),
    });
    dirInput.value = saved.download_dir;
    qualitySelect.value = saved.default_quality;
    settingsPanel.hidden = true;
    settingsToggle.setAttribute('aria-expanded', 'false');
  } catch (err) {
    showError(err.message);
  }
});

// ---------------------------------------------------------------- startup

async function init() {
  try {
    const [qualities, settings] = await Promise.all([api('/api/qualities'), api('/api/settings')]);
    for (const select of [qualitySelect, defaultQualitySelect]) {
      select.replaceChildren(
        ...qualities.map((q) => {
          const opt = document.createElement('option');
          opt.value = q.id;
          opt.textContent = q.label;
          return opt;
        })
      );
    }
    qualitySelect.value = settings.default_quality;
    defaultQualitySelect.value = settings.default_quality;
    dirInput.value = settings.download_dir;
    await refresh();
    urlInput.focus();
  } catch (err) {
    showError(`Couldn't reach the server: ${err.message}`);
  }
}

init();
