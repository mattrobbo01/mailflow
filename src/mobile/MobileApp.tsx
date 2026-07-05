import { useCallback, useEffect, useRef, useState } from 'react'
import type { Account, CategoryGroup, DraftRow, Message, ThreadSummary } from '../types.d'
import { ComposerSeed, replySeed, forwardSeed, draftSeed } from '../components/Composer'
import InboxScreen, { MobileView } from './InboxScreen'
import ThreadScreen from './ThreadScreen'
import SearchScreen from './SearchScreen'
import ComposeScreen from './ComposeScreen'
import PersonSheet from './PersonSheet'
import Drawer from './Drawer'
import Sheet from './Sheet'
import { formatTs } from '../lib/format'

interface Toast {
  message: string
  undo?: () => void
}

function at(dayOffset: number, hour: number): number {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

const SNOOZE_PRESETS: { label: string; until: () => number }[] = [
  { label: 'This evening 6pm', until: () => at(0, 18) },
  { label: 'Tomorrow 8am', until: () => at(1, 8) },
  { label: 'Tomorrow 1pm', until: () => at(1, 13) },
  {
    label: 'Saturday 9am',
    until: () => {
      const d = new Date()
      d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7))
      d.setHours(9, 0, 0, 0)
      return Math.floor(d.getTime() / 1000)
    }
  },
  { label: 'Next Monday 8am', until: () => at(((8 - new Date().getDay()) % 7) || 7, 8) }
]

function MobileDrafts({ onOpen, onBack }: { onOpen: (d: DraftRow) => void; onBack: () => void }) {
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null)
  useEffect(() => {
    window.mailflow.draftsList().then(setDrafts).catch(() => setDrafts([]))
  }, [])
  if (drafts === null) return <div className="p-6 text-[13px] text-zinc-600">Loading…</div>
  if (drafts.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-3 px-8 text-center text-[14px] text-zinc-600">
        No drafts — close a compose with content to save one
        <button onClick={onBack} className="text-[#35c3d4]">Back to Inbox</button>
      </div>
    )
  }
  return (
    <div>
      {drafts.map((d) => (
        <button
          key={d.id}
          onClick={() => onOpen(d)}
          className="block w-full border-b border-white/5 px-4 py-3 text-left active:bg-white/5"
        >
          <div className="flex items-center gap-2">
            <span className="truncate text-[15px] font-medium text-zinc-200">{d.subject || '(no subject)'}</span>
            <span className="ml-auto shrink-0 text-[12px] tabular-nums text-zinc-500">{formatTs(d.updated_at)}</span>
          </div>
          <div className="truncate text-[13px] text-zinc-500">to {d.to_field || '…'} · {d.account}</div>
          <div className="truncate text-[13px] text-zinc-500">{d.body}</div>
        </button>
      ))}
    </div>
  )
}

