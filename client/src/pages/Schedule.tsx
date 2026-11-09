import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Plus, CalendarDays, Link, Download, ExternalLink } from 'lucide-react'
import { api, type ScheduleBlock, type PartnershipMember } from '@/lib/api'
import { AircraftStatusBanner, pastInsurance, useAircraftStatus } from '@/components/AircraftStatusBanner'
import { Badge } from '@/components/ui/badge'
import { useMemberColors, DOWNTIME_DOT } from '@/lib/memberColors'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December']
const DOW = ['Su','Mo','Tu','We','Th','Fr','Sa']

function effectivePilotId(b: ScheduleBlock): string | null {
  return b.pilot_name ? null : (b.pilot_id ?? b.created_by)
}

// Reservations take the member's color; maintenance and unavailable (aircraft down) are red.
function blockDotClass(b: ScheduleBlock, colorOf: ReturnType<typeof useMemberColors>) {
  if (b.block_type === 'maintenance' || b.block_type === 'unavailable') return DOWNTIME_DOT
  return colorOf(effectivePilotId(b)).dot
}

function displayName(b: ScheduleBlock, members: PartnershipMember[]): string {
  if (b.pilot_name) return b.pilot_name
  if (b.pilot_id) return members.find(m => m.id === b.pilot_id)?.name ?? b.created_by_name
  return b.created_by_name
}

