const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = 4739;
const APP_DIR = __dirname;
const DEFAULT_FOLDER = path.join(APP_DIR, 'sample-docs');
const PUBLIC_DIR = path.join(APP_DIR, 'public');

const db = new DatabaseSync(path.join(APP_DIR, 'data.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

function getRootFolder() {
  return getSetting('root_folder', DEFAULT_FOLDER);
}

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
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Recursively builds a tree of .md files under `dir`, relative to `root`.
function buildTree(dir, root) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const children = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = buildTree(full, root);
      if (sub && sub.children.length > 0) {
        children.push({ type: 'dir', name: entry.name, children: sub.children });
      }
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      children.push({
        type: 'file',
        name: entry.name,
        relPath: path.relative(root, full).split(path.sep).join('/'),
      });
    }
  }
  return { children };
}

// Resolves a relative path against the current root, refusing to escape it.
function resolveSafe(root, relPath) {
  const resolved = path.resolve(root, relPath);
  const normalizedRoot = path.resolve(root) + path.sep;
  if (!resolved.startsWith(normalizedRoot)) return null;
  return resolved;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    return sendJson(res, 200, { rootFolder: getRootFolder() });
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    const folder = String(payload.rootFolder || '').trim();
    if (!folder) return sendJson(res, 400, { error: 'rootFolder is required' });
    let stat;
    try {
      stat = fs.statSync(folder);
    } catch {
      return sendJson(res, 404, { error: 'Folder does not exist' });
    }
    if (!stat.isDirectory()) return sendJson(res, 400, { error: 'Path is not a folder' });
    setSetting('root_folder', path.resolve(folder));
    return sendJson(res, 200, { rootFolder: getRootFolder() });
  }

  if (url.pathname === '/api/tree' && req.method === 'GET') {
    const root = getRootFolder();
    const tree = buildTree(root, root);
    if (!tree) return sendJson(res, 404, { error: 'Folder not found: ' + root });
    return sendJson(res, 200, { root, tree: tree.children });
  }

  if (url.pathname === '/api/file' && req.method === 'GET') {
    const root = getRootFolder();
    const relPath = url.searchParams.get('path') || '';
    const full = resolveSafe(root, relPath);
    if (!full || !/\.md$/i.test(full)) return sendJson(res, 400, { error: 'Invalid path' });
    try {
      const content = fs.readFileSync(full, 'utf8');
      return sendJson(res, 200, { path: relPath, content });
    } catch {
      return sendJson(res, 404, { error: 'File not found' });
    }
  }

  if (url.pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'Not found' });
  }

  // Static file serving for the frontend.
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`MD Viewer running at http://localhost:${PORT}`);
});
