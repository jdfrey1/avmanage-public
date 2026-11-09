import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Modal } from '@/components/Modal'
import { Toggle } from '@/pages/ReportsSettings'
import { cn } from '@/lib/utils'

type Frequency = 'daily' | 'weekly' | 'changes'
interface Prefs {
  enabled: boolean
  frequency: Frequency
  send_time: string
  weekday: number
  sections: string[]
  lookahead_days: number
  my_schedule_only: boolean
  skip_empty: boolean
  last_sent_at: string | null
  email: string | null
  google_connected: boolean
  available_sections: { id: string; label: string }[]
}

const SECTION_HELP: Record<string, string> = {
  schedule: 'Reservations, maintenance and unavailable blocks coming up',
  squawks: 'Everything not yet resolved',
  insights: 'Open findings from the Garmin data logs',
  maintenance: 'Inspections and hour-based items overdue or coming due',
  currency: 'Your IFR, landing, medical and flight review status',
  hours: 'Your allotment used and account balance',
  flights: 'Flights logged since the last update',
}
const FREQS: { id: Frequency; label: string; help: string }[] = [
  { id: 'daily', label: 'Daily', help: 'Every day at the time below.' },
  { id: 'weekly', label: 'Weekly', help: 'Once a week on the day and time below.' },
  { id: 'changes', label: 'Only when something changes', help: 'Checked daily at the time below; sent only if something is new or was cleared since the last email (a new or changed reservation, squawk, insight, inspection coming due, currency about to lapse…).' },
]
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const LOOKAHEAD = [1, 2, 3, 7, 14, 30]

