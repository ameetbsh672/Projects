const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const PORT = 4000;
const ROOT = __dirname;
const APPS_FILE = path.join(ROOT, 'apps.json');

function loadApps() {
  const raw = fs.readFileSync(APPS_FILE, 'utf8');
  const list = JSON.parse(raw);
  const byId = {};
  for (const app of list) byId[app.id] = app;
  return byId;
}

// Tracks running child processes by app id.
const running = {};

function startApp(id) {
  const apps = loadApps();
  const app = apps[id];
  if (!app) throw new Error('unknown app');
  if (running[id]) return running[id];

  const appDir = path.join(ROOT, app.dir);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const entry = { child, startedAt: Date.now(), log: [] };
  const pushLog = (chunk) => {
    entry.log.push(chunk.toString());
    if (entry.log.length > 200) entry.log.shift();
  };
  child.stdout.on('data', pushLog);
  child.stderr.on('data', pushLog);
  child.on('exit', () => {
    delete running[id];
  });

  running[id] = entry;
  return entry;
}

function stopApp(id) {
  const entry = running[id];
  if (!entry) return false;
  entry.child.kill();
  delete running[id];
  return true;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  const filePath = urlPath === '/' ? '/index.html' : urlPath;
  const fullPath = path.join(ROOT, 'public', filePath);
  if (!fullPath.startsWith(path.join(ROOT, 'public'))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/apps' && req.method === 'GET') {
    const apps = loadApps();
    const list = Object.entries(apps).map(([id, app]) => ({
      id,
      name: app.name,
      port: app.port,
      url: `http://localhost:${app.port}`,
      running: Boolean(running[id]),
    }));
    return sendJson(res, 200, list);
  }

  const startMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/start$/);
  if (startMatch && req.method === 'POST') {
    const id = startMatch[1];
    try {
      startApp(id);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 404, { error: err.message });
    }
  }

  const stopMatch = url.pathname.match(/^\/api\/apps\/([^/]+)\/stop$/);
  if (stopMatch && req.method === 'POST') {
    const id = stopMatch[1];
    stopApp(id);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET') {
    return serveStatic(req, res, url.pathname);
  }

  res.writeHead(405);
  res.end('Method not allowed');
});

process.on('SIGINT', () => {
  for (const id of Object.keys(running)) stopApp(id);
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
