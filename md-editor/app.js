const editor = document.getElementById('editor');
const preview = document.getElementById('preview');
const titleEl = document.getElementById('title');
const saveStatus = document.getElementById('save-status');
const docList = document.getElementById('doc-list');
const workspace = document.getElementById('workspace');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const help = document.getElementById('help');
const helpToggle = document.getElementById('help-toggle');
const statsEl = document.getElementById('stats');
const cursorEl = document.getElementById('cursor-pos');
const emptyState = document.getElementById('empty-state');

const state = {
  docs: [], // [{id, title, updated_at}] — list working copy from the server
  current: null, // id of the open document
  dirty: false,
  saveTimer: null,
  inflight: null,
};

// ---------- API ----------

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function setStatus(text, kind = '') {
  saveStatus.textContent = text;
  saveStatus.dataset.kind = kind;
}

function scheduleSave() {
  state.dirty = true;
  setStatus('Unsaved', 'pending');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(save, 700);
}

async function save() {
  clearTimeout(state.saveTimer);
  while (state.inflight) await state.inflight;
  if (!state.dirty || state.current == null) return;

  const id = state.current;
  const payload = { title: titleEl.value, content: editor.value };
  state.dirty = false;
  setStatus('Saving…', 'pending');
  state.inflight = api(`/documents/${id}`, { method: 'PUT', body: payload })
    .then((doc) => {
      updateListEntry(doc);
      if (!state.dirty) setStatus('Saved', 'ok');
    })
    .catch(() => {
      state.dirty = true;
      setStatus('Save failed — retrying', 'error');
      state.saveTimer = setTimeout(save, 3000);
    })
    .finally(() => {
      state.inflight = null;
    });
  await state.inflight;
}

// ---------- Document list ----------

function formatWhen(sqlDate) {
  const d = new Date(sqlDate.replace(' ', 'T') + 'Z');
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function renderList() {
  docList.innerHTML = '';
  for (const doc of state.docs) {
    const li = document.createElement('li');
    li.className = doc.id === state.current ? 'active' : '';
    li.dataset.id = doc.id;

    const open = document.createElement('button');
    open.className = 'doc-open';
    open.innerHTML = '<span class="doc-title"></span><span class="doc-when"></span>';
    open.querySelector('.doc-title').textContent = doc.title;
    open.querySelector('.doc-when').textContent = formatWhen(doc.updated_at);
    open.addEventListener('click', () => openDoc(doc.id));

    const del = document.createElement('button');
    del.className = 'doc-del';
    del.title = 'Delete document';
    del.setAttribute('aria-label', `Delete ${doc.title}`);
    del.textContent = '×';
    del.addEventListener('click', () => confirmDelete(del, doc.id));

    li.append(open, del);
    docList.append(li);
  }
  const empty = state.docs.length === 0;
  emptyState.hidden = !empty;
  workspace.classList.toggle('is-empty', empty);
}

function updateListEntry(doc) {
  const entry = state.docs.find((d) => d.id === doc.id);
  if (!entry) return;
  entry.title = doc.title;
  entry.updated_at = doc.updated_at;
  const li = docList.querySelector(`li[data-id="${doc.id}"]`);
  if (li) {
    li.querySelector('.doc-title').textContent = doc.title;
    li.querySelector('.doc-when').textContent = formatWhen(doc.updated_at);
  }
}

// Two-click delete instead of a blocking confirm() dialog.
function confirmDelete(btn, id) {
  if (!btn.classList.contains('confirm')) {
    btn.classList.add('confirm');
    btn.textContent = 'Delete?';
    setTimeout(() => {
      btn.classList.remove('confirm');
      btn.textContent = '×';
    }, 3000);
    return;
  }
  deleteDoc(id);
}

async function deleteDoc(id) {
  try {
    if (id === state.current) {
      clearTimeout(state.saveTimer);
      while (state.inflight) await state.inflight;
      state.dirty = false;
    }
    await api(`/documents/${id}`, { method: 'DELETE' });
    state.docs = state.docs.filter((d) => d.id !== id);
    if (id === state.current) {
      state.current = null;
      if (state.docs.length) return openDoc(state.docs[0].id);
      showDoc(null);
    }
    renderList();
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

async function newDoc() {
  await save();
  if (state.dirty) return;
  try {
    const doc = await api('/documents', { method: 'POST', body: { title: 'Untitled', content: '' } });
    state.docs.unshift({ id: doc.id, title: doc.title, updated_at: doc.updated_at });
    state.current = doc.id;
    renderList();
    showDoc(doc);
    titleEl.focus();
    titleEl.select();
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

async function openDoc(id) {
  if (id === state.current) return closeSidebarOnMobile();
  await save();
  if (state.dirty) return; // save failed; don't navigate away from unsaved work
  try {
    const doc = await api(`/documents/${id}`);
    state.current = doc.id;
    renderList();
    showDoc(doc);
    closeSidebarOnMobile();
  } catch (err) {
    setStatus(err.message, 'error');
  }
}

function showDoc(doc) {
  editor.disabled = !doc;
  titleEl.disabled = !doc;
  editor.placeholder = doc ? 'Start writing Markdown…' : '';
  editor.value = doc ? doc.content : '';
  titleEl.value = doc ? doc.title : '';
  setStatus(doc ? 'Saved' : '', doc ? 'ok' : '');
  editor.scrollTop = 0;
  preview.scrollTop = 0;
  editor.setSelectionRange(0, 0);
  refresh();
}

// ---------- Preview + stats ----------

let renderQueued = false;
function refresh() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    preview.innerHTML = editor.value.trim()
      ? renderMarkdown(editor.value)
      : '<p class="preview-empty">Nothing to preview yet.</p>';
    const text = editor.value;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const minutes = Math.max(1, Math.round(words / 230));
    statsEl.textContent = `${words} words · ${text.length} chars · ${minutes} min read`;
    document.title = `${titleEl.value || 'Untitled'} — MD Editor`;
    updateCursor();
  });
}

function updateCursor() {
  const before = editor.value.slice(0, editor.selectionStart);
  const line = before.split('\n').length;
  const col = before.length - before.lastIndexOf('\n');
  cursorEl.textContent = `Ln ${line}, Col ${col}`;
}

editor.addEventListener('input', () => {
  refresh();
  scheduleSave();
});
titleEl.addEventListener('input', () => {
  refresh();
  scheduleSave();
});
titleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    editor.focus();
  }
});
editor.addEventListener('keyup', updateCursor);
editor.addEventListener('click', updateCursor);