export default function MobileApp() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loaded, setLoaded] = useState(false)
  const [accountFilter, setAccountFilter] = useState<string | undefined>(undefined)
  const [view, setView] = useState<MobileView>('inbox')
  const [showDone, setShowDone] = useState(false)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [groups, setGroups] = useState<CategoryGroup[]>([])
  const [openThread, setOpenThread] = useState<ThreadSummary | null>(null)
  const openMessagesRef = useRef<Message[]>([])

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [personOpen, setPersonOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [snoozeFor, setSnoozeFor] = useState<ThreadSummary | null>(null)
  const [composer, setComposer] = useState<ComposerSeed | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showToast = useCallback((t: Toast, ms = 5000) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(t)
    toastTimer.current = setTimeout(() => setToast(null), ms)
  }, [])

  const connectedAccounts = accounts.filter((a) => a.connected)
  const selfEmails = connectedAccounts.map((a) => a.id.toLowerCase())

  const refreshAccounts = useCallback(async () => {
    try {
      const res = await window.mailflow.accounts()
      setAccounts(res.accounts)
    } finally {
      setLoaded(true)
    }
  }, [])

  const refreshThreads = useCallback(async () => {
    if (view === 'drafts') {
      setThreads([])
      setGroups([])
      return
    }
    const listView = view === 'done' ? 'inbox' : view
    const done = view === 'done' ? true : showDone
    setThreads(await window.mailflow.listThreads({ account: accountFilter, view: listView, showDone: done, limit: 300 }))
    setGroups(view === 'inbox' ? await window.mailflow.threadGroups(accountFilter, done) : [])
  }, [accountFilter, view, showDone])

  useEffect(() => { refreshAccounts() }, [refreshAccounts])
  useEffect(() => { refreshThreads() }, [refreshThreads])

  useEffect(() => {
    return window.mailflow.onSyncUpdated(() => {
      refreshThreads()
      refreshAccounts()
    })
  }, [refreshThreads, refreshAccounts])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await window.mailflow.syncNow()
      await refreshThreads()
    } finally {
      setRefreshing(false)
    }
  }, [refreshThreads])

  // ---------- actions ----------

  const removeFromList = useCallback((removed: ThreadSummary) => {
    const same = (t: ThreadSummary) => t.account_id === removed.account_id && t.id === removed.id
    setThreads((prev) => prev.filter((t) => !same(t)))
    setOpenThread((prev) => (prev && same(prev) ? null : prev))
  }, [])

  const inDoneList = view === 'done' || showDone

  const doDone = useCallback((t: ThreadSummary) => {
    const unDone = inDoneList // in a done list the action puts it back
    window.mailflow.setDone(t.account_id, t.id, !unDone)
    removeFromList(t)
    showToast({
      message: unDone ? 'Moved back to inbox' : 'Done',
      undo: () => {
        window.mailflow.setDone(t.account_id, t.id, unDone)
        refreshThreads()
      }
    })
  }, [inDoneList, removeFromList, showToast, refreshThreads])

  const doTrash = useCallback((t: ThreadSummary) => {
    window.mailflow.trash(t.account_id, t.id)
    removeFromList(t)
    showToast({ message: 'Moved to trash' })
  }, [removeFromList, showToast])

  const doArchive = useCallback((t: ThreadSummary) => {
    window.mailflow.archive(t.account_id, t.id)
    removeFromList(t)
    showToast({
      message: 'Archived',
      undo: () => {
        window.mailflow.moveToInbox(t.account_id, t.id)
        refreshThreads()
      }
    })
  }, [removeFromList, showToast, refreshThreads])

  const doSnooze = useCallback((t: ThreadSummary, until: number, label: string) => {
    window.mailflow.snooze(t.account_id, t.id, until)
    removeFromList(t)
    setSnoozeFor(null)
    showToast({ message: `Snoozed until ${label}` })
  }, [removeFromList, showToast])

  const doStar = useCallback((t: ThreadSummary) => {
    const starred = (JSON.parse(t.label_ids) as string[]).includes('STARRED')
    window.mailflow.star(t.account_id, t.id, !starred)
    const labels = JSON.stringify(
      starred ? (JSON.parse(t.label_ids) as string[]).filter((l) => l !== 'STARRED')
              : [...(JSON.parse(t.label_ids) as string[]), 'STARRED']
    )
    setOpenThread((prev) => (prev && prev.id === t.id ? { ...prev, label_ids: labels } : prev))
    refreshThreads()
  }, [refreshThreads])

  const doToggleRead = useCallback((t: ThreadSummary) => {
    if (t.is_unread) window.mailflow.markRead(t.account_id, t.id)
    else window.mailflow.markUnread(t.account_id, t.id)
    refreshThreads()
  }, [refreshThreads])

  const onOpen = useCallback((t: ThreadSummary) => {
    setSearchOpen(false)
    setOpenThread(t)
    if (t.is_unread) {
      window.mailflow.markRead(t.account_id, t.id)
      setThreads((prev) => prev.map((x) => (x.id === t.id && x.account_id === t.account_id ? { ...x, is_unread: 0 } : x)))
    }
  }, [])

  const openThreadById = useCallback(async (accountId: string, threadId: string) => {
    const t =
      threads.find((x) => x.account_id === accountId && x.id === threadId) ??
      (await window.mailflow.getThreadSummary(accountId, threadId))
    if (t) {
      setPersonOpen(false)
      onOpen(t)
    }
  }, [threads, onOpen])

  const doReply = useCallback((all = false) => {
    const t = openThread
    if (!t) return
    const msgs = openMessagesRef.current
    const last = msgs[msgs.length - 1]
    if (last) setComposer(replySeed(t, last, selfEmails, all))
    else window.mailflow.getThread(t.account_id, t.id).then((m) => {
      if (m.length) setComposer(replySeed(t, m[m.length - 1], selfEmails, all))
    })
  }, [openThread, selfEmails])

  // First participant on the open thread who isn't one of the connected accounts.
  const counterpart = (() => {
    if (!openThread) return null
    try {
      const people = JSON.parse(openThread.participants) as { name: string; email: string }[]
      return people.find((p) => p.email && !selfEmails.includes(p.email.toLowerCase())) ?? null
    } catch {
      return null
    }
  })()

  // ---------- render ----------

  if (loaded && connectedAccounts.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <div className="text-[17px] font-semibold text-zinc-100">No accounts connected</div>
        <div className="text-[14px] leading-relaxed text-zinc-400">
          Google sign-in happens on the Mac — open MailFlow there and connect, then pull to refresh here.
        </div>
      </div>
    )
  }

  return (
    <div className="mobile-root h-full">
      {view === 'drafts' ? (
        <div className="flex h-full flex-col bg-[#1b1e24]">
          <header className="flex shrink-0 items-center gap-3 border-b border-white/8 px-4 pb-2 pt-[max(env(safe-area-inset-top),12px)]">
            <button onClick={() => setDrawerOpen(true)} aria-label="Menu" className="-ml-1 rounded-md p-1.5 text-zinc-300 active:bg-white/10">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="4" y1="7" x2="20" y2="7" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="17" x2="20" y2="17" />
              </svg>
            </button>
            <div className="text-[19px] font-bold text-zinc-50">Drafts</div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <MobileDrafts
              onBack={() => setView('inbox')}
              onOpen={(d) => setComposer(draftSeed(d))}
            />
          </div>
        </div>
      ) : (
        <InboxScreen
          view={view}
          accountFilter={accountFilter}
          accounts={connectedAccounts}
          threads={threads}
          groups={groups}
          showDone={showDone}
          refreshing={refreshing}
          onMenu={() => setDrawerOpen(true)}
          onSearch={() => setSearchOpen(true)}
          onBackToInbox={() => {
            setView('inbox')
            setShowDone(false)
          }}
          onToggleDone={() => setShowDone((v) => !v)}
          onOpenGroup={(c) => setView(c)}
          onOpen={onOpen}
          onDone={doDone}
          onSnooze={(t) => setSnoozeFor(t)}
          onCompose={() => setComposer({ account: accountFilter ?? connectedAccounts[0]?.id ?? '' })}
          onRefresh={onRefresh}
        />
      )}

      {openThread && (
        <ThreadScreen
          thread={openThread}
          selfEmails={selfEmails}
          onBack={() => setOpenThread(null)}
          onPerson={() => setPersonOpen(true)}
          onMessages={(msgs) => { openMessagesRef.current = msgs }}
          onReplyMessage={(m, all) => setComposer(replySeed(openThread, m, selfEmails, all))}
          onForwardMessage={(m) => setComposer(forwardSeed(openThread, m))}
          onEditDraft={(d) => setComposer(draftSeed(d))}
          onDone={() => doDone(openThread)}
          onReply={() => doReply()}
          onSnooze={() => setSnoozeFor(openThread)}
          onStar={() => doStar(openThread)}
          onMore={() => setMoreOpen(true)}
        />
      )}

      <Drawer
        open={drawerOpen}
        view={view}
        accountFilter={accountFilter}
        accounts={connectedAccounts}
        onClose={() => setDrawerOpen(false)}
        onView={(v) => {
          setView(v)
          setShowDone(false)
          setOpenThread(null)
          setDrawerOpen(false)
        }}
        onAccount={(id) => {
          setAccountFilter(id)
          setOpenThread(null)
          setDrawerOpen(false)
        }}
      />

      {searchOpen && (
        <SearchScreen accounts={connectedAccounts} onClose={() => setSearchOpen(false)} onOpen={onOpen} />
      )}

      {personOpen && openThread && (
        <PersonSheet
          email={counterpart?.email ?? null}
          name={counterpart?.name || undefined}
          onClose={() => setPersonOpen(false)}
          onOpenThread={openThreadById}
        />
      )}

      {snoozeFor && (
        <Sheet title="Snooze until…" onClose={() => setSnoozeFor(null)}>
          <div className="px-4 py-2">
            {SNOOZE_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => doSnooze(snoozeFor, p.until(), p.label)}
                className="block w-full border-b border-white/5 py-3 text-left text-[15px] text-zinc-200 active:bg-white/5"
              >
                {p.label}
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {moreOpen && openThread && (
        <Sheet onClose={() => setMoreOpen(false)}>
          <div className="px-4 py-1">
            {[
              { label: 'Reply all', run: () => doReply(true) },
              {
                label: 'Forward',
                run: () => {
                  const last = openMessagesRef.current[openMessagesRef.current.length - 1]
                  if (last) setComposer(forwardSeed(openThread, last))
                }
              },
              { label: openThread.is_unread ? 'Mark read' : 'Mark unread', run: () => doToggleRead(openThread) },
              { label: 'Archive (Gmail)', run: () => doArchive(openThread) },
              { label: 'Move to inbox', run: () => { window.mailflow.moveToInbox(openThread.account_id, openThread.id); refreshThreads(); showToast({ message: 'Moved to inbox' }) } },
              { label: 'Move to trash', run: () => doTrash(openThread), danger: true }
            ].map((item: { label: string; run: () => void; danger?: boolean }) => (
              <button
                key={item.label}
                onClick={() => {
                  setMoreOpen(false)
                  item.run()
                }}
                className={`block w-full border-b border-white/5 py-3.5 text-left text-[15px] active:bg-white/5 ${
                  item.danger ? 'text-red-400' : 'text-zinc-200'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {composer && (
        <ComposeScreen
          accounts={connectedAccounts}
          seed={composer}
          onClose={() => setComposer(null)}
          onSent={(undoId, summary) => {
            showToast({
              message: summary,
              undo: undoId !== null
                ? () => {
                    window.mailflow.sendUndo(undoId).then((ok) =>
                      showToast({ message: ok ? 'Send cancelled' : 'Too late — already sent' })
                    )
                  }
                : undefined
            }, undoId !== null ? 10_000 : 5000)
          }}
        />
      )}

      {toast && (
        <div className="fixed inset-x-4 bottom-[max(env(safe-area-inset-bottom),16px)] z-[60] flex items-center gap-3 rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-3 text-[14px] text-zinc-200 shadow-2xl">
          <span className="min-w-0 flex-1 truncate">{toast.message}</span>
          {toast.undo && (
            <button
              onClick={() => {
                toast.undo!()
                setToast(null)
              }}
              className="shrink-0 font-semibold text-[#35c3d4]"
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  )
}
