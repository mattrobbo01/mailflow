import { ImapFlow } from 'imapflow'
import { powerMonitor } from 'electron'
import { getDb } from '../db/db'
import { connectedAccountEmails, getAuthClient } from './auth'

/**
 * Gmail push via IMAP IDLE: one persistent connection per account on INBOX,
 * read-only. imapflow enters IDLE automatically whenever the connection is
 * quiet; any mailbox event just kicks the existing history.list sync, so all
 * mail flow still goes through the one REST pipeline. Polling stays on as the
 * safety net — a dead IDLE connection can only ever degrade to poll latency.
 *
 * Requires the https://mail.google.com/ scope (XOAUTH2 for IMAP rejects the
 * narrower REST scopes) — accounts consented before 2026-07-05 show
 * "needs reconnect" in idleStatus() until re-consented.
 */

interface ConnState {
  client: ImapFlow | null
  connected: boolean
  connecting: boolean
  stopping: boolean
  retryMs: number
  timer: NodeJS.Timeout | null
  lastError: string | null
  since: number | null
}

const conns = new Map<string, ConnState>()
let onEvent: (() => void) | null = null
let kickTimer: NodeJS.Timeout | null = null
let reconciler: NodeJS.Timeout | null = null

const RETRY_MIN = 15_000
const RETRY_MAX = 5 * 60_000
const RETRY_AUTH = 30 * 60_000 // stale scope / bad creds — don't hammer Google

/** Coalesce event bursts (a new email fires several mailbox events) into one sync kick. */
function kick() {
  if (kickTimer) return
  kickTimer = setTimeout(() => {
    kickTimer = null
    onEvent?.()
  }, 300)
}

function state(email: string): ConnState {
  let s = conns.get(email)
  if (!s) {
    s = { client: null, connected: false, connecting: false, stopping: false, retryMs: RETRY_MIN, timer: null, lastError: null, since: null }
    conns.set(email, s)
  }
  return s
}

function scheduleReconnect(email: string, delayMs?: number) {
  const s = state(email)
  if (s.stopping || s.timer) return
  const delay = delayMs ?? s.retryMs
  s.retryMs = Math.min(s.retryMs * 2, RETRY_MAX)
  s.timer = setTimeout(() => {
    s.timer = null
    connect(email).catch(() => {})
  }, delay)
}

function teardown(s: ConnState) {
  const c = s.client
  s.client = null
  s.connected = false
  if (c) {
    try {
      c.close()
    } catch {
      /* already dead */
    }
  }
}

async function connect(email: string) {
  const s = state(email)
  if (s.connecting || s.connected || s.stopping) return
  s.connecting = true
  try {
    const auth = getAuthClient(email)
    const { token } = await auth.getAccessToken()
    if (!token) throw new Error('could not obtain access token')

    const client = new ImapFlow({
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      auth: { user: email, accessToken: token },
      logger: false
    })
    client.on('error', (e: any) => {
      s.lastError = String(e?.message ?? e)
      teardown(s)
      scheduleReconnect(email)
    })
    client.on('close', () => {
      if (s.client === client) {
        teardown(s)
        scheduleReconnect(email)
      }
    })
    // Mailbox activity of any kind → sync. 'exists' = new mail; 'expunge' and
    // 'flags' = changes made in other clients worth reflecting quickly.
    client.on('exists', kick)
    client.on('expunge', kick)
    client.on('flags', kick)

    await client.connect()
    await client.mailboxOpen('INBOX', { readOnly: true })

    s.client = client
    s.connected = true
    s.retryMs = RETRY_MIN
    s.lastError = null
    s.since = Date.now()
    console.log(`[idle:${email}] connected — push mail active`)
    kick() // catch anything that arrived while we were connecting
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    s.lastError = msg
    teardown(s)
    // imapflow surfaces AUTHENTICATE rejections as a generic "Command failed"
    // with authenticationFailed set on the error object.
    if (e?.authenticationFailed || /AUTHENTICATE|Invalid credentials|SASL/i.test(msg)) {
      // Token predates the mail.google.com scope (or was revoked) — needs a
      // reconnect from the UI; back way off instead of retry-spamming.
      s.lastError = 'needs reconnect (account consented before IMAP scope)'
      console.error(`[idle:${email}] auth rejected — reconnect the account to enable push mail`)
      scheduleReconnect(email, RETRY_AUTH)
    } else {
      console.error(`[idle:${email}]`, msg)
      scheduleReconnect(email)
    }
  } finally {
    s.connecting = false
  }
}

function eligibleAccounts(): string[] {
  const connected = new Set(connectedAccountEmails())
  return (getDb().prepare(`SELECT id FROM accounts WHERE backfill_state = 'done'`).all() as { id: string }[])
    .map((r) => r.id)
    .filter((id) => connected.has(id))
}

/** Start (and keep alive) an IDLE connection per connected account. Idempotent. */
export function startIdleListeners(onNewMail: () => void) {
  onEvent = onNewMail
  const ensureAll = () => {
    for (const email of eligibleAccounts()) connect(email).catch(() => {})
  }
  ensureAll()
  // Reconciler: picks up newly connected / newly re-consented accounts and
  // restarts anything that wedged without firing 'close'.
  if (!reconciler) reconciler = setInterval(ensureAll, 5 * 60_000)

  powerMonitor.on('resume', () => {
    // Sockets rarely survive sleep; rebuild them and sweep for missed mail.
    for (const [email, s] of conns) {
      teardown(s)
      if (s.timer) {
        clearTimeout(s.timer)
        s.timer = null
      }
      s.retryMs = RETRY_MIN
      connect(email).catch(() => {})
    }
    kick()
  })
}

export interface IdleStatus {
  email: string
  connected: boolean
  since: number | null
  lastError: string | null
}

export function idleStatus(): IdleStatus[] {
  return eligibleAccounts().map((email) => {
    const s = conns.get(email)
    return {
      email,
      connected: s?.connected ?? false,
      since: s?.since ?? null,
      lastError: s?.lastError ?? (s ? null : 'not started')
    }
  })
}
