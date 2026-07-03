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

/** Substitute cid: image references with resolved data: URLs. */
export function resolveCids(html: string, cidMap: Record<string, string>): string {
  return html.replace(/(["'])cid:([^"']+)\1/gi, (match, quote, cid) => {
    const url = cidMap[cid]
    return url ? `${quote}${url}${quote}` : match
  })
}
