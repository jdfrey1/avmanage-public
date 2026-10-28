import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, Trash2, Camera } from 'lucide-react'
import { api, type Flight, type TachOcrResult, type PartnershipMember } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

const TABS_GALLONS = '60'
const FULL_GALLONS = '92'

export function EditFlight() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [members, setMembers] = useState<PartnershipMember[]>([])
  const [pilotId, setPilotId] = useState('')
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [flightDate, setFlightDate] = useState('')
  const [route, setRoute] = useState('')
  const [tachStart, setTachStart] = useState('')
  const [tachEnd, setTachEnd] = useState('')
  const [hobbsStart, setHobbsStart] = useState('')
  const [hobbsEnd, setHobbsEnd] = useState('')
  const [fuelGallons, setFuelGallons] = useState('')
  const [fuelAdded, setFuelAdded] = useState('')
  const [oilAdded, setOilAdded] = useState('')
  const [tksGallons, setTksGallons] = useState('')
  const [excludeFromAllotment, setExcludeFromAllotment] = useState(false)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Hobbs/Flight photo OCR. NOTE: state vars keep their old tach*/hobbs* names
  // (matching the unchanged DB columns tach_start/tach_end/hobbs_start/hobbs_end)
  // even though the UI now labels them "Hobbs" and "Flight" respectively.
  const photoInputRef = useRef<HTMLInputElement>(null)
  const [ocrEnabled, setOcrEnabled]     = useState(false)
  const [ocrLoading, setOcrLoading]     = useState(false)
  const [ocrError, setOcrError]         = useState('')
  const [ocrResult, setOcrResult]       = useState<TachOcrResult | null>(null)
  const [ocrImageKey, setOcrImageKey]   = useState<string | null>(null)
  const [existingPhotoKey, setExistingPhotoKey] = useState<string | null>(null)

  useEffect(() => {
    api.get<Flight>(`/flights/${id}`)
      .then(f => {
        setFlightDate(f.flight_date)
        setRoute(f.route ?? '')
        setTachStart(parseFloat(f.tach_start).toFixed(1))
        setTachEnd(parseFloat(f.tach_end).toFixed(1))
        setHobbsStart(f.hobbs_start ? parseFloat(f.hobbs_start).toFixed(1) : '')
        setHobbsEnd(f.hobbs_end ? parseFloat(f.hobbs_end).toFixed(1) : '')
        setFuelGallons(f.fuel_gallons ? parseFloat(f.fuel_gallons).toFixed(1) : '')
        setFuelAdded(f.fuel_added_gallons ? parseFloat(f.fuel_added_gallons).toFixed(1) : '')
        setOilAdded(f.oil_added_quarts ? parseFloat(f.oil_added_quarts).toFixed(1) : '')
        setTksGallons(f.tks_gallons && parseFloat(f.tks_gallons) > 0 ? parseFloat(f.tks_gallons).toFixed(1) : '')
        setNotes(f.notes ?? '')
        setExcludeFromAllotment(f.exclude_from_allotment)
        setExistingPhotoKey(f.ocr_source_image_key)
        setPilotId(f.pilot_id)
      })
      .catch(err => {
        if (err.status === 404) setNotFound(true)
        else setError(err.message)
      })
      .finally(() => setLoading(false))
    api.get<{ ocrEnabled: boolean }>('/config').then(c => setOcrEnabled(c.ocrEnabled)).catch(() => {})
    api.get<PartnershipMember[]>('/schedule/members').then(setMembers).catch(() => {})
  }, [id])

  async function runOcr(file: File) {
    setOcrLoading(true)
    setOcrError('')
    setOcrResult(null)
    try {
      const fd = new FormData()
      fd.append('photo', file)
      const result = await api.upload<TachOcrResult>('/flights/ocr-photo', fd)
      setOcrResult(result)
      setOcrImageKey(result.image_key)
      if (result.hobbs == null && result.flight == null) {
        setOcrError("Couldn't read the gauges from this photo — enter manually")
      }
    } catch (err) {
      setOcrError(err instanceof Error ? err.message : 'Failed to process photo')
    } finally {
      setOcrLoading(false)
    }
  }

  function handlePhotoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) runOcr(file)
    e.target.value = ''
  }

  function applyOcr(target: 'start' | 'end') {
    if (!ocrResult) return
    if (target === 'start') {
      if (ocrResult.hobbs != null)  setTachStart(ocrResult.hobbs.toFixed(1))
      if (ocrResult.flight != null) setHobbsStart(ocrResult.flight.toFixed(1))
    } else {
      if (ocrResult.hobbs != null)  setTachEnd(ocrResult.hobbs.toFixed(1))
      if (ocrResult.flight != null) setHobbsEnd(ocrResult.flight.toFixed(1))
    }
    setOcrResult(null)
  }

  const tachTime = tachStart && tachEnd
    ? (parseFloat(tachEnd) - parseFloat(tachStart)).toFixed(1)
    : null
  const tachValid = tachTime !== null && parseFloat(tachTime) >= 0

  const hobbsTime = hobbsStart && hobbsEnd
    ? (parseFloat(hobbsEnd) - parseFloat(hobbsStart)).toFixed(1)
    : null
  const hobbsValid = hobbsTime !== null && parseFloat(hobbsTime) >= 0

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (!tachValid) { setError('Hobbs end must be ≥ Hobbs start'); return }
    if (!hobbsValid) { setError('Flight end must be ≥ Flight start'); return }
    setSubmitting(true)
    try {
      await api.patch<Flight>(`/flights/${id}`, {
        flight_date: flightDate,
        route: route || null,
        tach_start: parseFloat(tachStart),
        tach_end: parseFloat(tachEnd),
        hobbs_start: hobbsStart ? parseFloat(hobbsStart) : null,
        hobbs_end: hobbsEnd ? parseFloat(hobbsEnd) : null,
        fuel_gallons: fuelGallons ? parseFloat(fuelGallons) : null,
        tks_gallons: tksGallons ? parseFloat(tksGallons) : 0,
        fuel_added_gallons: fuelAdded ? parseFloat(fuelAdded) : null,
        oil_added_quarts: oilAdded ? parseFloat(oilAdded) : null,
        notes: notes || null,
        pilot_id: pilotId || null,
        exclude_from_allotment: excludeFromAllotment,
        ...(ocrImageKey ? { ocr_source_image_key: ocrImageKey } : {}),
      })
      navigate('/flights')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setDeleting(true)
    try {
      await api.delete(`/flights/${id}`)
      navigate('/flights')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  if (loading) {
    return <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
  }
  if (notFound) {
    return <div className="p-8 text-center text-sm text-destructive">Flight not found.</div>
  }

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/flights')}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-semibold">Edit Flight</h1>
        </div>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
            confirmDelete
              ? 'bg-destructive text-destructive-foreground'
              : 'text-destructive hover:bg-destructive/10'
          }`}
        >
          <Trash2 className="h-4 w-4" />
          {confirmDelete ? 'Confirm delete' : 'Delete'}
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5 p-4">
        {/* Date */}
        <Field label="Date">
          <Input
            type="date"
            value={flightDate}
            onChange={e => setFlightDate(e.target.value)}
            required
          />
        </Field>

        {/* Pilot */}
        {members.length > 1 && (
          <div className="space-y-1.5">
            <Label>Pilot</Label>
            <select
              value={pilotId}
              onChange={e => setPilotId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {members.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Route */}
        <Field label={<>Route <span className="font-normal text-muted-foreground">(optional)</span></>}>
          <Input
            type="text"
            value={route}
            onChange={e => setRoute(e.target.value)}
            placeholder="KPAO – KSBA – KPAO"
          />
        </Field>

        {/* Hobbs (primary) */}
        <div>
          <div className="mb-2 flex items-center gap-2">
            <p className="text-sm font-medium">Hobbs</p>
            {ocrEnabled && (
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                disabled={ocrLoading}
                className="flex items-center gap-1 rounded-md p-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <Camera className="h-3.5 w-3.5" />
                {ocrLoading ? 'Reading…' : 'Snap photo'}
              </button>
            )}
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handlePhotoSelect}
            />
          </div>

          {existingPhotoKey && (
            <a
              href={`/api/flights/${id}/photo`}
              target="_blank"
              rel="noreferrer"
              className="mb-2 inline-block overflow-hidden rounded-md border"
            >
              <img src={`/api/flights/${id}/photo`} alt="Gauge photo" className="h-20 w-auto" />
            </a>
          )}

          {ocrError && <p className="mb-2 text-xs text-destructive">{ocrError}</p>}

          {ocrResult && (ocrResult.hobbs != null || ocrResult.flight != null) && (
            <div className="mb-3 space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
              <p className="text-sm">
                Detected{ocrResult.hobbs != null && <> Hobbs <span className="font-semibold tabular-nums">{ocrResult.hobbs.toFixed(1)}</span></>}
                {ocrResult.flight != null && <> / Flight <span className="font-semibold tabular-nums">{ocrResult.flight.toFixed(1)}</span></>}
              </p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => applyOcr('start')}>Apply to Start</Button>
                <Button type="button" size="sm" onClick={() => applyOcr('end')}>Apply to End</Button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Start">
              <Input type="number" step="0.1" min="0" value={tachStart}
                onChange={e => setTachStart(e.target.value)} required />
            </Field>
            <Field label="End">
              <Input type="number" step="0.1" min="0" value={tachEnd}
                onChange={e => setTachEnd(e.target.value)} required />
            </Field>
          </div>
          {tachTime !== null && (
            <p className={`mt-1.5 text-sm ${tachValid ? 'text-muted-foreground' : 'text-destructive'}`}>
              {tachValid ? `${tachTime} Hobbs hours` : 'End must be ≥ start'}
            </p>
          )}
        </div>

        {/* Flight meter */}
        <div>
          <p className="mb-2 text-sm font-medium">Flight</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start">
              <Input type="number" step="0.1" min="0" value={hobbsStart}
                onChange={e => setHobbsStart(e.target.value)} placeholder="2104.2" required />
            </Field>
            <Field label="End">
              <Input type="number" step="0.1" min="0" value={hobbsEnd}
                onChange={e => setHobbsEnd(e.target.value)} placeholder="2108.9" required />
            </Field>
          </div>
          {hobbsTime !== null && (
            <p className={`mt-1.5 text-sm ${hobbsValid ? 'text-muted-foreground' : 'text-destructive'}`}>
              {hobbsValid ? `${hobbsTime} Flight hours` : 'End must be ≥ start'}
            </p>
          )}
        </div>

        {/* Exclude from allotment — lessees only (the owner has no allotment) */}
        {members.find(m => m.id === pilotId)?.role === 'lessee' && (
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
            <input
              type="checkbox"
              checked={excludeFromAllotment}
              onChange={e => setExcludeFromAllotment(e.target.checked)}
              className="mt-0.5 h-4 w-4"
            />
            <div>
              <p className="text-sm font-medium">Exclude from annual hour allotment</p>
              <p className="text-xs text-muted-foreground">e.g. repositioning flights — these Flight hours won't count toward the pilot's total</p>
            </div>
          </label>
        )}

        {/* Fuel at end of flight */}
        <div>
          <p className="mb-2 text-sm font-medium">Fuel at end of flight</p>
          <div className="mb-1.5 flex items-center gap-2">
            <Label>Gallons remaining</Label>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setFuelGallons(TABS_GALLONS)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  fuelGallons === TABS_GALLONS
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                Tabs (60)
              </button>
              <button
                type="button"
                onClick={() => setFuelGallons(FULL_GALLONS)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  fuelGallons === FULL_GALLONS
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                Full (92)
              </button>
            </div>
          </div>
          <Input type="number" step="0.1" min="0" value={fuelGallons}
            onChange={e => setFuelGallons(e.target.value)} placeholder="45.0" />
        </div>

        {/* TKS */}
        <div className="grid grid-cols-2 gap-3">
          <Field label={<>Fuel added (gal) <span className="font-normal text-muted-foreground">(optional)</span></>}>
            <Input type="number" step="0.1" min="0" value={fuelAdded} onChange={e => setFuelAdded(e.target.value)} placeholder="0" />
          </Field>
          <Field label={<>Oil added (qt) <span className="font-normal text-muted-foreground">(optional)</span></>}>
            <Input type="number" step="0.5" min="0" value={oilAdded} onChange={e => setOilAdded(e.target.value)} placeholder="0" />
          </Field>
        </div>

        <Field label={<>TKS fluid used <span className="font-normal text-muted-foreground">(optional)</span></>}>
          <Input type="number" step="0.1" min="0" value={tksGallons}
            onChange={e => setTksGallons(e.target.value)} placeholder="0" />
        </Field>

        {/* Notes */}
        <Field label={<>Notes <span className="font-normal text-muted-foreground">(optional)</span></>}>
          <Textarea value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="Conditions, anything notable…" rows={3} />
        </Field>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {confirmDelete && (
          <p className="text-sm text-muted-foreground">
            Tap "Confirm delete" above to permanently remove this flight, or{' '}
            <button type="button" className="underline" onClick={() => setConfirmDelete(false)}>
              cancel
            </button>
            .
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
