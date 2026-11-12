import { useEffect, useState, type FormEvent } from 'react'
import { Select } from '@/components/ui/select'
import { useSearchParams } from 'react-router-dom'
import { useGoBack } from '@/lib/navigation'
import { ChevronLeft } from 'lucide-react'
import { AircraftStatusBanner, InsuranceWarning, useAircraftStatus } from '@/components/AircraftStatusBanner'
import { api, type ScheduleBlock, type PartnershipMember, type CurrencyStatus, type Squawk } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

type BlockType = 'reservation' | 'maintenance' | 'unavailable'
const BLOCK_TYPES: BlockType[] = ['reservation', 'maintenance', 'unavailable']

type ConflictBlock = { id: string; title: string; start_dt: string; end_dt: string }

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalInput(local: string): string {
  return new Date(local).toISOString()
}

function defaultDate(dateParam?: string | null): string {
  if (dateParam) return dateParam
  const t = new Date(); t.setDate(t.getDate() + 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}`
}

function defaultStart(date: string): string {
  return toLocalInput(new Date(date + 'T08:00').toISOString())
}
function defaultEnd(date: string): string {
  return toLocalInput(new Date(date + 'T17:00').toISOString())
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function NewReservation() {
  const goBack = useGoBack('/schedule')
  const { user } = useAuth()
  const [params] = useSearchParams()
  const dateParam = params.get('date')

  const initDate = defaultDate(dateParam)

  const [members, setMembers]     = useState<PartnershipMember[]>([])
  const [pilotId, setPilotId]     = useState<string>('')
  const [pilotName, setPilotName] = useState('')
  const [title, setTitle]         = useState('')
  const [blockType, setBlockType] = useState<BlockType>('reservation')
  const [isAllDay, setIsAllDay]   = useState(false)
  const [startDate, setStartDate] = useState(initDate)
  const [endDate, setEndDate]     = useState(initDate)
  const [startDt, setStartDt]     = useState(defaultStart(initDate))
  const [endDt, setEndDt]         = useState(defaultEnd(initDate))
  const [notes, setNotes]         = useState('')
  const [error, setError]         = useState('')
  const aircraftStatus = useAircraftStatus()
  const [conflictBlock, setConflictBlock] = useState<ConflictBlock | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [currency, setCurrency]   = useState<CurrencyStatus | null>(null)
  const [openSquawks, setOpenSquawks] = useState<Squawk[]>([])

  useEffect(() => {
    api.get<PartnershipMember[]>('/schedule/members')
      .then(ms => {
        setMembers(ms)
        const self = ms.find(m => m.user_id === user?.id)
        setPilotId(self?.id ?? ms[0]?.id ?? '')
      })
      .catch(() => {})
    api.get<CurrencyStatus>('/currency').then(setCurrency).catch(() => {})
    api.get<Squawk[]>('/squawks?status=unresolved').then(setOpenSquawks).catch(() => {})
  }, [user?.id])

  function toggleAllDay(checked: boolean) {
    setIsAllDay(checked)
    if (checked) {
      const d = startDt.slice(0, 10)
      setStartDate(d)
      setEndDate(d)
    } else {
      setStartDt(defaultStart(startDate))
      setEndDt(defaultEnd(startDate))
    }
  }

  function buildPayload(): object | null {
    const start = isAllDay ? new Date(startDate + 'T00:00:00').toISOString() : fromLocalInput(startDt)
    const end   = isAllDay ? new Date(endDate   + 'T23:59:59').toISOString() : fromLocalInput(endDt)

    if (isAllDay && endDate < startDate) {
      setError('End date must be on or after start date')
      return null
    }
    if (!isAllDay && new Date(end) <= new Date(start)) {
      setError('End must be after start')
      return null
    }

    return {
      title,
      block_type: blockType,
      start_dt: start,
      end_dt: end,
      is_all_day: isAllDay,
      pilot_id: pilotId !== 'custom' ? pilotId || null : null,
      pilot_name: pilotId === 'custom' ? pilotName || null : null,
      notes: notes || undefined,
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setConflictBlock(null)

    const payload = buildPayload()
    if (!payload) return

    setSubmitting(true)
    try {
      await api.post<ScheduleBlock>('/schedule', payload)
      goBack()
    } catch (err: any) {
      if (err.status === 409 && err.conflict) {
        setConflictBlock(err.conflict)
      } else {
        setError(err instanceof Error ? err.message : 'Failed to save')
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function handleForce() {
    const payload = buildPayload()
    if (!payload) return
    setSubmitting(true)
    try {
      await api.post<ScheduleBlock>('/schedule', { ...payload, force: true })
      goBack()
    } catch (err: any) {
      setError(err instanceof Error ? err.message : 'Failed to save')
      setConflictBlock(null)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDeleteAndSchedule() {
    const payload = buildPayload()
    if (!payload) return
    setSubmitting(true)
    try {
      await api.delete(`/schedule/${conflictBlock!.id}`)
      await api.post<ScheduleBlock>('/schedule', payload)
      goBack()
    } catch (err: any) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSubmitting(false)
    }
  }

  const isCustomPilot = pilotId === 'custom'

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-4 py-3">
        <button
          onClick={() => goBack()}
          className="rounded-md p-1 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold">New Reservation</h1>
      </div>

      {/* Currency / squawk warnings */}
      {(() => {
        const scheduledDaysOut = isAllDay
          ? Math.floor((new Date(startDate + 'T12:00:00').getTime() - Date.now()) / 86400000)
          : Math.floor((new Date(startDt).getTime() - Date.now()) / 86400000)
        const warnings: string[] = []
        if (currency) {
          if (!currency.ifr.current || currency.ifr.expiresInDays <= scheduledDaysOut)
            warnings.push('IFR')
          if (!currency.dayLanding.current || currency.dayLanding.expiresInDays <= scheduledDaysOut)
            warnings.push('Day landings')
          if (!currency.nightLanding.current || currency.nightLanding.expiresInDays <= scheduledDaysOut)
            warnings.push('Night landings')
          if (currency.medical && !currency.medical.current)
            warnings.push('Medical')
        }
        return (warnings.length > 0 || openSquawks.length > 0) ? (
          <div className="space-y-1.5 border-b px-4 py-3">
            {warnings.length > 0 && (
              <div className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 dark:border-amber-600 dark:bg-amber-950/30">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Not current by flight date: {warnings.join(', ')}</p>
              </div>
            )}
            {openSquawks.length > 0 && (
              <div className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 dark:border-amber-600 dark:bg-amber-950/30">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400">{openSquawks.length} open squawk{openSquawks.length > 1 ? 's' : ''} — review maintenance log before scheduling</p>
              </div>
            )}
          </div>
        ) : null
      })()}

      <form onSubmit={handleSubmit} className="space-y-5 p-4">
        {/* Title */}
        <Field label="Title">
          <Input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Enter short desc of flight here"
            required
          />
        </Field>

        {/* Pilot */}
        {(
          <div className="space-y-1.5">
            <Label>Pilot</Label>
            <Select
              value={pilotId}
              onChange={e => setPilotId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {members.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
              <option value="custom">Other (custom)…</option>
            </Select>
            {isCustomPilot && (
              <Input
                type="text"
                value={pilotName}
                onChange={e => setPilotName(e.target.value)}
                placeholder="Full name"
                className="mt-2"
              />
            )}
          </div>
        )}

        {/* Block type */}
        <div className="space-y-1.5">
          <Label>Type</Label>
          <div className="flex gap-2">
            {BLOCK_TYPES.map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setBlockType(t)}
                className={cn(
                  'rounded-full border px-3 py-1 text-xs capitalize transition-colors',
                  blockType === t
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Full day toggle */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isAllDay}
            onChange={e => toggleAllDay(e.target.checked)}
            className="h-4 w-4 rounded border-input accent-primary"
          />
          <span className="text-sm font-medium">Full day</span>
        </label>

        {/* Date / time fields */}
        {isAllDay ? (
          <>
            <Field label="Start date">
              <Input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                required
              />
            </Field>
            <Field label="End date">
              <Input
                type="date"
                value={endDate}
                onChange={e => setEndDate(e.target.value)}
                required
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="Start">
              <Input
                type="datetime-local"
                value={startDt}
                onChange={e => setStartDt(e.target.value)}
                step={900}
                required
              />
            </Field>
            <Field label="End">
              <Input
                type="datetime-local"
                value={endDt}
                onChange={e => setEndDt(e.target.value)}
                step={900}
                required
              />
            </Field>
          </>
        )}

        {/* Notes */}
        <Field label={<>Notes <span className="font-normal text-muted-foreground">(optional)</span></>}>
          <Textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Destination, passengers, anything notable…"
            rows={3}
          />
        </Field>

        <InsuranceWarning status={aircraftStatus} date={isAllDay ? endDate : endDt.slice(0, 10)} />
        {aircraftStatus?.grounded && <AircraftStatusBanner status={{ ...aircraftStatus, overdue: [], due_soon: [], insurance_expires_date: null }} />}

        {error && <p className="text-sm text-destructive">{error}</p>}

        {conflictBlock && (
          <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-destructive">
              Overlaps &ldquo;{conflictBlock.title}&rdquo; ({fmt(conflictBlock.start_dt)} – {fmt(conflictBlock.end_dt)})
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={handleForce} disabled={submitting}>
                Schedule anyway
              </Button>
              <Button type="button" variant="destructive" size="sm" onClick={handleDeleteAndSchedule} disabled={submitting}>
                Delete &ldquo;{conflictBlock.title}&rdquo; &amp; schedule
              </Button>
            </div>
          </div>
        )}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save reservation'}
        </Button>
      </form>
    </div>
  )
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  )
}
