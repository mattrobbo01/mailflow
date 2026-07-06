#!/usr/bin/env node
// MailFlow MCP server — v1, strictly read-only (spec: Robbo2 vault,
// Projects/MailFlow/mcp-server-spec.md). Stdio transport; direct SQLite reads
// so it works with MailFlow.app closed. No send, no draft, no archive.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { all, get, dbLastModified, resolveAccounts, dbPath } from './db.js'
import { extractBody, iso, parseWhen } from './text.js'

const server = new McpServer({ name: 'mailflow', version: '1.0.0' })

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

function json(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

function wrap<A>(fn: (args: A) => unknown): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return json(fn(args))
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true
      }
    }
  }
}

const accountParam = z
  .string()
  .optional()
  .describe('work | personal | all (default), or a literal account email')

interface ThreadRow {
  account_id: string
  id: string
  subject: string | null
  snippet: string | null
  last_ts: number | null
  message_count: number
  is_unread: number
  participants: string
  category?: string | null
  done_at?: number | null
  snoozed_until?: number | null
}

function threadSummary(t: ThreadRow) {
  return {
    thread_id: t.id,
    account: t.account_id,
    subject: t.subject,
    participants: JSON.parse(t.participants || '[]'),
    date: iso(t.last_ts),
    message_count: t.message_count,
    unread: !!t.is_unread,
    snippet: t.snippet
  }
}

// ---------- search_email ----------

/** Try the query as raw FTS5; if its syntax is invalid, quote every term (app-compiler style). */
function ftsMatchClauses(query: string): string {
  try {
    // LIMIT 1 (not 0): the FTS5 query string is only parsed when the cursor actually runs.
    get('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? LIMIT 1', query)
    return query
  } catch {
    const tokens = query.match(/"[^"]*"|\S+/g) ?? []
    return tokens.map((t) => `"${t.replace(/"/g, '')}"`).join(' ')
  }
}

server.registerTool(
  'search_email',
  {
    title: 'Search email',
    description:
      'Full-history FTS5 search across ALL connected Gmail accounts (work AND personal) via ' +
      "MailFlow's local index. Returns thread summaries; fetch bodies with get_thread.",
    inputSchema: {
      query: z.string().describe('Search text. FTS5 syntax (AND/OR/NEAR/"phrases") allowed.'),
      account: accountParam,
      from: z.string().optional().describe('Filter: sender name or email (substring)'),
      to: z.string().optional().describe('Filter: recipient name or email (substring)'),
      after: z.string().optional().describe('Only messages after this ISO date'),
      before: z.string().optional().describe('Only messages before this ISO date'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20)')
    }
  },
  wrap(({ query, account, from, to, after, before, limit }) => {
    const accounts = resolveAccounts(account)
    const where: string[] = [`m.account_id IN (${accounts.map(() => '?').join(',')})`]
    const params: unknown[] = [ftsMatchClauses(query), ...accounts]
    if (from) {
      where.push('(m.from_email LIKE ? OR m.from_name LIKE ?)')
      params.push(`%${from}%`, `%${from}%`)
    }
    if (to) {
      where.push('m.to_json LIKE ?')
      params.push(`%${to}%`)
    }
    const afterTs = parseWhen(after, 'after')
    const beforeTs = parseWhen(before, 'before')
    if (afterTs) {
      where.push('m.ts > ?')
      params.push(afterTs)
    }
    if (beforeTs) {
      where.push('m.ts < ?')
      params.push(beforeTs)
    }
    params.push(limit ?? 20)

    const rows = all<ThreadRow>(
      `SELECT DISTINCT t.account_id, t.id, t.subject, t.snippet, t.last_ts,
              t.message_count, t.is_unread, t.participants
       FROM messages m
       JOIN messages_fts f ON f.rowid = m.rid AND messages_fts MATCH ?
       JOIN threads t ON t.account_id = m.account_id AND t.id = m.thread_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.last_ts DESC
       LIMIT ?`,
      ...params
    )
    return { results: rows.map(threadSummary), count: rows.length }
  })
)

// ---------- get_thread ----------

