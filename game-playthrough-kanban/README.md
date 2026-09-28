# Game Playthrough Kanban

A local kanban board for tracking what you're playing. Drag games between
**Backlog → Playing → Completed → Dropped**, click a card to edit its
platform and progress notes.

## Run it

```
node server.js
```

Then open http://localhost:4174

Data is stored in `data.db` (SQLite) in this folder — back it up or inspect
it with any SQLite tool.

## Notes

- Columns are fixed (backlog/downloading/playing/completed/dropped); edit the `STATUSES`
  set and `COLUMNS` array in `server.js` / `app.js` if you want to rename or
  add more.
- Card order within a column is preserved via a `position` column that
  updates on drag-and-drop.
