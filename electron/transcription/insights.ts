import { getDb } from '../db/db'
import { broadcast } from '../broadcast'
import { loadAutodraftConfig } from '../autodraft/config'
import { getEngine } from '../autodraft/engine'
import { createNote, createTask, findOwnerId, isConfigured } from '../hubspot/api'

/**
 * Post-meeting insights: after a recording finishes, the auto-draft engine
 * (headless Claude Code, vault cwd) analyses the transcript and produces
 *   - coaching  → LOCAL ONLY. Matt's private feedback; never leaves this Mac.
 *   - summary   → pushed to HubSpot as a note on the external attendees.
 *   - tasks     → created in HubSpot, assigned to Matt, associated per contact.
 * Rendered as the Coaching and Summary & Tasks tabs in the transcripts view.
 */

export interface InsightTask {
  title: string
  details: string
  dueInDays: number
  contactEmail: string | null
  hubspotTaskId?: string
}

export interface InsightsRow {
  transcript_id: number
  state: 'pending' | 'running' | 'done' | 'failed'
  coaching: string | null
  summary: string | null
  tasks_json: string
  hubspot_note_id: string | null
  hubspot_pushed_at: number | null
  hubspot_error: string | null
  last_error: string | null
  updated_at: number
}

const OWNER_KEY = 'hubspot:ownerId'
const MAX_TRANSCRIPT_CHARS = 30_000

function notify(transcriptId: number, state: string) {
  try {
    broadcast('transcript:insights-updated', { transcriptId, state })
  } catch {
    /* no windows */
  }
}

function upsertState(transcriptId: number, state: string, fields: Partial<Record<string, unknown>> = {}) {
  const db = getDb()
  db.prepare(
    `INSERT INTO transcript_insights (transcript_id, state, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(transcript_id) DO UPDATE SET state = excluded.state, updated_at = unixepoch()`
  ).run(transcriptId, state)
  for (const [k, v] of Object.entries(fields)) {
    if (!/^[a-z_]+$/.test(k)) continue
    db.prepare(`UPDATE transcript_insights SET ${k} = ? WHERE transcript_id = ?`).run(v as any, transcriptId)
  }
  notify(transcriptId, state)
}

// ---------- prompt ----------

function buildInsightsPrompt(transcriptId: number): { prompt: string; externalEmails: string[] } | null {
  const db = getDb()
  const t = db
    .prepare(`SELECT id, title, started_at FROM transcripts WHERE id = ?`)
    .get(transcriptId) as { id: number; title: string | null; started_at: number | null } | undefined
  if (!t) return null

  const segments = db
    .prepare(
      `SELECT speaker, channel, text FROM transcript_segments WHERE transcript_id = ? ORDER BY seq`
    )
    .all(transcriptId) as { speaker: string | null; channel: string; text: string }[]
  if (segments.length === 0) return null

  const attendees = db
    .prepare(
      `SELECT ta.person_email AS email, p.name, p.company, p.role, p.robbo2_note,
              hc.properties AS hs_props
       FROM transcript_attendees ta
       LEFT JOIN people p ON p.email = ta.person_email
       LEFT JOIN hs_contacts hc ON hc.email = ta.person_email
       WHERE ta.transcript_id = ?`
    )
    .all(transcriptId) as any[]

  const selfEmails = new Set(
    (db.prepare(`SELECT lower(id) AS id FROM accounts`).all() as { id: string }[]).map((r) => r.id)
  )
  const external = attendees.filter((a) => a.email && !selfEmails.has(a.email.toLowerCase()))

  let transcript = segments
    .map((s) => `${s.speaker || (s.channel === 'mic' ? 'Matt' : 'Speaker')}: ${s.text}`)
    .join('\n')
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = `${transcript.slice(0, MAX_TRANSCRIPT_CHARS / 2)}\n[…middle truncated…]\n${transcript.slice(-MAX_TRANSCRIPT_CHARS / 2)}`
  }

  const attendeeBlock = external.length
    ? external
        .map((a) => {
          const bits = [a.email, a.name, a.role, a.company].filter(Boolean).join(' · ')
          const props = (() => {
            try {
              const p = JSON.parse(a.hs_props ?? '{}')
              return ['lifecyclestage', 'hs_lead_status'].filter((k) => p[k]).map((k) => `${k}: ${p[k]}`).join(', ')
            } catch {
              return ''
            }
          })()
          return `- ${bits}${props ? ` (HubSpot: ${props})` : ''}${a.robbo2_note ? ` — vault note: ${a.robbo2_note}` : ''}`
        })
        .join('\n')
    : '(none — internal meeting)'

  const when = t.started_at ? new Date(t.started_at * 1000).toISOString().slice(0, 10) : 'unknown date'

  const prompt = `You are analysing a recorded meeting for Matt Robertson (co-founder at Habits, a fintech advisor-consumer platform). Matt ran this call. Your current directory is Matt's Obsidian vault — search it (Grep/Glob, then Read) for notes on the attendees/companies below for context before writing. Read at most ~6 files.

Meeting: "${t.title ?? 'Meeting'}" on ${when}
External attendees:
${attendeeBlock}

Transcript (speaker-labelled):
${transcript}

Produce your analysis as ONLY this JSON object, no other text, no markdown fences:
{
  "summary": "<markdown: 2-4 short paragraphs for the CRM record — purpose of the call, key discussion points, decisions, objections/concerns raised, agreed next steps. Written to be useful to anyone at Habits reading the contact's record later.>",
  "coaching": "<markdown with two sections: '## What went well' and '## What could be better'. This is PRIVATE feedback for Matt on how he ran the call: discovery quality, listening vs talking, objection handling, clarity of next steps, missed opportunities. Be specific — quote or closely paraphrase actual moments from the transcript. Direct and honest beats polite.>",
  "tasks": [{"title": "<imperative, short>", "details": "<1-2 sentences of context>", "dueInDays": <1-14>, "contactEmail": "<one of the external attendee emails, or null for internal follow-ups>"}]
}

Rules:
- tasks: ONLY real commitments or clear next steps from the call (things Matt owes or must chase). No filler tasks. Empty array is a fine answer.
- Do not invent facts, numbers, or commitments not present in the transcript.
- If the call is internal (no external attendees), summary should be brief and tasks mostly null-contact.`

  return { prompt, externalEmails: external.map((a) => a.email.toLowerCase()) }
}

