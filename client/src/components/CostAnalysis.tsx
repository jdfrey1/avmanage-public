import { useEffect, useState } from 'react'
import { api, type CostAnalysis as CostAnalysisData } from '@/lib/api'
import { useUrlState } from '@/lib/navigation'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

// Ledger → Cost Analysis: what the aircraft cost over a period (from ledger expenses — the same
// categories as the monthly report) and per flight hour. Deliberately no per-pilot allocation:
// fixed costs are shared regardless of hours flown.

type Range = 'ytd' | '12mo' | 'last_year' | 'custom'
const RANGES: readonly Range[] = ['ytd', '12mo', 'last_year', 'custom']
const RANGE_LABELS: Record<Range, string> = { ytd: 'Year to date', '12mo': 'Last 12 months', last_year: 'Last year', custom: 'Custom' }

const iso = (d: Date) => d.toLocaleDateString('en-CA')
const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const dollars = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

function rangeDates(range: Range, from: string, to: string): [string, string] {
  const now = new Date()
  const y = now.getFullYear()
  if (range === '12mo') { const s = new Date(now); s.setFullYear(y - 1); s.setDate(s.getDate() + 1); return [iso(s), iso(now)] }
  if (range === 'last_year') return [`${y - 1}-01-01`, `${y - 1}-12-31`]
  if (range === 'custom' && from && to) return [from, to]
  return [`${y}-01-01`, iso(now)]
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card px-2.5 py-3 sm:px-3">
      <p className="truncate text-lg font-bold tabular-nums sm:text-xl">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

export function CostAnalysis() {
  const [range, setRange] = useUrlState<Range>('range', 'ytd', RANGES)
  const [from, setFrom] = useUrlState<string>('from', '')
  const [to, setTo] = useUrlState<string>('to', '')
  const [data, setData] = useState<CostAnalysisData | null>(null)
  const [error, setError] = useState('')
  const [start, end] = rangeDates(range, from, to)

  useEffect(() => {
    setError('')
    api.get<CostAnalysisData>(`/ledger/cost-analysis?start=${start}&end=${end}`)
      .then(setData).catch(e => setError(e.message))
  }, [start, end])

  function pickRange(r: Range) {
    if (r === 'custom' && !from) { setFrom(start); setTo(end) }
    setRange(r)
  }

  const fmtDay = (d: string) => new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap gap-2">
        {RANGES.map(r => (
          <button key={r} type="button" onClick={() => pickRange(r)}
            className={cn('rounded-full border px-3 py-1 text-xs transition-colors',
              range === r ? 'border-primary bg-primary/10 font-medium text-primary' : 'border-border text-muted-foreground hover:text-foreground')}>
            {RANGE_LABELS[r]}
          </button>
        ))}
      </div>
      {range === 'custom' && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1"><Label className="text-xs">From</Label><Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="h-8 text-xs" /></div>
          <div className="space-y-1"><Label className="text-xs">To</Label><Input type="date" value={to} onChange={e => setTo(e.target.value)} className="h-8 text-xs" /></div>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {!data ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <>
          <p className="text-xs text-muted-foreground">{fmtDay(data.start_date)} – {fmtDay(data.end_date)}</p>
          <div className="grid grid-cols-3 gap-2">
            <Stat value={dollars(data.total_cost)} label="Aircraft costs" />
            <Stat value={data.total_hours.toFixed(1)} label="Hours flown" />
            <Stat value={data.total_hours > 0 ? dollars(data.cost_per_hour) : '—'} label="Per hour" />
          </div>
          {data.first_flight_date && data.first_flight_date > data.start_date && (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Flights are only logged in the app from {fmtDay(data.first_flight_date)}, so hours before then aren't counted
              and the per-hour cost and shares below are overstated for this period.
            </p>
          )}

          {data.total_cost === 0 ? (
            <p className="text-sm text-muted-foreground">No aircraft costs in the Ledger for this period.</p>
          ) : (
            <div className="rounded-lg border bg-card p-3 space-y-1.5">
              <div className="flex justify-between text-sm">
                <span className="font-medium">Fixed costs</span>
                <span className="tabular-nums font-medium">{money(data.fixed_cost)}</span>
              </div>
              {data.by_category.filter(r => !r.variable).map(r => (
                <div key={r.category} className="flex justify-between pl-3 text-xs text-muted-foreground">
                  <span>{r.category}</span><span className="tabular-nums">{money(r.total)}</span>
                </div>
              ))}
              {data.variable_cost !== 0 && (
                <>
                  <div className="flex justify-between border-t pt-1.5 text-sm">
                    <span className="font-medium">Per-hour costs</span>
                    <span className="tabular-nums font-medium">{money(data.variable_cost)}</span>
                  </div>
                  {data.by_category.filter(r => r.variable).map(r => (
                    <div key={r.category} className="flex justify-between pl-3 text-xs text-muted-foreground">
                      <span>{r.category}</span><span className="tabular-nums">{money(r.total)}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            Counts Ledger expenses for annual, maintenance, insurance, hangar, subscriptions, capital, fuel, TKS and oil
            (refunds reduce them). Lease payments between members aren't aircraft costs and are left out.
          </p>
        </>
      )}
    </div>
  )
}
