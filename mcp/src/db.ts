// Read-only access to MailFlow's live SQLite store. This process never writes,
// and only ever queries the allowlisted tables below — nothing that could carry
// credential material (OAuth tokens live in files, HubSpot key in hubspot.json,
// but hs_* / drafts / autodraft tables are excluded too, by allowlist).
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const ALLOWED_TABLES = new Set([
  'accounts',
  'threads',
  'messages',
  'messages_fts',
  'labels',
  'people',
  'transcripts',
  'transcript_segments',
  'transcript_attendees',
  'transcript_insights'
])

export function dbPath(): string {
  return (
    process.env.MAILFLOW_DB ??
    join(homedir(), 'Library', 'Application Support', 'MailFlow', 'mailflow.db')
  )
}

let db: DatabaseSync | null = null

export function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(dbPath(), { readOnly: true })
    // Live DB (app may be writing via WAL); give readers patience instead of SQLITE_BUSY.
    db.exec('PRAGMA busy_timeout = 5000')
  }
  return db
}

/** Guard: every SQL string we run must reference only allowlisted tables. */
export function assertAllowed(sql: string): void {
  const refs = sql.match(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi) ?? []
  for (const ref of refs) {
    const table = ref.replace(/^(FROM|JOIN)\s+/i, '').toLowerCase()
    if (table === 'json_each') continue
    if (!ALLOWED_TABLES.has(table)) {
      throw new Error(`query touches non-allowlisted table: ${table}`)
    }
  }
}

export function all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
  assertAllowed(sql)
  return getDb().prepare(sql).all(...(params as never[])) as T[]
}

export function get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
  assertAllowed(sql)
  return getDb().prepare(sql).get(...(params as never[])) as T | undefined
}

/** Newest mtime across db/-wal/-shm — proxy for "when did MailFlow last write anything". */
export function dbLastModified(): number {
  const base = dbPath()
  let newest = 0
  for (const p of [base, `${base}-wal`, `${base}-shm`]) {
    try {
      newest = Math.max(newest, statSync(p).mtimeMs)
    } catch {
      /* wal/shm may not exist */
    }
  }
  return Math.floor(newest / 1000)
}

/** Map account selector (work | personal | all | literal email) to account ids. */
export function resolveAccounts(selector?: string): string[] {
  const rows = all<{ id: string }>('SELECT id FROM accounts ORDER BY created_at')
  const ids = rows.map((r) => r.id)
  const sel = (selector ?? 'all').toLowerCase()
  if (sel === 'all' || sel === '') return ids
  if (sel === 'personal') return ids.filter((id) => id.endsWith('@gmail.com'))
  if (sel === 'work') return ids.filter((id) => !id.endsWith('@gmail.com'))
  const exact = ids.filter((id) => id.toLowerCase() === sel)
  if (exact.length) return exact
  throw new Error(
    `unknown account "${selector}" — use work, personal, all, or one of: ${ids.join(', ')}`
  )
}
