'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const PORT = 4175;
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'data.db');
const MAX_CONCURRENT = 2;
// A playlist is expanded into one row per video. Channel URLs can run to
// thousands of entries, so cap what a single paste can queue up.
const MAX_PLAYLIST_ITEMS = 200;

// Quality presets. `fmt` is handed straight to yt-dlp's -f; `post` adds
// extraction flags for the audio-only preset. Add a row here to add a choice
// to the dropdown — the frontend reads this list from GET /api/qualities.
const QUALITIES = [
  { id: '360', label: '360p', fmt: h(360) },
  { id: '480', label: '480p', fmt: h(480) },
  { id: '720', label: '720p', fmt: h(720) },
  { id: '1080', label: '1080p', fmt: h(1080) },
  { id: '1440', label: '1440p', fmt: h(1440) },
  { id: '2160', label: '2160p (4K)', fmt: h(2160) },
  { id: 'best', label: 'Best available', fmt: 'bv*+ba/b' },
  { id: 'audio', label: 'Audio only (mp3)', fmt: 'ba/b', post: ['-x', '--audio-format', 'mp3'] },
];

// Prefer mp4/m4a at or below the requested height, then anything at or below
// it, then fall back to the smallest thing that exists (very old uploads).
function h(height) {
  return `bv*[height<=${height}][ext=mp4]+ba[ext=m4a]/bv*[height<=${height}]+ba/b[height<=${height}]/b`;
}

const DEFAULTS = {
  download_dir: path.join(os.homedir(), 'Downloads', 'youtube-downloader'),
  default_quality: '720',
};

// ---------------------------------------------------------------- database

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS downloads (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    url        TEXT NOT NULL,
    title      TEXT,
    uploader   TEXT,
    duration   INTEGER,
    quality    TEXT NOT NULL,
    status     TEXT NOT NULL,
    percent    REAL NOT NULL DEFAULT 0,
    speed      TEXT,
    eta        TEXT,
    filepath   TEXT,
    filesize   INTEGER,
    error      TEXT,
    is_playlist    INTEGER NOT NULL DEFAULT 0,
    playlist_title TEXT,
    playlist_index INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Older databases predate the playlist columns — add whatever is missing so an
// existing data.db keeps working without being thrown away.
{
  const existing = db.prepare('PRAGMA table_info(downloads)').all().map((c) => c.name);
  const added = [
    ['is_playlist', 'INTEGER NOT NULL DEFAULT 0'],
    ['playlist_title', 'TEXT'],
    ['playlist_index', 'INTEGER'],
  ];
  for (const [name, def] of added) {
    if (!existing.includes(name)) db.exec(`ALTER TABLE downloads ADD COLUMN ${name} ${def}`);
  }
}

const now = () => new Date().toISOString();

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULTS[key];
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// Newest batch first, but within one playlist batch (whose rows all share a
// created_at) keep the playlist's own running order.
function listDownloads() {
  return db
    .prepare(
      `SELECT * FROM downloads
       ORDER BY created_at DESC, COALESCE(playlist_index, 0) ASC, id DESC`
    )
    .all();
}

function getDownload(id) {
  return db.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
}

function patch(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sql = `UPDATE downloads SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => fields[k]), now(), id);
}

// Anything still mid-flight when the server last stopped can't be resumed —
// the child process died with it, so mark it interrupted rather than leaving
// a row that claims to be downloading forever.
db.prepare(
  `UPDATE downloads SET status = 'error', error = 'Interrupted — server restarted', updated_at = ?
   WHERE status IN ('queued', 'fetching', 'downloading')`
).run(now());

// ---------------------------------------------------------------- downloads

const running = new Map(); // download id -> ChildProcess

function qualityById(id) {
  return QUALITIES.find((q) => q.id === id) || QUALITIES.find((q) => q.id === '720');
}

function pump() {
  if (running.size >= MAX_CONCURRENT) return;
  const next = db.prepare(`SELECT * FROM downloads WHERE status = 'queued' ORDER BY id ASC LIMIT 1`).get();
  if (next) start(next);
}

async function start(row) {
  const dir = getSetting('download_dir');
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    patch(row.id, { status: 'error', error: `Can't write to ${dir}: ${err.message}` });
    return;
  }

  patch(row.id, { status: 'fetching', error: null });
  running.set(row.id, null); // reserve the concurrency slot straight away

  fetchMetadata(row.url)
    .then((meta) => {
      if (!getDownload(row.id)) return; // deleted while we were fetching
      if (meta) patch(row.id, meta);
      runDownload(row.id, row.url, row.quality, dir);
    })
    .catch((err) => {
      running.delete(row.id);
      patch(row.id, { status: 'error', error: err.message });
      pump();
    });
}

