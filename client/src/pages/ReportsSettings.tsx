import { useEffect, useState } from 'react'
import cronstrue from 'cronstrue'
import { reportsApi, type ReportSettings } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/utils'

const DEFAULTS: ReportSettings = {
  monthlyEnabled: false,
  monthlyCron: '0 8 1 * *',
  currencyCheckEnabled: false,
  currencyCheckCron: '0 8 * * *',
}
const SELECT_CLS = 'rounded-md border border-input bg-background px-3 py-2 text-sm'

// The schedules are stored as cron expressions; the pickers cover the simple shapes
// ("minute hour day * *"). Anything else shows as custom.
const pad = (n: number) => String(n).padStart(2, '0')
function parseMonthly(expr: string) {
  const m = expr.trim().match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/)
  return m ? { day: +m[3], time: `${pad(+m[2])}:${pad(+m[1])}` } : null
}
const toCron = (time: string, day: number) => {
  const [h, m] = time.split(':').map(Number)
  return `${m} ${h} ${day} * *`
}
function describe(expr: string) {
  try { return cronstrue.toString(expr, { verbose: false }) } catch { return expr }
}
const ordinal = (n: number) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th')
const timeLabel = (t: string) => new Date(`2000-01-01T${t}`).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: () => void; label: string; hint: string; disabled?: boolean }) {
  return (
    <label className={cn('flex items-start gap-3', disabled ? 'cursor-default' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={onChange}
        disabled={disabled}
        className={cn('relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors', checked ? 'bg-primary' : 'bg-muted', disabled && 'opacity-60')}
      >
        <span className={cn('absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5' : 'translate-x-0')} />
      </button>
      <div>
        <p className="text-sm font-medium leading-tight">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </label>
  )
}

// Personal: the member's own opt-in for currency expiration warnings, and when to check.
export function MyCurrencyAlerts() {
  const [enabled, setEnabled] = useState(true)
  const [time, setTime] = useState('08:00')
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => { reportsApi.getCurrencyAlertPref().then(p => { setEnabled(p.enabled); setTime(p.time) }).catch(() => {}) }, [])

  async function save(nextEnabled: boolean, nextTime: string) {
    const prev = { enabled, time }
    setEnabled(nextEnabled); setTime(nextTime); setSaving(true); setMsg(null)
    try {
      const r = await reportsApi.saveCurrencyAlertPref(nextEnabled, nextTime)
      setTime(r.time)
      setMsg({ ok: true, text: r.enabled ? `Saved. Checked every day at ${timeLabel(r.time)}.` : 'Saved. Currency warnings are off.' })
    }
    catch (e: any) { setEnabled(prev.enabled); setTime(prev.time); setMsg({ ok: false, text: e.message ?? 'Could not save' }) }
    finally { setSaving(false) }
  }
  async function test() {
    setSending(true); setMsg(null)
    try { await reportsApi.sendCurrencyTest(); setMsg({ ok: true, text: 'Sent to your email.' }) }
    catch (e: any) { setMsg({ ok: false, text: e.message ?? 'Could not send' }) }
    finally { setSending(false) }
  }

  return (
    <div className="space-y-2">
      <Toggle checked={enabled} onChange={() => save(!enabled, time)} label="Warn me before my currency lapses"
        hint="A separate email 7 days and 1 day before your IFR, landing, medical or flight review currency runs out. Only you get it." />
      {enabled && (
        <div className="space-y-1 pl-14">
          <Label>Time</Label>
          <Input type="time" step={300} value={time} className="w-36"
            onChange={e => setTime(e.target.value)}
            onBlur={e => { if (e.target.value) save(true, e.target.value) }} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 pl-14">
        <Button size="sm" variant="outline" onClick={test} disabled={sending}>{sending ? 'Sending…' : 'Send me a sample'}</Button>
        {saving && <span className="text-xs text-muted-foreground">Saving…</span>}
      </div>
      {msg && <p className={cn('pl-14 text-xs', msg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>{msg.text}</p>}
    </div>
  )
}

// Partnership-wide: the monthly report (owner/admin edits; others see a summary).
export function ReportsSettings({ canEdit }: { canEdit: boolean }) {
  const [settings, setSettings] = useState<ReportSettings>(DEFAULTS)
  const [savedJson, setSavedJson] = useState(JSON.stringify(DEFAULTS))
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [testRecipient, setTestRecipient] = useState('')

  useEffect(() => {
    reportsApi.getSettings().then(s => { setSettings(s); setSavedJson(JSON.stringify(s)) }).catch(() => {})
  }, [])

  const monthly = parseMonthly(settings.monthlyCron)
  const dirty = JSON.stringify(settings) !== savedJson
  const set = (patch: Partial<ReportSettings>) => { setSettings(s => ({ ...s, ...patch })); setMsg(null) }

  async function save() {
    setSaving(true); setMsg(null)
    try {
      const s = await reportsApi.saveSettings(settings)
      setSettings(s); setSavedJson(JSON.stringify(s))
      setMsg({ ok: true, text: 'Saved.' })
    } catch (e: any) { setMsg({ ok: false, text: e.message ?? 'Save failed' }) }
    finally { setSaving(false) }
  }
  async function sendTest() {
    setSending(true); setMsg(null)
    try {
      await reportsApi.sendTest(testRecipient.trim() || undefined)
      setMsg({ ok: true, text: testRecipient.trim() ? `Sent to ${testRecipient.trim()}.` : 'Sent to everyone on the partnership.' })
    } catch (e: any) { setMsg({ ok: false, text: e.message ?? 'Failed to send report' }) }
    finally { setSending(false) }
  }

  const monthlyWhen = monthly ? `the ${ordinal(monthly.day)} of each month at ${timeLabel(monthly.time)}` : describe(settings.monthlyCron)

  if (!canEdit) {
    return (
      <ul className="space-y-1 text-sm">
        <li><span className="font-medium">Monthly report:</span> {settings.monthlyEnabled ? `sent to every member ${monthlyWhen}` : 'off'}</li>
        <li className="text-xs text-muted-foreground">The owner or an administrator can change these.</li>
      </ul>
    )
  }

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <Toggle checked={settings.monthlyEnabled} onChange={() => set({ monthlyEnabled: !settings.monthlyEnabled })}
          label="Monthly report"
          hint="A look back at last month, sent to every member (with a copy kept in the aircraft’s inbox): costs, each member’s currency, hours, flights and balance, maintenance and open squawks." />
        <div className="flex flex-wrap items-end gap-3 pl-14">
          <div className="space-y-1">
            <Label>Day of month</Label>
            <Select value={monthly?.day ?? 1} onChange={e => set({ monthlyCron: toCron(monthly?.time ?? '08:00', +e.target.value) })} className={cn(SELECT_CLS, 'w-28')}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{ordinal(d)}</option>)}
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Time</Label>
            <Input type="time" step={300} value={monthly?.time ?? '08:00'} onChange={e => e.target.value && set({ monthlyCron: toCron(e.target.value, monthly?.day ?? 1) })} className="w-36" />
          </div>
        </div>
        {!monthly && <p className="pl-14 text-xs text-muted-foreground">Currently a custom schedule ({describe(settings.monthlyCron)}); picking a day or time replaces it.</p>}
        <div className="flex flex-wrap items-center gap-2 pl-14">
          <Input value={testRecipient} onChange={e => setTestRecipient(e.target.value)} placeholder="Send to (blank = everyone)" className="max-w-xs text-sm" />
          <Button size="sm" variant="outline" onClick={sendTest} disabled={sending}>{sending ? 'Sending…' : 'Send report now'}</Button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</Button>
        {msg && <p className={cn('text-xs', msg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>{msg.text}</p>}
      </div>
    </div>
  )
}
