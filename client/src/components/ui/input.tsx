import { cn } from '@/lib/utils'

// Browsers only open the calendar from the small icon; this opens it from anywhere in the field.
export function openPicker(e: React.MouseEvent<HTMLInputElement>) {
  try { e.currentTarget.showPicker() } catch { /* unsupported or disabled */ }
}

export function Input({ className, onClick, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm',
        'placeholder:text-muted-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      onClick={e => {
        if (props.type === 'date' || props.type === 'datetime-local') openPicker(e)
        onClick?.(e)
      }}
      {...props}
    />
  )
}
