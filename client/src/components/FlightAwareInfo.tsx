import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { api, type Flight, type FlightAwareUnmatched, type TrackPoint } from '@/lib/api'

const clock = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—'

function Spark({ label, values, unit }: { label: string; values: number[]; unit: string }) {
  if (values.length < 2) return null
  const max = Math.max(...values, 1)
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 300},${58 - (v / max) * 54}`).join(' ')
  return (
    <div>
      <p className="text-[10px] text-muted-foreground">{label} (max {Math.round(max).toLocaleString()} {unit})</p>
      <svg viewBox="0 0 300 60" className="h-14 w-full rounded bg-muted/40">
        <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary" />
      </svg>
    </div>
  )
}

function TrackView({ track }: { track: TrackPoint[] }) {
  const lat0 = track.reduce((s, p) => s + p.lat, 0) / track.length
  const k = Math.cos((lat0 * Math.PI) / 180)
  const xs = track.map(p => p.lon * k), ys = track.map(p => -p.lat)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const span = Math.max(x1 - x0, y1 - y0, 1e-6)
  const sc = 120 / span, ox = (300 - (x1 - x0) * sc) / 2, oy = (140 - (y1 - y0) * sc) / 2
  const pts = track.map((_, i) => `${ox + (xs[i] - x0) * sc},${oy + (ys[i] - y0) * sc}`)
  const alts = track.map(p => p.alt ?? 0), gss = track.map(p => p.gs ?? 0)
  return (
    <div className="space-y-2">
      <svg viewBox="0 0 300 140" className="h-40 w-full rounded bg-muted/40">
        <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary" />
        <circle cx={pts[0].split(',')[0]} cy={pts[0].split(',')[1]} r="3" className="fill-emerald-500" />
        <circle cx={pts[pts.length - 1].split(',')[0]} cy={pts[pts.length - 1].split(',')[1]} r="3" className="fill-destructive" />
      </svg>
      <Spark label="Altitude" values={alts} unit="ft" />
      <Spark label="Groundspeed" values={gss} unit="kt" />
    </div>
  )
}

export function FlightAwareInfo({ flight: f }: { flight: Flight }) {
  const [track, setTrack] = useState<TrackPoint[] | null>(null)
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation()
    if (open) return setOpen(false)
    setOpen(true)
    if (track) return
    try {
      const r = await api.get<{ track: TrackPoint[]; status: string | null }>(`/flightaware/${f.fa_id}/track`)
      if (r.track.length) setTrack(r.track)
      else setMsg('Track not available for this flight.')
    } catch { setMsg('Could not load the track.') }
  }

  return (
    <div className="mt-2 rounded-md border bg-muted/20 p-2 text-xs" onClick={e => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">FlightAware</span>
        <span className="tabular-nums">{f.fa_origin ?? '?'} {clock(f.fa_off_time)} → {f.fa_destination ?? '?'} {clock(f.fa_on_time)}</span>
        {f.fa_en_route_min != null && <span className="tabular-nums text-muted-foreground">{(f.fa_en_route_min / 60).toFixed(1)} hrs en route</span>}
        {f.fa_url && (
          <a href={f.fa_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
            Flight page <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {f.fa_has_track && (
          <button type="button" onClick={toggle} className="text-primary hover:underline">{open ? 'Hide track' : 'View track'}</button>
        )}
      </div>
      {open && (track ? <div className="mt-2"><TrackView track={track} /></div> : <p className="mt-2 text-muted-foreground">{msg || 'Loading…'}</p>)}
    </div>
  )
}

// Alerts that didn't match a logged flight (e.g. a maintenance test flight), with a manual
// "attach to flight" picker limited to flights logged within a day of the alert.
function UnmatchedTrack({ id }: { id: string }) {
  const [open, setOpen] = useState(false)
  const [track, setTrack] = useState<TrackPoint[] | null>(null)
  async function toggle() {
    setOpen(o => !o)
    if (!track) {
      const r = await api.get<{ track: TrackPoint[] }>(`/flightaware/${id}/track`).catch(() => null)
      if (r?.track.length) setTrack(r.track)
    }
  }
  return (
    <>
      <button type="button" onClick={toggle} className="ml-2 text-primary hover:underline">{open ? 'Hide track' : 'View track'}</button>
      {open && <div className="mt-2">{track ? <TrackView track={track} /> : <p className="text-muted-foreground">Loading…</p>}</div>}
    </>
  )
}

export function UnmatchedFlightAware({ flights, onChange }: { flights: Flight[]; onChange: () => void }) {
  const [items, setItems] = useState<FlightAwareUnmatched[] | null>(null)
  const [showIgnored, setShowIgnored] = useState(false)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.get<FlightAwareUnmatched[]>(`/flightaware/unmatched${showIgnored ? '?ignored=1' : ''}`).then(setItems).catch(() => setItems([]))
  }, [flights, showIgnored])

  async function attach(id: string) {
    setError('')
    try {
      await api.post(`/flightaware/${id}/attach`, { flight_id: picked[id] })
      onChange()
    } catch { setError('Could not attach') }
  }
  async function setIgnored(id: string, ignore: boolean) {
    setError('')
    try {
      await api.post(`/flightaware/${id}/${ignore ? 'ignore' : 'unignore'}`, {})
      setItems(list => (list ?? []).filter(i => i.id !== id))
    } catch { setError('Could not update') }
  }
  async function sync() {
    setSyncing(true); setError('')
    try { await api.post('/flightaware/sync?days=30', {}); onChange() } catch { setError('Check failed') }
    finally { setSyncing(false) }
  }

  const day = (iso: string) => new Date(iso).toLocaleDateString('en-CA')
  if (!items) return null
  return (
    <div className="mb-3 rounded-lg border bg-card p-3 text-xs">
      <div className="flex items-center justify-between">
        <p className="font-medium">{showIgnored ? 'Ignored FlightAware flights' : 'FlightAware flights not matched to a logged flight'} ({items.length})</p>
        <button type="button" onClick={sync} disabled={syncing} className="text-primary hover:underline disabled:opacity-50">
          {syncing ? 'Checking…' : 'Check email now'}
        </button>
      </div>
      {error && <p className="mt-1 text-destructive">{error}</p>}
      <button type="button" onClick={() => setShowIgnored(v => !v)} className="mt-1 text-muted-foreground hover:text-foreground hover:underline">
        {showIgnored ? '← Back to unmatched' : 'Show ignored'}
      </button>
      {items.length === 0 ? (
        <p className="mt-1 text-muted-foreground">{showIgnored ? 'No ignored flights.' : 'Nothing unmatched. New flights from FlightAware alert emails appear here until they match a logged flight.'}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {items.map(it => {
            const d = it.off_time ? day(it.off_time) : ''
            const near = flights.filter(f => d && Math.abs(Date.parse(f.flight_date) - Date.parse(d)) <= 86400000)
            return (
              <li key={it.id} className="rounded-md bg-muted/30 p-2">
                <p className="tabular-nums">
                  {d} · {it.origin ?? '?'} {clock(it.off_time)} → {it.destination ?? '?'} {clock(it.on_time)}
                  {it.en_route_min != null && <span className="text-muted-foreground"> · {(it.en_route_min / 60).toFixed(1)} hrs</span>}
                  {it.url && <a href={it.url} target="_blank" rel="noreferrer" className="ml-2 text-primary hover:underline">Flight page</a>}
                  {it.has_track && <UnmatchedTrack id={it.id} />}
                </p>
                <div className="mt-1.5 flex gap-2">
                  {!showIgnored && near.length > 0 && (
                    <>
                    <select
                      value={picked[it.id] ?? ''}
                      onChange={e => setPicked(p => ({ ...p, [it.id]: e.target.value }))}
                      className="flex-1 rounded-md border border-input bg-background px-2 py-1"
                    >
                      <option value="">Attach to a logged flight…</option>
                      {near.map(f => <option key={f.id} value={f.id}>{f.flight_date} · {f.pilot_name.split(' ')[0]} · {f.route ?? 'no route'}</option>)}
                    </select>
                    <button type="button" disabled={!picked[it.id]} onClick={() => attach(it.id)} className="rounded-md border px-2 py-1 disabled:opacity-40">Attach</button>
                    </>
                  )}
                  <button type="button" onClick={() => setIgnored(it.id, !showIgnored)} className="ml-auto rounded-md border px-2 py-1 text-muted-foreground hover:text-foreground">
                    {showIgnored ? 'Restore' : 'Ignore'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
