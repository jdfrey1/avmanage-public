import { useEffect, useRef, useState } from 'react'
import { Select } from '@/components/ui/select'
import cronstrue from 'cronstrue'
import { backupApi, type BackupFile, type BackupSettings, type BackupVerifyResult } from '@/lib/api'
import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

const PRESETS = [
  { label: 'Daily 3 AM', cron: '0 3 * * *' },
  { label: 'Weekly (Sun)', cron: '0 3 * * 0' },
  { label: 'Monthly (1st)', cron: '0 3 1 * *' },
]

const MAX_OPTIONS = [1, 2, 3, 5, 10, 15, 20, 30]

function cronDescription(expr: string): string {
  try { return cronstrue.toString(expr, { verbose: false }) } catch { return 'Invalid cron expression' }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function BackupIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
    </svg>
  )
}

export function BackupPage() {
  const [backups, setBackups] = useState<BackupFile[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [settings, setSettings] = useState<BackupSettings>({ enabled: false, cron: '0 3 * * 0', maxBackups: 5 })
  const [cronInput, setCronInput] = useState('0 3 * * 0')
  const [creating, setCreating] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreMsg, setRestoreMsg] = useState('')
  const [error, setError] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<{ filename: string; result: BackupVerifyResult } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    load()
    backupApi.getSettings().then(s => {
      setSettings(s)
      setCronInput(s.cron)
    }).catch(() => {})
  }, [])

  async function load() {
    try {
      const list = await backupApi.list()
      setBackups(list)
      setSelectedIdx(0)
    } catch { setError('Failed to load backups') }
  }

  async function handleCreate() {
    setCreating(true)
    setError('')
    try {
      await backupApi.create()
      await load()
    } catch (e: any) { setError(e.message ?? 'Backup failed') }
    finally { setCreating(false) }
  }

  async function handleDelete() {
    const b = backups[selectedIdx]
    if (!b) return
    if (!confirm(`Delete ${b.filename}?`)) return
    try {
      await backupApi.delete(b.filename)
      await load()
    } catch (e: any) { setError(e.message ?? 'Delete failed') }
  }

  async function handleProtect() {
    const b = backups[selectedIdx]
    if (!b) return
    try {
      const res = await backupApi.toggleProtect(b.filename)
      setBackups(prev => prev.map((x, i) => i === selectedIdx ? { ...x, protected: res.protected } : x))
    } catch (e: any) { setError(e.message ?? 'Failed') }
  }

  async function handleVerify() {
    const b = backups[selectedIdx]
    if (!b) return
    setVerifying(true)
    setVerifyResult(null)
    setError('')
    try {
      setVerifyResult({ filename: b.filename, result: await backupApi.verify(b.filename) })
    } catch (e: any) { setError('Verify failed: ' + (e.message ?? 'Unknown error')) }
    finally { setVerifying(false) }
  }

  function handleDownload() {
    const b = backups[selectedIdx]
    if (b) backupApi.download(b.filename)
  }

  async function handleSaveSettings() {
    setSettingsSaving(true)
    setError('')
    try {
      const saved = await backupApi.saveSettings({ ...settings, cron: cronInput })
      setSettings(saved)
      setCronInput(saved.cron)
      setSettingsSaved(true)
      setTimeout(() => setSettingsSaved(false), 2000)
    } catch (e: any) { setError(e.message ?? 'Save failed') }
    finally { setSettingsSaving(false) }
  }

  async function handleRestoreFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!fileInputRef.current) fileInputRef.current = e.target
    if (!file) return
    if (!confirm('Restore this backup? ALL current data will be replaced. A pre-restore snapshot will be created first.')) {
      e.target.value = ''
      return
    }
    setRestoring(true)
    setRestoreMsg('')
    setError('')
    try {
      const res = await backupApi.restore(file)
      setRestoreMsg(`Restored. Pre-restore snapshot: ${res.preRestoreBackup}`)
      await load()
    } catch (e: any) {
      setError('Restore failed: ' + (e.message ?? 'Unknown error'))
    } finally {
      setRestoring(false)
      e.target.value = ''
    }
  }

  function applyPreset(cron: string) {
    setCronInput(cron)
  }

  const selected = backups[selectedIdx]

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-base font-semibold">
          <BackupIcon />
          Backup &amp; Restore
        </div>
        <Button size="sm" onClick={handleCreate} disabled={creating}>
          {creating ? 'Creating…' : '+ Create Backup'}
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Scheduled Backups */}
      <section className="space-y-4 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Scheduled Backups</h2>

        {/* Enable toggle */}
        <label className="flex items-start gap-3 cursor-pointer">
          <button
            role="switch"
            aria-checked={settings.enabled}
            onClick={() => setSettings(s => ({ ...s, enabled: !s.enabled }))}
            className={cn(
              'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors',
              settings.enabled ? 'bg-primary' : 'bg-muted'
            )}
          >
            <span className={cn(
              'absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
              settings.enabled ? 'translate-x-5' : 'translate-x-0'
            )} />
          </button>
          <div>
            <p className="text-sm font-medium leading-tight">Enable Scheduled Backups</p>
            <p className="text-xs text-muted-foreground">Automatically create backups according to the schedule</p>
          </div>
        </label>

        {/* Presets */}
        <div>
          <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Schedule</p>
          <div className="flex gap-2 flex-wrap">
            {PRESETS.map(p => (
              <button
                key={p.cron}
                onClick={() => applyPreset(p.cron)}
                className={cn(
                  'rounded border px-3 py-1.5 text-sm transition-colors',
                  cronInput === p.cron
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-foreground hover:border-primary/50'
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Cron + max backups row */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Input
              value={cronInput}
              onChange={e => setCronInput(e.target.value)}
              className="font-mono text-sm"
              placeholder="cron expression"
            />
            <p className="text-xs text-muted-foreground">{cronDescription(cronInput)}</p>
          </div>
          <div className="space-y-1">
            <Select
              value={settings.maxBackups}
              onChange={e => setSettings(s => ({ ...s, maxBackups: parseInt(e.target.value) }))}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {MAX_OPTIONS.map(n => (
                <option key={n} value={n}>{n} backup{n !== 1 ? 's' : ''}</option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">Max backups to keep (oldest deleted when exceeded)</p>
          </div>
        </div>

        <Button size="sm" variant="outline" onClick={handleSaveSettings} disabled={settingsSaving}>
          {settingsSaved ? 'Saved' : settingsSaving ? 'Saving…' : '💾 Save Settings'}
        </Button>
      </section>

      {/* Backup Files */}
      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Backup Files</h2>

        {backups.length === 0 ? (
          <p className="text-sm text-muted-foreground">No backups found.</p>
        ) : (
          <div className="space-y-2">
            {/* Dropdown */}
            <Select
              value={selectedIdx}
              onChange={e => setSelectedIdx(parseInt(e.target.value))}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {backups.map((b, i) => (
                <option key={b.filename} value={i}>
                  {b.filename} · {b.size_label} · {formatDate(b.created_at)}
                </option>
              ))}
            </Select>

            {/* Meta row + action icons */}
            {selected && (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className={cn(
                    'rounded px-1.5 py-0.5 text-xs font-medium',
                    selected.type === 'scheduled'
                      ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                      : selected.type === 'auto'
                      ? 'bg-violet-500/15 text-violet-600 dark:text-violet-400'
                      : 'bg-green-500/15 text-green-700 dark:text-green-400'
                  )}>
                    {selected.type}
                  </span>
                  <span>{backups.length} backup{backups.length !== 1 ? 's' : ''} total</span>
                </div>

                <div className="flex items-center gap-1">
                  {/* Download */}
                  <button
                    onClick={handleDownload}
                    title="Download"
                    className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                    </svg>
                  </button>

                  {/* Verify */}
                  <button
                    onClick={handleVerify}
                    title="Verify this backup (test restore into a scratch database)"
                    disabled={verifying}
                    className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-40"
                  >
                    <ShieldCheck className="w-4 h-4" />
                  </button>

                  {/* Restore this */}
                  <button
                    onClick={() => {
                      // Trigger restore from server-side for a known backup
                      if (confirm(`Restore from ${selected.filename}?\n\nALL current data will be replaced. A pre-restore snapshot will be created first.`)) {
                        setRestoring(true)
                        setRestoreMsg('')
                        setError('')
                        fetch(`/api/backup/restore-file`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          credentials: 'include',
                          body: JSON.stringify({ filename: selected.filename }),
                        })
                          .then(r => r.json())
                          .then(async r => {
                            if (r.error) throw new Error(r.error)
                            setRestoreMsg(`Restored. Pre-restore snapshot: ${r.preRestoreBackup}`)
                            await load()
                          })
                          .catch(e => setError('Restore failed: ' + e.message))
                          .finally(() => setRestoring(false))
                      }
                    }}
                    title="Restore this backup"
                    disabled={restoring}
                    className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-40"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 7.5m0 0L7.5 12M12 7.5V21" />
                    </svg>
                  </button>

                  {/* Protect */}
                  <button
                    onClick={handleProtect}
                    title={selected.protected ? 'Remove protection' : 'Protect this backup'}
                    className={cn(
                      'rounded p-2 transition-colors',
                      selected.protected
                        ? 'text-amber-500 hover:bg-amber-500/10'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    <svg className="w-4 h-4" fill={selected.protected ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                    </svg>
                  </button>

                  {/* Delete */}
                  <button
                    onClick={handleDelete}
                    title="Delete"
                    disabled={selected.protected}
                    className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-30"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
                  </button>
                </div>
              </div>
            )}
            {verifying && <p className="mt-2 text-xs text-muted-foreground">Verifying — restoring into a scratch database…</p>}
            {verifyResult && selected && verifyResult.filename === selected.filename && (
              <div className={cn('mt-2 rounded-md border p-2 text-xs', verifyResult.result.ok ? 'border-green-500/40 bg-green-500/10' : 'border-destructive/40 bg-destructive/10')}>
                <p className="font-medium">{verifyResult.result.ok ? '✓ Backup verified' : '✗ Verification failed'}</p>
                {verifyResult.result.steps.map(st => <p key={st} className="text-muted-foreground">✓ {st}</p>)}
                {verifyResult.result.error && <p className="text-destructive">{verifyResult.result.error}</p>}
                {verifyResult.result.rows && (
                  <p className="mt-1 text-muted-foreground">
                    {verifyResult.result.tables} tables ·{' '}
                    {Object.entries(verifyResult.result.rows).filter(([, n]) => n > 0).map(([t, n]) => `${t.replace(/_/g, ' ')}: ${n}`).join(' · ')}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Restore from File */}
      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">Restore from File</h2>
        <p className="text-sm text-muted-foreground">
          Upload a <code className="text-xs bg-muted px-1 py-0.5 rounded">.sql.gz</code> backup file to restore. A pre-restore backup will be created first.
        </p>
        {restoreMsg && (
          <p className="text-sm text-green-600 dark:text-green-400">{restoreMsg}</p>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".gz,.sql.gz"
          className="hidden"
          onChange={handleRestoreFile}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={restoring}
        >
          <svg className="mr-2 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 7.5m0 0L7.5 12M12 7.5V21" />
          </svg>
          {restoring ? 'Restoring…' : 'Upload & Restore'}
        </Button>
      </section>

      {/* Warning */}
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 space-y-1">
        <p className="text-sm font-medium text-amber-600 dark:text-amber-400">Important</p>
        <p className="text-xs text-amber-600/80 dark:text-amber-400/70">
          Restoring a backup will replace ALL current data. Protected backups (🔒) are excluded from automatic rotation.
        </p>
      </div>
    </div>
  )
}