function parseInsights(raw: string): { summary: string; coaching: string; tasks: InsightTask[] } {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('engine returned no JSON')
  const j = JSON.parse(match[0])
  if (typeof j.summary !== 'string' || typeof j.coaching !== 'string') {
    throw new Error('engine JSON missing summary/coaching')
  }
  const tasks: InsightTask[] = Array.isArray(j.tasks)
    ? j.tasks
        .filter((t: any) => t && typeof t.title === 'string' && t.title.trim())
        .map((t: any) => ({
          title: String(t.title).trim(),
          details: String(t.details ?? '').trim(),
          dueInDays: Math.min(30, Math.max(1, Number(t.dueInDays) || 3)),
          contactEmail: typeof t.contactEmail === 'string' && t.contactEmail.includes('@')
            ? t.contactEmail.toLowerCase()
            : null
        }))
    : []
  return { summary: j.summary.trim(), coaching: j.coaching.trim(), tasks }
}

// ---------- HubSpot push ----------

function markdownToNoteHtml(md: string, title: string | null): string {
  const body = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/^### (.+)$/gm, '<strong>$1</strong>')
    .replace(/^## (.+)$/gm, '<strong>$1</strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^- /gm, '• ')
    .replace(/\n/g, '<br>')
  return `<strong>Meeting summary — ${title ?? 'Meeting'} (via MailFlow)</strong><br><br>${body}`
}

async function ownerId(): Promise<string | null> {
  const db = getDb()
  const cached = (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(OWNER_KEY) as any)?.value
  if (cached) return cached
  const accounts = db.prepare(`SELECT id FROM accounts`).all() as { id: string }[]
  for (const a of accounts) {
    try {
      const id = await findOwnerId(a.id)
      if (id) {
        db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
          .run(OWNER_KEY, id)
        return id
      }
    } catch {
      /* try next account */
    }
  }
  return null
}

/** Push summary note + tasks to HubSpot. Coaching NEVER goes here by design. */
async function pushToHubSpot(
  transcriptId: number,
  summary: string,
  tasks: InsightTask[],
  externalEmails: string[]
): Promise<void> {
  const db = getDb()
  if (!isConfigured()) {
    upsertState(transcriptId, 'done', { hubspot_error: 'HubSpot not configured' })
    return
  }
  const contactByEmail = new Map<string, string>()
  for (const email of externalEmails) {
    const row = db.prepare(`SELECT hubspot_id FROM hs_contacts WHERE email = ?`).get(email) as any
    if (row?.hubspot_id) contactByEmail.set(email, String(row.hubspot_id))
  }
  if (contactByEmail.size === 0) {
    upsertState(transcriptId, 'done', { hubspot_error: 'no matching HubSpot contacts for attendees' })
    return
  }

  const t = db.prepare(`SELECT title, started_at FROM transcripts WHERE id = ?`).get(transcriptId) as any
  const when = (t?.started_at ?? Math.floor(Date.now() / 1000)) * 1000
  const allContactIds = [...new Set(contactByEmail.values())]

  try {
    const noteId = await createNote(markdownToNoteHtml(summary, t?.title), allContactIds, when)
    const owner = await ownerId().catch(() => null)
    const updatedTasks: InsightTask[] = []
    for (const task of tasks) {
      const contactId = task.contactEmail ? contactByEmail.get(task.contactEmail) : undefined
      try {
        const taskId = await createTask({
          subject: task.title,
          body: task.details,
          dueMs: Date.now() + task.dueInDays * 86_400_000,
          contactIds: contactId ? [contactId] : allContactIds,
          ownerId: owner
        })
        updatedTasks.push({ ...task, hubspotTaskId: taskId })
      } catch (e: any) {
        updatedTasks.push(task) // note pushed but this task failed — keep it visible locally
        console.error(`[insights] task push failed:`, e?.message ?? e)
      }
    }
    upsertState(transcriptId, 'done', {
      hubspot_note_id: noteId,
      hubspot_pushed_at: Math.floor(Date.now() / 1000),
      hubspot_error: updatedTasks.some((x) => !x.hubspotTaskId && tasks.length) && updatedTasks.length
        ? 'some tasks failed to push'
        : null,
      tasks_json: JSON.stringify(updatedTasks)
    })
  } catch (e: any) {
    // Push failed (likely missing write scopes) — insights stay local + retryable.
    upsertState(transcriptId, 'done', { hubspot_error: String(e?.message ?? e).slice(0, 400) })
  }
}

// ---------- entry points ----------

const inFlight = new Set<number>()

export async function generateInsights(transcriptId: number): Promise<void> {
  if (inFlight.has(transcriptId)) return
  inFlight.add(transcriptId)
  try {
    const built = buildInsightsPrompt(transcriptId)
    if (!built) return
    upsertState(transcriptId, 'running', {
      last_error: null
    })
    getDb().prepare(`UPDATE transcript_insights SET attempts = attempts + 1 WHERE transcript_id = ?`).run(transcriptId)

    const cfg = loadAutodraftConfig()
    const engine = getEngine(cfg)
    const parsed = parseInsights(await engine.draft(built.prompt))

    upsertState(transcriptId, 'running', {
      summary: parsed.summary,
      coaching: parsed.coaching,
      tasks_json: JSON.stringify(parsed.tasks)
    })
    await pushToHubSpot(transcriptId, parsed.summary, parsed.tasks, built.externalEmails)
    console.log(`[insights] transcript ${transcriptId} analysed`)
  } catch (e: any) {
    upsertState(transcriptId, 'failed', { last_error: String(e?.message ?? e).slice(0, 400) })
    console.error(`[insights] transcript ${transcriptId} failed:`, e?.message ?? e)
  } finally {
    inFlight.delete(transcriptId)
  }
}

/** Retry only the HubSpot push (e.g. after scopes were added) without re-analysing. */
export async function repushInsights(transcriptId: number): Promise<void> {
  const row = getInsights(transcriptId)
  if (!row?.summary) return generateInsights(transcriptId)
  const built = buildInsightsPrompt(transcriptId)
  await pushToHubSpot(
    transcriptId,
    row.summary,
    JSON.parse(row.tasks_json ?? '[]').filter((t: InsightTask) => !t.hubspotTaskId),
    built?.externalEmails ?? []
  )
}

export function getInsights(transcriptId: number): InsightsRow | null {
  return (getDb()
    .prepare(`SELECT * FROM transcript_insights WHERE transcript_id = ?`)
    .get(transcriptId) ?? null) as InsightsRow | null
}