// A quick metadata pass before downloading, so the card shows a real title
// and duration while the bytes are still moving.
function fetchMetadata(url) {
  return new Promise((resolve) => {
    const child = spawn('yt-dlp', ['-J', '--no-playlist', '--no-warnings', '--', url]);
    let out = '';
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      try {
        const info = JSON.parse(out);
        resolve({
          title: info.title || null,
          uploader: info.uploader || info.channel || null,
          duration: Number.isFinite(info.duration) ? Math.round(info.duration) : null,
        });
      } catch {
        resolve(null); // not fatal — the download itself will report the real error
      }
    });
  });
}

function looksLikePlaylist(url) {
  return /[?&]list=/.test(url) || /\/playlist\b/.test(url);
}

// A playlist row starts life as a single placeholder so the UI has something to
// show while yt-dlp reads the index; once the entries are known the placeholder
// is swapped for one real row per video, inside a transaction so the list is
// never briefly empty of both.
function expandPlaylist(rowId, url, quality) {
  const child = spawn('yt-dlp', [
    '--flat-playlist',
    '-J',
    '--no-warnings',
    '--playlist-items',
    `1-${MAX_PLAYLIST_ITEMS}`,
    '--',
    url,
  ]);

  let out = '';
  let stderr = '';
  child.stdout.on('data', (c) => {
    out += c;
  });
  child.stderr.on('data', (c) => {
    stderr += c;
  });

  child.on('error', (err) => {
    patch(rowId, { status: 'error', error: `Couldn't run yt-dlp: ${err.message}` });
  });

  child.on('close', () => {
    if (!getDownload(rowId)) return; // removed while we were reading the playlist

    let info;
    try {
      info = JSON.parse(out);
    } catch {
      const msg = lastMeaningfulLine(stderr) || "Couldn't read that playlist";
      return patch(rowId, { status: 'error', error: msg });
    }

    const entries = (info.entries || []).filter((e) => e && (e.url || e.id));

    // A plain video URL that merely carried a `list=` parameter: no entries came
    // back, so treat it as the single video it is rather than failing.
    if (!entries.length) {
      if (info.id || info.webpage_url) {
        patch(rowId, { is_playlist: 0, status: 'queued' });
        return pump();
      }
      return patch(rowId, { status: 'error', error: 'No videos found at that URL' });
    }

    const ts = now();
    const playlistTitle = info.title || null;
    const insert = db.prepare(
      `INSERT INTO downloads
         (url, title, uploader, duration, quality, status, playlist_title, playlist_index, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
    );

    db.exec('BEGIN');
    try {
      entries.forEach((entry, i) => {
        insert.run(
          entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
          entry.title || null,
          entry.uploader || entry.channel || info.uploader || null,
          Number.isFinite(entry.duration) ? Math.round(entry.duration) : null,
          quality,
          playlistTitle,
          i + 1,
          ts,
          ts
        );
      });
      db.prepare('DELETE FROM downloads WHERE id = ?').run(rowId);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      return patch(rowId, { status: 'error', error: `Couldn't queue playlist: ${err.message}` });
    }
    pump();
  });
}

