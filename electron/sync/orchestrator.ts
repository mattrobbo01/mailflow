import { app, BrowserWindow, Notification } from 'electron'
import { getDb, listAccounts } from '../db/db'
import type { NewMailNotice } from './incremental'
import { connectedAccountEmails } from './auth'
import { backfillAccount } from './backfill'
import { syncAccount } from './incremental'
import { startDrainLoop } from './modifier-queue'
import { processDueJobs } from './send'
import { startHubSpotLoop } from '../hubspot/sync'
import { runAutodraft } from '../autodraft/worker'
import { broadcast } from '../broadcast'

// history.list costs 2 quota units against 15k/min — aggressive polling is
// nearly free, and it's what closes the gap to push-based clients like Spark.
const FOCUSED_INTERVAL = 10_000
const BLURRED_INTERVAL = 30_000

let timer: NodeJS.Timeout | null = null
let running = false
const backfilling = new Set<string>()

/** Dock badge = unread, not-done inbox threads across ALL categories. */
export function updateBadge() {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM threads
       WHERE is_inbox = 1 AND is_unread = 1 AND done_at IS NULL`
    )
    .get() as { n: number }
  app.dock?.setBadge(row.n > 0 ? String(row.n) : '')
}

/** Banner per new inbound email — people, notifications, and newsletters alike. */
function notifyNewMail(notices: NewMailNotice[]) {
  const interesting = notices.filter(
    (n) => Date.now() / 1000 - n.ts <= 10 * 60 // history replay after reopen — not "new"
  )
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
    // Auto-draft sweep+process; NOT awaited — a slow draft run must never stall
    // the sync loop (the worker has its own reentrancy guard).
    runAutodraft({ maxJobs: 3 }).catch((e) => console.error('[autodraft]', e?.message ?? e))
  }
}

export function startSyncLoop() {
  getDb() // ensure schema before first tick
  startDrainLoop()
  startHubSpotLoop()
  // Push mail: IMAP IDLE kicks a sync the moment Gmail signals; the poll loop
  // below stays on as the safety net (a dead socket degrades to poll latency).
  import('./idle').then(({ startIdleListeners }) => startIdleListeners(() => tick()))
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
