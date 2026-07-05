import { getDb } from '../db/db'
import { broadcast } from '../broadcast'
import { loadAutodraftConfig } from './config'
import { getEngine } from './engine'
import {
  buildDraftPrompt, buildTriagePrompt, cleanDraftBody, getTriggerMessage, parseTriageVerdict, TriggerMessage
} from './prompts'

/**
 * Auto-draft worker: sweep → triage → agentic draft → local draft row.
 * Candidate discovery is a single SQL sweep (not event plumbing), so live mail,
 * wake-from-sleep catch-up, and headless runner catch-up share one code path.
 * Jobs are claimed atomically, so the app and the launchd runner can't both
 * process the same one.
 */

const SINCE_KEY = 'autodraft:since'
const AUTH_FAIL_KEY = 'autodraft:authFailedAt'
const SWEEP_WINDOW_S = 24 * 3600
const AUTH_BACKOFF_S = 30 * 60

interface JobRow {
  id: number
  account_id: string
  thread_id: string
  message_id: string
  state: string
  guidance: string | null
  draft_id: number | null
  attempts: number
}

function getMeta(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined
  return row?.value ?? null
}

function setMeta(key: string, value: string) {
  getDb()
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value)
}

function notify(account: string, threadId: string, state: string) {
  try {
    broadcast('autodraft:updated', { account, threadId, state })
  } catch {
    /* headless runner has no windows */
  }
}

// ---------- candidate sweep ----------

/**
 * Enqueue a job for every recent inbound people-category message that is the
 * latest message on a live inbox thread and has no job yet. The watermark set
 * on first run keeps the historical backlog out.
 */
function sweep() {
  const db = getDb()
  if (!getMeta(SINCE_KEY)) setMeta(SINCE_KEY, String(Math.floor(Date.now() / 1000)))
  const since = Math.max(Number(getMeta(SINCE_KEY)), Math.floor(Date.now() / 1000) - SWEEP_WINDOW_S)

  db.prepare(
    `INSERT INTO autodraft_jobs (account_id, thread_id, message_id)
     SELECT m.account_id, m.thread_id, m.id
     FROM messages m
     JOIN threads t ON t.account_id = m.account_id AND t.id = m.thread_id
     WHERE m.ts > ?
       AND m.ts = t.last_ts
       AND t.is_inbox = 1 AND t.done_at IS NULL
       AND (t.category IS NULL OR t.category = 'people')
       AND (t.snoozed_until IS NULL OR t.snoozed_until <= unixepoch())
       AND m.from_email IS NOT NULL
       AND lower(m.from_email) NOT IN (SELECT lower(id) FROM accounts)
       AND m.body_state = 'full'
       AND NOT EXISTS (
         SELECT 1 FROM autodraft_jobs j
         WHERE j.account_id = m.account_id AND j.thread_id = m.thread_id AND j.message_id = m.id
       )`
  ).run(since)
}

/**
 * Pristine AI drafts self-dismiss when their thread is done/trashed or Matt has
 * since replied. Anything Matt has touched (ai_pristine = 0) is his to delete.
 */
function cleanupStaleDrafts() {
  getDb().exec(`
    DELETE FROM drafts WHERE ai_generated = 1 AND ai_pristine = 1 AND id IN (
      SELECT d.id FROM drafts d
      JOIN threads t ON t.account_id = d.account AND t.id = d.thread_id
      LEFT JOIN messages lm ON lm.account_id = t.account_id AND lm.thread_id = t.id AND lm.ts = t.last_ts
      WHERE t.done_at IS NOT NULL
         OR EXISTS (SELECT 1 FROM json_each(t.label_ids) WHERE value IN ('TRASH','SPAM'))
         OR lower(COALESCE(lm.from_email, '')) IN (SELECT lower(id) FROM accounts)
    )
  `)
}

// ---------- job processing ----------

function threadSubject(account: string, threadId: string): string {
  const row = getDb().prepare(`SELECT subject FROM threads WHERE account_id = ? AND id = ?`).get(account, threadId) as
    | { subject: string | null }
    | undefined
  return row?.subject ?? ''
}

/**
 * Is this job still worth acting on? Regenerations (explicit user request)
 * only require the thread to still exist; automatic jobs bail if the thread
 * closed or the trigger is no longer the latest message (Matt replied, or a
 * newer inbound message has its own job).
 */