// Keep the preview roughly in step with the editor while scrolling in split view.
editor.addEventListener('scroll', () => {
  if (workspace.dataset.view !== 'split') return;
  const max = editor.scrollHeight - editor.clientHeight;
  const ratio = max > 0 ? editor.scrollTop / max : 0;
  preview.scrollTop = ratio * (preview.scrollHeight - preview.clientHeight);
});

preview.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (href.startsWith('#')) {
    const target = preview.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (href !== '#') {
    window.open(href, '_blank', 'noopener');
  }
});

// ---------- Editing helpers ----------

// Inserts via execCommand when possible so Ctrl+Z still works.
function replaceRange(start, end, text, selStart = start + text.length, selEnd = selStart) {
  editor.focus();
  editor.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) {
    editor.setRangeText(text, start, end, 'end');
    editor.dispatchEvent(new Event('input'));
  }
  editor.setSelectionRange(selStart, selEnd);
  updateCursor();
}

function wrap(before, after, placeholder) {
  const { selectionStart: s, selectionEnd: e, value } = editor;
  const sel = value.slice(s, e);
  if (value.slice(s - before.length, s) === before && value.slice(e, e + after.length) === after) {
    replaceRange(s - before.length, e + after.length, sel, s - before.length, e - before.length);
    return;
  }
  const inner = sel || placeholder;
  replaceRange(s, e, before + inner + after, s + before.length, s + before.length + inner.length);
}

function selectedLines() {
  const { selectionStart: s, selectionEnd: e, value } = editor;
  const start = value.lastIndexOf('\n', s - 1) + 1;
  let end = value.indexOf('\n', e > s && value[e - 1] === '\n' ? e - 1 : e);
  if (end === -1) end = value.length;
  return { start, end, lines: value.slice(start, end).split('\n') };
}

