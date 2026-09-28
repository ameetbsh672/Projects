# MD Editor

A minimal Markdown editor: write on the left, live preview on the right, with a
formatting toolbar and a click-to-insert Markdown help panel (`?` or `Ctrl+/`).
Documents autosave as `.md` files in `documents/` as you type.

Run:

```
node server.js
```

Then open http://localhost:4740

No dependencies, no `npm install`.

- The Markdown renderer is hand-written in `markdown.js` (no libraries). It
  covers headings, emphasis, strikethrough, lists (nested, numbered, tasks),
  links, images, code, quotes, tables and rules. Raw HTML is shown as text.
- The help panel's examples live in the `HELP` array in `app.js`.
- Each document is `documents/<title>.md` — the file name is the title, and
  renaming a document renames its file. Copy that folder to back them up.
