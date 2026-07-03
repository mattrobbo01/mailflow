import { useRef, useEffect, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ThreadSummary, Account, CategoryGroup } from '../types.d'
import { formatTs, participantLine, counterpartOf, initials, avatarColor, accountColor } from '../lib/format'
import { BellIcon, NewsIcon } from './Icons'

interface Props {
  threads: ThreadSummary[]
  accounts: Account[]
  selectedIndex: number
  unified: boolean
  groups?: CategoryGroup[]
  onOpenGroup?: (category: CategoryGroup['category']) => void
  onOpen: (t: ThreadSummary) => void
}

type Row =
  | { kind: 'header'; label: string }
  | { kind: 'group'; group: CategoryGroup }
  | { kind: 'thread'; t: ThreadSummary; threadIndex: number }

function sectionLabel(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const dayMs = 86_400_000
  const diffDays = Math.floor((startOfDay(now) - startOfDay(d)) / dayMs)
  if (diffDays <= 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return 'This Week'
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'long' })
  return d.toLocaleDateString([], { month: 'long', year: 'numeric' })
}

export default function ThreadList({
  threads, accounts, selectedIndex, unified, groups, onOpenGroup, onOpen
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null)
  const selfEmails = accounts.map((a) => a.id.toLowerCase())

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    let lastLabel = ''
    const pushHeader = (label: string) => {
      if (label !== lastLabel) {
        out.push({ kind: 'header', label })
        lastLabel = label
      }
    }
    // Category rollups live under "Today", like Spark.
    if (groups && groups.length > 0) {
      pushHeader('Today')
      for (const g of groups) out.push({ kind: 'group', group: g })
    }
    threads.forEach((t, i) => {
      pushHeader(sectionLabel(t.last_ts))
      out.push({ kind: 'thread', t, threadIndex: i })
    })
    return out
  }, [threads, groups])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (rows[i].kind === 'thread' ? 70 : rows[i].kind === 'group' ? 60 : 26),
    // Identity keys keep the measurement cache correct when headers shift positions.
    getItemKey: (i) => {
      const r = rows[i]
      return r.kind === 'header' ? `h:${r.label}` : r.kind === 'group' ? `g:${r.group.category}` : `${r.t.account_id}:${r.t.id}`
    },
    overscan: 12
  })

  useEffect(() => {
    if (selectedIndex < 0) return
    const rowIndex = rows.findIndex((r) => r.kind === 'thread' && r.threadIndex === selectedIndex)
    if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
  }, [selectedIndex, rows, virtualizer])

  return (
    <div ref={parentRef} className="h-full overflow-y-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index]
          const common = {
            'data-index': vi.index,
            ref: virtualizer.measureElement as any,
            style: { transform: `translateY(${vi.start}px)` } as const
          }

          if (row.kind === 'header') {
            return (
              <div
                key={`h:${row.label}`}
                {...common}
                className="absolute left-0 right-0 px-3 pb-0.5 pt-2 text-[11.5px] font-medium text-zinc-500"
              >
                {row.label}
              </div>
            )
          }

          if (row.kind === 'group') {
            return (
              <div key={`g:${row.group.category}`} {...common} className="absolute left-0 right-0">
                <GroupRow group={row.group} onClick={() => onOpenGroup?.(row.group.category)} />
              </div>
            )
          }

          const { t, threadIndex } = row
          const selected = threadIndex === selectedIndex
          const who = counterpartOf(t, selfEmails)
          return (
            <div
              key={`${t.account_id}:${t.id}`}
              {...common}
              onClick={() => onOpen(t)}
              className={`absolute left-0 right-0 flex cursor-default gap-3 rounded-md px-3 py-2.5
                ${selected ? 'bg-white/10' : 'hover:bg-white/4'}`}
            >
              <span
                className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white/90"
                title={unified ? t.account_id : undefined}
                style={{
                  background: avatarColor(who?.email ?? null),
                  boxShadow: unified
                    ? `0 0 0 1.5px #16181d, 0 0 0 3px ${accountColor(t.account_id, accounts)}55`
                    : undefined
                }}
              >
                {initials(who?.name ?? null, who?.email ?? null)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {t.is_unread ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#35c3d4]" /> : null}
                  <span
                    className={`truncate text-[13px] ${t.is_unread ? 'font-semibold text-zinc-100' : 'font-medium text-zinc-300'}`}
                  >
                    {participantLine(t, selfEmails)}
                  </span>
                  {t.message_count > 1 && (
                    <span className="shrink-0 rounded bg-white/8 px-1 text-[10.5px] text-zinc-400">
                      {t.message_count}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-500">
                    {formatTs(t.last_ts)}
                  </span>
                </div>
                <div className={`truncate text-[12.5px] ${t.is_unread ? 'text-zinc-200' : 'text-zinc-400'}`}>
                  {t.subject || '(no subject)'}
                </div>
                <div className="truncate text-[12px] text-zinc-500">{t.snippet}</div>
              </div>
            </div>
          )
        })}
      </div>
      {threads.length === 0 && (!groups || groups.length === 0) && (
        <div className="flex h-40 items-center justify-center text-sm text-zinc-600">No conversations</div>
      )}
    </div>
  )
}

function GroupRow({ group, onClick }: { group: CategoryGroup; onClick: () => void }) {
  const label = group.category === 'notifications' ? 'Notifications' : 'Newsletters'
  const Icon = group.category === 'notifications' ? BellIcon : NewsIcon
  return (
    <button
      onClick={onClick}
      className="flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left hover:bg-white/4"
    >
      <span
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full
          ${group.category === 'notifications' ? 'bg-emerald-900/60 text-emerald-300' : 'bg-amber-900/50 text-amber-300'}`}
      >
        <Icon />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold text-zinc-100">{label}</span>
          <span className={`text-[12px] ${group.unread > 0 ? 'text-[#35c3d4]' : 'text-zinc-500'}`}>
            {group.unread > 0 ? group.unread : group.total}
          </span>
        </div>
        <div className="truncate text-[12.5px] text-zinc-400">
          {group.senders.map((s, i) => (
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
