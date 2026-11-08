import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Upload } from 'lucide-react'
import { api, type Flight, type GarminLog, type GarminSeries, type GarminUploadResult } from '@/lib/api'
import { Select } from '@/components/ui/select'
import { LineChart, SERIES_COLORS, timeTicks, type LineSeries } from '@/components/LineChart'
import { Modal } from '@/components/Modal'
import { TrackMap } from '@/components/TrackMap'

const clock = (iso?: string | number | null) =>
  iso != null ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—'
const hrs = (h: number | null | undefined) => (h == null ? '—' : h.toFixed(1))
const sum = (logs: GarminLog[], k: 'engine_hrs' | 'air_hrs' | 'fuel_used_gal') =>
  logs.reduce((s, l) => s + (l[k] ?? 0), 0)

// One-line summary of a set of engine runs.
export function garminSummary(logs: GarminLog[]) {
  const hottest = logs.reduce<GarminLog | null>((b, l) => (l.max_cht != null && (!b || l.max_cht > (b.max_cht ?? 0)) ? l : b), null)
  return [
    `${sum(logs, 'engine_hrs').toFixed(1)} hrs engine`,
    `${sum(logs, 'air_hrs').toFixed(1)} airborne`,
    `${sum(logs, 'fuel_used_gal').toFixed(1)} gal burned`,
    hottest && `peak CHT ${hottest.max_cht}° (#${hottest.max_cht_cyl})`,
  ].filter(Boolean).join(' · ')
}

// Garmin data in a pop-up: map plus charts, all sharing one cursor (touch/hover a chart and the
// map marker and every chart follow).
export function GarminModal({ log, onClose }: { log: GarminLog; onClose: () => void }) {
  const [s, setS] = useState<GarminSeries | null>(null)
  const [err, setErr] = useState('')
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    api.get<GarminSeries>(`/garmin/${log.id}/series`).then(setS).catch(() => setErr('Could not load the data.'))
  }, [log.id])
  const points = useMemo(() => (s?.t ?? []).map((_, i) => {
    const lat = s?.lat?.[i], lon = s?.lon?.[i]
    return lat != null && lon != null ? { lat, lon } : null
  }), [s])

  const day = new Date(log.engine_on_at ?? log.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const title = `${log.origin ?? '?'} → ${log.destination ?? '?'} · ${day}`
  const subtitle = `Garmin data · ${garminSummary([log])}`
  if (err || !s) {
    return <Modal title={title} subtitle={subtitle} onClose={onClose}><p className="text-sm text-muted-foreground">{err || 'Loading…'}</p></Modal>
  }

  const x = s.t
  const xLabel = (sec: number) => clock(s.t0 + sec * 1000)
  const ticks = timeTicks(x, s.t0)
  const col = (k: string) => s[k] ?? []
  const cyl = (prefix: 'cht' | 'egt') => [1, 2, 3, 4, 5, 6]
    .filter(c => s[`${prefix}${c}`])
    .map((c, i): LineSeries => ({ label: `#${c}`, values: col(`${prefix}${c}`), color: SERIES_COLORS[i] }))
  const fuel = col('fql').map((l, i) => (l == null && col('fqr')[i] == null ? null : (l ?? 0) + (col('fqr')[i] ?? 0)))
  const common = { x, xLabel, xTicks: ticks, hover, onHover: setHover }

  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose}>
      <div className="space-y-4">
        {points.some(Boolean) && <TrackMap points={points} hover={hover} />}
        <div className="grid gap-4 md:grid-cols-2">
          <LineChart title="Altitude" unit="ft MSL" {...common} series={[{ label: 'MSL', values: col('alt'), color: SERIES_COLORS[3] }]} />
          <LineChart title="Speed" unit="kt" {...common} series={[
            { label: 'IAS', values: col('ias'), color: SERIES_COLORS[3] },
            { label: 'TAS', values: col('tas'), color: SERIES_COLORS[4] },
            { label: 'GS', values: col('gs'), color: SERIES_COLORS[2] },
          ]} />
          <LineChart title="RPM" {...common} series={[{ label: 'RPM', values: col('rpm'), color: SERIES_COLORS[0] }]} />
          <LineChart title="Manifold pressure / fuel flow" digits={1} {...common} series={[
            { label: 'MAP inHg', values: col('map'), color: SERIES_COLORS[3] },
            { label: 'FF gph', values: col('ff'), color: SERIES_COLORS[1] },
          ]} />
          <LineChart title="CHT" unit="°F" {...common} series={cyl('cht')} />
          <LineChart title="EGT" unit="°F" {...common} series={cyl('egt')} />
          <LineChart title="Oil" {...common} series={[
            { label: 'Temp °F', values: col('oilt'), color: SERIES_COLORS[0] },
            { label: 'Press psi', values: col('oilp'), color: SERIES_COLORS[3] },
          ]} />
          <LineChart title="Fuel on board" unit="gal" digits={1} {...common} series={[{ label: 'Total', values: fuel, color: SERIES_COLORS[2] }]} />
          {s.volt && (
            <LineChart title="Electrical" digits={1} {...common} series={[
              { label: 'Volts', values: col('volt'), color: SERIES_COLORS[1] },
              { label: 'Amps', values: col('amp'), color: SERIES_COLORS[5] },
            ]} />
          )}
          <LineChart title="Vertical speed" unit="fpm" {...common} series={[{ label: 'VS', values: col('vs'), color: SERIES_COLORS[4] }]} />
        </div>
      </div>
    </Modal>
  )
}

