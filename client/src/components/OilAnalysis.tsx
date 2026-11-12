import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileText, Upload, RefreshCw, Trash2 } from 'lucide-react'
import { oilApi, type OilAnalysisResponse, type OilSample } from '@/lib/api'
import { LineChart, SERIES_COLORS, indexTicks } from '@/components/LineChart'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

// Rows shown in the history table: the wear metals that matter most, then contamination and the oil.
const TABLE_ELEMENTS = ['iron', 'chromium', 'nickel', 'aluminum', 'copper', 'tin', 'lead', 'silicon']
const TABLE_PROPS: [string, string][] = [
  ['fuel_pct', 'Fuel %'], ['water_pct', 'Water %'], ['insolubles_pct', 'Insolubles %'],
  ['sus_viscosity_210f', 'Viscosity SUS'], ['flashpoint_f', 'Flashpoint °F'],
]
const CHART_METALS = ['iron', 'chromium', 'nickel', 'aluminum', 'copper']

const fmtDate = (d: string) => new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const shortDate = (d: string) => new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'numeric', year: '2-digit' })
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

export function OilAnalysis() {
  const [data, setData] = useState<OilAnalysisResponse | null>(null)
  const [error, setError] = useState('')
  const [perHour, setPerHour] = useState(true)
  const [search, setSearch] = useState('')
  const [uploading, setUploading] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function load() { oilApi.list().then(setData).catch(e => setError(e.message)) }
  useEffect(load, [])

  async function onFile(file: File | undefined) {
    if (!file) return
    setUploading(true); setMsg(null)
    try {
      const r = await oilApi.upload(file)
      setMsg({ ok: true, text: `Read ${r.reports} report${r.reports === 1 ? '' : 's'}.` })
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'Upload failed' }) }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; load() }
  }

  const samples = data?.samples ?? []
  const symbol = (k: string) => data?.elements.find(e => e.key === k)?.symbol ?? k
  const source = (k: string) => data?.elements.find(e => e.key === k)?.source ?? ''

  // Oldest → newest for the chart. Very short oil runs (e.g. a 10-hour break-in change) read
  // far higher per hour and would flatten everything else, so the chart skips them.
  const chrono = useMemo(() => [...samples].reverse().filter(s => (s.oil_hours ?? 0) >= 15), [samples])

  const q = search.trim().toLowerCase()
  const reports = samples.filter(s => s.comments || s.notes).filter(s => !q ||
    [s.comments, s.notes, s.lab_number, s.submitted_by, s.sample_date].some(v => v?.toLowerCase().includes(q)))

  if (error) return <p className="p-4 text-sm text-destructive">{error}</p>
  if (!data) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>

  const value = (s: OilSample, k: string) => {
    const v = s.elements[k]
    if (v == null) return '—'
    return perHour && s.oil_hours ? (v / s.oil_hours).toFixed(k === 'lead' ? 0 : 2) : String(v)
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {samples.length} samples{samples.length ? ` · ${fmtDate(samples[samples.length - 1].sample_date)} – ${fmtDate(samples[0].sample_date)}` : ''}
        </p>
        <div className="flex items-center gap-2">
          <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={e => onFile(e.target.files?.[0])} />
          <Button size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            <Upload className="h-4 w-4" /> {uploading ? 'Reading report…' : 'Upload report'}
          </Button>
        </div>
      </div>
      {msg && <p className={cn('text-xs', msg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>{msg.text}</p>}

      {samples.length === 0 ? (
        <p className="text-sm text-muted-foreground">No oil analysis reports yet. Upload a lab report PDF to start a history.</p>
      ) : (
        <>
          <div className="space-y-1.5 rounded-lg border bg-card p-3">
            <p className="text-sm font-semibold">Trends</p>
            {data.trends.length === 0 ? (
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> Nothing out of line with this engine's history.</p>
            ) : data.trends.map((t, i) => (
              <p key={i} className="flex gap-1.5 text-sm">
                {t.level === 'watch'
                  ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />}
                <span>{t.text}</span>
              </p>
            ))}
            {samples[0].comments && (
              <p className="border-t pt-2 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Lab, {fmtDate(samples[0].sample_date)}:</span> {samples[0].comments}
              </p>
            )}
          </div>

          <LineChart
            title={`Wear metals per hour on the oil${chrono.length < samples.length ? ' (oil runs of 15+ hrs)' : ''}`} unit=" ppm/hr" digits={2} height={180}
            x={chrono.map((_, i) => i)}
            xTicks={indexTicks(chrono.length)}
            xLabel={i => chrono[i] ? `${shortDate(chrono[i].sample_date)} · ${chrono[i].unit_hours ?? '?'} h` : ''}
            series={CHART_METALS.map((m, i) => ({
              label: `${cap(m)} (${symbol(m)})`,
              color: SERIES_COLORS[i],
              values: chrono.map(s => s.elements[m] != null && s.oil_hours ? +(s.elements[m] / s.oil_hours).toFixed(2) : null),
              marks: chrono.flatMap((s, j) => s.flags.includes(m) ? [j] : []),
            }))}
          />

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold">History</p>
              <div className="flex rounded-md border text-xs">
                {([[true, 'ppm/hr'], [false, 'ppm']] as const).map(([v, l]) => (
                  <button key={l} onClick={() => setPerHour(v)}
                    className={cn('px-2 py-0.5', perHour === v ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground')}>{l}</button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="text-xs">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="sticky left-0 bg-muted px-2 py-1.5 text-left font-medium">Sample</th>
                    {samples.map(s => (
                      <th key={s.id} className="whitespace-nowrap px-2 py-1.5 text-right font-medium" title={s.notes ?? undefined}>
                        {shortDate(s.sample_date)}{s.notes ? '*' : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t">
                    <td className="sticky left-0 bg-background px-2 py-1 text-muted-foreground">Hrs on oil</td>
                    {samples.map(s => <td key={s.id} className="px-2 py-1 text-right">{s.oil_hours ?? '—'}</td>)}
                  </tr>
                  <tr>
                    <td className="sticky left-0 bg-background px-2 py-1 text-muted-foreground">Engine hrs</td>
                    {samples.map(s => <td key={s.id} className="px-2 py-1 text-right">{s.unit_hours ?? '—'}</td>)}
                  </tr>
                  {TABLE_ELEMENTS.map(k => (
                    <tr key={k} className="border-t">
                      <td className="sticky left-0 bg-background px-2 py-1" title={source(k)}>{cap(k)}</td>
                      {samples.map(s => (
                        <td key={s.id} className={cn('px-2 py-1 text-right tabular-nums', s.flags.includes(k) && 'font-semibold text-amber-600 dark:text-amber-400')}>
                          {value(s, k)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {TABLE_PROPS.map(([k, label], i) => (
                    <tr key={k} className={cn(i === 0 && 'border-t-2')}>
                      <td className="sticky left-0 bg-background px-2 py-1 text-muted-foreground">{label}</td>
                      {samples.map(s => (
                        <td key={s.id} className={cn('px-2 py-1 text-right tabular-nums', s.flags.includes(k) && 'font-semibold text-amber-600 dark:text-amber-400')}>
                          {s.properties[k] ?? '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-muted-foreground">Highlighted values were flagged by the lab. Per-hour figures divide by hours on the oil, so short oil runs read a little high.</p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">Lab comments</p>
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search comments (e.g. silicon, fuel, chrome)…" className="h-8 max-w-xs text-sm" />
            </div>
            {reports.length === 0 ? <p className="text-sm text-muted-foreground">No comments match.</p> : (
              <ul className="space-y-2">
                {reports.map(s => (
                  <li key={s.id} className="rounded-md border p-2.5 text-sm">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{fmtDate(s.sample_date)}</span>
                      <span>{s.oil_hours ?? '?'} hrs on oil · {s.unit_hours ?? '?'} engine hrs</span>
                      {s.lab_number && <span>· {s.lab} {s.lab_number}</span>}
                      {s.submitted_by && <span>· {s.submitted_by}</span>}
                      {s.flags.length > 0 && <span className="text-amber-600 dark:text-amber-400">· flagged: {s.flags.map(f => f.replace(/_pct|_f$/, '')).join(', ')}</span>}
                      {s.file_id && (
                        <a href={oilApi.fileUrl(s.file_id, s.page_number)} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 hover:text-foreground">
                          <FileText className="h-3.5 w-3.5" /> Report
                        </a>
                      )}
                    </div>
                    {s.comments && <p className="mt-1">{s.comments}</p>}
                    {s.notes && <p className="mt-1 text-xs text-muted-foreground">Note: {s.notes}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {data.files.length > 0 && (
        <div className="space-y-1">
          <p className="text-sm font-semibold">Report files</p>
          <ul className="space-y-1 text-sm">
            {data.files.map(f => (
              <li key={f.id} className="flex items-center gap-2">
                <a href={oilApi.fileUrl(f.id)} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:underline">
                  <FileText className="h-4 w-4 text-muted-foreground" /> {f.filename}
                </a>
                <span className="text-xs text-muted-foreground">
                  {f.status === 'error' ? <span className="text-destructive">couldn't be read</span> : `${f.sample_count} samples`}
                </span>
                <span className="ml-auto flex gap-1">
                  {f.status === 'error' && (
                    <button title="Read again" className="p-1 text-muted-foreground hover:text-foreground"
                      onClick={() => oilApi.reprocess(f.id).then(load).catch(e => setMsg({ ok: false, text: e.message }))}>
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button title="Remove" className="p-1 text-muted-foreground hover:text-destructive"
                    onClick={() => { if (confirm(`Remove ${f.filename} and its samples?`)) oilApi.remove(f.id).then(load) }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
