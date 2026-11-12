import { useEffect, useState, type FormEvent } from 'react'
import { Select } from '@/components/ui/select'
import { useParams } from 'react-router-dom'
import { useGoBack } from '@/lib/navigation'
import { ChevronLeft, Trash2 } from 'lucide-react'
import { InsuranceWarning, useAircraftStatus } from '@/components/AircraftStatusBanner'
import { api, type ScheduleBlock, type PartnershipMember } from '@/lib/api'
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

function fmt(iso: string) {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function EditReservation() {
  const { id } = useParams<{ id: string }>()
  const goBack = useGoBack('/schedule')

  const [loading, setLoading]           = useState(true)
  const [notFound, setNotFound]         = useState(false)
  const [members, setMembers]           = useState<PartnershipMember[]>([])
  const [pilotId, setPilotId]           = useState<string>('')
  const [pilotName, setPilotName]       = useState('')
  const [title, setTitle]               = useState('')
  const [blockType, setBlockType]       = useState<BlockType>('reservation')
  const [isAllDay, setIsAllDay]         = useState(false)
  const aircraftStatus = useAircraftStatus()
  const [startDate, setStartDate]       = useState('')
  const [endDate, setEndDate]           = useState('')
  const [startDt, setStartDt]           = useState('')
  const [endDt, setEndDt]               = useState('')
  const [notes, setNotes]               = useState('')
  const [error, setError]               = useState('')
  const [conflictBlock, setConflictBlock] = useState<ConflictBlock | null>(null)
  const [submitting, setSubmitting]     = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting]         = useState(false)

  useEffect(() => {
    Promise.all([
      api.get<ScheduleBlock>(`/schedule/${id}`),
      api.get<PartnershipMember[]>('/schedule/members'),
    ])
      .then(([b, ms]) => {
        setMembers(ms)
        setTitle(b.title)
        setBlockType(b.block_type)
        setNotes(b.notes ?? '')
        setIsAllDay(b.is_all_day)

        if (b.is_all_day) {
          setStartDate(b.start_dt.slice(0, 10))
          setEndDate(b.end_dt.slice(0, 10))
        } else {
          setStartDt(toLocalInput(b.start_dt))
          setEndDt(toLocalInput(b.end_dt))
        }

        if (b.pilot_name) {
          setPilotId('custom')
          setPilotName(b.pilot_name)
        } else {
          setPilotId(b.pilot_id ?? b.created_by)
        }
      })
      .catch(err => {
        if (err.status === 404) setNotFound(true)
        else setError(err.message)
      })
      .finally(() => setLoading(false))
  }, [id])

  function toggleAllDay(checked: boolean) {
    setIsAllDay(checked)
    if (checked) {
      const d = startDt.slice(0, 10)
      setStartDate(d)
      setEndDate(d)
    } else {
      const d = startDate || new Date().toISOString().slice(0, 10)
      setStartDt(`${d}T08:00`)
      setEndDt(`${d}T17:00`)
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
      notes: notes || null,
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
      await api.patch<ScheduleBlock>(`/schedule/${id}`, payload)
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
      await api.patch<ScheduleBlock>(`/schedule/${id}`, { ...payload, force: true })
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
      await api.patch<ScheduleBlock>(`/schedule/${id}`, payload)
      goBack()
    } catch (err: any) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setDeleting(true)
    try {
      await api.delete(`/schedule/${id}`)
      goBack()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  if (loading) return <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
  if (notFound) return <div className="p-8 text-center text-sm text-destructive">Reservation not found.</div>

  const isCustomPilot = pilotId === 'custom'

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => goBack()}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-semibold">Edit Reservation</h1>
        </div>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
            confirmDelete
              ? 'bg-destructive text-destructive-foreground'
              : 'text-destructive hover:bg-destructive/10'
          )}
        >
          <Trash2 className="h-4 w-4" />
          {confirmDelete ? 'Confirm delete' : 'Delete'}
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5 p-4">
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

        {/* Full day */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={isAllDay}
            onChange={e => toggleAllDay(e.target.checked)}
            className="h-4 w-4 rounded border-input accent-primary"
          />
          <span className="text-sm font-medium">Full day</span>
        </label>

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

        <Field label={<>Notes <span className="font-normal text-muted-foreground">(optional)</span></>}>
          <Textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Destination, passengers, anything notable…"
            rows={3}
          />
        </Field>

        <InsuranceWarning status={aircraftStatus} date={isAllDay ? endDate : endDt.slice(0, 10)} />

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

        {confirmDelete && (
          <p className="text-sm text-muted-foreground">
            Tap "Confirm delete" to permanently remove this reservation, or{' '}
            <button type="button" className="underline" onClick={() => setConfirmDelete(false)}>cancel</button>.
          </p>
        )}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save changes'}
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
