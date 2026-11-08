import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, TrendingUp, Activity, Gauge } from 'lucide-react'
import { api, type EngineFinding, type EngineTrendsResponse, type GarminTrendPoint } from '@/lib/api'
import { LineChart, SERIES_COLORS, indexTicks, type LineSeries } from '@/components/LineChart'
import { GarminModal } from '@/components/GarminData'
import { cn } from '@/lib/utils'

// Engine monitoring across Garmin data logs, one point per engine run (oldest → newest):
// findings (limits, in-flight events, outliers vs. history, trend shifts) above the charts.

const CYL = [0, 1, 2, 3, 4, 5]
const KIND = {
  limit: { label: 'Limit', icon: Gauge },
  event: { label: 'In flight', icon: Activity },
  outlier: { label: 'Outlier', icon: AlertTriangle },
  trend: { label: 'Trend', icon: TrendingUp },
} as const

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

function FindingRow({ f, run, open, onChange }: {
  f: EngineFinding; run?: GarminTrendPoint; open: (r: GarminTrendPoint) => void; onChange: () => void
}) {
  const K = KIND[f.kind]
  const [acking, setAcking] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  async function post(path: string, body: object) {
    setBusy(true)
    try { await api.post(path, body); onChange() } finally { setBusy(false) }
  }
  const addressed = !!f.ack
  return (
    <li className="px-3 py-2">
      <div className="flex items-start gap-3">
        <K.icon className={cn('mt-0.5 h-4 w-4 shrink-0', addressed ? 'text-muted-foreground' : f.severity === 'warning' ? 'text-destructive' : 'text-amber-500')} />
        <div className="min-w-0 flex-1">
          <p className={cn('text-sm', addressed && 'text-muted-foreground')}>{f.title}</p>
          {f.detail && !addressed && <p className="text-xs text-muted-foreground">{f.detail}</p>}
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {K.label}{run && <> · {shortDate(run.started_at)} {run.origin ?? '?'}→{run.destination ?? '?'}{run.pilot_name && ` · ${run.pilot_name.split(' ')[0]}`} · </>}
            {run && <button type="button" onClick={() => open(run)} className="text-primary hover:underline">view flight data</button>}
          </p>
          {addressed && (
            <p className="mt-1 text-xs">
              <CheckCircle2 className="mr-1 inline h-3 w-3 text-emerald-600" />
              Addressed {shortDate(f.ack!.acked_at)}{f.ack!.acked_by_name && ` by ${f.ack!.acked_by_name.split(' ')[0]}`}
              {f.ack!.note && <span className="text-muted-foreground"> — {f.ack!.note}</span>}
            </p>
          )}
          {acking && (
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                autoFocus
                value={note}
                onChange={e => setNote(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') post('/garmin/findings/ack', { key: f.key, note }) }}
                placeholder="What was done? (optional)"
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
              />
              <button type="button" disabled={busy} onClick={() => post('/garmin/findings/ack', { key: f.key, note })} className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50">Save</button>
              <button type="button" onClick={() => setAcking(false)} className="rounded-md border px-2 py-1 text-xs">Cancel</button>
            </div>
          )}
        </div>
        {!acking && (
          addressed
            ? <button type="button" disabled={busy} onClick={() => post('/garmin/findings/unack', { key: f.key })} className="shrink-0 text-xs text-muted-foreground hover:text-foreground hover:underline">Reopen</button>
            : <button type="button" onClick={() => setAcking(true)} className="shrink-0 text-xs text-primary hover:underline">Mark addressed</button>
        )}
      </div>
      {f.kind === 'trend' && acking && (
        <p className="ml-7 mt-1 text-[11px] text-muted-foreground">If the shift is still there after 5 more flights, it will come back.</p>
      )}
    </li>
  )
}

function Findings({ data, open, onChange }: { data: EngineTrendsResponse; open: (r: GarminTrendPoint) => void; onChange: () => void }) {
  const { findings, addressed, history, runs } = data
  const [showAddressed, setShowAddressed] = useState(false)
  const byId = new Map(runs.map(r => [r.id, r]))
  const warn = findings.filter(f => f.severity === 'warning').length
  return (
    <div className="space-y-2">
      {findings.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          {addressed.length ? 'No open findings.' : 'No limit exceedances, in-flight events, outliers or trend shifts found.'}
        </div>
      ) : (
        <div className="rounded-lg border">
          <p className="border-b px-3 py-2 text-sm font-medium">
            {findings.length} open finding{findings.length > 1 ? 's' : ''}{warn > 0 && <span className="text-destructive"> · {warn} warning{warn > 1 ? 's' : ''}</span>}
          </p>
          <ul className="divide-y">
            {findings.map(f => <FindingRow key={f.key} f={f} run={byId.get(f.log_id)} open={open} onChange={onChange} />)}
          </ul>
        </div>
      )}
      {addressed.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowAddressed(v => !v)} className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            {showAddressed ? 'Hide' : 'Show'} addressed ({addressed.length})
          </button>
          {showAddressed && (
            <ul className="mt-2 divide-y rounded-lg border">
              {addressed.map(f => <FindingRow key={f.key} f={f} run={byId.get(f.log_id)} open={open} onChange={onChange} />)}
            </ul>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {history.cruise_runs} flight{history.cruise_runs === 1 ? '' : 's'} with cruise data.
        {history.cruise_runs < history.outliers_from
          ? ` Comparing flights against this engine's history starts at ${history.outliers_from} flights; trend checks at ${history.trends_from}. Limits and in-flight events are checked on every flight.`
          : history.cruise_runs < history.trends_from
            ? ` Outlier checks are on; trend checks start at ${history.trends_from} flights.`
            : ' Outlier and trend checks are on.'}
        {' '}Cylinder checks use each cylinder's difference from the average of all six, so power setting and weather don't skew them.
      </p>
    </div>
  )
}

export function EngineTrends() {
  const [data, setData] = useState<EngineTrendsResponse | null>(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState<GarminTrendPoint | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const load = () => { api.get<EngineTrendsResponse>('/garmin/trends?limit=200').then(setData).catch(() => setError('Could not load engine data')) }
  useEffect(load, [])

  if (error) return <p className="p-4 text-sm text-destructive">{error}</p>
  if (!data) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>
  const { runs, marks, findings } = data
  if (runs.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No Garmin data yet. Upload “Original CSV” logs from flyGarmin on the Flights page or when logging a flight.
      </p>
    )
  }

  const x = runs.map((_, i) => i)
  const ticks = indexTicks(runs.length, 5)
  const date = (i: number) => (runs[Math.round(i)] ? shortDate(runs[Math.round(i)].started_at) : '')
  const idx = new Map(runs.map((r, i) => [r.id, i]))
  const marked = (key: string) => (marks[key] ?? []).map(id => idx.get(id)).filter((i): i is number => i != null)
  const devs = (a?: (number | null)[]) => {
    if (!a || a.some(v => v == null)) return null
    const m = (a as number[]).reduce((s, v) => s + v, 0) / a.length
    return (a as number[]).map(v => v - m)
  }
  const cyl = (pick: (r: GarminTrendPoint) => (number | null)[] | null | undefined, markKey?: string): LineSeries[] =>
    CYL.map(c => ({ label: `#${c + 1}`, values: runs.map(r => pick(r)?.[c] ?? null), color: SERIES_COLORS[c], marks: markKey ? marked(`${markKey}${c + 1}`) : undefined }))
  const one = (label: string, color: string, pick: (r: GarminTrendPoint) => number | null | undefined, markKey?: string): LineSeries =>
    ({ label, color, values: runs.map(r => pick(r) ?? null), marks: markKey ? marked(markKey) : undefined })
  const common = { x, xLabel: date, xTicks: ticks, hover, onHover: setHover }
  const flagged = new Set(findings.map(f => f.log_id))
  const flaggedAddressed = new Set(data.addressed.map(f => f.log_id).filter(id => !flagged.has(id)))
  const totalHrs = runs.reduce((s, r) => s + (r.engine_hrs ?? 0), 0)

  return (
    <div className="space-y-5 p-4">
      <p className="text-sm text-muted-foreground">{runs.length} engine run{runs.length > 1 ? 's' : ''}, {totalHrs.toFixed(1)} engine hrs of data.</p>
      <Findings data={data} open={setModal} onChange={load} />

      {runs.length < 2 ? (
        <p className="text-sm text-muted-foreground">Trend charts appear once there are at least two engine runs.</p>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          <LineChart title="Cylinder CHT vs. average, cruise" unit="°F" {...common} series={cyl(r => devs(r.stats.cruise?.cht), 'cht_dev')} />
          <LineChart title="Cylinder EGT vs. average, cruise" unit="°F" {...common} series={cyl(r => devs(r.stats.cruise?.egt), 'egt_dev')} />
          <LineChart title="Cruise CHT" unit="°F" {...common} series={cyl(r => r.stats.cruise?.cht)} />
          <LineChart title="Peak CHT" unit="°F" {...common} series={cyl(r => r.stats.cht_max, 'cht_max')} />
          <LineChart title="Oil" {...common} series={[
            one('Max temp °F', SERIES_COLORS[0], r => r.stats.oilt_max),
            one('Cruise temp °F', SERIES_COLORS[1], r => r.stats.cruise?.oilt, 'oilt'),
            one('Cruise press psi', SERIES_COLORS[3], r => r.stats.cruise?.oilp, 'oilp'),
          ]} />
          <LineChart title="Cruise power" digits={1} {...common} series={[
            one('FF gph', SERIES_COLORS[1], r => r.stats.cruise?.ff),
            one('FF at 65% gph', SERIES_COLORS[2], r => { const c = r.stats.cruise; return c?.ff != null && c?.pwr ? (c.ff / c.pwr) * 0.65 : null }, 'ff_per_pwr'),
            one('MAP inHg', SERIES_COLORS[3], r => r.stats.cruise?.map),
          ]} />
          <LineChart title="Cruise TAS" unit="kt" {...common} series={[one('TAS', SERIES_COLORS[2], r => r.stats.cruise?.tas)]} />
          <LineChart title="Lowest bus voltage after warm-up" unit="V" digits={1} {...common} series={[one('Volts', SERIES_COLORS[1], r => r.stats.volt_min)]} />
        </div>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 font-medium">Date</th>
              <th className="px-2 py-1.5 font-medium">Route</th>
              <th className="px-2 py-1.5 text-right font-medium">Engine</th>
              <th className="px-2 py-1.5 text-right font-medium">Fuel</th>
              <th className="px-2 py-1.5 text-right font-medium">Peak CHT</th>
              <th className="px-2 py-1.5 text-right font-medium">Oil max</th>
            </tr>
          </thead>
          <tbody className="divide-y tabular-nums">
            {[...runs].reverse().map(r => (
              <tr key={r.id} onClick={() => setModal(r)} className={cn('cursor-pointer hover:bg-accent/40', flagged.has(r.id) && 'bg-amber-500/10')}>
                <td className="whitespace-nowrap px-2 py-1.5">
                  {flagged.has(r.id) && <AlertTriangle className="mr-1 inline h-3 w-3 text-amber-500" />}
                  {flaggedAddressed.has(r.id) && <span title="Finding addressed"><AlertTriangle className="mr-1 inline h-3 w-3 text-muted-foreground" /></span>}
                  {shortDate(r.started_at)}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5">{r.origin ?? '?'}→{r.destination ?? '?'}{r.pilot_name && <span className="text-muted-foreground"> · {r.pilot_name.split(' ')[0]}</span>}</td>
                <td className="px-2 py-1.5 text-right">{r.engine_hrs?.toFixed(1) ?? '—'}</td>
                <td className="px-2 py-1.5 text-right">{r.fuel_used_gal?.toFixed(1) ?? '—'}</td>
                <td className="whitespace-nowrap px-2 py-1.5 text-right">{r.max_cht ?? '—'}° #{r.max_cht_cyl ?? '?'}</td>
                <td className="px-2 py-1.5 text-right">{r.stats.oilt_max ?? '—'}°</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {modal && <GarminModal log={modal} onClose={() => setModal(null)} />}
    </div>
  )
}
