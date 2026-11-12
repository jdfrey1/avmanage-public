// Calendar-style date tile (month over day), shared by the Dashboard, Flights and Schedule lists.
// Accepts a YYYY-MM-DD date or a full ISO timestamp; adds the year when it isn't the current one.
export function DateTile({ date }: { date: string }) {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? date + 'T12:00:00' : date)
  const otherYear = d.getFullYear() !== new Date().getFullYear()
  return (
    <div className="flex w-10 shrink-0 flex-col items-center rounded-md bg-muted py-1 text-center">
      <span className="text-[10px] uppercase leading-tight text-muted-foreground">
        {d.toLocaleDateString('en-US', { month: 'short' })}
      </span>
      <span className="text-lg font-bold leading-none">{d.getDate()}</span>
      {otherYear && <span className="text-[9px] leading-tight text-muted-foreground">{d.getFullYear()}</span>}
    </div>
  )
}
