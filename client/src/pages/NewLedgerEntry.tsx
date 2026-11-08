import { useEffect, useState, type FormEvent } from 'react'
import { Select } from '@/components/ui/select'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import { api, uploadInvoice, type LedgerEntry, type RecurringCharge, type PartnershipMember } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { TYPE_CONFIG, typesFor, type Direction } from '@/lib/ledgerTypes'

const now = new Date()
const TODAY = now.toISOString().slice(0, 10)

const DEFAULT_TYPE = 'monthly_lease'

export function NewLedgerEntry() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { user } = useAuth()

  const [lessees, setLessees]             = useState<PartnershipMember[]>([])
  const [selectedLesseeIds, setSelectedIds] = useState<string[]>(
    () => { const id = searchParams.get('lessee_id'); return id ? [id] : [] }
  )
  const [entryType, setEntryType]         = useState(DEFAULT_TYPE)
  const [direction, setDirection]         = useState<Direction>(TYPE_CONFIG[DEFAULT_TYPE].direction)
  const [amount, setAmount]               = useState('')
  const [effectiveDate, setDate]          = useState(TODAY)
  const [description, setDescription]     = useState(TYPE_CONFIG[DEFAULT_TYPE].defaultDesc)
  const [error, setError]                 = useState('')
  const [submitting, setSubmitting]       = useState(false)

  const [invoiceFile, setInvoiceFile] = useState<File | null>(null)
  const [makeRecurring, setMakeRecurring] = useState(false)
  const [dayOfMonth, setDayOfMonth]       = useState('1')
  const [nextDueDate, setNextDueDate]     = useState(TODAY)

  useEffect(() => {
    api.get<PartnershipMember[]>('/ledger/lessees')
      .then(ls => {
        setLessees(ls)
        if (selectedLesseeIds.length === 0) {
          const self = ls.find(l => l.id === user?.id)
          setSelectedIds(self ? [self.id] : ls[0] ? [ls[0].id] : [])
        }
      })
      .catch(() => {})
  }, [])

  function toggleLessee(id: string) {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  const typeOptions = typesFor(selectedLesseeIds.map(id => lessees.find(l => l.id === id)?.role))

  // Keep the chosen type valid when the selected people change.
  useEffect(() => {
    if (typeOptions.length && !typeOptions.some(([k]) => k === entryType)) handleTypeChange(typeOptions[0][0])
  }, [selectedLesseeIds.join(','), lessees.length])

  function handleTypeChange(type: string) {
    const cfg = TYPE_CONFIG[type]
    setEntryType(type)
    setDirection(cfg.direction)
    setDescription(cfg.defaultDesc)
  }

  const splitCount   = selectedLesseeIds.length || 1
  const splitAmount  = amount && !isNaN(parseFloat(amount))
    ? parseFloat(amount) / splitCount
    : null

  const ledgerUrl = selectedLesseeIds[0] ? `/ledger?lessee_id=${selectedLesseeIds[0]}` : '/ledger'

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    const amt = parseFloat(amount)
    if (isNaN(amt) || amt <= 0) { setError('Amount must be a positive number'); return }
    if (selectedLesseeIds.length === 0) { setError('Select at least one person'); return }
    setSubmitting(true)

    const isMulti  = selectedLesseeIds.length > 1
    const perAmt   = amt / selectedLesseeIds.length
    const desc     = isMulti ? `${description} (split ${selectedLesseeIds.length} ways)` : description

    try {
      const created = await Promise.all(selectedLesseeIds.map(lesseeId => {
        if (makeRecurring) {
          return api.post<RecurringCharge>('/ledger/recurring', {
            entry_type: entryType,
            direction,
            amount: perAmt,
            description_template: desc,
            day_of_month: parseInt(dayOfMonth) || 1,
            next_due_date: nextDueDate,
            lessee_id: lesseeId,
          })
        } else {
          return api.post<LedgerEntry>('/ledger', {
            entry_type: entryType,
            direction,
            amount: perAmt,
            effective_date: effectiveDate,
            description: desc,
            lessee_id: lesseeId,
          })
        }
      }))
      if (invoiceFile && !makeRecurring) {
        const ids = (created as LedgerEntry[]).map(c => c.id)
        try {
          const inv = await uploadInvoice(invoiceFile, ids)
          // Not a recognised work order: take them to fill in the vendor / number / date.
          navigate(inv.parsed ? ledgerUrl : `/invoices/${inv.id}`)
          return
        } catch (err: any) {
          setError(`Entry saved, but the invoice upload failed: ${err instanceof Error ? err.message : 'error'}`)
          setSubmitting(false)
          return
        }
      }
      navigate(ledgerUrl)
    } catch (err: any) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-4 py-3">
        <button
          onClick={() => navigate(ledgerUrl)}
          className="rounded-md p-1 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold">New Entry</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5 p-4">
        {/* Lessee multi-select */}
        {lessees.length > 0 && (
          <div className="space-y-2">
            <Label>Apply to</Label>
            <div className="space-y-2">
              {lessees.map(l => (
                <label key={l.id} className="flex cursor-pointer items-center gap-3 rounded-md border p-2.5 transition-colors hover:bg-accent/30">
                  <input
                    type="checkbox"
                    checked={selectedLesseeIds.includes(l.id)}
                    onChange={() => toggleLessee(l.id)}
                    className="h-4 w-4 rounded accent-primary"
                  />
                  <span className="text-sm font-medium">{l.name}</span>
                </label>
              ))}
            </div>
            {selectedLesseeIds.length > 1 && splitAmount !== null && (
              <p className="text-xs text-muted-foreground">
                ${splitAmount.toFixed(2)} each — cost split {selectedLesseeIds.length} ways
              </p>
            )}
          </div>
        )}

        <div className="space-y-1.5">
          <Label>Type</Label>
          <Select
            value={entryType}
            onChange={e => handleTypeChange(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {typeOptions.map(([key, { label }]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Direction</Label>
          <div className="flex gap-2">
            {(['debit', 'credit'] as Direction[]).map(d => (
              <button
                key={d}
                type="button"
                onClick={() => setDirection(d)}
                className={cn(
                  'rounded-full border px-4 py-1.5 text-sm capitalize transition-colors',
                  direction === d
                    ? d === 'debit'
                      ? 'border-destructive bg-destructive/10 text-destructive'
                      : 'border-emerald-600 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        <Field label={selectedLesseeIds.length > 1 ? `Total amount ($)` : 'Amount ($)'}>
          <Input
            type="number" step="0.01" min="0.01" placeholder="0.00"
            value={amount} onChange={e => setAmount(e.target.value)} required
          />
        </Field>

        <Field label="Description">
          <Input
            type="text" value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Describe this entry" required
          />
        </Field>

        {/* Make recurring toggle */}
        <div
          className={cn(
            'rounded-lg border p-3 transition-colors',
            makeRecurring ? 'border-primary/40 bg-primary/5' : 'cursor-pointer border-border hover:bg-accent/30'
          )}
          onClick={() => { if (!makeRecurring) setMakeRecurring(true) }}
        >
          <div
            role="switch"
            aria-checked={makeRecurring}
            tabIndex={0}
            className="flex cursor-pointer items-center justify-between gap-3"
            onClick={e => { e.stopPropagation(); setMakeRecurring(v => !v) }}
            onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setMakeRecurring(v => !v) } }}
          >
            <div>
              <p className="text-sm font-medium">Make recurring</p>
              <p className="text-xs text-muted-foreground">Post this charge automatically each month</p>
            </div>
            <div
              className={cn(
                'relative h-6 w-11 shrink-0 rounded-full border transition-colors',
                makeRecurring ? 'border-primary bg-primary' : 'border-muted-foreground/40 bg-muted-foreground/25'
              )}
            >
              <span
                className={cn(
                  'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
                  makeRecurring ? 'translate-x-[1.125rem]' : 'translate-x-0.5'
                )}
              />
            </div>
          </div>

          {makeRecurring && (
            <div className="mt-3 grid grid-cols-2 gap-3 border-t pt-3">
              <Field label="Day of month">
                <Input
                  type="number" min="1" max="28"
                  value={dayOfMonth}
                  onChange={e => setDayOfMonth(e.target.value)}
                  required
                />
              </Field>
              <Field label="First due date">
                <Input
                  type="date"
                  value={nextDueDate}
                  onChange={e => setNextDueDate(e.target.value)}
                  required
                />
              </Field>
            </div>
          )}
        </div>

        {!makeRecurring && (
          <Field label="Date">
            <Input type="date" value={effectiveDate} onChange={e => setDate(e.target.value)} required />
          </Field>
        )}

        {!makeRecurring && (
          <div className="space-y-1.5">
            <Label>Invoice (optional)</Label>
            <input
              type="file" accept="application/pdf,image/*"
              onChange={e => setInvoiceFile(e.target.files?.[0] ?? null)}
              className="block w-full text-xs file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Attach the shop invoice (PDF or photo). It's filed to Google Drive, becomes searchable, and links to this entry.
            </p>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? 'Saving…' : makeRecurring ? 'Save recurring charge' : 'Save entry'}
        </Button>
      </form>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  )
}
