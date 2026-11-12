import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useGoBack } from '@/lib/navigation'
import { ChevronLeft, Search } from 'lucide-react'
import { api, type InvoiceSummary } from '@/lib/api'
import { Input } from '@/components/ui/input'

export const money = (n: number | null | undefined) =>
  n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const fmtDate = (d: string | null) =>
  d ? new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''

// The snippet comes back with <b> highlights from ts_headline; render only that tag.
function Snippet({ html }: { html: string }) {
  const parts = html.split(/(<b>.*?<\/b>)/g)
  return (
    <>
      {parts.map((p, i) => p.startsWith('<b>')
        ? <mark key={i} className="rounded bg-yellow-200/70 px-0.5 dark:bg-yellow-500/30">{p.slice(3, -4)}</mark>
        : <span key={i}>{p}</span>)}
    </>
  )
}

export function Invoices() {
  const navigate = useNavigate()
  const goBack = useGoBack('/maintenance')
  const [q, setQ] = useState('')
  const [invoices, setInvoices] = useState<InvoiceSummary[] | null>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      api.get<InvoiceSummary[]>(`/invoices${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`)
        .then(setInvoices).catch(() => setInvoices([]))
    }, 250)
    return () => clearTimeout(t)
  }, [q])

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-4 py-3">
        <button onClick={goBack} className="rounded-md p-1 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-lg font-semibold">Maintenance Invoices</h1>
          <p className="text-xs text-muted-foreground">Work orders from the shop — search any line item.</p>
        </div>
      </div>

      <div className="space-y-3 p-4">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Search work performed, parts… (e.g. exhaust, battery, brake)" value={q} onChange={e => setQ(e.target.value)} />
        </div>

        {invoices === null && <p className="text-sm text-muted-foreground">Loading…</p>}
        {invoices?.length === 0 && <p className="text-sm text-muted-foreground">{q ? 'No matching line items.' : 'No invoices yet.'}</p>}

        {invoices?.map(i => (
          <div key={i.id} className="cursor-pointer rounded-lg border bg-card p-3 hover:bg-accent/40" onClick={() => navigate(`/invoices/${i.id}`)}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{i.vendor} — {i.invoice_number}</p>
                <p className="text-xs text-muted-foreground">{i.summary}</p>
                <p className="text-xs text-muted-foreground">
                  {fmtDate(i.invoice_date)}{i.customer ? ` · ${i.customer}` : ''}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-semibold tabular-nums">{money(i.total)}</p>
                <p className="text-[11px] text-muted-foreground">
                  {i.ledger_count ? `${i.ledger_count} ledger` : 'not in ledger'}
                  {i.logbook_count ? ` · ${i.logbook_count} logbook` : ''}
                </p>
              </div>
            </div>
            {i.matches.length > 0 && (
              <ul className="mt-2 space-y-1 border-t pt-2">
                {i.matches.slice(0, 6).map(m => (
                  <li key={m.item_no} className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">#{m.item_no}</span> <Snippet html={m.snippet} />
                    {m.status !== 'approved' && <span className="ml-1 uppercase">({m.status})</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
