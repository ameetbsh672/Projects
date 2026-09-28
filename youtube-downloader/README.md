# YouTube Downloader

A small local web UI for `yt-dlp`. Paste a video URL, pick a quality (720p by
default), and it downloads to a folder on your machine. Every download is
recorded in a SQLite file, so the list — titles, paths, sizes, failures —
survives restarts, and a failed or cancelled download can be retried later.

## Run it

```
node server.js
```

Then open http://localhost:4175

## Requirements

- Node 22.5+ (uses the built-in `node:sqlite` module — nothing to `npm install`)
- `yt-dlp` on your `PATH` — this app is a front end for it, and the server
  refuses to start without it
- `ffmpeg`, for merging separate video/audio streams (needed for 1080p and up,
  and for the mp3 preset)

## Notes

- Downloads go to `~/Downloads/youtube-downloader` by default. Change it under
  **Settings**; the choice is stored in the database, not in your browser.
- Two downloads run at a time (`MAX_CONCURRENT` in `server.js`).
- Quality presets live in the `QUALITIES` array near the top of `server.js` —
  add an entry there and it appears in both dropdowns automatically.
- Paste a playlist URL and a "queue every video in it" checkbox appears,
  pre-ticked. Each video becomes its own row, with its own progress, retry and
  file — so one bad video in a playlist doesn't sink the rest. Leave it
  unticked on a `watch?v=…&list=…` link to grab just that one video.
  `MAX_PLAYLIST_ITEMS` in `server.js` caps a single paste at 200 videos.
- Data lives in `data.db` in this folder. Copy it to back up the list, or open
  it with any SQLite tool. Deleting it resets the list but leaves your files.
- "Remove" drops the row and leaves the file on disk; "Delete file" removes both.
- Cancelling leaves yt-dlp's `.part`/`.ytdl` files in the save folder on purpose
  — that's what "Resume" picks up from. Removing a still-incomplete row won't
  clear those; delete them by hand if you don't intend to resume.
