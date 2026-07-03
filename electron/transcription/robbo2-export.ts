import { writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { getDb } from '../db/db'

const TRANSCRIPTS_DIR = join(
  process.env.HOME!,
  'Projects', 'Robbo2', 'Projects', 'Habits', 'transcripts'
)

/**
 * Export a finished transcript to the Robbo2 vault, matching the existing
 * frontmatter contract (see 2026-06-04 - NerdWallet (Alex Kemp).md). The
 * verbatim transcript is the payload; the Summary/signals/CRM header sections
 * are added later by Matt's existing daily-ingestion scheduled task — we only
 * archive, never fabricate analysis.
 */
export function exportTranscriptToVault(transcriptId: number): string | null {
  const db = getDb()
  const t = db.prepare(`SELECT * FROM transcripts WHERE id = ?`).get(transcriptId) as any
  if (!t) return null

  const segments = db
    .prepare(`SELECT * FROM transcript_segments WHERE transcript_id = ? ORDER BY seq`)
    .all(transcriptId) as any[]
  const attendees = db
    .prepare(
      `SELECT ta.person_email, p.name FROM transcript_attendees ta
       LEFT JOIN people p ON p.email = ta.person_email
       WHERE ta.transcript_id = ?`
    )
    .all(transcriptId) as any[]

  const date = new Date((t.started_at ?? Date.now() / 1000) * 1000)
  const dateStr = date.toISOString().slice(0, 10)
  const title = (t.title ?? 'Meeting').replace(/[/\\:]/g, '-')

  const attendeeLinks = attendees
    .filter((a) => a.name)
    .map((a) => `"[[People/${a.name}]]"`)
    .join(', ')

  const frontmatter = [
    '---',
    'type: transcript',
    `date: ${dateStr}`,
    `meeting: ${t.title ?? 'Meeting'}`,
    `attendees: [${attendeeLinks}]`,
    'call_type: unknown',
    'source: mailflow',
    `created: ${new Date().toISOString().slice(0, 10)}`,
    '---'
  ].join('\n')

  const body = segments
    .map((s) => {
      const mins = Math.floor(s.t0 / 60)
      const secs = Math.floor(s.t0 % 60).toString().padStart(2, '0')
      return `**${s.speaker ?? (s.channel === 'mic' ? 'Matt' : 'Speaker')}** [${mins}:${secs}]: ${s.text}`
    })
    .join('\n\n')

  const md = `${frontmatter}\n# ${dateStr} — ${t.title ?? 'Meeting'}\n\n## Transcript (verbatim)\n\n${body}\n`

  if (!existsSync(TRANSCRIPTS_DIR)) {
    console.error(`[robbo2-export] vault dir missing: ${TRANSCRIPTS_DIR}`)
    return null
  }
  let path = join(TRANSCRIPTS_DIR, `${dateStr} - ${title}.md`)
  if (existsSync(path)) path = join(TRANSCRIPTS_DIR, `${dateStr} - ${title} (${transcriptId}).md`)
  writeFileSync(path, md, 'utf8')

  db.prepare(`UPDATE transcripts SET markdown_path = ? WHERE id = ?`).run(path, transcriptId)
  return path
}
