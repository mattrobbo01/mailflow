import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { dataDir } from '../db/db'

/**
 * Auto-draft settings, user-editable at
 * ~/Library/Application Support/MailFlow/autodraft.json. The engine field picks
 * the DraftEngine implementation, so a future OpenAI/Anthropic-API engine is a
 * config change, not a refactor.
 */
export interface AutodraftConfig {
  enabled: boolean
  engine: 'claude-code'
  claudeBinary: string
  /** Cheap model for the "does this warrant a reply?" gate. */
  triageModel: string
  /** null = the claude CLI's default model (subscription default). */
  draftModel: string | null
  vaultPath: string
  /** Engine-invoking jobs per rolling hour — protects subscription rate limits. */
  maxJobsPerHour: number
  triageTimeoutMs: number
  draftTimeoutMs: number
  /** Company domains: attendees here are colleagues — never pushed to HubSpot. */
  internalDomains: string[]
  /** Vault note injected into meeting analysis — Matt's evolving coaching lens. */
  coachingProfilePath: string
}

function defaults(): AutodraftConfig {
  const home = process.env.HOME ?? ''
  return {
    enabled: true,
    engine: 'claude-code',
    claudeBinary: join(home, '.local', 'bin', 'claude'),
    triageModel: 'claude-haiku-4-5-20251001',
    draftModel: null,
    vaultPath: join(home, 'Projects', 'Robbo2'),
    maxJobsPerHour: 12,
    triageTimeoutMs: 90_000,
    draftTimeoutMs: 300_000,
    internalDomains: ['usehabits.com'],
    coachingProfilePath: join(home, 'Projects', 'Robbo2', 'Projects', 'MailFlow', 'coaching-profile.md')
  }
}

export function loadAutodraftConfig(): AutodraftConfig {
  const path = join(dataDir(), 'autodraft.json')
  const base = defaults()
  if (!existsSync(path)) {
    try {
      writeFileSync(path, JSON.stringify(base, null, 2))
    } catch {
      /* read-only disk shouldn't kill the worker */
    }
    return base
  }
  try {
    return { ...base, ...JSON.parse(readFileSync(path, 'utf8')) }
  } catch {
    return base
  }
}
