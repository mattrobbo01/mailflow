export interface ThreadSummary {
  account_id: string
  id: string
  subject: string
  snippet: string
  last_ts: number
  message_count: number
  is_unread: number
  label_ids: string
  participants: string
}

export interface Message {
  rid: number
  id: string
  account_id: string
  thread_id: string
  from_name: string | null
  from_email: string | null
  to_json: string
  cc_json: string
  ts: number
  snippet: string | null
  label_ids: string
  has_attachments: number
  attachments_json: string
  body_html: string | null
  body_text: string | null
  body_state: 'none' | 'full'
  message_id_header: string | null
  references_header: string | null
}

export interface Person {
  email: string
  name: string | null
  company: string | null
  role: string | null
  hubspot_id: string | null
  robbo2_note: string | null
  last_emailed: number | null
}

export interface HsContact {
  hubspot_id: string
  email: string | null
  properties: string // JSON of HubSpot properties
  updated_at: number | null
}

export interface HsDeal {
  hubspot_id: string
  name: string | null
  stage: string | null
  amount: number | null
  pipeline: string | null
  close_date: number | null
}

export interface HsNote {
  hubspot_id: string
  body: string | null
  created_at: number | null
}

export interface TranscriptSummary {
  id: number
  title: string | null
  started_at: number | null
}

export interface PersonContext {
  person: Person | null
  hsContact: HsContact | null
  deals: HsDeal[]
  notes: HsNote[]
  transcripts: TranscriptSummary[]
  recentThreads: ThreadSummary[]
}

export interface HubSpotStatus {
  configured: boolean
  lastSync: number | null
  contacts: number
  portalId: string | null
}

export interface DraftRow {
  id: number
  account: string
  to_field: string
  cc_field: string
  bcc_field: string
  subject: string
  body: string
  quoted: string | null
  thread_id: string | null
  in_reply_to: string | null
  references_header: string | null
  attachments_json: string
  updated_at: number
  ai_generated: number
  ai_pristine: number
}

export interface AutodraftStatus {
  jobId: number
  state: 'pending' | 'running' | 'done' | 'skipped' | 'superseded' | 'failed'
  triageReason: string | null
  lastError: string | null
  createdAt: number
}

export interface TranscriptInsights {
  transcript_id: number
  state: 'pending' | 'running' | 'done' | 'failed'
  coaching: string | null
  summary: string | null
  tasks_json: string
  hubspot_note_id: string | null
  hubspot_pushed_at: number | null
  hubspot_error: string | null
  last_error: string | null
  updated_at: number
}

export interface CategoryGroup {
  category: 'notifications' | 'newsletters'
  total: number
  unread: number
  senders: { name: string; count: number }[]
}

export interface Account {
  id: string
  display_name: string | null
  backfill_state: 'pending' | 'running' | 'done'
  connected: boolean
}

