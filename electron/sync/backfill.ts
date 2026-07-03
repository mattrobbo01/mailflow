import { gmail_v1 } from 'googleapis'
import { getDb, transaction, upsertMessage, upsertThreadShell, refreshThread } from '../db/db'
import { getGmail, toMessageRow, subjectOf, fetchPool } from './gmail-client'

export type BackfillProgress = {
  account: string
  phase: 'recent' | 'archive' | 'done'
  fetched: number
}

/**
 * Two-pass backfill:
 *   pass 1 ("recent"):  q=newer_than:1y  → format=full  (bodies, attachments metadata)
 *   pass 2 ("archive"): q=older_than:1y  → format=metadata (headers only; bodies lazy-load on open)
 * Restartable: page tokens persisted per pass in the meta table.
 */
export async function backfillAccount(
  email: string,
  onProgress?: (p: BackfillProgress) => void
): Promise<void> {
  const db = getDb()
  const gmail = getGmail(email)

  // Watermark FIRST: changes that arrive during backfill are replayed by incremental sync.
  const account = db.prepare(`SELECT history_id, backfill_state FROM accounts WHERE id = ?`).get(email) as any
  if (account?.backfill_state === 'done') return
  if (!account?.history_id) {
    const profile = await gmail.users.getProfile({ userId: 'me' })
    db.prepare(`UPDATE accounts SET history_id = ?, backfill_state = 'running' WHERE id = ?`).run(
      String(profile.data.historyId), email
    )
  }

  await syncLabels(email, gmail)

  let fetched = countMessages(email)
  for (const pass of ['recent', 'archive'] as const) {
    const tokenKey = `backfill:${email}:${pass}:pageToken`
    const doneKey = `backfill:${email}:${pass}:done`
    if (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(doneKey)) continue

    let pageToken = (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(tokenKey) as any)?.value as
      | string
      | undefined

    do {
      const list = await gmail.users.messages.list({
        userId: 'me',
        q: pass === 'recent' ? 'newer_than:1y' : 'older_than:1y',
        includeSpamTrash: false,
        maxResults: 100,
        pageToken
      })
      const ids = (list.data.messages ?? []).map((m) => m.id!)
      const results: gmail_v1.Schema$Message[] = []
      await fetchPool(
        ids,
        12,
        async (id) =>
          (await gmail.users.messages.get({
            userId: 'me',
            id,
            format: pass === 'recent' ? 'full' : 'metadata',
            metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References', 'Reply-To', 'Date']
          })).data,
        (msg) => results.push(msg)
      )

      transaction(() => {
        const touched = new Set<string>()
        for (const msg of results) {
          upsertThreadShell(email, msg.threadId!, subjectOf(msg))
          upsertMessage(toMessageRow(email, msg, pass === 'recent'))
          touched.add(msg.threadId!)
        }
        for (const t of touched) refreshThread(email, t)
        pageToken = list.data.nextPageToken ?? undefined
        db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(tokenKey, pageToken ?? '')
      })

      fetched += results.length
      onProgress?.({ account: email, phase: pass, fetched })
    } while (pageToken)

    db.prepare(`INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING`).run(doneKey)
  }

  db.prepare(`UPDATE accounts SET backfill_state = 'done' WHERE id = ?`).run(email)
  onProgress?.({ account: email, phase: 'done', fetched })
}

async function syncLabels(email: string, gmail: gmail_v1.Gmail) {
  const res = await gmail.users.labels.list({ userId: 'me' })
  const db = getDb()
  const stmt = db.prepare(
    `INSERT INTO labels (account_id, id, name, type, color) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, id) DO UPDATE SET name = excluded.name, color = excluded.color`
  )
  transaction(() => {
    for (const l of res.data.labels ?? []) {
      stmt.run(email, l.id, l.name, l.type, l.color?.backgroundColor ?? null)
    }
  })
}

function countMessages(email: string): number {
  return (
    (getDb().prepare(`SELECT COUNT(*) AS n FROM messages WHERE account_id = ?`).get(email) as any)?.n ?? 0
  )
}

/** Lazy body hydration for archive messages opened in the UI. */
export async function hydrateMessageBody(email: string, messageId: string): Promise<void> {
  const db = getDb()
  const row = db
    .prepare(`SELECT body_state, thread_id FROM messages WHERE account_id = ? AND id = ?`)
    .get(email, messageId) as any
  if (!row || row.body_state === 'full') return
  const gmail = getGmail(email)
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
  upsertMessage(toMessageRow(email, msg.data, true))
  refreshThread(email, row.thread_id)
}
