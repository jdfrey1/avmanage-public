import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { api, type AircraftStatus } from '@/lib/api'

export function useAircraftStatus() {
  const [status, setStatus] = useState<AircraftStatus | null>(null)
  useEffect(() => { api.get<AircraftStatus>('/maintenance/aircraft-status').then(setStatus).catch(() => {}) }, [])
  return status
}

const fmt = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

// True when a date (YYYY-MM-DD) falls on or after the day insurance coverage ends.
export function pastInsurance(status: AircraftStatus | null, date: string | null | undefined) {
  return !!(status?.insurance_expires_date && date && date >= status.insurance_expires_date)
}

export function AircraftStatusBanner({ status }: { status: AircraftStatus | null }) {
  if (!status) return null
  const today = new Date().toLocaleDateString('en-CA')
  const insDays = status.insurance_expires_date
    ? Math.round((Date.parse(status.insurance_expires_date) - Date.parse(today)) / 86400000) : null
  const lines: { tone: 'red' | 'amber'; text: string }[] = []
  if (status.grounded) {
    lines.push({ tone: 'red', text: `Grounded — open major squawk: ${status.major_squawks[0].description.slice(0, 90)}${status.major_squawks.length > 1 ? ` (+${status.major_squawks.length - 1} more)` : ''}` })
  }
  for (const i of status.overdue) lines.push({ tone: 'red', text: `Overdue: ${i.title} (was due ${fmt(i.due_date!)})` })
  for (const i of status.due_soon) lines.push({ tone: 'amber', text: `Due soon: ${i.title} (${fmt(i.due_date!)}, ${i.days_until} days)` })
  if (insDays != null && insDays <= 30) {
    lines.push({ tone: insDays <= 0 ? 'red' : 'amber', text: insDays <= 0
      ? `Insurance on record ended ${fmt(status.insurance_expires_date!)}`
      : `Insurance on record ends ${fmt(status.insurance_expires_date!)} (${insDays} days)` })
  }
  if (!lines.length) return null
  return (
    <div className="space-y-1">
      {lines.map((l, i) => (
        <div key={i} className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${l.tone === 'red'
          ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'}`}>
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  )
}

export function InsuranceWarning({ status, date }: { status: AircraftStatus | null; date: string | null | undefined }) {
  if (!pastInsurance(status, date)) return null
  return (
    <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
      Insurance on record ends {fmt(status!.insurance_expires_date!)}. This reservation is on or after that date and isn't covered
      unless the policy is renewed — update the date in Settings → Aircraft once it is.
    </p>
  )
}
