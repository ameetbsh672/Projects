const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = 4174;
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'data.db');

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const STATUSES = new Set(['backlog', 'downloading', 'playing', 'completed', 'dropped']);

function nextPosition(status) {
  const row = db
    .prepare('SELECT MAX(position) AS maxPos FROM games WHERE status = ?')
    .get(status);
  const maxPos = row && row.maxPos !== null ? row.maxPos : -1;
  return maxPos + 1;
}

function rowToGame(row) {
  return {
    id: row.id,
    title: row.title,
    platform: row.platform,
    notes: row.notes,
    status: row.status,
    position: row.position,
    createdAt: row.created_at,
  };
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  const filePath = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.join(ROOT, filePath);
  if (!resolved.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(resolved);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleApi(req, res, pathname) {
  const segments = pathname.split('/').filter(Boolean); // ['api','games', maybe id]

  if (segments.length === 2 && req.method === 'GET') {
    const rows = db
      .prepare('SELECT * FROM games ORDER BY status, position ASC')
      .all();
    sendJson(res, 200, rows.map(rowToGame));
    return;
  }

  if (segments.length === 2 && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      sendJson(res, 400, { error: 'title is required' });
      return;
    }
    const platform = typeof body.platform === 'string' ? body.platform.trim() : '';
    const status = STATUSES.has(body.status) ? body.status : 'backlog';
    const position = nextPosition(status);
    const result = db
      .prepare(
        'INSERT INTO games (title, platform, notes, status, position) VALUES (?, ?, ?, ?, ?)'
      )
      .run(title, platform, '', status, position);
    const row = db
      .prepare('SELECT * FROM games WHERE id = ?')
      .get(Number(result.lastInsertRowid));
    sendJson(res, 201, rowToGame(row));
    return;
  }

  if (segments.length === 3 && req.method === 'PUT') {
    const id = Number(segments[2]);
    if (!Number.isInteger(id)) {
      sendJson(res, 400, { error: 'Invalid id' });
      return;
    }
    const existing = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!existing) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return;
    }

    const title =
      typeof body.title === 'string' && body.title.trim() ? body.title.trim() : existing.title;
    const platform = typeof body.platform === 'string' ? body.platform.trim() : existing.platform;
    const notes = typeof body.notes === 'string' ? body.notes : existing.notes;
    const status = STATUSES.has(body.status) ? body.status : existing.status;
    const position = Number.isInteger(body.position) ? body.position : existing.position;

    db.prepare(
      'UPDATE games SET title = ?, platform = ?, notes = ?, status = ?, position = ? WHERE id = ?'
    ).run(title, platform, notes, status, position, id);

    const row = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    sendJson(res, 200, rowToGame(row));
    return;
  }

  if (segments.length === 3 && req.method === 'DELETE') {
    const id = Number(segments[2]);
    if (!Number.isInteger(id)) {
      sendJson(res, 400, { error: 'Invalid id' });
      return;
    }
    const result = db.prepare('DELETE FROM games WHERE id = ?').run(id);
    if (result.changes === 0) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: 'Internal server error' });
    });
    return;
  }

  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Game playthrough kanban running at http://localhost:${PORT}`);
});
