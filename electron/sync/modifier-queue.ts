import { getDb, transaction } from '../db/db'
import { getGmail } from './gmail-client'

/**
 * Superhuman's modifier-queue pattern:
 *  - modify(): mutate local SQLite (and therefore the UI) synchronously
 *  - persist(): drain the actions table to Gmail, serialized per thread,
 *    idempotent, with exponential backoff.
 */

export type LabelChange = { add: string[]; remove: string[] }

// ---------- modify(): local, instant ----------

export function applyLocalLabelChange(account: string, threadId: string, change: LabelChange) {
  const db = getDb()
  transaction(() => {
    const msgs = db
      .prepare(`SELECT rid, label_ids FROM messages WHERE account_id = ? AND thread_id = ?`)
      .all(account, threadId) as { rid: number; label_ids: string }[]
    for (const m of msgs) {
      const labels = new Set<string>(JSON.parse(m.label_ids))
      for (const l of change.add) labels.add(l)
      for (const l of change.remove) labels.delete(l)
      db.prepare(`UPDATE messages SET label_ids = ? WHERE rid = ?`).run(JSON.stringify([...labels]), m.rid)
    }
    const t = db
      .prepare(`SELECT label_ids FROM threads WHERE account_id = ? AND id = ?`)
      .get(account, threadId) as { label_ids: string } | undefined
    if (t) {
      const labels = new Set<string>(JSON.parse(t.label_ids))
      for (const l of change.add) labels.add(l)
      for (const l of change.remove) labels.delete(l)
      db.prepare(
        `UPDATE threads SET label_ids = ?, is_unread = ?, is_inbox = ? WHERE account_id = ? AND id = ?`
      ).run(
        JSON.stringify([...labels]),
        labels.has('UNREAD') ? 1 : 0,
        labels.has('INBOX') ? 1 : 0,
        account,
        threadId
      )
    }
  })
}

function enqueue(account: string, threadId: string | null, type: string, payload: unknown, notBefore = 0): number {
  const res = getDb()
    .prepare(
      `INSERT INTO actions (account_id, thread_id, type, payload, not_before) VALUES (?, ?, ?, ?, ?)`
    )
    .run(account, threadId, type, JSON.stringify(payload), notBefore)
  setTimeout(drain, 10)
  return Number(res.lastInsertRowid)
}

// ---------- public actions ----------

export function modifyThreadLabels(account: string, threadId: string, change: LabelChange) {
  applyLocalLabelChange(account, threadId, change)
  enqueue(account, threadId, 'modifyLabels', change)
}

export const archiveThread = (a: string, t: string) => modifyThreadLabels(a, t, { add: [], remove: ['INBOX'] })
export const trashThread = (a: string, t: string) => {
  applyLocalLabelChange(a, t, { add: ['TRASH'], remove: ['INBOX'] })
  enqueue(a, t, 'trash', {})
}
export const markRead = (a: string, t: string) => modifyThreadLabels(a, t, { add: [], remove: ['UNREAD'] })
export const markUnread = (a: string, t: string) => modifyThreadLabels(a, t, { add: ['UNREAD'], remove: [] })
export const toggleStar = (a: string, t: string, starred: boolean) =>
  modifyThreadLabels(a, t, starred ? { add: ['STARRED'], remove: [] } : { add: [], remove: ['STARRED'] })

export function snoozeThread(account: string, threadId: string, until: number) {
  const db = getDb()
  db.prepare(`UPDATE threads SET snoozed_until = ? WHERE account_id = ? AND id = ?`).run(until, account, threadId)
  modifyThreadLabels(account, threadId, { add: [], remove: ['INBOX'] })
  db.prepare(
    `INSERT INTO scheduled_jobs (account_id, kind, send_at, thread_id) VALUES (?, 'unsnooze', ?, ?)`
  ).run(account, until, threadId)
}

/** Queue a send with an undo window. Returns the action id (cancel with cancelAction). */
export function queueSend(account: string, raw: string, threadId: string | null, undoSeconds = 10): number {
  const notBefore = Math.floor(Date.now() / 1000) + undoSeconds
  return enqueue(account, threadId, 'send', { raw, threadId }, notBefore)
}

export function cancelAction(actionId: number): boolean {
  const res = getDb().prepare(`DELETE FROM actions WHERE id = ? AND state = 'pending'`).run(actionId)
  return res.changes > 0
}

/** Re-apply local effects of pending actions after server echo (anti-stomp). */
export function reapplyPending(account: string, threadId: string) {
  const rows = getDb()
    .prepare(
      `SELECT type, payload FROM actions
       WHERE account_id = ? AND thread_id = ? AND state IN ('pending','inflight')`
    )
    .all(account, threadId) as { type: string; payload: string }[]
  for (const r of rows) {
    if (r.type === 'modifyLabels') applyLocalLabelChange(account, threadId, JSON.parse(r.payload))
    if (r.type === 'trash') applyLocalLabelChange(account, threadId, { add: ['TRASH'], remove: ['INBOX'] })
  }
}

// ---------- persist(): drain to Gmail ----------

let draining = false

export async function drain(): Promise<void> {
  if (draining) return
  draining = true
  const db = getDb()
  try {
    for (;;) {
      const now = Math.floor(Date.now() / 1000)
      // One action per thread at a time, oldest first; null-thread actions run freely.
      const next = db
        .prepare(
          `SELECT * FROM actions a
           WHERE a.state = 'pending' AND a.not_before <= ?
             AND NOT EXISTS (
               SELECT 1 FROM actions b
               WHERE b.state = 'inflight' AND b.account_id = a.account_id
                 AND b.thread_id IS NOT NULL AND b.thread_id = a.thread_id)
           ORDER BY a.id LIMIT 1`
        )
        .get(now) as any
      if (!next) break

      db.prepare(`UPDATE actions SET state = 'inflight' WHERE id = ?`).run(next.id)
      try {
        await execute(next)
        db.prepare(`UPDATE actions SET state = 'done' WHERE id = ?`).run(next.id)
      } catch (e: any) {
        const attempts = next.attempts + 1
        const backoff = Math.min(3600, 15 * 2 ** attempts)
        const failed = attempts >= 8
        db.prepare(
          `UPDATE actions SET state = ?, attempts = ?, not_before = ?, last_error = ? WHERE id = ?`
        ).run(failed ? 'failed' : 'pending', attempts, now + backoff, String(e?.message ?? e), next.id)
        if (failed) console.error(`[actions] permanently failed #${next.id} ${next.type}: ${e?.message}`)
      }
    }
  } finally {
    draining = false
  }
}

async function execute(action: any): Promise<void> {
  const gmail = getGmail(action.account_id)
  const payload = JSON.parse(action.payload)
  switch (action.type) {
    case 'modifyLabels':
      await gmail.users.threads.modify({
        userId: 'me',
        id: action.thread_id,
        requestBody: { addLabelIds: payload.add, removeLabelIds: payload.remove }
      })
      break
    case 'trash':
      await gmail.users.threads.trash({ userId: 'me', id: action.thread_id })
      break
    case 'send':
      await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: payload.raw, threadId: payload.threadId ?? undefined }
      })
      break
    default:
      throw new Error(`Unknown action type ${action.type}`)
  }
}

export function startDrainLoop() {
  setInterval(drain, 3000)
}
