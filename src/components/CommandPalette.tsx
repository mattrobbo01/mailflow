import { useEffect, useState } from 'react'
import { Command } from 'cmdk'

export interface PaletteCommand {
  id: string
  label: string
  shortcut?: string
  keywords?: string
  run: () => void
}

interface Props {
  open: boolean
  commands: PaletteCommand[]
  onClose: () => void
}

export default function CommandPalette({ open, commands, onClose }: Props) {
  const [frecency, setFrecency] = useState<Record<string, number>>({})

  useEffect(() => {
    if (open) window.mailflow.paletteFrecency().then(setFrecency)
  }, [open])

  if (!open) return null

  const sorted = [...commands].sort((a, b) => (frecency[b.id] ?? 0) - (frecency[a.id] ?? 0))

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[18vh]" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>
        <Command
          label="Command palette"
          className="w-[560px] max-w-[90vw] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
          }}
        >
          <Command.Input
            autoFocus
            placeholder="Type a command…"
            className="w-full border-b border-zinc-800 bg-transparent px-4 py-3 text-[14px] text-zinc-200 outline-none placeholder:text-zinc-600"
          />
          <Command.List className="max-h-[320px] overflow-y-auto p-1.5">
            <Command.Empty className="px-3 py-6 text-center text-[13px] text-zinc-600">
              No matching commands
            </Command.Empty>
            {sorted.map((c) => (
              <Command.Item
                key={c.id}
                value={`${c.label} ${c.keywords ?? ''}`}
                onSelect={() => {
                  window.mailflow.paletteUsed(c.id)
                  onClose()
                  c.run()
                }}
                className="flex cursor-default items-center gap-3 rounded-md px-3 py-2 text-[13px] text-zinc-300 data-[selected=true]:bg-zinc-700/70 data-[selected=true]:text-zinc-100"
              >
                <span>{c.label}</span>
                {c.shortcut && (
                  <kbd className="ml-auto rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-500">
                    {c.shortcut}
                  </kbd>
                )}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  )
}
