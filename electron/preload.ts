import { contextBridge, ipcRenderer } from 'electron'

const api = {
  accounts: () => ipcRenderer.invoke('accounts:list'),
  startAuth: (kind: 'work' | 'personal') => ipcRenderer.invoke('auth:start', kind),
  listThreads: (opts: unknown) => ipcRenderer.invoke('threads:list', opts),
  getThread: (account: string, threadId: string) => ipcRenderer.invoke('thread:get', account, threadId),
  getThreadSummary: (account: string, threadId: string) => ipcRenderer.invoke('thread:summary', account, threadId),
  search: (q: string) => ipcRenderer.invoke('search:query', q),
  inlineImages: (account: string, messageId: string) =>
    ipcRenderer.invoke('message:inlineImages', account, messageId),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  archive: (a: string, t: string) => ipcRenderer.invoke('thread:archive', a, t),
  trash: (a: string, t: string) => ipcRenderer.invoke('thread:trash', a, t),
  markRead: (a: string, t: string) => ipcRenderer.invoke('thread:markRead', a, t),
  markUnread: (a: string, t: string) => ipcRenderer.invoke('thread:markUnread', a, t),
  star: (a: string, t: string, on: boolean) => ipcRenderer.invoke('thread:star', a, t, on),
  snooze: (a: string, t: string, until: number) => ipcRenderer.invoke('thread:snooze', a, t, until),
  moveToInbox: (a: string, t: string) => ipcRenderer.invoke('thread:moveToInbox', a, t),
  setDone: (a: string, t: string, done: boolean) => ipcRenderer.invoke('thread:setDone', a, t, done),
  threadGroups: (account?: string, showDone?: boolean) =>
    ipcRenderer.invoke('threads:groups', account, showDone),
  sendNow: (mail: unknown) => ipcRenderer.invoke('send:now', mail),
  sendUndo: (actionId: number) => ipcRenderer.invoke('send:undo', actionId),
  sendSchedule: (mail: unknown, sendAt: number) => ipcRenderer.invoke('send:schedule', mail, sendAt),
  jobsList: () => ipcRenderer.invoke('jobs:list'),
  jobsCancel: (id: number) => ipcRenderer.invoke('jobs:cancel', id),
  threadScheduled: (account: string, threadId: string) =>
    ipcRenderer.invoke('thread:scheduled', account, threadId),
  personForEmail: (email: string) => ipcRenderer.invoke('people:forEmail', email),
  hubspotSyncNow: () => ipcRenderer.invoke('hubspot:syncNow'),
  hubspotSetToken: (token: string) => ipcRenderer.invoke('hubspot:setToken', token),
  contactsSuggest: (q: string) => ipcRenderer.invoke('contacts:suggest', q),
  draftsList: () => ipcRenderer.invoke('drafts:list'),
  draftSave: (d: unknown) => ipcRenderer.invoke('drafts:save', d),
  draftDelete: (id: number) => ipcRenderer.invoke('drafts:delete', id),
  threadDrafts: (account: string, threadId: string) => ipcRenderer.invoke('thread:drafts', account, threadId),
  autodraftStatus: (account: string, threadId: string) => ipcRenderer.invoke('autodraft:status', account, threadId),
  autodraftRegenerate: (account: string, threadId: string, guidance: string) =>
    ipcRenderer.invoke('autodraft:regenerate', account, threadId, guidance),
  signatureGet: (account: string) => ipcRenderer.invoke('signature:get', account),
  signatureImport: (account: string) => ipcRenderer.invoke('signature:import', account),
  signatureSet: (account: string, html: string) => ipcRenderer.invoke('signature:set', account, html),
  hubspotStatus: () => ipcRenderer.invoke('hubspot:status'),
  hubspotCreateContact: (email: string, name?: string) => ipcRenderer.invoke('hubspot:createContact', email, name),
  paletteUsed: (id: string) => ipcRenderer.invoke('palette:used', id),
  paletteFrecency: () => ipcRenderer.invoke('palette:frecency'),
  transcriptionStart: (title: string, attendees: string[], eventId?: string) =>
    ipcRenderer.invoke('transcription:start', title, attendees, eventId),
  transcriptionStop: () => ipcRenderer.invoke('transcription:stop'),
  transcriptionIsRecording: () => ipcRenderer.invoke('transcription:isRecording'),
  transcriptionList: () => ipcRenderer.invoke('transcription:list'),
  transcriptsList: (query?: string) => ipcRenderer.invoke('transcription:list', query),
  transcriptionGet: (id: number) => ipcRenderer.invoke('transcription:get', id),
  transcriptionDelete: (id: number) => ipcRenderer.invoke('transcription:delete', id),
  transcriptionRename: (id: number, title: string) => ipcRenderer.invoke('transcription:rename', id, title),
  transcriptInsights: (id: number) => ipcRenderer.invoke('transcript:insights', id),
  transcriptInsightsGenerate: (id: number) => ipcRenderer.invoke('transcript:insightsGenerate', id),
  transcriptInsightsRepush: (id: number) => ipcRenderer.invoke('transcript:insightsRepush', id),
  onTranscriptInsights: (cb: (p: { transcriptId: number; state: string }) => void) => {
    const listener = (_: unknown, p: any) => cb(p)
    ipcRenderer.on('transcript:insights-updated', listener)
    return () => ipcRenderer.removeListener('transcript:insights-updated', listener)
  },
  revealPath: (path: string) => ipcRenderer.invoke('shell:reveal', path),
  // Recording-pill window only: manual drag (fire-and-forget for smoothness).
  pillMoveBy: (dx: number, dy: number) => ipcRenderer.send('pill:moveBy', dx, dy),
  notifyTest: () => ipcRenderer.invoke('notify:test'),
  attachmentOpen: (account: string, messageId: string, attachmentId: string, filename: string) =>
    ipcRenderer.invoke('attachment:open', account, messageId, attachmentId, filename),
  meetingsLive: () => ipcRenderer.invoke('meetings:live'),
  onTranscriptionEvent: (cb: (ev: any) => void) => {
    const listener = (_: unknown, ev: any) => cb(ev)
    ipcRenderer.on('transcription:event', listener)
    return () => ipcRenderer.removeListener('transcription:event', listener)
  },
  onTranscriptionStarted: (cb: (p: { transcriptId: number; title: string }) => void) => {
    const listener = (_: unknown, p: any) => cb(p)
    ipcRenderer.on('transcription:started', listener)
    return () => ipcRenderer.removeListener('transcription:started', listener)
  },
  onTranscriptionFinished: (cb: (p: { transcriptId: number; error: string | null; exportedTo: string | null }) => void) => {
    const listener = (_: unknown, p: any) => cb(p)
    ipcRenderer.on('transcription:finished', listener)
    return () => ipcRenderer.removeListener('transcription:finished', listener)
  },
  onOpenThread: (cb: (p: { account: string; threadId: string }) => void) => {
    const listener = (_: unknown, p: any) => cb(p)
    ipcRenderer.on('open-thread', listener)
    return () => ipcRenderer.removeListener('open-thread', listener)
  },
  onMeetingDetected: (cb: (m: any) => void) => {
    const listener = (_: unknown, m: any) => cb(m)
    ipcRenderer.on('meeting:detected', listener)
    return () => ipcRenderer.removeListener('meeting:detected', listener)
  },
  onAutodraftUpdated: (cb: (p: { account: string; threadId: string; state: string }) => void) => {
    const listener = (_: unknown, p: any) => cb(p)
    ipcRenderer.on('autodraft:updated', listener)
    return () => ipcRenderer.removeListener('autodraft:updated', listener)
  },
  onSyncUpdated: (cb: (payload: { account: string }) => void) => {
    const listener = (_: unknown, payload: { account: string }) => cb(payload)
    ipcRenderer.on('sync:updated', listener)
    return () => ipcRenderer.removeListener('sync:updated', listener)
  },
  onBackfillProgress: (cb: (p: { account: string; phase: string; fetched: number }) => void) => {
    const listener = (_: unknown, p: any) => cb(p)
    ipcRenderer.on('sync:backfill-progress', listener)
    return () => ipcRenderer.removeListener('sync:backfill-progress', listener)
  }
}

contextBridge.exposeInMainWorld('mailflow', api)

export type MailflowApi = typeof api
