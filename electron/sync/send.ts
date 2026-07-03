import { getDb } from '../db/db'
import { getGmail } from './gmail-client'
import { queueSend } from './modifier-queue'
import { getSignature } from './signatures'

export interface OutgoingEmail {
  account: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string            // plain text
  threadId?: string       // set when replying
  inReplyTo?: string      // RFC Message-ID of the message being replied to
  references?: string
  attachments?: { name: string; mimeType: string; dataBase64: string }[]
}

function encodeHeaderValue(v: string): string {
  // RFC 2047 encode if non-ASCII
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`
}

const b64wrap = (buf: Buffer | string) =>
  (typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf).toString('base64').replace(/(.{76})/g, '$1\r\n')

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const stripTags = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * multipart/alternative [ text/plain, multipart/related [ text/html, inline images ] ]
 * — HTML body with the account's signature (logo embedded via Content-ID), plus a
 * faithful plain-text alternative.
 */
export function buildMime(mail: OutgoingEmail): string {
  const sig = getSignature(mail.account)

  const headers: string[] = [
    `From: ${mail.account}`,
    `To: ${mail.to.join(', ')}`
  ]
  if (mail.cc?.length) headers.push(`Cc: ${mail.cc.join(', ')}`)
  if (mail.bcc?.length) headers.push(`Bcc: ${mail.bcc.join(', ')}`)
  headers.push(`Subject: ${encodeHeaderValue(mail.subject)}`)
  if (mail.inReplyTo) {
    headers.push(`In-Reply-To: ${mail.inReplyTo}`)
    headers.push(`References: ${[mail.references, mail.inReplyTo].filter(Boolean).join(' ')}`)
  }
  headers.push('MIME-Version: 1.0')

  const text = mail.body + (sig ? `\n\n--\n${stripTags(sig.html)}` : '')
  const html =
    `<div dir="ltr" style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:14px">` +
    escapeHtml(mail.body).replace(/\n/g, '<br>') +
    `</div>` +
    (sig ? sig.html : '')

  const altBoundary = 'mfalt000boundary'
  const relBoundary = 'mfrel000boundary'
  const mixBoundary = 'mfmix000boundary'
  const hasAttachments = (mail.attachments?.length ?? 0) > 0
  headers.push(
    hasAttachments
      ? `Content-Type: multipart/mixed; boundary="${mixBoundary}"`
      : `Content-Type: multipart/alternative; boundary="${altBoundary}"`
  )

  const parts: string[] = []
  if (hasAttachments) {
    parts.push(`--${mixBoundary}`, `Content-Type: multipart/alternative; boundary="${altBoundary}"`, '')
  }
  parts.push(
    `--${altBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64wrap(text)
  )

  const htmlPart = [
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64wrap(html)
  ]

  if (sig && sig.images.length > 0) {
    parts.push(
      `--${altBoundary}`,
      `Content-Type: multipart/related; boundary="${relBoundary}"`,
      '',
      `--${relBoundary}`,
      ...htmlPart
    )
    for (const img of sig.images) {
      parts.push(
        `--${relBoundary}`,
        `Content-Type: ${img.mimeType}`,
        'Content-Transfer-Encoding: base64',
        `Content-ID: <${img.cid}>`,
        'Content-Disposition: inline',
        '',
        img.base64.replace(/(.{76})/g, '$1\r\n')
      )
    }
    parts.push(`--${relBoundary}--`)
  } else {
    parts.push(`--${altBoundary}`, ...htmlPart)
  }
  parts.push(`--${altBoundary}--`)

  if (hasAttachments) {
    for (const att of mail.attachments!) {
      const safeName = att.name.replace(/["\\\r\n]/g, '_')
      parts.push(
        `--${mixBoundary}`,
        `Content-Type: ${att.mimeType || 'application/octet-stream'}; name="${safeName}"`,
        `Content-Disposition: attachment; filename="${safeName}"`,
        'Content-Transfer-Encoding: base64',
        '',
        att.dataBase64.replace(/(.{76})/g, '$1\r\n')
      )
    }
    parts.push(`--${mixBoundary}--`)
  }

  const raw = headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n')
  return Buffer.from(raw, 'utf8').toString('base64url')
}

/** Send with a 10s undo window via the modifier queue. Returns action id for undo. */
export function sendWithUndo(mail: OutgoingEmail): number {
  return queueSend(mail.account, buildMime(mail), mail.threadId ?? null)
}

/**
 * Scheduled send: create a REAL Gmail draft now (safety net — the mail exists at
 * Google even if this Mac never wakes), plus a scheduled_jobs row the runner fires.
 */
export async function scheduleSend(mail: OutgoingEmail, sendAt: number): Promise<void> {
  const gmail = getGmail(mail.account)
  const draft = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw: buildMime(mail), threadId: mail.threadId ?? undefined } }
  })
  getDb()
    .prepare(
      `INSERT INTO scheduled_jobs (account_id, kind, send_at, draft_id, thread_id, payload)
       VALUES (?, 'send', ?, ?, ?, ?)`
    )
    .run(
      mail.account, sendAt, draft.data.id, mail.threadId ?? null,
      JSON.stringify({ subject: mail.subject, to: mail.to, body: mail.body })
    )
}

/** Pending scheduled sends for a thread (rendered as "Scheduled" cards in the thread view). */
export function scheduledForThread(account: string, threadId: string) {
  return getDb()
    .prepare(
      `SELECT id, send_at, payload FROM scheduled_jobs
       WHERE state = 'pending' AND kind = 'send' AND account_id = ? AND thread_id = ?
       ORDER BY send_at`
    )
    .all(account, threadId)
}

/** Fire due jobs (called by the poll loop and by the headless launchd runner). */
export async function processDueJobs(): Promise<number> {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const due = db
    .prepare(`SELECT * FROM scheduled_jobs WHERE state = 'pending' AND send_at <= ? ORDER BY send_at`)
    .all(now) as any[]

  let fired = 0
  for (const job of due) {
    try {
      const gmail = getGmail(job.account_id)
      if (job.kind === 'send') {
        await gmail.users.drafts.send({ userId: 'me', requestBody: { id: job.draft_id } })
      } else if (job.kind === 'unsnooze') {
        await gmail.users.threads.modify({
          userId: 'me',
          id: job.thread_id,
          requestBody: { addLabelIds: ['INBOX'], removeLabelIds: [] }
        })
        db.prepare(`UPDATE threads SET snoozed_until = NULL WHERE account_id = ? AND id = ?`).run(
          job.account_id, job.thread_id
        )
      }
      db.prepare(`UPDATE scheduled_jobs SET state = 'done' WHERE id = ?`).run(job.id)
      fired++
    } catch (e: any) {
      const status = e?.code ?? e?.response?.status
      if (status === 404 && job.kind === 'send') {
        // Draft gone — user sent or deleted it manually. Job is moot.
        db.prepare(`UPDATE scheduled_jobs SET state = 'done' WHERE id = ?`).run(job.id)
      } else {
        console.error(`[jobs] #${job.id} ${job.kind} failed: ${e?.message}`)
      }
    }
  }
  return fired
}

export function listScheduledJobs() {
  return getDb()
    .prepare(`SELECT * FROM scheduled_jobs WHERE state = 'pending' ORDER BY send_at`)
    .all()
}

export function cancelScheduledJob(id: number): boolean {
  // Leaves the Gmail draft in place (visible in Drafts) — deliberate: never destroy mail.
  return getDb().prepare(`UPDATE scheduled_jobs SET state = 'failed' WHERE id = ? AND state = 'pending'`).run(id)
    .changes > 0
}
