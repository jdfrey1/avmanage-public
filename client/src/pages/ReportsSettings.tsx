import { useEffect, useState } from 'react'
import cronstrue from 'cronstrue'
import { reportsApi, type ReportSettings } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const MONTHLY_PRESETS = [
  { label: '1st of month, 8 AM', cron: '0 8 1 * *' },
  { label: '1st of month, 6 PM', cron: '0 18 1 * *' },
]

const DEFAULTS: ReportSettings = {
  monthlyEnabled: false,
  monthlyCron: '0 8 1 * *',
  currencyCheckEnabled: false,
  currencyCheckCron: '0 8 * * *',
}

function cronDescription(expr: string): string {
  try { return cronstrue.toString(expr, { verbose: false }) } catch { return 'Invalid cron expression' }
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: () => void; label: string; hint: string }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <button
        role="switch"
        aria-checked={checked}
        onClick={onChange}
        className={cn(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-muted'
        )}
      >
        <span className={cn(
          'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0'
        )} />
      </button>
      <div>
        <p className="text-sm font-medium leading-tight">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </label>
  )
}

export function ReportsSettings() {
  const [settings, setSettings] = useState<ReportSettings>(DEFAULTS)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendMsg, setSendMsg] = useState('')
  const [error, setError] = useState('')
  const [testRecipient, setTestRecipient] = useState('')

  const [myAlertsEnabled, setMyAlertsEnabled] = useState(true)
  const [myAlertsSaving, setMyAlertsSaving] = useState(false)
  const [currencyTestRecipient, setCurrencyTestRecipient] = useState('')
  const [currencyTestSending, setCurrencyTestSending] = useState(false)
  const [currencyTestMsg, setCurrencyTestMsg] = useState('')

  useEffect(() => {
    reportsApi.getSettings().then(setSettings).catch(() => {})
    reportsApi.getCurrencyAlertPref().then(p => setMyAlertsEnabled(p.enabled)).catch(() => {})
  }, [])

  async function handleToggleMyAlerts() {
    const next = !myAlertsEnabled
    setMyAlertsEnabled(next)
    setMyAlertsSaving(true)
    try { await reportsApi.saveCurrencyAlertPref(next) }
    catch (e: any) { setMyAlertsEnabled(!next); setError(e.message ?? 'Failed to save preference') }
    finally { setMyAlertsSaving(false) }
  }

  async function handleSendCurrencyTest() {
    setCurrencyTestSending(true)
    setCurrencyTestMsg('')
    setError('')
    try {
      await reportsApi.sendCurrencyTest(currencyTestRecipient.trim() || undefined)
      setCurrencyTestMsg(currencyTestRecipient.trim() ? `Sent to ${currencyTestRecipient.trim()}.` : 'Sent to your email.')
    } catch (e: any) { setError(e.message ?? 'Failed to send test alert') }
    finally { setCurrencyTestSending(false) }
  }

  async function handleSave() {
    setSaving(true)
    setError('')
    try {
      const saved = await reportsApi.saveSettings(settings)
      setSettings(saved)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: any) { setError(e.message ?? 'Save failed') }
    finally { setSaving(false) }
  }

  async function handleSendTest() {
    setSending(true)
    setSendMsg('')
    setError('')
    try {
      await reportsApi.sendTest(testRecipient.trim() || undefined)
      setSendMsg(testRecipient.trim() ? `Sent to ${testRecipient.trim()}.` : 'Sent to the whole partnership.')
    } catch (e: any) { setError(e.message ?? 'Failed to send report') }
    finally { setSending(false) }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Reports &amp; Alerts
      </p>
      <p className="text-xs text-muted-foreground">
        Email currency, hours, maintenance costs, upcoming maintenance, open squawks, and ledger
        balance to everyone on the partnership — sent from the shared Google account.
      </p>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <Toggle
        checked={settings.monthlyEnabled}
        onChange={() => setSettings(s => ({ ...s, monthlyEnabled: !s.monthlyEnabled }))}
        label="Monthly Summary Report"
        hint="Currency, hours, maintenance costs, upcoming maintenance, open squawks, ledger balance"
      />
      <div className="pl-14 space-y-2">
        <div className="flex gap-2 flex-wrap">
          {MONTHLY_PRESETS.map(p => (
            <button
              key={p.cron}
              onClick={() => setSettings(s => ({ ...s, monthlyCron: p.cron }))}
              className={cn(
                'rounded border px-3 py-1.5 text-sm transition-colors',
                settings.monthlyCron === p.cron
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-foreground hover:border-primary/50'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <Input
          value={settings.monthlyCron}
          onChange={e => setSettings(s => ({ ...s, monthlyCron: e.target.value }))}
          className="font-mono text-sm max-w-xs"
        />
        <p className="text-xs text-muted-foreground">{cronDescription(settings.monthlyCron)}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={testRecipient}
            onChange={e => setTestRecipient(e.target.value)}
            placeholder="Preview to (optional, defaults to whole partnership)"
            className="text-sm max-w-xs"
          />
          <Button size="sm" variant="outline" onClick={handleSendTest} disabled={sending}>
            {sending ? 'Sending…' : 'Send Test Report Now'}
          </Button>
        </div>
        {sendMsg && <p className="text-xs text-emerald-600 dark:text-emerald-400">{sendMsg}</p>}
      </div>

      <Toggle
        checked={settings.currencyCheckEnabled}
        onChange={() => setSettings(s => ({ ...s, currencyCheckEnabled: !s.currencyCheckEnabled }))}
        label="Currency Expiration Alerts"
        hint="Checks daily; each person is only emailed about their own currency, and only if they've opted in below"
      />
      <div className="pl-14 space-y-2">
        <Input
          value={settings.currencyCheckCron}
          onChange={e => setSettings(s => ({ ...s, currencyCheckCron: e.target.value }))}
          className="font-mono text-sm max-w-xs"
        />
        <p className="text-xs text-muted-foreground">{cronDescription(settings.currencyCheckCron)} (check frequency)</p>
      </div>

      <Button size="sm" variant="outline" onClick={handleSave} disabled={saving}>
        {saved ? 'Saved' : saving ? 'Saving…' : '💾 Save Settings'}
      </Button>

      <div className="border-t pt-4 space-y-3">
        <Toggle
          checked={myAlertsEnabled}
          onChange={handleToggleMyAlerts}
          label="Notify Me About My Own Currency"
          hint="7 days and 1 day before your IFR, landing, medical, or BFR currency lapses — only visible to you"
        />
        {myAlertsSaving && <p className="pl-14 text-xs text-muted-foreground">Saving…</p>}
        <div className="pl-14 flex flex-wrap items-center gap-2">
          <Input
            value={currencyTestRecipient}
            onChange={e => setCurrencyTestRecipient(e.target.value)}
            placeholder="Preview to (optional, defaults to you)"
            className="text-sm max-w-xs"
          />
          <Button size="sm" variant="outline" onClick={handleSendCurrencyTest} disabled={currencyTestSending}>
            {currencyTestSending ? 'Sending…' : 'Send Test Alert'}
          </Button>
        </div>
        {currencyTestMsg && <p className="pl-14 text-xs text-emerald-600 dark:text-emerald-400">{currencyTestMsg}</p>}
      </div>
    </div>
  )
}