function formatTimeRange(start: string, end: string) {
  const fmt = (iso: string) =>
    new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const startDate = new Date(start)
  const label = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${label} · ${fmt(start)} – ${fmt(end)}`
}

// "3 flights logged · Alex 2, Sam 1" for a reservation; null when not applicable.
function FlightsLogged({ b }: { b: ScheduleBlock }) {
  const logged = b.flights_logged
  if (b.block_type !== 'reservation' || !logged) return null
  const total = logged.reduce((n, p) => n + p.count, 0)
  if (total === 0) {
    return b.day_over
      ? <p className="mt-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">No flights logged</p>
      : null
  }
  const who = logged.length === 1
    ? ` (${logged[0].pilot.split(' ')[0]})`
    : ` · ${logged.map(p => `${p.pilot.split(' ')[0]} ${p.count}`).join(', ')}`
  return <p className="mt-0.5 text-[11px] text-emerald-700 dark:text-emerald-400">{total} flight{total > 1 ? 's' : ''} logged{who}</p>
}

const unflown = (b: ScheduleBlock) =>
  b.block_type === 'reservation' && !!b.day_over && !!b.flights_logged && b.flights_logged.length === 0

function blockOverlapsDay(b: ScheduleBlock, year: number, month: number, day: number) {
  const dayStart = new Date(year, month, day).getTime()
  const dayEnd   = new Date(year, month, day + 1).getTime()
  return new Date(b.start_dt).getTime() < dayEnd &&
         new Date(b.end_dt).getTime()   > dayStart
}

export function Schedule() {
  const navigate = useNavigate()

  const now = new Date()
  const [year, setYear]   = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const aircraftStatus = useAircraftStatus()
  const notInsured = (b: ScheduleBlock) =>
    b.block_type === 'reservation' && pastInsurance(aircraftStatus, new Date(b.end_dt).toLocaleDateString('en-CA'))
  const [blocks, setBlocks]   = useState<ScheduleBlock[]>([])
  const [members, setMembers] = useState<PartnershipMember[]>([])
  const colorOf = useMemberColors()
  const [loading, setLoading] = useState(true)
  const [error, setError]    = useState('')
  const [dayPicker, setDayPicker] = useState<{ date: string; blocks: ScheduleBlock[] } | null>(null)
  const [showFeedSheet, setShowFeedSheet] = useState(false)
  const [feedUrl, setFeedUrl]   = useState<string | null>(null)
  const [feedCopied, setFeedCopied] = useState(false)
  const [googleCalendarUrl, setGoogleCalendarUrl] = useState<string | null>(null)

  useEffect(() => {
    api.get<{ connected: boolean; calendarUrl: string | null }>('/calendar/google/status')
      .then(s => setGoogleCalendarUrl(s.connected ? s.calendarUrl : null))
      .catch(() => {})
  }, [])

  async function openFeedSheet() {
    setShowFeedSheet(v => !v)
    if (!feedUrl) {
      try {
        const { url } = await api.get<{ token: string; url: string }>('/calendar/token')
        setFeedUrl(url)
      } catch {}
    }
  }

  function copyFeedUrl() {
    if (!feedUrl) return
    navigator.clipboard.writeText(feedUrl).then(() => {
      setFeedCopied(true)
      setTimeout(() => setFeedCopied(false), 2000)
    })
  }

  useEffect(() => {
    api.get<PartnershipMember[]>('/schedule/members').then(setMembers).catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true)
    setError('')
    const start = new Date(year, month, 1).toISOString()
    const end   = new Date(year, month + 1, 1).toISOString()
    api.get<ScheduleBlock[]>(`/schedule?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`)
      .then(setBlocks)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [year, month])

  function prevMonth() {
    setDayPicker(null)
    if (month === 0) { setYear(y => y - 1); setMonth(11) }
    else setMonth(m => m - 1)
  }
  function nextMonth() {
    setDayPicker(null)
    if (month === 11) { setYear(y => y + 1); setMonth(0) }
    else setMonth(m => m + 1)
  }

  const firstDow   = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const today = new Date()
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month

  const cells: (number | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]

  function tapDay(day: number, dayBlocks: ScheduleBlock[]) {
    const pad = (n: number) => String(n).padStart(2, '0')
    const date = `${year}-${pad(month + 1)}-${pad(day)}`
    if (dayBlocks.length === 0) {
      navigate(`/schedule/new?date=${date}`)
    } else if (dayBlocks.length === 1) {
      navigate(`/schedule/${dayBlocks[0].id}/edit`)
    } else {
      setDayPicker({ date, blocks: dayBlocks })
    }
  }

  return (
    <div className="flex flex-col">
      <div className="px-4 pt-3 empty:hidden"><AircraftStatusBanner status={aircraftStatus} /></div>
      {/* Header */}
      <div className="sticky top-0 z-10 border-b bg-background px-4 pb-3 pt-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Schedule</h1>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => { window.location.href = '/api/export/schedule.csv' }}
              title="Download CSV"
              className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
            >
              <Download className="h-4 w-4" />
            </button>
            {googleCalendarUrl && (
              <button
                onClick={() => window.open(googleCalendarUrl, '_blank', 'noopener,noreferrer')}
                title="Open Google Calendar"
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
              >
                <ExternalLink className="h-4 w-4" />
              </button>
            )}
            <button
              onClick={openFeedSheet}
              title="Calendar feed link"
              className={cn(
                'rounded-md p-1.5 transition-colors',
                showFeedSheet ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Link className="h-4 w-4" />
            </button>
            <Button size="sm" onClick={() => navigate('/schedule/new')}>
              <Plus className="h-4 w-4" /> Reserve
            </Button>
          </div>
        </div>

        {showFeedSheet && (
          <div className="mt-3 rounded-lg border bg-card p-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              {googleCalendarUrl
                ? 'Prefer a different calendar app? Subscribe to this URL instead — note that unlike the connected Google Calendar, updates here depend on your calendar app’s own refresh schedule and may be delayed.'
                : 'Subscribe to this URL in Google Calendar or any calendar app to see reservations and flights.'}
            </p>
            {feedUrl ? (
              <>
                <p className="break-all rounded bg-muted px-2 py-1.5 font-mono text-[11px]">{feedUrl}</p>
                <Button size="sm" variant="outline" className="w-full" onClick={copyFeedUrl}>
                  {feedCopied ? 'Copied!' : 'Copy URL'}
                </Button>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Loading…</p>
            )}
          </div>
        )}

        {/* Month nav */}
        <div className="mt-3 flex items-center justify-between">
          <button onClick={prevMonth} className="rounded-md p-1 text-muted-foreground hover:text-foreground">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="text-sm font-medium">{MONTHS[month]} {year}</span>
          <button onClick={nextMonth} className="rounded-md p-1 text-muted-foreground hover:text-foreground">
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        {/* Day-of-week headers */}
        <div className="mt-2 grid grid-cols-7">
          {DOW.map(d => (
            <div key={d} className="py-1 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {d}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7 gap-y-0.5">
          {cells.map((day, i) => {
            if (!day) return <div key={`e${i}`} />
            const dayBlocks = blocks.filter(b => blockOverlapsDay(b, year, month, day))
            const isToday = isCurrentMonth && today.getDate() === day
            return (
              <button
                key={day}
                onClick={() => tapDay(day, dayBlocks)}
                className={cn(
                  'flex flex-col items-center rounded-md py-1 transition-colors hover:bg-accent',
                  isToday && 'bg-primary/10'
                )}
              >
                <span className={cn('text-sm', isToday && 'font-bold text-primary')}>{day}</span>
                {dayBlocks.length > 0 && (
                  <div className="mt-0.5 flex gap-0.5">
                    {dayBlocks.slice(0, 3).map(b => (
                      <span key={b.id} className={cn('h-1.5 w-1.5 rounded-full', blockDotClass(b, colorOf))} />
                    ))}
                    {dayBlocks.length > 3 && (
                      <span className="text-[8px] text-muted-foreground">+{dayBlocks.length - 3}</span>
                    )}
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Block list */}
      <div className="px-4 py-3">
        {dayPicker && (
          <div className="mb-4 rounded-lg border bg-card p-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-semibold">
                {new Date(dayPicker.date + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' })}
              </span>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => { navigate(`/schedule/new?date=${dayPicker.date}`); setDayPicker(null) }}
                  className="text-xs font-medium text-primary"
                >
                  + New
                </button>
                <button onClick={() => setDayPicker(null)} className="text-muted-foreground hover:text-foreground">
                  ✕
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              {dayPicker.blocks.map(b => (
                <div
                  key={b.id}
                  className={cn('flex cursor-pointer items-start gap-3 rounded-md border bg-background p-2.5 transition-colors hover:bg-accent/40', unflown(b) && 'border-amber-400 bg-amber-50/60 dark:border-amber-600 dark:bg-amber-950/20')}
                  onClick={() => navigate(`/schedule/${b.id}/edit`)}
                >
                  <Badge className={cn('mt-0.5 shrink-0', colorOf(effectivePilotId(b)).pill)}>
                    {displayName(b, members).split(' ')[0]}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{b.title}</p>
                    <p className="text-xs text-muted-foreground">{formatTimeRange(b.start_dt, b.end_dt)}</p>
                    <FlightsLogged b={b} />
                    {notInsured(b) && <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400">Not covered by insurance on record</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {loading && <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>}
        {error   && <p className="py-10 text-center text-sm text-destructive">{error}</p>}

        {!loading && !error && blocks.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-14 text-center">
            <CalendarDays className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No reservations this month</p>
            <Button size="sm" onClick={() => navigate('/schedule/new')}>Reserve a slot</Button>
          </div>
        )}

        <div className="space-y-2">
          {blocks.map(b => (
            <div
              key={b.id}
              className={cn('flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 hover:bg-accent/40 active:bg-accent/60 transition-colors', unflown(b) && 'border-amber-400 bg-amber-50/60 dark:border-amber-600 dark:bg-amber-950/20')}
              onClick={() => navigate(`/schedule/${b.id}/edit`)}
            >
              <Badge className={cn('mt-0.5 shrink-0', colorOf(effectivePilotId(b)).pill)}>
                {displayName(b, members).split(' ')[0]}
              </Badge>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">{b.title}</p>
                  {b.block_type !== 'reservation' && (
                    <Badge variant="outline" className="shrink-0 capitalize text-xs">
                      {b.block_type}
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{formatTimeRange(b.start_dt, b.end_dt)}</p>
                <FlightsLogged b={b} />
                {notInsured(b) && <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400">Not covered by insurance on record</p>}
                {b.notes && <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{b.notes}</p>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
