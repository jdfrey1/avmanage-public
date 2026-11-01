import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, Camera } from 'lucide-react'
import { api, type Flight, type Squawk, type CurrencyStatus, type TachOcrResult, type PartnershipMember, type Partnership } from '@/lib/api'
import { takePendingPhoto } from '@/lib/pendingPhoto'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

const TABS_GALLONS = '60'
const FULL_GALLONS = '92'

function today() {
  return new Date().toISOString().slice(0, 10)
}

export function LogFlight() {
  const navigate = useNavigate()
  const { user } = useAuth()

  const [flightDate, setFlightDate] = useState(today())
  const [route, setRoute] = useState('')
  const [tachStart, setTachStart] = useState('')
  const [tachEnd, setTachEnd] = useState('')
  const [hobbsStart, setHobbsStart] = useState('')
  const [hobbsEnd, setHobbsEnd] = useState('')
  const [fuelGallons, setFuelGallons] = useState(TABS_GALLONS)
  const [tksGallons, setTksGallons] = useState('')
  const [fuelAdded, setFuelAdded] = useState('')
  const [oilAdded, setOilAdded] = useState('')
  const [excludeFromAllotment, setExcludeFromAllotment] = useState(false)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Pilot selection
  const [members, setMembers] = useState<PartnershipMember[]>([])
  const [pilotId, setPilotId] = useState('')

  // Squawk toggle
  const [reportSquawk, setReportSquawk]     = useState(false)
  const [squawkDesc, setSquawkDesc]         = useState('')
  const [squawkSeverity, setSquawkSeverity] = useState<'major' | 'minor' | 'note'>('note')
  const [currency, setCurrency]             = useState<CurrencyStatus | null>(null)
  const [openSquawks, setOpenSquawks]       = useState<Squawk[]>([])

  // Hobbs/Flight photo OCR. NOTE: state vars keep their old tach*/hobbs* names
  // (matching the unchanged DB columns tach_start/tach_end/hobbs_start/hobbs_end)
  // even though the UI now labels them "Hobbs" and "Flight" respectively.
  const photoInputRef = useRef<HTMLInputElement>(null)
  const [ocrEnabled, setOcrEnabled]   = useState(false)
  const [ocrLoading, setOcrLoading]   = useState(false)
  const [ocrError, setOcrError]       = useState('')
  const [ocrResult, setOcrResult]     = useState<TachOcrResult | null>(null)
  const [ocrImageKey, setOcrImageKey] = useState<string | null>(null)

  useEffect(() => {
    api.get<Flight[]>('/flights?limit=1').then(async ([last]) => {
      if (last) {
        setTachStart(parseFloat(last.tach_end).toFixed(1))
        if (last.hobbs_end) setHobbsStart(parseFloat(last.hobbs_end).toFixed(1))
        return
      }
      // No flights yet: start from the recorded meter baseline.
      const p = await api.get<Partnership>('/partnership')
      if (p.baseline_hobbs != null) setTachStart(p.baseline_hobbs.toFixed(1))
      if (p.baseline_flight != null) setHobbsStart(p.baseline_flight.toFixed(1))
    }).catch(() => {})
    api.get<CurrencyStatus>('/currency').then(setCurrency).catch(() => {})
    api.get<Squawk[]>('/squawks?status=open').then(setOpenSquawks).catch(() => {})
    api.get<{ ocrEnabled: boolean }>('/config').then(c => setOcrEnabled(c.ocrEnabled)).catch(() => {})
    api.get<PartnershipMember[]>('/schedule/members').then(ms => {
      setMembers(ms)
      const self = ms.find(m => m.user_id === user?.id)
      setPilotId(self?.id ?? ms[0]?.id ?? '')
    }).catch(() => {})

    const pendingPhoto = takePendingPhoto()
    if (pendingPhoto) runOcr(pendingPhoto)
  }, [])

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
    if (!tachValid) {
      setError('Hobbs end must be ≥ Hobbs start')
      return
    }
    if (!hobbsValid) {
      setError('Flight end must be ≥ Flight start')
      return
    }
    setSubmitting(true)
    try {
      await api.post<Flight>('/flights', {
        flight_date: flightDate,
        route: route || undefined,
        tach_start: parseFloat(tachStart),
        tach_end: parseFloat(tachEnd),
        hobbs_start: parseFloat(hobbsStart),
        hobbs_end: parseFloat(hobbsEnd),
        fuel_gallons: fuelGallons ? parseFloat(fuelGallons) : undefined,
        tks_gallons: tksGallons ? parseFloat(tksGallons) : undefined,
        fuel_added_gallons: fuelAdded ? parseFloat(fuelAdded) : undefined,
        oil_added_quarts: oilAdded ? parseFloat(oilAdded) : undefined,
        notes: notes || undefined,
        ocr_source_image_key: ocrImageKey || undefined,
        pilot_id: pilotId || undefined,
        exclude_from_allotment: excludeFromAllotment,
      })
      if (reportSquawk && squawkDesc.trim()) {
        await api.post<Squawk>('/squawks', {
          description: squawkDesc.trim(),
          severity: squawkSeverity,
          tach_at_report: parseFloat(tachEnd),
        })
      }
      navigate('/flights')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save flight')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-4 py-3">
        <button
          onClick={() => navigate('/flights')}
          className="rounded-md p-1 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold">Log Flight</h1>
      </div>

      {/* Currency / squawk warnings */}
      {(currency || openSquawks.length > 0) && (() => {
        const warnings: string[] = []
        if (currency) {
          if (!currency.ifr.current) warnings.push('IFR not current')
          if (!currency.dayLanding.current) warnings.push('Day landings not current')
          if (!currency.nightLanding.current) warnings.push('Night landings not current')
          if (currency.medical && !currency.medical.current) warnings.push('Medical expired')
        }
        return (warnings.length > 0 || openSquawks.length > 0) ? (
          <div className="space-y-1.5 border-b px-4 py-3">
            {warnings.length > 0 && (
              <div className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 dark:border-amber-600 dark:bg-amber-950/30">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Currency warning: {warnings.join(', ')}</p>
              </div>
            )}
            {openSquawks.length > 0 && (
              <div className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 dark:border-amber-600 dark:bg-amber-950/30">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400">{openSquawks.length} open squawk{openSquawks.length > 1 ? 's' : ''} — review maintenance log before flying</p>
              </div>
            )}
          </div>
        ) : null
      })()}

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
                {ocrLoading ? 'Reading…' : 'Import Photo'}
              </button>
            )}
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handlePhotoSelect}
            />
          </div>

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
              <Input
                type="number"
                step="0.1"
                min="0"
                value={tachStart}
                onChange={e => setTachStart(e.target.value)}
                placeholder="1847.3"
                required
              />
            </Field>
            <Field label="End">
              <Input
                type="number"
                step="0.1"
                min="0"
                value={tachEnd}
                onChange={e => setTachEnd(e.target.value)}
                placeholder="1852.1"
                required
              />
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
              <Input
                type="number"
                step="0.1"
                min="0"
                value={hobbsStart}
                onChange={e => setHobbsStart(e.target.value)}
                placeholder="2104.2"
                required
              />
            </Field>
            <Field label="End">
              <Input
                type="number"
                step="0.1"
                min="0"
                value={hobbsEnd}
                onChange={e => setHobbsEnd(e.target.value)}
                placeholder="2108.9"
                required
              />
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
          <Input
            type="number"
            step="0.1"
            min="0"
            value={fuelGallons}
            onChange={e => setFuelGallons(e.target.value)}
            placeholder="45.0"
          />
        </div>

        {/* Fuel & oil added */}
        <div className="grid grid-cols-2 gap-3">
          <Field label={<>Fuel added (gal) <span className="font-normal text-muted-foreground">(optional)</span></>}>
            <Input type="number" step="0.1" min="0" value={fuelAdded} onChange={e => setFuelAdded(e.target.value)} placeholder="0" />
          </Field>
          <Field label={<>Oil added (qt) <span className="font-normal text-muted-foreground">(optional)</span></>}>
            <Input type="number" step="0.5" min="0" value={oilAdded} onChange={e => setOilAdded(e.target.value)} placeholder="0" />
          </Field>
        </div>

        {/* TKS */}
        <Field label={<>TKS fluid used <span className="font-normal text-muted-foreground">(optional)</span></>}>
          <Input
            type="number"
            step="0.1"
            min="0"
            value={tksGallons}
            onChange={e => setTksGallons(e.target.value)}
            placeholder="0"
          />
        </Field>

        {/* Notes */}
        <Field label={<>Notes <span className="font-normal text-muted-foreground">(optional)</span></>}>
          <Textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Conditions, anything notable…"
            rows={3}
          />
        </Field>

        {/* Report a squawk */}
        <div className={cn(
          'rounded-lg border p-3 transition-colors',
          reportSquawk ? 'border-primary/40 bg-primary/5' : 'border-border'
        )}>
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Report a squawk</p>
              <p className="text-xs text-muted-foreground">Log an issue observed during this flight</p>
            </div>
            <div
              className={cn('relative h-6 w-11 rounded-full transition-colors', reportSquawk ? 'bg-primary' : 'bg-muted')}
              onClick={() => setReportSquawk(v => !v)}
            >
              <span className={cn(
                'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
                reportSquawk ? 'translate-x-5' : 'translate-x-0.5'
              )} />
            </div>
          </label>

          {reportSquawk && (
            <div className="mt-3 space-y-3 border-t pt-3">
              <div className="space-y-1.5">
                <Label>Description</Label>
                <Textarea
                  value={squawkDesc}
                  onChange={e => setSquawkDesc(e.target.value)}
                  placeholder="Describe the issue…"
                  rows={2}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Severity</Label>
                <div className="flex gap-2">
                  {([
                    { val: 'major' as const, label: 'Major', active: 'border-destructive bg-destructive/10 text-destructive font-medium' },
                    { val: 'minor' as const, label: 'Minor', active: 'border-amber-500 bg-amber-50 text-amber-700 font-medium' },
                    { val: 'note'  as const, label: 'Note',  active: 'border-emerald-500 bg-emerald-50 text-emerald-700 font-medium' },
                  ]).map(({ val, label, active }) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setSquawkSeverity(val)}
                      className={cn(
                        'rounded-full border px-3 py-1.5 text-xs transition-colors',
                        squawkSeverity === val ? active : 'border-border text-muted-foreground'
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save flight'}
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
