import { getDb } from '../db/db'
import { AutodraftConfig } from './config'

/**
 * Context assembly + prompt construction for the auto-draft pipeline.
 * Everything MailFlow already knows (thread, person, HubSpot, sent-mail tone
 * corpus, transcript locations) is assembled deterministically here; only the
 * Obsidian vault is left for the drafting agent to search itself.
 */

interface Recipient {
  name: string
  email: string
}

export interface TriggerMessage {
  account_id: string
  id: string
  thread_id: string
  from_name: string | null
  from_email: string | null
  to_json: string
  cc_json: string
  reply_to: string | null
  message_id_header: string | null
  references_header: string | null
  ts: number
  snippet: string | null
  body_text: string | null
  body_html: string | null
}

export function getTriggerMessage(account: string, threadId: string, messageId: string): TriggerMessage | null {
  return (getDb()
    .prepare(
      `SELECT account_id, id, thread_id, from_name, from_email, to_json, cc_json, reply_to,
              message_id_header, references_header, ts, snippet, body_text, body_html
       FROM messages WHERE account_id = ? AND thread_id = ? AND id = ?`
    )
    .get(account, threadId, messageId) ?? null) as TriggerMessage | null
}

/** Crude but effective plain-texting for context blocks (never rendered). */
function bodyOf(m: { body_text: string | null; body_html: string | null; snippet: string | null }): string {
  if (m.body_text) return m.body_text
  if (m.body_html) {
    return m.body_html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s{3,}/g, '\n')
      .trim()
  }
  return m.snippet ?? ''
}

