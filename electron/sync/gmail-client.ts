import { google, gmail_v1 } from 'googleapis'
import { getAuthClient } from './auth'
import type { MessageRow, Recipient } from '../db/db'

export function getGmail(email: string): gmail_v1.Gmail {
  return google.gmail({ version: 'v1', auth: getAuthClient(email) })
}

// ---------- RFC 2822 header parsing ----------

export function parseAddressList(value: string | undefined | null): Recipient[] {
  if (!value) return []
  // Split on commas not inside quotes or angle brackets.
  const parts: string[] = []
  let depth = 0
  let inQuote = false
  let cur = ''
  for (const ch of value) {
    if (ch === '"') inQuote = !inQuote
    if (!inQuote) {
      if (ch === '<' || ch === '(') depth++
      if (ch === '>' || ch === ')') depth = Math.max(0, depth - 1)
      if (ch === ',' && depth === 0) {
        parts.push(cur)
        cur = ''
        continue
      }
    }
    cur += ch
  }
  if (cur.trim()) parts.push(cur)

  return parts
    .map((p) => {
      const m = p.match(/^\s*(?:"?([^"]*)"?\s*)?<([^>]+)>\s*$/)
      if (m) return { name: (m[1] ?? '').trim(), email: m[2].trim().toLowerCase() }
      const bare = p.trim().replace(/^<|>$/g, '')
      return bare.includes('@') ? { name: '', email: bare.toLowerCase() } : null
    })
    .filter((r): r is Recipient => r !== null)
}

function header(msg: gmail_v1.Schema$Message, name: string): string | undefined {
  return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined
}

function decodeBody(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8')
}

/** Gmail's snippet field arrives HTML-entity-encoded (&#39; etc). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

interface ParsedParts {
  html: string | null
  text: string | null
  attachments: { partId: string; filename: string; mimeType: string; size: number; attachmentId: string }[]
}

function walkParts(part: gmail_v1.Schema$MessagePart | undefined, out: ParsedParts) {
  if (!part) return
  const mime = part.mimeType ?? ''
  if (part.filename && part.body?.attachmentId) {
    out.attachments.push({
      partId: part.partId ?? '',
      filename: part.filename,
      mimeType: mime,
      size: part.body.size ?? 0,
      attachmentId: part.body.attachmentId
    })
  } else if (mime === 'text/html' && part.body?.data && out.html === null) {
    out.html = decodeBody(part.body.data)
  } else if (mime === 'text/plain' && part.body?.data && out.text === null) {
    out.text = decodeBody(part.body.data)
  }
  for (const child of part.parts ?? []) walkParts(child, out)
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Convert a Gmail API message (format=full or format=metadata) to our row shape. */
export function toMessageRow(accountId: string, msg: gmail_v1.Schema$Message, full: boolean): MessageRow {
  const parsed: ParsedParts = { html: null, text: null, attachments: [] }
  if (full) walkParts(msg.payload, parsed)

  const from = parseAddressList(header(msg, 'From'))[0] ?? null
  const bodyText = parsed.text ?? (parsed.html ? stripHtml(parsed.html) : null)

  return {
    account_id: accountId,
    id: msg.id!,
    thread_id: msg.threadId!,
    from_name: from?.name ?? null,
    from_email: from?.email ?? null,
    to_json: JSON.stringify(parseAddressList(header(msg, 'To'))),
    cc_json: JSON.stringify(parseAddressList(header(msg, 'Cc'))),
    reply_to: header(msg, 'Reply-To') ?? null,
    message_id_header: header(msg, 'Message-ID') ?? null,
    references_header: header(msg, 'References') ?? null,
    ts: msg.internalDate ? Math.floor(Number(msg.internalDate) / 1000) : 0,
    snippet: msg.snippet ? decodeEntities(msg.snippet) : null,
    label_ids: JSON.stringify(msg.labelIds ?? []),
    has_attachments: parsed.attachments.length > 0 ? 1 : 0,
    attachments_json: JSON.stringify(parsed.attachments),
    body_html: parsed.html,
    body_text: bodyText,
    body_state: full ? 'full' : 'none'
  }
}

export function subjectOf(msg: gmail_v1.Schema$Message): string {
  return header(msg, 'Subject') ?? '(no subject)'
}

/** Small promise pool with 429/5xx-aware retry, tuned under Gmail's 250 units/user/sec. */
export async function fetchPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  onResult?: (r: R) => void
): Promise<void> {
  let i = 0
  async function worker() {
    while (i < items.length) {
      const item = items[i++]
      let attempt = 0
      for (;;) {
        try {
          const r = await fn(item)
          onResult?.(r)
          break
        } catch (e: any) {
          const status = e?.code ?? e?.response?.status
          attempt++
          if ((status === 429 || status === 403 || (status >= 500 && status < 600)) && attempt <= 5) {
            await new Promise((res) => setTimeout(res, Math.min(30_000, 1000 * 2 ** attempt)))
            continue
          }
          throw e
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
}
