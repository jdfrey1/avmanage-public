import { useEffect, useState, type FormEvent } from 'react'
import { Select } from '@/components/ui/select'
import { useNavigate, useParams } from 'react-router-dom'
import { useGoBack } from '@/lib/navigation'
import { ChevronLeft, Trash2 } from 'lucide-react'
import { api, documentsApi, uploadInvoice, type AircraftDocument, type LedgerEntry, type PartnershipMember } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { TYPE_CONFIG, typesFor, type Direction } from '@/lib/ledgerTypes'


export function EditLedgerEntry() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [loading, setLoading]           = useState(true)
  const [notFound, setNotFound]         = useState(false)
  const [entryType, setEntryType]       = useState('monthly_lease')
  const [lesseeId, setLesseeId]     = useState('')
  const [invoices, setInvoices]     = useState<{ id: string; invoice_number: string }[]>([])
  const [docs, setDocs]             = useState<{ id: string; title: string }[]>([])
  const [allDocs, setAllDocs]       = useState<AircraftDocument[]>([])
  const [invoiceFile, setInvoiceFile] = useState<File | null>(null)
  const [role, setRole]                 = useState<'owner' | 'lessee' | undefined>()
  const [direction, setDirection]       = useState<Direction>('debit')
  const [amount, setAmount]             = useState('')
  const [effectiveDate, setDate]        = useState('')
  const [description, setDescription]  = useState('')
  const [error, setError]              = useState('')
  const [submitting, setSubmitting]    = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting]        = useState(false)

  useEffect(() => {
    api.get<LedgerEntry>(`/ledger/${id}`)
      .then(e => {
        setEntryType(e.entry_type)
        setDirection(e.direction)
        setAmount(parseFloat(e.amount).toFixed(2))
        setDate(e.effective_date)
        setDescription(e.description)
        setLesseeId(e.lessee_id)
        setInvoices(e.invoices ?? [])
        setDocs(e.documents ?? [])
        documentsApi.list().then(setAllDocs).catch(() => {})
        api.get<PartnershipMember[]>('/ledger/lessees')
          .then(ls => setRole(ls.find(l => l.id === e.lessee_id)?.role))
          .catch(() => {})
      })
      .catch(err => {
        if (err.status === 404) setNotFound(true)
        else setError(err.message)
      })
      .finally(() => setLoading(false))
  }, [id])

  function handleTypeChange(type: string) {
    const cfg = TYPE_CONFIG[type]
    if (cfg) {
      setEntryType(type)
      setDirection(cfg.direction)
    } else {
      setEntryType(type)
    }
  }

  async function linkDoc(documentId: string) {
    if (!documentId) return
    await api.post(`/ledger/${id}/documents`, { document_id: documentId })
    const d = allDocs.find(x => x.id === documentId)
    if (d) setDocs(prev => [...prev, { id: d.id, title: d.title }])
  }
  async function unlinkDoc(documentId: string) {
    await api.delete(`/ledger/${id}/documents/${documentId}`)
    setDocs(prev => prev.filter(d => d.id !== documentId))
  }

  const ledgerUrl = lesseeId ? `/ledger?lessee_id=${lesseeId}` : '/ledger'
  const goBack = useGoBack(ledgerUrl)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    const amt = parseFloat(amount)
    if (isNaN(amt) || amt <= 0) { setError('Amount must be a positive number'); return }
    setSubmitting(true)
    try {
      await api.patch<LedgerEntry>(`/ledger/${id}`, { entry_type: entryType, direction, amount: amt, effective_date: effectiveDate, description })
      if (invoiceFile && id) {
        try {
          const inv = await uploadInvoice(invoiceFile, [id])
          inv.parsed ? goBack() : navigate(`/invoices/${inv.id}`)
          return
        } catch (err: any) {
          setError(`Entry saved, but the invoice upload failed: ${err instanceof Error ? err.message : 'error'}`)
          return
        }
      }
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
      await api.delete(`/ledger/${id}`)
      goBack()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  if (loading) return <div className="p-8 text-center text-sm text-muted-foreground">Loading…</div>
  if (notFound) return <div className="p-8 text-center text-sm text-destructive">Entry not found.</div>

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
          <h1 className="text-lg font-semibold">Edit Entry</h1>
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
        <Field label="Date">
          <Input type="date" value={effectiveDate} onChange={e => setDate(e.target.value)} required />
        </Field>

        <div className="space-y-1.5">
          <Label>Type</Label>
          <Select
            value={entryType}
            onChange={e => handleTypeChange(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {typesFor([role]).map(([key, { label }]) => (
              <option key={key} value={key}>{label}</option>
            ))}
            {!typesFor([role]).some(([k]) => k === entryType) && (
              <option value={entryType}>{TYPE_CONFIG[entryType]?.label ?? entryType.replace(/_/g, ' ')}</option>
            )}
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

        <Field label="Amount ($)">
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

        <div className="space-y-1.5">
          <Label>Invoice</Label>
          {invoices.length > 0 && (
            <ul className="space-y-0.5">
              {invoices.map(inv => (
                <li key={inv.id} className="text-sm">
                  <button type="button" className="text-primary hover:underline" onClick={() => navigate(`/invoices/${inv.id}`)}>
                    Invoice {inv.invoice_number}
                  </button>
                  {' '}
                  <a href={`/api/invoices/${inv.id}/file`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    (Original)
                  </a>
                </li>
              ))}
            </ul>
          )}
          <input
            type="file" accept="application/pdf,image/*"
            onChange={e => setInvoiceFile(e.target.files?.[0] ?? null)}
            className="block w-full text-xs file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-xs"
          />
          <p className="text-xs text-muted-foreground">
            {invoices.length ? 'Attach another invoice' : 'Attach the shop invoice'} (PDF or photo); it's saved when you press Save. Unlink invoices from the invoice page.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Documents</Label>
          {docs.length > 0 && (
            <ul className="space-y-0.5">
              {docs.map(d => (
                <li key={d.id} className="flex items-center gap-2 text-sm">
                  <a href={documentsApi.fileUrl(d.id)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-primary hover:underline">{d.title}</a>
                  <button type="button" title="Unlink" onClick={() => unlinkDoc(d.id)} className="text-xs text-muted-foreground hover:text-destructive">unlink</button>
                </li>
              ))}
            </ul>
          )}
          <Select
            value="" onChange={e => linkDoc(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            <option value="">Link a document (insurance binder, lease…)</option>
            {allDocs.filter(d => d.doc_type !== 'invoice' && !docs.some(x => x.id === d.id)).map(d => (
              <option key={d.id} value={d.id}>{d.title}</option>
            ))}
          </Select>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {confirmDelete && (
          <p className="text-sm text-muted-foreground">
            Tap "Confirm delete" to permanently remove this entry, or{' '}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  )
}