/** Cut a sent email down to Matt's own words: drop quoted trails and reply headers. */
function stripQuoted(text: string): string {
  const lines = text.split('\n')
  const cut = lines.findIndex((l) => /^On .{8,120} wrote:\s*$/.test(l.trim()) || l.trim().startsWith('>'))
  return (cut === -1 ? text : lines.slice(0, cut).join('\n')).trim()
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n[…truncated]`
}

function names(json: string): string {
  try {
    return (JSON.parse(json) as Recipient[]).map((r) => r.name || r.email).join(', ')
  } catch {
    return ''
  }
}

// ---------- triage ----------

export function buildTriagePrompt(trigger: TriggerMessage, subject: string): string {
  const db = getDb()
  // A little thread context helps the gate tell "awaiting Matt's reply" from "FYI".
  const prior = db
    .prepare(
      `SELECT from_name, from_email, snippet FROM messages
       WHERE account_id = ? AND thread_id = ? AND id != ? ORDER BY ts DESC LIMIT 2`
    )
    .all(trigger.account_id, trigger.thread_id, trigger.id) as any[]

  const priorBlock = prior.length
    ? `\nEarlier in this thread (most recent first):\n${prior
        .map((p) => `- ${p.from_name || p.from_email}: ${p.snippet ?? ''}`)
        .join('\n')}\n`
    : ''

  return `You triage email for Matt Robertson (${trigger.account_id}). Decide whether this incoming email warrants a written reply from Matt.

A reply is NOT needed for: automated notifications, receipts, marketing, mailing-list mail, calendar confirmations, pure FYIs, or bare acknowledgements like "thanks!" / "sounds good". Also not needed when Matt is only cc'd and nothing is asked of him.
A reply IS needed when: someone asks Matt a direct question, requests an action or decision from him, makes an introduction or business proposal, or an ongoing conversation is clearly waiting on Matt's response.

From: ${trigger.from_name || ''} <${trigger.from_email ?? ''}>
Subject: ${subject}
To: ${names(trigger.to_json)}${priorBlock}
Body:
${clip(bodyOf(trigger), 4000)}

Answer with ONLY this JSON, nothing else: {"reply": true or false, "reason": "<one short sentence>"}`
}

export function parseTriageVerdict(raw: string): { reply: boolean; reason: string } {
  const match = raw.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const j = JSON.parse(match[0])
      if (typeof j.reply === 'boolean') return { reply: j.reply, reason: String(j.reason ?? '') }
    } catch {
      /* fall through */
    }
  }
  // Unparseable verdict → draft anyway; a wasted draft beats a missed reply.
  return { reply: true, reason: 'triage output unparseable — defaulted to reply' }
}

// ---------- draft ----------

export interface DraftJobInput {
  trigger: TriggerMessage
  subject: string
  guidance: string | null
  previousDraft: string | null
}

export function buildDraftPrompt(input: DraftJobInput, cfg: AutodraftConfig): string {
  const db = getDb()
  const { trigger, subject } = input
  const account = trigger.account_id
  const sender = (trigger.from_email ?? '').toLowerCase()
  const senderName = trigger.from_name || trigger.from_email || 'the sender'

  const thread = db
    .prepare(
      `SELECT from_name, from_email, ts, snippet, body_text, body_html
       FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY ts DESC LIMIT 6`
    )
    .all(account, trigger.thread_id)
    .reverse() as any[]

  const person = db
    .prepare(`SELECT name, company, role, robbo2_note FROM people WHERE email = ?`)
    .get(sender) as any
  const hs = db.prepare(`SELECT hubspot_id, properties FROM hs_contacts WHERE email = ?`).get(sender) as any
  const contactId = hs?.hubspot_id ?? null
  const deals = contactId
    ? (db
        .prepare(
          `SELECT d.name, d.stage, d.amount FROM hs_deals d
           JOIN hs_deal_contacts dc ON dc.deal_id = d.hubspot_id WHERE dc.contact_id = ? LIMIT 5`
        )
        .all(contactId) as any[])
    : []
  const notes = contactId
    ? (db
        .prepare(`SELECT body, created_at FROM hs_notes WHERE contact_id = ? ORDER BY created_at DESC LIMIT 5`)
        .all(contactId) as any[])
    : []

  const recentThreads = db
    .prepare(
      `SELECT subject, snippet, last_ts FROM threads
       WHERE participants LIKE ? AND NOT (account_id = ? AND id = ?)
       ORDER BY last_ts DESC LIMIT 6`
    )
    .all(`%${sender.replace(/[\\%_]/g, '\\$&')}%`, account, trigger.thread_id) as any[]

  const transcripts = db
    .prepare(
      `SELECT t.title, t.started_at, t.markdown_path FROM transcript_attendees a
       JOIN transcripts t ON t.id = a.transcript_id
       WHERE a.person_email = ? AND t.markdown_path IS NOT NULL
       ORDER BY t.started_at DESC LIMIT 2`
    )
    .all(sender) as any[]

  const sentToSender = db
    .prepare(
      `SELECT body_text FROM messages
       WHERE lower(from_email) IN (SELECT lower(id) FROM accounts)
         AND (to_json LIKE ? OR cc_json LIKE ?)
         AND body_text IS NOT NULL AND length(body_text) > 40
       ORDER BY ts DESC LIMIT 3`
    )
    .all(`%${sender}%`, `%${sender}%`) as any[]
  const sentGeneral = db
    .prepare(
      `SELECT body_text FROM messages
       WHERE account_id = ? AND lower(from_email) IN (SELECT lower(id) FROM accounts)
         AND body_text IS NOT NULL AND length(body_text) BETWEEN 100 AND 4000
       ORDER BY ts DESC LIMIT 3`
    )
    .all(account) as any[]
  const voice = [...sentToSender, ...sentGeneral]
    .map((r) => stripQuoted(r.body_text))
    .filter((t) => t.length > 30)
    .slice(0, 5)

  const fmtTs = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10)
  const sections: string[] = []

  sections.push(`You are drafting an email reply on behalf of Matt Robertson, sending from ${account}.
Today's date: ${new Date().toISOString().slice(0, 10)}.
Your FINAL message must be ONLY the reply body text — no subject line, no signature block, no quoted original, no commentary, no markdown code fences.`)

  sections.push(
    `# The thread (oldest first)\n` +
      thread
        .map((m) => `--- ${m.from_name || m.from_email} · ${fmtTs(m.ts)} ---\n${clip(bodyOf(m), 2500)}`)
        .join('\n\n')
  )

  sections.push(`# The message to reply to
From: ${senderName} <${trigger.from_email ?? ''}>
Subject: ${subject}
To: ${names(trigger.to_json)}
Cc: ${names(trigger.cc_json)}`)

  const about: string[] = []
  if (person?.name || person?.company || person?.role) {
    about.push(`${person?.name ?? senderName}${person?.role ? ` — ${person.role}` : ''}${person?.company ? ` at ${person.company}` : ''}`)
  }
  if (hs?.properties) {
    try {
      const p = JSON.parse(hs.properties)
      const keep = ['lifecyclestage', 'jobtitle', 'company', 'city', 'state', 'hs_lead_status']
      const kv = keep.filter((k) => p[k]).map((k) => `${k}: ${p[k]}`)
      if (kv.length) about.push(`HubSpot: ${kv.join(' · ')}`)
    } catch {
      /* skip */
    }
  }
  for (const d of deals) about.push(`Deal: ${d.name ?? '?'} — stage ${d.stage ?? '?'}${d.amount ? `, $${d.amount}` : ''}`)
  for (const n of notes) {
    if (n.body) about.push(`HubSpot note (${n.created_at ? fmtTs(n.created_at) : '?'}): ${clip(String(n.body).replace(/<[^>]+>/g, ' ').trim(), 500)}`)
  }
  if (about.length) sections.push(`# About the sender\n${about.join('\n')}`)

  if (recentThreads.length) {
    sections.push(
      `# Recent email history with this person\n` +
        recentThreads.map((t) => `- ${fmtTs(t.last_ts)} · ${t.subject ?? '(no subject)'}: ${t.snippet ?? ''}`).join('\n')
    )
  }

  if (transcripts.length) {
    sections.push(
      `# Meeting transcripts with this person (files in the current directory tree)\n` +
        transcripts.map((t) => `- ${t.markdown_path} (${t.title ?? 'meeting'}, ${t.started_at ? fmtTs(t.started_at) : '?'})`).join('\n')
    )
  }

  if (voice.length) {
    sections.push(
      `# How Matt writes — recent emails he sent. Match this voice: greeting style, sign-off, directness, typical length.\n` +
        voice.map((v, i) => `--- example ${i + 1} ---\n${clip(v, 1500)}`).join('\n\n')
    )
  }

  const vaultBits: string[] = []
  vaultBits.push(`Your current directory is Matt's Obsidian vault ("${cfg.vaultPath}").`)
  if (person?.robbo2_note) vaultBits.push(`There is a note about this person at: ${person.robbo2_note} — read it.`)
  vaultBits.push(
    `Search the vault (Grep/Glob, then Read) for extra context on "${senderName}"${person?.company ? ` and "${person.company}"` : ''} — check People/, Projects/, and meeting notes. Read at most ~8 files, then write the reply.`
  )
  sections.push(`# Gather vault context first\n${vaultBits.join('\n')}`)

  const rules = [
    `Write the reply in Matt's voice, based on everything above.`,
    `Do not invent facts, commitments, dates, or numbers that aren't supported by the context. If something needs confirming, phrase it the way Matt would ("let me check and come back to you").`,
    `Keep it as long as Matt would make it — usually short and direct.`,
    `No signature (it is appended automatically) and no quoted original text.`
  ]
  if (input.guidance) {
    rules.unshift(`Matt's guidance for this reply (follow it above all else): ${input.guidance}`)
  }
  if (input.previousDraft) {
    sections.push(`# Previous draft (revise it per Matt's guidance rather than starting from scratch)\n${clip(input.previousDraft, 3000)}`)
  }
  sections.push(`# Write the reply\n${rules.map((r) => `- ${r}`).join('\n')}\n\nOutput ONLY the reply body text.`)

  return sections.join('\n\n')
}

/** Strip accidental wrapping the model sometimes adds around the body. */
export function cleanDraftBody(raw: string): string {
  let s = raw.trim()
  const fence = s.match(/^```[a-z]*\n([\s\S]*?)\n```$/)
  if (fence) s = fence[1].trim()
  return s
}
