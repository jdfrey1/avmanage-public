import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface ManualEntry {
  id: string
  event_date: string
  landings_day: number
  landings_night: number
  approaches: number
  holds_accomplished: boolean
  notes: string | null
}

const today = () => new Date().toLocaleDateString('en-CA')

// Landings and approaches flown since the last ForeFlight import, entered by hand. They count
// toward day/night/IFR currency until the next import covers their dates, then they're cleared.
export function CurrencyEntries({ onChange }: { onChange?: () => void }) {
  const [entries, setEntries] = useState<ManualEntry[]>([])
  const [importEmail, setImportEmail] = useState<string | null>(null)
  const [date, setDate] = useState(today())
  const [day, setDay] = useState('')
  const [night, setNight] = useState('')
  const [appr, setAppr] = useState('')
  const [holds, setHolds] = useState(false)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function load() {
    api.get<{ entries: ManualEntry[]; import_email: string | null }>('/currency/manual')
      .then(r => { setEntries(r.entries); setImportEmail(r.import_email) })
      .catch(() => {})
  }
  useEffect(load, [])

  async function add() {
    setSaving(true); setError('')
    try {
      await api.post('/currency/manual', {
        event_date: date, landings_day: day, landings_night: night, approaches: appr, holds, notes,
      })
      setDay(''); setNight(''); setAppr(''); setHolds(false); setNotes(''); setDate(today())
      load(); onChange?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally { setSaving(false) }
  }

  async function remove(id: string) {
    try { await api.delete(`/currency/manual/${id}`); load(); onChange?.() }
    catch { setError('Could not delete') }
  }

  const fmt = (d: string) => new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const summary = (e: ManualEntry) => [
    e.landings_day && `${e.landings_day} day ldg`,
    e.landings_night && `${e.landings_night} night ldg`,
    e.approaches && `${e.approaches} appr`,
    e.holds_accomplished && 'hold',
  ].filter(Boolean).join(' · ')

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Add landings and approaches flown since your last ForeFlight import. They count toward currency
        until the next import includes those dates, then they're removed automatically.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="col-span-2 space-y-1 sm:col-span-4">
          <Label>Date</Label>
          <Input type="date" value={date} max={today()} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Day landings</Label>
          <Input type="number" inputMode="numeric" min={0} value={day} onChange={e => setDay(e.target.value)} placeholder="0" />
        </div>
        <div className="space-y-1">
          <Label>Night landings</Label>
          <Input type="number" inputMode="numeric" min={0} value={night} onChange={e => setNight(e.target.value)} placeholder="0" />
        </div>
        <div className="space-y-1">
          <Label>Approaches</Label>
          <Input type="number" inputMode="numeric" min={0} value={appr} onChange={e => setAppr(e.target.value)} placeholder="0" />
        </div>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <input type="checkbox" checked={holds} onChange={e => setHolds(e.target.checked)} className="h-4 w-4" />
          Holding
        </label>
        <div className="col-span-2 space-y-1 sm:col-span-4">
          <Label>Note (optional)</Label>
          <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. pattern work" />
        </div>
      </div>
      <Button size="sm" variant="outline" disabled={saving || !date} onClick={add}>
        {saving ? 'Saving…' : 'Add entry'}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}

      {entries.length > 0 && (
        <ul className="divide-y rounded-md border text-sm">
          {entries.map(e => (
            <li key={e.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{fmt(e.event_date)} <span className="font-normal text-muted-foreground">· {summary(e)}</span></p>
                {e.notes && <p className="truncate text-xs text-muted-foreground">{e.notes}</p>}
              </div>
              <button type="button" onClick={() => remove(e.id)} title="Delete" className="text-muted-foreground hover:text-destructive">
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {importEmail && (
        <p className="text-xs text-muted-foreground">
          Tip: forward your monthly “Logbook Auto-Export” email from ForeFlight to <span className="font-medium text-foreground">{importEmail}</span> and
          it's imported automatically within the hour. Forward it from the email address on your avManage account.
        </p>
      )}
    </div>
  )
}
