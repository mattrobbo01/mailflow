import { getDb } from './db'

export interface ThreadSummary {
  account_id: string
  id: string
  subject: string
  snippet: string
  last_ts: number
  message_count: number
  is_unread: number
  label_ids: string
  participants: string
}

export interface ListOptions {
  account?: string          // undefined = unified across accounts
  view: 'inbox' | 'notifications' | 'newsletters' | 'all' | 'sent' | 'starred' | 'snoozed' | 'done'
  showDone?: boolean        // inbox/notifications/newsletters: show done instead of not-done
  limit?: number
  beforeTs?: number         // pagination cursor
}

export function listThreads(opts: ListOptions): ThreadSummary[] {
  const db = getDb()
  const where: string[] = []
  const params: any[] = []

  if (opts.account) {
    where.push(`account_id = ?`)
    params.push(opts.account)
  }
  // Done threads live OUTSIDE the inbox (done archives, like Spark), so the
  // showDone variant filters on done_at + category rather than the INBOX label.
  const inboxOrDone = () => {
    if (opts.showDone) {
      where.push(`done_at IS NOT NULL`)
      where.push(`NOT EXISTS (SELECT 1 FROM json_each(threads.label_ids) WHERE value IN ('TRASH','SPAM'))`)
    } else {
      where.push(`is_inbox = 1`)
      where.push(`done_at IS NULL`)
    }
  }
  switch (opts.view) {
    case 'inbox':
      inboxOrDone()
      where.push(`(category IS NULL OR category = 'people')`)
      where.push(`(snoozed_until IS NULL OR snoozed_until <= unixepoch())`)
      break
    case 'notifications':
      inboxOrDone()
      where.push(`category = 'notifications'`)
      break
    case 'newsletters':
      inboxOrDone()
      where.push(`category = 'newsletters'`)
      break
    case 'done':
      where.push(`done_at IS NOT NULL`)
      break
    case 'sent':
      where.push(`EXISTS (SELECT 1 FROM json_each(threads.label_ids) WHERE json_each.value = 'SENT')`)
      break
    case 'starred':
      where.push(`EXISTS (SELECT 1 FROM json_each(threads.label_ids) WHERE json_each.value = 'STARRED')`)
      break
    case 'snoozed':
      where.push(`snoozed_until > unixepoch()`)
      break
    case 'all':
      break
  }
  if (opts.beforeTs) {
    where.push(`last_ts < ?`)
    params.push(opts.beforeTs)
  }

  const sql = `
    SELECT account_id, id, subject, snippet, last_ts, message_count, is_unread, label_ids, participants
    FROM threads
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${opts.view === 'done' ? 'done_at DESC' : 'last_ts DESC'}
    LIMIT ?`
  params.push(opts.limit ?? 100)
  return db.prepare(sql).all(...params) as ThreadSummary[]
}

export function setThreadDone(account: string, threadId: string, done: boolean) {
  getDb()
    .prepare(`UPDATE threads SET done_at = ? WHERE account_id = ? AND id = ?`)
    .run(done ? Math.floor(Date.now() / 1000) : null, account, threadId)
}

export interface CategoryGroup {
  category: 'notifications' | 'newsletters'
  total: number
  unread: number
  senders: { name: string; count: number }[]
}

/** Spark-style rollup rows: counts + recent senders per non-people category. */
export function categoryGroups(account?: string, showDone = false): CategoryGroup[] {
  const db = getDb()
  const acctFilter = account ? 'AND t.account_id = ?' : ''
  const acctParams = account ? [account] : []
  const doneFilter = showDone
    ? `t.done_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(t.label_ids) WHERE value IN ('TRASH','SPAM'))`
    : `t.is_inbox = 1 AND t.done_at IS NULL`

  const totals = db
    .prepare(
      `SELECT category, COUNT(*) AS total, SUM(is_unread) AS unread
       FROM threads t
       WHERE ${doneFilter}
         AND t.category IN ('notifications','newsletters') ${acctFilter}
       GROUP BY category`
    )
    .all(...acctParams) as { category: string; total: number; unread: number }[]

  const senders = db
    .prepare(
      `SELECT t.category, COALESCE(NULLIF(m.from_name, ''), m.from_email, '?') AS sender,
              COUNT(*) AS n, MAX(t.last_ts) AS recent
       FROM threads t
       JOIN messages m ON m.account_id = t.account_id AND m.thread_id = t.id AND m.ts = t.last_ts
       WHERE ${doneFilter}
         AND t.category IN ('notifications','newsletters') ${acctFilter}
       GROUP BY t.category, sender
       ORDER BY recent DESC`
    )
    .all(...acctParams) as { category: string; sender: string; n: number }[]

  return (['notifications', 'newsletters'] as const).flatMap((c) => {
    const t = totals.find((x) => x.category === c)
    if (!t || t.total === 0) return []
    return [{
      category: c,
      total: t.total,
      unread: t.unread ?? 0,
      senders: senders.filter((s) => s.category === c).slice(0, 5).map((s) => ({ name: s.sender, count: s.n }))
    }]
  })
}