const PREFIX_RE = /^(\s*)(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/;

// Toggles a line prefix (heading, quote, list marker) across all selected lines.
function prefixLines(makePrefix) {
  const collapsed = editor.selectionStart === editor.selectionEnd;
  const { start, end, lines } = selectedLines();
  const kind = (p) => p.replace(/\d+/, 'N').trim();
  const target = kind(makePrefix(0));
  const allHave = lines.every((l) => !l.trim() || kind(PREFIX_RE.exec(l)[2] || '') === target);
  let n = 0;
  const out = lines.map((line) => {
    if (!line.trim() && lines.length > 1) return line;
    const [, indent, existing = ''] = PREFIX_RE.exec(line);
    const body = line.slice(indent.length + existing.length);
    return allHave ? indent + body : indent + makePrefix(n++) + body;
  });
  const text = out.join('\n');
  replaceRange(start, end, text, collapsed ? start + text.length : start, start + text.length);
}

// Inserts a block element on its own lines, padded by blank lines from its neighbours.
function insertBlock(block, selectFrom = block.length, selectLen = 0) {
  const { selectionStart: s, selectionEnd: e, value } = editor;
  const before = value.slice(0, s);
  const after = value.slice(e);
  const pre = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const post = after === '' ? '\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const at = s + pre.length + selectFrom;
  replaceRange(s, e, pre + block + post, at, at + selectLen);
}

const commands = {
  bold: () => wrap('**', '**', 'bold text'),
  italic: () => wrap('*', '*', 'italic text'),
  strike: () => wrap('~~', '~~', 'struck text'),
  code: () => wrap('`', '`', 'code'),
  h1: () => prefixLines(() => '# '),
  h2: () => prefixLines(() => '## '),
  h3: () => prefixLines(() => '### '),
  quote: () => prefixLines(() => '> '),
  ul: () => prefixLines(() => '- '),
  ol: () => prefixLines((n) => `${n + 1}. `),
  task: () => prefixLines(() => '- [ ] '),
  link: () => {
    const { selectionStart: s, selectionEnd: e, value } = editor;
    const sel = value.slice(s, e);
    if (/^https?:\/\/\S+$/.test(sel)) {
      replaceRange(s, e, `[link text](${sel})`, s + 1, s + 10);
    } else if (sel) {
      replaceRange(s, e, `[${sel}](https://)`, s + sel.length + 3, s + sel.length + 11);
    } else {
      replaceRange(s, e, '[link text](https://)', s + 1, s + 10);
    }
  },
  image: () => {
    const { selectionStart: s, selectionEnd: e, value } = editor;
    const alt = value.slice(s, e) || 'alt text';
    replaceRange(s, e, `![${alt}](https://)`, s + alt.length + 4, s + alt.length + 12);
  },
  codeblock: () => {
    const { selectionStart: s, selectionEnd: e, value } = editor;
    const sel = value.slice(s, e);
    if (sel) return replaceRange(s, e, '```\n' + sel.replace(/\n$/, '') + '\n```', s + 3, s + 3);
    insertBlock('```\ncode\n```', 4, 4);
  },
  table: () => insertBlock('| Column | Column |\n| ------ | ------ |\n| Cell   | Cell   |', 2, 6),
  hr: () => insertBlock('---'),
};

document.getElementById('toolbar').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-cmd]');
  if (btn && !editor.disabled) commands[btn.dataset.cmd]();
});
// Keep the editor's selection when a toolbar button is pressed.
document.getElementById('toolbar').addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) e.preventDefault();
});

const LIST_CONT_RE = /^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/;

editor.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && !e.altKey) {
    const map = { b: 'bold', i: 'italic', k: 'link', e: 'code' };
    const cmd = map[e.key.toLowerCase()];
    if (cmd) {
      e.preventDefault();
      commands[cmd]();
      return;
    }
  }

  if (e.key === 'Tab' && !mod && !e.altKey) {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: en } = editor;
    const { start, end, lines } = selectedLines();
    const inList = lines.length === 1 && LIST_CONT_RE.test(lines[0]);
    if (s === en && !inList && !e.shiftKey) return replaceRange(s, en, '  ');
    const out = lines.map((l) => (e.shiftKey ? l.replace(/^ {1,2}|^\t/, '') : '  ' + l));
    const text = out.join('\n');
    const shift = out[0].length - lines[0].length;
    if (s === en) return replaceRange(start, end, text, Math.max(start, s + shift));
    replaceRange(start, end, text, start, start + text.length);
    return;
  }

  if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && editor.selectionStart === editor.selectionEnd) {
    const pos = editor.selectionStart;
    const value = editor.value;
    const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
    const line = value.slice(lineStart, pos);
    const list = line.match(LIST_CONT_RE);
    const quote = !list && line.match(/^(\s*>\s?)(.*)$/);
    if (list) {
      e.preventDefault();
      const [, indent, bullet, num, delim, gap, task, rest] = list;
      if (!rest.trim()) return replaceRange(lineStart, pos, ''); // empty item ends the list
      const marker = num ? `${Number(num) + 1}${delim}` : bullet;
      replaceRange(pos, pos, `\n${indent}${marker}${gap}${task ? '[ ] ' : ''}`);
    } else if (quote) {
      e.preventDefault();
      if (!quote[2].trim()) return replaceRange(lineStart, pos, '');
      replaceRange(pos, pos, `\n${quote[1]}`);
    }
  }
});

// ---------- Help toolbox ----------