function LogRow({ log, onChange }: { log: GarminLog; onChange: () => void }) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [msg, setMsg] = useState('')
  async function detach() {
    try { await api.post(`/garmin/${log.id}/detach`, {}); onChange() }
    catch { setMsg('Could not detach.'); setConfirm(false) }
  }
  const st = log.stats
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="tabular-nums">{log.origin ?? '?'} {clock(log.takeoff_at ?? log.engine_on_at)} → {log.destination ?? '?'} {clock(log.landing_at ?? log.engine_off_at)}</span>
        <span className="tabular-nums text-muted-foreground">
          {hrs(log.engine_hrs)} engine · {hrs(log.air_hrs)} air · {log.fuel_used_gal?.toFixed(1) ?? '—'} gal
        </span>
        <button type="button" onClick={() => setOpen(true)} className="text-primary hover:underline">Map &amp; charts</button>
        <a href={`/api/garmin/${log.id}/download`} className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground" title="Download original CSV">
          <Download className="h-3 w-3" />
        </a>
        {confirm ? (
          <span className="ml-auto flex items-center gap-2">
            <span className="text-muted-foreground">Wrong flight?</span>
            <button type="button" onClick={detach} className="text-destructive hover:underline">Detach</button>
            <button type="button" onClick={() => setConfirm(false)} className="text-muted-foreground hover:underline">Cancel</button>
          </span>
        ) : (
          <button type="button" onClick={() => setConfirm(true)} className="ml-auto text-muted-foreground hover:text-foreground hover:underline">Detach</button>
        )}
      </div>
      <p className="mt-0.5 tabular-nums text-muted-foreground">
        Peak CHT {log.max_cht ?? '—'}° (#{log.max_cht_cyl ?? '?'}) · oil {st.oilt_max ?? '—'}°F, {st.oilp_min ?? '—'}–{st.oilp_max ?? '—'} psi
        {st.cruise && <> · cruise {st.cruise.ff} gph, {st.cruise.tas} kt TAS, {Math.round((st.cruise.pwr ?? 0) * 100)}% power</>}
      </p>
      {(st.events ?? []).map(e => (
        <p key={e.type + e.at} className={e.severity === 'warning' ? 'mt-0.5 font-medium text-destructive' : 'mt-0.5 font-medium text-amber-600 dark:text-amber-400'}>
          ⚠ {e.msg} <span className="font-normal text-muted-foreground">at {clock(e.at)}</span>
        </p>
      ))}
      {msg && <p className="mt-1 text-destructive">{msg}</p>}
      {open && <GarminModal log={log} onClose={() => setOpen(false)} />}
    </div>
  )
}

