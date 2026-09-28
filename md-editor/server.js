const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

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

// Each document is stored as documents/<title>.md — the file name is the
// title and doubles as the document id. updated_at comes from the file's mtime.
const DOCS_DIR = path.join(APP_DIR, 'documents');
fs.mkdirSync(DOCS_DIR, { recursive: true });

const docPath = (id) => path.join(DOCS_DIR, `${id}.md`);

// Same "YYYY-MM-DD HH:MM:SS" (UTC) format the client expects.
const sqlTime = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

function docIds() {
  return fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3));
}

// Titles become file names, so strip characters that aren't safe in one.
function fileSafe(title) {
  const t = title.replace(/[\/\\:*?"<>|\x00-\x1f]/g, '-').replace(/^\.+/, '').trim();
  return t || 'Untitled';
}

// Pick a free file name for `title`, appending " (2)", " (3)"… on clashes.
// `self` is the doc being renamed, which may keep its own name.
function uniqueId(title, self) {
  const base = fileSafe(title);
  const taken = new Set(docIds().map((id) => id.toLowerCase()));
  if (self) taken.delete(self.toLowerCase());
  let id = base;
  for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${base} (${n})`;
  return id;
}

function getDoc(id) {
  if (!docIds().includes(id)) return undefined;
  const stat = fs.statSync(docPath(id));
  return {
    id,
    title: id,
    content: fs.readFileSync(docPath(id), 'utf8'),
    created_at: sqlTime(stat.birthtime.getTime() ? stat.birthtime : stat.mtime),
    updated_at: sqlTime(stat.mtime),
  };
}

// Writes the doc, renaming its file if the title changed. Returns the new id.
function writeDoc(id, title, content) {
  const newId = uniqueId(title, id);
  if (id && newId !== id) fs.renameSync(docPath(id), docPath(newId));
  fs.writeFileSync(docPath(newId), content);
  return newId;
}

function listDocs() {
  return docIds()
    .map(getDoc)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
    .map(({ id, title, updated_at }) => ({ id, title, updated_at }));
}

const insertDoc = (title, content) => writeDoc(null, title, content);

// Seed one document on first run so the editor never opens empty-handed.
if (docIds().length === 0) insertDoc('Welcome', WELCOME);

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
  const match = url.pathname.match(/^\/api\/documents(?:\/([^/]+))?$/);
  if (!match) return sendJson(res, 404, { error: 'Not found' });
  const id = match[1] ? decodeURIComponent(match[1]) : null;

  if (id === null) {
    if (req.method === 'GET') return sendJson(res, 200, listDocs());
    if (req.method === 'POST') {
      const body = await readJson(req);
      const content = typeof body.content === 'string' ? body.content : '';
      const newId = insertDoc(cleanTitle(body.title), content);
      return sendJson(res, 201, getDoc(newId));
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const existing = getDoc(id);
  if (!existing) return sendJson(res, 404, { error: 'Document not found' });

  if (req.method === 'GET') return sendJson(res, 200, existing);
  if (req.method === 'PUT') {
    const body = await readJson(req);
    const title = body.title !== undefined ? cleanTitle(body.title) : existing.title;
    const content = typeof body.content === 'string' ? body.content : existing.content;
    return sendJson(res, 200, getDoc(writeDoc(id, title, content)));
  }
  if (req.method === 'DELETE') {
    fs.unlinkSync(docPath(id));
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