const HELP = [
  {
    title: 'Headings',
    items: ['# Heading 1', '## Heading 2', '### Heading 3'],
  },
  {
    title: 'Emphasis',
    items: ['**bold**', '*italic*', '~~strikethrough~~', '**_bold italic_**'],
  },
  {
    title: 'Lists',
    items: ['- Item\n- Item\n  - Nested item', '1. First\n2. Second', '- [ ] To do\n- [x] Done'],
  },
  {
    title: 'Links & images',
    items: ['[Link text](https://example.com)', '<https://example.com>', '![Alt text](https://example.com/image.png)', '[Jump to heading](#heading-1)'],
  },
  {
    title: 'Code',
    items: ['`inline code`', '```js\nconsole.log("hi");\n```'],
  },
  {
    title: 'Blocks',
    items: ['> A quotation', '---', '| Left | Center | Right |\n| :--- | :----: | ----: |\n| a    | b      | c     |'],
  },
  {
    title: 'Line breaks & escaping',
    items: ['Line one\\\nLine two', '\\*not italic\\*'],
    note: 'End a line with a backslash (or two spaces) to force a line break. A blank line starts a new paragraph. Raw HTML is shown as text, not rendered.',
  },
];

function buildHelp() {
  const body = document.getElementById('help-body');
  for (const section of HELP) {
    const h = document.createElement('h3');
    h.textContent = section.title;
    body.append(h);
    for (const snippet of section.items) {
      const btn = document.createElement('button');
      btn.className = 'help-item';
      btn.title = 'Insert at cursor';
      const src = document.createElement('code');
      src.textContent = snippet;
      const out = document.createElement('div');
      out.className = 'help-out';
      out.innerHTML = renderMarkdown(snippet);
      btn.append(src, out);
      btn.addEventListener('click', () => insertSnippet(snippet));
      body.append(btn);
    }
    if (section.note) {
      const p = document.createElement('p');
      p.className = 'help-note';
      p.textContent = section.note;
      body.append(p);
    }
  }
}

function insertSnippet(snippet) {
  if (editor.disabled) return;
  if (snippet.includes('\n') || /^(#|>|---|- |1\.)/.test(snippet)) insertBlock(snippet);
  else {
    const { selectionStart: s, selectionEnd: e } = editor;
    replaceRange(s, e, snippet);
  }
}

function setHelp(open) {
  help.hidden = !open;
  helpToggle.setAttribute('aria-expanded', String(open));
  helpToggle.classList.toggle('on', open);
  store('mdeditor.help', open ? '1' : '0');
}

helpToggle.addEventListener('click', () => setHelp(help.hidden));
document.getElementById('help-close').addEventListener('click', () => setHelp(false));

// ---------- View mode, sidebar, global keys ----------

// Per-viewer UI preferences only; documents themselves live in SQLite.
function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setView(view) {
  workspace.dataset.view = view;
  document.querySelectorAll('.view-switch button').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.view === view))
  );
  store('mdeditor.view', view);
  if (view !== 'preview' && !editor.disabled) editor.focus();
}

document.querySelectorAll('.view-switch button').forEach((b) =>
  b.addEventListener('click', () => setView(b.dataset.view))
);

const isNarrow = () => window.matchMedia('(max-width: 760px)').matches;

function setSidebar(open) {
  document.body.classList.toggle('sidebar-closed', !open);
  sidebarToggle.setAttribute('aria-expanded', String(open));
  if (!isNarrow()) store('mdeditor.sidebar', open ? '1' : '0');
}
function closeSidebarOnMobile() {
  if (isNarrow()) setSidebar(false);
}

sidebarToggle.addEventListener('click', () =>
  setSidebar(document.body.classList.contains('sidebar-closed'))
);
document.getElementById('new-doc').addEventListener('click', newDoc);
document.getElementById('empty-new').addEventListener('click', newDoc);

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) {
    if (e.key === 'Escape' && !help.hidden) setHelp(false);
    return;
  }
  if (e.key === 's') {
    e.preventDefault();
    save();
  } else if (e.key === '/') {
    e.preventDefault();
    setHelp(help.hidden);
  } else if (['1', '2', '3'].includes(e.key)) {
    e.preventDefault();
    setView(['edit', 'split', 'preview'][Number(e.key) - 1]);
  }
});

// Flush a pending save if the tab is closed mid-edit.
window.addEventListener('beforeunload', () => {
  if (!state.dirty || state.current == null) return;
  fetch(`/api/documents/${state.current}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: titleEl.value, content: editor.value }),
    keepalive: true,
  });
});

// ---------- Init ----------

(async function init() {
  buildHelp();
  setView(recall('mdeditor.view') || 'split');
  setHelp(recall('mdeditor.help') === '1' && !isNarrow());
  setSidebar(isNarrow() ? false : recall('mdeditor.sidebar') !== '0');

  try {
    state.docs = await api('/documents');
  } catch (err) {
    setStatus('Could not reach the server', 'error');
    editor.placeholder = 'Server unavailable — is node server.js running?';
    return;
  }
  renderList();
  if (state.docs.length) await openDoc(state.docs[0].id);
  else showDoc(null);
  setInterval(() => state.docs.forEach(updateListEntry), 60000);
})();