// Garmin data box on a flight card.
export function GarminDataInfo({ logs, onChange }: { logs: GarminLog[]; onChange: () => void }) {
  return (
    <div className="h-full space-y-2 rounded-md border bg-muted/20 p-2 text-xs" onClick={e => e.stopPropagation()}>
      <p className="font-medium">
        Garmin data <span className="font-normal text-muted-foreground">· {garminSummary(logs)}</span>
      </p>
      {logs.map(l => <LogRow key={l.id} log={l} onChange={onChange} />)}
    </div>
  )
}

// Card placeholder when a flight has no Garmin data yet, with an upload link for that flight.
export function GarminDataEmpty({ flightId, onChange }: { flightId: string; onChange: () => void }) {
  return (
    <div className="flex h-full flex-wrap items-center gap-x-2 rounded-md border border-dashed p-2 text-xs text-muted-foreground" onClick={e => e.stopPropagation()}>
      <span className="font-medium text-foreground">Garmin data</span>
      <span>none</span>
      <span className="ml-auto"><GarminUploadButton flightId={flightId} onDone={onChange} label="Upload" /></span>
    </div>
  )
}

// Upload one or more "Original CSV" files. flightId attaches them all to that flight; hold leaves
// them unattached (Log Flight attaches them after saving).
export function useGarminUpload() {
  const [busy, setBusy] = useState(false)
  async function upload(files: File[], opts: { flightId?: string; hold?: boolean } = {}) {
    setBusy(true)
    try {
      const fd = new FormData()
      files.forEach(f => fd.append('logs', f))
      if (opts.flightId) fd.append('flight_id', opts.flightId)
      if (opts.hold) fd.append('hold', '1')
      return (await api.upload<{ results: GarminUploadResult[] }>('/garmin/upload', fd)).results
    } finally { setBusy(false) }
  }
  return { upload, busy }
}

export function describeResults(results: GarminUploadResult[]) {
  const n = (s: GarminUploadResult['status']) => results.filter(r => r.status === s).length
  const parts = [
    n('attached') && `${n('attached')} attached to a flight`,
    n('unmatched') && `${n('unmatched')} not matched — attach below`,
    n('duplicate') && `${n('duplicate')} already uploaded`,
  ].filter(Boolean) as string[]
  const errors = results.filter(r => r.status === 'error').map(r => `${r.filename}: ${r.error}`)
  return { text: parts.join(' · '), errors }
}

export function GarminUploadButton({ onDone, flightId, label = 'Garmin data' }: { onDone: () => void; flightId?: string; label?: string }) {
  const ref = useRef<HTMLInputElement>(null)
  const { upload, busy } = useGarminUpload()
  const [msg, setMsg] = useState<{ text: string; errors: string[] } | null>(null)
  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!files.length) return
    try {
      setMsg(describeResults(await upload(files, { flightId })))
      onDone()
    } catch (err) {
      setMsg({ text: '', errors: [err instanceof Error ? err.message : 'Upload failed'] })
    }
  }
  return (
    <>
      <button
        type="button"
        onClick={() => ref.current?.click()}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded-md p-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        title="Upload Garmin data logs (Original CSV from flyGarmin)"
      >
        <Upload className="h-4 w-4" /> {busy ? 'Uploading…' : label}
      </button>
      <input ref={ref} type="file" accept=".csv,text/csv" multiple className="hidden" onChange={pick} />
      {msg && (msg.text || msg.errors.length > 0) && (
        <div className="basis-full text-xs">
          {msg.text && <p className="text-emerald-700 dark:text-emerald-400">{msg.text}</p>}
          {msg.errors.map(e => <p key={e} className="text-destructive">{e}</p>)}
        </div>
      )}
    </>
  )
}

