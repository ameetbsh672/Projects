const treeEl = document.getElementById('tree');
const docEl = document.getElementById('doc');
const folderForm = document.getElementById('folder-form');
const folderInput = document.getElementById('folder-input');
const folderStatus = document.getElementById('folder-status');
const themeToggle = document.getElementById('theme-toggle');

let activeFile = null;

function isDarkTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  return current ? current === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function initMermaid() {
  mermaid.initialize({ startOnLoad: false, theme: isDarkTheme() ? 'dark' : 'default' });
}

async function renderMermaidDiagrams() {
  const nodes = docEl.querySelectorAll('pre.mermaid');
  if (nodes.length === 0) return;
  await mermaid.run({ nodes });
}

function applyTheme(theme) {
  if (theme) {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  themeToggle.textContent = isDarkTheme() ? '☀️' : '🌙';
  initMermaid();
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem('md-viewer-theme');
  } catch {
    // ignore
  }
  applyTheme(stored);
}

themeToggle.addEventListener('click', () => {
  const next = isDarkTheme() ? 'light' : 'dark';
  applyTheme(next);
  try {
    localStorage.setItem('md-viewer-theme', next);
  } catch {
    // ignore
  }
  if (activeFile) {
    const el = document.querySelector(`.tree-file[data-path="${CSS.escape(activeFile)}"]`);
    openFile(activeFile, el);
  }
});

async function loadSettings() {
  const res = await fetch('/api/settings');
  const data = await res.json();
  folderInput.value = data.rootFolder;
  folderStatus.textContent = data.rootFolder;
  folderStatus.classList.remove('error');
}

async function loadTree() {
  treeEl.innerHTML = '<p class="tree-empty">Loading…</p>';
  try {
    const res = await fetch('/api/tree');
    const data = await res.json();
    if (!res.ok) {
      treeEl.innerHTML = `<p class="tree-empty">${escapeHtml(data.error || 'Could not load folder')}</p>`;
      return;
    }
    if (data.tree.length === 0) {
      treeEl.innerHTML = '<p class="tree-empty">No .md files found in this folder.</p>';
      return;
    }
    treeEl.innerHTML = '';
    treeEl.appendChild(renderTree(data.tree));
  } catch {
    treeEl.innerHTML = '<p class="tree-empty">Could not reach the server.</p>';
  }
}

function renderTree(nodes) {
  const ul = document.createElement('ul');
  for (const node of nodes) {
    const li = document.createElement('li');
    if (node.type === 'dir') {
      const dirEl = document.createElement('div');
      dirEl.className = 'tree-dir';
      dirEl.innerHTML = `<span class="chevron">▾</span><span>${escapeHtml(node.name)}</span>`;
      const childUl = renderTree(node.children);
      dirEl.addEventListener('click', () => {
        dirEl.classList.toggle('collapsed');
      });
      li.appendChild(dirEl);
      li.appendChild(childUl);
    } else {
      const fileEl = document.createElement('div');
      fileEl.className = 'tree-file';
      fileEl.textContent = node.name;
      fileEl.dataset.path = node.relPath;
      fileEl.addEventListener('click', () => openFile(node.relPath, fileEl));
      li.appendChild(fileEl);
    }
    ul.appendChild(li);
  }
  return ul;
}

async function openFile(relPath, el) {
  document.querySelectorAll('.tree-file.active').forEach((n) => n.classList.remove('active'));
  if (el) el.classList.add('active');
  activeFile = relPath;
  docEl.innerHTML = '<div class="doc-empty"><p>Loading…</p></div>';
  try {
    const res = await fetch('/api/file?path=' + encodeURIComponent(relPath));
    const data = await res.json();
    if (!res.ok) {
      docEl.innerHTML = `<div class="doc-empty"><p>${escapeHtml(data.error || 'Could not load file')}</p></div>`;
      return;
    }
    docEl.innerHTML = renderMarkdown(data.content);
    await renderMermaidDiagrams();
  } catch {
    docEl.innerHTML = '<div class="doc-empty"><p>Could not reach the server.</p></div>';
  }
}

folderForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const folder = folderInput.value.trim();
  if (!folder) return;
  folderStatus.textContent = 'Checking…';
  folderStatus.classList.remove('error');
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rootFolder: folder }),
    });
    const data = await res.json();
    if (!res.ok) {
      folderStatus.textContent = data.error || 'Could not set folder';
      folderStatus.classList.add('error');
      return;
    }
    folderStatus.textContent = data.rootFolder;
    folderStatus.classList.remove('error');
    activeFile = null;
    docEl.innerHTML = '<div class="doc-empty"><p>Select a file on the left to view it.</p></div>';
    await loadTree();
  } catch {
    folderStatus.textContent = 'Could not reach the server.';
    folderStatus.classList.add('error');
  }
});

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Small, dependency-free Markdown -> HTML renderer covering common syntax:
// headings, bold/italic, inline code, fenced code blocks, links, images,
// blockquotes, ordered/unordered lists, horizontal rules, paragraphs.
function renderMarkdown(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;
  let inCode = false;
  let codeLang = '';
  let codeBuf = [];
  let listStack = []; // { type: 'ul'|'ol' }
  let inBlockquote = false;
  let blockquoteBuf = [];

  function closeLists() {
    while (listStack.length) {
      html.push(`</${listStack.pop().type}>`);
    }
  }

  function flushBlockquote() {
    if (inBlockquote) {
      html.push('<blockquote>' + renderInlineBlock(blockquoteBuf.join('\n')) + '</blockquote>');
      blockquoteBuf = [];
      inBlockquote = false;
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      if (!inCode) {
        closeLists();
        flushBlockquote();
        inCode = true;
        codeLang = fence[1];
        codeBuf = [];
      } else {
        if (codeLang === 'mermaid') {
          html.push(`<pre class="mermaid">${escapeHtml(codeBuf.join('\n'))}</pre>`);
        } else {
          html.push(
            `<pre><code${codeLang ? ` class="language-${escapeHtml(codeLang)}"` : ''}>${escapeHtml(
              codeBuf.join('\n')
            )}</code></pre>`
          );
        }
        inCode = false;
      }
      i++;
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      closeLists();
      inBlockquote = true;
      blockquoteBuf.push(line.replace(/^\s*>\s?/, ''));
      i++;
      continue;
    } else if (inBlockquote) {
      flushBlockquote();
    }

    if (/^\s*$/.test(line)) {
      closeLists();
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeLists();
      html.push('<hr>');
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeLists();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    const ulItem = line.match(/^\s*[-*+]\s+(.*)$/);
    const olItem = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ulItem || olItem) {
      const type = ulItem ? 'ul' : 'ol';
      if (listStack.length === 0 || listStack[listStack.length - 1].type !== type) {
        closeLists();
        html.push(`<${type}>`);
        listStack.push({ type });
      }
      html.push(`<li>${renderInline(ulItem ? ulItem[1] : olItem[1])}</li>`);
      i++;
      continue;
    }

    closeLists();
    const paraLines = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    html.push(`<p>${renderInline(paraLines.join(' '))}</p>`);
  }
  closeLists();
  flushBlockquote();
  if (inCode) {
    html.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
  }
  return html.join('\n');
}

function renderInlineBlock(text) {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${renderInline(p.replace(/\n/g, ' '))}</p>`)
    .join('\n');
}

function renderInline(text) {
  let escaped = escapeHtml(text);
  escaped = escaped.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  escaped = escaped.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">');
  escaped = escaped.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  escaped = escaped.replace(/(?<![_\w])_([^_]+)_(?![_\w])/g, '<em>$1</em>');
  return escaped;
}

(async function init() {
  initTheme();
  await loadSettings();
  await loadTree();
})();
