import { app, BrowserWindow, Notification } from 'electron'
import { classifyThread, getDb, listAccounts } from '../db/db'
import type { NewMailNotice } from './incremental'
import { connectedAccountEmails } from './auth'
import { backfillAccount } from './backfill'
import { syncAccount } from './incremental'
import { startDrainLoop } from './modifier-queue'
import { processDueJobs } from './send'
import { startHubSpotLoop } from '../hubspot/sync'

const FOCUSED_INTERVAL = 20_000
const BLURRED_INTERVAL = 120_000

let timer: NodeJS.Timeout | null = null
let running = false
const backfilling = new Set<string>()

function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

/** Dock badge = unread, not-done, focused (people) inbox threads. */
export function updateBadge() {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM threads
       WHERE is_inbox = 1 AND is_unread = 1 AND done_at IS NULL
         AND (category IS NULL OR category = 'people')`
    )
    .get() as { n: number }
  app.dock?.setBadge(row.n > 0 ? String(row.n) : '')
}

/** Banner per new focused-inbox email; noreply machines and category mail stay quiet. */
function notifyNewMail(notices: NewMailNotice[]) {
  const interesting = notices.filter((n) => {
    if (Date.now() / 1000 - n.ts > 10 * 60) return false // history replay after reopen — not "new"
    return classifyThread(new Set(n.labels), [n.fromEmail ?? '']) === 'people'
  })
  if (interesting.length === 0 || !Notification.isSupported()) return

  for (const n of interesting.slice(0, 3)) {
    const banner = new Notification({
      title: n.fromName || n.fromEmail || 'New email',
      subtitle: n.subject,
      body: n.snippet ?? '',
      sound: 'default'
    })
    banner.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        win.show()
        win.focus()
        win.webContents.send('open-thread', { account: n.account, threadId: n.threadId })
      }
    })
    banner.show()
  }
  if (interesting.length > 3) {
    new Notification({
      title: 'MailFlow',
      body: `${interesting.length - 3} more new emails`
    }).show()
  }
}

export async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    await processDueJobs().catch((e) => console.error('[jobs]', e.message))
    const connected = new Set(connectedAccountEmails())
    for (const account of listAccounts()) {
      if (!connected.has(account.id)) continue
      try {
        if (account.backfill_state !== 'done') {
          if (!backfilling.has(account.id)) {
            backfilling.add(account.id)
            // Long-running; don't block the poll loop for the other account.
            backfillAccount(account.id, (p) => broadcast('sync:backfill-progress', p))
              .catch((e) => console.error(`[backfill:${account.id}]`, e.message))
              .finally(() => {
                backfilling.delete(account.id)
                broadcast('sync:updated', { account: account.id })
              })
          }
          continue
        }
        const { changed, newMail } = await syncAccount(account.id)
        if (changed > 0) broadcast('sync:updated', { account: account.id })
        notifyNewMail(newMail)
      } catch (e: any) {
        console.error(`[sync:${account.id}]`, e.message)
      }
    }
  } finally {
    running = false
    try {
      updateBadge()
    } catch { /* db not ready yet */ }
  }
}

export function startSyncLoop() {
  getDb() // ensure schema before first tick
  startDrainLoop()
  startHubSpotLoop()
  // Signatures import themselves from sent mail on first run.
  import('./signatures').then(({ autoImportSignatures }) =>
    autoImportSignatures(connectedAccountEmails()).catch(() => {})
  )
  const schedule = () => {
    if (timer) clearInterval(timer)
    const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused())
    timer = setInterval(tick, focused ? FOCUSED_INTERVAL : BLURRED_INTERVAL)
  }
  schedule()
  tick()
  // Local actions (read/done in the UI) change the count between sync ticks.
  setInterval(() => {
    try { updateBadge() } catch { /* noop */ }
  }, 15_000)
  // Re-evaluate cadence on focus changes.
  const { app } = require('electron')
  app.on('browser-window-focus', schedule)
  app.on('browser-window-blur', schedule)
}