function stillValid(job: JobRow): { ok: boolean; reason?: string } {
  const db = getDb()
  const thread = db
    .prepare(`SELECT done_at, label_ids FROM threads WHERE account_id = ? AND id = ?`)
    .get(job.account_id, job.thread_id) as { done_at: number | null; label_ids: string } | undefined
  if (!thread) return { ok: false, reason: 'thread gone' }
  // guidance non-NULL (even '') marks an explicit regeneration — user's call.
  if (job.guidance !== null) return { ok: true }

  if (thread.done_at !== null) return { ok: false, reason: 'thread marked done' }
  try {
    const labels = JSON.parse(thread.label_ids) as string[]
    if (labels.includes('TRASH') || labels.includes('SPAM')) return { ok: false, reason: 'thread trashed' }
  } catch {
    /* unparseable labels — proceed */
  }
  const last = db
    .prepare(`SELECT id FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY ts DESC LIMIT 1`)
    .get(job.account_id, job.thread_id) as { id: string } | undefined
  if (last?.id !== job.message_id) return { ok: false, reason: 'no longer the latest message' }
  return { ok: true }
}

function finishJob(job: JobRow, state: string, fields: { triage_reason?: string; draft_id?: number | null; last_error?: string }) {
  getDb()
    .prepare(
      `UPDATE autodraft_jobs
       SET state = ?, triage_reason = COALESCE(?, triage_reason), draft_id = COALESCE(?, draft_id),
           last_error = ?, processed_at = unixepoch()
       WHERE id = ?`
    )
    .run(state, fields.triage_reason ?? null, fields.draft_id ?? null, fields.last_error ?? null, job.id)
  notify(job.account_id, job.thread_id, state)
}

