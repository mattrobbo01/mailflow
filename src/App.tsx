import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Account, CategoryGroup, Message, ThreadSummary } from './types.d'
import ThreadList from './components/ThreadList'
import ThreadView from './components/ThreadView'
import ConnectScreen from './components/ConnectScreen'
import Composer, { ComposerSeed, replySeed, forwardSeed } from './components/Composer'
import CommandPalette, { PaletteCommand } from './components/CommandPalette'
import PeopleSidebar from './components/PeopleSidebar'
import ShortcutsModal from './components/ShortcutsModal'
import { loadKeymap, matches, formatBinding, ActionId, Binding } from './lib/keymap'
import TranscriptPanel from './components/TranscriptPanel'
import TranscriptsSection from './components/Transcripts'
import { InboxIcon, StarIcon, ClockIcon, SendIcon, LayersIcon, UnifiedIcon, PanelIcon, CheckIcon, ComposeIcon, MicIcon, FileIcon } from './components/Icons'
import type { DraftRow } from './types.d'
import { formatTs } from './lib/format'

type View = 'inbox' | 'notifications' | 'newsletters' | 'all' | 'sent' | 'starred' | 'snoozed' | 'done' | 'drafts'

interface Toast {
  message: string
  undo?: () => void
}

function DraftsList({ onOpen }: { onOpen: (d: DraftRow) => void }) {
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null)
  const load = () => window.mailflow.draftsList().then(setDrafts).catch(() => setDrafts([]))
  useEffect(() => { load() }, [])

  if (drafts === null) return <div className="p-4 text-[12px] text-zinc-600">Loading…</div>
  if (drafts.length === 0) {
    return <div className="p-4 text-center text-[12.5px] text-zinc-600">No drafts — close a compose with content to save one</div>
  }
  return (
    <div className="h-full overflow-y-auto">
      {drafts.map((d) => (
        <div key={d.id} className="group flex cursor-default gap-2 border-b border-white/5 px-3 py-2.5 hover:bg-white/4"
          onClick={() => onOpen(d)}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-medium text-zinc-200">{d.subject || '(no subject)'}</span>
              <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-500">{formatTs(d.updated_at)}</span>
            </div>
            <div className="truncate text-[12px] text-zinc-500">to {d.to_field || '…'} · {d.account}</div>
            <div className="truncate text-[12px] text-zinc-500">{d.body}</div>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); window.mailflow.draftDelete(d.id).then(load) }}
            data-tip="Delete draft"
            className="self-center text-zinc-600 opacity-0 hover:text-zinc-300 group-hover:opacity-100"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}

function tomorrowAt(hour: number): number {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(hour, 0, 0, 0)
  return Math.floor(d.getTime() / 1000)
}

