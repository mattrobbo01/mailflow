// Body extraction for a headless process: prefer body_text; fall back to a
// naive HTML strip. Quoted trails folded with the plain-text sibling of the
// renderer's splitQuotedTrail (src/lib/sanitize.ts) — same rules, no DOM.

export const BODY_TRUNCATE = 2000

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Port of splitQuotedText from src/lib/sanitize.ts — keep the rules in lockstep. */
export function splitQuotedText(text: string): { main: string; hasQuoted: boolean } {
  const lines = text.split('\n')
  const isMarker = (l: string) =>
    /^On .{5,200} wrote:$/.test(l) || /^-{2,}\s*(Original|Forwarded) Message\s*-{2,}$/i.test(l)
  const cut = lines.findIndex((raw) => {
    const l = raw.trim()
    return isMarker(l) || l.startsWith('>')
  })
  if (cut === -1) return { main: text, hasQuoted: false }

  const main = lines.slice(0, cut).join('\n').trim()
  if (main.length < 30) return { main: text, hasQuoted: false }
  // Only fold when the remainder is genuinely a quote trail, not an
  // interleaved reply with fresh answers between quoted lines.
  const rest = lines.slice(cut).map((s) => s.trim()).filter(Boolean)
  const quoted = rest.filter((s) => s.startsWith('>') || isMarker(s)).length
  if (rest.length > 0 && quoted / rest.length < 0.7) return { main: text, hasQuoted: false }
  return { main, hasQuoted: true }
}

export interface BodyResult {
  body: string
  truncated: boolean
  quoted_trail_folded: boolean
}

export function extractBody(
  bodyText: string | null,
  bodyHtml: string | null,
  full: boolean
): BodyResult {
  let text = bodyText?.trim() || (bodyHtml ? htmlToText(bodyHtml) : '')
  let folded = false
  if (!full) {
    const split = splitQuotedText(text)
    text = split.main
    folded = split.hasQuoted
  }
  let truncated = false
  if (!full && text.length > BODY_TRUNCATE) {
    text = text.slice(0, BODY_TRUNCATE)
    truncated = true
  }
  return { body: text, truncated, quoted_trail_folded: folded }
}

export function iso(ts: number | null | undefined): string | null {
  return ts ? new Date(ts * 1000).toISOString() : null
}

export function parseWhen(v: string | undefined, label: string): number | undefined {
  if (!v) return undefined
  const ms = Date.parse(v)
  if (Number.isNaN(ms)) throw new Error(`invalid ${label} date: "${v}" (use ISO 8601)`)
  return Math.floor(ms / 1000)
}
