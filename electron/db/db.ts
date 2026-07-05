import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import schema from './schema.sql?raw'

export type Recipient = { name: string; email: string }

let db: Database.Database | null = null

export function dataDir(): string {
  // app is undefined when running headless via `mailflow --runner` before app.ready;
  // both paths resolve to ~/Library/Application Support/MailFlow on macOS.
  const base = app?.getPath?.('appData') ?? join(process.env.HOME!, 'Library', 'Application Support')
  const dir = join(base, 'MailFlow')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getDb(): Database.Database {
  if (db) return db
  db = new Database(join(dataDir(), 'mailflow.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.exec(schema)
  migrate(db)
  return db
}

function migrate(d: Database.Database) {
  try {
    d.exec(`ALTER TABLE threads ADD COLUMN category TEXT`)
  } catch {
    /* column exists */
  }
  try {
    d.exec(`ALTER TABLE threads ADD COLUMN done_at INTEGER`)
  } catch {
    /* column exists */
  }
  // One-time import: archived conversations (Spark's "done" archives in Gmail) become done.
  // Sent-only threads (no message from anyone else) are excluded — they belong in Sent, not Done.
  const doneImported = d.prepare(`SELECT value FROM meta WHERE key = 'done:imported'`).get()
  if (!doneImported) {
    d.exec(`
      UPDATE threads SET done_at = last_ts
      WHERE done_at IS NULL AND is_inbox = 0 AND snoozed_until IS NULL
        AND NOT EXISTS (SELECT 1 FROM json_each(threads.label_ids) WHERE value IN ('TRASH','SPAM','DRAFT'))
        AND EXISTS (SELECT 1 FROM messages m
                    WHERE m.account_id = threads.account_id AND m.thread_id = threads.id
                      AND lower(COALESCE(m.from_email,'')) NOT IN (SELECT lower(id) FROM accounts));
      INSERT INTO meta (key, value) VALUES ('done:imported','1');
    `)
  }

  d.exec(`CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    to_field TEXT DEFAULT '',
    cc_field TEXT DEFAULT '',
    bcc_field TEXT DEFAULT '',
    subject TEXT DEFAULT '',
    body TEXT DEFAULT '',
    quoted TEXT,
    thread_id TEXT,
    in_reply_to TEXT,
    references_header TEXT,
    attachments_json TEXT DEFAULT '[]',
    updated_at INTEGER DEFAULT (unixepoch())
  )`)

  // Auto-draft pipeline: job queue + AI flags on drafts. ai_pristine means the body
  // is untouched machine output — the only kind the worker is allowed to clean up.
  d.exec(`CREATE TABLE IF NOT EXISTS autodraft_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    state TEXT DEFAULT 'pending',    -- pending | running | done | skipped | superseded | failed
    guidance TEXT,                   -- steer text on regenerations (skips triage)
    triage_reason TEXT,
    draft_id INTEGER,
    attempts INTEGER DEFAULT 0,
    last_error TEXT,
    created_at INTEGER DEFAULT (unixepoch()),
    processed_at INTEGER
  )`)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_autodraft_pending ON autodraft_jobs(state, created_at)`)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_autodraft_thread ON autodraft_jobs(account_id, thread_id, created_at DESC)`)
  try {
    d.exec(`ALTER TABLE drafts ADD COLUMN ai_generated INTEGER DEFAULT 0`)
  } catch {
    /* column exists */
  }
  try {
    d.exec(`ALTER TABLE drafts ADD COLUMN ai_pristine INTEGER DEFAULT 0`)
  } catch {
    /* column exists */
  }

  // One-time cleanup: snippets stored before entity decoding was added.
  const decoded = d.prepare(`SELECT value FROM meta WHERE key = 'snippets:decoded'`).get()
  if (!decoded) {
    for (const table of ['messages', 'threads']) {
      d.exec(`
        UPDATE ${table} SET snippet =
          replace(replace(replace(replace(replace(replace(snippet,
            '&#39;', ''''), '&quot;', '"'), '&lt;', '<'), '&gt;', '>'), '&nbsp;', ' '), '&amp;', '&')
        WHERE snippet LIKE '%&%';
      `)
    }
    d.exec(`INSERT INTO meta (key, value) VALUES ('snippets:decoded','1')`)
  }

  // One-time backfill from Gmail's own category labels.
  const done = d.prepare(`SELECT value FROM meta WHERE key = 'category:backfilled'`).get()
  if (!done) {
    d.exec(`
      UPDATE threads SET category = CASE
        WHEN EXISTS (SELECT 1 FROM json_each(threads.label_ids)
                     WHERE value IN ('CATEGORY_PROMOTIONS','CATEGORY_FORUMS')) THEN 'newsletters'
        WHEN EXISTS (SELECT 1 FROM json_each(threads.label_ids)
                     WHERE value IN ('CATEGORY_UPDATES','CATEGORY_SOCIAL')) THEN 'notifications'
        ELSE 'people' END
      WHERE category IS NULL;
      INSERT INTO meta (key, value) VALUES ('category:backfilled','1');
    `)
  }
}

const NOREPLY_RE = /(^|[.-])(no-?reply|do-?not-?reply|notifications?|alerts?|jobalerts?|mailer|updates)@|@(email|mail|news|newsletter|notify|jobs)\./i

/**
 * Spark-style bucket for a thread. Gmail's server-side category labels do the
 * heavy lifting; a sender heuristic catches noreply machines Gmail left in Personal.
 */
export function classifyThread(labels: Set<string>, fromEmails: string[]): 'people' | 'notifications' | 'newsletters' {
  if (labels.has('CATEGORY_PROMOTIONS') || labels.has('CATEGORY_FORUMS')) return 'newsletters'
  if (labels.has('CATEGORY_UPDATES') || labels.has('CATEGORY_SOCIAL')) return 'notifications'
  const external = fromEmails.filter(Boolean)
  if (external.length > 0 && external.every((e) => NOREPLY_RE.test(e))) return 'notifications'
  return 'people'
}

// ---------- accounts ----------

export function upsertAccount(id: string, displayName?: string) {
  getDb()
    .prepare(
      `INSERT INTO accounts (id, display_name) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET display_name = COALESCE(excluded.display_name, display_name)`
    )
    .run(id, displayName ?? null)
}

export function listAccounts() {
  return getDb().prepare(`SELECT * FROM accounts ORDER BY created_at`).all() as any[]
}

// ---------- messages / threads ----------

export interface MessageRow {
  account_id: string
  id: string
  thread_id: string
  from_name: string | null
  from_email: string | null
  to_json: string
  cc_json: string
  reply_to: string | null
  message_id_header: string | null
  references_header: string | null
  ts: number
  snippet: string | null
  label_ids: string
  has_attachments: number
  attachments_json: string
  body_html: string | null
  body_text: string | null
  body_state: 'none' | 'full'
}

const upsertMessageStmt = () =>
  getDb().prepare(`
    INSERT INTO messages (account_id, id, thread_id, from_name, from_email, to_json, cc_json,
      reply_to, message_id_header, references_header, ts, snippet, label_ids,
      has_attachments, attachments_json, body_html, body_text, body_state)
    VALUES (@account_id, @id, @thread_id, @from_name, @from_email, @to_json, @cc_json,
      @reply_to, @message_id_header, @references_header, @ts, @snippet, @label_ids,
      @has_attachments, @attachments_json, @body_html, @body_text, @body_state)
    ON CONFLICT(account_id, id) DO UPDATE SET
      thread_id = excluded.thread_id,
      label_ids = excluded.label_ids,
      snippet = COALESCE(excluded.snippet, snippet),
      body_html = CASE WHEN excluded.body_state = 'full' THEN excluded.body_html ELSE body_html END,
      body_text = CASE WHEN excluded.body_state = 'full' THEN excluded.body_text ELSE body_text END,
      attachments_json = CASE WHEN excluded.body_state = 'full' THEN excluded.attachments_json ELSE attachments_json END,
      has_attachments = CASE WHEN excluded.body_state = 'full' THEN excluded.has_attachments ELSE has_attachments END,
      body_state = CASE WHEN excluded.body_state = 'full' THEN 'full' ELSE body_state END
  `)

export function upsertMessage(m: MessageRow) {
  const d = getDb()
  upsertMessageStmt().run(m)
  const { rid } = d
    .prepare(`SELECT rid FROM messages WHERE account_id = ? AND id = ?`)
    .get(m.account_id, m.id) as { rid: number }

  // Keep FTS in sync: delete-then-insert on every upsert that carries content.
  d.prepare(`DELETE FROM messages_fts WHERE rowid = ?`).run(rid)
  const to = (JSON.parse(m.to_json) as Recipient[]).map((r) => `${r.name} ${r.email}`).join(' ')
  const cc = (JSON.parse(m.cc_json) as Recipient[]).map((r) => `${r.name} ${r.email}`).join(' ')
  d.prepare(`INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?, ?, ?, ?, ?)`).run(
    rid,
    threadSubject(m.account_id, m.thread_id) ?? '',
    `${m.from_name ?? ''} ${m.from_email ?? ''}`,
    `${to} ${cc}`,
    m.body_text ?? m.snippet ?? ''
  )
}

function threadSubject(accountId: string, threadId: string): string | null {
  const row = getDb()
    .prepare(`SELECT subject FROM threads WHERE account_id = ? AND id = ?`)
    .get(accountId, threadId) as { subject: string } | undefined
  return row?.subject ?? null
}

export function deleteMessage(accountId: string, id: string) {
  const d = getDb()
  const row = d.prepare(`SELECT rid FROM messages WHERE account_id = ? AND id = ?`).get(accountId, id) as
    | { rid: number }
    | undefined
  if (!row) return
  d.prepare(`DELETE FROM messages_fts WHERE rowid = ?`).run(row.rid)
  d.prepare(`DELETE FROM messages WHERE rid = ?`).run(row.rid)
}

/** Recompute thread rollup from its messages. Call after message upserts/deletes. */
export function refreshThread(accountId: string, threadId: string) {
  const d = getDb()
  const msgs = d
    .prepare(
      `SELECT from_name, from_email, to_json, ts, snippet, label_ids FROM messages
       WHERE account_id = ? AND thread_id = ? ORDER BY ts`
    )
    .all(accountId, threadId) as any[]
  if (msgs.length === 0) {
    d.prepare(`DELETE FROM threads WHERE account_id = ? AND id = ?`).run(accountId, threadId)
    return
  }
  const labels = new Set<string>()
  const participants = new Map<string, Recipient>()
  const fromEmails: string[] = []
  for (const m of msgs) {
    for (const l of JSON.parse(m.label_ids)) labels.add(l)
    if (m.from_email) {
      fromEmails.push(m.from_email)
      participants.set(m.from_email.toLowerCase(), { name: m.from_name ?? '', email: m.from_email })
    }
    for (const r of JSON.parse(m.to_json) as Recipient[]) {
      if (r.email) participants.set(r.email.toLowerCase(), r)
    }
  }
  const last = msgs[msgs.length - 1]
  const existing = d
    .prepare(`SELECT done_at, snoozed_until FROM threads WHERE account_id = ? AND id = ?`)
    .get(accountId, threadId) as { done_at: number | null; snoozed_until: number | null } | undefined

  // Done mirrors archive (Spark semantics): a thread that leaves the inbox — and isn't
  // snoozed, trashed, spam, or purely outgoing — is done. Returning to the inbox
  // (new reply, un-archive) clears it, so replies to done threads resurface.
  const selfEmails = new Set(
    (d.prepare(`SELECT lower(id) AS id FROM accounts`).all() as { id: string }[]).map((r) => r.id)
  )
  const hasExternal = fromEmails.some((e) => !selfEmails.has(e.toLowerCase()))
  const inInbox = labels.has('INBOX')
  const snoozed = (existing?.snoozed_until ?? 0) > Date.now() / 1000
  let doneAt = existing?.done_at ?? null
  if (inInbox) doneAt = null
  else if (doneAt === null && !snoozed && hasExternal && !labels.has('TRASH') && !labels.has('SPAM') && !labels.has('DRAFT')) {
    doneAt = last.ts
  }

  d.prepare(
    `UPDATE threads SET snippet = ?, last_ts = ?, message_count = ?, label_ids = ?,
       is_unread = ?, is_inbox = ?, participants = ?, category = ?, done_at = ?
     WHERE account_id = ? AND id = ?`
  ).run(
    last.snippet,
    last.ts,
    msgs.length,
    JSON.stringify([...labels]),
    labels.has('UNREAD') ? 1 : 0,
    inInbox ? 1 : 0,
    JSON.stringify([...participants.values()]),
    classifyThread(labels, fromEmails),
    doneAt,
    accountId,
    threadId
  )
}

export function upsertThreadShell(accountId: string, threadId: string, subject: string | null) {
  getDb()
    .prepare(
      `INSERT INTO threads (account_id, id, subject) VALUES (?, ?, ?)
       ON CONFLICT(account_id, id) DO UPDATE SET subject = COALESCE(excluded.subject, subject)`
    )
    .run(accountId, threadId, subject)
}

export function transaction<T>(fn: () => T): T {
  return getDb().transaction(fn)()
}