function runDownload(id, url, qualityId, dir) {
  const q = qualityById(qualityId);
  const args = [
    '--no-playlist',
    '--newline',
    '--progress',
    '--no-simulate',
    '--no-warnings',
    '--restrict-filenames',
    '-f', q.fmt,
    '-o', path.join(dir, '%(title).180B [%(id)s].%(ext)s'),
    '--print', 'after_move:@@FILE@@%(filepath)s',
    '--progress-template', 'download:@@PROG@@%(progress._percent_str)s@@%(progress._speed_str)s@@%(progress._eta_str)s',
  ];
  if (q.post) args.push(...q.post);
  else args.push('--merge-output-format', 'mp4');
  args.push('--', url);

  const child = spawn('yt-dlp', args);
  running.set(id, child);
  patch(id, { status: 'downloading', percent: 0 });

  let filepath = null;
  let lastWrite = 0;
  let stderr = '';

  lineReader(child.stdout, (line) => {
    if (line.startsWith('@@FILE@@')) {
      filepath = line.slice(8).trim();
      return;
    }
    if (line.startsWith('@@PROG@@')) {
      const [pct, speed, eta] = line.slice(8).split('@@');
      const percent = parseFloat(String(pct).replace('%', '').trim());
      // yt-dlp emits several progress lines a second, and with two concurrent
      // downloads that's a lot of writes for no visible gain — throttle to 2/s.
      const t = Date.now();
      if (t - lastWrite < 500) return;
      lastWrite = t;
      patch(id, {
        percent: Number.isFinite(percent) ? percent : 0,
        speed: (speed || '').trim() || null,
        eta: (eta || '').trim() || null,
      });
    }
  });

  lineReader(child.stderr, (line) => {
    stderr += line + '\n';
  });

  child.on('error', (err) => {
    running.delete(id);
    patch(id, { status: 'error', error: `Couldn't run yt-dlp: ${err.message}` });
    pump();
  });

  child.on('close', (code, signal) => {
    running.delete(id);
    const row = getDownload(id);
    if (!row) return pump(); // deleted mid-download

    if (row.status === 'cancelled' || signal === 'SIGTERM') {
      patch(id, { status: 'cancelled', speed: null, eta: null });
    } else if (code === 0) {
      let size = null;
      if (filepath) {
        try {
          size = fs.statSync(filepath).size;
        } catch {
          /* file moved or removed behind our back — leave size unknown */
        }
      }
      patch(id, {
        status: 'done',
        percent: 100,
        speed: null,
        eta: null,
        filepath,
        filesize: size,
        error: null,
      });
    } else {
      const msg = lastMeaningfulLine(stderr) || `yt-dlp exited with code ${code}`;
      patch(id, { status: 'error', speed: null, eta: null, error: msg });
    }
    pump();
  });
}

function lineReader(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    // yt-dlp redraws the progress line with \r when it isn't in --newline mode
    buf += chunk.replace(/\r/g, '\n');
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) if (line.trim()) onLine(line);
  });
  stream.on('end', () => {
    if (buf.trim()) onLine(buf);
  });
}

function lastMeaningfulLine(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const err = lines.reverse().find((l) => l.startsWith('ERROR:'));
  return (err || lines[0] || '').replace(/^ERROR:\s*/, '').slice(0, 400);
}

