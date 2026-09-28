const wordDisplay = document.getElementById('word-display');
const keyboard = document.getElementById('keyboard');
const message = document.getElementById('message');
const wrongCountEl = document.getElementById('wrong-count');
const wrongLettersEl = document.getElementById('wrong-letters');
const difficultySelect = document.getElementById('difficulty');
const newGameBtn = document.getElementById('new-game-btn');
const statWords = document.getElementById('stat-words');
const statWins = document.getElementById('stat-wins');
const statLosses = document.getElementById('stat-losses');
const figureParts = document.querySelectorAll('.part.figure');

let currentGame = null;
let busy = false;

function buildKeyboard() {
  keyboard.innerHTML = '';
  for (let i = 97; i <= 122; i++) {
    const letter = String.fromCharCode(i);
    const btn = document.createElement('button');
    btn.className = 'key';
    btn.textContent = letter;
    btn.dataset.letter = letter;
    btn.addEventListener('click', () => guess(letter));
    keyboard.appendChild(btn);
  }
}

function renderGame(game) {
  currentGame = game;
  wordDisplay.textContent = game.masked.split('').join(' ');
  wrongCountEl.textContent = `${game.wrongCount} / ${game.maxWrong} wrong guesses`;

  wrongLettersEl.innerHTML = '';
  game.wrongLetters.forEach((l) => {
    const span = document.createElement('span');
    span.textContent = l;
    wrongLettersEl.appendChild(span);
  });

  figureParts.forEach((part) => {
    const stage = Number(part.dataset.stage);
    part.style.opacity = stage <= game.wrongCount ? '1' : '0';
  });

  document.querySelectorAll('.key').forEach((btn) => {
    const letter = btn.dataset.letter;
    const wasGuessed = game.guessed.includes(letter);
    btn.disabled = wasGuessed || game.status !== 'playing';
    btn.classList.remove('correct', 'wrong');
    if (wasGuessed) {
      btn.classList.add(game.wrongLetters.includes(letter) ? 'wrong' : 'correct');
    }
  });

  message.classList.remove('won', 'lost');
  if (game.status === 'won') {
    message.textContent = `You got it! The word was "${game.word}".`;
    message.classList.add('won');
  } else if (game.status === 'lost') {
    message.textContent = `Out of guesses. The word was "${game.word}".`;
    message.classList.add('lost');
  } else {
    message.textContent = '';
  }
}

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadStats() {
  try {
    const stats = await fetchJSON('/api/stats');
    statWords.textContent = `${stats.totalWords.toLocaleString()} words`;
    statWins.textContent = `${stats.wins} wins`;
    statLosses.textContent = `${stats.losses} losses`;
  } catch (err) {
    statWords.textContent = 'stats unavailable';
  }
}

async function startNewGame() {
  if (busy) return;
  busy = true;
  newGameBtn.disabled = true;
  message.textContent = '';
  try {
    const game = await fetchJSON('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ difficulty: difficultySelect.value }),
    });
    buildKeyboard();
    renderGame(game);
    await loadStats();
  } catch (err) {
    message.textContent = 'Could not start a new game. Is the server running?';
  } finally {
    busy = false;
    newGameBtn.disabled = false;
  }
}

async function guess(letter) {
  if (busy || !currentGame || currentGame.status !== 'playing') return;
  busy = true;
  try {
    const game = await fetchJSON(`/api/games/${currentGame.id}/guess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ letter }),
    });
    renderGame(game);
    if (game.status !== 'playing') await loadStats();
  } catch (err) {
    message.textContent = 'That guess did not go through — try again.';
  } finally {
    busy = false;
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key.length === 1 && /[a-z]/i.test(e.key)) {
    guess(e.key.toLowerCase());
  }
});

newGameBtn.addEventListener('click', startNewGame);

async function init() {
  buildKeyboard();
  await loadStats();
  try {
    const game = await fetchJSON('/api/games/current');
    renderGame(game);
  } catch (err) {
    await startNewGame();
  }
}

init();