// Per-member email update settings (Settings → Email updates).
export function NotificationSettings() {
  const [p, setP] = useState<Prefs | null>(null)
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'preview'>('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null)

  useEffect(() => {
    api.get<Prefs>('/notifications').then(r => { setP(r); setSaved(JSON.stringify(body(r))) }).catch(() => setMsg({ ok: false, text: 'Could not load settings' }))
  }, [])

  if (!p) return <p className="text-sm text-muted-foreground">Loading…</p>
  const set = (patch: Partial<Prefs>) => { setP({ ...p, ...patch }); setMsg(null) }
  const dirty = JSON.stringify(body(p)) !== saved
  const toggleSection = (id: string) =>
    set({ sections: p.sections.includes(id) ? p.sections.filter(s => s !== id) : [...p.sections, id] })

  async function save() {
    setBusy('save'); setMsg(null)
    try {
      const r = await api.post<Prefs>('/notifications', body(p!))
      setP(r); setSaved(JSON.stringify(body(r)))
      setMsg({ ok: true, text: r.enabled ? `Saved. ${scheduleText(r)}` : 'Saved. Email updates are off.' })
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'Could not save' })
    } finally { setBusy('') }
  }
  async function test() {
    setBusy('test'); setMsg(null)
    try {
      await api.post('/notifications/test', body(p!))
      setMsg({ ok: true, text: `Sent to ${p!.email}. It may take a minute to arrive.` })
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : 'Could not send' })
    } finally { setBusy('') }
  }
  async function showPreview() {
    setBusy('preview'); setMsg(null)
    try { setPreview(await api.post<{ subject: string; html: string }>('/notifications/preview', body(p!))) }
    catch (err) { setMsg({ ok: false, text: err instanceof Error ? err.message : 'Could not build preview' }) }
    finally { setBusy('') }
  }

  return (
    <div className="space-y-5">
      <Toggle checked={p.enabled} onChange={() => set({ enabled: !p.enabled })} label="Email me updates"
        hint={`Sent to ${p.email || 'your account email'} from the aircraft’s Google account.${p.last_sent_at ? ` Last sent ${new Date(p.last_sent_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : ''}`} />
      {!p.google_connected && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          Google isn’t connected, so no email can be sent until an admin connects it under Application.
        </p>
      )}

      <div className={cn('space-y-5', !p.enabled && 'opacity-60')}>
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">How often</p>
          <div className="flex flex-wrap gap-2">
            {FREQS.map(f => (
              <button key={f.id} type="button" onClick={() => set({ frequency: f.id })}
                className={cn('rounded-full px-3 py-1 text-sm transition-colors', p.frequency === f.id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground')}>
                {f.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{FREQS.find(f => f.id === p.frequency)?.help}</p>
          <div className="flex flex-wrap items-end gap-3">
            {p.frequency === 'weekly' && (
              <div className="space-y-1">
                <Label>Day</Label>
                <Select value={p.weekday} onChange={e => set({ weekday: +e.target.value })} className="w-40 rounded-md border border-input bg-background px-3 py-2 text-sm">
                  {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <Label>{p.frequency === 'changes' ? 'Check at' : 'Time'}</Label>
              <Input type="time" step={300} value={p.send_time} onChange={e => set({ send_time: e.target.value })} className="w-36" />
            </div>
          </div>
          {p.frequency !== 'changes' && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={p.skip_empty} onChange={e => set({ skip_empty: e.target.checked })} />
              Skip the email when there’s nothing to report
            </label>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Include</p>
          <div className="divide-y rounded-md border">
            {p.available_sections.map(s => (
              <div key={s.id} className="px-3 py-2">
                <label className="flex items-start gap-3">
                  <input type="checkbox" className="mt-0.5 h-4 w-4" checked={p.sections.includes(s.id)} onChange={() => toggleSection(s.id)} />
                  <span className="text-sm">
                    {s.label}
                    <span className="block text-xs text-muted-foreground">{SECTION_HELP[s.id]}</span>
                  </span>
                </label>
                {s.id === 'schedule' && p.sections.includes('schedule') && (
                  <div className="ml-7 mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                    <span className="flex items-center gap-2">
                      Look ahead
                      <Select value={p.lookahead_days} onChange={e => set({ lookahead_days: +e.target.value })} className="w-28 rounded-md border border-input bg-background px-2 py-1 text-sm">
                        {LOOKAHEAD.map(n => <option key={n} value={n}>{n === 1 ? 'Today' : `${n} days`}</option>)}
                      </Select>
                    </span>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" className="h-4 w-4" checked={p.my_schedule_only} onChange={e => set({ my_schedule_only: e.target.checked })} />
                      Only my reservations
                    </label>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={busy !== '' || !dirty}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
        <Button size="sm" variant="outline" onClick={showPreview} disabled={busy !== '' || !p.sections.length}>{busy === 'preview' ? 'Building…' : 'Preview'}</Button>
        <Button size="sm" variant="outline" onClick={test} disabled={busy !== '' || !p.sections.length || !p.google_connected}>{busy === 'test' ? 'Sending…' : 'Send me one now'}</Button>
      </div>
      {msg && <p className={cn('text-xs', msg.ok ? 'text-emerald-600' : 'text-destructive')}>{msg.text}</p>}

      {preview && (
        <Modal title="Email preview" subtitle={preview.subject} onClose={() => setPreview(null)}>
          <iframe title="Email preview" srcDoc={preview.html} className="h-[70vh] w-full rounded-md border bg-white" sandbox="allow-popups allow-popups-to-escape-sandbox" />
        </Modal>
      )}
    </div>
  )
}

function body(p: Prefs) {
  const { enabled, frequency, send_time, weekday, sections, lookahead_days, my_schedule_only, skip_empty } = p
  return { enabled, frequency, send_time, weekday, sections: [...sections].sort(), lookahead_days, my_schedule_only, skip_empty }
}

function scheduleText(p: Prefs) {
  const t = new Date(`2000-01-01T${p.send_time}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (p.frequency === 'weekly') return `You’ll get it ${DAYS[p.weekday]}s at ${t}.`
  if (p.frequency === 'changes') return `Checked daily at ${t}; sent only when something changes.`
  return `You’ll get it every day at ${t}.`
}