declare global {
  interface Window {
    mailflow: {
      accounts: () => Promise<{
        accounts: Account[]
        clientsConfigured: { work: boolean; personal: boolean }
      }>
      startAuth: (kind: 'work' | 'personal') => Promise<string>
      listThreads: (opts: {
        account?: string
        view: 'inbox' | 'notifications' | 'newsletters' | 'all' | 'sent' | 'starred' | 'snoozed' | 'done'
        showDone?: boolean
        limit?: number
        beforeTs?: number
      }) => Promise<ThreadSummary[]>
      getThread: (account: string, threadId: string) => Promise<Message[]>
      getThreadSummary: (account: string, threadId: string) => Promise<ThreadSummary | null>
      search: (q: string) => Promise<ThreadSummary[]>
      inlineImages: (account: string, messageId: string) => Promise<Record<string, string>>
      syncNow: () => Promise<void>
      archive: (a: string, t: string) => Promise<void>
      trash: (a: string, t: string) => Promise<void>
      markRead: (a: string, t: string) => Promise<void>
      markUnread: (a: string, t: string) => Promise<void>
      star: (a: string, t: string, on: boolean) => Promise<void>
      snooze: (a: string, t: string, until: number) => Promise<void>
      moveToInbox: (a: string, t: string) => Promise<void>
      setDone: (a: string, t: string, done: boolean) => Promise<void>
      threadGroups: (account?: string, showDone?: boolean) => Promise<CategoryGroup[]>
      sendNow: (mail: unknown) => Promise<number>
      sendUndo: (actionId: number) => Promise<boolean>
      sendSchedule: (mail: unknown, sendAt: number) => Promise<void>
      jobsList: () => Promise<unknown[]>
      jobsCancel: (id: number) => Promise<boolean>
      threadScheduled: (account: string, threadId: string) => Promise<{ id: number; send_at: number; payload: string }[]>
      personForEmail: (email: string) => Promise<PersonContext>
      hubspotSyncNow: () => Promise<void>
      hubspotSetToken: (token: string) => Promise<HubSpotStatus>
      contactsSuggest: (q: string) => Promise<{ email: string; name: string | null }[]>
      draftsList: () => Promise<DraftRow[]>
      draftSave: (d: unknown) => Promise<number>
      draftDelete: (id: number) => Promise<boolean>
      threadDrafts: (account: string, threadId: string) => Promise<DraftRow[]>
      autodraftStatus: (account: string, threadId: string) => Promise<AutodraftStatus | null>
      autodraftRegenerate: (account: string, threadId: string, guidance: string) => Promise<number>
      onAutodraftUpdated: (cb: (p: { account: string; threadId: string; state: string }) => void) => () => void
      signatureGet: (account: string) => Promise<{ html: string } | null>
      signatureImport: (account: string) => Promise<{ html: string } | null>
      signatureSet: (account: string, html: string) => Promise<{ html: string } | null>
      hubspotStatus: () => Promise<HubSpotStatus>
      paletteUsed: (id: string) => Promise<void>
      paletteFrecency: () => Promise<Record<string, number>>
      onSyncUpdated: (cb: (p: { account: string }) => void) => () => void
      transcriptionStart: (title: string, attendees: string[], eventId?: string) => Promise<number>
      transcriptionStop: () => Promise<void>
      transcriptionIsRecording: () => Promise<boolean>
      transcriptionList: () => Promise<unknown[]>
      transcriptionGet: (id: number) => Promise<unknown>
      transcriptionDelete: (id: number) => Promise<void>
      transcriptionRename: (id: number, title: string) => Promise<void>
      transcriptInsights: (id: number) => Promise<TranscriptInsights | null>
      transcriptInsightsGenerate: (id: number) => Promise<boolean>
      transcriptInsightsRepush: (id: number) => Promise<TranscriptInsights | null>
      onTranscriptInsights: (cb: (p: { transcriptId: number; state: string }) => void) => () => void
      meetingsLive: () => Promise<unknown[]>
      notifyTest: () => Promise<boolean>
      pillMoveBy: (dx: number, dy: number) => void
      attachmentOpen: (account: string, messageId: string, attachmentId: string, filename: string) => Promise<string>
      onTranscriptionEvent: (
        cb: (ev: { t: string; ch?: 'mic' | 'sys'; t0?: number; text?: string; spk?: number; rms?: number }) => void
      ) => () => void
      onTranscriptionStarted: (cb: (p: { transcriptId: number; title: string }) => void) => () => void
      onTranscriptionFinished: (
        cb: (p: { transcriptId: number; error: string | null; exportedTo: string | null }) => void
      ) => () => void
      onOpenThread: (cb: (p: { account: string; threadId: string }) => void) => () => void
      onMeetingDetected: (
        cb: (m: { eventId: string; title: string; attendees: { email: string; name?: string }[] }) => void
      ) => () => void
      onBackfillProgress: (cb: (p: { account: string; phase: string; fetched: number }) => void) => () => void
    }
  }
}

export {}
