import React, { useCallback, useEffect, useState } from 'react'
import type { AutodraftStatus, DraftRow, Message, ThreadSummary } from '../types.d'
import { sanitizeEmailHtml, emailDocument, resolveCids, splitQuotedTrail, splitQuotedText } from '../lib/sanitize'
import { formatTs, initials, avatarColor } from '../lib/format'
import { ArchiveIcon, TrashIcon, ClockIcon, StarIcon, ReplyIcon, MailIcon, CheckIcon } from './Icons'

export interface ThreadActions {
  onDone: () => void
  onArchive: () => void
  onTrash: () => void
  onSnooze: () => void
  onStar: () => void
  onToggleRead: () => void
  onReply: () => void
}

interface Props {
  thread: ThreadSummary
  actions: ThreadActions
  selfEmails: string[]
  onReplyMessage: (m: Message, all: boolean) => void
  onForwardMessage: (m: Message) => void
  onEditDraft: (d: DraftRow) => void
  onMessages?: (msgs: Message[]) => void
  /** Bump to refetch drafts (e.g. after the composer closes). */
  draftsRefreshKey?: number
}

/**
 * Spark-style auto-condense: the latest message from the other side and
 * everything after it (your replies since) start expanded; older messages
 * collapse to one line. Unread messages never auto-collapse.
 */
export function defaultCollapsed(messages: Message[], selfEmails: string[]): Set<string> {
  const collapsed = new Set<string>()
  if (messages.length < 2) return collapsed
  let lastExternal = -1
  for (let i = 0; i < messages.length; i++) {
    const from = (messages[i].from_email ?? '').toLowerCase()
    if (from && !selfEmails.includes(from)) lastExternal = i
  }
  if (lastExternal === -1) return collapsed // sent-only thread: keep everything open
  for (let i = 0; i < lastExternal; i++) {
    const m = messages[i]
    let unread = false
    try {
      unread = (JSON.parse(m.label_ids) as string[]).includes('UNREAD')
    } catch { /* treat as read */ }
    if (!unread) collapsed.add(m.id)
  }
  return collapsed
}

/** Thread-scoped local drafts + auto-draft job state, kept live via broadcast. */
export function useThreadDrafts(account: string, threadId: string, refreshKey = 0) {
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [adStatus, setAdStatus] = useState<AutodraftStatus | null>(null)

  const reload = useCallback(() => {
    window.mailflow.threadDrafts(account, threadId).then(setDrafts).catch(() => {})
    window.mailflow.autodraftStatus(account, threadId).then(setAdStatus).catch(() => {})
  }, [account, threadId])

  useEffect(() => {
    setDrafts([])
    setAdStatus(null)
    reload()
  }, [reload, refreshKey])

  useEffect(() => {
    return window.mailflow.onAutodraftUpdated((p) => {
      if (p.account === account && p.threadId === threadId) reload()
    })
  }, [account, threadId, reload])

  return { drafts, adStatus, reload }
}

