import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { dataDir, getDb } from '../db/db'
import { getInlineImages } from './inline-images'

export interface StoredSignature {
  html: string   // may reference images via src="cid:<id>"
  images: { cid: string; mimeType: string; base64: string }[]
}

type SignatureFile = Record<string, StoredSignature>

const path = () => join(dataDir(), 'signatures.json')

function loadAll(): SignatureFile {
  try {
    return JSON.parse(readFileSync(path(), 'utf8'))
  } catch {
    return {}
  }
}

export function getSignature(account: string): StoredSignature | null {
  return loadAll()[account.toLowerCase()] ?? null
}

export function setSignature(account: string, sig: StoredSignature) {
  const all = loadAll()
  all[account.toLowerCase()] = sig
  writeFileSync(path(), JSON.stringify(all, null, 2))
}

/** Preview form: cid images swapped for data URIs so the renderer can display it. */
export function getSignaturePreview(account: string): { html: string } | null {
  const sig = getSignature(account)
  if (!sig) return null
  let html = sig.html
  for (const img of sig.images) {
    html = html.split(`cid:${img.cid}`).join(`data:${img.mimeType};base64,${img.base64}`)
  }
  return { html }
}

/** Walk <div> nesting from `start` (which must point at a '<div') to its matching close. */
function divBlock(html: string, start: number): string | null {
  const re = /<\/?div\b[^>]*>/gi
  re.lastIndex = start
  let depth = 0
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0][1] === '/' ? -1 : 1
    if (depth === 0) return html.slice(start, m.index + m[0].length)
  }
  return null
}

/**
 * Import the user's signature from their most recent sent mail. Handles the
 * blocks Spark/HubSpot/Gmail emit (hs_signature / gmail_signature divs),
 * resolving inline cid images to stored bytes so we can re-embed them.
 */
export async function importSignatureFromSent(account: string): Promise<{ html: string } | null> {
  const db = getDb()
  const candidates = db
    .prepare(
      `SELECT id, body_html FROM messages
       WHERE account_id = ? AND lower(from_email) = lower(?) AND body_html IS NOT NULL
         AND (body_html LIKE '%hs_signature%' OR body_html LIKE '%gmail_signature%' OR body_html LIKE '%data-hs-signature%')
       ORDER BY ts DESC LIMIT 5`
    )
    .all(account, account) as { id: string; body_html: string }[]

  for (const msg of candidates) {
    const html = msg.body_html
    const markers = ['data-hs-signature', 'class="hs_signature"', 'class="gmail_signature"']
    let at = -1
    for (const marker of markers) {
      const i = html.indexOf(marker)
      if (i >= 0) {
        at = html.lastIndexOf('<div', i)
        break
      }
    }
    if (at < 0) continue
    const block = divBlock(html, at)
    if (!block || block.length < 40) continue

    // Resolve any inline images referenced by cid.
    const cids = [...block.matchAll(/src="cid:([^"]+)"/gi)].map((m) => m[1])
    const images: StoredSignature['images'] = []
    if (cids.length > 0) {
      try {
        const dataUris = await getInlineImages(account, msg.id)
        for (const cid of cids) {
          const uri = dataUris[cid]
          const parsed = uri?.match(/^data:([^;]+);base64,(.+)$/)
          if (parsed) images.push({ cid, mimeType: parsed[1], base64: parsed[2] })
        }
      } catch {
        /* image-less signature is still useful */
      }
    }

    const sig: StoredSignature = { html: block, images }
    setSignature(account, sig)
    return getSignaturePreview(account)
  }
  return null
}

/** Startup convenience: import for any connected account that has no signature yet. */
export async function autoImportSignatures(accounts: string[]) {
  for (const account of accounts) {
    if (!getSignature(account) && existsSync(join(dataDir(), 'mailflow.db'))) {
      try {
        const got = await importSignatureFromSent(account)
        if (got) console.log(`[signatures] imported signature for ${account}`)
      } catch (e: any) {
        console.error(`[signatures] import for ${account}:`, e?.message ?? e)
      }
    }
  }
}
