// Thin HubSpot CRM v3/v4 API client. Plain fetch, no SDK.
// Auth: Private App token read from ~/Library/Application Support/MailFlow/hubspot.json
//   → {"token": "pat-...", "portalId": "45088531"}   (portalId optional, used for deep links)
// If the file is missing all sync callers no-op gracefully via isConfigured().

import { readFileSync } from 'fs'
import { join } from 'path'
import { dataDir } from '../db/db'

const BASE = 'https://api.hubapi.com'
const MAX_RETRIES = 5
const SEARCH_CAP = 9500 // HubSpot CRM search pages out at 10k results

export interface HubSpotConfig {
  token: string
  portalId?: string
}

export function loadConfig(): HubSpotConfig | null {
  try {
    const raw = readFileSync(join(dataDir(), 'hubspot.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.token === 'string' && parsed.token.trim()) {
      return {
        token: parsed.token.trim(),
        portalId: parsed.portalId != null ? String(parsed.portalId) : undefined
      }
    }
  } catch {
    // File missing or malformed → not configured.
  }
  return null
}

export function isConfigured(): boolean {
  return loadConfig() !== null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** fetch wrapper: bearer auth + 429/5xx retry with backoff (HubSpot burst: 100 req/10s). */
async function hsFetch(path: string, init: RequestInit = {}): Promise<any> {
  const config = loadConfig()
  if (!config) throw new Error('HubSpot is not configured')

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {})
      }
    })
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`HubSpot ${res.status} after ${attempt + 1} attempts: ${path}`)
      }
      const retryAfter = Number(res.headers.get('retry-after'))
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1000 * 2 ** attempt, 30_000)
      await sleep(delay)
      continue
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`HubSpot ${res.status} ${path}: ${body.slice(0, 300)}`)
    }
    if (res.status === 204) return null
    return res.json()
  }
}

export interface HsObject {
  id: string
  properties: Record<string, string | null>
  updatedAt?: string
}

export const CONTACT_PROPERTIES = [
  'email', 'firstname', 'lastname', 'company', 'jobtitle', 'hs_object_id', 'lifecyclestage',
  'hs_timezone', 'linkedin__twitter_or_website_url', 'linkedin', 'hs_linkedin_url', 'linkedinbio'
]

export const DEAL_PROPERTIES = [
  'dealname', 'dealstage', 'amount', 'pipeline', 'closedate', 'hs_lastmodifieddate'
]

/** Paginated CRM v3 search over any object type. */
async function searchAll(objectType: string, body: Record<string, unknown>): Promise<HsObject[]> {
  const out: HsObject[] = []
  let after: string | undefined
  while (out.length < SEARCH_CAP) {
    const payload = await hsFetch(`/crm/v3/objects/${objectType}/search`, {
      method: 'POST',
      body: JSON.stringify({ ...body, limit: 100, ...(after ? { after } : {}) })
    })
    for (const item of payload?.results ?? []) {
      if (item?.id != null) out.push(item as HsObject)
    }
    after = payload?.paging?.next?.after
    if (!after) break
  }
  return out
}

