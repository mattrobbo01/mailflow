import { useRef, useState } from 'react'
import type { Account, ThreadSummary } from '../types.d'
import { formatTs, participantLine, counterpartOf, initials, avatarColor, accountColor } from '../lib/format'

const SWIPE_TRIGGER = 88

/**
 * Spark-style list row with swipe gestures: right → done, left → snooze picker.
 * Direction locks after ~12px so vertical scrolling never fights the gesture.
 */
export default function ThreadRow({
  t, accounts, unified, onOpen, onDone, onSnooze
}: {
  t: ThreadSummary
  accounts: Account[]
  unified: boolean
  onOpen: () => void
  onDone?: () => void
  onSnooze?: () => void
}) {
  const selfEmails = accounts.map((a) => a.id.toLowerCase())
  const who = counterpartOf(t, selfEmails)
  const swipeable = Boolean(onDone || onSnooze)

  const [dx, setDx] = useState(0)
  const start = useRef<{ x: number; y: number } | null>(null)
  const axis = useRef<'h' | 'v' | null>(null)

  function onTouchStart(e: React.TouchEvent) {
    if (!swipeable) return
    start.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    axis.current = null
  }
  function onTouchMove(e: React.TouchEvent) {
    if (!start.current) return
    const mx = e.touches[0].clientX - start.current.x
    const my = e.touches[0].clientY - start.current.y
    if (!axis.current && (Math.abs(mx) > 12 || Math.abs(my) > 12)) {
      axis.current = Math.abs(mx) > Math.abs(my) ? 'h' : 'v'
    }
    if (axis.current === 'h') {
      setDx((onDone ? mx > 0 : false) || (onSnooze ? mx < 0 : false) ? mx : 0)
    }
  }
  function onTouchEnd() {
    if (axis.current === 'h') {
      if (dx > SWIPE_TRIGGER && onDone) onDone()
      else if (dx < -SWIPE_TRIGGER && onSnooze) onSnooze()
    }
    setDx(0)
    start.current = null
    axis.current = null
  }

  return (
    <div className="relative overflow-hidden">
      {/* swipe reveal backgrounds */}
      {dx > 0 && (
        <div className="absolute inset-0 flex items-center bg-[#1f9dad] pl-5 text-white">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span className="ml-2 text-[13px] font-semibold">Done</span>
        </div>
      )}
      {dx < 0 && (
        <div className="absolute inset-0 flex items-center justify-end bg-amber-600 pr-5 text-white">
          <span className="mr-2 text-[13px] font-semibold">Snooze</span>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        </div>
      )}

      <div
        onClick={() => Math.abs(dx) < 4 && onOpen()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{ transform: dx !== 0 ? `translateX(${dx}px)` : undefined, transition: dx === 0 ? 'transform 150ms ease' : 'none' }}
        className="relative flex gap-3 bg-[#1b1e24] px-4 py-3 active:bg-white/5"
      >
        <span
          className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-white/90"
          style={{
            background: avatarColor(who?.email ?? null),
            boxShadow: unified
              ? `0 0 0 1.5px #1b1e24, 0 0 0 3px ${accountColor(t.account_id, accounts)}55`
              : undefined
          }}
        >
          {initials(who?.name ?? null, who?.email ?? null)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {t.is_unread ? <span className="h-2 w-2 shrink-0 rounded-full bg-[#35c3d4]" /> : null}
            <span className={`truncate text-[15px] ${t.is_unread ? 'font-semibold text-zinc-50' : 'font-medium text-zinc-300'}`}>
              {participantLine(t, selfEmails)}
            </span>
            {t.message_count > 1 && (
              <span className="shrink-0 rounded bg-white/10 px-1 text-[11px] text-zinc-400">{t.message_count}</span>
            )}
            <span className="ml-auto shrink-0 text-[12px] tabular-nums text-zinc-500">{formatTs(t.last_ts)}</span>
          </div>
          <div className={`truncate text-[13.5px] ${t.is_unread ? 'text-zinc-200' : 'text-zinc-400'}`}>
            {t.subject || '(no subject)'}
          </div>
          <div className="truncate text-[13px] text-zinc-500">{t.snippet}</div>
        </div>
      </div>
    </div>
  )
}
