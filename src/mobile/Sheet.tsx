import { ReactNode, useEffect, useRef, useState } from 'react'

/**
 * Bottom sheet: backdrop + rounded panel sliding up from the bottom edge,
 * dismissed by tapping the backdrop or dragging the grab handle down.
 */
export default function Sheet({
  title, onClose, children, tall = false
}: {
  title?: string
  onClose: () => void
  children: ReactNode
  tall?: boolean
}) {
  const [dragY, setDragY] = useState(0)
  const startY = useRef<number | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Freeze the page behind the sheet (iOS scroll chaining).
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50 mf-fade-in" onClick={onClose} />
      <div
        ref={panelRef}
        style={{ transform: dragY > 0 ? `translateY(${dragY}px)` : undefined }}
        className={`absolute inset-x-0 bottom-0 flex flex-col rounded-t-2xl border-t border-white/10 bg-[#1f2228] shadow-2xl mf-slide-up ${
          tall ? 'h-[calc(var(--app-h,100dvh)*0.85)]' : 'max-h-[calc(var(--app-h,100dvh)*0.7)]'
        }`}
      >
        <div
          className="shrink-0 touch-none px-4 pb-1 pt-2.5"
          onTouchStart={(e) => {
            startY.current = e.touches[0].clientY
          }}
          onTouchMove={(e) => {
            if (startY.current === null) return
            setDragY(Math.max(0, e.touches[0].clientY - startY.current))
          }}
          onTouchEnd={() => {
            if (dragY > 90) onClose()
            setDragY(0)
            startY.current = null
          }}
        >
          <div className="mx-auto h-1 w-9 rounded-full bg-white/20" />
          {title && <div className="pt-2 text-center text-[14px] font-semibold text-zinc-100">{title}</div>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-[max(env(safe-area-inset-bottom),12px)]">
          {children}
        </div>
      </div>
    </div>
  )
}
