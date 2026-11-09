import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, PlaneTakeoff, Download, Camera, X, Pencil, ChevronDown } from 'lucide-react'
import { api, type Flight } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { FlightAwareInfo, UnmatchedFlightAware } from '@/components/FlightAwareInfo'
import { GarminDataEmpty, GarminDataInfo, UnmatchedGarmin } from '@/components/GarminData'
import { cn } from '@/lib/utils'

function formatDate(iso: string) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  })
}

function groupByDate(flights: Flight[]): [string, Flight[]][] {
  const map = new Map<string, Flight[]>()
  for (const f of flights) {
    const existing = map.get(f.flight_date) ?? []
    existing.push(f)
    map.set(f.flight_date, existing)
  }
  return [...map.entries()]
}

type Filter = 'all' | string
type SortBy = 'date' | 'pilot' | 'route' | 'notes'

export function Flights() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [flights, setFlights] = useState<Flight[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [sortBy, setSortBy] = useState<SortBy>('date')
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc')
  const [searchText, setSearchText] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    setLoading(true)
    const qs = new URLSearchParams()
    if (filter !== 'all') qs.set('pilot_id', filter)
    qs.set('sort_by', sortBy)
    qs.set('order', sortOrder)
    api.get<Flight[]>(`/flights?${qs}`)
      .then(setFlights)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [filter, sortBy, sortOrder, reloadKey])

  const hasActiveFilter = searchText || dateFrom || dateTo

  const filteredFlights = flights.filter(f => {
    if (searchText) {
      const q = searchText.toLowerCase()
      const match = (f.route ?? '').toLowerCase().includes(q)
        || (f.notes ?? '').toLowerCase().includes(q)
        || f.pilot_name.toLowerCase().includes(q)
      if (!match) return false
    }
    if (dateFrom && f.flight_date < dateFrom) return false
    if (dateTo && f.flight_date > dateTo) return false
    return true
  })

  function clearFilters() {
    setSearchText('')
    setDateFrom('')
    setDateTo('')
  }

  const groups = groupByDate(filteredFlights)

  const totalHobbs = filteredFlights.reduce((s, f) => s + parseFloat(f.tach_time), 0)
  // A blank field means nothing was added, so averages are per Flight hour across all listed flights.
  const flightHrs = (f: Flight) => (f.flight_time ? parseFloat(f.flight_time) : 0)
  const oilFlights = filteredFlights.filter(f => f.oil_added_quarts && parseFloat(f.oil_added_quarts) > 0)
  const oilAddedTotal = oilFlights.reduce((s, f) => s + parseFloat(f.oil_added_quarts!), 0)
  const oilHours = Math.max(0.1, filteredFlights.reduce((s, f) => s + flightHrs(f), 0))
  const fuelFlights = filteredFlights.filter(f => f.fuel_added_gallons && parseFloat(f.fuel_added_gallons) > 0)
  const fuelAddedTotal = fuelFlights.reduce((s, f) => s + parseFloat(f.fuel_added_gallons!), 0)
  const fuelHours = Math.max(0.1, filteredFlights.reduce((s, f) => s + flightHrs(f), 0))
  const totalFlight = filteredFlights.reduce((s, f) => {
    if (f.hobbs_start && f.hobbs_end)
      return s + (parseFloat(f.hobbs_end) - parseFloat(f.hobbs_start))
    return s
  }, 0)

  const pilots = [...new Map(flights.map(f => [f.pilot_id, f.member_name])).entries()]

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b bg-background px-4 pb-3 pt-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Flights</h1>
          <div className="flex gap-2">
            <button
              onClick={() => { window.location.href = '/api/export/flights.csv' }}
              className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
              title="Download CSV"
            >
              <Download className="h-4 w-4" />
            </button>
            <Button size="sm" onClick={() => navigate('/flights/new')}>
              <Plus className="h-4 w-4" />
              Log flight
            </Button>
          </div>
        </div>

        {/* Pilot filter tabs */}
        {pilots.length > 1 && (
          <div className="mt-3 flex gap-2">
            <FilterTab active={filter === 'all'} onClick={() => setFilter('all')}>All</FilterTab>
            {pilots.map(([id, name]) => (
              <FilterTab key={id} active={filter === id} onClick={() => setFilter(id)}>
                {name.split(' ')[0]}
              </FilterTab>
            ))}
          </div>
        )}

        {/* Sort controls */}
        <div className="mt-2 flex items-center gap-1.5">
          {(['date', 'pilot', 'route', 'notes'] as const).map(s => (
            <FilterTab key={s} active={sortBy === s} onClick={() => setSortBy(s)}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </FilterTab>
          ))}
          <button
            onClick={() => setSortOrder(o => o === 'desc' ? 'asc' : 'desc')}
            className="ml-auto rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {sortOrder === 'desc' ? '↓ Newest' : '↑ Oldest'}
          </button>
        </div>

        {/* Search / filter inputs */}
        <div className="mt-2 space-y-2">
          <div className="relative">
            <Input
              type="text"
              placeholder="Search route, notes, pilot…"
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              className="h-8 pr-7 text-sm"
            />
            {searchText && (
              <button
                onClick={() => setSearchText('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              className="h-8 flex-1 text-sm"
              placeholder="From"
            />
            <span className="text-xs text-muted-foreground">–</span>
            <Input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              className="h-8 flex-1 text-sm"
              placeholder="To"
            />
            {hasActiveFilter && (
              <button
                onClick={clearFilters}
                className="shrink-0 rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Totals */}
        {filteredFlights.length > 0 && !loading && (
          <p className="mt-2 text-xs text-muted-foreground">
            {filteredFlights.length} flights · {totalFlight.toFixed(1)} Flight hrs · {totalHobbs.toFixed(1)} Hobbs hrs
            {totalFlight > 0 && ` · ${totalFlight.toFixed(1)} Flight hrs`}
            {oilAddedTotal > 0 && ` · Oil ${oilAddedTotal.toFixed(1)} qt (${(oilAddedTotal / oilHours).toFixed(2)} qt/hr)`}
            {fuelAddedTotal > 0 && ` · Fuel added ${fuelAddedTotal.toFixed(0)} gal (${(fuelAddedTotal / fuelHours).toFixed(1)} gal/hr)`}
          </p>
        )}
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        {loading && (
          <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>
        )}
        <div className="mb-3 grid gap-3 md:grid-cols-2">
          <UnmatchedFlightAware flights={flights} onChange={() => setReloadKey(k => k + 1)} />
          <UnmatchedGarmin flights={flights} reloadKey={reloadKey} onChange={() => setReloadKey(k => k + 1)} />
        </div>

        {error && (
          <p className="py-12 text-center text-sm text-destructive">{error}</p>
        )}
        {!loading && !error && flights.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <PlaneTakeoff className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No flights yet</p>
            <Button size="sm" onClick={() => navigate('/flights/new')}>Log your first flight</Button>
          </div>
        )}
        {!loading && !error && flights.length > 0 && filteredFlights.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <p className="text-sm text-muted-foreground">No flights match the current filter</p>
            <button onClick={clearFilters} className="text-sm text-primary underline">Clear filters</button>
          </div>
        )}

        {sortBy === 'date' ? (
          groups.map(([date, dayFlights]) => (
            <div key={date} className="mb-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {formatDate(date)}
              </p>
              <div className="space-y-2">
                {dayFlights.map(f => (
                  <FlightCard key={f.id} flight={f} isSelf={f.pilot_id === user?.id} onChange={() => setReloadKey(k => k + 1)} />
                ))}
              </div>
            </div>
          ))
        ) : (
          <div className="space-y-2">
            {filteredFlights.map(f => (
              <FlightCard key={f.id} flight={f} isSelf={f.pilot_id === user?.id} showDate onChange={() => setReloadKey(k => k + 1)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function FilterTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-full px-3 py-1 text-sm transition-colors',
        active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
      )}
    >
      {children}
    </button>
  )
}

function FlightCard({ flight: f, isSelf, showDate, onChange }: { flight: Flight; isSelf: boolean; showDate?: boolean; onChange: () => void }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const tachTime = parseFloat(f.tach_time).toFixed(1)
  const hobbsTime = f.hobbs_start && f.hobbs_end
    ? (parseFloat(f.hobbs_end) - parseFloat(f.hobbs_start)).toFixed(1)
    : null
  const hasFuel = !!(f.oil_added_quarts || f.fuel_added_gallons || f.fuel_gallons || f.tks_gallons)

  return (
    <div className={cn('rounded-lg border bg-card transition-colors', open && 'ring-1 ring-border')}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        className="flex cursor-pointer items-start gap-3 rounded-lg p-3 hover:bg-accent/40 active:bg-accent/60"
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(o => !o) } }}
      >
        <div className="min-w-0 flex-1 sm:flex sm:items-start sm:gap-4">
          <div className="shrink-0 space-y-0.5">
            {showDate && (
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{formatDate(f.flight_date)}</p>
            )}
            <p className="tabular-nums text-sm">
              {hobbsTime && (
                <>
                  <span className="whitespace-nowrap font-semibold">{hobbsTime} Flight hrs</span>
                  {' '}<span className="hidden text-muted-foreground sm:inline">({parseFloat(f.hobbs_start!).toFixed(1)} → {parseFloat(f.hobbs_end!).toFixed(1)})</span>
                  {' '}<span className="mx-1 text-muted-foreground">·</span>{' '}
                </>
              )}
              <span className="whitespace-nowrap"><span className={hobbsTime ? '' : 'font-semibold'}>{tachTime} Hobbs hrs</span>{f.ocr_source_image_key && <Camera className="ml-1.5 inline h-3.5 w-3.5 align-[-2px] text-muted-foreground" />}</span>
              {' '}<span className="hidden text-muted-foreground sm:inline">({parseFloat(f.tach_start).toFixed(1)} → {parseFloat(f.tach_end).toFixed(1)})</span>
            </p>
            {f.route && <p className="text-xs font-medium text-foreground/70">{f.route}</p>}
          </div>
          {f.notes && (
            <p className={cn('mt-1 min-w-0 flex-1 text-sm text-muted-foreground sm:mt-0', open ? 'hidden sm:block sm:whitespace-pre-wrap' : 'line-clamp-1 sm:line-clamp-2')}>
              {f.notes}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            title="Edit flight"
            aria-label="Edit flight"
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={e => { e.stopPropagation(); navigate(`/flights/${f.id}/edit`) }}
          >
            <Pencil className="h-4 w-4" />
          </button>
          {f.exclude_from_allotment && <Badge variant="outline">Excluded</Badge>}
          <Badge variant={isSelf ? 'default' : 'secondary'}>
            {f.other_pilot ? `${f.other_pilot} → ${f.member_name.split(' ')[0]}` : f.pilot_name.split(' ')[0]}
          </Badge>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </div>
      </div>

      {open && (
        <div className="space-y-2 border-t px-3 pb-3 pt-2">
          <div className="space-y-1 sm:hidden">
            <p className="tabular-nums text-xs text-muted-foreground">
              {hobbsTime && <>Flight {parseFloat(f.hobbs_start!).toFixed(1)} → {parseFloat(f.hobbs_end!).toFixed(1)} · </>}
              Hobbs {parseFloat(f.tach_start).toFixed(1)} → {parseFloat(f.tach_end).toFixed(1)}
            </p>
            {f.notes && <p className="whitespace-pre-wrap text-sm">{f.notes}</p>}
          </div>
          {hasFuel && (
            <p className="text-xs text-muted-foreground">
              {[
                f.fuel_gallons && `${parseFloat(f.fuel_gallons).toFixed(1)} gal`,
                f.tks_gallons && parseFloat(f.tks_gallons) > 0 && `${parseFloat(f.tks_gallons).toFixed(1)} TKS`,
                f.fuel_added_gallons && `+${parseFloat(f.fuel_added_gallons).toFixed(1)} gal fuel added`,
                f.oil_added_quarts && `+${parseFloat(f.oil_added_quarts).toFixed(1)} qt oil added`,
              ].filter(Boolean).join(' · ')}
            </p>
          )}
          <div className="grid gap-2 md:grid-cols-2">
            {f.fa_tracks?.length
              ? <FlightAwareInfo tracks={f.fa_tracks} onDetached={onChange} />
              : <div className="h-full rounded-md border border-dashed p-2 text-xs text-muted-foreground"><span className="font-medium text-foreground">FlightAware</span> · no track</div>}
            {f.garmin_logs?.length
              ? <GarminDataInfo logs={f.garmin_logs} onChange={onChange} />
              : <GarminDataEmpty flightId={f.id} onChange={onChange} />}
          </div>
        </div>
      )}
    </div>
  )
}
