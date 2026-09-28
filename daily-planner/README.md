# Daily Planner

A local day planner: an hourly schedule (6 AM–10 PM) for time-blocking your day, plus a
prioritized task list. Each day is tracked separately and everything is saved to a local
SQLite database, so you can navigate back and forth between days and nothing is lost.

Run it:

```
node server.js
```

Then open http://localhost:4173

Data lives in `data.db` in this folder — copy or open it with any SQLite tool to back up
or inspect it. The visible schedule hours (6 AM–10 PM) are set via `START_HOUR`/`END_HOUR`
near the top of `app.js` if you want a different range.
