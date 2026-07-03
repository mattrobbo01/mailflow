import { useMemo, useRef, useState } from 'react'
import type { Account, CategoryGroup, ThreadSummary } from '../types.d'
import ThreadRow from './ThreadRow'
import { BellIcon, NewsIcon } from '../components/Icons'

export type MobileView =
  | 'inbox' | 'notifications' | 'newsletters' | 'all' | 'sent' | 'starred' | 'snoozed' | 'done' | 'drafts'

export const VIEW_LABELS: Record<MobileView, string> = {
  inbox: 'Inbox', notifications: 'Notifications', newsletters: 'Newsletters', all: 'Everything',
  sent: 'Sent', starred: 'Starred', snoozed: 'Snoozed', done: 'Done', drafts: 'Drafts'
}

function sectionLabel(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.floor((startOfDay(now) - startOfDay(d)) / 86_400_000)
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return 'This Week'
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'long' })
  return d.toLocaleDateString([], { month: 'long', year: 'numeric' })
}

type Row =
  | { kind: 'header'; label: string }
  | { kind: 'group'; group: CategoryGroup }
  | { kind: 'thread'; t: ThreadSummary }

export default function InboxScreen({
  view, accountFilter, accounts, threads, groups, showDone, refreshing,
  onMenu, onSearch, onBackToInbox, onToggleDone, onOpenGroup, onOpen, onDone, onSnooze, onCompose, onRefresh
}: {
  view: MobileView
  accountFilter?: string
  accounts: Account[]
  threads: ThreadSummary[]
  groups: CategoryGroup[]
  showDone: boolean
  refreshing: boolean
  onMenu: () => void
  onSearch: () => void
  onBackToInbox: () => void
  onToggleDone: () => void
  onOpenGroup: (c: CategoryGroup['category']) => void
  onOpen: (t: ThreadSummary) => void
  onDone: (t: ThreadSummary) => void
  onSnooze: (t: ThreadSummary) => void
  onCompose: () => void
  onRefresh: () => void
}) {
  const unified = accountFilter === undefined

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    let last = ''
    const pushHeader = (label: string) => {
      if (label !== last) {
        out.push({ kind: 'header', label })
        last = label
      }
    }
    if (view === 'inbox' && groups.length > 0) {
      pushHeader('Today')
      for (const g of groups) out.push({ kind: 'group', group: g })
    }
    for (const t of threads) {
      pushHeader(sectionLabel(t.last_ts))
      out.push({ kind: 'thread', t })
    }
    return out
  }, [threads, groups, view])

  // Pull-to-refresh: track downward drag while the scroller is at the top.
  const scrollRef = useRef<HTMLDivElement>(null)
  const pullStart = useRef<number | null>(null)
  const [pull, setPull] = useState(0)

  const title = showDone && view === 'inbox' ? 'Done' : VIEW_LABELS[view]
  const subtitle = unified ? 'All accounts' : accountFilter

  return (
    <div className="flex h-full flex-col bg-[#1b1e24]">
      <header className="shrink-0 border-b border-white/8 px-4 pb-2 pt-[max(env(safe-area-inset-top),12px)]">
        <div className="flex items-center gap-3">
          <button onClick={onMenu} aria-label="Menu" className="-ml-1 rounded-md p-1.5 text-zinc-300 active:bg-white/10">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <line x1="4" y1="7" x2="20" y2="7" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="17" x2="20" y2="17" />
            </svg>
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-[19px] font-bold leading-tight text-zinc-50">{title}</div>
            <div className="truncate text-[12px] text-zinc-500">{subtitle}</div>
          </div>
          {/* show-done toggle, same semantics as the desktop pill */}
          <button
            onClick={onToggleDone}
            aria-label="Show done"
            className={`flex h-[22px] w-10 items-center rounded-full px-0.5 transition-colors ${showDone ? 'bg-[#1f9dad]' : 'bg-white/12'}`}
          >
            <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-full bg-white text-black/60 transition-transform ${showDone ? 'translate-x-[18px]' : ''}`}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
          </button>
          <button onClick={onSearch} aria-label="Search" className="rounded-md p-1.5 text-zinc-300 active:bg-white/10">
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
        </div>
      </header>

      {(refreshing || pull > 0) && (
        <div className="flex shrink-0 items-center justify-center py-1.5 text-[12px] text-zinc-500">
          {refreshing ? 'Refreshing…' : pull > 70 ? 'Release to refresh' : 'Pull to refresh'}
        </div>
      )}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onTouchStart={(e) => {
          if ((scrollRef.current?.scrollTop ?? 1) <= 0) pullStart.current = e.touches[0].clientY
        }}
        onTouchMove={(e) => {
          if (pullStart.current === null) return
          const dy = e.touches[0].clientY - pullStart.current
          setPull(dy > 0 && (scrollRef.current?.scrollTop ?? 1) <= 0 ? dy : 0)
        }}
        onTouchEnd={() => {
          if (pull > 70) onRefresh()
          setPull(0)
          pullStart.current = null
        }}
      >
        {(view === 'notifications' || view === 'newsletters' || view === 'done') && (
          <button
            onClick={onBackToInbox}
            className="sticky top-0 z-10 flex w-full items-center gap-2 border-b border-white/8 bg-[#16181d] px-4 py-3 text-left text-[14px] font-medium text-zinc-300 active:bg-white/5"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back to Inbox
            <span className="ml-auto capitalize text-zinc-500">{VIEW_LABELS[view]}</span>
          </button>
        )}
        {rows.map((row) => {
          if (row.kind === 'header') {
            return (
              <div key={`h:${row.label}`} className="px-4 pb-1 pt-3 text-[12.5px] font-semibold text-zinc-500">
                {row.label}
              </div>
            )
          }
          if (row.kind === 'group') {
            const g = row.group
            const label = g.category === 'notifications' ? 'Notifications' : 'Newsletters'
            const Icon = g.category === 'notifications' ? BellIcon : NewsIcon
            return (
              <button
                key={`g:${g.category}`}
                onClick={() => onOpenGroup(g.category)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left active:bg-white/5"
              >
                <span className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                  g.category === 'notifications' ? 'bg-emerald-900/60 text-emerald-300' : 'bg-amber-900/50 text-amber-300'
                }`}>
                  <Icon />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[15px] font-semibold text-zinc-50">{label}</span>
                    <span className={`rounded-full px-1.5 text-[12px] ${g.unread > 0 ? 'bg-white/10 text-[#35c3d4]' : 'bg-white/6 text-zinc-500'}`}>
                      {g.unread > 0 ? g.unread : g.total}
                    </span>
                  </div>
                  <div className="truncate text-[13px] text-zinc-400">
                    {g.senders.map((s, i) => (
                      <span key={s.name}>
                        {i > 0 && ' · '}
                        {s.name}
                        {s.count > 1 && <span className="text-zinc-600"> {s.count}</span>}
                      </span>
                    ))}
                  </div>
                </div>
              </button>
            )
          }
          const t = row.t
          return (
            <ThreadRow
              key={`${t.account_id}:${t.id}`}
              t={t}
              accounts={accounts}
              unified={unified}
              onOpen={() => onOpen(t)}
              onDone={() => onDone(t)}
              onSnooze={() => onSnooze(t)}
            />
          )
        })}
        {rows.length === 0 && (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-zinc-600">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
            <div className="text-[14px]">{showDone ? 'Nothing marked done here yet' : 'No conversations'}</div>
          </div>
        )}
        <div className="h-24" />
      </div>

      {/* compose FAB, Spark-style */}
      <button
        onClick={onCompose}
        aria-label="Compose"
        className="fixed bottom-[max(env(safe-area-inset-bottom),16px)] right-4 z-20 flex h-14 w-14 items-center justify-center rounded-full bg-[#2b8cf4] text-white shadow-xl active:scale-95"
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>
    </div>
  )
}