server.registerTool(
  'get_thread',
  {
    title: 'Get thread',
    description:
      'Full email thread by id (from search_email / list_recent). Bodies have quoted trails ' +
      'folded and are truncated to ~2000 chars unless full=true.',
    inputSchema: {
      thread_id: z.string().describe('Gmail thread id'),
      account: accountParam,
      full: z.boolean().optional().describe('true = untruncated bodies incl. quoted trails (default false)')
    }
  },
  wrap(({ thread_id, account, full }) => {
    const accounts = resolveAccounts(account)
    const thread = get<ThreadRow>(
      `SELECT account_id, id, subject, snippet, last_ts, message_count, is_unread,
              participants, category, done_at, snoozed_until
       FROM threads
       WHERE id = ? AND account_id IN (${accounts.map(() => '?').join(',')})`,
      thread_id,
      ...accounts
    )
    if (!thread) throw new Error(`thread ${thread_id} not found`)

    const messages = all<{
      id: string
      from_name: string | null
      from_email: string | null
      to_json: string
      cc_json: string
      ts: number | null
      body_text: string | null
      body_html: string | null
      body_state: string
      snippet: string | null
      label_ids: string
      attachments_json: string
    }>(
      `SELECT id, from_name, from_email, to_json, cc_json, ts, body_text, body_html,
              body_state, snippet, label_ids, attachments_json
       FROM messages WHERE account_id = ? AND thread_id = ? ORDER BY ts`,
      thread.account_id,
      thread_id
    )

    return {
      thread_id: thread.id,
      account: thread.account_id,
      subject: thread.subject,
      category: thread.category ?? 'people',
      done: thread.done_at != null,
      snoozed_until: iso(thread.snoozed_until),
      participants: JSON.parse(thread.participants || '[]'),
      messages: messages.map((m) => {
        const hasBody = m.body_state === 'full'
        const body = hasBody
          ? extractBody(m.body_text, m.body_html, !!full)
          : { body: m.snippet ?? '', truncated: false, quoted_trail_folded: false }
        return {
          message_id: m.id,
          from: { name: m.from_name, email: m.from_email },
          to: JSON.parse(m.to_json || '[]'),
          cc: JSON.parse(m.cc_json || '[]'),
          date: iso(m.ts),
          labels: JSON.parse(m.label_ids || '[]'),
          attachments: (JSON.parse(m.attachments_json || '[]') as Record<string, unknown>[]).map(
            (a) => ({ filename: a.filename, mimeType: a.mimeType, size: a.size })
          ),
          ...(hasBody ? {} : { body_note: 'metadata-only message (outside 12mo full-body window); body is the snippet' }),
          ...body
        }
      })
    }
  })
)

// ---------- list_recent ----------

server.registerTool(
  'list_recent',
  {
    title: 'List recent email',
    description:
      'Recent incoming threads across both accounts — the daily-ingestion workhorse ' +
      '(e.g. everything in the people inbox since yesterday 07:00). Includes threads already ' +
      'marked done/archived (done: true) so processed mail still shows up.',
    inputSchema: {
      account: accountParam,
      category: z
        .enum(['people', 'notifications', 'newsletters'])
        .optional()
        .describe('Focused-inbox category filter (default: all categories)'),
      unread_only: z.boolean().optional(),
      since: z.string().optional().describe('ISO date/datetime (default: 24 hours ago)'),
      limit: z.number().int().min(1).max(100).optional().describe('Max threads (default 20)')
    }
  },
  wrap(({ account, category, unread_only, since, limit }) => {
    const accounts = resolveAccounts(account)
    const sinceTs = parseWhen(since, 'since') ?? Math.floor(Date.now() / 1000) - 86400
    const where: string[] = [
      `t.account_id IN (${accounts.map(() => '?').join(',')})`,
      't.last_ts >= ?',
      // incoming mail only: in the inbox now, or archived out of it (done).
      // Sent-only threads have neither and are excluded.
      '(t.is_inbox = 1 OR t.done_at IS NOT NULL)',
      `NOT EXISTS (SELECT 1 FROM json_each(t.label_ids) WHERE value IN ('TRASH','SPAM'))`
    ]
    const params: unknown[] = [...accounts, sinceTs]
    if (category === 'people') where.push(`(t.category IS NULL OR t.category = 'people')`)
    else if (category) {
      where.push('t.category = ?')
      params.push(category)
    }
    if (unread_only) where.push('t.is_unread = 1')
    params.push(limit ?? 20)

    const rows = all<ThreadRow>(
      `SELECT t.account_id, t.id, t.subject, t.snippet, t.last_ts, t.message_count,
              t.is_unread, t.participants, t.category, t.done_at, t.snoozed_until
       FROM threads t
       WHERE ${where.join(' AND ')}
       ORDER BY t.last_ts DESC
       LIMIT ?`,
      ...params
    )
    return {
      since: iso(sinceTs),
      count: rows.length,
      threads: rows.map((t) => ({
        ...threadSummary(t),
        category: t.category ?? 'people',
        done: t.done_at != null,
        snoozed_until: iso(t.snoozed_until)
      }))
    }
  })
)

// ---------- list_transcripts ----------