export default function ThreadView({
  thread, actions, selfEmails, onReplyMessage, onForwardMessage, onEditDraft, onMessages, draftsRefreshKey
}: Props) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [scheduled, setScheduled] = useState<{ id: number; send_at: number; payload: string }[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const { drafts, adStatus, reload: reloadDrafts } = useThreadDrafts(thread.account_id, thread.id, draftsRefreshKey)

  useEffect(() => {
    let alive = true
    setMessages(null)
    setScheduled([])
    window.mailflow.getThread(thread.account_id, thread.id).then((msgs) => {
      if (alive) {
        setMessages(msgs)
        onMessages?.(msgs)
      }
    })
    window.mailflow.threadScheduled(thread.account_id, thread.id).then((s) => {
      if (alive) setScheduled(s)
    }).catch(() => {})
    return () => {
      alive = false
    }
  }, [thread.account_id, thread.id])

  // Recompute condense defaults when the messages land AND when accounts finish
  // loading (selfEmails is [] on cold start — without this, own replies would
  // count as external and the wrong cards would collapse).
  const selfKey = selfEmails.join(',')
  useEffect(() => {
    if (messages) setCollapsed(defaultCollapsed(messages, selfKey ? selfKey.split(',') : []))
  }, [messages, selfKey])

  const starred = (JSON.parse(thread.label_ids) as string[]).includes('STARRED')

  const actionButtons: { icon: () => React.ReactElement; title: string; run: () => void; active?: boolean }[] = [
    { icon: CheckIcon, title: 'Mark done (E)', run: actions.onDone },
    { icon: ArchiveIcon, title: 'Archive in Gmail', run: actions.onArchive },
    { icon: TrashIcon, title: 'Trash (#)', run: actions.onTrash },
    { icon: ClockIcon, title: 'Snooze until tomorrow 8am (H)', run: actions.onSnooze },
    { icon: StarIcon, title: starred ? 'Unstar (S)' : 'Star (S)', run: actions.onStar, active: starred },
    { icon: MailIcon, title: 'Mark unread (⇧U)', run: actions.onToggleRead },
    { icon: ReplyIcon, title: 'Reply (R)', run: actions.onReply }
  ]

  return (
    <div className="flex h-full flex-col">
      {/* Action row: subject left, actions right; h-11 aligns its border with the list header */}
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-white/8 px-4">
        <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-zinc-100">
          {thread.subject || '(no subject)'}
        </h1>
        {actionButtons.map((b) => (
          <button
            key={b.title}
            data-tip={b.title}
            onClick={b.run}
            className={`shrink-0 rounded-md p-2 hover:bg-white/8 ${b.active ? 'text-[#35c3d4]' : 'text-zinc-400 hover:text-zinc-200'}`}
          >
            <b.icon />
          </button>
        ))}
      </header>

      {/* Card flow */}
      <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {messages === null && (
          <div className="flex h-32 items-center justify-center text-sm text-zinc-600">Loading…</div>
        )}
        {messages?.map((m) => (
          <MessageCard
            key={m.id}
            message={m}
            showImages={true}
            collapsed={collapsed.has(m.id)}
            onToggle={() =>
              setCollapsed((prev) => {
                const next = new Set(prev)
                if (next.has(m.id)) next.delete(m.id)
                else next.add(m.id)
                return next
              })
            }
            onReply={(all) => onReplyMessage(m, all)}
            onForward={() => onForwardMessage(m)}
          />
        ))}
        {drafts.map((d) => (
          <DraftCard
            key={d.id}
            draft={d}
            busy={!!adStatus && (adStatus.state === 'pending' || adStatus.state === 'running')}
            onEdit={() => onEditDraft(d)}
            onDelete={() => window.mailflow.draftDelete(d.id).then(reloadDrafts)}
          />
        ))}
        {adStatus && (adStatus.state === 'pending' || adStatus.state === 'running') &&
          !drafts.some((d) => d.ai_generated) && <DraftingCard />}
        {scheduled.map((s) => (
          <ScheduledCard
            key={s.id}
            job={s}
            onCancel={() => {
              window.mailflow.jobsCancel(s.id)
              setScheduled((prev) => prev.filter((x) => x.id !== s.id))
            }}
          />
        ))}
      </div>
    </div>
  )
}

export function DraftingCard() {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-amber-400/25 bg-[#22262c] px-4 py-3">
      <span className="h-2 w-2 animate-pulse rounded-full bg-amber-300" />
      <span className="text-[12.5px] text-zinc-400">Drafting a reply…</span>
    </div>
  )
}

/**
 * A saved reply draft rendered inline in the thread flow. AI drafts get a
 * steer box: guidance + Regenerate re-runs the drafting agent on this thread.
 */
