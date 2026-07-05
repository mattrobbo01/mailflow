import { ipcMain } from 'electron'
import { getDb, listAccounts } from './db/db'
import {
  listThreads, getThreadMessages, getThreadSummary, searchThreads, setThreadDone, categoryGroups, ListOptions
} from './db/queries'
import { startAuthFlow, connectedAccountEmails, loadClientConfigs, ClientKind } from './sync/auth'
import { hydrateMessageBody } from './sync/backfill'
import { tick } from './sync/orchestrator'
import {
  archiveThread, trashThread, markRead, markUnread, toggleStar, snoozeThread, cancelAction,
  modifyThreadLabels
} from './sync/modifier-queue'
import {
  sendWithUndo, scheduleSend, listScheduledJobs, cancelScheduledJob, scheduledForThread, OutgoingEmail
} from './sync/send'
import { getPersonContext, hubspotStatus, syncHubSpot } from './hubspot/sync'
import { getInlineImages } from './sync/inline-images'
import { getSignaturePreview, setSignature, getSignature, importSignatureFromSent } from './sync/signatures'
import { startRecording, stopRecording, isRecording, listTranscripts, getTranscript, deleteTranscript, renameTranscript } from './transcription/sidecar'
import { autodraftStatus, draftsForThread, regenerateDraft } from './autodraft/worker'
import { liveMeetings } from './calendar/gcal'

/**
 * Download an attachment to the local cache and return its path.
 * Shared by the desktop open flow and the mobile bridge download route.
 */
export async function fetchAttachmentToCache(
  account: string, messageId: string, attachmentId: string, filename: string
): Promise<string> {
  const { getGmail } = await import('./sync/gmail-client')
  const { dataDir } = await import('./db/db')
  const { mkdirSync, writeFileSync, existsSync } = await import('fs')
  const { join } = await import('path')

  const gmail = getGmail(account)
  let data: string | null | undefined
  try {
    data = (await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId })).data.data
  } catch {
    // Attachment ids can go stale — refetch the message for fresh ones and match by filename.
    const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
    const stack = [msg.data.payload]
    while (stack.length) {
      const part = stack.pop()
      if (!part) continue
      if (part.filename === filename && part.body?.attachmentId) {
        data = (await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: part.body.attachmentId })).data.data
        break
      }
      for (const child of part.parts ?? []) stack.push(child)
    }
  }
  if (!data) throw new Error('Could not download attachment from Gmail')

  const dir = join(dataDir(), 'attachments')
  mkdirSync(dir, { recursive: true })
  const safe = filename.replace(/[/\\:]/g, '_') || 'attachment'
  const path = join(dir, `${messageId.slice(0, 10)}-${safe}`)
  if (!existsSync(path)) writeFileSync(path, Buffer.from(data, 'base64url'))
  return path
}

type Handler = (...args: any[]) => unknown

/**
 * Every renderer-facing operation, keyed by channel. Registered on ipcMain for
 * the desktop window and served over HTTP by the bridge for mobile Safari —
 * keep handlers transport-agnostic (no BrowserWindow/event access).
 */
