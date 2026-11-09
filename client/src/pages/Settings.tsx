import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, profileApi, type Partnership, type CurrencyStatus } from '@/lib/api'
import { BackupPage } from './BackupPage'
import { ReportsSettings, MyCurrencyAlerts } from './ReportsSettings'
import { MembersManager } from './MembersManager'
import { FlightAwareSettings } from './FlightAwareSettings'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { CurrencyEntries } from '@/components/CurrencyEntries'
import { NotificationSettings } from '@/components/NotificationSettings'

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={cn('w-4 h-4', className)} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  )
}

function AccordionSection({
  id, label, open, onToggle, children,
}: {
  id: string; label: string; open: boolean; onToggle: (id: string) => void; children: React.ReactNode
}) {
  return (
    <div className="border-b border-border last:border-0">
      <button
        type="button"
        onClick={() => onToggle(id)}
        className="flex w-full items-center justify-between px-4 py-4 text-left"
      >
        <span className="text-sm font-semibold">{label}</span>
        <ChevronDown className={cn('shrink-0 text-muted-foreground transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="space-y-4 pl-6 pr-4 pb-5">
          {children}
        </div>
      )}
    </div>
  )
}

export function Settings() {
  const navigate = useNavigate()
  const { user, refreshUser } = useAuth()
  const [partnership, setPartnership] = useState<Partnership | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // /settings?open=account opens that section (the Dashboard currency card links here)
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set<string>(new URLSearchParams(window.location.search).getAll('open').map(o => o === 'notifications' ? 'email' : o)))
  const toggleSection = (id: string) =>
    setOpenSections(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  // Aircraft
  const [tail, setTail]   = useState('')
  const [serial, setSerial] = useState('')
  const [desc, setDesc]   = useState('')
  const [insuranceDate, setInsuranceDate] = useState('')
  const [baseHobbs, setBaseHobbs]   = useState('')
  const [baseFlight, setBaseFlight] = useState('')
  const [aircraftSaving, setAircraftSaving] = useState(false)
  const [aircraftSaved, setAircraftSaved]   = useState(false)

  // Logbook
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importStatus, setImportStatus] = useState<'idle' | 'importing' | 'done' | 'error'>('idle')
  const [importMsg, setImportMsg]       = useState('')
  const [lastImport, setLastImport]     = useState<string | null>(null)
  const [lastImportFile, setLastImportFile] = useState<string | null>(null)

  // Medical
  const [medicalExpiry, setMedicalExpiry] = useState('')
  const [medicalSaving, setMedicalSaving] = useState(false)
  const [medicalSaved, setMedicalSaved]   = useState(false)

  // BFR
  const [bfrDate, setBfrDate]     = useState('')
  const [bfrSaving, setBfrSaving] = useState(false)
  const [bfrSaved, setBfrSaved]   = useState(false)

  // Account (name/email)
  const [accountName, setAccountName]     = useState('')
  const [accountEmail, setAccountEmail]   = useState('')
  const [accountSaving, setAccountSaving] = useState(false)
  const [accountSaved, setAccountSaved]   = useState(false)
  const [accountError, setAccountError]   = useState('')

  // Google Calendar sync
  const [googleCalendarStatus, setGoogleCalendarStatus] =
    useState<{ configured: boolean; connected: boolean; tokenValid: boolean | null; calendarUrl: string | null; driveUrl: string | null } | null>(null)
  const [googleCalendarNotice, setGoogleCalendarNotice] = useState<'connected' | 'error' | null>(null)
  const [googleCalendarDisconnecting, setGoogleCalendarDisconnecting] = useState(false)

  function loadGoogleCalendarStatus() {
    api.get<{ configured: boolean; connected: boolean; tokenValid: boolean | null; calendarUrl: string | null; driveUrl: string | null }>('/calendar/google/status')
      .then(setGoogleCalendarStatus)
      .catch(() => {})
  }

  async function disconnectGoogleCalendar() {
    setGoogleCalendarDisconnecting(true)
    try {
      await api.post('/calendar/google/disconnect', {})
      loadGoogleCalendarStatus()
    } catch {}
    finally { setGoogleCalendarDisconnecting(false) }
  }

  // Password modal
  const [pwdModalOpen, setPwdModalOpen] = useState(false)
  const [curPwd, setCurPwd]       = useState('')
  const [newPwd, setNewPwd]       = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [pwdSaving, setPwdSaving]   = useState(false)
  const [pwdMsg, setPwdMsg]         = useState('')
  const [pwdError, setPwdError]     = useState('')

  useEffect(() => {
    api.get<Partnership>('/partnership')
      .then(p => {
        setPartnership(p)
        setTail(p.aircraft_tail ?? '')
        setSerial(p.aircraft_serial ?? '')
        setDesc(p.aircraft_make_model ?? '')
        setInsuranceDate(p.insurance_expires_date ?? '')
        setBaseHobbs(p.baseline_hobbs != null ? p.baseline_hobbs.toFixed(1) : '')
        setBaseFlight(p.baseline_flight != null ? p.baseline_flight.toFixed(1) : '')
      })
      .catch(() => setError('Failed to load settings'))
      .finally(() => setLoading(false))

    api.get<CurrencyStatus>('/currency')
      .then(c => {
        setLastImport(c.lastImportAt)
        setLastImportFile(c.lastImportFile ?? null)
        setMedicalExpiry(c.medical?.expiresDate ?? '')
        setBfrDate(c.bfr?.accomplishedDate ?? '')
      })
      .catch(() => {})

    loadGoogleCalendarStatus()

    // Google redirects back here with ?google_calendar=connected|error after the OAuth flow
    const params = new URLSearchParams(window.location.search)
    const result = params.get('google_calendar')
    if (result === 'connected' || result === 'error') {
      setGoogleCalendarNotice(result)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  useEffect(() => {
    if (user) {
      setAccountName(user.name ?? '')
      setAccountEmail(user.email ?? '')
    }
  }, [user])

  function closePwdModal() {
    setPwdModalOpen(false)
    setCurPwd(''); setNewPwd(''); setConfirmPwd('')
    setPwdMsg(''); setPwdError('')
  }

  async function saveAircraft() {
    setAircraftSaving(true)
    setAircraftSaved(false)
    try {
      await api.patch('/partnership', {
        aircraft_tail: tail || null,
        aircraft_make_model: desc || null,
        aircraft_serial: serial || null,
        insurance_expires_date: insuranceDate || null,
        baseline_hobbs: baseHobbs || null,
        baseline_flight: baseFlight || null,
      })
      setAircraftSaved(true)
      setTimeout(() => setAircraftSaved(false), 2000)
    } catch {
      setError('Failed to save aircraft settings')
    } finally {
      setAircraftSaving(false)
    }
  }

  async function saveAccount() {
    setAccountSaving(true)
    setAccountSaved(false)
    setAccountError('')
    try {
      await profileApi.update({ name: accountName, email: accountEmail })
      await refreshUser()
      setAccountSaved(true)
      setTimeout(() => setAccountSaved(false), 2000)
    } catch (e: any) {
      setAccountError(e.message ?? 'Failed to save')
    } finally {
      setAccountSaving(false)
    }
  }

  async function savePassword() {
    setPwdError('')
    setPwdMsg('')
    if (newPwd !== confirmPwd) { setPwdError('Passwords do not match'); return }
    if (newPwd.length < 8) { setPwdError('Must be at least 8 characters'); return }
    setPwdSaving(true)
    try {
      await profileApi.update({ currentPassword: curPwd, newPassword: newPwd })
      setPwdMsg('Password updated!')
      setTimeout(() => closePwdModal(), 1500)
    } catch (e: any) {
      setPwdError(e.message ?? 'Failed to update password')
    } finally {
      setPwdSaving(false)
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImportStatus('importing')
    setImportMsg('')
    try {
      const fd = new FormData()
      fd.append('logbook', file)
      const result = await api.upload<{ imported: number; skipped: number; manualCleared?: number; last_import_at: string; last_import_file: string }>('/currency/import', fd)
      setLastImport(result.last_import_at)
      setLastImportFile(result.last_import_file ?? null)
      setImportMsg(`Imported ${result.imported} flights${result.manualCleared ? ` · ${result.manualCleared} manual entr${result.manualCleared === 1 ? 'y' : 'ies'} now covered by ForeFlight removed` : ''}`)
      setImportStatus('done')
    } catch (err: any) {
      setImportMsg(err.message ?? 'Import failed')
      setImportStatus('error')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  async function saveMedical() {
    setMedicalSaving(true)
    setMedicalSaved(false)
    try {
      await api.patch('/currency/medical', { medical_expires_date: medicalExpiry || null })
      setMedicalSaved(true)
      setTimeout(() => setMedicalSaved(false), 2000)
    } catch {
      setError('Failed to save medical expiry')
    } finally {
      setMedicalSaving(false)
    }
  }

  async function saveBfr() {
    setBfrSaving(true)
    setBfrSaved(false)
    try {
      await api.patch('/currency/bfr', { bfr_date: bfrDate || null })
      setBfrSaved(true)
      setTimeout(() => setBfrSaved(false), 2000)
    } catch {
      setError('Failed to save BFR date')
    } finally {
      setBfrSaving(false)
    }
  }

  if (loading) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>


  return (
    <>
      <div className="flex flex-col">
        <div className="sticky top-0 z-10 border-b bg-background px-4 py-3">
          <h1 className="text-lg font-semibold">Settings</h1>
        </div>

        {error && <p className="px-4 pt-3 text-sm text-destructive">{error}</p>}

        <div className="divide-y divide-border">
          {/* ── Section 1: Aircraft ── */}
          <AccordionSection id="aircraft" label="Aircraft" open={openSections.has('aircraft')} onToggle={toggleSection}>
            <div className="space-y-1.5">
              <Label>N Number</Label>
              <Input value={tail} onChange={e => setTail(e.target.value)} placeholder="N12345" />
            </div>
            <div className="space-y-1.5">
              <Label>Serial #</Label>
              <Input value={serial} onChange={e => setSerial(e.target.value)} placeholder="22-1234" />
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input value={desc} onChange={e => setDesc(e.target.value)} placeholder="Cirrus SR22" />
            </div>
            <div className="space-y-1.5">
              <Label>Insurance coverage ends</Label>
              <Input type="date" value={insuranceDate} onChange={e => setInsuranceDate(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                The scheduler warns about reservations on or after this date. Update it when the policy is renewed.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Meter baseline{partnership?.baseline_date ? ` (read ${partnership.baseline_date})` : ''}</Label>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <p className="text-[11px] text-muted-foreground">Hobbs</p>
                  <Input type="number" step="0.1" value={baseHobbs} onChange={e => setBaseHobbs(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <p className="text-[11px] text-muted-foreground">Flight</p>
                  <Input type="number" step="0.1" value={baseFlight} onChange={e => setBaseFlight(e.target.value)} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                The first flight logged starts from these readings; maintenance hours count from the Flight reading.
                {partnership?.baseline_image_key && <> <a className="underline" href="/api/partnership/baseline-photo" target="_blank" rel="noreferrer">View photo</a></>}
              </p>
            </div>
            <Button onClick={saveAircraft} disabled={aircraftSaving} size="sm">
              {aircraftSaved ? 'Saved!' : aircraftSaving ? 'Saving…' : 'Save Aircraft'}
            </Button>

            {(user?.role === 'owner' || user?.is_admin) && <AircraftImage />}

            <div className="border-t pt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Required Aircraft Documents (ARROW)
              </p>
              <Button size="sm" variant="outline" onClick={() => navigate('/documents')}>
                Manage Aircraft Documents →
              </Button>
            </div>
          </AccordionSection>

          {/* ── Section 2: Account ── */}
          <AccordionSection id="account" label="Account" open={openSections.has('account')} onToggle={toggleSection}>
            {/* Name / Email */}
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={accountName} onChange={e => setAccountName(e.target.value)} placeholder="Your name" />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={accountEmail} onChange={e => setAccountEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            {accountError && <p className="text-xs text-destructive">{accountError}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={saveAccount} disabled={accountSaving}>
                {accountSaved ? 'Saved!' : accountSaving ? 'Saving…' : 'Save Account'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPwdModalOpen(true)}>
                Change Password
              </Button>
            </div>


            {/* Medical */}
            <div className="space-y-3 border-t pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Medical</p>
              <div className="space-y-1.5">
                <Label>Expiration Date</Label>
                <Input type="date" value={medicalExpiry} onChange={e => setMedicalExpiry(e.target.value)} />
              </div>
              <Button size="sm" variant="outline" disabled={medicalSaving} onClick={saveMedical}>
                {medicalSaved ? 'Saved!' : medicalSaving ? 'Saving…' : 'Save Medical'}
              </Button>
            </div>

            {/* BFR */}
            <div className="space-y-3 border-t pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">BFR</p>
              <div className="space-y-1.5">
                <Label>Date Accomplished</Label>
                <Input type="date" value={bfrDate} onChange={e => setBfrDate(e.target.value)} />
              </div>
              <Button size="sm" variant="outline" disabled={bfrSaving} onClick={saveBfr}>
                {bfrSaved ? 'Saved!' : bfrSaving ? 'Saving…' : 'Save BFR'}
              </Button>
            </div>

            {/* Manual currency entries */}
            <div className="space-y-3 border-t pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Flights since last import</p>
              <CurrencyEntries key={lastImport ?? 'none'} />
            </div>

            {/* Logbook */}
            <div className="space-y-3 border-t pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Logbook</p>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>
                  {lastImport
                    ? `Last import: ${new Date(lastImport).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                    : 'No logbook imported yet'}
                </span>
                {lastImport && lastImportFile && (
                  <a href="/api/currency/import/download" className="inline-flex items-center gap-1 text-primary hover:underline">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                    </svg>
                    Download
                  </a>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept=".csv" className="hidden" onChange={handleImport} />
              <Button
                size="sm"
                variant="outline"
                disabled={importStatus === 'importing'}
                onClick={() => fileInputRef.current?.click()}
              >
                {importStatus === 'importing' ? 'Importing…' : 'Import ForeFlight CSV'}
              </Button>
              {importMsg && (
                <p className={`text-xs ${importStatus === 'error' ? 'text-destructive' : 'text-emerald-600'}`}>
                  {importMsg}
                </p>
              )}
            </div>
          </AccordionSection>

          {/* ── Email & Reports: personal emails, then partnership-wide ones ── */}
          <AccordionSection id="email" label="Email & Reports" open={openSections.has('email')} onToggle={toggleSection}>
            <EmailAndReports canEdit={user?.role === 'owner' || !!user?.is_admin} />
          </AccordionSection>

          {/* ── Members ── */}
          {(user?.role === 'owner' || user?.is_admin) && (
            <AccordionSection id="members" label="Members" open={openSections.has('members')} onToggle={toggleSection}>
              <MembersManager />
            </AccordionSection>
          )}

          {/* ── FlightAware ── */}
          {(user?.role === 'owner' || user?.is_admin) && (
            <AccordionSection id="flightaware" label="FlightAware" open={openSections.has('flightaware')} onToggle={toggleSection}>
              <FlightAwareSettings />
            </AccordionSection>
          )}

          {/* ── Section 3: Application ── */}
          <AccordionSection id="application" label="Application" open={openSections.has('application')} onToggle={toggleSection}>
            {/* Exports */}
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Exports</p>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: 'Flights',     path: '/api/export/flights.csv' },
                  { label: 'Ledger',      path: '/api/export/ledger.csv' },
                  { label: 'Maintenance', path: '/api/export/maintenance.csv' },
                  { label: 'Squawks',     path: '/api/export/squawks.csv' },
                  { label: 'Schedule',    path: '/api/export/schedule.csv' },
                ].map(({ label, path }) => (
                  <Button key={label} size="sm" variant="outline" onClick={() => { window.location.href = path }}>
                    {label}
                  </Button>
                ))}
                <Button size="sm" onClick={() => { window.location.href = '/api/export/all.zip' }}>
                  All (ZIP)
                </Button>
              </div>
            </div>

            {/* Database Backups — inline */}
            <div className="border-t pt-4">
              <BackupPage />
            </div>

            {/* Google Integration (Calendar + Drive + Gmail) */}
            <div className="border-t pt-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Google Integration
              </p>
              {googleCalendarNotice === 'connected' && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">Connected! Calendar sync, Drive backups, and email reports are now active.</p>
              )}
              {googleCalendarNotice === 'error' && (
                <p className="text-xs text-destructive">Something went wrong connecting Google. Please try again.</p>
              )}
              {googleCalendarStatus === null ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : googleCalendarStatus.connected ? (
                <>
                  {googleCalendarStatus.tokenValid === false && (
                    <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      Google has revoked or expired this connection — calendar sync, Drive backups and emails are NOT working. Click Disconnect, then Connect Google to reconnect.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    <span className={googleCalendarStatus.tokenValid === false ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400'}>●</span> {googleCalendarStatus.tokenValid === false ? 'Connection expired' : 'Connected'} — reservations/flights sync to Google Calendar, uploaded files archive to Google Drive, and reports send via Gmail.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {googleCalendarStatus.calendarUrl && (
                      <Button size="sm" variant="outline" onClick={() => window.open(googleCalendarStatus.calendarUrl!, '_blank', 'noopener,noreferrer')}>
                        Open Calendar →
                      </Button>
                    )}
                    {googleCalendarStatus.driveUrl && (
                      <Button size="sm" variant="outline" onClick={() => window.open(googleCalendarStatus.driveUrl!, '_blank', 'noopener,noreferrer')}>
                        Open Drive Folder →
                      </Button>
                    )}
                    <Button size="sm" variant="outline" disabled={googleCalendarDisconnecting} onClick={disconnectGoogleCalendar}>
                      {googleCalendarDisconnecting ? 'Disconnecting…' : 'Disconnect'}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    Connect the shared aircraft Google account to push the schedule to Google Calendar, archive uploaded files to Google Drive, and send email reports — instead of relying on the subscribed calendar feed alone.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!googleCalendarStatus.configured}
                    onClick={() => { window.location.href = '/api/calendar/google/connect' }}
                  >
                    Connect Google
                  </Button>
                  {!googleCalendarStatus.configured && (
                    <p className="text-[11px] text-muted-foreground">Not configured on the server yet — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see docs/INTEGRATIONS.md).</p>
                  )}
                </>
              )}
            </div>

          </AccordionSection>
        </div>

        {/* bottom padding for nav */}
        <div className="h-24" />
      </div>

      {/* ── Password Modal ── */}
      {pwdModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={e => { if (e.target === e.currentTarget) closePwdModal() }}
        >
          <div className="w-full max-w-sm rounded-xl border border-border bg-background p-6 shadow-xl">
            <h2 className="mb-4 text-base font-semibold">Change Password</h2>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Current Password</Label>
                <Input
                  type="password"
                  value={curPwd}
                  onChange={e => setCurPwd(e.target.value)}
                  autoComplete="current-password"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label>New Password</Label>
                <Input
                  type="password"
                  value={newPwd}
                  onChange={e => setNewPwd(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Confirm New Password</Label>
                <Input
                  type="password"
                  value={confirmPwd}
                  onChange={e => setConfirmPwd(e.target.value)}
                  autoComplete="new-password"
                  onKeyDown={e => { if (e.key === 'Enter') savePassword() }}
                />
              </div>
              {pwdError && <p className="text-xs text-destructive">{pwdError}</p>}
              {pwdMsg && <p className="text-xs text-emerald-600">{pwdMsg}</p>}
            </div>
            <div className="mt-5 flex gap-2">
              <Button
                className="flex-1"
                onClick={savePassword}
                disabled={pwdSaving || !curPwd || !newPwd || !confirmPwd}
              >
                {pwdSaving ? 'Updating…' : 'Update Password'}
              </Button>
              <Button variant="outline" onClick={closePwdModal} disabled={pwdSaving}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// The picture on the sign-in screen and dashboard — your own aircraft photo or the generic mark.
function AircraftImage() {
  const [custom, setCustom] = useState(false)
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.get<{ custom: boolean }>('/partnership/branding').then(r => setCustom(r.custom)).catch(() => {})
  }, [])

  async function upload(file: File) {
    setBusy(true); setError('')
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await api.upload<{ custom: boolean }>('/partnership/branding', fd)
      setCustom(r.custom); setVersion(v => v + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  async function reset() {
    setBusy(true); setError('')
    try {
      await api.delete('/partnership/branding')
      setCustom(false); setVersion(v => v + 1)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 border-t pt-4">
      <Label>Aircraft image</Label>
      <img src={`/branding/mark?v=${version}`} alt="" className="h-24 w-auto rounded-md border object-cover" />
      <div className="flex flex-wrap items-center gap-2">
        <label className="cursor-pointer rounded-md border px-3 py-1.5 text-xs hover:bg-accent/40">
          {busy ? 'Working…' : 'Upload image'}
          <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" disabled={busy}
            onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }} />
        </label>
        {custom && (
          <button type="button" className="text-xs text-muted-foreground hover:underline" disabled={busy} onClick={reset}>
            Use the default image
          </button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">Shown on the sign-in screen and the dashboard.</p>
    </div>
  )
}

function EmailAndReports({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">My emails</p>
          <p className="text-xs text-muted-foreground">Just for you: what’s coming up and what’s changed.</p>
        </div>
        <NotificationSettings />
        <div className="border-t pt-4">
          <MyCurrencyAlerts />
        </div>
      </div>
      <div className="space-y-4 border-t pt-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Partnership emails</p>
          <p className="text-xs text-muted-foreground">Set once for everyone.</p>
        </div>
        <ReportsSettings canEdit={canEdit} />
      </div>
    </div>
  )
}