export function DraftCard({
  draft, busy, onEdit, onDelete
}: {
  draft: DraftRow
  busy: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const [guidance, setGuidance] = useState('')
  const ai = !!draft.ai_generated

  const regenerate = () => {
    if (busy || !draft.thread_id) return
    window.mailflow.autodraftRegenerate(draft.account, draft.thread_id, guidance.trim()).catch(() => {})
    setGuidance('')
  }

  return (
    <div className="rounded-xl border border-amber-400/25 bg-[#22262c]">
      <div className="flex items-center gap-2 px-4 pb-1 pt-3">
        <span className="text-[13.5px] font-semibold text-zinc-100">You</span>
        <span className="truncate text-[12px] text-zinc-500">to {draft.to_field || '…'}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2.5">
          <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[11px] font-medium text-amber-300">
            {ai ? 'AI draft' : 'Draft'}
          </span>
          <button onClick={onEdit} data-tip="Open in composer" className="text-[11px] text-zinc-500 hover:text-zinc-300">
            Edit
          </button>
          <button onClick={onDelete} data-tip="Delete draft" className="text-[11px] text-zinc-500 hover:text-red-400">
            Delete
          </button>
        </span>
      </div>
      <pre className="whitespace-pre-wrap px-4 pb-3 pt-1 font-sans text-[13.5px] leading-relaxed text-zinc-300">
        {draft.body}
      </pre>
      {ai && draft.thread_id && (
        <div className="flex items-center gap-2 border-t border-white/6 px-4 py-2">
          <input
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') regenerate() }}
            placeholder="Steer this draft — e.g. “say we'll push it to Q3”"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-zinc-300 outline-none placeholder:text-zinc-600"
          />
          <button
            onClick={regenerate}
            disabled={busy}
            className="shrink-0 rounded-md bg-amber-400/15 px-2.5 py-1 text-[11.5px] font-medium text-amber-300 hover:bg-amber-400/25 disabled:opacity-50"
          >
            {busy ? 'Drafting…' : 'Regenerate'}
          </button>
        </div>
      )}
    </div>
  )
}

export function ScheduledCard({ job, onCancel }: { job: { id: number; send_at: number; payload: string }; onCancel: () => void }) {
  let to = ''
  let body = ''
  try {
    const p = JSON.parse(job.payload)
    to = Array.isArray(p.to) ? p.to.join(', ') : ''
    body = p.body ?? ''
  } catch { /* legacy job without body */ }
  const at = new Date(job.send_at * 1000)
  const atLabel = at.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

  return (
    <div className="rounded-xl border border-[#35c3d4]/25 bg-[#22262c]">
      <div className="flex items-center gap-2 px-4 pb-1 pt-3">
        <span className="text-[13.5px] font-semibold text-zinc-100">You</span>
        <span className="truncate text-[12px] text-zinc-500">to {to || '…'}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-[#35c3d4]/15 px-2 py-0.5 text-[11px] font-medium text-[#35c3d4]">
            Scheduled · {atLabel}
          </span>
          <button
            onClick={onCancel}
            data-tip="Cancel send (draft stays in Gmail)"
            className="text-[11px] text-zinc-500 hover:text-zinc-300"
          >
            Cancel
          </button>
        </span>
      </div>
      {body && (
        <pre className="whitespace-pre-wrap px-4 pb-3.5 pt-1 font-sans text-[13.5px] leading-relaxed text-zinc-300">
          {body}
        </pre>
      )}
    </div>
  )
}

export function MessageCard({
  message: m, showImages, collapsed = false, onToggle, onReply, onForward
}: {
  message: Message
  showImages: boolean
  collapsed?: boolean
  onToggle?: () => void
  onReply: (all: boolean) => void
  onForward: () => void
}) {
  const toList = JSON.parse(m.to_json) as { name: string; email: string }[]
  const ccList = JSON.parse(m.cc_json) as { name: string; email: string }[]
  const to = toList.map((r) => r.name || r.email).join(', ')
  const cc = ccList.map((r) => r.name || r.email).join(', ')
  const hasMultipleRecipients = toList.length + ccList.length > 1
  const d = new Date(m.ts * 1000)
  const fullDate = `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`

  // Spark-style condensed row: avatar · sender · snippet preview · time. The
  // whole row is the expand target.
  if (collapsed) {
    return (
      <div
        onClick={onToggle}
        className="flex cursor-pointer items-center gap-3 rounded-xl border border-white/6 bg-[#22262c] px-4 py-2.5 hover:bg-[#262b31]"
      >
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white/90"
          style={{ background: avatarColor(m.from_email) }}
        >
          {initials(m.from_name, m.from_email)}
        </span>
        <span className="shrink-0 text-[13px] font-semibold text-zinc-200">{m.from_name || m.from_email}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-zinc-500">{m.snippet ?? m.body_text ?? ''}</span>
        <span className="shrink-0 text-[11.5px] tabular-nums text-zinc-500" title={formatTs(m.ts)}>
          {fullDate}
        </span>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-white/6 bg-[#22262c]">
      {/* Clicking the header collapses the card (Spark behavior) */}
      <div
        onClick={onToggle}
        className={`flex items-start gap-3 px-4 pb-2 pt-3.5 ${onToggle ? 'cursor-pointer' : ''}`}
      >
        <span
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white/90"
          style={{ background: avatarColor(m.from_email) }}
        >
          {initials(m.from_name, m.from_email)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13.5px] font-semibold text-zinc-100" title={m.from_email ?? ''}>
              {m.from_name || m.from_email}
            </span>
            <span className="ml-auto shrink-0 text-[11.5px] tabular-nums text-zinc-500" title={formatTs(m.ts)}>
              {fullDate}
            </span>
          </div>
          <div className="truncate text-[12px] text-zinc-500" title={cc ? `to ${to} · cc ${cc}` : `to ${to}`}>
            to {to || 'me'}{cc ? ` · cc ${cc}` : ''}
          </div>
        </div>
      </div>
      <MessageBody message={m} showImages={showImages} />
      <AttachmentChips message={m} />
      <div className="flex justify-end gap-1 px-3 pb-2.5">
        <CardButton label="Reply" onClick={() => onReply(false)}><ReplyIcon /></CardButton>
        {hasMultipleRecipients && (
          <CardButton label="Reply all" onClick={() => onReply(true)}><ReplyAllGlyph /></CardButton>
        )}
        <CardButton label="Forward" onClick={onForward}><ForwardGlyph /></CardButton>
      </div>
    </div>
  )
}

function CardButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      data-tip={label}
      onClick={onClick}
      className="rounded-md p-1.5 text-zinc-500 hover:bg-white/8 hover:text-zinc-200"
    >
      {children}
    </button>
  )
}

const glyph = {
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  width: 13, height: 13, viewBox: '0 0 24 24'
}

const ReplyAllGlyph = () => (
  <svg {...glyph}>
    <polyline points="7 17 2 12 7 7" />
    <polyline points="12 17 7 12 12 7" />
    <path d="M22 18v-2a4 4 0 0 0-4-4H7" />
  </svg>
)

const ForwardGlyph = () => (
  <svg {...glyph}>
    <polyline points="15 17 20 12 15 7" />
    <path d="M4 18v-2a4 4 0 0 1 4-4h12" />
  </svg>
)

function AttachmentChips({ message: m }: { message: Message }) {
  const [busy, setBusy] = useState<string | null>(null)
  let atts: { partId: string; filename: string; mimeType: string; size: number; attachmentId: string }[] = []
  try {
    atts = (JSON.parse(m.attachments_json) as typeof atts).filter((a) => a.filename)
  } catch { /* none */ }
  if (atts.length === 0) return null

  const sizeLabel = (n: number) =>
    n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

  return (
    <div className="flex flex-wrap gap-1.5 px-4 pb-2">
      {atts.map((a) => (
        <button
          key={a.attachmentId || a.partId}
          data-tip="Download & open"
          disabled={busy === a.attachmentId}
          onClick={async () => {
            setBusy(a.attachmentId)
            try {
              await window.mailflow.attachmentOpen(m.account_id, m.id, a.attachmentId, a.filename)
            } finally {
              setBusy(null)
            }
          }}
          className="flex items-center gap-1.5 rounded-md border border-white/8 bg-white/4 px-2 py-1 text-[12px] text-zinc-300 hover:bg-white/8 disabled:opacity-50"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
          {a.filename}
          <span className="text-zinc-500">{sizeLabel(a.size)}</span>
        </button>
      ))}
    </div>
  )
}

/** Gmail-style "quoted history hidden here" affordance. */
function QuotedToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <div className="px-4 pb-2">
      <button
        onClick={onToggle}
        data-tip={open ? 'Hide quoted text' : 'Show quoted text'}
        className="rounded-full bg-white/8 px-2.5 py-0.5 text-[11px] font-bold tracking-widest text-zinc-400 hover:bg-white/12 hover:text-zinc-200"
      >
        •••
      </button>
    </div>
  )
}