server.registerTool(
  'list_transcripts',
  {
    title: 'List meeting transcripts',
    description: 'Meeting transcripts recorded by MailFlow (local transcription).',
    inputSchema: {
      since: z.string().optional().describe('ISO date — only meetings started after this'),
      limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)')
    }
  },
  wrap(({ since, limit }) => {
    const sinceTs = parseWhen(since, 'since')
    const rows = all<{
      id: number
      title: string | null
      started_at: number | null
      ended_at: number | null
      markdown_path: string | null
      attendees: string | null
    }>(
      `SELECT tr.id, tr.title, tr.started_at, tr.ended_at, tr.markdown_path,
              (SELECT group_concat(ta.person_email, ', ')
               FROM transcript_attendees ta WHERE ta.transcript_id = tr.id) AS attendees
       FROM transcripts tr
       ${sinceTs ? 'WHERE tr.started_at >= ?' : ''}
       ORDER BY tr.started_at DESC
       LIMIT ?`,
      ...(sinceTs ? [sinceTs] : []),
      limit ?? 20
    )
    return {
      count: rows.length,
      transcripts: rows.map((r) => ({
        transcript_id: r.id,
        title: r.title,
        date: iso(r.started_at),
        duration_minutes:
          r.started_at && r.ended_at ? Math.round((r.ended_at - r.started_at) / 60) : null,
        attendees: r.attendees ? r.attendees.split(', ') : [],
        markdown_path: r.markdown_path
      }))
    }
  })
)

// ---------- get_transcript ----------

server.registerTool(
  'get_transcript',
  {
    title: 'Get transcript',
    description:
      'One meeting transcript. format=summary (default): metadata + AI summary + first/last ' +
      'segments. format=full: every segment.',
    inputSchema: {
      transcript_id: z.number().int().describe('id from list_transcripts'),
      format: z.enum(['summary', 'full']).optional()
    }
  },
  wrap(({ transcript_id, format }) => {
    const tr = get<{
      id: number
      title: string | null
      started_at: number | null
      ended_at: number | null
      markdown_path: string | null
    }>(
      'SELECT id, title, started_at, ended_at, markdown_path FROM transcripts WHERE id = ?',
      transcript_id
    )
    if (!tr) throw new Error(`transcript ${transcript_id} not found`)

    const attendees = all<{ person_email: string }>(
      'SELECT person_email FROM transcript_attendees WHERE transcript_id = ?',
      transcript_id
    ).map((a) => a.person_email)

    const insights = get<{ summary: string | null; tasks_json: string }>(
      `SELECT summary, tasks_json FROM transcript_insights WHERE transcript_id = ? AND state = 'done'`,
      transcript_id
    )

    const segments = all<{ seq: number; speaker: string | null; t0: number | null; text: string | null }>(
      'SELECT seq, speaker, t0, text FROM transcript_segments WHERE transcript_id = ? ORDER BY seq',
      transcript_id
    )
    const fmtSeg = (s: (typeof segments)[number]) => ({
      t: s.t0 != null ? Math.round(s.t0) : null,
      speaker: s.speaker,
      text: s.text
    })

    const base = {
      transcript_id: tr.id,
      title: tr.title,
      date: iso(tr.started_at),
      duration_minutes:
        tr.started_at && tr.ended_at ? Math.round((tr.ended_at - tr.started_at) / 60) : null,
      attendees,
      markdown_path: tr.markdown_path,
      summary: insights?.summary ?? null,
      action_items: insights ? JSON.parse(insights.tasks_json || '[]') : [],
      segment_count: segments.length
    }
    if (format === 'full') return { ...base, segments: segments.map(fmtSeg) }
    return {
      ...base,
      first_segments: segments.slice(0, 8).map(fmtSeg),
      last_segments: segments.length > 16 ? segments.slice(-8).map(fmtSeg) : []
    }
  })
)

// ---------- list_accounts ----------

server.registerTool(
  'list_accounts',
  {
    title: 'List accounts & sync freshness',
    description:
      'The connected Gmail accounts with data-freshness signals. Call this first when recency ' +
      'matters: if the store looks stale, say so instead of presenting results as current.',
    inputSchema: {}
  },
  wrap(() => {
    const accounts = all<{
      id: string
      display_name: string | null
      backfill_state: string
      newest_ts: number | null
      total: number
    }>(
      `SELECT a.id, a.display_name, a.backfill_state,
              (SELECT MAX(ts) FROM messages m WHERE m.account_id = a.id) AS newest_ts,
              (SELECT COUNT(*) FROM messages m WHERE m.account_id = a.id) AS total
       FROM accounts a ORDER BY a.created_at`
    )
    const lastWrite = dbLastModified()
    const now = Math.floor(Date.now() / 1000)
    const staleHours = (now - lastWrite) / 3600
    return {
      db_path: dbPath(),
      db_last_write: iso(lastWrite),
      possibly_stale: staleHours > 6,
      ...(staleHours > 6 && {
        staleness_warning:
          `MailFlow last wrote to its store ${staleHours.toFixed(1)}h ago — the app (or its ` +
          `runner) may not be running, and the personal-account OAuth token expires ~weekly. ` +
          `Treat results as a snapshot, not live.`
      }),
      accounts: accounts.map((a) => ({
        email: a.id,
        display_name: a.display_name,
        kind: a.id.endsWith('@gmail.com') ? 'personal' : 'work',
        backfill_state: a.backfill_state,
        message_count: a.total,
        newest_message_at: iso(a.newest_ts)
      }))
    }
  })
)

const transport = new StdioServerTransport()
await server.connect(transport)
console.error(`mailflow-mcp ready (db: ${dbPath()})`)
