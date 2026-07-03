import { spawn, ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { existsSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow } from 'electron'
import { getDb } from '../db/db'
import { exportTranscriptToVault } from './robbo2-export'

export interface SidecarEvent {
  t: 'ready' | 'level' | 'seg' | 'error' | 'stopped'
  ch?: 'mic' | 'sys'
  rms?: number
  t0?: number
  t1?: number
  text?: string
  spk?: number
  message?: string
}

interface ActiveRecording {
  transcriptId: number
  proc: ChildProcess
  seq: number
  startedAt: number
}

let active: ActiveRecording | null = null

function sidecarBinary(): string {
  // Prefer the installed app bundle: TCC only grants System Audio Recording
  // to a real bundle identity (installed via scripts/install-scribe.sh).
  const bundled = '/Applications/MeetingScribe.app/Contents/MacOS/meetingscribe'
  if (existsSync(bundled)) return bundled
  const dev = join(app.getAppPath(), 'sidecar', '.build', 'release', 'meetingscribe')
  if (existsSync(dev)) return dev
  return join(process.resourcesPath ?? '', 'meetingscribe')
}

import { broadcast } from '../broadcast'

export function isRecording(): boolean {
  return active !== null
}

export function startRecording(title: string, attendeeEmails: string[], calendarEventId?: string): number {
  if (active) throw new Error('Already recording')
  const bin = sidecarBinary()
  if (!existsSync(bin)) throw new Error(`meetingscribe binary not found at ${bin} — build sidecar first`)

  const db = getDb()
  const startedAt = Math.floor(Date.now() / 1000)
  const res = db
    .prepare(`INSERT INTO transcripts (title, started_at, calendar_event_id) VALUES (?, ?, ?)`)
    .run(title, startedAt, calendarEventId ?? null)
  const transcriptId = Number(res.lastInsertRowid)

  for (const email of attendeeEmails) {
    db.prepare(
      `INSERT OR IGNORE INTO transcript_attendees (transcript_id, person_email) VALUES (?, ?)`
    ).run(transcriptId, email.toLowerCase())
  }

  const proc = spawn(bin, ['start'], { stdio: ['pipe', 'pipe', 'pipe'] })
  active = { transcriptId, proc, seq: 0, startedAt }

  // Speaker playback reaches the mic acoustically, so remote speech can arrive
  // on BOTH channels (tap = clean, mic = room echo). Voice-processing AEC is
  // broken on this hardware (zeroes buffers — see MicRecorder), so we dedup at
  // the transcript level: near-identical text on the other channel within a
  // few seconds is the echo — keep the first arrival, drop the second.
  const recentSegs: { ch: string; tokens: Set<string>; at: number }[] = []
  const tokenize = (text: string) =>
    new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 1))
  const isEcho = (ch: string, text: string): boolean => {
    const tokens = tokenize(text)
    if (tokens.size < 4) return false
    const now = Date.now()
    for (const seg of recentSegs) {
      if (seg.ch === ch || now - seg.at > 12_000) continue
      let overlap = 0
      for (const w of tokens) if (seg.tokens.has(w)) overlap++
      if (overlap / Math.min(tokens.size, seg.tokens.size) >= 0.7) return true
    }
    recentSegs.push({ ch, tokens, at: now })
    if (recentSegs.length > 24) recentSegs.shift()
    return false
  }

  // A created-but-silent system tap is the signature of the missing
  // "System Audio Recording" TCC permission — surface it instead of
  // silently producing a one-sided transcript.
  let sysHeard = false
  const sysCheck = setTimeout(() => {
    if (active?.proc === proc && !sysHeard) {
      broadcast('transcription:event', {
        t: 'error',
        transcriptId,
        message:
          'System audio is silent — only your mic is being captured. Allow MailFlow (Electron) under System Settings → Privacy & Security → Screen & System Audio Recording, then restart the recording.'
      })
    }
  }, 15_000)

  const rl = createInterface({ input: proc.stdout! })
  rl.on('line', (line) => {
    let ev: SidecarEvent
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    if (ev.t === 'level' && ev.ch === 'sys' && (ev.rms ?? 0) > 0.0005) sysHeard = true
    if (ev.t === 'seg' && ev.ch && ev.text && isEcho(ev.ch, ev.text)) return
    if (ev.t === 'seg' && active) {
      active.seq++
      db.prepare(
        `INSERT INTO transcript_segments (transcript_id, seq, channel, speaker, t0, t1, text)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        active.transcriptId,
        active.seq,
        ev.ch,
        ev.ch === 'mic' ? 'Matt' : ev.spk != null ? `Speaker ${ev.spk + 1}` : 'Speaker',
        ev.t0,
        ev.t1,
        ev.text
      )
    }
    broadcast('transcription:event', { ...ev, transcriptId })
  })

  proc.stderr!.on('data', (d) => console.error('[meetingscribe]', String(d).trim()))
  proc.on('exit', (code) => {
    clearTimeout(sysCheck)
    if (active?.proc === proc) finalize(code === 0 ? null : `sidecar exited with code ${code}`)
  })

  return transcriptId
}

export function stopRecording(): void {
  if (!active) return
  try {
    active.proc.stdin!.write('stop\n')
  } catch {
    active.proc.kill('SIGTERM')
  }
  // finalize happens on process exit
}

function finalize(error: string | null) {
  if (!active) return
  const { transcriptId } = active
  active = null
  getDb().prepare(`UPDATE transcripts SET ended_at = unixepoch() WHERE id = ?`).run(transcriptId)
  const hasSegments =
    ((getDb().prepare(`SELECT COUNT(*) n FROM transcript_segments WHERE transcript_id = ?`).get(transcriptId) as any)
      ?.n ?? 0) > 0
  let path: string | null = null
  if (hasSegments) path = exportTranscriptToVault(transcriptId)
  broadcast('transcription:finished', { transcriptId, error, exportedTo: path })
}

export function listTranscripts(query?: string, limit = 100) {
  const db = getDb()
  const q = query?.trim()
  const where = q
    ? `WHERE t.title LIKE @q OR EXISTS (
         SELECT 1 FROM transcript_segments s WHERE s.transcript_id = t.id AND s.text LIKE @q)`
    : ''
  const params: Record<string, unknown> = q ? { q: `%${q}%`, limit } : { limit }
  return db
    .prepare(
      `SELECT t.id, t.title, t.started_at, t.ended_at, t.markdown_path,
        (SELECT text FROM transcript_segments s WHERE s.transcript_id = t.id ORDER BY seq LIMIT 1) AS preview,
        (SELECT group_concat(COALESCE(p.name, ta.person_email), ', ')
           FROM transcript_attendees ta LEFT JOIN people p ON p.email = ta.person_email
           WHERE ta.transcript_id = t.id) AS attendee_names
       FROM transcripts t ${where}
       ORDER BY t.started_at DESC LIMIT @limit`
    )
    .all(params)
}

export function getTranscript(id: number) {
  const db = getDb()
  return {
    transcript: db.prepare(`SELECT * FROM transcripts WHERE id = ?`).get(id),
    segments: db.prepare(`SELECT * FROM transcript_segments WHERE transcript_id = ? ORDER BY seq`).all(id),
    attendees: db
      .prepare(
        `SELECT ta.person_email AS email, p.name
         FROM transcript_attendees ta LEFT JOIN people p ON p.email = ta.person_email
         WHERE ta.transcript_id = ?`
      )
      .all(id)
  }
}
