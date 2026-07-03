import { useEffect, useRef, useState } from 'react'

interface Segment {
  ch: 'mic' | 'sys'
  t0: number
  text: string
  spk?: number
}

interface Props {
  recording: { transcriptId: number; title: string } | null
  onStop: () => void
}

export default function TranscriptPanel({ recording, onStop }: Props) {
  const [segments, setSegments] = useState<Segment[]>([])
  const [levels, setLevels] = useState({ mic: 0, sys: 0 })
  const [warning, setWarning] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!recording) {
      setSegments([])
      setWarning(null)
      return
    }
    const off = window.mailflow.onTranscriptionEvent((ev) => {
      if (ev.t === 'seg') {
        setSegments((prev) => [...prev, ev as Segment])
        setTimeout(() => scrollRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' }), 30)
      }
      if (ev.t === 'level' && ev.ch) {
        setLevels((prev) => ({ ...prev, [ev.ch as 'mic' | 'sys']: ev.rms ?? 0 }))
      }
      if (ev.t === 'error' && (ev as any).message) {
        setWarning((ev as any).message)
      }
    })
    return off
  }, [recording?.transcriptId])

  if (!recording) return null

  return (
    <div className="fixed bottom-4 right-4 z-30 flex h-[380px] w-[420px] flex-col rounded-xl border border-zinc-700 bg-zinc-900/95 shadow-2xl backdrop-blur">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
        <span className="truncate text-[13px] font-medium text-zinc-200">{recording.title}</span>
        <Meter label="you" value={levels.mic} />
        <Meter label="them" value={levels.sys} />
        <button
          onClick={onStop}
          className="ml-auto rounded-md bg-red-600/90 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-red-500"
        >
          Stop
        </button>
      </header>
      {warning && (
        <div className="border-b border-amber-900/50 bg-amber-950/40 px-3 py-2 text-[11.5px] leading-snug text-amber-200/90">
          {warning}
        </div>
      )}
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-3">
        {segments.length === 0 && (
          <div className="pt-8 text-center text-[12px] text-zinc-600">Listening…</div>
        )}
        {segments.map((s, i) => (
          <div key={i} className="text-[12.5px] leading-relaxed">
            <span className={s.ch === 'mic' ? 'font-medium text-emerald-400' : 'font-medium text-sky-400'}>
              {s.ch === 'mic' ? 'Matt' : s.spk != null ? `Speaker ${s.spk + 1}` : 'Them'}
            </span>{' '}
            <span className="text-zinc-300">{s.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-zinc-600">{label}</span>
      <div className="h-1.5 w-10 overflow-hidden rounded bg-zinc-800">
        <div
          className="h-full bg-emerald-500 transition-[width] duration-100"
          style={{ width: `${Math.min(100, value * 300)}%` }}
        />
      </div>
    </div>
  )
}