// Top-of-page Garmin box: upload link, plus logs that didn't match a logged flight with a manual
// attach picker.
export function UnmatchedGarmin({ flights, reloadKey, onChange }: { flights: Flight[]; reloadKey: number; onChange: () => void }) {
  const [items, setItems] = useState<GarminLog[] | null>(null)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [msg, setMsg] = useState<{ text: string; errors: string[] } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { upload, busy } = useGarminUpload()
  useEffect(() => { api.get<GarminLog[]>('/garmin/unmatched').then(setItems).catch(() => setItems([])) }, [reloadKey])

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    if (!files.length) return
    setError('')
    try { setMsg(describeResults(await upload(files))); onChange() }
    catch (err) { setMsg({ text: '', errors: [err instanceof Error ? err.message : 'Upload failed'] }) }
  }
  async function attach(id: string) {
    setError('')
    try { await api.post(`/garmin/${id}/attach`, { flight_id: picked[id] }); onChange() }
    catch { setError('Could not attach') }
  }
  async function remove(id: string) {
    setError('')
    try { await api.delete(`/garmin/${id}`); setItems(l => (l ?? []).filter(i => i.id !== id)) }
    catch { setError('Could not delete') }
  }

  if (!items) return null
  const day = (iso: string) => new Date(iso).toLocaleDateString('en-CA')
  return (
    <div className="h-full rounded-lg border bg-card p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">Garmin data logs not matched to a logged flight ({items.length})</p>
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} className="shrink-0 text-primary hover:underline disabled:opacity-50">
          {busy ? 'Uploading…' : 'Upload Garmin data'}
        </button>
        <input ref={inputRef} type="file" accept=".csv,text/csv" multiple className="hidden" onChange={pick} />
      </div>
      {msg?.text && <p className="mt-1 text-emerald-700 dark:text-emerald-400">{msg.text}</p>}
      {msg?.errors.map(e => <p key={e} className="mt-1 text-destructive">{e}</p>)}
      {error && <p className="mt-1 text-destructive">{error}</p>}
      {items.length === 0 ? (
        <p className="mt-1 text-muted-foreground">Nothing unmatched. Upload “Original CSV” files from flyGarmin; each attaches to the logged flight it belongs to.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {items.map(it => {
            const d = day(it.engine_on_at ?? it.started_at)
            const near = flights.filter(f => Math.abs(Date.parse(f.flight_date) - Date.parse(d)) <= 86400000)
            return (
              <li key={it.id} className="rounded-md bg-muted/30 p-2">
                <p className="tabular-nums">
                  {d} · {it.origin ?? '?'} {clock(it.takeoff_at ?? it.engine_on_at)} → {it.destination ?? '?'} {clock(it.landing_at ?? it.engine_off_at)}
                  <span className="text-muted-foreground"> · {hrs(it.engine_hrs)} engine, {hrs(it.air_hrs)} air</span>
                </p>
                <div className="mt-1.5 flex gap-2">
                  {near.length > 0 && (
                    <>
                      <Select
                        value={picked[it.id] ?? ''}
                        onChange={e => setPicked(p => ({ ...p, [it.id]: e.target.value }))}
                        className="flex-1 rounded-md border border-input bg-background px-2 py-1"
                      >
                        <option value="">Attach to a logged flight…</option>
                        {near.map(f => <option key={f.id} value={f.id}>{f.flight_date} · {f.pilot_name.split(' ')[0]} · {f.route ?? 'no route'}</option>)}
                      </Select>
                      <button type="button" disabled={!picked[it.id]} onClick={() => attach(it.id)} className="rounded-md border px-2 py-1 disabled:opacity-40">Attach</button>
                    </>
                  )}
                  <button type="button" onClick={() => remove(it.id)} className="ml-auto rounded-md border px-2 py-1 text-muted-foreground hover:text-destructive">Delete</button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
