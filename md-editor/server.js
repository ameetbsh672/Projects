const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = 4740;
const APP_DIR = __dirname;

const WELCOME = `# Welcome to MD Editor

Type Markdown on the left, see the result on the right.

- **Bold**, *italic*, \`inline code\`, [links](https://example.com)
- [x] Task lists
- [ ] Tables, quotes, code blocks

Open the **Help** panel (\`?\` button or \`Ctrl+/\`) for a syntax cheat sheet —
click any example there to insert it at the cursor.
`;

const db = new DatabaseSync(path.join(APP_DIR, 'data.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'Untitled',
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Seed one document on first run so the editor never opens empty-handed.
if (db.prepare('SELECT COUNT(*) AS n FROM documents').get().n === 0) {
  db.prepare('INSERT INTO documents (title, content) VALUES (?, ?)').run('Welcome', WELCOME);
}

const listDocs = db.prepare(
  'SELECT id, title, updated_at FROM documents ORDER BY updated_at DESC, id DESC'
);
const getDoc = db.prepare('SELECT * FROM documents WHERE id = ?');
const insertDoc = db.prepare('INSERT INTO documents (title, content) VALUES (?, ?)');
const updateDoc = db.prepare(
  "UPDATE documents SET title = ?, content = ?, updated_at = datetime('now') WHERE id = ?"
);
const deleteDoc = db.prepare('DELETE FROM documents WHERE id = ?');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function cleanTitle(title) {
  const t = typeof title === 'string' ? title.trim().slice(0, 200) : '';
  return t || 'Untitled';
}

async function handleApi(req, res, url) {
  const match = url.pathname.match(/^\/api\/documents(?:\/(\d+))?$/);
  if (!match) return sendJson(res, 404, { error: 'Not found' });
  const id = match[1] ? Number(match[1]) : null;

  if (id === null) {
    if (req.method === 'GET') return sendJson(res, 200, listDocs.all());
    if (req.method === 'POST') {
      const body = await readJson(req);
      const content = typeof body.content === 'string' ? body.content : '';
      const { lastInsertRowid } = insertDoc.run(cleanTitle(body.title), content);
      return sendJson(res, 201, getDoc.get(lastInsertRowid));
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const existing = getDoc.get(id);
  if (!existing) return sendJson(res, 404, { error: 'Document not found' });

  if (req.method === 'GET') return sendJson(res, 200, existing);
  if (req.method === 'PUT') {
    const body = await readJson(req);
    const title = body.title !== undefined ? cleanTitle(body.title) : existing.title;
    const content = typeof body.content === 'string' ? body.content : existing.content;
    updateDoc.run(title, content, id);
    return sendJson(res, 200, getDoc.get(id));
  }
  if (req.method === 'DELETE') {
    deleteDoc.run(id);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 405, { error: 'Method not allowed' });
}

function serveStatic(res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'style.css', 'app.js', 'markdown.js'].includes(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  fs.readFile(path.join(APP_DIR, file), (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Failed to read file');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    serveStatic(res, url.pathname);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MD Editor running at http://localhost:${PORT}`);
});
