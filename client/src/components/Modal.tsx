import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

// Full-screen on phones, a large centered panel on wider screens. Escape or the backdrop closes it.
export function Modal({ title, subtitle, onClose, children }: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  onClose: () => void
  children: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-stretch justify-center bg-black/60 md:items-center md:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="flex w-full flex-col bg-background md:max-h-[92vh] md:max-w-6xl md:rounded-lg md:border md:shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">{title}</h2>
            {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:text-foreground" title="Close">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
