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
import { startRecording, stopRecording, isRecording, listTranscripts, getTranscript } from './transcription/sidecar'
import { liveMeetings } from './calendar/gcal'

export function registerIpc() {
  ipcMain.handle('accounts:list', () => {
    const connected = new Set(connectedAccountEmails())
    const configs = loadClientConfigs()
    return {
      accounts: listAccounts().map((a) => ({ ...a, connected: connected.has(a.id) })),
      clientsConfigured: { work: Boolean(configs.work), personal: Boolean(configs.personal) }
    }
  })

  ipcMain.handle('auth:start', async (_e, kind: ClientKind) => {
    const email = await startAuthFlow(kind)
    tick() // kick off backfill immediately
    return email
  })

  ipcMain.handle('threads:list', (_e, opts: ListOptions) => listThreads(opts))

  ipcMain.handle('thread:summary', (_e, account: string, threadId: string) =>
    getThreadSummary(account, threadId)
  )

  ipcMain.handle('thread:setDone', (_e, account: string, threadId: string, done: boolean) => {
    setThreadDone(account, threadId, done)
    // Done mirrors archive in Gmail (Spark semantics); un-done restores to inbox.
    modifyThreadLabels(account, threadId, done ? { add: [], remove: ['INBOX'] } : { add: ['INBOX'], remove: [] })
  })

  ipcMain.handle('threads:groups', (_e, account?: string, showDone?: boolean) =>
    categoryGroups(account, showDone)
  )

  ipcMain.handle('thread:get', async (_e, account: string, threadId: string) => {
    const messages = getThreadMessages(account, threadId)
    // Hydrate any metadata-only bodies in the background of first open.
    const stale = messages.filter((m: any) => m.body_state !== 'full')
    if (stale.length > 0) {
      await Promise.all(stale.map((m: any) => hydrateMessageBody(account, m.id).catch(() => {})))
      return getThreadMessages(account, threadId)
    }
    return messages
  })

  ipcMain.handle('search:query', (_e, q: string) => searchThreads(q))

  ipcMain.handle('message:inlineImages', (_e, account: string, messageId: string) =>
    getInlineImages(account, messageId)
  )

  ipcMain.handle('sync:now', () => tick())

  // ---- actions (modifier queue) ----
  ipcMain.handle('thread:archive', (_e, a: string, t: string) => archiveThread(a, t))
  ipcMain.handle('thread:trash', (_e, a: string, t: string) => trashThread(a, t))
  ipcMain.handle('thread:markRead', (_e, a: string, t: string) => markRead(a, t))
  ipcMain.handle('thread:markUnread', (_e, a: string, t: string) => markUnread(a, t))
  ipcMain.handle('thread:star', (_e, a: string, t: string, on: boolean) => toggleStar(a, t, on))
  ipcMain.handle('thread:snooze', (_e, a: string, t: string, until: number) => snoozeThread(a, t, until))
  ipcMain.handle('thread:moveToInbox', (_e, a: string, t: string) => {
    getDb().prepare(`UPDATE threads SET snoozed_until = NULL WHERE account_id = ? AND id = ?`).run(a, t)
    modifyThreadLabels(a, t, { add: ['INBOX'], remove: [] })
  })

  // ---- send ----
  ipcMain.handle('send:now', (_e, mail: OutgoingEmail) => sendWithUndo(mail))
  ipcMain.handle('send:undo', (_e, actionId: number) => cancelAction(actionId))
  ipcMain.handle('send:schedule', (_e, mail: OutgoingEmail, sendAt: number) => scheduleSend(mail, sendAt))
  ipcMain.handle('jobs:list', () => listScheduledJobs())
  ipcMain.handle('jobs:cancel', (_e, id: number) => cancelScheduledJob(id))
  ipcMain.handle('thread:scheduled', (_e, account: string, threadId: string) =>
    scheduledForThread(account, threadId)
  )

  // ---- people sidebar / hubspot ----
  ipcMain.handle('people:forEmail', (_e, email: string) => getPersonContext(email))
  ipcMain.handle('hubspot:syncNow', () => syncHubSpot())
  ipcMain.handle('hubspot:setToken', async (_e, token: string) => {
    const { writeFileSync } = await import('fs')
    const { join } = await import('path')
    const { dataDir } = await import('./db/db')
    writeFileSync(join(dataDir(), 'hubspot.json'), JSON.stringify({ token: token.trim() }, null, 2))
    await syncHubSpot()
    return hubspotStatus()
  })
  ipcMain.handle('hubspot:status', () => hubspotStatus())

  // ---- transcription ----
  ipcMain.handle('transcription:start', (_e, title: string, attendees: string[], eventId?: string) =>
    startRecording(title, attendees, eventId)
  )
  ipcMain.handle('transcription:stop', () => stopRecording())
  ipcMain.handle('transcription:isRecording', () => isRecording())
  ipcMain.handle('transcription:list', (_e, query?: string) => listTranscripts(query))
  ipcMain.handle('transcription:get', (_e, id: number) => getTranscript(id))
  ipcMain.handle('shell:reveal', async (_e, path: string) => {
    const { shell } = await import('electron')
    shell.showItemInFolder(path)
  })

  ipcMain.handle('attachment:open', async (_e, account: string, messageId: string, attachmentId: string, filename: string) => {
    const { getGmail } = await import('./sync/gmail-client')
    const { dataDir } = await import('./db/db')
    const { mkdirSync, writeFileSync, existsSync } = await import('fs')
    const { join } = await import('path')
    const { shell } = await import('electron')

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
    await shell.openPath(path)
    return path
  })

  ipcMain.handle('notify:test', async () => {
    const { Notification } = await import('electron')
    if (!Notification.isSupported()) return false
    new Notification({
      title: 'MailFlow',
      body: 'System notifications are working — meeting alerts will look like this.',
      sound: 'default'
    }).show()
    return true
  })
  ipcMain.handle('meetings:live', () => liveMeetings())

  // ---- local drafts ----
  ipcMain.handle('drafts:list', () =>
    getDb().prepare(`SELECT * FROM drafts ORDER BY updated_at DESC`).all()
  )
  ipcMain.handle('drafts:save', (_e, d: any) => {
    const db = getDb()
    if (d.id) {
      db.prepare(
        `UPDATE drafts SET account=?, to_field=?, cc_field=?, bcc_field=?, subject=?, body=?, quoted=?,
           thread_id=?, in_reply_to=?, references_header=?, attachments_json=?, updated_at=unixepoch()
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
  })
  ipcMain.handle('drafts:delete', (_e, id: number) =>
    getDb().prepare(`DELETE FROM drafts WHERE id = ?`).run(id).changes > 0
  )

  // ---- recipient autocomplete ----
  ipcMain.handle('contacts:suggest', (_e, q: string) => {
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
  })

  // ---- signatures ----
  ipcMain.handle('signature:get', (_e, account: string) => getSignaturePreview(account))
  ipcMain.handle('signature:import', (_e, account: string) => importSignatureFromSent(account))
  ipcMain.handle('signature:set', (_e, account: string, html: string) => {
    const existing = getSignature(account)
    setSignature(account, { html, images: existing?.images ?? [] })
    return getSignaturePreview(account)
  })

  // ---- command palette frecency ----
  ipcMain.handle('palette:used', (_e, commandId: string) => {
    getDb()
      .prepare(
        `INSERT INTO palette_frecency (command_id, uses, last_used) VALUES (?, 1, unixepoch())
         ON CONFLICT(command_id) DO UPDATE SET uses = uses + 1, last_used = unixepoch()`
      )
      .run(commandId)
  })
  ipcMain.handle('palette:frecency', () => {
    const rows = getDb().prepare(`SELECT command_id, uses, last_used FROM palette_frecency`).all() as any[]
    return Object.fromEntries(rows.map((r) => [r.command_id, r.uses * 2 + r.last_used / 1e9]))
  })
}