export function buildHandlers(): Record<string, Handler> {
  return {
    'accounts:list': () => {
      const connected = new Set(connectedAccountEmails())
      const configs = loadClientConfigs()
      return {
        accounts: listAccounts().map((a) => ({ ...a, connected: connected.has(a.id) })),
        clientsConfigured: { work: Boolean(configs.work), personal: Boolean(configs.personal) }
      }
    },

    'auth:start': async (kind: ClientKind) => {
      const email = await startAuthFlow(kind)
      tick() // kick off backfill immediately
      return email
    },

    'threads:list': (opts: ListOptions) => listThreads(opts),

    'thread:summary': (account: string, threadId: string) => getThreadSummary(account, threadId),

    'thread:setDone': (account: string, threadId: string, done: boolean) => {
      setThreadDone(account, threadId, done)
      // Done mirrors archive in Gmail (Spark semantics); un-done restores to inbox.
      modifyThreadLabels(account, threadId, done ? { add: [], remove: ['INBOX'] } : { add: ['INBOX'], remove: [] })
    },

    'threads:groups': (account?: string, showDone?: boolean) => categoryGroups(account, showDone),

    'thread:get': async (account: string, threadId: string) => {
      const messages = getThreadMessages(account, threadId)
      // Hydrate any metadata-only bodies in the background of first open.
      const stale = messages.filter((m: any) => m.body_state !== 'full')
      if (stale.length > 0) {
        await Promise.all(stale.map((m: any) => hydrateMessageBody(account, m.id).catch(() => {})))
        return getThreadMessages(account, threadId)
      }
      return messages
    },

    'search:query': (q: string) => searchThreads(q),

    'message:inlineImages': (account: string, messageId: string) => getInlineImages(account, messageId),

    'sync:now': () => tick(),
    'sync:idleStatus': async () => (await import('./sync/idle')).idleStatus(),

    // ---- actions (modifier queue) ----
    'thread:archive': (a: string, t: string) => archiveThread(a, t),
    'thread:trash': (a: string, t: string) => trashThread(a, t),
    'thread:markRead': (a: string, t: string) => markRead(a, t),
    'thread:markUnread': (a: string, t: string) => markUnread(a, t),
    'thread:star': (a: string, t: string, on: boolean) => toggleStar(a, t, on),
    'thread:snooze': (a: string, t: string, until: number) => snoozeThread(a, t, until),
    'thread:moveToInbox': (a: string, t: string) => {
      getDb().prepare(`UPDATE threads SET snoozed_until = NULL WHERE account_id = ? AND id = ?`).run(a, t)
      modifyThreadLabels(a, t, { add: ['INBOX'], remove: [] })
    },

    // ---- send ----
    'send:now': (mail: OutgoingEmail) => sendWithUndo(mail),
    'send:undo': (actionId: number) => cancelAction(actionId),
    'send:schedule': (mail: OutgoingEmail, sendAt: number) => scheduleSend(mail, sendAt),
    'jobs:list': () => listScheduledJobs(),
    'jobs:cancel': (id: number) => cancelScheduledJob(id),
    'thread:scheduled': (account: string, threadId: string) => scheduledForThread(account, threadId),

    // ---- people sidebar / hubspot ----
    'people:forEmail': (email: string) => getPersonContext(email),
    'hubspot:syncNow': () => syncHubSpot(),
    'hubspot:setToken': async (token: string) => {
      const { writeFileSync } = await import('fs')
      const { join } = await import('path')
      const { dataDir } = await import('./db/db')
      writeFileSync(join(dataDir(), 'hubspot.json'), JSON.stringify({ token: token.trim() }, null, 2))
      await syncHubSpot()
      return hubspotStatus()
    },
    'hubspot:status': () => hubspotStatus(),

    // ---- transcription ----
    'transcription:start': async (title: string, attendees: string[], eventId?: string) => {
      const transcriptId = await startRecording(title, attendees, eventId)
      // Recording runs in the background: the floating pill is the visible
      // presence (hover → stop); surfaces sync via the started broadcast.
      const { showRecordingPill } = await import('./recording-pill')
      showRecordingPill(title)
      const { broadcast } = await import('./broadcast')
      broadcast('transcription:started', { transcriptId, title })
      return transcriptId
    },
    'meeting:testPopup': async () => {
      const { showMeetingPopup } = await import('./meeting-popup')
      showMeetingPopup({
        account: 'test', eventId: `test-${Math.random().toString(36).slice(2)}`,
        title: 'Test meeting — popup preview', start: 0, end: 0, attendees: [], conferenceLink: ''
      })
      return true
    },
    'transcription:stop': () => stopRecording(),
    'transcription:isRecording': () => isRecording(),
    'transcription:list': (query?: string) => listTranscripts(query),
    'transcription:get': (id: number) => getTranscript(id),
    'transcription:delete': (id: number) => deleteTranscript(id),
    'transcription:rename': (id: number, title: string) => renameTranscript(id, title),

    'shell:reveal': async (path: string) => {
      const { shell } = await import('electron')
      shell.showItemInFolder(path)
    },

    'attachment:open': async (account: string, messageId: string, attachmentId: string, filename: string) => {
      const path = await fetchAttachmentToCache(account, messageId, attachmentId, filename)
      const { shell } = await import('electron')
      await shell.openPath(path)
      return path
    },

    'notify:test': async () => {
      const { Notification } = await import('electron')
      if (!Notification.isSupported()) return false
      new Notification({
        title: 'MailFlow',
        body: 'System notifications are working — meeting alerts will look like this.',
        sound: 'default'
      }).show()
      return true
    },
    'meetings:live': () => liveMeetings(),

    // ---- local drafts ----
    'drafts:list': () => getDb().prepare(`SELECT * FROM drafts ORDER BY updated_at DESC`).all(),
    'drafts:save': (d: any) => {
      const db = getDb()
      if (d.id) {
        // A manual save means Matt touched it — the auto-draft cleaner keeps hands off.
        db.prepare(
          `UPDATE drafts SET account=?, to_field=?, cc_field=?, bcc_field=?, subject=?, body=?, quoted=?,
             thread_id=?, in_reply_to=?, references_header=?, attachments_json=?, ai_pristine=0, updated_at=unixepoch()
           WHERE id=?`
        ).run(d.account, d.to ?? '', d.cc ?? '', d.bcc ?? '', d.subject ?? '', d.body ?? '', d.quoted ?? null,
          d.threadId ?? null, d.inReplyTo ?? null, d.references ?? null, JSON.stringify(d.attachments ?? []), d.id)
        return d.id
      }
      const res = db.prepare(
        `INSERT INTO drafts (account, to_field, cc_field, bcc_field, subject, body, quoted,
           thread_id, in_reply_to, references_header, attachments_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      ).run(d.account, d.to ?? '', d.cc ?? '', d.bcc ?? '', d.subject ?? '', d.body ?? '', d.quoted ?? null,
        d.threadId ?? null, d.inReplyTo ?? null, d.references ?? null, JSON.stringify(d.attachments ?? []))
      return Number(res.lastInsertRowid)
    },
    'drafts:delete': (id: number) => getDb().prepare(`DELETE FROM drafts WHERE id = ?`).run(id).changes > 0,

    // ---- auto-drafts ----
    'thread:drafts': (account: string, threadId: string) => draftsForThread(account, threadId),
    'autodraft:status': (account: string, threadId: string) => autodraftStatus(account, threadId),
    'autodraft:regenerate': (account: string, threadId: string, guidance: string) =>
      regenerateDraft(account, threadId, guidance),

    // ---- recipient autocomplete ----
    'contacts:suggest': (q: string) => {
      const query = (q ?? '').trim()
      if (query.length < 2) return []
      const like = `%${query}%`
      return getDb()
        .prepare(
          `SELECT email, name FROM people
           WHERE email LIKE ? OR name LIKE ?
           ORDER BY (last_emailed IS NOT NULL) DESC, COALESCE(last_emailed, first_seen, 0) DESC,
                    (hubspot_id IS NOT NULL) DESC
           LIMIT 8`
        )
        .all(like, like)
    },

    // ---- signatures ----
    'signature:get': (account: string) => getSignaturePreview(account),
    'signature:import': (account: string) => importSignatureFromSent(account),
    'signature:set': (account: string, html: string) => {
      const existing = getSignature(account)
      setSignature(account, { html, images: existing?.images ?? [] })
      return getSignaturePreview(account)
    },

    // ---- command palette frecency ----
    'palette:used': (commandId: string) => {
      getDb()
        .prepare(
          `INSERT INTO palette_frecency (command_id, uses, last_used) VALUES (?, 1, unixepoch())
           ON CONFLICT(command_id) DO UPDATE SET uses = uses + 1, last_used = unixepoch()`
        )
        .run(commandId)
    },
    'palette:frecency': () => {
      const rows = getDb().prepare(`SELECT command_id, uses, last_used FROM palette_frecency`).all() as any[]
      return Object.fromEntries(rows.map((r) => [r.command_id, r.uses * 2 + r.last_used / 1e9]))
    }
  }
}

let handlers: Record<string, Handler> | null = null

export function getHandlers(): Record<string, Handler> {
  if (!handlers) handlers = buildHandlers()
  return handlers
}

export function registerIpc() {
  for (const [channel, fn] of Object.entries(getHandlers())) {
    ipcMain.handle(channel, (_e, ...args) => fn(...args))
  }
}