export function getThreadSummary(account: string, threadId: string): ThreadSummary | null {
  return (
    (getDb()
      .prepare(
        `SELECT account_id, id, subject, snippet, last_ts, message_count, is_unread, label_ids, participants
         FROM threads WHERE account_id = ? AND id = ?`
      )
      .get(account, threadId) as ThreadSummary | undefined) ?? null
  )
}

export function getThreadMessages(account: string, threadId: string) {
  return getDb()
    .prepare(
      `SELECT rid, id, account_id, thread_id, from_name, from_email, to_json, cc_json, ts, snippet,
              label_ids, has_attachments, attachments_json, body_html, body_text, body_state,
              message_id_header, references_header, reply_to
       FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY ts`
    )
    .all(account, threadId)
}

// ---------- search query compiler ----------
// Supports: from:x to:x subject:x is:unread is:starred in:inbox has:attachment
//           before:YYYY-MM-DD after:YYYY-MM-DD account:<email>  + free text via FTS5

interface Compiled {
  sql: string
  params: any[]
}

export function compileSearch(query: string): Compiled {
  const where: string[] = []
  const params: any[] = []
  const ftsTerms: string[] = []

  const tokens = query.match(/(?:[a-z]+:(?:"[^"]*"|\S+))|(?:"[^"]*")|\S+/gi) ?? []

  for (const raw of tokens) {
    const m = raw.match(/^([a-z]+):(.*)$/i)
    const unquote = (s: string) => s.replace(/^"|"$/g, '')
    if (m) {
      const key = m[1].toLowerCase()
      const val = unquote(m[2])
      switch (key) {
        case 'from':
          where.push(`(m.from_email LIKE ? OR m.from_name LIKE ?)`)
          params.push(`%${val}%`, `%${val}%`)
          continue
        case 'to':
          where.push(`m.to_json LIKE ?`)
          params.push(`%${val}%`)
          continue
        case 'subject':
          where.push(`t.subject LIKE ?`)
          params.push(`%${val}%`)
          continue
        case 'account':
          where.push(`m.account_id LIKE ?`)
          params.push(`%${val}%`)
          continue
        case 'is':
          if (val === 'unread') where.push(`t.is_unread = 1`)
          else if (val === 'starred')
            where.push(`EXISTS (SELECT 1 FROM json_each(t.label_ids) WHERE json_each.value = 'STARRED')`)
          continue
        case 'in':
          if (val === 'inbox') where.push(`t.is_inbox = 1`)
          else {
            where.push(
              `EXISTS (SELECT 1 FROM labels l WHERE l.account_id = t.account_id AND l.name = ? COLLATE NOCASE
                 AND EXISTS (SELECT 1 FROM json_each(t.label_ids) WHERE json_each.value = l.id))`
            )
            params.push(val)
          }
          continue
        case 'has':
          if (val === 'attachment') where.push(`m.has_attachments = 1`)
          continue
        case 'before':
        case 'after': {
          const ts = Math.floor(Date.parse(val) / 1000)
          if (!Number.isNaN(ts)) {
            where.push(`m.ts ${key === 'before' ? '<' : '>'} ?`)
            params.push(ts)
          }
          continue
        }
      }
    }
    // Free text → FTS. Quote each term to keep FTS5 syntax chars inert; prefix-match the last term.
    ftsTerms.push(`"${unquote(raw).replace(/"/g, '')}"`)
  }

  let joinFts = ''
  if (ftsTerms.length > 0) {
    const last = ftsTerms.length - 1
    ftsTerms[last] = `${ftsTerms[last]}*`
    joinFts = `JOIN messages_fts f ON f.rowid = m.rid AND messages_fts MATCH ?`
    params.unshift(ftsTerms.join(' '))
  }

  const sql = `
    SELECT DISTINCT t.account_id, t.id, t.subject, t.snippet, t.last_ts, t.message_count,
                    t.is_unread, t.label_ids, t.participants
    FROM messages m
    ${joinFts}
    JOIN threads t ON t.account_id = m.account_id AND t.id = m.thread_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.last_ts DESC
    LIMIT 50`
  return { sql, params }
}

export function searchThreads(query: string): ThreadSummary[] {
  if (!query.trim()) return []
  const { sql, params } = compileSearch(query)
  return getDb().prepare(sql).all(...params) as ThreadSummary[]
}
