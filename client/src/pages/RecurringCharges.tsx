import { useEffect, useState, type FormEvent } from 'react'
import { Select } from '@/components/ui/select'
import { useSearchParams } from 'react-router-dom'
import { useGoBack } from '@/lib/navigation'
import { ChevronLeft, Plus, RefreshCw } from 'lucide-react'
import { api, type RecurringCharge, type PartnershipMember } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { TYPE_CONFIG, typesFor, type Direction } from '@/lib/ledgerTypes'

const now = new Date()

const TODAY = now.toISOString().slice(0, 10)

interface EditState {
  entry_type: string
  direction: Direction
  amount: string
  description_template: string
  day_of_month: string
  next_due_date: string
}

export function RecurringCharges() {
  const { user } = useAuth()
  const [searchParams] = useSearchParams()

  const [recurring, setRecurring]       = useState<RecurringCharge[]>([])
  const [lessees, setLessees]           = useState<PartnershipMember[]>([])
  const [selectedLesseeId, setLesseeId] = useState<string>('')
  const goBack = useGoBack(selectedLesseeId ? `/ledger?lessee_id=${selectedLesseeId}` : '/ledger')
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState('')
  const [showForm, setShowForm]         = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting, setDeleting]         = useState(false)
  const [editingId, setEditingId]       = useState<string | null>(null)
  const [editState, setEditState]       = useState<EditState | null>(null)
  const [editSaving, setEditSaving]     = useState(false)
  const [editError, setEditError]       = useState('')

  // New charge form state
  const [entryType, setEntryType]       = useState('monthly_lease')
  const [direction, setDirection]       = useState<Direction>('debit')
  const [amount, setAmount]             = useState('')
  const [descTemplate, setDescTemplate] = useState(TYPE_CONFIG['monthly_lease'].defaultDesc)
  const [dayOfMonth, setDayOfMonth]     = useState('1')
  const [nextDueDate, setNextDueDate]   = useState(TODAY)
  const [submitting, setSubmitting]     = useState(false)
  const [formError, setFormError]       = useState('')

  useEffect(() => {
    api.get<PartnershipMember[]>('/ledger/lessees')
      .then(ls => {
        setLessees(ls)
        const wanted = searchParams.get('lessee_id')
        setLesseeId(ls.find(l => l.id === wanted)?.id ?? ls.find(l => l.id === user?.id)?.id ?? ls[0]?.id ?? '')
      })
      .catch(() => {})
  }, [user?.id])

  function loadRecurring(lesseeId?: string) {
    setLoading(true)
    const param = lesseeId ? `?lessee_id=${lesseeId}` : ''
    api.get<RecurringCharge[]>(`/ledger/recurring${param}`)
      .then(setRecurring)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (selectedLesseeId) loadRecurring(selectedLesseeId)
  }, [selectedLesseeId])

  // Arriving from the ledger's Upcoming list: open that charge for editing.
  useEffect(() => {
    const editId = searchParams.get('edit')
    const r = editId ? recurring.find(x => x.id === editId) : null
    if (r && editingId !== r.id && !editState) startEdit(r)
  }, [recurring])

  const typeOptions = typesFor([lessees.find(l => l.id === selectedLesseeId)?.role])

  // Keep the chosen type valid for whoever the charge is for (e.g. owners have no monthly lease).
  useEffect(() => {
    if (typeOptions.length && !typeOptions.some(([k]) => k === entryType)) handleTypeChange(typeOptions[0][0])
  }, [selectedLesseeId, lessees.length])

  function handleTypeChange(type: string) {
    const cfg = TYPE_CONFIG[type]
    setEntryType(type)
    setDirection(cfg.direction)
    setDescTemplate(cfg.defaultDesc)
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    setFormError('')
    const amt = parseFloat(amount)
    if (isNaN(amt) || amt <= 0) { setFormError('Amount must be positive'); return }
    setSubmitting(true)
    try {
      await api.post('/ledger/recurring', {
        entry_type: entryType,
        direction,
        amount: amt,
        description_template: descTemplate,
        day_of_month: parseInt(dayOfMonth) || 1,
        next_due_date: nextDueDate,
        ...(selectedLesseeId ? { lessee_id: selectedLesseeId } : {}),
      })
      setShowForm(false)
      setAmount('')
      loadRecurring(selectedLesseeId || undefined)
    } catch (err: any) {
      setFormError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSubmitting(false)
    }
  }

  function startEdit(r: RecurringCharge) {
    setEditingId(r.id)
    setConfirmDeleteId(null)
    setEditError('')
    setEditState({
      entry_type: r.entry_type,
      direction: r.direction,
      amount: parseFloat(r.amount).toFixed(2),
      description_template: r.description_template,
      day_of_month: String(r.day_of_month),
      next_due_date: r.next_due_date,
    })
  }

  function cancelEdit() {
    setEditingId(null)
    setEditState(null)
    setEditError('')
  }

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault()
    if (!editingId || !editState) return
    setEditError('')
    const amt = parseFloat(editState.amount)
    if (isNaN(amt) || amt <= 0) { setEditError('Amount must be positive'); return }
    setEditSaving(true)
    try {
      await api.patch(`/ledger/recurring/${editingId}`, {
        entry_type: editState.entry_type,
        direction: editState.direction,
        amount: amt,
        description_template: editState.description_template,
        day_of_month: parseInt(editState.day_of_month) || 1,
        next_due_date: editState.next_due_date,
      })
      cancelEdit()
      loadRecurring(selectedLesseeId || undefined)
    } catch (err: any) {
      setEditError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setEditSaving(false)
    }
  }

  async function handleDelete(id: string) {
    setDeleting(true)
    try {
      await api.delete(`/ledger/recurring/${id}`)
      setRecurring(prev => prev.filter(r => r.id !== id))
      setConfirmDeleteId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background px-4 py-3">
        <div className="flex items-center gap-2">
          <button
            onClick={goBack}
            className="rounded-md p-1 text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h1 className="text-lg font-semibold">Recurring Charges</h1>
        </div>
        <Button size="sm" onClick={() => setShowForm(f => !f)}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>

      <div className="space-y-4 p-4">
        {/* Lessee picker — owner only */}
        {lessees.length > 1 && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">Viewing for:</p>
            <Select
              value={selectedLesseeId}
              onChange={e => setLesseeId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {lessees.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </Select>
          </div>
        )}

        {/* New charge form */}
        {showForm && (
          <form onSubmit={handleCreate} className="space-y-4 rounded-lg border bg-card p-4">
            <p className="text-sm font-semibold">New recurring charge</p>

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
                    key={d} type="button" onClick={() => setDirection(d)}
                    className={cn(
                      'rounded-full border px-4 py-1.5 text-sm capitalize transition-colors',
                      direction === d
                        ? d === 'debit'
                          ? 'border-destructive bg-destructive/10 text-destructive'
                          : 'border-emerald-600 bg-emerald-50 text-emerald-700'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                  >{d}</button>
                ))}
              </div>
            </div>

            <Field label="Amount ($)">
              <Input type="number" step="0.01" min="0.01" placeholder="0.00" value={amount} onChange={e => setAmount(e.target.value)} required />
            </Field>

            <Field label="Description template">
              <Input type="text" value={descTemplate} onChange={e => setDescTemplate(e.target.value)} required />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Day of month">
                <Input type="number" min="1" max="28" value={dayOfMonth} onChange={e => setDayOfMonth(e.target.value)} required />
              </Field>
              <Field label="First due date">
                <Input type="date" value={nextDueDate} onChange={e => setNextDueDate(e.target.value)} required />
              </Field>
            </div>

            {formError && <p className="text-sm text-destructive">{formError}</p>}

            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={submitting}>{submitting ? 'Saving…' : 'Save'}</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
            </div>
          </form>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        {!loading && recurring.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-14 text-center">
            <RefreshCw className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No recurring charges</p>
          </div>
        )}

        <div className="space-y-2">
          {recurring.map(r => (
            <div
              key={r.id}
              className={cn(
                'rounded-lg border bg-card transition-colors',
                editingId === r.id
                  ? 'border-primary/40 bg-primary/5'
                  : confirmDeleteId === r.id
                  ? 'border-destructive/40 bg-destructive/5'
                  : 'cursor-pointer hover:bg-accent/40'
              )}
            >
              {editingId === r.id && editState ? (
                /* ── Inline edit form ── */
                <form onSubmit={handleSaveEdit} className="space-y-3 p-3">
                  <p className="text-sm font-semibold">Edit recurring charge</p>

                  <div className="space-y-1.5">
                    <Label>Type</Label>
                    <Select
                      value={editState.entry_type}
                      onChange={e => setEditState(s => s && ({ ...s, entry_type: e.target.value }))}
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
                          key={d} type="button"
                          onClick={() => setEditState(s => s && ({ ...s, direction: d }))}
                          className={cn(
                            'rounded-full border px-4 py-1.5 text-sm capitalize transition-colors',
                            editState.direction === d
                              ? d === 'debit'
                                ? 'border-destructive bg-destructive/10 text-destructive'
                                : 'border-emerald-600 bg-emerald-50 text-emerald-700'
                              : 'border-border text-muted-foreground hover:text-foreground'
                          )}
                        >{d}</button>
                      ))}
                    </div>
                  </div>

                  <Field label="Amount ($)">
                    <Input
                      type="number" step="0.01" min="0.01"
                      value={editState.amount}
                      onChange={e => setEditState(s => s && ({ ...s, amount: e.target.value }))}
                      required
                    />
                  </Field>

                  <Field label="Description template">
                    <Input
                      type="text"
                      value={editState.description_template}
                      onChange={e => setEditState(s => s && ({ ...s, description_template: e.target.value }))}
                      required
                    />
                  </Field>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Day of month">
                      <Input
                        type="number" min="1" max="28"
                        value={editState.day_of_month}
                        onChange={e => setEditState(s => s && ({ ...s, day_of_month: e.target.value }))}
                        required
                      />
                    </Field>
                    <Field label="Next due date">
                      <Input
                        type="date"
                        value={editState.next_due_date}
                        onChange={e => setEditState(s => s && ({ ...s, next_due_date: e.target.value }))}
                        required
                      />
                    </Field>
                  </div>

                  {editError && <p className="text-sm text-destructive">{editError}</p>}

                  <div className="flex gap-2">
                    <Button type="submit" size="sm" disabled={editSaving}>{editSaving ? 'Saving…' : 'Save'}</Button>
                    <Button type="button" size="sm" variant="outline" onClick={cancelEdit}>Cancel</Button>
                  </div>
                </form>
              ) : (
                /* ── Read-only row ── */
                <div
                  className="p-3"
                  onClick={() => {
                    if (confirmDeleteId === r.id) { setConfirmDeleteId(null); return }
                    startEdit(r)
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{r.description_template}</p>
                      <p className="text-xs text-muted-foreground capitalize">
                        {r.entry_type.replace(/_/g, ' ')} · day {r.day_of_month} monthly
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className={cn('text-sm font-semibold tabular-nums', r.direction === 'credit' ? 'text-emerald-600' : 'text-destructive')}>
                        {r.direction === 'credit' ? '+' : '–'}${parseFloat(r.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </p>
                      <p className="text-xs text-muted-foreground">next: {r.next_due_date}</p>
                    </div>
                  </div>
                  {confirmDeleteId === r.id && (
                    <div className="mt-2 flex items-center justify-between border-t border-destructive/20 pt-2">
                      <p className="text-xs text-muted-foreground">Remove this recurring charge?</p>
                      <Button
                        variant="destructive" size="sm" disabled={deleting}
                        onClick={evt => { evt.stopPropagation(); handleDelete(r.id) }}
                      >
                        {deleting ? 'Removing…' : 'Confirm'}
                      </Button>
                    </div>
                  )}
                </div>
              )}

              {/* Delete trigger — shown in edit mode */}
              {editingId === r.id && (
                <div className="border-t px-3 pb-3">
                  {confirmDeleteId === r.id ? (
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">Remove this recurring charge?</p>
                      <Button
                        variant="destructive" size="sm" disabled={deleting}
                        onClick={() => handleDelete(r.id)}
                      >
                        {deleting ? 'Removing…' : 'Confirm'}
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="text-xs text-destructive hover:underline"
                      onClick={() => setConfirmDeleteId(r.id)}
                    >
                      Delete this recurring charge
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
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
