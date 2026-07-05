import DOMPurify from 'dompurify'

/**
 * Sanitize provider HTML for display inside a sandboxed iframe.
 * Remote images are stripped by default (tracking protection); when allowImages
 * is true, http(s) images are permitted but everything active remains banned.
 */
export function sanitizeEmailHtml(html: string, allowImages: boolean): string {
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'meta', 'link', 'base'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'srcset'],
    WHOLE_DOCUMENT: false,
    ALLOW_DATA_ATTR: false
  })

  if (allowImages) return clean

  // Strip remote image sources; keep inline (cid:/data:) images.
  const doc = new DOMParser().parseFromString(clean, 'text/html')
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? ''
    if (/^https?:/i.test(src)) {
      img.setAttribute('data-blocked-src', src)
      img.removeAttribute('src')
      img.style.display = 'none'
    }
  }
  for (const el of Array.from(doc.querySelectorAll('[style]'))) {
    const style = el.getAttribute('style') ?? ''
    if (/url\s*\(\s*['"]?https?:/i.test(style)) {
      el.setAttribute('style', style.replace(/background(-image)?\s*:[^;]+;?/gi, ''))
    }
  }
  return doc.body.innerHTML
}

/**
 * Wrap sanitized HTML in a minimal document for iframe srcdoc rendering.
 * Spark-style dark card: instead of trusting the email's own colors (HTML email
 * assumes white backgrounds), ALL text is forced to light tones and all element
 * backgrounds are stripped, so every email reads correctly on the dark card.
 * Links get the LocalFlow teal. Images are untouched.
 */
export function emailDocument(sanitizedHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid: https: http:; style-src 'unsafe-inline'">
    <style>
      /* Must match the embedder's color-scheme: a mismatch makes the browser
         force an opaque white canvas behind this (otherwise transparent) frame. */
      html { background: transparent; overflow-x: hidden; color-scheme: dark; }
      body { font: 13.5px/1.6 -apple-system, BlinkMacSystemFont, sans-serif;
             margin: 0; padding: 14px 16px; word-break: break-word; overflow-x: hidden; }
      body, body * {
        color: #dde1e6 !important;
        background-color: transparent !important;
        background-image: none !important;
        border-color: rgba(255,255,255,0.14) !important;
        text-shadow: none !important;
      }
      a, a * { color: var(--mf-teal, #35c3d4) !important; }
      blockquote { border-left: 3px solid rgba(255,255,255,0.18); margin-left: 0; padding-left: 12px; }
      blockquote, blockquote * { color: #9aa2ab !important; }
      img { max-width: 100%; height: auto; }
      table { max-width: 100%; }
      pre { white-space: pre-wrap; }
      hr { border: none; border-top: 1px solid rgba(255,255,255,0.14); }
    </style></head><body style="--mf-teal:#35c3d4">${sanitizedHtml}</body></html>`
}

/**
 * Split the quoted reply trail (the embedded copy of earlier messages) off the
 * end of a message body, so threads don't render every message N times.
 * Detection covers the big client conventions: Gmail (div.gmail_quote),
 * Apple Mail (blockquote[type=cite]), Outlook (#divRplyFwdMsg/#appendonsend),
 * plus a generic trailing <blockquote>. Two safety rules keep it honest:
 * only a TRAILING quote folds (interleaved point-by-point replies stay whole),
 * and only when there's real fresh content before it (forwards stay whole).
 */
const QUOTE_SELECTOR =
  'div.gmail_quote, blockquote[type="cite"], #divRplyFwdMsg, #appendonsend, div[id^="divRplyFwdMsg"], div[id^="x_divRplyFwdMsg"], blockquote'

// Outlook-style MARKER headers ("From: … Sent: …"): the quoted message is the
// content AFTER the marker, so the after-check doesn't apply to these.
const MARKER_RE = /(^|\s)(divRplyFwdMsg|x_divRplyFwdMsg|appendonsend)($|\s)/

function isMarker(el: Element): boolean {
  return MARKER_RE.test(el.id) || MARKER_RE.test(el.className)
}

/**
 * Gmail can place the sender's signature BELOW the quoted trail. That's
 * boilerplate, not fresh content — it must not veto the fold (Gmail's own
 * trimmer hides trailing signature + quote together behind the ••• too).
 */
function onlySignatureAfter(doc: Document, body: HTMLElement, el: Element, afterText: string): boolean {
  if (/^--(\s|$)/.test(afterText)) return true // classic "-- " sig delimiter leads the after-content
  const sig = Array.from(body.querySelectorAll('.gmail_signature')).find(
    (s) =>
      el.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING &&
      !(el.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_CONTAINED_BY)
  )
  if (!sig) return false
  const gap = doc.createRange()
  gap.setStartAfter(el)
  gap.setEndBefore(sig)
  return gap.toString().trim().length < 30 // nothing meaningful between quote and signature
}

export function splitQuotedTrail(sanitizedHtml: string): { main: string; hasQuoted: boolean } {
  const doc = new DOMParser().parseFromString(sanitizedHtml, 'text/html')
  const body = doc.body
  if (!(body.textContent ?? '').trim()) return { main: sanitizedHtml, hasQuoted: false }

  for (const el of Array.from(body.querySelectorAll(QUOTE_SELECTOR))) {
    const before = doc.createRange()
    before.setStart(body, 0)
    before.setEndBefore(el)
    const after = doc.createRange()
    after.setStartAfter(el)
    after.setEnd(body, body.childNodes.length)

    if (before.toString().trim().length < 30) continue // forward / pure quote — the quote IS the message
    // Interleaved reply or real content after the quote — keep visible.
    const afterText = after.toString().trim()
    if (!isMarker(el) && afterText.length > 120 && !onlySignatureAfter(doc, body, el, afterText)) continue

    // Fold from the quote (and its cosmetic <hr> lead-in, Outlook-style) to the end.
    let start: Element = el
    if (start.previousElementSibling?.tagName === 'HR') start = start.previousElementSibling
    const cut = doc.createRange()
    cut.setStartBefore(start)
    cut.setEnd(body, body.childNodes.length)
    cut.deleteContents()
    return { main: body.innerHTML, hasQuoted: true }
  }
  return { main: sanitizedHtml, hasQuoted: false }
}

/** Plain-text sibling of splitQuotedTrail: cut at "On … wrote:" / ">" trails. */
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

/** Substitute cid: image references with resolved data: URLs. */
export function resolveCids(html: string, cidMap: Record<string, string>): string {
  return html.replace(/(["'])cid:([^"']+)\1/gi, (match, quote, cid) => {
    const url = cidMap[cid]
    return url ? `${quote}${url}${quote}` : match
  })
}
