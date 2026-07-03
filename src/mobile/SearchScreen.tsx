import { useEffect, useRef, useState } from 'react'
import type { Account, ThreadSummary } from '../types.d'
import ThreadRow from './ThreadRow'

export default function SearchScreen({
  accounts, onClose, onOpen
}: {
  accounts: Account[]
  onClose: () => void
  onOpen: (t: ThreadSummary) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ThreadSummary[] | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!query.trim()) {
      setResults(null)
      return
    }
    const t = setTimeout(async () => setResults(await window.mailflow.search(query)), 120)
    return () => clearTimeout(t)
  }, [query])

  return (
    <div className="mf-screen fixed inset-x-0 top-0 z-40 flex flex-col bg-[#1b1e24] mf-slide-in">
      <header className="flex shrink-0 items-center gap-2 border-b border-white/8 px-3 pb-2 pt-[max(env(safe-area-inset-top),12px)]">
        <div className="relative min-w-0 flex-1">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600"
            width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search all mail"
            className="w-full rounded-xl bg-white/8 py-2 pl-9 pr-4 text-[16px] text-zinc-100 outline-none placeholder:text-zinc-600"
          />
        </div>
        <button onClick={onClose} className="shrink-0 px-2 py-1 text-[15px] text-[#35c3d4]">
          Cancel
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {results?.map((t) => (
          <ThreadRow
            key={`${t.account_id}:${t.id}`}
            t={t}
            accounts={accounts}
            unified
            onOpen={() => onOpen(t)}
          />
        ))}
        {results !== null && results.length === 0 && (
          <div className="flex h-40 items-center justify-center text-[14px] text-zinc-600">No results</div>
        )}
        {results === null && (
          <div className="flex h-40 items-center justify-center px-8 text-center text-[13px] text-zinc-600">
            Full-history search across both accounts — try a name, subject or phrase
          </div>
        )}
      </div>
    </div>
  )
}
