# MailFlow

A local-first Gmail client for macOS, built because no commercial client had the three
things I actually wanted: meetings transcribed on-device without a bot joining the call,
my CRM's context on every person I email, and AI that drafts replies in my voice rather
than a generic one.

**Status: shipped and daily-driven.** This is the mail client I run my job through, on
two Google accounts, all day, every day. It is personal software: the code is public as
a portfolio piece and reference, not as a supported product, though everything you need
to run your own is in [SETUP.md](SETUP.md).

Built end-to-end pair-programming with Claude Code: v1 (full sync, instant search,
HubSpot sidebar, local transcription) shipped in a day; push mail, AI auto-drafts, and
an iPhone PWA landed over the days that followed. Sister project:
[LocalFlow](https://github.com/mattrobbo01/LocalFlow), a fully local voice dictation
app whose ASR stack this reuses.

<!-- TODO: screenshots (redacted inbox, thread view with an AI draft card, person sidebar, transcript insights) -->

## Why build an email client

I was paying for Spark and eyeing Superhuman at £40/month, and neither would have given
me what I wanted anyway. The interesting features are the ones nobody sells:

- **No cloud middleman.** Mail syncs directly between the Mac and Google. Full offline
  archive in SQLite, instant full-text search across tens of thousands of messages, and
  no third-party server ever sees a message.
- **Meetings become searchable records.** A Swift sidecar taps system audio and the mic,
  runs Parakeet ASR with speaker diarization on the Neural Engine, and produces
  transcripts, summaries, tasks, and sales coaching notes. No bot joins the call and no
  audio leaves the machine.
- **Email is about people, not threads.** A HubSpot-backed sidebar (⌘I) shows the
  person behind any thread: contact card, local time, open deals, notes, meeting
  history, recent correspondence.
- **Replies draft themselves, in my voice.** New mail in the people inbox is triaged by
  a small model; anything that warrants a reply is drafted by a Claude agent with the
  full thread, the sender's CRM record, meeting transcripts, and a corpus of my own
  sent mail. Drafts appear inline as editable cards with one-box "steer and regenerate".

## Features

**Mail, fast**

- Superhuman-style instant actions: a modifier queue applies every action locally the
  moment you press the key, then persists to Gmail asynchronously per-thread
- Command palette (⌘K), fully customisable shortcuts, keyboard-first throughout
- Focused inbox (people / notifications / newsletters), **done = archive** semantics
  (`e`, ⌘Z undo) that interop cleanly with Gmail on other devices
- Two accounts (Workspace + personal), unified or split

**Sync engine**

- Two-pass backfill: 12 months of full bodies, then metadata for the entire history
- IMAP IDLE push on both accounts for real-time delivery, with polling as fallback
- Scheduled send and snooze that fire even when the app is closed, via a launchd runner
- Signatures auto-imported from sent mail; HTML sends with inline images; attachments
  with drag and drop

**Beyond mail**

- Local meeting transcription with per-speaker attribution, plus insight tabs
  (summary, tasks, coaching) that can push straight to HubSpot
- AI auto-drafts as described above, with a shared work queue so the app and the
  background runner can both drain it
- An iPhone PWA: the desktop app doubles as a server, exposing its IPC surface over
  HTTP + SSE and serving a Spark-style mobile UI to the phone over the LAN or
  Tailscale. Off by default (`"enabled": true` in bridge.json turns it on); every data
  route requires a pairing key

## How it's built

Electron + React 19 + Tailwind v4 + better-sqlite3 (FTS5) for the app; a Swift sidecar
speaking JSONL over stdio for audio capture and ASR; plain `fetch` clients for Gmail and
HubSpot (no SDKs). OAuth tokens are encrypted with the macOS Keychain via
`safeStorage`; all credentials live outside the repo in
`~/Library/Application Support/MailFlow/`.

The architecture map, domain invariants, and ship cycle live in
[CLAUDE.md](CLAUDE.md), the dev contract written for the AI pair-programmer as much as
for me. It is a fair sample of what building software this way looks like in practice.

Some problems that took real fighting, preserved for anyone walking the same road:

- **Capturing call audio without a bot** means a Core Audio process tap, where
  `kAudioAggregateDeviceTapAutoStartKey` is load-bearing and undocumented-ish, and a
  mic stream with voice-processing disabled because it zeroes buffers on this hardware
- **Hearing yourself twice:** the mic picks up what the speakers play, so transcription
  dedups by text overlap between the mic and system channels within a sliding window
- **iOS PWAs lie about geometry.** The `black-translucent` status-bar style sizes the
  standalone web view short by exactly the status bar, leaving a dead band no CSS can
  reach; the fix chain ended with a `/client-metrics` beacon so phones report ground
  truth instead of being debugged from screenshots
- **Instant UX over a slow API** is the modifier-queue pattern: mutate local state now,
  reconcile with Gmail later, and design every action to be safely replayable

## Run your own

One-time Google OAuth setup (about 15 minutes, both account types covered) is in
[SETUP.md](SETUP.md). Then:

```bash
npm install                      # postinstall rebuilds better-sqlite3 for Electron
npm run dev                      # HMR dev instance (separate identity from the packaged app)
npx electron-builder --mac dir   # package; then ditto dist/mac-arm64/MailFlow.app /Applications/
bash scripts/install-scribe.sh   # build + install the transcription sidecar
bash scripts/install-launchd.sh  # background runner for scheduled sends
```

HubSpot (optional) wants a Private App token in `hubspot.json`; auto-drafts (optional)
want a Claude Code subscription and `autodraft.json`. Missing config degrades
gracefully: every integration no-ops when its credentials are absent.

## License

MIT. Nothing sensitive is in this repo; config, tokens, and the mail database all live
under `~/Library/Application Support/MailFlow/`.
