import { app } from 'electron'
import { getDb } from './db/db'
import { processDueJobs } from './sync/send'
import { drain } from './sync/modifier-queue'

/**
 * Headless mode for the launchd agent: fire due scheduled sends / unsnoozes,
 * flush any stranded modifier-queue actions, exit. Runs every 60s via
 * launchd/com.mattrobertson.mailflow.runner.plist.
 */
export async function runHeadless(): Promise<void> {
  try {
    getDb()
    const fired = await processDueJobs()
    await drain()
    if (fired > 0) console.log(`[runner] fired ${fired} job(s)`)
  } catch (e: any) {
    console.error('[runner]', e?.message ?? e)
    process.exitCode = 1
  } finally {
    app.quit()
  }
}
