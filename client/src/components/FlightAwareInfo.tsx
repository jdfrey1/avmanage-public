import { useEffect, useMemo, useState } from 'react'
import { Modal } from '@/components/Modal'
import { TrackMap } from '@/components/TrackMap'
import { LineChart, SERIES_COLORS, timeTicks } from '@/components/LineChart'
import { Select } from '@/components/ui/select'
import { ExternalLink } from 'lucide-react'
import { api, type Flight, type FlightAwareTrack, type FlightAwareUnmatched, type TrackPoint } from '@/lib/api'

const clock = (iso?: string | number | null) =>
  iso != null ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '—'

// FlightAware track in a pop-up: map plus altitude and groundspeed with a shared cursor.
export function FlightAwareTrackModal({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const [track, setTrack] = useState<TrackPoint[] | null>(null)
  const [msg, setMsg] = useState('')
  const [hover, setHover] = useState<number | null>(null)
  useEffect(() => {
    api.get<{ track: TrackPoint[]; status: string | null }>(`/flightaware/${id}/track`)
      .then(r => (r.track.length ? setTrack(r.track) : setMsg('Track not available for this flight.')))
      .catch(() => setMsg('Could not load the track.'))
  }, [id])
  const points = useMemo(() => track?.map(p => ({ lat: p.lat, lon: p.lon })) ?? [], [track])
  const t0 = track ? track[0].t * 1000 : 0
  const x = track?.map(p => p.t - track[0].t) ?? []
  const xLabel = (sec: number) => clock(t0 + sec * 1000)
  const ticks = track ? timeTicks(x, t0) : []
  return (
    <Modal title={title} subtitle="FlightAware track" onClose={onClose}>
      {!track ? <p className="text-sm text-muted-foreground">{msg || 'Loading…'}</p> : (
        <div className="space-y-4">
          <TrackMap points={points} hover={hover} />
          <div className="grid gap-4 md:grid-cols-2">
            <LineChart title="Altitude" unit="ft" x={x} xLabel={xLabel} xTicks={ticks} hover={hover} onHover={setHover}
              series={[{ label: 'Altitude', values: track.map(p => p.alt), color: SERIES_COLORS[3] }]} />
            <LineChart title="Groundspeed" unit="kt" x={x} xLabel={xLabel} xTicks={ticks} hover={hover} onHover={setHover}
              series={[{ label: 'GS', values: track.map(p => p.gs), color: SERIES_COLORS[2] }]} />
          </div>
        </div>
      )}
    </Modal>
  )
}

// One FlightAware leg attached to a logged flight, with its own track view and Detach.
function AttachedLeg({ leg, onDetached }: { leg: FlightAwareTrack; onDetached: () => void }) {
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')
  const [confirmDetach, setConfirmDetach] = useState(false)

  async function detach() {
    try { await api.post(`/flightaware/${leg.id}/detach`, {}); onDetached() }
    catch { setMsg('Could not detach.'); setConfirmDetach(false) }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="tabular-nums">{leg.origin ?? '?'} {clock(leg.off_time)} → {leg.destination ?? '?'} {clock(leg.on_time)}</span>
        {leg.en_route_min != null && <span className="tabular-nums text-muted-foreground">{(leg.en_route_min / 60).toFixed(1)} hrs en route</span>}
        {leg.url && (
          <a href={leg.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
            Flight page <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {leg.has_track && (
          <button type="button" onClick={() => setOpen(true)} className="text-primary hover:underline">View track</button>
        )}
        {confirmDetach ? (
          <span className="ml-auto flex items-center gap-2">
            <span className="text-muted-foreground">Wrong flight?</span>
            <button type="button" onClick={detach} className="text-destructive hover:underline">Detach</button>
            <button type="button" onClick={() => setConfirmDetach(false)} className="text-muted-foreground hover:underline">Cancel</button>
          </span>
        ) : (
          <button type="button" onClick={() => setConfirmDetach(true)} className="ml-auto text-muted-foreground hover:text-foreground hover:underline">Detach</button>
        )}
      </div>
      {msg && <p className="mt-1 text-destructive">{msg}</p>}
      {open && <FlightAwareTrackModal id={leg.id} title={`${leg.origin ?? '?'} → ${leg.destination ?? '?'} · ${leg.off_time ? new Date(leg.off_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}`} onClose={() => setOpen(false)} />}
    </div>
  )
}

export function FlightAwareInfo({ tracks, onDetached }: { tracks: FlightAwareTrack[]; onDetached: () => void }) {
  const total = tracks.reduce((s, t) => s + (t.en_route_min ?? 0), 0)
  return (
    <div className="h-full space-y-1.5 rounded-md border bg-muted/20 p-2 text-xs" onClick={e => e.stopPropagation()}>
      <p className="font-medium">
        FlightAware
        {tracks.length > 1 && <span className="font-normal text-muted-foreground"> · {tracks.length} legs, {(total / 60).toFixed(1)} hrs en route</span>}
      </p>
      {tracks.map(t => <AttachedLeg key={t.id} leg={t} onDetached={onDetached} />)}
    </div>
  )
}

// Alerts that didn't match a logged flight (e.g. a maintenance test flight), with a manual
// "attach to flight" picker limited to flights logged within a day of the alert.
function UnmatchedTrack({ id, title }: { id: string; title: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="ml-2 text-primary hover:underline">View track</button>
      {open && <FlightAwareTrackModal id={id} title={title} onClose={() => setOpen(false)} />}
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
    <div className="h-full rounded-lg border bg-card p-3 text-xs">
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
                  {it.has_track && <UnmatchedTrack id={it.id} title={`${it.origin ?? '?'} → ${it.destination ?? '?'} · ${d}`} />}
                </p>
                <div className="mt-1.5 flex gap-2">
                  {!showIgnored && near.length > 0 && (
                    <>
                    <Select
                      value={picked[it.id] ?? ''}
                      onChange={e => setPicked(p => ({ ...p, [it.id]: e.target.value }))}
                      className="flex-1 rounded-md border border-input bg-background px-2 py-1"
                    >
                      <option value="">Attach to a logged flight…</option>
                      {near.map(f => <option key={f.id} value={f.id}>{f.flight_date} · {f.pilot_name.split(' ')[0]} · {f.route ?? 'no route'}{f.fa_tracks?.length ? ` (adds to its ${f.fa_tracks.length} track${f.fa_tracks.length > 1 ? 's' : ''})` : ''}</option>)}
                    </Select>
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
