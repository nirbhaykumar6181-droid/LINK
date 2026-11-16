# Real-browser tests (Playwright + Chromium)

Not part of `npm test` (they need `pip install playwright` and a Chromium). Each script starts its own relay
on a random-ish port with a temp data dir, opens separate browser contexts as separate users, and prints PASS/FAIL.

- `theme_sync.py`: two users; shared theme, gallery photo, isolation between chats, simultaneous edits, reset, new-device restore.
- `theme_restart.py`: theme + photo survive a hard server kill and restart (also writes 320px screenshots).
- `header_corners.py [path-to-v1.3.2]`: samples the pixel behind the header's curved corner; with a path it also shows the old defect.
