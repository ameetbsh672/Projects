# Hangman: Long Words

A classic hangman game backed by a SQLite database of ~47,000 real English words (5–15 letters, filtered from the system cracklib word list). Pick a word-length difficulty, guess letters, and watch the gallows fill in as you go.

Run it:

```
node server.js
```

Then open http://localhost:4738

## Notes

- The word database is seeded once from `words.txt` into `data.db` (SQLite) on first run. `data.db` is the persistent store — copy or open it with any SQLite tool to inspect or back up.
- Win/loss stats and the in-progress game persist across reloads and restarts.
- To add more words, add them (one per line, lowercase, letters only) to `words.txt` before first run, or `INSERT` directly into the `words` table in `data.db`.
- Also registered in the shared `dashboard/` app (sibling folder) — start it with `node server.js` there and launch this game from http://localhost:4000 instead of running this server directly, if you'd rather manage all your local apps from one place.