/** Reply seed mirroring the composer's replySeed(): sender only, Re: subject, thread headers. */
function upsertDraft(job: JobRow, trigger: TriggerMessage, subject: string, body: string): number {
  const db = getDb()
  const to = trigger.reply_to || trigger.from_email || ''
  const reSubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`

  const existing =
    (job.draft_id
      ? (db.prepare(`SELECT id FROM drafts WHERE id = ?`).get(job.draft_id) as { id: number } | undefined)
      : undefined) ??
    (db
      .prepare(`SELECT id FROM drafts WHERE account = ? AND thread_id = ? AND ai_generated = 1`)
      .get(job.account_id, job.thread_id) as { id: number } | undefined)

  if (existing) {
    db.prepare(
      `UPDATE drafts SET to_field = ?, subject = ?, body = ?, in_reply_to = ?, references_header = ?,
         ai_generated = 1, ai_pristine = 1, updated_at = unixepoch()
       WHERE id = ?`
    ).run(to, reSubject, body, trigger.message_id_header, trigger.references_header, existing.id)
    return existing.id
  }
  const res = db
    .prepare(
      `INSERT INTO drafts (account, to_field, subject, body, thread_id, in_reply_to, references_header,
         ai_generated, ai_pristine)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`
    )
    .run(job.account_id, to, reSubject, body, job.thread_id, trigger.message_id_header, trigger.references_header)
  return Number(res.lastInsertRowid)
}

async function processJob(job: JobRow): Promise<void> {
  const cfg = loadAutodraftConfig()
  const engine = getEngine(cfg)

  const valid = stillValid(job)
  if (!valid.ok) {
    finishJob(job, 'superseded', { last_error: valid.reason })
    return
  }
  const trigger = getTriggerMessage(job.account_id, job.thread_id, job.message_id)
  if (!trigger) {
    finishJob(job, 'superseded', { last_error: 'trigger message gone' })
    return
  }
  const subject = threadSubject(job.account_id, job.thread_id)

  try {
    if (job.guidance === null) {
      const verdict = parseTriageVerdict(await engine.triage(buildTriagePrompt(trigger, subject)))
      if (!verdict.reply) {
        finishJob(job, 'skipped', { triage_reason: verdict.reason })
        return
      }
      getDb().prepare(`UPDATE autodraft_jobs SET triage_reason = ? WHERE id = ?`).run(verdict.reason, job.id)
    }

    const previousDraft = job.draft_id
      ? ((getDb().prepare(`SELECT body FROM drafts WHERE id = ?`).get(job.draft_id) as { body: string } | undefined)
          ?.body ?? null)
      : null
    const body = cleanDraftBody(
      await engine.draft(buildDraftPrompt({ trigger, subject, guidance: job.guidance || null, previousDraft }, cfg))
    )
    if (!body) throw new Error('engine returned an empty draft')

    // The world may have moved on during the (slow) draft run.
    const revalid = stillValid(job)
    if (!revalid.ok) {
      finishJob(job, 'superseded', { last_error: revalid.reason })
      return
    }
    const draftId = upsertDraft(job, trigger, subject, body)
    finishJob(job, 'done', { draft_id: draftId })
    console.log(`[autodraft] drafted reply to ${trigger.from_email} (job ${job.id})`)
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    finishJob(job, 'failed', { last_error: msg.slice(0, 500) })
    if (/401|authenticat/i.test(msg)) {
      // Subscription login is stale — back off instead of burning every job.
      setMeta(AUTH_FAIL_KEY, String(Math.floor(Date.now() / 1000)))
      console.error('[autodraft] claude CLI auth failed — run `claude login` in a terminal, then drafts resume')
    } else {
      console.error(`[autodraft] job ${job.id} failed:`, msg)
    }
  }
}

// ---------- public entry points ----------

let running = false

export async function runAutodraft(opts?: { maxJobs?: number }): Promise<number> {
  if (running) return 0
  running = true
  try {
    const cfg = loadAutodraftConfig()
    if (!cfg.enabled) return 0
    const db = getDb()

    cleanupStaleDrafts()
    sweep()

    const authFailedAt = Number(getMeta(AUTH_FAIL_KEY) ?? '0')
    if (authFailedAt && Date.now() / 1000 - authFailedAt < AUTH_BACKOFF_S) return 0

    const maxJobs = opts?.maxJobs ?? 5
    let processed = 0
    while (processed < maxJobs) {
      const hourCount = (db
        .prepare(
          `SELECT COUNT(*) AS n FROM autodraft_jobs
           WHERE processed_at > unixepoch() - 3600 AND state IN ('done','skipped','failed')`
        )
        .get() as { n: number }).n
      if (hourCount >= cfg.maxJobsPerHour) break

      const job = db
        .prepare(`SELECT * FROM autodraft_jobs WHERE state = 'pending' ORDER BY created_at LIMIT 1`)
        .get() as JobRow | undefined
      if (!job) break
      // Atomic claim — the app and the headless runner may both be draining.
      const claimed = db
        .prepare(`UPDATE autodraft_jobs SET state = 'running', attempts = attempts + 1 WHERE id = ? AND state = 'pending'`)
        .run(job.id).changes
      if (!claimed) continue

      notify(job.account_id, job.thread_id, 'running')
      await processJob(job)
      processed++
      if (getMeta(AUTH_FAIL_KEY) && Date.now() / 1000 - Number(getMeta(AUTH_FAIL_KEY)) < AUTH_BACKOFF_S) break
    }
    return processed
  } finally {
    running = false
  }
}

/** Steer-and-regenerate: a user-guided job for the thread's latest inbound message. */
export function regenerateDraft(account: string, threadId: string, guidance: string): number {
  const db = getDb()
  const trigger = db
    .prepare(
      `SELECT id FROM messages
       WHERE account_id = ? AND thread_id = ? AND lower(COALESCE(from_email,'')) NOT IN (SELECT lower(id) FROM accounts)
       ORDER BY ts DESC LIMIT 1`
    )
    .get(account, threadId) as { id: string } | undefined
  if (!trigger) throw new Error('No inbound message on this thread to reply to')

  const draft = db
    .prepare(`SELECT id FROM drafts WHERE account = ? AND thread_id = ? AND ai_generated = 1`)
    .get(account, threadId) as { id: number } | undefined

  // Store '' (not NULL) for empty guidance: non-NULL means "explicitly requested,
  // skip the triage gate" — a user hitting Regenerate always gets a draft.
  const res = db
    .prepare(
      `INSERT INTO autodraft_jobs (account_id, thread_id, message_id, guidance, draft_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(account, threadId, trigger.id, guidance.trim(), draft?.id ?? null)
  const jobId = Number(res.lastInsertRowid)

  notify(account, threadId, 'pending')
  runAutodraft().catch((e) => console.error('[autodraft]', e?.message ?? e))
  return jobId
}

export interface AutodraftStatus {
  jobId: number
  state: string
  triageReason: string | null
  lastError: string | null
  createdAt: number
}

/** Latest job for a thread — lets the UI show "Drafting…" / skip reasons. */
export function autodraftStatus(account: string, threadId: string): AutodraftStatus | null {
  const row = getDb()
    .prepare(
      `SELECT id, state, triage_reason, last_error, created_at FROM autodraft_jobs
       WHERE account_id = ? AND thread_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
    )
    .get(account, threadId) as any
  if (!row) return null
  return {
    jobId: row.id,
    state: row.state,
    triageReason: row.triage_reason,
    lastError: row.last_error,
    createdAt: row.created_at
  }
}

export function draftsForThread(account: string, threadId: string) {
  return getDb()
    .prepare(`SELECT * FROM drafts WHERE account = ? AND thread_id = ? ORDER BY updated_at`)
    .all(account, threadId)
}
