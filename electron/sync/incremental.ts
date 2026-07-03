import { gmail_v1 } from 'googleapis'
import { getDb, transaction, upsertMessage, upsertThreadShell, refreshThread, deleteMessage } from '../db/db'
import { getGmail, toMessageRow, subjectOf, fetchPool } from './gmail-client'
import { reapplyPending } from './modifier-queue'

/**
 * Incremental sync via users.history.list from the stored historyId watermark.
 * Applies adds/deletes/label-changes, refreshes affected thread rollups, advances
 * the watermark. On a 404 (historyId expired) the caller should trigger re-backfill.
 */
export interface NewMailNotice {
  account: string
  threadId: string
  fromName: string | null
  fromEmail: string | null
  subject: string
  snippet: string | null
  labels: string[]
  ts: number
}

export async function syncAccount(email: string): Promise<{ changed: number; newMail: NewMailNotice[] }> {
  const db = getDb()
  const account = db.prepare(`SELECT history_id, backfill_state FROM accounts WHERE id = ?`).get(email) as any
  if (!account?.history_id) return { changed: 0, newMail: [] }

  const gmail = getGmail(email)
  const touchedThreads = new Set<string>()
  const toFetch = new Set<string>()
  const addedIds = new Set<string>()
  let newHistoryId: string | null = null
  let pageToken: string | undefined

  try {
    do {
      const res = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: account.history_id,
        maxResults: 500,
        pageToken
      })
      newHistoryId = res.data.historyId ? String(res.data.historyId) : newHistoryId

      for (const h of res.data.history ?? []) {
        for (const added of h.messagesAdded ?? []) {
          if (added.message?.id) {
            toFetch.add(added.message.id)
            addedIds.add(added.message.id)
          }
        }
        for (const del of h.messagesDeleted ?? []) {
          const m = del.message
          if (!m?.id) continue
          toFetch.delete(m.id)
          deleteMessage(email, m.id)
          if (m.threadId) touchedThreads.add(m.threadId)
        }
        for (const change of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) {
          const m = change.message
          if (!m?.id) continue
          // labelIds on the history record's message reflect the post-change state.
          if (m.labelIds) {
            db.prepare(`UPDATE messages SET label_ids = ? WHERE account_id = ? AND id = ?`).run(
              JSON.stringify(m.labelIds), email, m.id
            )
          } else {
            toFetch.add(m.id)
          }
          if (m.threadId) touchedThreads.add(m.threadId)
        }
      }
      pageToken = res.data.nextPageToken ?? undefined
    } while (pageToken)
  } catch (e: any) {
    const status = e?.code ?? e?.response?.status
    if (status === 404) {
      // History expired — flag for re-backfill of the recent window.
      db.prepare(`UPDATE accounts SET backfill_state = 'pending', history_id = NULL WHERE id = ?`).run(email)
      db.prepare(`DELETE FROM meta WHERE key LIKE ?`).run(`backfill:${email}:%`)
      return { changed: 0, newMail: [] }
    }
    throw e
  }

  const fetched: gmail_v1.Schema$Message[] = []
  await fetchPool(
    [...toFetch],
    8,
    async (id) => {
      try {
        return (await gmail.users.messages.get({ userId: 'me', id, format: 'full' })).data
      } catch (e: any) {
        const status = e?.code ?? e?.response?.status
        if (status === 404) return null // deleted between history read and fetch
        throw e
      }
    },
    (msg) => {
      if (msg) fetched.push(msg)
    }
  )

  const selfEmails = new Set(
    (db.prepare(`SELECT lower(id) AS id FROM accounts`).all() as { id: string }[]).map((r) => r.id)
  )
  const newMail: NewMailNotice[] = []

  transaction(() => {
    for (const msg of fetched) {
      upsertThreadShell(email, msg.threadId!, subjectOf(msg))
      const row = toMessageRow(email, msg, true)
      upsertMessage(row)
      touchedThreads.add(msg.threadId!)
      const labels: string[] = msg.labelIds ?? []
      if (
        addedIds.has(msg.id!) &&
        labels.includes('INBOX') &&
        labels.includes('UNREAD') &&
        row.from_email && !selfEmails.has(row.from_email.toLowerCase())
      ) {
        newMail.push({
          account: email,
          threadId: msg.threadId!,
          fromName: row.from_name,
          fromEmail: row.from_email,
          subject: subjectOf(msg),
          snippet: row.snippet,
          labels,
          ts: row.ts
        })
      }
    }
    for (const t of touchedThreads) {
      refreshThread(email, t)
      // Server echo must not stomp optimistic local state for still-pending actions.
      reapplyPending(email, t)
    }
    if (newHistoryId) {
      getDb().prepare(`UPDATE accounts SET history_id = ? WHERE id = ?`).run(newHistoryId, email)
    }
  })

  return { changed: fetched.length + touchedThreads.size, newMail }
}
