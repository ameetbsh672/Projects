const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const PORT = 4173;
const DB_PATH = path.join(__dirname, 'data.db');
const PUBLIC_DIR = __dirname;

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    hour INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    UNIQUE(date, hour)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    done INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0
  );
`);

function sendJSON(res, status, data) {
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
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function isValidDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  const resolved = path.join(PUBLIC_DIR, filePath);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(resolved);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (!url.pathname.startsWith('/api/')) {
    return serveStatic(req, res, url.pathname);
  }

  try {
    // GET /api/day?date=YYYY-MM-DD  -> { blocks: [...], tasks: [...] }
    if (req.method === 'GET' && url.pathname === '/api/day') {
      const date = url.searchParams.get('date');
      if (!isValidDate(date)) return sendJSON(res, 400, { error: 'invalid date' });
      const blocks = db.prepare('SELECT id, hour, text FROM blocks WHERE date = ? ORDER BY hour').all(date);
      const tasks = db.prepare('SELECT id, title, priority, done, position FROM tasks WHERE date = ? ORDER BY position, id').all(date);
      return sendJSON(res, 200, { blocks, tasks });
    }

    // PUT /api/blocks -> upsert a single hour block { date, hour, text }
    if (req.method === 'PUT' && url.pathname === '/api/blocks') {
      const body = await readBody(req);
      const { date, hour, text } = body;
      if (!isValidDate(date) || typeof hour !== 'number' || hour < 0 || hour > 23) {
        return sendJSON(res, 400, { error: 'invalid block' });
      }
      db.prepare(`
        INSERT INTO blocks (date, hour, text) VALUES (?, ?, ?)
        ON CONFLICT(date, hour) DO UPDATE SET text = excluded.text
      `).run(date, hour, String(text || ''));
      return sendJSON(res, 200, { ok: true });
    }

    // POST /api/tasks -> create { date, title, priority }
    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      const body = await readBody(req);
      const { date, title, priority } = body;
      if (!isValidDate(date) || typeof title !== 'string' || !title.trim()) {
        return sendJSON(res, 400, { error: 'invalid task' });
      }
      const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM tasks WHERE date = ?').get(date).m;
      const result = db.prepare(
        'INSERT INTO tasks (date, title, priority, done, position) VALUES (?, ?, ?, 0, ?)'
      ).run(date, title.trim(), priority === 'high' || priority === 'low' ? priority : 'normal', maxPos + 1);
      const task = db.prepare('SELECT id, title, priority, done, position FROM tasks WHERE id = ?').get(result.lastInsertRowid);
      return sendJSON(res, 201, task);
    }

    // PUT /api/tasks/:id -> update { title?, priority?, done? }
    const taskMatch = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
    if (req.method === 'PUT' && taskMatch) {
      const id = Number(taskMatch[1]);
      const existing = db.prepare('SELECT id, title, priority, done, position FROM tasks WHERE id = ?').get(id);
      if (!existing) return sendJSON(res, 404, { error: 'not found' });
      const body = await readBody(req);
      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : existing.title;
      const priority = ['high', 'normal', 'low'].includes(body.priority) ? body.priority : existing.priority;
      const done = typeof body.done === 'boolean' ? (body.done ? 1 : 0) : existing.done;
      db.prepare('UPDATE tasks SET title = ?, priority = ?, done = ? WHERE id = ?').run(title, priority, done, id);
      const updated = db.prepare('SELECT id, title, priority, done, position FROM tasks WHERE id = ?').get(id);
      return sendJSON(res, 200, updated);
    }

    // DELETE /api/tasks/:id
    if (req.method === 'DELETE' && taskMatch) {
      const id = Number(taskMatch[1]);
      const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      if (result.changes === 0) return sendJSON(res, 404, { error: 'not found' });
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 404, { error: 'not found' });
  } catch (err) {
    return sendJSON(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Daily planner running at http://localhost:${PORT}`);
});