export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [clientsConfigured, setClientsConfigured] = useState({ work: false, personal: false })
  const [loaded, setLoaded] = useState(false)

  const [accountFilter, setAccountFilter] = useState<string | undefined>(undefined)
  const [view, setView] = useState<View>('inbox')
  const [section, setSection] = useState<'mail' | 'transcripts'>('mail')
  const [transcriptCounterpart, setTranscriptCounterpart] = useState<string | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [groups, setGroups] = useState<CategoryGroup[]>([])
  const doneUndoStack = useRef<{ account: string; id: string; wasDone: boolean }[]>([])
  const [openThread, setOpenThread] = useState<ThreadSummary | null>(null)
  const openMessagesRef = useRef<Message[]>([])

  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<ThreadSummary[] | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const [composer, setComposer] = useState<ComposerSeed | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [keymap, setKeymap] = useState<Record<ActionId, Binding>>(loadKeymap)
  const offListRef = useRef(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem('navCollapsed') === '1')
  const toggleNav = useCallback(() => {
    setNavCollapsed((v) => {
      localStorage.setItem('navCollapsed', v ? '0' : '1')
      return !v
    })
  }, [])
  const [toast, setToast] = useState<Toast | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [backfill, setBackfill] = useState<Record<string, { phase: string; fetched: number }>>({})
  const [recording, setRecording] = useState<{ transcriptId: number; title: string } | null>(null)
  const [meetingPrompt, setMeetingPrompt] = useState<{
    eventId: string; title: string; attendees: { email: string; name?: string }[]
  } | null>(null)

  const showToast = useCallback((t: Toast, ms = 5000) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast(t)
    toastTimer.current = setTimeout(() => setToast(null), ms)
  }, [])

  const refreshAccounts = useCallback(async () => {
    const res = await window.mailflow.accounts()
    setAccounts(res.accounts)
    setClientsConfigured(res.clientsConfigured)
    setLoaded(true)
  }, [])

  const refreshThreads = useCallback(async () => {
    if (view === 'drafts') {
      setThreads([])
      setGroups([])
      return
    }
    setThreads(await window.mailflow.listThreads({ account: accountFilter, view: view as Exclude<View, 'drafts'>, showDone, limit: 300 }))
    setGroups(await window.mailflow.threadGroups(accountFilter, showDone))
  }, [accountFilter, view, showDone])

  const toggleShowDone = useCallback(() => {
    setShowDone((v) => !v)
    setOpenThread(null)
  }, [])

  useEffect(() => { refreshAccounts() }, [refreshAccounts])
  useEffect(() => { refreshThreads() }, [refreshThreads])

  useEffect(() => {
    const off1 = window.mailflow.onSyncUpdated(() => { refreshThreads(); refreshAccounts() })
    const off2 = window.mailflow.onBackfillProgress((p) => {
      setBackfill((prev) => ({ ...prev, [p.account]: { phase: p.phase, fetched: p.fetched } }))
      if (p.fetched % 1000 === 0 || p.phase === 'done') refreshThreads()
    })
    return () => { off1(); off2() }
  }, [refreshThreads, refreshAccounts])

  useEffect(() => {
    const off1 = window.mailflow.onMeetingDetected((m) => setMeetingPrompt(m))
    const off2 = window.mailflow.onTranscriptionFinished((p) => {
      setRecording(null)
      showToast({
        message: p.error
          ? `Recording ended: ${p.error}`
          : p.exportedTo
            ? `Transcript saved to Robbo2 vault`
            : 'Recording ended (no speech captured)'
      }, 8000)
    })
    return () => { off1(); off2() }
  }, [showToast])

  const startMeetingRecording = useCallback(async (title: string, attendees: string[], eventId?: string) => {
    try {
      const transcriptId = await window.mailflow.transcriptionStart(title, attendees, eventId)
      setRecording({ transcriptId, title })
      setMeetingPrompt(null)
    } catch (e: any) {
      showToast({ message: `Could not start recording: ${e.message}` }, 8000)
    }
  }, [showToast])

  const startRecordNow = useCallback(async () => {
    const live = await window.mailflow.meetingsLive().catch(() => [])
    const m = (live as any[])[0]
    startMeetingRecording(
      m?.title ?? `Meeting ${new Date().toLocaleDateString()}`,
      m?.attendees?.map((a: any) => a.email) ?? [],
      m?.eventId
    )
  }, [startMeetingRecording])

  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults(null); return }
    const t = setTimeout(async () => setSearchResults(await window.mailflow.search(searchQuery)), 80)
    return () => clearTimeout(t)
  }, [searchQuery])

  const visibleThreads = searchResults ?? threads
  // The open thread IS the selection — one source of truth, so the list highlight
  // and the reading pane can never disagree.
  const selectedIndex = openThread
    ? visibleThreads.findIndex((x) => x.account_id === openThread.account_id && x.id === openThread.id)
    : -1
  const currentThread: ThreadSummary | undefined = openThread ?? undefined
  const connectedAccounts = accounts.filter((a) => a.connected)
  const selfEmails = connectedAccounts.map((a) => a.id.toLowerCase())

  const missingKinds = (['work', 'personal'] as const).filter(
    (kind) =>
      clientsConfigured[kind] &&
      !connectedAccounts.some((a) =>
        kind === 'work' ? a.id.endsWith('@usehabits.com') : a.id.endsWith('@gmail.com')
      )
  )

  const connectAccount = useCallback(async (kind: 'work' | 'personal') => {
    try {
      const email = await window.mailflow.startAuth(kind)
      showToast({ message: `${email} connected — backfill starting` }, 8000)
      refreshAccounts()
    } catch (e: any) {
      showToast({ message: `Connect failed: ${e.message}` }, 10000)
    }
  }, [refreshAccounts, showToast])

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

  // ---------- actions ----------

  const advanceAfterRemoval = useCallback((removed: ThreadSummary) => {
    const same = (t: ThreadSummary) => t.account_id === removed.account_id && t.id === removed.id
    const i = visibleThreads.findIndex(same)
    const next = visibleThreads[i + 1] ?? visibleThreads[i - 1] ?? null
    setThreads((prev) => prev.filter((t) => !same(t)))
    setSearchResults((prev) => prev?.filter((t) => !same(t)) ?? null)
    setOpenThread((prev) => (prev && same(prev) ? next : prev))
  }, [visibleThreads])

  const doArchive = useCallback((t?: ThreadSummary) => {
    if (!t) return
    window.mailflow.archive(t.account_id, t.id)
    advanceAfterRemoval(t)
    showToast({ message: 'Archived', undo: () => { window.mailflow.moveToInbox(t.account_id, t.id); refreshThreads() } })
  }, [advanceAfterRemoval, showToast, refreshThreads])

  const doTrash = useCallback((t?: ThreadSummary) => {
    if (!t) return
    window.mailflow.trash(t.account_id, t.id)
    advanceAfterRemoval(t)
    showToast({ message: 'Moved to trash' })
  }, [advanceAfterRemoval, showToast])

  const doSnooze = useCallback((t: ThreadSummary | undefined, until: number, label: string) => {
    if (!t) return
    window.mailflow.snooze(t.account_id, t.id, until)
    advanceAfterRemoval(t)
    showToast({ message: `Snoozed until ${label}` })
  }, [advanceAfterRemoval, showToast])

  const doToggleRead = useCallback((t?: ThreadSummary) => {
    if (!t) return
    if (t.is_unread) window.mailflow.markRead(t.account_id, t.id)
    else window.mailflow.markUnread(t.account_id, t.id)
    refreshThreads()
  }, [refreshThreads])

  const doStar = useCallback((t?: ThreadSummary) => {
    if (!t) return
    const starred = (JSON.parse(t.label_ids) as string[]).includes('STARRED')
    window.mailflow.star(t.account_id, t.id, !starred)
    refreshThreads()
  }, [refreshThreads])

  const doReply = useCallback(() => {
    const t = currentThread
    if (!t) return
    const msgs = openMessagesRef.current
    const last = msgs[msgs.length - 1]
    if (last) setComposer(replySeed(t, last, selfEmails))
    else window.mailflow.getThread(t.account_id, t.id).then((m) => {
      if (m.length) setComposer(replySeed(t, m[m.length - 1], selfEmails))
    })
  }, [currentThread, selfEmails])

  const doCompose = useCallback(() => {
    setComposer({ account: accountFilter ?? connectedAccounts[0]?.id ?? '' })
  }, [accountFilter, connectedAccounts])

  const onOpen = useCallback((t: ThreadSummary) => {
    offListRef.current = false
    setOpenThread(t)
  }, [])

  // Reading pane is always populated when there's anything to show, and never
  // shows a thread that fell out of the current list (unless it was deliberately
  // opened from the people sidebar).
  useEffect(() => {
    if (!openThread) {
      if (visibleThreads.length > 0) setOpenThread(visibleThreads[0])
      return
    }
    const inList = visibleThreads.some(
      (x) => x.account_id === openThread.account_id && x.id === openThread.id
    )
    if (!inList && !offListRef.current) {
      setOpenThread(visibleThreads[0] ?? null)
    }
  }, [openThread, visibleThreads])

  // Mark read only after the thread has been on screen briefly (fast j/k skimming doesn't mark).
  useEffect(() => {
    if (!openThread?.is_unread) return
    const { account_id, id } = openThread
    const timer = setTimeout(() => {
      window.mailflow.markRead(account_id, id)
      setOpenThread((prev) => (prev && prev.id === id ? { ...prev, is_unread: 0 } : prev))
      refreshThreads()
    }, 800)
    return () => clearTimeout(timer)
  }, [openThread?.account_id, openThread?.id, openThread?.is_unread, refreshThreads])

  const doDone = useCallback((t?: ThreadSummary) => {
    if (!t) return
    const unDone = showDone || view === 'done' // in a done list, E puts it back
    window.mailflow.setDone(t.account_id, t.id, !unDone)
    doneUndoStack.current.push({ account: t.account_id, id: t.id, wasDone: unDone })
    advanceAfterRemoval(t)
    showToast({
      message: unDone ? 'Moved back to inbox' : 'Done',
      undo: () => { window.mailflow.setDone(t.account_id, t.id, unDone); doneUndoStack.current.pop(); refreshThreads() }
    })
  }, [view, showDone, advanceAfterRemoval, showToast, refreshThreads])

  const undoLastDone = useCallback(() => {
    const last = doneUndoStack.current.pop()
    if (!last) return
    window.mailflow.setDone(last.account, last.id, last.wasDone)
    refreshThreads()
    showToast({ message: last.wasDone ? 'Restored to done' : 'Moved back to inbox' })
  }, [refreshThreads, showToast])

  const openThreadById = useCallback(async (accountId: string, threadId: string) => {
    const local =
      threads.find((x) => x.account_id === accountId && x.id === threadId) ??
      searchResults?.find((x) => x.account_id === accountId && x.id === threadId)
    const t = local ?? (await window.mailflow.getThreadSummary(accountId, threadId))
    offListRef.current = !local
    setOpenThread(
      t ?? {
        account_id: accountId, id: threadId, subject: '', snippet: '', last_ts: 0,
        message_count: 0, is_unread: 0, label_ids: '[]', participants: '[]'
      }
    )
  }, [threads, searchResults])

  useEffect(() => {
    // Clicking a new-mail banner lands directly on that thread.
    return window.mailflow.onOpenThread((p) => {
      setSection('mail')
      setView('inbox')
      openThreadById(p.account, p.threadId)
    })
  }, [openThreadById])

  // ---------- keyboard ----------

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (composer || shortcutsOpen) return // those surfaces handle their own keys
      const target = e.target as HTMLElement
      const inInput = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'

      if (e.metaKey && e.key === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      if (paletteOpen) return
      // Transcripts section: only global chords apply (palette/nav/people handled above and below).
      if (section === 'transcripts' && !e.metaKey) return

      // ⌘-bound custom actions work even while typing; bare-key ones don't.
      const run = (fn: () => void) => { e.preventDefault(); fn() }
      const bound = (id: ActionId) => matches(e, keymap[id]) && (keymap[id].meta || !inInput)
      if (bound('toggleDone')) return run(toggleShowDone)
      if (bound('undoDone')) return run(undoLastDone)
      if (bound('peopleSidebar')) return run(() => setSidebarOpen((v) => !v))
      if (bound('collapseNav')) return run(toggleNav)
      if (bound('search')) return run(() => searchRef.current?.focus())
      if (bound('compose')) return run(doCompose)
      if (bound('reply')) return run(() => { if (openThread) doReply() })
      if (bound('done')) return run(() => doDone(currentThread))
      if (bound('trash')) return run(() => doTrash(currentThread))
      if (bound('star')) return run(() => doStar(currentThread))
      if (bound('unread')) return run(() => doToggleRead(currentThread))
      if (bound('snooze')) return run(() => doSnooze(currentThread, tomorrowAt(8), 'tomorrow 8am'))

      if (inInput) {
        if (e.key === 'Escape') { setSearchQuery(''); target.blur() }
        if (e.key === 'Enter' && searchResults && searchResults.length > 0) {
          onOpen(searchResults[0]); target.blur()
        }
        return
      }

      switch (e.key) {
        case 'j': case 'ArrowDown': {
          e.preventDefault()
          const next = visibleThreads[Math.min(selectedIndex + 1, visibleThreads.length - 1)]
          if (next) onOpen(next)
          break
        }
        case 'k': case 'ArrowUp': {
          e.preventDefault()
          const next = visibleThreads[Math.max(selectedIndex - 1, 0)]
          if (next) onOpen(next)
          break
        }
        case 'Enter': case 'o':
          if (visibleThreads[selectedIndex]) onOpen(visibleThreads[selectedIndex])
          break
        case 'Escape':
          if (view === 'notifications' || view === 'newsletters' || view === 'done') {
            setView('inbox')
            setOpenThread(null)
          }
          break
        case '1': if (e.metaKey) { e.preventDefault(); setAccountFilter(accounts[0]?.id) } break
        case '2': if (e.metaKey) { e.preventDefault(); setAccountFilter(accounts[1]?.id) } break
        case '3': if (e.metaKey) { e.preventDefault(); setAccountFilter(undefined) } break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visibleThreads, selectedIndex, openThread, accounts, searchResults, composer, paletteOpen, view,
      currentThread, doArchive, doTrash, doStar, doToggleRead, doSnooze, doReply, doCompose, doDone,
      onOpen, toggleNav, toggleShowDone, undoLastDone, keymap, shortcutsOpen, section])

  // ---------- palette commands ----------

  const paletteCommands: PaletteCommand[] = [
    { id: 'compose', label: 'Compose new message', shortcut: formatBinding(keymap.compose), run: doCompose },
    { id: 'reply', label: 'Reply', shortcut: formatBinding(keymap.reply), keywords: 'respond', run: doReply },
    { id: 'done', label: 'Mark done', shortcut: formatBinding(keymap.done), keywords: 'complete finish', run: () => doDone(currentThread) },
    { id: 'toggle-done', label: 'Show / hide done emails', shortcut: formatBinding(keymap.toggleDone), keywords: 'completed toggle', run: toggleShowDone },
    { id: 'undo-done', label: 'Undo last done', shortcut: formatBinding(keymap.undoDone), run: undoLastDone },
    { id: 'archive', label: 'Archive (Gmail)', keywords: 'file away', run: () => doArchive(currentThread) },
    { id: 'trash', label: 'Move to trash', shortcut: formatBinding(keymap.trash), keywords: 'delete', run: () => doTrash(currentThread) },
    { id: 'star', label: 'Star / unstar', shortcut: formatBinding(keymap.star), run: () => doStar(currentThread) },
    { id: 'toggle-read', label: 'Mark read / unread', shortcut: formatBinding(keymap.unread), run: () => doToggleRead(currentThread) },
    { id: 'snooze-tomorrow', label: 'Snooze until tomorrow 8am', shortcut: formatBinding(keymap.snooze), keywords: 'later', run: () => doSnooze(currentThread, tomorrowAt(8), 'tomorrow 8am') },
    { id: 'shortcuts', label: 'Keyboard shortcuts…', keywords: 'keys hotkeys settings customize', run: () => setShortcutsOpen(true) },
    ...connectedAccounts.map((a) => ({
      id: `sig-import-${a.id}`,
      label: `Re-import signature from sent mail (${a.id})`,
      keywords: 'signature footer',
      run: () => {
        window.mailflow.signatureImport(a.id).then((r) =>
          showToast({ message: r ? `Signature imported for ${a.id}` : `No signature found in ${a.id} sent mail` }, 6000)
        )
      }
    })),
    { id: 'snooze-evening', label: 'Snooze until this evening 6pm', keywords: 'later tonight', run: () => { const d = new Date(); d.setHours(18, 0, 0, 0); doSnooze(currentThread, Math.floor(d.getTime() / 1000), '6pm') } },
    { id: 'snooze-weekend', label: 'Snooze until Saturday 9am', keywords: 'later weekend', run: () => { const d = new Date(); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7)); d.setHours(9, 0, 0, 0); doSnooze(currentThread, Math.floor(d.getTime() / 1000), 'Saturday 9am') } },
    { id: 'search', label: 'Search', shortcut: '/', run: () => setTimeout(() => searchRef.current?.focus(), 0) },
    { id: 'toggle-people', label: 'Toggle people sidebar', shortcut: '⌘I', keywords: 'hubspot contact crm', run: () => setSidebarOpen((v) => !v) },
    { id: 'toggle-nav', label: 'Collapse / expand navigation', shortcut: '⌘.', keywords: 'sidebar minimize', run: toggleNav },
    { id: 'go-inbox', label: 'Go to Inbox', run: () => setView('inbox') },
    { id: 'go-starred', label: 'Go to Starred', run: () => setView('starred') },
    { id: 'go-snoozed', label: 'Go to Snoozed', run: () => setView('snoozed') },
    { id: 'go-sent', label: 'Go to Sent', run: () => { setSection('mail'); setView('sent') } },
    { id: 'go-transcripts', label: 'Go to Transcripts', keywords: 'meetings recordings', run: () => setSection('transcripts') },
    { id: 'acct-unified', label: 'Switch to unified inbox', shortcut: '⌘3', run: () => setAccountFilter(undefined) },
    ...connectedAccounts.map((a, i) => ({
      id: `acct-${a.id}`, label: `Switch to ${a.id}`, shortcut: `⌘${i + 1}`, run: () => setAccountFilter(a.id)
    })),
    { id: 'sync', label: 'Sync now', keywords: 'refresh', run: () => window.mailflow.syncNow() },
    ...missingKinds.map((kind) => ({
      id: `connect-${kind}`,
      label: `Connect ${kind} account`,
      keywords: 'add login oauth google',
      run: () => connectAccount(kind)
    })),
    recording
      ? { id: 'record-stop', label: 'Stop recording meeting', keywords: 'transcribe', run: () => window.mailflow.transcriptionStop() }
      : { id: 'record-start', label: 'Record meeting now', keywords: 'transcribe meeting notes', run: startRecordNow },
    { id: 'notify-test', label: 'Test system notification', keywords: 'sound alert debug', run: () => window.mailflow.notifyTest() }
  ]

  // ---------- render ----------

  if (loaded && connectedAccounts.length === 0) {
    return <ConnectScreen accounts={accounts} clientsConfigured={clientsConfigured} onConnected={refreshAccounts} />
  }

  const views: { id: View; label: string; icon: () => React.ReactElement; badge?: number }[] = [
    { id: 'inbox', label: 'Inbox', icon: InboxIcon },
    { id: 'starred', label: 'Starred', icon: StarIcon },
    { id: 'snoozed', label: 'Snoozed', icon: ClockIcon },
    { id: 'sent', label: 'Sent', icon: SendIcon },
    { id: 'drafts', label: 'Drafts', icon: FileIcon },
    { id: 'all', label: 'Everything', icon: LayersIcon }
  ]

  const navBtn = (active: boolean) =>
    `flex w-full items-center gap-2.5 rounded-md py-1.5 text-[13px] ${
      navCollapsed ? 'justify-center px-0' : 'px-2.5'
    } ${active ? 'bg-white/10 text-zinc-100' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`

  return (
    <div className="flex h-full">
      <aside
        className={`flex ${navCollapsed ? 'w-14' : 'w-56'} shrink-0 flex-col border-r border-white/8 bg-[#16181d] pt-11 transition-[width] duration-150`}
      >
        <nav className="px-2">
          {views.map((v) => (
            <button
              key={v.id}
              data-tip={navCollapsed ? `${v.label}${v.badge ? ` (${v.badge})` : ''}` : undefined}
              onClick={() => { setSection('mail'); setView(v.id); setOpenThread(null) }}
              className={`tip-right relative ${navBtn(section === 'mail' && view === v.id)}`}
            >
              <span className="relative shrink-0">
                <v.icon />
                {navCollapsed && v.badge ? (
                  <span className="absolute -right-1.5 -top-1 h-2 w-2 rounded-full bg-[#35c3d4]" />
                ) : null}
              </span>
              {!navCollapsed && (
                <>
                  {v.label}
                  {v.badge ? <span className="ml-auto text-[11px] text-zinc-500">{v.badge}</span> : null}
                </>
              )}
            </button>
          ))}
        </nav>

        <div className="mt-5 px-2">
          {!navCollapsed && (
            <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
              Accounts
            </div>
          )}
          <button
            onClick={() => setAccountFilter(undefined)}
            data-tip="Unified inbox (⌘3)"
            className={`tip-right ${navBtn(accountFilter === undefined)}`}
          >
            <span className="shrink-0"><UnifiedIcon /></span>
            {!navCollapsed && <span className="truncate">Unified</span>}
          </button>
          {connectedAccounts.map((a, i) => (
            <button
              key={a.id}
              onClick={() => setAccountFilter(a.id)}
              data-tip={`${a.id} (⌘${i + 1})`}
              className={`tip-right ${navBtn(accountFilter === a.id)}`}
            >
              <span
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-black/70"
                style={{ background: i === 0 ? 'var(--accent-personal)' : 'var(--accent-work)' }}
              >
                {a.id[0].toUpperCase()}
              </span>
              {!navCollapsed && <span className="min-w-0 truncate">{a.id}</span>}
            </button>
          ))}
          {missingKinds.map((kind) => (
            <button
              key={kind}
              onClick={() => connectAccount(kind)}
              data-tip={`Connect ${kind} account`}
              className={`tip-right ${navBtn(false)} text-zinc-500`}
            >
              <span className="shrink-0 text-[15px] leading-4">+</span>
              {!navCollapsed && `Connect ${kind}`}
            </button>
          ))}
        </div>

        <div className="mt-auto px-2 pb-3">
          <button
            onClick={() => setSection(section === 'transcripts' ? 'mail' : 'transcripts')}
            data-tip={navCollapsed ? 'Transcripts' : undefined}
            className={`tip-right ${navBtn(section === 'transcripts')}`}
          >
            <span className="shrink-0"><MicIcon /></span>
            {!navCollapsed && 'Transcripts'}
          </button>
          {Object.entries(backfill)
            .filter(([, p]) => p.phase !== 'done')
            .map(([acct, p]) => (
              <div
                key={acct}
                title={`${acct}: ${p.fetched.toLocaleString()} messages synced (${p.phase})`}
                className={`truncate py-0.5 text-[11px] text-zinc-500 ${navCollapsed ? 'text-center' : 'px-2.5'}`}
              >
                {navCollapsed ? '⏳' : `⏳ ${acct.split('@')[0]}: ${p.fetched.toLocaleString()}`}
              </div>
            ))}
          <button onClick={toggleNav} data-tip="Collapse / expand (⌘.)" className={`tip-right ${navBtn(false)}`}>
            <span className="shrink-0"><PanelIcon /></span>
            {!navCollapsed && <span className="text-[12px] text-zinc-500">Collapse</span>}
          </button>
        </div>
      </aside>

      {section === 'transcripts' && (
        <main className="flex min-w-0 flex-1 pt-10">
          <div className="flex min-w-0 flex-1">
            <TranscriptsSection onCounterpart={setTranscriptCounterpart} onRecord={startRecordNow} />
          </div>
          {sidebarOpen && (
            <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-white/8">
              <PeopleSidebar
                email={transcriptCounterpart}
                onOpenThread={(a, t) => { setSection('mail'); openThreadById(a, t) }}
              />
            </aside>
          )}
        </main>
      )}

      <main className={`min-w-0 flex-1 ${section === 'mail' ? 'flex' : 'hidden'}`}>
        <section className="flex w-[300px] shrink-0 flex-col border-r border-white/8 pt-10">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/8 px-3">
            <div className="relative min-w-0 flex-1">
              <svg
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600"
                width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={searchRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search all mail"
                className="w-full bg-transparent py-1 pl-8 pr-7 text-[13px] text-zinc-200 outline-none placeholder:text-zinc-600"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                >
                  ✕
                </button>
              )}
            </div>
            <button
              data-tip={showDone ? 'Showing done — back to inbox (⌘E)' : 'Show emails marked done (⌘E)'}
              onClick={toggleShowDone}
              className={`flex h-[20px] w-9 shrink-0 items-center rounded-full px-0.5 transition-colors
                ${showDone ? 'bg-[#1f9dad]' : 'bg-white/12'}`}
            >
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full bg-white text-black/60 transition-transform
                  ${showDone ? 'translate-x-[16px]' : ''}`}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </span>
            </button>
            <button
              data-tip="Compose (C)"
              onClick={doCompose}
              className="shrink-0 rounded-md p-1.5 text-zinc-400 hover:bg-white/8 hover:text-zinc-200"
            >
              <ComposeIcon />
            </button>
          </div>
          {(view === 'notifications' || view === 'newsletters' || view === 'done') && (
            <button
              onClick={() => { setView('inbox'); setOpenThread(null) }}
              className="flex items-center gap-2 border-b border-white/5 px-4 py-2 text-left text-[12.5px] font-medium text-zinc-400 hover:bg-white/4 hover:text-zinc-200"
            >
              ← Inbox <span className="text-zinc-600">Esc</span>
              <span className="ml-auto capitalize text-zinc-500">{view}</span>
            </button>
          )}
          <div className="min-h-0 flex-1">
            {view === 'drafts' ? (
              <DraftsList
                key={composer ? 'composing' : 'idle'}
                onOpen={(d) => {
                  let attachments: ComposerSeed['attachments']
                  try { attachments = JSON.parse(d.attachments_json) } catch { attachments = [] }
                  setComposer({
                    account: d.account, to: d.to_field, cc: d.cc_field, bcc: d.bcc_field,
                    subject: d.subject, body: d.body, quoted: d.quoted ?? undefined,
                    threadId: d.thread_id ?? undefined, inReplyTo: d.in_reply_to ?? undefined,
                    references: d.references_header ?? undefined, draftId: d.id, attachments
                  })
                }}
              />
            ) : (
            <ThreadList
              threads={visibleThreads}
              accounts={connectedAccounts}
              selectedIndex={selectedIndex}
              unified={accountFilter === undefined}
              groups={view === 'inbox' && !searchResults ? groups : undefined}
              onOpenGroup={(c) => { setView(c); setOpenThread(null) }}
              onOpen={onOpen}
            />
            )}
          </div>
        </section>

        {!openThread && (
          <section className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 pt-10 text-zinc-600">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
            <div className="text-[13px]">
              {showDone ? 'Nothing marked done here yet' : 'No conversations'}
            </div>
          </section>
        )}
        {openThread && (
          <section className="min-w-0 flex-1 pt-10">
            <ThreadView
              thread={openThread}
              onMessages={(msgs) => { openMessagesRef.current = msgs }}
              onReplyMessage={(m, all) => setComposer(replySeed(openThread, m, selfEmails, all))}
              onForwardMessage={(m) => setComposer(forwardSeed(openThread, m))}
              actions={{
                onDone: () => doDone(openThread),
                onArchive: () => doArchive(openThread),
                onTrash: () => doTrash(openThread),
                onSnooze: () => doSnooze(openThread, tomorrowAt(8), 'tomorrow 8am'),
                onStar: () => doStar(openThread),
                onToggleRead: () => doToggleRead(openThread),
                onReply: doReply
              }}
            />
          </section>
        )}

        {openThread && sidebarOpen && (
          <aside className="w-[300px] shrink-0 overflow-y-auto border-l border-zinc-800 pt-10">
            <PeopleSidebar
              email={counterpart?.email ?? null}
              name={counterpart?.name || undefined}
              onOpenThread={openThreadById}
            />
          </aside>
        )}
      </main>

      {composer && (
        <Composer
          accounts={connectedAccounts}
          seed={composer}
          leftOffset={navCollapsed ? 56 : 224}
          onClose={() => setComposer(null)}
          onSent={(undoId, summary) => {
            showToast({
              message: summary,
              undo: undoId !== null
                ? () => { window.mailflow.sendUndo(undoId).then((ok) => showToast({ message: ok ? 'Send cancelled' : 'Too late — already sent' })) }
                : undefined
            }, undoId !== null ? 10_000 : 5000)
          }}
        />
      )}

      <CommandPalette open={paletteOpen} commands={paletteCommands} onClose={() => setPaletteOpen(false)} />
      <ShortcutsModal open={shortcutsOpen} keymap={keymap} onChange={setKeymap} onClose={() => setShortcutsOpen(false)} />

      {meetingPrompt && !recording && (
        <div className="fixed top-12 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-[13px] text-zinc-200 shadow-xl">
          <span className="h-2 w-2 rounded-full bg-red-500" />
          <span className="max-w-[280px] truncate">“{meetingPrompt.title}” looks live — record it?</span>
          <button
            onClick={() =>
              startMeetingRecording(
                meetingPrompt.title,
                meetingPrompt.attendees.map((a) => a.email),
                meetingPrompt.eventId
              )
            }
            className="rounded-md bg-red-600/90 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-red-500"
          >
            Record
          </button>
          <button onClick={() => setMeetingPrompt(null)} className="text-zinc-500 hover:text-zinc-300">
            Dismiss
          </button>
        </div>
      )}

      <TranscriptPanel recording={recording} onStop={() => window.mailflow.transcriptionStop()} />

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-[13px] text-zinc-200 shadow-xl">
          {toast.message}
          {toast.undo && (
            <button
              onClick={() => { toast.undo!(); setToast(null) }}
              className="font-medium text-[#35c3d4] hover:text-[#57d1e0]"
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  )
}
