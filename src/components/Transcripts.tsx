import { useEffect, useMemo, useRef, useState } from 'react'
import { formatTs, initials, avatarColor } from '../lib/format'

// Local IPC types — handlers are provided by the main process; types.d.ts is not extended on purpose.
interface TranscriptListItem {
  id: number
  title: string | null
  started_at: number | null
  ended_at: number | null
  markdown_path: string | null
  preview: string | null
  attendee_names: string | null
}

interface TranscriptSegment {
  seq: number
  channel: 'mic' | 'sys'
  speaker: string | null
  person_email: string | null
  t0: number
  t1: number
  text: string
}

interface TranscriptAttendee {
  email: string
  name: string | null
}

interface TranscriptDetail {
  transcript: {
    id: number
    title: string | null
    started_at: number | null
    ended_at: number | null
    markdown_path: string | null
  }
  segments: TranscriptSegment[]
  attendees: TranscriptAttendee[]
}

const ipc = () =>
  (window as any).mailflow as {
    transcriptsList: (query?: string) => Promise<TranscriptListItem[]>
    transcriptionGet: (id: number) => Promise<TranscriptDetail>
    transcriptionDelete: (id: number) => Promise<void>
    transcriptionRename: (id: number, title: string) => Promise<void>
  }

const ACCENT = '#35c3d4'

