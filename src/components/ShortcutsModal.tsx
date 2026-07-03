import { useState } from 'react'
import { ACTIONS, ActionId, Binding, DEFAULT_KEYMAP, formatBinding, saveKeymap } from '../lib/keymap'

interface Props {
  open: boolean
  keymap: Record<ActionId, Binding>
  onChange: (map: Record<ActionId, Binding>) => void
  onClose: () => void
}

export default function ShortcutsModal({ open, keymap, onChange, onClose }: Props) {
  const [recording, setRecording] = useState<ActionId | null>(null)

  if (!open) return null

  function record(e: React.KeyboardEvent, id: ActionId) {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecording(null)
      return
    }
    // Ignore bare modifier presses; wait for the real key.
    if (['Meta', 'Shift', 'Control', 'Alt'].includes(e.key)) return
    const next = { ...keymap, [id]: { key: e.key, meta: e.metaKey || undefined } }
    saveKeymap(next)
    onChange(next)
    setRecording(null)
  }

  function reset() {
    saveKeymap(DEFAULT_KEYMAP)
    onChange({ ...DEFAULT_KEYMAP })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[440px] max-w-[90vw] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
      >
        <header className="flex items-center border-b border-white/8 px-4 py-3">
          <h2 className="text-[14px] font-semibold text-zinc-100">Keyboard shortcuts</h2>
          <button onClick={reset} className="ml-auto text-[12px] text-zinc-500 hover:text-zinc-300">
            Reset defaults
          </button>
          <button onClick={onClose} className="ml-3 text-zinc-500 hover:text-zinc-300">✕</button>
        </header>
        <div className="max-h-[55vh] overflow-y-auto p-2">
          {ACTIONS.map((a) => (
            <div key={a.id} className="flex items-center rounded-md px-2 py-1.5 hover:bg-white/4">
              <span className="text-[13px] text-zinc-300">{a.label}</span>
              <button
                onClick={() => setRecording(a.id)}
                onKeyDown={(e) => recording === a.id && record(e, a.id)}
                onBlur={() => setRecording((r) => (r === a.id ? null : r))}
                className={`ml-auto min-w-[64px] rounded border px-2 py-0.5 text-center text-[12px]
                  ${recording === a.id
                    ? 'border-[#35c3d4] bg-[#35c3d4]/10 text-[#35c3d4]'
                    : 'border-white/10 bg-white/5 text-zinc-300 hover:border-white/25'}`}
              >
                {recording === a.id ? 'Press keys…' : formatBinding(keymap[a.id])}
              </button>
            </div>
          ))}
        </div>
        <div className="border-t border-white/8 px-4 py-2 text-[11px] text-zinc-600">
          Click a shortcut, then press the new key (with ⌘ if wanted). j/k navigation and ⌘K are fixed.
        </div>
      </div>
    </div>
  )
}