// ---------------------------------------------------------------- http

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) || rel === 'data.db') return sendJson(res, 404, { error: 'Not found' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function serveFile(res, row) {
  if (!row.filepath) return sendJson(res, 404, { error: 'No file on disk for this download' });
  fs.stat(row.filepath, (err, stat) => {
    if (err) return sendJson(res, 404, { error: 'File is no longer on disk' });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${path.basename(row.filepath).replace(/"/g, '')}"`,
    });
    fs.createReadStream(row.filepath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  try {
    if (pathname === '/api/qualities' && req.method === 'GET') {
      return sendJson(res, 200, QUALITIES.map(({ id, label }) => ({ id, label })));
    }

    if (pathname === '/api/settings') {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          download_dir: getSetting('download_dir'),
          default_quality: getSetting('default_quality'),
        });
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (body.download_dir !== undefined) {
          const dir = String(body.download_dir).trim();
          if (!dir) return sendJson(res, 400, { error: 'Download folder cannot be empty' });
          setSetting('download_dir', path.resolve(dir.replace(/^~(?=\/|$)/, os.homedir())));
        }
        if (body.default_quality !== undefined) {
          setSetting('default_quality', qualityById(String(body.default_quality)).id);
        }
        return sendJson(res, 200, {
          download_dir: getSetting('download_dir'),
          default_quality: getSetting('default_quality'),
        });
      }
    }

    if (pathname === '/api/downloads') {
      if (req.method === 'GET') return sendJson(res, 200, listDownloads());
      if (req.method === 'POST') {
        const body = await readBody(req);
        const link = String(body.url || '').trim();
        if (!/^https?:\/\/\S+$/i.test(link)) {
          return sendJson(res, 400, { error: 'Paste a full video URL starting with http:// or https://' });
        }
        const quality = qualityById(String(body.quality || getSetting('default_quality'))).id;
        const asPlaylist = body.playlist === true && looksLikePlaylist(link);
        const ts = now();
        const info = db
          .prepare(
            `INSERT INTO downloads (url, quality, status, is_playlist, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(link, quality, asPlaylist ? 'fetching' : 'queued', asPlaylist ? 1 : 0, ts, ts);
        const id = Number(info.lastInsertRowid);
        if (asPlaylist) expandPlaylist(id, link, quality);
        else pump();
        return sendJson(res, 201, getDownload(id));
      }
    }

    if (pathname === '/api/downloads/cancel-all' && req.method === 'POST') {
      // Flip every active row first so the close handlers' pump() finds nothing queued.
      const { changes } = db
        .prepare(
          `UPDATE downloads SET status = 'cancelled', speed = NULL, eta = NULL, updated_at = ?
           WHERE status IN ('queued', 'fetching', 'downloading')`
        )
        .run(now());
      for (const child of running.values()) if (child) child.kill('SIGTERM');
      running.clear();
      return sendJson(res, 200, { cancelled: Number(changes) });
    }

    if (pathname === '/api/downloads' && req.method === 'DELETE') {
      const rows = listDownloads();
      db.prepare('DELETE FROM downloads').run();
      for (const child of running.values()) if (child) child.kill('SIGTERM');
      running.clear();
      if (url.searchParams.get('file') === '1') {
        for (const row of rows) {
          if (row.filepath) await fsp.unlink(row.filepath).catch(() => {});
        }
      }
      return sendJson(res, 200, { deleted: rows.length });
    }

    const match = pathname.match(/^\/api\/downloads\/(\d+)(?:\/(cancel|retry|file))?$/);
    if (match) {
      const id = Number(match[1]);
      const action = match[2];
      const row = getDownload(id);
      if (!row) return sendJson(res, 404, { error: 'Download not found' });

      if (action === 'file' && req.method === 'GET') return serveFile(res, row);

      if (action === 'cancel' && req.method === 'POST') {
        if (!['queued', 'fetching', 'downloading'].includes(row.status)) {
          return sendJson(res, 409, { error: 'That download is not running' });
        }
        patch(id, { status: 'cancelled', speed: null, eta: null });
        const child = running.get(id);
        if (child) child.kill('SIGTERM');
        else running.delete(id);
        pump();
        return sendJson(res, 200, getDownload(id));
      }

      if (action === 'retry' && req.method === 'POST') {
        if (['queued', 'fetching', 'downloading'].includes(row.status)) {
          return sendJson(res, 409, { error: 'That download is already running' });
        }
        const reset = { percent: 0, error: null, speed: null, eta: null, filepath: null, filesize: null };
        if (row.is_playlist) {
          // Still an unexpanded playlist — read the index again rather than
          // trying to download the playlist URL as if it were one video.
          patch(id, { ...reset, status: 'fetching' });
          expandPlaylist(id, row.url, row.quality);
        } else {
          patch(id, { ...reset, status: 'queued' });
          pump();
        }
        return sendJson(res, 200, getDownload(id));
      }

      if (!action && req.method === 'DELETE') {
        const child = running.get(id);
        if (child) child.kill('SIGTERM');
        running.delete(id);
        if (url.searchParams.get('file') === '1' && row.filepath) {
          try {
            await fsp.unlink(row.filepath);
          } catch {
            /* already gone — deleting the row is still the right outcome */
          }
        }
        db.prepare('DELETE FROM downloads WHERE id = ?').run(id);
        pump();
        return sendJson(res, 200, { ok: true });
      }
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
});

// Fail loudly and early if yt-dlp isn't on PATH — the app is a front end for
// it, so there's no useful degraded mode to fall back to.
const probe = spawn('yt-dlp', ['--version']);
probe.on('error', () => {
  console.error('\n  yt-dlp was not found on your PATH.');
  console.error('  Install it first (e.g. `sudo pacman -S yt-dlp` or `pipx install yt-dlp`), then start this again.\n');
  process.exit(1);
});
probe.on('close', () => {
  server.listen(PORT, () => {
    console.log(`YouTube Downloader running at http://localhost:${PORT}`);
    console.log(`Saving to ${getSetting('download_dir')}`);
  });
});

function shutdown() {
  for (const child of running.values()) if (child) child.kill('SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
