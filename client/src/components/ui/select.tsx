import { Children, Fragment, isValidElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

// Drop-in replacement for <select> with <option> children. The list is drawn by the app instead
// of the browser: some browsers place the native list off-screen, leaving the choices invisible.
// onChange receives { target: { value } } so existing `e => set(e.target.value)` handlers work.

interface Opt { value: string; label: React.ReactNode; disabled: boolean }

type OptionProps = { value?: string | number; children?: React.ReactNode; disabled?: boolean }

function collectOptions(children: React.ReactNode, out: Opt[] = []): Opt[] {
  Children.forEach(children, child => {
    if (!isValidElement(child)) return
    if (child.type === Fragment) {
      collectOptions((child.props as { children?: React.ReactNode }).children, out)
    } else if (child.type === 'option') {
      const p = child.props as OptionProps
      out.push({ value: String(p.value ?? p.children ?? ''), label: p.children, disabled: !!p.disabled })
    }
  })
  return out
}

// Sizing classes stay on the wrapper so the field takes the same space as the old <Select>.
const LAYOUT = /^(w-|min-w-|max-w-|flex-|shrink|grow|basis-)/

interface SelectProps {
  value: string | number
  onChange: (e: { target: { value: string } }) => void
  className?: string
  id?: string
  title?: string
  disabled?: boolean
  children: React.ReactNode
}

export function Select({ value, onChange, className, id, title, disabled, children }: SelectProps) {
  const options = collectOptions(children)
  const current = options.find(o => o.value === String(value))
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const classes = (className ?? '').split(/\s+/).filter(Boolean)
  const layout = classes.filter(c => LAYOUT.test(c))
  const look = classes.filter(c => !LAYOUT.test(c))

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return
    const r = buttonRef.current.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - 8
    const above = r.top - 8
    const width = Math.max(r.width, 160)
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8))
    setPos(below >= 200 || below >= above
      ? { top: r.bottom + 4, left, width, maxHeight: Math.min(320, below) }
      : { bottom: window.innerHeight - r.top + 4, left, width, maxHeight: Math.min(320, above) })
  }, [open])

  useEffect(() => {
    if (!open) return
    listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
    function onDown(e: PointerEvent) {
      if (!listRef.current?.contains(e.target as Node) && !buttonRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); buttonRef.current?.focus() }
    }
    function onScroll(e: Event) {
      if (!listRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  function pick(o: Opt) {
    if (o.disabled) return
    setOpen(false)
    buttonRef.current?.focus()
    if (o.value !== String(value)) onChange({ target: { value: o.value } })
  }

  // Arrow keys change the value without opening the list, as a native select does.
  function onButtonKey(e: React.KeyboardEvent) {
    if (open || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
    e.preventDefault()
    const enabled = options.filter(o => !o.disabled)
    const i = enabled.findIndex(o => o.value === String(value))
    const next = enabled[Math.max(0, Math.min(enabled.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (next && next.value !== String(value)) onChange({ target: { value: next.value } })
  }

  return (
    <div className={cn('relative', layout.length ? layout : 'inline-block')}>
      <button
        ref={buttonRef}
        id={id}
        title={title}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onButtonKey}
        className={cn('flex w-full items-center justify-between gap-2 text-left disabled:cursor-not-allowed disabled:opacity-50', look)}
      >
        <span className="min-w-0 truncate">{current?.label ?? ''}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </button>
      {open && pos && createPortal(
        <div
          ref={listRef}
          role="listbox"
          style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
          className="z-[100] overflow-y-auto rounded-md border bg-card p-1 text-sm text-card-foreground shadow-lg"
        >
          {options.map(o => {
            const selected = o.value === String(value)
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={selected}
                data-selected={selected}
                disabled={o.disabled}
                onClick={() => pick(o)}
                className={cn(
                  'flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-accent disabled:opacity-50',
                  selected && 'font-medium',
                )}
              >
                <Check className={cn('h-3.5 w-3.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
                <span className="min-w-0">{o.label}</span>
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}
