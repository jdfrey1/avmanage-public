import { useEffect, useState, type FormEvent } from 'react'
import { Select } from '@/components/ui/select'
import { useNavigate, useParams } from 'react-router-dom'
import { useGoBack } from '@/lib/navigation'
import { ChevronLeft, ExternalLink, X } from 'lucide-react'
import { api, type InvoiceDetail, type InvoiceItem, type LedgerEntry, type LogbookEntry, type PartnershipMember } from '@/lib/api'
import { TYPE_CONFIG } from '@/lib/ledgerTypes'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { money } from './Invoices'

const fmtDate = (d: string | null) =>
  d ? new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

function ItemRow({ item }: { item: InvoiceItem }) {
  const [open, setOpen] = useState(false)
  return (
    <li className="rounded-md border">
      <button type="button" className="flex w-full items-start gap-2 p-2 text-left" onClick={() => setOpen(o => !o)}>
        <span className="w-6 shrink-0 text-xs font-medium text-muted-foreground">#{item.item_no}</span>
        <span className="min-w-0 flex-1 text-xs">
          {item.description}
          {item.status !== 'approved' && (
            <Badge variant="outline" className="ml-1.5 px-1.5 py-0 text-[10px] uppercase">{item.status}</Badge>
          )}
        </span>
        <span className="shrink-0 text-xs tabular-nums">{money(item.total_amount)}</span>
      </button>
      {open && (
        <div className="space-y-1.5 border-t bg-muted/30 p-2 text-xs">
          {item.item_date && <p className="text-muted-foreground">{fmtDate(item.item_date)}</p>}
          {item.work_performed && <p><span className="font-medium">Work performed:</span> {item.work_performed}</p>}
          <p className="text-muted-foreground">
            Labor {item.labor_hours} hrs @ {money(item.labor_rate)} = {money(item.labor_amount)}
          </p>
          {item.parts.length > 0 && (
            <table className="w-full">
              <tbody>
                {item.parts.map((p, i) => (
                  <tr key={i} className="align-top">
                    <td className="pr-2 text-muted-foreground">{p.part}</td>
                    <td className="pr-2">{p.description}</td>
                    <td className="pr-2 text-right tabular-nums">{p.qty}</td>
                    <td className="text-right tabular-nums">{money(p.ext)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </li>
  )
}

export function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const goBack = useGoBack('/invoices')
  const [inv, setInv] = useState<InvoiceDetail | null>(null)
  const [error, setError] = useState('')
  const [members, setMembers] = useState<PartnershipMember[]>([])

  function load() {
    api.get<InvoiceDetail>(`/invoices/${id}`).then(setInv).catch(() => setError('Invoice not found'))
  }
  useEffect(load, [id])
  useEffect(() => { api.get<PartnershipMember[]>('/ledger/lessees').then(setMembers).catch(() => {}) }, [])

  // ── details editor ──
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ vendor: '', invoice_number: '', invoice_date: '', total: '', summary: '' })
  const [savingDetails, setSavingDetails] = useState(false)
  function openEdit() {
    if (!inv) return
    setForm({ vendor: inv.vendor, invoice_number: inv.invoice_number, invoice_date: inv.invoice_date ?? '', total: inv.total.toFixed(2), summary: inv.summary ?? '' })
    setEditing(true)
  }
  async function saveDetails(e: FormEvent) {
    e.preventDefault()
    setSavingDetails(true); setError('')
    try {
      await api.patch(`/invoices/${id}`, { ...form, total: parseFloat(form.total) })
      setEditing(false); load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to save') }
    finally { setSavingDetails(false) }
  }

  // ── ledger: link existing ──
  const [linkPerson, setLinkPerson] = useState('')
  const [candidates, setCandidates] = useState<LedgerEntry[]>([])
  useEffect(() => {
    if (!linkPerson) { setCandidates([]); return }
    api.get<LedgerEntry[]>(`/ledger?lessee_id=${linkPerson}`)
      .then(es => setCandidates(es.filter(e => e.direction === 'debit' && !e.invoices?.some(i => i.id === id)))).catch(() => {})
  }, [linkPerson, inv?.ledger_entries.length])

  async function linkLedger(ledgerId: string) {
    await api.post(`/invoices/${id}/ledger`, { ledger_id: ledgerId }); load()
  }
  async function unlinkLedger(ledgerId: string) {
    await api.delete(`/invoices/${id}/ledger/${ledgerId}`); load()
  }

  // ── logbook ──
  const [lq, setLq] = useState('')
  const [lbResults, setLbResults] = useState<LogbookEntry[] | null>(null)
  async function searchLogbook() {
    if (!inv) return
    const params = new URLSearchParams()
    if (lq.trim()) params.set('q', lq.trim())
    else if (inv.invoice_date) {
      const d = new Date(inv.invoice_date + 'T12:00')
      const f = (n: number) => new Date(d.getTime() + n * 86400000).toISOString().slice(0, 10)
      params.set('date_from', f(-45)); params.set('date_to', f(30))
    }
    setLbResults(await api.get<LogbookEntry[]>(`/logbook/entries?${params}`))
  }
  async function linkLogbook(entryId: string) {
    await api.post(`/invoices/${id}/logbook`, { entry_id: entryId }); setLbResults(null); load()
  }
  async function unlinkLogbook(entryId: string) {
    await api.delete(`/invoices/${id}/logbook/${entryId}`); load()
  }

  if (!inv) return <p className="p-4 text-sm text-muted-foreground">{error || 'Loading…'}</p>

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-4 py-3">
        <button
          // Go back to wherever the invoice was opened from (ledger, entry, list); the list only if opened directly.
          onClick={goBack}
          className="rounded-md p-1 text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold">{inv.vendor} — {inv.invoice_number}</h1>
          <p className="truncate text-xs text-muted-foreground">{inv.summary}</p>
        </div>
        <a href={`/api/invoices/${inv.id}/file`} target="_blank" rel="noreferrer"
           className="flex shrink-0 items-center gap-1 text-xs text-primary hover:underline">
          PDF <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      <div className="space-y-5 p-4">
        {error && <p className="text-xs text-destructive">{error}</p>}

        {editing ? (
          <form onSubmit={saveDetails} className="space-y-3 rounded-lg border p-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5"><Label>Vendor</Label><Input value={form.vendor} onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))} required /></div>
              <div className="space-y-1.5"><Label>Invoice #</Label><Input value={form.invoice_number} onChange={e => setForm(f => ({ ...f, invoice_number: e.target.value }))} required /></div>
              <div className="space-y-1.5"><Label>Date</Label><Input type="date" value={form.invoice_date} onChange={e => setForm(f => ({ ...f, invoice_date: e.target.value }))} /></div>
              <div className="space-y-1.5"><Label>Total ($)</Label><Input type="number" step="0.01" min="0" value={form.total} onChange={e => setForm(f => ({ ...f, total: e.target.value }))} required /></div>
            </div>
            <div className="space-y-1.5"><Label>Summary</Label><Input value={form.summary} onChange={e => setForm(f => ({ ...f, summary: e.target.value }))} /></div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={savingDetails}>{savingDetails ? 'Saving…' : 'Save'}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <button type="button" onClick={openEdit} className="text-xs text-primary hover:underline">Edit details</button>
        )}

        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md bg-muted/40 p-2"><p className="text-muted-foreground">Invoice date</p><p className="font-medium">{fmtDate(inv.invoice_date)}</p></div>
          <div className="rounded-md bg-muted/40 p-2"><p className="text-muted-foreground">Customer</p><p className="font-medium">{inv.customer}</p></div>
          <div className="rounded-md bg-muted/40 p-2">
            <p className="text-muted-foreground">At the time</p>
            <p className="font-medium">Flight {inv.flight_timer ?? '—'} · Hobbs {inv.hobbs ?? '—'}</p>
          </div>
          <div className="rounded-md bg-muted/40 p-2">
            <p className="text-muted-foreground">Total</p>
            <p className="font-medium tabular-nums">{money(inv.total)}</p>
            <p className="text-muted-foreground">labor {money(inv.labor)} · parts {money(inv.parts)}{inv.shipping ? ` · ship ${money(inv.shipping)}` : ''}</p>
          </div>
        </div>
        {inv.responsible === 'seller' && (
          <p className="text-xs text-muted-foreground">This invoice is the seller's responsibility — it's kept for the maintenance record and isn't a partnership cost.</p>
        )}

        {/* Ledger */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Ledger</h2>
          {inv.ledger_entries.length === 0 && <p className="text-xs text-muted-foreground">Not linked to a ledger entry yet. Add the entry in the Ledger and attach this invoice there, or link an existing one below.</p>}
          <ul className="space-y-1">
            {inv.ledger_entries.map(l => (
              <li key={l.id} className="flex items-center gap-2 rounded bg-muted/30 px-2 py-1.5 text-xs">
                <button className="min-w-0 flex-1 truncate text-left text-primary hover:underline" onClick={() => navigate(`/ledger/${l.id}/edit`)}>
                  {l.lessee_name} · {TYPE_CONFIG[l.entry_type]?.label ?? l.entry_type} · {fmtDate(l.effective_date)} · {money(l.amount)}
                </button>
                <button title="Unlink" onClick={() => unlinkLedger(l.id)} className="text-muted-foreground hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={linkPerson} onChange={e => setLinkPerson(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1.5 text-xs">
              <option value="">Link an existing ledger entry for…</option>
              {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </div>
          {linkPerson && (
            candidates.length === 0
              ? <p className="text-xs text-muted-foreground">No unlinked expense entries for that person.</p>
              : (
                <ul className="space-y-1">
                  {candidates.map(c => (
                    <li key={c.id} className="flex items-center gap-2 rounded border px-2 py-1.5 text-xs">
                      <span className="min-w-0 flex-1 truncate">{fmtDate(c.effective_date)} · {c.description} · ${parseFloat(c.amount).toFixed(2)}</span>
                      <button className="text-primary hover:underline" onClick={() => linkLedger(c.id)}>Link</button>
                    </li>
                  ))}
                </ul>
              )
          )}
        </section>

        {/* Logbook */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Logbook entries</h2>
          {inv.logbook_entries.length === 0 && <p className="text-xs text-muted-foreground">No logbook entries linked yet.</p>}
          <ul className="space-y-1">
            {inv.logbook_entries.map(l => (
              <li key={l.id} className={cn('flex items-center gap-2 rounded bg-muted/30 px-2 py-1.5 text-xs')}>
                <span className="min-w-0 flex-1 truncate">{fmtDate(l.entry_date)} · {l.category} · {l.summary}</span>
                <button title="Unlink" onClick={() => unlinkLogbook(l.id)} className="text-muted-foreground hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Input className="h-8 text-xs" placeholder="Search logbook (blank = entries near the invoice date)" value={lq}
              onChange={e => setLq(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); searchLogbook() } }} />
            <Button size="sm" variant="outline" onClick={searchLogbook}>Find</Button>
          </div>
          {lbResults && (lbResults.length === 0
            ? <p className="text-xs text-muted-foreground">No logbook entries found. Import the new logbook pages first.</p>
            : (
              <ul className="space-y-1">
                {lbResults.slice(0, 30).map(e => (
                  <li key={e.id} className="flex items-center gap-2 rounded border px-2 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate">{fmtDate(e.entry_date)} · {e.category} · {e.summary}</span>
                    {e.invoices?.some(x => x.id === inv.id)
                      ? <span className="text-muted-foreground">linked</span>
                      : <button className="text-primary hover:underline" onClick={() => linkLogbook(e.id)}>Link</button>}
                  </li>
                ))}
              </ul>
            ))}
        </section>

        {/* Line items */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Line items ({inv.items.length})</h2>
          <ul className="space-y-1.5">{inv.items.map(it => <ItemRow key={it.id} item={it} />)}</ul>
        </section>
      </div>
    </div>
  )
}
