import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clock, DollarSign, Plane, AlertTriangle, CalendarDays, ShieldCheck, ShieldAlert, Plus, Download } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useAuth } from '@/context/AuthContext'
import { setPendingPhoto } from '@/lib/pendingPhoto'
import { AircraftStatusBanner, useAircraftStatus } from '@/components/AircraftStatusBanner'
import { api, type Flight, type ScheduleBlock, type PartnershipMember, type LedgerEntry, type AnnualHoursSummary, type Squawk, type Partnership, type CurrencyStatus } from '@/lib/api'

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function displayPilot(b: ScheduleBlock, members: PartnershipMember[]): string {
  if (b.pilot_name) return b.pilot_name
  const id = b.pilot_id ?? b.created_by
  return members.find(m => m.id === id)?.name ?? b.created_by_name
}

function formatBlockTime(b: ScheduleBlock): string {
  if (b.is_all_day) return 'All day'
  return `${formatTime(b.start_dt)}–${formatTime(b.end_dt)}`
}

function squawkVariant(severity: string) {
  if (severity === 'major') return 'destructive'
  if (severity === 'minor') return 'warning'
  return 'secondary'
}

function expiryDate(daysFromNow: number): string {
  const d = new Date()
  d.setDate(d.getDate() + daysFromNow)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function timeGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

const fmtDay = (d: string | null) =>
  d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''

export function Dashboard() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const importRef = useRef<HTMLInputElement>(null)
  const [currency, setCurrency] = useState<CurrencyStatus | null>(null)
  const [partnership, setPartnership] = useState<Partnership | null>(null)
  const [squawks, setSquawks] = useState<Squawk[]>([])
  const aircraftStatus = useAircraftStatus()
  const [lastFlight, setLastFlight]       = useState<Flight | null>(null)
  const [upcoming, setUpcoming]           = useState<ScheduleBlock[]>([])
  const [upcomingMembers, setUpcomingMembers] = useState<PartnershipMember[]>([])
  const [ledgerEntry, setLedgerEntry]     = useState<LedgerEntry | null>(null)
  const [annualHours, setAnnualHours]     = useState<AnnualHoursSummary | null>(null)
  const [hoursUserId, setHoursUserId] = useState<string | null>(null)
  const [flightDragOver, setFlightDragOver] = useState(false)

  function handleFlightDrop(e: React.DragEvent) {
    e.preventDefault()
    setFlightDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file && file.type.startsWith('image/')) {
      setPendingPhoto(file)
      navigate('/flights/new')
    }
  }

  useEffect(() => {
    api.get<Partnership>('/partnership').then(setPartnership).catch(() => {})
    api.get<CurrencyStatus>('/currency').then(setCurrency).catch(() => {})

    api.get<Flight[]>('/flights?limit=1')
      .then(([f]) => f && setLastFlight(f))
      .catch(() => {})

    api.get<LedgerEntry[]>('/ledger?limit=1')
      .then(([e]) => e && setLedgerEntry(e))
      .catch(() => {})

    api.get<Squawk[]>('/squawks?status=open')
      .then(setSquawks)
      .catch(() => {})

    const now = new Date().toISOString()
    const horizon = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    api.get<ScheduleBlock[]>(`/schedule?start=${encodeURIComponent(now)}&end=${encodeURIComponent(horizon)}`)
      .then(blocks => setUpcoming(blocks.slice(0, 5)))
      .catch(() => {})
    api.get<PartnershipMember[]>('/schedule/members')
      .then(setUpcomingMembers)
      .catch(() => {})
  }, [user?.is_admin])

  const hoursMemberId = hoursUserId ?? user?.id ?? null
  useEffect(() => {
    if (!hoursMemberId) return
    api.get<AnnualHoursSummary>(`/flights/annual-summary?user_id=${hoursMemberId}`)
      .then(setAnnualHours)
      .catch(() => setAnnualHours(null))
  }, [hoursMemberId])

  async function handleDashboardImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const fd = new FormData()
      fd.append('logbook', file)
      await api.upload<{ imported: number; last_import_at: string }>('/currency/import', fd)
      api.get<CurrencyStatus>('/currency').then(setCurrency).catch(() => {})
    } catch { /* silent — settings page shows errors */ }
    finally { if (importRef.current) importRef.current.value = '' }
  }

  return (
    <div className="space-y-4 p-4">
      <AircraftStatusBanner status={aircraftStatus} />
      {/* Header */}
      <div className="pt-2 flex items-start justify-between">
        <div>
          <p className="text-xs text-muted-foreground">{timeGreeting()}{currency?.pilot ? `, ${currency.pilot.split(' ')[0]}` : ''}</p>
          <button
            type="button"
            onClick={() => navigate('/documents')}
            title="View aircraft documents"
            className="flex items-center gap-3 text-left transition-opacity hover:opacity-70"
          >
            <img src="/branding/mark" alt="" className="h-14 w-auto rounded-lg shadow-sm" />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{partnership?.aircraft_tail ?? '—'}</h1>
              <p className="text-sm text-muted-foreground">{partnership?.aircraft_make_model ?? ''}</p>
              {partnership?.aircraft_serial && (
                <p className="text-xs text-muted-foreground">S/N {partnership.aircraft_serial}</p>
              )}
            </div>
          </button>
        </div>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-5 gap-2">
        {[
          { label: 'Flight',   path: '/flights/new' },
          { label: 'Reserve',  path: '/schedule/new' },
          { label: 'Maintenance', path: '/maintenance?add=entry' },
          { label: 'Squawk',   path: '/maintenance?add=squawk' },
          { label: 'Ledger',   path: '/ledger/new' },
        ].map(({ label, path }) => (
          <Button
            key={label}
            variant="outline"
            size="sm"
            className={cn(
              'flex flex-col h-auto gap-1 py-2 px-1 text-[11px]',
              label === 'Flight' && flightDragOver && 'border-primary bg-primary/10'
            )}
            onClick={() => navigate(path)}
            {...(label === 'Flight' ? {
              onDragOver: (e: React.DragEvent) => { e.preventDefault(); setFlightDragOver(true) },
              onDragLeave: () => setFlightDragOver(false),
              onDrop: handleFlightDrop,
            } : {})}
          >
            <Plus className="h-3.5 w-3.5" />
            {label}
          </Button>
        ))}
      </div>

      {/* Summary row: Aircraft Hours | Annual/Monthly Hours | Balance */}
      <div className="grid grid-cols-3 gap-2">
        <Card>
          <CardHeader className="pb-1 pt-3 px-3">
            <CardTitle className="flex items-center gap-1 text-xs">
              <Plane className="h-3 w-3" /> Aircraft Total Hours
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 pt-0">
            {lastFlight ? (
              <div className="flex gap-3">
                <div>
                  <p className="text-lg font-bold tabular-nums leading-tight">
                    {parseFloat(lastFlight.tach_end).toFixed(1)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">Hobbs</p>
                </div>
                {lastFlight.hobbs_end && (
                  <div>
                    <p className="text-lg font-bold tabular-nums leading-tight">
                      {parseFloat(lastFlight.hobbs_end).toFixed(1)}
                    </p>
                    <p className="text-[10px] text-muted-foreground">Flight</p>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No flights</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1 pt-3 px-3">
            <div className="flex items-start justify-between gap-1">
              <CardTitle className="flex items-center gap-1 text-xs">
                <Clock className="h-3 w-3" /> Used Hours
              </CardTitle>
              <div className="flex gap-1">
                {upcomingMembers.map(m => (
                  <button
                    key={m.user_id}
                    type="button"
                    onClick={() => setHoursUserId(m.user_id)}
                    className={cn(
                      'rounded px-1 text-[10px] leading-tight',
                      m.user_id === hoursMemberId ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {m.name.split(' ')[0]}
                  </button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-3 pb-3 pt-0">
            {annualHours ? (
              <>
                <p className="text-lg font-bold tabular-nums leading-tight">
                  {annualHours.hours_flown.toFixed(1)}
                  {annualHours.annual_allotment != null && (
                    <span className="text-[10px] font-normal text-muted-foreground">/{annualHours.annual_allotment}h</span>
                  )}
                </p>
                {annualHours.annual_allotment != null && (
                  <div className="mt-1.5 h-1 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn('h-full rounded-full', annualHours.overage > 0 ? 'bg-destructive' : 'bg-emerald-500')}
                      style={{ width: `${Math.min(100, (annualHours.hours_flown / annualHours.annual_allotment) * 100)}%` }}
                    />
                  </div>
                )}
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {annualHours.no_allotment
                    ? 'This calendar year'
                    : annualHours.not_started
                    ? `Starts ${fmtDay(annualHours.lease_start)}`
                    : annualHours.overage > 0 && annualHours.overage_cost != null
                      ? `${annualHours.overage.toFixed(1)}h over · $${annualHours.overage_cost.toFixed(2)} excess`
                      : `Resets ${fmtDay(annualHours.window_end)}`}
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No data</p>
            )}
          </CardContent>
        </Card>

        <Card className="cursor-pointer" onClick={() => navigate('/ledger')}>
          <CardHeader className="pb-1 pt-3 px-3">
            <CardTitle className="flex items-center gap-1 text-xs">
              <DollarSign className="h-3 w-3" /> {user?.role === 'owner' ? 'Total expenses' : 'Balance'}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 pt-0">
            <p className="text-lg font-bold tabular-nums leading-tight">
              ${((user?.role === 'owner' ? -1 : 1) * parseFloat(ledgerEntry?.running_balance ?? '0')).toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Squawks */}
      <Card className="cursor-pointer" onClick={() => navigate('/maintenance')}>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" /> Open Squawks
          </CardTitle>
        </CardHeader>
        <CardContent>
          {squawks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open squawks</p>
          ) : (
            <ul className="space-y-2">
              {squawks.map(s => (
                <li key={s.id} className="flex items-start gap-2">
                  <Badge variant={squawkVariant(s.severity) as any} className="mt-0.5 shrink-0 capitalize">
                    {s.severity}
                  </Badge>
                  <span className="text-sm">{s.description}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Upcoming reservations */}
      <Card className="cursor-pointer" onClick={() => navigate('/schedule')}>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <CalendarDays className="h-3.5 w-3.5" /> Upcoming
          </CardTitle>
        </CardHeader>
        <CardContent>
          {upcoming.length === 0 ? (
            <p className="text-sm text-muted-foreground">No upcoming reservations in the next 30 days</p>
          ) : (
            <ul className="space-y-3">
              {upcoming.map(b => (
                <li key={b.id} className="flex items-start gap-3">
                  <div className="flex w-10 flex-col items-center rounded-md bg-muted py-1 text-center">
                    <span className="text-[10px] uppercase text-muted-foreground">
                      {new Date(b.start_dt).toLocaleDateString('en-US', { month: 'short' })}
                    </span>
                    <span className="text-lg font-bold leading-none">
                      {new Date(b.start_dt).getDate()}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium">{b.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {displayPilot(b, upcomingMembers)} · {formatBlockTime(b)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Currency */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5" /> Currency{currency?.pilot ? ` — ${currency.pilot}` : ''}
          </CardTitle>
          <button
            onClick={() => importRef.current?.click()}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground"
            title="Import ForeFlight CSV"
          >
            <Download className="h-3.5 w-3.5" />
          </button>
          <input ref={importRef} type="file" accept=".csv" className="hidden" onChange={handleDashboardImport} />
        </CardHeader>
        <CardContent className="space-y-2">
          {!currency ? (
            <p className="text-sm text-muted-foreground">Import ForeFlight logbook in Settings to see currency</p>
          ) : (
            <>
              <CurrencyRow
                label="IFR"
                current={currency.ifr.current}
                detail={currency.ifr.current
                  ? `${currency.ifr.approachesInWindow} approaches · expires in ${currency.ifr.expiresInDays}d · ${expiryDate(currency.ifr.expiresInDays)}`
                  : 'Not current'}
              />
              <CurrencyRow
                label="Day landing"
                current={currency.dayLanding.current}
                detail={currency.dayLanding.current
                  ? `Expires in ${currency.dayLanding.expiresInDays}d · ${expiryDate(currency.dayLanding.expiresInDays)}`
                  : 'Not current'}
              />
              <CurrencyRow
                label="Night landing"
                current={currency.nightLanding.current}
                detail={currency.nightLanding.current
                  ? `Expires in ${currency.nightLanding.expiresInDays}d · ${expiryDate(currency.nightLanding.expiresInDays)}`
                  : currency.nightLanding.expiresInDays < 0
                    ? `Expired ${Math.abs(currency.nightLanding.expiresInDays)}d ago`
                    : 'Not current'}
              />
              <CurrencyRow
                label="Medical"
                current={currency.medical?.current ?? false}
                detail={currency.medical?.expiresDate
                  ? currency.medical.current
                    ? `Expires in ${currency.medical.daysUntilExpiry}d · ${new Date(currency.medical.expiresDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                    : `Expired ${Math.abs(currency.medical.daysUntilExpiry ?? 0)}d ago`
                  : 'No expiry set — update in Settings'}
              />
              <CurrencyRow
                label="BFR"
                current={currency.bfr?.current ?? false}
                detail={currency.bfr?.expiresDate
                  ? currency.bfr.current
                    ? `Expires in ${currency.bfr.daysUntilExpiry}d · ${new Date(currency.bfr.expiresDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                    : `Expired ${Math.abs(currency.bfr.daysUntilExpiry ?? 0)}d ago`
                  : 'No BFR date set — update in Settings'}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function CurrencyRow({ label, current, detail }: { label: string; current: boolean; detail: string }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        {current
          ? <ShieldCheck className="h-4 w-4 text-emerald-500" />
          : <ShieldAlert className="h-4 w-4 text-destructive" />
        }
        <span className="text-sm">{label}</span>
      </div>
      <span className={`text-xs ${current ? 'text-muted-foreground' : 'text-destructive font-medium'}`}>
        {detail}
      </span>
    </div>
  )
}
