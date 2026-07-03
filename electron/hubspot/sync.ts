// Incremental HubSpot sync + people-spine merge.
// - syncHubSpot(): contacts/deals modified since the 'hubspot:lastSync' watermark,
//   notes per changed contact, all upserted into hs_* tables and merged into people.
// - Bootstrap (cheap, local): Gmail correspondents → people (every run, single SQL),
//   Robbo2 People/*.md frontmatter → people (once, guarded by meta key).
// Network failures never crash the app: every entry point is wrapped in try/catch.

import { readdirSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { getDb, transaction } from '../db/db'
import {
  dealContactAssociations,
  fetchContactNotes,
  isConfigured,
  loadConfig,
  searchContactsModifiedSince,
  searchDealsModifiedSince
} from './api'

const LAST_SYNC_KEY = 'hubspot:lastSync'
const BOOTSTRAP_KEY = 'hubspot:bootstrapped'
const PORTAL_ID_KEY = 'hubspot:portalId'
const SYNC_INTERVAL = 15 * 60 * 1000
const NOTES_PER_CONTACT = 10
const NOTES_CONTACT_CAP = 500 // bound API calls on huge first syncs

const ROBBO2_PEOPLE_DIR = join(process.env.HOME ?? '', 'Projects', 'Robbo2', 'People')

// ---------- meta helpers ----------

function getMeta(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

function setMeta(key: string, value: string) {
  getDb()
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value)
}

// ---------- local bootstrap: Gmail correspondents + Robbo2 notes ----------

/** INSERT OR IGNORE every Gmail correspondent into people. Idempotent + cheap; runs every sync. */
function mergeGmailCorrespondents() {
  getDb().exec(`
    INSERT OR IGNORE INTO people (email, name)
    SELECT lower(from_email), NULLIF(max(from_name), '')
    FROM messages
    WHERE from_email IS NOT NULL AND from_email <> ''
      AND lower(from_email) NOT IN (SELECT lower(id) FROM accounts)
    GROUP BY lower(from_email)
  `)
}

/** Pull a `key: value` line out of YAML frontmatter with a small regex (no yaml dep). */
function frontmatterField(fm: string, key: string): string | null {
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.+)$`, 'mi'))
  if (!m) return null
  const v = m[1].trim().replace(/^["']|["']$/g, '').trim()
  return v || null
}

/** Scan Robbo2 People/*.md frontmatter for email / hubspot / company / role fields. */
function parseRobbo2People() {
  let files: string[]
  try {
    files = readdirSync(ROBBO2_PEOPLE_DIR).filter((f) => f.endsWith('.md'))
  } catch {
    return // Robbo2 not present on this machine
  }
  const upsert = getDb().prepare(`
    INSERT INTO people (email, name, company, role, hubspot_id, robbo2_note)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      name = COALESCE(NULLIF(name, ''), excluded.name),
      company = COALESCE(NULLIF(company, ''), excluded.company),
      role = COALESCE(NULLIF(role, ''), excluded.role),
      hubspot_id = COALESCE(hubspot_id, excluded.hubspot_id),
      robbo2_note = excluded.robbo2_note
  `)
  transaction(() => {
    for (const f of files) {
      try {
        const path = join(ROBBO2_PEOPLE_DIR, f)
        const head = readFileSync(path, 'utf8').slice(0, 4000)
        const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/)
        if (!fm) continue
        const email = frontmatterField(fm[1], 'email')?.toLowerCase()
        if (!email || !email.includes('@')) continue

        const hubspotUrl = frontmatterField(fm[1], 'hubspot')
        const hubspotId = hubspotUrl?.match(/\/record\/0-1\/(\d+)/)?.[1] ?? null
        const portalId = hubspotUrl?.match(/\/contacts\/(\d+)\//)?.[1]
        if (portalId && !getMeta(PORTAL_ID_KEY)) setMeta(PORTAL_ID_KEY, portalId)

        const company = frontmatterField(fm[1], 'company')
          ?.replace(/^\[\[(?:Companies\/)?/, '')
          .replace(/\]\]$/, '')
          .trim() ?? null
        const role = frontmatterField(fm[1], 'role')
        upsert.run(email, basename(f, '.md'), company || null, role, hubspotId, path)
      } catch {
        // Skip unreadable/malformed note; never abort the scan.
      }
    }
  })
}

// ---------- HubSpot → local upserts ----------

function toEpochSeconds(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

function upsertContacts(contacts: { id: string; properties: Record<string, string | null>; updatedAt?: string }[]) {
  const db = getDb()
  const upsertHs = db.prepare(`
    INSERT INTO hs_contacts (hubspot_id, email, properties, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(hubspot_id) DO UPDATE SET
      email = excluded.email,
      properties = excluded.properties,
      updated_at = excluded.updated_at
  `)
  const mergePerson = db.prepare(`
    INSERT INTO people (email, name, company, role, hubspot_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      name = COALESCE(NULLIF(excluded.name, ''), name),
      company = COALESCE(NULLIF(excluded.company, ''), company),
      role = COALESCE(NULLIF(excluded.role, ''), role),
      hubspot_id = excluded.hubspot_id
  `)
  transaction(() => {
    for (const c of contacts) {
      const p = c.properties ?? {}
      const email = (p.email ?? '').trim().toLowerCase() || null
      upsertHs.run(c.id, email, JSON.stringify(p), toEpochSeconds(c.updatedAt) ?? Math.floor(Date.now() / 1000))
      if (email) {
        const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim()
        mergePerson.run(email, name || null, p.company ?? null, p.jobtitle ?? null, c.id)
      }
    }
  })
}

function upsertDeals(
  deals: { id: string; properties: Record<string, string | null> }[],
  associations: Map<string, string[]>
) {
  const db = getDb()
  const upsertDeal = db.prepare(`
    INSERT INTO hs_deals (hubspot_id, name, stage, amount, pipeline, close_date, properties, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(hubspot_id) DO UPDATE SET
      name = excluded.name,
      stage = excluded.stage,
      amount = excluded.amount,
      pipeline = excluded.pipeline,
      close_date = excluded.close_date,
      properties = excluded.properties,
      updated_at = excluded.updated_at
  `)
  const clearAssoc = db.prepare(`DELETE FROM hs_deal_contacts WHERE deal_id = ?`)
  const insertAssoc = db.prepare(`INSERT OR IGNORE INTO hs_deal_contacts (deal_id, contact_id) VALUES (?, ?)`)
  transaction(() => {
    for (const d of deals) {
      const p = d.properties ?? {}
      const amount = p.amount != null && p.amount !== '' && !Number.isNaN(Number(p.amount)) ? Number(p.amount) : null
      upsertDeal.run(d.id, p.dealname ?? null, p.dealstage ?? null, amount, p.pipeline ?? null,
        toEpochSeconds(p.closedate), JSON.stringify(p))
      clearAssoc.run(d.id)
      for (const contactId of associations.get(d.id) ?? []) insertAssoc.run(d.id, contactId)
    }
  })
}

function replaceContactNotes(contactId: string, notes: { id: string; body: string | null; timestamp: string | null }[]) {
  const db = getDb()
  const insert = db.prepare(`
    INSERT INTO hs_notes (hubspot_id, contact_id, body, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(hubspot_id) DO UPDATE SET
      contact_id = excluded.contact_id,
      body = excluded.body,
      created_at = excluded.created_at
  `)
  transaction(() => {
    db.prepare(`DELETE FROM hs_notes WHERE contact_id = ?`).run(contactId)
    for (const n of notes) insert.run(n.id, contactId, n.body, toEpochSeconds(n.timestamp))
  })
}

// ---------- sync entry points ----------

let syncing = false

export async function syncHubSpot(): Promise<void> {
  if (syncing) return
  syncing = true
  try {
    // Local merges first — useful even without a HubSpot token.
    try {
      mergeGmailCorrespondents()
    } catch (e: any) {
      console.error('[hubspot] gmail correspondent merge failed:', e?.message ?? e)
    }
    if (getMeta(BOOTSTRAP_KEY) !== '1') {
      try {
        parseRobbo2People()
        setMeta(BOOTSTRAP_KEY, '1')
      } catch (e: any) {
        console.error('[hubspot] robbo2 bootstrap failed:', e?.message ?? e)
      }
    }

    if (!isConfigured()) return

    const runStart = Date.now()
    const since = Number(getMeta(LAST_SYNC_KEY) ?? '0') || 0

    const contacts = await searchContactsModifiedSince(since)
    if (contacts.length > 0) upsertContacts(contacts)

    const deals = await searchDealsModifiedSince(since)
    if (deals.length > 0) {
      const associations = await dealContactAssociations(deals.map((d) => d.id))
      upsertDeals(deals, associations)
    }

    for (const c of contacts.slice(0, NOTES_CONTACT_CAP)) {
      try {
        replaceContactNotes(c.id, await fetchContactNotes(c.id, NOTES_PER_CONTACT))
      } catch (e: any) {
        console.error(`[hubspot] notes for contact ${c.id} failed:`, e?.message ?? e)
      }
    }

    setMeta(LAST_SYNC_KEY, String(runStart))
    if (contacts.length > 0 || deals.length > 0) {
      console.log(`[hubspot] synced ${contacts.length} contacts, ${deals.length} deals`)
    }
  } catch (e: any) {
    console.error('[hubspot] sync failed:', e?.message ?? e)
  } finally {
    syncing = false
  }
}

let timer: NodeJS.Timeout | null = null

/** Run syncHubSpot() now and every 15 minutes. Idempotent. */
export function startHubSpotLoop() {
  if (timer) return
  timer = setInterval(() => { syncHubSpot() }, SYNC_INTERVAL)
  syncHubSpot()
}

// ---------- read side (IPC) ----------

export function hubspotStatus() {
  const contacts = (getDb().prepare(`SELECT COUNT(*) AS n FROM hs_contacts`).get() as { n: number }).n
  const last = getMeta(LAST_SYNC_KEY)
  return {
    configured: isConfigured(),
    lastSync: last ? Number(last) : null,
    contacts,
    portalId: loadConfig()?.portalId ?? getMeta(PORTAL_ID_KEY)
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}

// Per-contact freshness for on-demand note fetches (avoid hammering on every ⌘I).
const notesFetchedAt = new Map<string, number>()

/**
 * Refresh a single contact's notes from HubSpot right now, so opening a person
 * shows their notes immediately instead of waiting for the batched background
 * sweep to reach them. Waits up to `timeoutMs`; a slower fetch still lands in
 * the DB for the next open.
 */
async function refreshNotesOnDemand(contactId: string, timeoutMs = 2500): Promise<void> {
  const last = notesFetchedAt.get(contactId) ?? 0
  if (Date.now() - last < 5 * 60_000) return
  notesFetchedAt.set(contactId, Date.now())
  const fetchAndStore = fetchContactNotes(contactId)
    .then((notes) => replaceContactNotes(contactId, notes))
    .catch((e) => {
      notesFetchedAt.delete(contactId)
      console.error(`[hubspot] on-demand notes for ${contactId}:`, e?.message ?? e)
    })
  await Promise.race([fetchAndStore, new Promise((r) => setTimeout(r, timeoutMs))])
}

export async function getPersonContext(email: string) {
  const db = getDb()
  const lower = email.trim().toLowerCase()

  const person = (db
    .prepare(`SELECT email, name, company, role, hubspot_id, robbo2_note, last_emailed FROM people WHERE email = ?`)
    .get(lower) ?? null) as { hubspot_id: string | null } | null

  let hsContact = (db.prepare(`SELECT hubspot_id, email, properties, updated_at FROM hs_contacts WHERE email = ?`).get(lower) ?? null) as
    | { hubspot_id: string }
    | null
  if (!hsContact && person?.hubspot_id) {
    hsContact = (db
      .prepare(`SELECT hubspot_id, email, properties, updated_at FROM hs_contacts WHERE hubspot_id = ?`)
      .get(person.hubspot_id) ?? null) as { hubspot_id: string } | null
  }

  const contactId = hsContact?.hubspot_id ?? person?.hubspot_id ?? null
  if (contactId && isConfigured()) {
    await refreshNotesOnDemand(contactId)
  }
  const deals = contactId
    ? db.prepare(`
        SELECT d.hubspot_id, d.name, d.stage, d.amount, d.pipeline, d.close_date
        FROM hs_deals d
        JOIN hs_deal_contacts dc ON dc.deal_id = d.hubspot_id
        WHERE dc.contact_id = ?
        ORDER BY d.updated_at DESC
      `).all(contactId)
    : []
  const notes = contactId
    ? db.prepare(`
        SELECT hubspot_id, body, created_at FROM hs_notes
        WHERE contact_id = ? ORDER BY created_at DESC LIMIT 10
      `).all(contactId)
    : []

  const transcripts = db.prepare(`
    SELECT t.id, t.title, t.started_at
    FROM transcript_attendees a
    JOIN transcripts t ON t.id = a.transcript_id
    WHERE a.person_email = ?
    ORDER BY t.started_at DESC LIMIT 5
  `).all(lower)

  const recentThreads = db.prepare(`
    SELECT account_id, id, subject, snippet, last_ts, message_count, is_unread, label_ids, participants
    FROM threads
    WHERE participants LIKE ? ESCAPE '\\'
    ORDER BY last_ts DESC LIMIT 8
  `).all(`%${escapeLike(lower)}%`)

  return { person, hsContact, deals, notes, transcripts, recentThreads }
}
