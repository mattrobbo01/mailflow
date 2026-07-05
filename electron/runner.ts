import { app } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { dataDir, getDb, listAccounts } from './db/db'
import { processDueJobs } from './sync/send'
import { drain } from './sync/modifier-queue'

/**
 * Headless mode for the launchd agent: fire due scheduled sends / unsnoozes,
 * flush any stranded modifier-queue actions, exit. Runs every 60s via
 * launchd/com.mattrobertson.mailflow.runner.plist (launchd never overlaps
 * instances of the same label, so a slow draft run just delays the next tick).
 *
 * When the desktop app is NOT running, the runner also does an incremental
 * sync and processes auto-draft jobs, so drafts keep generating while the app
 * is closed (or after wake, before the app is opened).
 */

async function appAlive(): Promise<boolean> {
  let port = 8484
  try {
    port = Number(JSON.parse(readFileSync(join(dataDir(), 'bridge.json'), 'utf8')).port) || 8484
  } catch {
    /* default port */
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    return ((await res.json()) as any)?.app === 'mailflow'
  } catch {
    return false
  }
}

export async function runHeadless(): Promise<void> {
  try {
    getDb()
    const fired = await processDueJobs()
    await drain()
    if (fired > 0) console.log(`[runner] fired ${fired} job(s)`)

    if (!(await appAlive())) {
      // App closed — pull new mail so the auto-draft sweep has something to see.
      const { connectedAccountEmails } = await import('./sync/auth')
      const { syncAccount } = await import('./sync/incremental')
      const connected = new Set(connectedAccountEmails())
      for (const account of listAccounts()) {
        if (!connected.has(account.id) || account.backfill_state !== 'done') continue
        try {
          await syncAccount(account.id)
        } catch (e: any) {
          console.error(`[runner:sync:${account.id}]`, e?.message ?? e)
        }
      }
      const { runAutodraft } = await import('./autodraft/worker')
      const drafted = await runAutodraft({ maxJobs: 2 })
      if (drafted > 0) console.log(`[runner] processed ${drafted} auto-draft job(s)`)
    }
  } catch (e: any) {
    console.error('[runner]', e?.message ?? e)
    process.exitCode = 1
  } finally {
    app.quit()
  }
}