/** Contacts modified since `sinceMs` (epoch ms). sinceMs=0 → everything. */
export function searchContactsModifiedSince(sinceMs: number): Promise<HsObject[]> {
  return searchAll('contacts', {
    filterGroups: sinceMs > 0
      ? [{ filters: [{ propertyName: 'lastmodifieddate', operator: 'GTE', value: String(sinceMs) }] }]
      : [],
    sorts: [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
    properties: CONTACT_PROPERTIES
  })
}

/** Deals modified since `sinceMs` (epoch ms). sinceMs=0 → everything. */
export function searchDealsModifiedSince(sinceMs: number): Promise<HsObject[]> {
  return searchAll('deals', {
    filterGroups: sinceMs > 0
      ? [{ filters: [{ propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: String(sinceMs) }] }]
      : [],
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
    properties: DEAL_PROPERTIES
  })
}

/** Deal → contact associations via v4 batch read. Returns dealId → contactIds. */
export async function dealContactAssociations(dealIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  for (let i = 0; i < dealIds.length; i += 100) {
    const chunk = dealIds.slice(i, i + 100)
    const payload = await hsFetch('/crm/v4/associations/deals/contacts/batch/read', {
      method: 'POST',
      body: JSON.stringify({ inputs: chunk.map((id) => ({ id })) })
    })
    for (const result of payload?.results ?? []) {
      const from = result?.from?.id
      if (from == null) continue
      const tos: string[] = []
      for (const t of result?.to ?? []) {
        const id = t?.toObjectId ?? t?.id
        if (id != null) tos.push(String(id))
      }
      map.set(String(from), tos)
    }
  }
  return map
}

// ---------- write side (meeting insights → CRM) ----------

/** Owner record for task assignment. */
export async function findOwnerId(email: string): Promise<string | null> {
  const payload = await hsFetch(`/crm/v3/owners?email=${encodeURIComponent(email)}`)
  const id = payload?.results?.[0]?.id
  return id != null ? String(id) : null
}

/**
 * Create a contact. ONLY ever called from an explicit user action (the
 * "Add to HubSpot" buttons) — the insights pipeline never creates contacts.
 */
export async function createContact(email: string, name?: string | null): Promise<string> {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  const properties: Record<string, string> = { email }
  if (parts[0]) properties.firstname = parts[0]
  if (parts.length > 1) properties.lastname = parts.slice(1).join(' ')
  const payload = await hsFetch('/crm/v3/objects/contacts', {
    method: 'POST',
    body: JSON.stringify({ properties })
  })
  return String(payload.id)
}

const NOTE_TO_CONTACT = 202 // HubSpot-defined association type ids
const TASK_TO_CONTACT = 204

function contactAssociations(contactIds: string[], typeId: number) {
  return contactIds.map((id) => ({
    to: { id },
    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }]
  }))
}

/** Create a note engagement associated with the given contacts. Returns note id. */
export async function createNote(bodyHtml: string, contactIds: string[], timestampMs: number): Promise<string> {
  const payload = await hsFetch('/crm/v3/objects/notes', {
    method: 'POST',
    body: JSON.stringify({
      properties: { hs_note_body: bodyHtml.slice(0, 65000), hs_timestamp: String(timestampMs) },
      associations: contactAssociations(contactIds, NOTE_TO_CONTACT)
    })
  })
  return String(payload.id)
}

/** Create a task associated with the given contacts. Returns task id. */
export async function createTask(input: {
  subject: string
  body: string
  dueMs: number
  contactIds: string[]
  ownerId: string | null
}): Promise<string> {
  const properties: Record<string, string> = {
    hs_task_subject: input.subject.slice(0, 250),
    hs_task_body: input.body.slice(0, 5000),
    hs_timestamp: String(input.dueMs),
    hs_task_status: 'NOT_STARTED',
    hs_task_type: 'TODO'
  }
  if (input.ownerId) properties.hubspot_owner_id = input.ownerId
  const payload = await hsFetch('/crm/v3/objects/tasks', {
    method: 'POST',
    body: JSON.stringify({
      properties,
      associations: contactAssociations(input.contactIds, TASK_TO_CONTACT)
    })
  })
  return String(payload.id)
}

export interface HsNoteResult {
  id: string
  body: string | null
  timestamp: string | null // ISO
}

/** Latest note engagements associated with a contact (association list → batch read). */
export async function fetchContactNotes(contactId: string, limit = 10): Promise<HsNoteResult[]> {
  const assoc = await hsFetch(
    `/crm/v4/objects/contacts/${contactId}/associations/notes?limit=${Math.max(limit * 4, 20)}`
  )
  const noteIds: string[] = []
  for (const item of assoc?.results ?? []) {
    const id = item?.toObjectId ?? item?.id
    if (id != null) noteIds.push(String(id))
  }
  if (noteIds.length === 0) return []

  const batch = await hsFetch('/crm/v3/objects/notes/batch/read', {
    method: 'POST',
    body: JSON.stringify({
      inputs: noteIds.slice(0, 50).map((id) => ({ id })),
      properties: ['hs_note_body', 'hs_timestamp', 'hs_createdate']
    })
  })

  const notes: HsNoteResult[] = []
  for (const note of batch?.results ?? []) {
    const props = note?.properties ?? {}
    notes.push({
      id: String(note?.id),
      body: props.hs_note_body ?? null,
      timestamp: props.hs_timestamp ?? props.hs_createdate ?? null
    })
  }
  notes.sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''))
  return notes.slice(0, limit)
}
