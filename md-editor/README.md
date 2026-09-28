# MD Editor

A minimal Markdown editor: write on the left, live preview on the right, with a
formatting toolbar and a click-to-insert Markdown help panel (`?` or `Ctrl+/`).
Documents autosave to a local SQLite file (`data.db`) as you type.

Run:

```
node server.js
```

Then open http://localhost:4740

Requires Node 22.5+ (uses the built-in `node:sqlite`). No `npm install`.

- The Markdown renderer is hand-written in `markdown.js` (no libraries). It
  covers headings, emphasis, strikethrough, lists (nested, numbered, tasks),
  links, images, code, quotes, tables and rules. Raw HTML is shown as text.
- The help panel's examples live in the `HELP` array in `app.js`.
- Documents are rows in the `documents` table in `data.db`; copy that file to
  back them up.
