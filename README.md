# MailFlow

Local-first Gmail client for macOS. Built to replace Spark (£15/m) with Superhuman-grade UX —
at £0/m, with everything on-device: email syncs directly with Google, meeting transcription
runs on the Neural Engine, HubSpot context is cached locally. No third-party servers.

**Status: shipped and daily-driven** as `/Applications/MailFlow.app` (packaged via
electron-builder, signed with the local "LocalFlow Dev" cert). Dev contract and architecture
map: [CLAUDE.md](CLAUDE.md). One-time account setup: [SETUP.md](SETUP.md).

## Features

- Two Gmail accounts (work + personal), unified or split, synced via Gmail API + local SQLite/FTS5
- Superhuman-style instant actions (modifier queue), command palette (⌘K), customizable shortcuts
- Focused inbox: people / notifications / newsletters (Gmail categories + heuristics)
- **Done = archive** workflow (`e`, ⌘E show-done toggle, ⌘Z undo) — interops with Gmail iOS
- Full-history instant search; scheduled send + snooze (launchd runner for app-closed sends)
- Drafts (save-on-close prompt), attachments (drag & drop, chips on received mail)
- Signatures auto-imported from sent mail — HTML sends with embedded images
- Dock badge + native new-mail banners (focused inbox only, click-to-open)
- **Local meeting transcription**: Core Audio system tap + mic → Parakeet ASR + diarization
  (no bots, no cloud); transcripts browser in-app + markdown export to the Robbo2 vault
- **HubSpot people sidebar** (⌘I): contact card, local time, deals, notes (fetched on open),
  LinkedIn, meeting history, recent threads — via a HubSpot Service Key

## Develop

```bash
npm install                      # postinstall rebuilds better-sqlite3 for Electron
npm run dev                      # HMR dev instance (separate identity from the packaged app)
npx electron-builder --mac dir   # package; then ditto dist/mac-arm64/MailFlow.app /Applications/
bash scripts/install-scribe.sh   # rebuild + reinstall the transcription sidecar bundle
bash scripts/install-launchd.sh  # background runner for scheduled sends (60s)
```

Config and data live in `~/Library/Application Support/MailFlow/` — nothing sensitive is in
this repo. See [CLAUDE.md](CLAUDE.md) for invariants and gotchas before changing sync,
done-semantics, or the sidecar.