function MessageBody({ message: m, showImages }: { message: Message; showImages: boolean }) {
  const hasCids = !!m.body_html && m.body_html.includes('cid:')
  const [cidMap, setCidMap] = useState<Record<string, string> | null>(hasCids ? null : {})
  const [showQuoted, setShowQuoted] = useState(false)

  useEffect(() => {
    if (!hasCids) return
    let alive = true
    window.mailflow
      .inlineImages(m.account_id, m.id)
      .then((map) => alive && setCidMap(map))
      .catch(() => alive && setCidMap({}))
    return () => {
      alive = false
    }
  }, [hasCids, m.account_id, m.id])

  if (m.body_html) {
    if (cidMap === null) {
      return <div className="px-4 pb-4 text-[12px] text-zinc-600">Loading…</div>
    }
    const html = resolveCids(m.body_html, cidMap)
    const sanitized = sanitizeEmailHtml(html, showImages)
    const { main, hasQuoted } = splitQuotedTrail(sanitized)
    const doc = emailDocument(hasQuoted && !showQuoted ? main : sanitized)
    return (
      <>
        <iframe
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={doc}
          className="block w-full"
          style={{ border: 'none', minHeight: 60, background: 'transparent' }}
          onLoad={(e) => {
            const frame = e.currentTarget
            const doc = frame.contentDocument
            if (!doc) return
            // Reset before measuring: scrollHeight never reports smaller than the
            // viewport, so a shrinking body (quoted-trail collapse) would stick
            // at the old height otherwise.
            frame.style.height = '0px'
            // Fixed-width marketing layouts (600px tables) overflow narrow frames —
            // scale the whole email down to fit instead of clipping/scrolling.
            // body.scrollWidth still reports the full content width under the
            // overflow-x clip; documentElement's does not.
            const contentW = Math.max(doc.body.scrollWidth, doc.documentElement.scrollWidth)
            const frameW = frame.clientWidth
            if (frameW > 0 && contentW > frameW + 1) {
              ;(doc.body.style as any).zoom = String(frameW / contentW)
            }
            const h = doc.documentElement.scrollHeight
            if (h) frame.style.height = `${Math.min(h + 6, 20000)}px`
            doc.querySelectorAll('a').forEach((a) => {
              a.setAttribute('target', '_blank')
              a.setAttribute('rel', 'noreferrer noopener')
            })
          }}
        />
        {hasQuoted && <QuotedToggle open={showQuoted} onToggle={() => setShowQuoted((v) => !v)} />}
      </>
    )
  }
  const fullText = m.body_text ?? m.snippet ?? ''
  const { main: mainText, hasQuoted: hasQuotedText } = splitQuotedText(fullText)
  return (
    <>
      <pre className="whitespace-pre-wrap px-4 pb-4 pt-1 font-sans text-[13.5px] leading-relaxed text-zinc-200">
        {hasQuotedText && !showQuoted ? mainText : fullText}
      </pre>
      {hasQuotedText && <QuotedToggle open={showQuoted} onToggle={() => setShowQuoted((v) => !v)} />}
    </>
  )
}
