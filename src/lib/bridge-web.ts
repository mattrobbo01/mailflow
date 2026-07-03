/**
 * Browser (iPhone PWA) implementation of window.mailflow: same surface as the
 * Electron preload, but every call goes over the LAN bridge (POST /rpc/:channel)
 * and events arrive via a single shared EventSource. Keep the channel map in
 * lockstep with electron/preload.ts.
 */

const KEY_STORAGE = 'mailflowKey'

export function pairingKey(): string {
  const fromUrl = new URLSearchParams(location.search).get('key')
  if (fromUrl) {
    localStorage.setItem(KEY_STORAGE, fromUrl)
    return fromUrl
  }
  return localStorage.getItem(KEY_STORAGE) ?? ''
}

export function isPaired(): boolean {
  return pairingKey().length > 0
}

async function rpc(channel: string, ...args: unknown[]): Promise<any> {
  const res = await fetch(`/rpc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-MailFlow-Key': pairingKey() },
    body: JSON.stringify({ args })
  })
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  if (!body.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body.result
}

type EventCb = (payload: any) => void
const eventListeners = new Map<string, Set<EventCb>>()
let source: EventSource | null = null

function ensureEvents() {
  if (source) return
  source = new EventSource(`/events?key=${encodeURIComponent(pairingKey())}`)
  source.onmessage = (e) => {
    try {
      const { channel, payload } = JSON.parse(e.data)
      for (const cb of eventListeners.get(channel) ?? []) cb(payload)
    } catch {
      /* malformed frame */
    }
  }
  // EventSource auto-reconnects; nothing to do on error.
}

function on(channel: string) {
  return (cb: EventCb) => {
    ensureEvents()
    let set = eventListeners.get(channel)
    if (!set) {
      set = new Set()
      eventListeners.set(channel, set)
    }
    set.add(cb)
    return () => {
      set!.delete(cb)
    }
  }
}

export function installWebBridge() {
  const api: Window['mailflow'] = {
    accounts: () => rpc('accounts:list'),
    startAuth: () => Promise.reject(new Error('Connect accounts from MailFlow on the Mac')),
    listThreads: (opts) => rpc('threads:list', opts),
    getThread: (a, t) => rpc('thread:get', a, t),
    getThreadSummary: (a, t) => rpc('thread:summary', a, t),
    search: (q) => rpc('search:query', q),
    inlineImages: (a, m) => rpc('message:inlineImages', a, m),
    syncNow: () => rpc('sync:now'),
    archive: (a, t) => rpc('thread:archive', a, t),
    trash: (a, t) => rpc('thread:trash', a, t),
    markRead: (a, t) => rpc('thread:markRead', a, t),
    markUnread: (a, t) => rpc('thread:markUnread', a, t),
    star: (a, t, on) => rpc('thread:star', a, t, on),
    snooze: (a, t, until) => rpc('thread:snooze', a, t, until),
    moveToInbox: (a, t) => rpc('thread:moveToInbox', a, t),
    setDone: (a, t, done) => rpc('thread:setDone', a, t, done),
    threadGroups: (account, showDone) => rpc('threads:groups', account, showDone),
    sendNow: (mail) => rpc('send:now', mail),
    sendUndo: (actionId) => rpc('send:undo', actionId),
    sendSchedule: (mail, sendAt) => rpc('send:schedule', mail, sendAt),
    jobsList: () => rpc('jobs:list'),
    jobsCancel: (id) => rpc('jobs:cancel', id),
    threadScheduled: (a, t) => rpc('thread:scheduled', a, t),
    personForEmail: (email) => rpc('people:forEmail', email),
    hubspotSyncNow: () => rpc('hubspot:syncNow'),
    hubspotSetToken: (token) => rpc('hubspot:setToken', token),
    contactsSuggest: (q) => rpc('contacts:suggest', q),
    draftsList: () => rpc('drafts:list'),
    draftSave: (d) => rpc('drafts:save', d),
    draftDelete: (id) => rpc('drafts:delete', id),
    signatureGet: (account) => rpc('signature:get', account),
    signatureImport: (account) => rpc('signature:import', account),
    signatureSet: (account, html) => rpc('signature:set', account, html),
    hubspotStatus: () => rpc('hubspot:status'),
    paletteUsed: (id) => rpc('palette:used', id),
    paletteFrecency: () => rpc('palette:frecency'),
    transcriptionStart: (title, attendees, eventId) => rpc('transcription:start', title, attendees, eventId),
    transcriptionStop: () => rpc('transcription:stop'),
    transcriptionIsRecording: () => rpc('transcription:isRecording'),
    transcriptionList: () => rpc('transcription:list'),
    transcriptionGet: (id) => rpc('transcription:get', id),
    meetingsLive: () => rpc('meetings:live'),
    notifyTest: () => rpc('notify:test'),
    // Attachments open in a new Safari tab straight off the bridge (QuickLook
    // previews PDFs/images natively); the desktop shell:open path means nothing here.
    attachmentOpen: async (account, messageId, attachmentId, filename) => {
      const q = new URLSearchParams({ account, messageId, attachmentId, filename, key: pairingKey() })
      window.open(`/attachment?${q}`, '_blank')
      return filename
    },
    onSyncUpdated: on('sync:updated'),
    onBackfillProgress: on('sync:backfill-progress'),
    onTranscriptionEvent: on('transcription:event'),
    onTranscriptionFinished: on('transcription:finished'),
    onMeetingDetected: on('meeting:detected'),
    onOpenThread: () => () => {} // Mac-banner navigation never targets the phone
  }

  // Alias used by Transcripts.tsx outside the typed surface.
  ;(api as any).transcriptsList = (q?: string) => rpc('transcription:list', q)

  window.mailflow = api
}
