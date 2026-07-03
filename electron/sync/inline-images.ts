import { gmail_v1 } from 'googleapis'
import { getGmail } from './gmail-client'

// contentId (without <>) → data: URL, cached per message
const cache = new Map<string, Record<string, string>>()

function collectCidParts(
  part: gmail_v1.Schema$MessagePart | undefined,
  out: { cid: string; attachmentId: string; mimeType: string }[]
) {
  if (!part) return
  const cidHeader = part.headers?.find((h) => h.name?.toLowerCase() === 'content-id')?.value
  if (cidHeader && part.body?.attachmentId) {
    out.push({
      cid: cidHeader.replace(/^<|>$/g, ''),
      attachmentId: part.body.attachmentId,
      mimeType: part.mimeType ?? 'image/png'
    })
  }
  for (const child of part.parts ?? []) collectCidParts(child, out)
}

/** Resolve a message's cid: inline images to data URLs (fetched once, cached). */
export async function getInlineImages(account: string, messageId: string): Promise<Record<string, string>> {
  const key = `${account}:${messageId}`
  const hit = cache.get(key)
  if (hit) return hit

  const gmail = getGmail(account)
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' })
  const parts: { cid: string; attachmentId: string; mimeType: string }[] = []
  collectCidParts(msg.data.payload, parts)

  const result: Record<string, string> = {}
  for (const p of parts) {
    try {
      const att = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: p.attachmentId
      })
      if (att.data.data) {
        const b64 = Buffer.from(att.data.data, 'base64url').toString('base64')
        result[p.cid] = `data:${p.mimeType};base64,${b64}`
      }
    } catch {
      /* skip broken attachment */
    }
  }
  cache.set(key, result)
  if (cache.size > 200) cache.delete(cache.keys().next().value!) // crude LRU bound
  return result
}
