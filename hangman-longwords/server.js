const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = 4738;
const ROOT = __dirname;
const MAX_WRONG = 6;

const db = new DatabaseSync(path.join(ROOT, 'data.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL UNIQUE,
    length INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL,
    guessed TEXT NOT NULL DEFAULT '',
    wrong_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'playing',
    difficulty TEXT NOT NULL DEFAULT 'any',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Seed the words table from words.txt on first run only.
const wordCount = db.prepare('SELECT COUNT(*) AS c FROM words').get().c;
if (wordCount === 0) {
  const listPath = path.join(ROOT, 'words.txt');
  const words = fs.readFileSync(listPath, 'utf8')
    .split('\n')
    .map((w) => w.trim())
    .filter((w) => /^[a-z]{5,15}$/.test(w));
  const insert = db.prepare('INSERT OR IGNORE INTO words (word, length) VALUES (?, ?)');
  db.exec('BEGIN');
  for (const w of words) insert.run(w, w.length);
  db.exec('COMMIT');
  console.log(`Seeded ${words.length} words into the database.`);
}

const DIFFICULTY_RANGES = {
  short: [5, 6],
  medium: [7, 9],
  long: [10, 15],
  any: [5, 15],
};

function pickRandomWord(difficulty) {
  const [min, max] = DIFFICULTY_RANGES[difficulty] || DIFFICULTY_RANGES.any;
  const row = db.prepare(
    'SELECT word FROM words WHERE length BETWEEN ? AND ? ORDER BY RANDOM() LIMIT 1'
  ).get(min, max);
  return row ? row.word : null;
}

function maskWord(word, guessedLetters) {
  return word
    .split('')
    .map((ch) => (guessedLetters.includes(ch) ? ch : '_'))
    .join('');
}

function serializeGame(row) {
  const guessed = row.guessed ? row.guessed.split(',').filter(Boolean) : [];
  const wrongLetters = guessed.filter((l) => !row.word.includes(l));
  return {
    id: row.id,
    masked: maskWord(row.word, guessed),
    length: row.word.length,
    guessed,
    wrongLetters,
    wrongCount: row.wrong_count,
    maxWrong: MAX_WRONG,
    status: row.status,
    difficulty: row.difficulty,
    word: row.status === 'playing' ? undefined : row.word,
  };
}

function getGameRow(id) {
  return db.prepare('SELECT * FROM games WHERE id = ?').get(id);
}

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
    let chunks = '';
    req.on('data', (chunk) => {
      chunks += chunk;
      if (chunks.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      if (!chunks) return resolve({});
      try {
        resolve(JSON.parse(chunks));
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
  '.js': 'application/javascript; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.join(ROOT, file);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/games' && req.method === 'POST') {
      const body = await readBody(req);
      const difficulty = ['short', 'medium', 'long', 'any'].includes(body.difficulty)
        ? body.difficulty
        : 'any';
      const word = pickRandomWord(difficulty);
      if (!word) return sendJSON(res, 500, { error: 'No words available for that difficulty' });
      const result = db.prepare(
        'INSERT INTO games (word, difficulty) VALUES (?, ?)'
      ).run(word, difficulty);
      const row = getGameRow(Number(result.lastInsertRowid));
      return sendJSON(res, 201, serializeGame(row));
    }

    if (pathname === '/api/games/current' && req.method === 'GET') {
      const row = db.prepare(
        "SELECT * FROM games WHERE status = 'playing' ORDER BY id DESC LIMIT 1"
      ).get();
      if (!row) return sendJSON(res, 404, { error: 'No game in progress' });
      return sendJSON(res, 200, serializeGame(row));
    }

    if (pathname === '/api/stats' && req.method === 'GET') {
      const wins = db.prepare("SELECT COUNT(*) AS c FROM games WHERE status = 'won'").get().c;
      const losses = db.prepare("SELECT COUNT(*) AS c FROM games WHERE status = 'lost'").get().c;
      const totalWords = db.prepare('SELECT COUNT(*) AS c FROM words').get().c;
      return sendJSON(res, 200, { wins, losses, totalWords });
    }

    const gameMatch = pathname.match(/^\/api\/games\/(\d+)$/);
    if (gameMatch && req.method === 'GET') {
      const row = getGameRow(Number(gameMatch[1]));
      if (!row) return sendJSON(res, 404, { error: 'Game not found' });
      return sendJSON(res, 200, serializeGame(row));
    }

    const guessMatch = pathname.match(/^\/api\/games\/(\d+)\/guess$/);
    if (guessMatch && req.method === 'POST') {
      const id = Number(guessMatch[1]);
      const row = getGameRow(id);
      if (!row) return sendJSON(res, 404, { error: 'Game not found' });
      if (row.status !== 'playing') return sendJSON(res, 400, { error: 'Game already over' });

      const body = await readBody(req);
      const letter = (body.letter || '').toLowerCase();
      if (!/^[a-z]$/.test(letter)) {
        return sendJSON(res, 400, { error: 'Guess must be a single letter a-z' });
      }

      const guessed = row.guessed ? row.guessed.split(',').filter(Boolean) : [];
      if (guessed.includes(letter)) {
        return sendJSON(res, 200, serializeGame(row));
      }
      guessed.push(letter);

      let wrongCount = row.wrong_count;
      if (!row.word.includes(letter)) wrongCount += 1;

      let status = 'playing';
      const allRevealed = row.word.split('').every((ch) => guessed.includes(ch));
      if (allRevealed) status = 'won';
      else if (wrongCount >= MAX_WRONG) status = 'lost';

      db.prepare(
        'UPDATE games SET guessed = ?, wrong_count = ?, status = ?, updated_at = datetime(\'now\') WHERE id = ?'
      ).run(guessed.join(','), wrongCount, status, id);

      return sendJSON(res, 200, serializeGame(getGameRow(id)));
    }

    if (pathname.startsWith('/api/')) {
      return sendJSON(res, 404, { error: 'Unknown API route' });
    }

    if (req.method === 'GET') {
      return serveStatic(req, res, pathname);
    }

    res.writeHead(405);
    res.end('Method not allowed');
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Hangman running at http://localhost:${PORT}`);
});
