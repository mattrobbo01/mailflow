import { useEffect, useState } from 'react'
import type { DraftRow, Message, ThreadSummary } from '../types.d'
import {
  DraftCard, DraftingCard, MessageCard, ScheduledCard, defaultCollapsed, useThreadDrafts
} from '../components/ThreadView'

const bar = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export default function ThreadScreen({
  thread, selfEmails, onBack, onPerson, onMessages, onReplyMessage, onForwardMessage, onEditDraft,
  onDone, onReply, onSnooze, onStar, onMore
}: {
  thread: ThreadSummary
  selfEmails: string[]
  onBack: () => void
  onPerson: () => void
  onMessages: (msgs: Message[]) => void
  onReplyMessage: (m: Message, all: boolean) => void
  onForwardMessage: (m: Message) => void
  onEditDraft: (d: DraftRow) => void
  onDone: () => void
  onReply: () => void
  onSnooze: () => void
  onStar: () => void
  onMore: () => void
}) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [scheduled, setScheduled] = useState<{ id: number; send_at: number; payload: string }[]>([])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const { drafts, adStatus, reload: reloadDrafts } = useThreadDrafts(thread.account_id, thread.id)

  useEffect(() => {
    let alive = true
    setMessages(null)
    setScheduled([])
    window.mailflow.getThread(thread.account_id, thread.id).then((msgs) => {
      if (alive) {
        setMessages(msgs)
        onMessages(msgs)
      }
    })
    window.mailflow.threadScheduled(thread.account_id, thread.id).then((s) => {
      if (alive) setScheduled(s)
    }).catch(() => {})
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.account_id, thread.id])

  // Condense defaults recompute when messages land or accounts finish loading.
  const selfKey = selfEmails.join(',')
  useEffect(() => {
    if (messages) setCollapsed(defaultCollapsed(messages, selfKey ? selfKey.split(',') : []))
  }, [messages, selfKey])

  const starred = (JSON.parse(thread.label_ids) as string[]).includes('STARRED')

  return (
    <div className="mf-screen fixed inset-x-0 top-0 z-30 flex flex-col bg-[#1b1e24] mf-slide-in">
      <header className="flex shrink-0 items-center gap-2 border-b border-white/8 px-2 pb-2 pt-[max(env(safe-area-inset-top),12px)]">
        <button onClick={onBack} aria-label="Back" className="rounded-md p-2 text-zinc-300 active:bg-white/10">
          <svg {...bar}>
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <h1 className="min-w-0 flex-1 truncate text-center text-[15px] font-semibold text-zinc-100">
          {thread.subject || '(no subject)'}
        </h1>
        {/* Person context — replaces the desktop people sidebar (⌘I) */}
        <button onClick={onPerson} aria-label="Contact details" className="rounded-md p-2 text-zinc-300 active:bg-white/10">
          <svg {...bar}>
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21v-1a7 7 0 0 1 7-7h2a7 7 0 0 1 7 7v1" />
          </svg>
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
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
        <div className="h-4" />
      </div>

      {/* bottom action bar, Spark-style */}
      <nav className="flex shrink-0 items-center justify-around border-t border-white/8 bg-[#16181d] px-2 pb-[max(env(safe-area-inset-bottom),10px)] pt-2">
        <button onClick={onDone} aria-label="Done" className="rounded-lg p-2.5 text-zinc-300 active:bg-white/10">
          <svg {...bar}>
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
        <button onClick={onReply} aria-label="Reply" className="rounded-lg p-2.5 text-zinc-300 active:bg-white/10">
          <svg {...bar}>
            <polyline points="9 17 4 12 9 7" />
            <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
          </svg>
        </button>
        <button onClick={onSnooze} aria-label="Snooze" className="rounded-lg p-2.5 text-zinc-300 active:bg-white/10">
          <svg {...bar}>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        </button>
        <button onClick={onStar} aria-label="Star" className={`rounded-lg p-2.5 active:bg-white/10 ${starred ? 'text-[#35c3d4]' : 'text-zinc-300'}`}>
          <svg {...bar} fill={starred ? 'currentColor' : 'none'}>
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        </button>
        <button onClick={onMore} aria-label="More" className="rounded-lg p-2.5 text-zinc-300 active:bg-white/10">
          <svg {...bar}>
            <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
            <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </nav>
    </div>
  )
}
