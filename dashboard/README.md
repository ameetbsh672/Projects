# App Dashboard

A single place to start, stop, and open the three local apps in this folder:
Daily Planner, Ledger (Expenses & Budgets), and Game Playthrough Kanban.

## Run it

```
node server.js
```

Then open http://localhost:4000

Each card lets you start/stop that app's own server as a background process
and open it in a new tab once it's running. Status refreshes automatically
every few seconds.

## Adding an app

Add an entry to `apps.json`:

```json
{ "id": "kebab-case-id", "name": "Human Readable Name", "dir": "../app-folder", "port": 4173 }
```

`dir` is relative to this dashboard folder. Make sure `port` doesn't collide
with another app already listed here.

## Notes

- `game-playthrough-kanban` was moved from port 4173 to 4174 to avoid
  colliding with `daily-planner`, which also used 4173.
- Stopping the dashboard (Ctrl+C) also stops any apps it launched.
