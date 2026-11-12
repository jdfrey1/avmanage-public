import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, DollarSign, RefreshCw, Download, FileText } from 'lucide-react'
import { api, type LedgerEntry, type RecurringCharge, type PartnershipMember } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { TYPE_CONFIG } from '@/lib/ledgerTypes'
import { useUrlState } from '@/lib/navigation'
import { CostAnalysis } from '@/components/CostAnalysis'

type View = 'entries' | 'analysis'
const VIEWS: readonly View[] = ['entries', 'analysis']
const VIEW_LABELS: Record<View, string> = { entries: 'Entries', analysis: 'Cost Analysis' }

function fmtAmount(amount: string) {
  return parseFloat(amount).toLocaleString('en-US', { minimumFractionDigits: 2 })
}

function fmtBalance(balance: string) {
  const n = parseFloat(balance)
  return (n < 0 ? '–$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2 })
}

export function Ledger() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const [view, setView] = useUrlState<View>('view', 'entries', VIEWS)
  const [lessees, setLessees]           = useState<PartnershipMember[]>([])
  const [selectedLesseeId, setLesseeId] = useState<string>('')
  const [entries, setEntries]           = useState<LedgerEntry[]>([])
  const [recurring, setRecurring]       = useState<RecurringCharge[]>([])
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState('')
  const [posting, setPosting]           = useState<string | null>(null)

  // Load all members; default selection to logged-in user
  useEffect(() => {
    api.get<PartnershipMember[]>('/ledger/lessees')
      .then(ls => {
        setLessees(ls)
        // The person being viewed lives in the URL so it survives opening an entry and coming back.
        const wanted = ls.find(l => l.id === searchParams.get('lessee_id'))
        const self = ls.find(l => l.id === user?.id)
        setLesseeId(wanted?.id ?? self?.id ?? ls[0]?.id ?? '')
      })
      .catch(() => {})
  }, [user?.id])

  function loadEntries(lesseeId?: string) {
    setLoading(true)
    setError('')
    const param = lesseeId ? `?lessee_id=${lesseeId}` : ''
    Promise.all([
      api.get<LedgerEntry[]>(`/ledger${param}`),
      api.get<RecurringCharge[]>(`/ledger/recurring${param}`),
    ])
      .then(([e, r]) => { setEntries(e); setRecurring(r) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (selectedLesseeId) {
      loadEntries(selectedLesseeId)
    }
  }, [selectedLesseeId])

  async function handlePost(chargeId: string, _lesseeId: string) {
    setPosting(chargeId)
    try {
      await api.post(`/ledger/recurring/${chargeId}/post`, {})
      loadEntries(selectedLesseeId || undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post')
    } finally {
      setPosting(null)
    }
  }

  // The owner's ledger tracks operating costs: show total expenses (positive) rather than a balance.
  const isExpenses = lessees.find(l => l.id === selectedLesseeId)?.role === 'owner'
  const sign = isExpenses ? -1 : 1
  const shown = (v: string) => String(sign * parseFloat(v))
  const balance = sign * parseFloat(entries[0]?.running_balance ?? '0')
  const balanceColor = isExpenses ? 'text-foreground' : balance >= 0 ? 'text-emerald-600' : 'text-destructive'
  const newEntryUrl = selectedLesseeId
    ? `/ledger/new?lessee_id=${selectedLesseeId}`
    : '/ledger/new'

  return (
    <div className="flex flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b bg-background">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">Ledger</h1>
            <button
              type="button"
              onClick={() => navigate('/invoices')}
              className="flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
              title="Maintenance invoices"
            >
              <FileText className="h-3.5 w-3.5" /> Invoices
            </button>
        </div>
        <div className="flex items-center gap-2">
          {view === 'entries' && <>
          <button
            onClick={() => { window.location.href = '/api/export/ledger.csv' }}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
            title="Download CSV"
          >
            <Download className="h-4 w-4" />
          </button>
          <button
            onClick={() => navigate('/ledger/recurring')}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
            title="Manage recurring charges"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          </>}
          <Button size="sm" onClick={() => navigate(newEntryUrl)}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
      </div>
        <div className="flex overflow-x-auto px-4">
          {VIEWS.map(v => (
            <button key={v} onClick={() => setView(v)}
              className={cn('shrink-0 whitespace-nowrap pb-2 pr-4 text-sm font-medium transition-colors border-b-2 -mb-px',
                view === v ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
      </div>

      {view === 'analysis' && <CostAnalysis />}

      {view === 'entries' && <div className="space-y-4 p-4">
        {/* Lessee switcher */}
        {lessees.length > 1 && (
          <div className="flex gap-2">
            {lessees.map(l => (
              <button
                key={l.id}
                onClick={() => { setLesseeId(l.id); setSearchParams({ lessee_id: l.id }, { replace: true }) }}
                className={cn(
                  'rounded-full border px-4 py-1.5 text-sm transition-colors',
                  selectedLesseeId === l.id
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border text-muted-foreground hover:text-foreground'
                )}
              >
                {l.name}
              </button>
            ))}
          </div>
        )}

        {/* Balance card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <DollarSign className="h-3.5 w-3.5" /> {isExpenses ? 'Total expenses' : 'Balance'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : (
              <>
                <p className={cn('text-3xl font-bold tabular-nums', balanceColor)}>
                  {fmtBalance(shown(entries[0]?.running_balance ?? '0'))}
                </p>
                {entries[0] && (
                  <p className="mt-1 text-xs text-muted-foreground">as of {entries[0].effective_date}</p>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* Upcoming recurring charges */}
        {recurring.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Upcoming</p>
            {recurring.map(r => (
              <div
                key={r.id}
                className="flex cursor-pointer items-center gap-3 rounded-lg border bg-muted/30 p-3 hover:bg-accent/40"
                onClick={() => navigate(`/ledger/recurring?lessee_id=${r.lessee_id}&edit=${r.id}`)}
                title="Edit or delete this recurring charge"
              >
                <div className="flex w-10 shrink-0 flex-col items-center rounded-md bg-muted py-1 text-center">
                  <span className="text-[10px] uppercase text-muted-foreground">
                    {new Date(r.next_due_date + 'T12:00').toLocaleDateString('en-US', { month: 'short' })}
                  </span>
                  <span className="text-lg font-bold leading-none">
                    {new Date(r.next_due_date + 'T12:00').getDate()}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.description_template}</p>
                  <p className={cn('text-xs font-semibold tabular-nums', r.direction === 'credit' ? 'text-emerald-600' : 'text-destructive')}>
                    {r.direction === 'credit' ? '+' : '–'}${fmtAmount(r.amount)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={posting === r.id}
                  onClick={evt => { evt.stopPropagation(); handlePost(r.id, r.lessee_id) }}
                >
                  {posting === r.id ? '…' : 'Post'}
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Entry list */}
        {!loading && entries.length === 0 && (
          <div className="flex flex-col items-center gap-3 py-14 text-center">
            <DollarSign className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No ledger entries yet</p>
            <Button size="sm" onClick={() => navigate(newEntryUrl)}>Add first entry</Button>
          </div>
        )}

        <div className="space-y-2">
          {entries.map(e => (
            <div
              key={e.id}
              className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent/40 active:bg-accent/60"
              onClick={() => navigate(`/ledger/${e.id}/edit`)}
            >
              {/* Date chip */}
              <div className="flex w-10 shrink-0 flex-col items-center rounded-md bg-muted py-1 text-center">
                <span className="text-[10px] uppercase text-muted-foreground">
                  {new Date(e.effective_date + 'T12:00').toLocaleDateString('en-US', { month: 'short' })}
                </span>
                <span className="text-lg font-bold leading-none">
                  {new Date(e.effective_date + 'T12:00').getDate()}
                </span>
              </div>

              {/* Description + type */}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{e.description}</p>
                <p className="text-xs capitalize text-muted-foreground">
                  {TYPE_CONFIG[e.entry_type]?.label ?? e.entry_type.replace(/_/g, ' ')}
                  {e.invoices?.map(inv => (
                    <span key={inv.id}>
                      {' · '}
                      <a
                        href={`/invoices/${inv.id}`}
                        onClick={evt => { evt.preventDefault(); evt.stopPropagation(); navigate(`/invoices/${inv.id}`) }}
                        className="normal-case text-primary hover:underline"
                      >
                        Invoice {inv.invoice_number}
                      </a>
                      {' '}
                      <a
                        href={`/api/invoices/${inv.id}/file`} target="_blank" rel="noreferrer"
                        onClick={evt => evt.stopPropagation()}
                        className="normal-case text-primary hover:underline"
                      >
                        (Original)
                      </a>
                    </span>
                  ))}
                  {e.documents?.map(d => (
                    <span key={d.id}>
                      {' · '}
                      <a
                        href={`/api/documents/${d.id}/file`} target="_blank" rel="noreferrer"
                        onClick={evt => evt.stopPropagation()}
                        title={d.title}
                        className="normal-case text-primary hover:underline"
                      >
                        {d.title.length > 32 ? d.title.slice(0, 30) + '…' : d.title}
                      </a>
                    </span>
                  ))}
                </p>
              </div>

              {/* Amount + running balance */}
              <div className="shrink-0 text-right">
                <p className={cn(
                  'text-sm font-semibold tabular-nums',
                  e.direction === 'credit' ? 'text-emerald-600' : 'text-destructive'
                )}>
                  {e.direction === 'credit' ? '+' : '–'}${fmtAmount(e.amount)}
                </p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {fmtBalance(shown(e.running_balance))}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>}
    </div>
  )
}