function mmss(t: number): string {
  const total = Math.max(0, Math.floor(t))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// "2 Jul, 14:59 – 15:34"
function timeRange(started: number | null, ended: number | null): string {
  if (!started) return ''
  const s = new Date(started * 1000)
  const day = s.toLocaleDateString([], { day: 'numeric', month: 'short' })
  const time = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (!ended) return `${day}, ${time(s)}`
  return `${day}, ${time(s)} – ${time(new Date(ended * 1000))}`
}

function speakerName(seg: TranscriptSegment): string {
  return seg.speaker || (seg.channel === 'mic' ? 'Matt' : 'Speaker')
}

function isSelf(seg: TranscriptSegment): boolean {
  return seg.channel === 'mic' || seg.speaker === 'Matt'
}

const MagnifierIcon = () => (
  <svg
    width={13}
    height={13}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.2" y2="16.2" />
  </svg>
)

export default function TranscriptsSection({
  onCounterpart,
  onRecord
}: {
  onCounterpart: (email: string | null) => void
  onRecord?: () => void
}) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<TranscriptListItem[] | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<TranscriptDetail | null>(null)
  const [listVersion, setListVersion] = useState(0)

  // Keep the latest callback without re-triggering data effects.
  const onCounterpartRef = useRef(onCounterpart)
  onCounterpartRef.current = onCounterpart

  // Debounced (~150ms) list fetch; also runs the initial load.
  useEffect(() => {
    let alive = true
    const timer = setTimeout(() => {
      ipc()
        .transcriptsList(query.trim() || undefined)
        .then((rows) => alive && setItems(rows))
        .catch(() => alive && setItems([]))
    }, 150)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query, listVersion])

  // A recording that just finished (stopped from the pill or anywhere else)
  // must appear in the list immediately, not on the next tab visit.
  useEffect(() => {
    return window.mailflow.onTranscriptionFinished(() => setListVersion((v) => v + 1))
  }, [])

  // Auto-select the first transcript when the list loads and nothing is selected.
  useEffect(() => {
    if (items && items.length > 0 && selectedId === null) setSelectedId(items[0].id)
  }, [items, selectedId])

  // Load the detail for the selection and report the counterpart to App.
  useEffect(() => {
    if (selectedId === null) {
      setDetail(null)
      onCounterpartRef.current(null)
      return
    }
    let alive = true
    setDetail(null)
    ipc()
      .transcriptionGet(selectedId)
      .then((d) => {
        if (!alive) return
        // Row deleted underneath us (or bad id): drop the selection instead of
        // rendering a detail with transcript === undefined.
        if (!d?.transcript) {
          setSelectedId(null)
          return
        }
        setDetail(d)
        onCounterpartRef.current(d.attendees[0]?.email ?? null)
      })
      .catch(() => {
        if (!alive) return
        onCounterpartRef.current(null)
      })
    return () => {
      alive = false
    }
  }, [selectedId])

  async function deleteSelected() {
    if (selectedId === null) return
    const hasVaultNote = Boolean(detail?.transcript.markdown_path)
    const ok = window.confirm(
      hasVaultNote
        ? 'Delete this transcript? Its vault note will be moved to the Trash.'
        : 'Delete this transcript?'
    )
    if (!ok) return
    await ipc().transcriptionDelete(selectedId)
    // Drop the item locally and pick a neighbour NOW — the auto-select effect
    // must never see a stale list that still contains the deleted id.
    const idx = (items ?? []).findIndex((t) => t.id === selectedId)
    const remaining = (items ?? []).filter((t) => t.id !== selectedId)
    const next = remaining[Math.min(Math.max(idx, 0), remaining.length - 1)]
    setItems(remaining)
    setSelectedId(next ? next.id : null)
    setListVersion((v) => v + 1)
  }

  async function renameSelected(title: string) {
    if (selectedId === null) return
    await ipc().transcriptionRename(selectedId, title)
    setDetail((d) => (d ? { ...d, transcript: { ...d.transcript, title } } : d))
    setListVersion((v) => v + 1)
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-1">
      {/* Left: transcript list */}
      <div className="flex w-[300px] shrink-0 flex-col border-r border-white/8">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/8 px-3 text-zinc-500">
          <MagnifierIcon />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search transcripts"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-200 outline-none placeholder:text-zinc-600"
          />
          {onRecord && (
            <button
              onClick={onRecord}
              data-tip="Start recording now"
              className="shrink-0 rounded-md p-1.5 text-[#e0705a] hover:bg-white/8"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
              </svg>
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {items === null && (
            <div className="flex h-32 items-center justify-center text-sm text-zinc-600">Loading…</div>
          )}
          {items !== null && items.length === 0 && (
            <div className="flex h-40 items-center justify-center px-6 text-center text-[12.5px] leading-relaxed text-zinc-600">
              No transcripts yet — record a meeting with ⌘K → Record meeting now
            </div>
          )}
          {items?.map((t) => (
            <div
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              className={`mx-1 cursor-default rounded-md px-2 py-2 ${
                t.id === selectedId ? 'bg-white/10' : 'hover:bg-white/4'
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span className="truncate text-[13px] font-semibold text-zinc-100">
                  {t.title || '(untitled meeting)'}
                </span>
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-zinc-500">
                  {formatTs(t.started_at ?? 0)}
                </span>
              </div>
              {t.attendee_names && (
                <div className="truncate text-[12.5px] text-zinc-400">{t.attendee_names}</div>
              )}
              {t.preview && <div className="truncate text-[12px] text-zinc-500">{t.preview}</div>}
            </div>
          ))}
        </div>
      </div>

      {/* Right: transcript detail */}
      <div className="min-w-0 flex-1">
        {selectedId === null ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-600">
            Select a transcript
          </div>
        ) : detail === null ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-600">Loading…</div>
        ) : (
          <TranscriptDetailView
            key={detail.transcript.id}
            detail={detail}
            onRename={renameSelected}
            onDelete={deleteSelected}
          />
        )}
      </div>
    </div>
  )
}

function TranscriptDetailView({
  detail,
  onRename,
  onDelete
}: {
  detail: TranscriptDetail
  onRename: (title: string) => void
  onDelete: () => void
}) {
  const { transcript, segments, attendees } = detail
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  function startEdit() {
    setDraft(transcript.title || '')
    setEditing(true)
  }

  function commitEdit() {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== (transcript.title || '')) onRename(next)
  }

  // Group consecutive segments by the same speaker under one name label.
  const groups = useMemo(() => {
    const out: { speaker: string; self: boolean; t0: number; segments: TranscriptSegment[] }[] = []
    for (const seg of segments) {
      const name = speakerName(seg)
      const last = out[out.length - 1]
      if (last && last.speaker === name) last.segments.push(seg)
      else out.push({ speaker: name, self: isSelf(seg), t0: seg.t0, segments: [seg] })
    }
    return out
  }, [segments])

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-white/8 px-4">
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit()
              if (e.key === 'Escape') setEditing(false)
            }}
            placeholder="Meeting title"
            className="min-w-0 flex-1 rounded bg-white/8 px-1.5 py-0.5 text-[14px] font-semibold text-zinc-100 outline-none placeholder:text-zinc-600"
          />
        ) : (
          <h1
            onDoubleClick={startEdit}
            className="min-w-0 flex-1 truncate text-[14px] font-semibold text-zinc-100"
          >
            {transcript.title || '(untitled meeting)'}
          </h1>
        )}
        {!editing && (
          <button
            onClick={startEdit}
            data-tip="Rename meeting"
            className="shrink-0 rounded-md p-1 text-zinc-500 hover:bg-white/8 hover:text-zinc-200"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            </svg>
          </button>
        )}
        <span className="shrink-0 text-[12px] tabular-nums text-zinc-500">
          {timeRange(transcript.started_at, transcript.ended_at)}
        </span>
        <button
          onClick={onDelete}
          data-tip="Delete transcript"
          className="shrink-0 rounded-md p-1 text-zinc-500 hover:bg-white/8 hover:text-[#e0705a]"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" />
            <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        {attendees.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            {attendees.map((a) => (
              <span
                key={a.email}
                title={a.email}
                className="flex items-center gap-1.5 rounded-full bg-white/6 px-2 py-0.5 text-[11.5px] text-zinc-300"
              >
                <span
                  className="flex h-3.5 w-3.5 items-center justify-center rounded-full text-[7px] font-semibold text-white/90"
                  style={{ background: avatarColor(a.email) }}
                >
                  {initials(a.name, a.email)}
                </span>
                {a.name || a.email}
              </span>
            ))}
          </div>
        )}

        {segments.length === 0 && (
          <div className="flex h-32 items-center justify-center text-sm text-zinc-600">
            No transcript segments
          </div>
        )}

        <div className="space-y-4">
          {groups.map((g, i) => (
            <div key={`${g.speaker}:${g.segments[0].seq}:${i}`}>
              <div className="mb-0.5 flex items-baseline gap-2">
                <span
                  className={`text-[13px] font-medium ${g.self ? '' : 'text-sky-400'}`}
                  style={g.self ? { color: ACCENT } : undefined}
                >
                  {g.speaker}
                </span>
                <span className="text-[11px] tabular-nums text-zinc-600">[{mmss(g.t0)}]</span>
              </div>
              <div className="space-y-1">
                {g.segments.map((seg) => (
                  <p key={seg.seq} className="text-[13.5px] leading-relaxed text-zinc-200">
                    {seg.text}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
