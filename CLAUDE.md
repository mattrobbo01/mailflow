# MailFlow — dev contract

Local-first Gmail client for macOS (Matt's Spark replacement; Superhuman-grade UX; £0/month).
Electron + React 19 + Tailwind v4 + better-sqlite3 (FTS5), with a Swift sidecar for meeting
transcription. **The installed app at /Applications/MailFlow.app is Matt's daily driver** —
treat it as production.

Strategy/state notes live in the Robbo2 vault: `~/Projects/Robbo2/Projects/MailFlow/_GUIDE.md`.

## Build & ship cycle

```bash
npx tsc --noEmit                 # typecheck (strict)
npx electron-vite build          # bundle main/preload/renderer → out/
npx electron .                   # DEV run (uses out/, no HMR unless `npm run dev`)
npx electron-builder --mac dir   # package → dist/mac-arm64/MailFlow.app (signed "LocalFlow Dev")
rm -rf /Applications/MailFlow.app && ditto dist/mac-arm64/MailFlow.app /Applications/MailFlow.app
open /Applications/MailFlow.app
```

Kill instances with `pkill -f "Applications/MailFlow.app/Contents/MacOS/MailFlow"` (packaged)
or `pkill -f "Projects/mailflow/node_modules/electron"` (dev). Other patterns leave zombies →
duplicate dock icons and a shared-SQLite mess.

Sidecar: `bash scripts/install-scribe.sh` rebuilds Swift + reinstalls /Applications/MeetingScribe.app
(bundle identity is REQUIRED for the System Audio Recording TCC prompt; signed "LocalFlow Dev"
so grants survive rebuilds). Icon: `swift scripts/make-icon.swift` → build/icon.png.

## Architecture map

- `electron/db/` — schema.sql + migrations in db.ts `migrate()` (guarded by meta keys);
  queries.ts (views, FTS search compiler, category groups)
- `electron/sync/` — auth.ts (OAuth loopback, safeStorage tokens), backfill.ts (2-pass:
  12mo full bodies + all-history metadata), incremental.ts (history.list poll, 20s/2min),
  modifier-queue.ts (Superhuman pattern: modify() local now, persist() drains `actions`
  per-thread), send.ts (MIME: alternative+related+mixed; signatures w/ inline images;
  scheduled_jobs), signatures.ts (auto-import from sent mail), inline-images.ts (cid→data)
- `electron/hubspot/` — Service-Key client + 15-min sync; on-demand note fetch per contact
- `electron/calendar/gcal.ts` — meeting watcher (60s; notify ~90s pre-start)
- `electron/transcription/` — sidecar manager (JSONL stdio), echo dedup (mic vs sys text
  overlap ≥0.7 within 12s), robbo2-export.ts (vault frontmatter contract, `source: mailflow`)
- `electron/runner.ts` — `MailFlow --runner` headless: fires scheduled sends/unsnoozes
  (launchd/com.mattrobertson.mailflow.runner.plist; install via scripts/install-launchd.sh)
- `electron/bridge.ts` — iPhone PWA bridge: HTTP server on 0.0.0.0:8484 serving out/renderer
  as the app shell + the ipc.ts handler map over `POST /rpc/:channel` + SSE `GET /events`
  (whitelist in SSE_CHANNELS) + `GET /attachment`. Pairing key in
  `~/Library/Application Support/MailFlow/bridge.json`; data routes require it
  (?key= or X-MailFlow-Key), the static shell doesn't. electron/broadcast.ts fans events
  out to windows AND SSE clients — new main-process events must use it, not webContents.send.
- `src/lib/bridge-web.ts` — browser implementation of window.mailflow (fetch + EventSource);
  keep its channel map in lockstep with preload.ts. main.tsx installs it when no preload
  is present and renders src/mobile/MobileApp (≤700px) instead of App.
- `src/mobile/` — Spark-style phone UI: InboxScreen (groups, date sections, swipe
  right=done / left=snooze, pull-to-refresh, FAB), ThreadScreen (bottom action bar,
  profile icon → PersonSheet bottom sheet wrapping PeopleSidebar), ComposeScreen,
  SearchScreen, Drawer. Reuses MessageCard/ScheduledCard from ThreadView and
  RecipientInput/seeds from Composer (exported for this).
- `sidecar/` — Swift `meetingscribe`: Core Audio process tap (**kAudioAggregateDeviceTapAutoStartKey
  is load-bearing**) + mic (NO voice-processing — zeroes buffers on this hardware) → Parakeet
  ASR (FluidAudio, models shared with LocalFlow) + WeSpeaker diarization on sys channel
- `src/` — App.tsx (sections: mail/transcripts; views incl. drafts; keymap-driven shortcuts),
  Composer (full/compact, drafts-on-close, attachments, recipient typeahead), ThreadView
  (dark cards, forced-light email CSS, scheduled-send cards, attachment chips), PeopleSidebar
  (HubSpot card, timezone clock, notes on demand), Transcripts.tsx

## Domain invariants

- **done == archived** (Spark semantics): `e` sets done_at AND removes INBOX; un-done restores;
  refreshThread auto-dones anything that leaves the inbox (not snoozed/trash/spam/sent-only);
  a reply to a done thread un-dones it.
- Categories: Gmail CATEGORY_* labels + noreply-sender heuristic → people/notifications/newsletters.
  Focused inbox, dock badge, and new-mail banners are people-only.
- The open thread IS the list selection (single source of truth; no separate index state).
- Gmail is source of truth for mail; MailFlow-local state = done_at, snoozed_until, drafts,
  category, people/hs_* caches, transcripts.

## Config & data (all under ~/Library/Application Support/MailFlow/)

mailflow.db (SQLite WAL) · oauth-clients.json (work=Internal app, personal=External/Testing —
personal refresh token expires ~weekly → Reconnect button) · tokens/*.enc (safeStorage; tied to
build identity — dev vs packaged can't read each other's) · hubspot.json (Service Key) ·
signatures.json · bridge.json (iPhone pairing key + port 8484) · attachments/ cache.
Keymap + navCollapsed in renderer localStorage.

## iPhone PWA

Served by the packaged app over the LAN: `http://<mac-ip>:8484/?key=<bridge.json token>`.
Saved to the home screen from that URL (manifest has NO start_url on purpose — Safari keeps
the ?key= URL; a home-screen PWA has separate localStorage from Safari, so the key must live
in the URL). Requires iPhone + Mac on the same network; for remote access both go on
Tailscale (standalone Tailscale.app installed; bridge binds 0.0.0.0 so the tailnet
address works with the same ?key= — a home-screen icon is pinned to its URL, so a
Tailscale-based icon is a separate add). Gmail actions still run on the Mac — the phone is a remote
control for the same DB/queues, so the Mac (or its runner) must be awake to sync/send.

## Gotchas

- Dev-mode Electron lacks the packaged Info.plist extras; system-audio capture in dev needs
  re-patching node_modules Electron.app plist after `npm i` (packaged app has extendInfo ✓).
- better-sqlite3 must match Electron ABI (postinstall runs electron-rebuild).
- Renderer types: window.mailflow declared in src/types.d.ts — keep in lockstep with preload.ts.
- npm overrides pin google-auth-library (dedup); electron-vite needs vite@7.
- Gmail attachment ids go stale — attachment:open re-resolves by filename on 404.
- iOS PWA: `black-translucent` status-bar style sizes the standalone web view SHORT by the
  status bar → dead letterbox band at the screen bottom no CSS can reach. Use `black`.
  iOS bakes status-bar style into the icon at Add-to-Home-Screen time — changing it means
  re-adding the icon. Also: don't trust dvh (mobile heights run off --app-h, set from
  innerHeight in main.tsx), and any parent/iframe color-scheme mismatch forces an opaque
  white canvas behind the email iframes (both declare dark). Debug device geometry via the
  beacon: phones POST /client-metrics → `~/Library/Application Support/MailFlow/client-metrics.jsonl`.
