import { useEffect, useState } from 'react'
import { Select } from '@/components/ui/select'
import { api, type MemberUsage } from '@/lib/api'
import { useAuth } from '@/context/AuthContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const hrs = (n: number) => n.toFixed(1)

function AddMember({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', role: 'lessee' as 'owner' | 'lessee' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ name: string; link: string; emailed: boolean } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      const r = await api.post<{ link: string; emailed: boolean }>('/partnership/members', form)
      setResult({ name: form.name, ...r })
      setForm({ name: '', email: '', role: 'lessee' })
      setOpen(false)
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add member')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2">
      {result && <InviteResult {...result} onClose={() => setResult(null)} />}
      {open ? (
        <form onSubmit={submit} className="space-y-3 rounded-lg border p-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} required />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Role</Label>
            <Select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value as 'owner' | 'lessee' }))}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              <option value="lessee">Lessee / partner</option>
              <option value="owner">Owner (replaces the current owner)</option>
            </Select>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={saving}>{saving ? 'Adding…' : 'Add and invite'}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Add member</Button>
      )}
    </div>
  )
}

function InviteResult({ name, link, emailed, onClose }: { name: string; link: string; emailed: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-1.5 rounded-lg border border-primary/40 bg-primary/5 p-3 text-xs">
      <p>
        {emailed ? `Invitation emailed to ${name}.` : `Send ${name} this link to choose a password (Google isn't connected, so it wasn't emailed).`}
        {' '}The link works for 7 days.
      </p>
      <div className="flex gap-2">
        <Input readOnly value={link} className="h-8 text-xs" onFocus={e => e.target.select()} />
        <Button type="button" size="sm" variant="outline" onClick={() => { navigator.clipboard?.writeText(link); setCopied(true) }}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <button type="button" className="text-muted-foreground hover:underline" onClick={onClose}>Dismiss</button>
    </div>
  )
}

export function MembersManager() {
  const { user } = useAuth()
  const [invite, setInvite] = useState<{ name: string; link: string; emailed: boolean } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [members, setMembers] = useState<MemberUsage[] | null>(null)
  const [allotments, setAllotments] = useState<Record<string, string>>({})
  const [terms, setTerms] = useState<Record<string, { rent: string; excess: string; start: string }>>({})
  const [periods, setPeriods] = useState<Record<string, 'annual' | 'monthly'>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})
  const [error, setError] = useState('')

  function load() {
    api.get<MemberUsage[]>('/partnership/members/usage')
      .then(ms => {
        setMembers(ms)
        setAllotments(Object.fromEntries(ms.map(m => [m.id, m.annual_hour_allotment != null ? String(m.annual_hour_allotment) : ''])))
        setTerms(Object.fromEntries(ms.map(m => [m.id, {
          rent: m.lease_monthly_rate != null ? String(m.lease_monthly_rate) : '',
          excess: m.overage_rate_per_hr != null ? String(m.overage_rate_per_hr) : '',
          start: m.lease_start_date ?? '',
        }])))
        setPeriods(Object.fromEntries(ms.map(m => [m.id, m.hour_allotment_period])))
      })
      .catch(() => setError('Failed to load members'))
  }
  useEffect(load, [])

  async function save(m: MemberUsage) {
    setSaving(s => ({ ...s, [m.id]: true }))
    setError('')
    try {
      await api.patch(`/partnership/members/${m.id}`, {
        annual_hour_allotment: allotments[m.id] ? parseInt(allotments[m.id]) : null,
        hour_allotment_period: periods[m.id],
        lease_monthly_rate: terms[m.id]?.rent || null,
        overage_rate_per_hr: terms[m.id]?.excess || null,
        lease_start_date: terms[m.id]?.start || null,
      })
      load()
      setSaved(s => ({ ...s, [m.id]: true }))
      setTimeout(() => setSaved(s => ({ ...s, [m.id]: false })), 2000)
    } catch {
      setError('Failed to save')
    } finally {
      setSaving(s => ({ ...s, [m.id]: false }))
    }
  }

  async function patchMember(m: MemberUsage, body: Record<string, unknown>) {
    setError('')
    try {
      await api.patch(`/partnership/members/${m.id}`, body)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    }
  }

  async function resendInvite(m: MemberUsage) {
    setError('')
    try {
      const r = await api.post<{ link: string; emailed: boolean }>(`/partnership/members/${m.id}/invite`, {})
      setInvite({ name: m.name, ...r })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create invite')
    }
  }

  async function removeMember(m: MemberUsage) {
    if (confirmRemove !== m.id) { setConfirmRemove(m.id); return }
    setError('')
    try {
      await api.delete(`/partnership/members/${m.id}`)
      setConfirmRemove(null)
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove')
    }
  }

  if (!members) return <p className="text-xs text-muted-foreground">{error || 'Loading…'}</p>

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Set each pilot's lease terms (rent, hour allotment, excess rate, start date) and see their Flight-hour usage. The allotment resets on each lease anniversary. Hours flagged "exclude from allotment"
        (e.g. repositioning flights) are shown separately and don't count.
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {invite && <InviteResult {...invite} onClose={() => setInvite(null)} />}

      {members.map(m => (
        <div key={m.id} className="space-y-3 rounded-lg border p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{m.name}</p>
              <p className="text-xs text-muted-foreground">{m.email}</p>
            </div>
            <div className="flex items-center gap-2">
              {m.is_admin && (
                <span className="rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Admin</span>
              )}
              <Select
                value={m.role}
                onChange={e => patchMember(m, { role: e.target.value })}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                title="The owner pays the aircraft's costs and has no hour allotment"
              >
                <option value="owner">Owner</option>
                <option value="lessee">Lessee</option>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <button type="button" className="text-primary hover:underline" onClick={() => resendInvite(m)}>Send password link</button>
            {user?.is_admin && m.user_id !== user.id && (
              <button type="button" className="text-primary hover:underline" onClick={() => patchMember(m, { is_admin: !m.is_admin })}>
                {m.is_admin ? 'Remove admin' : 'Make admin'}
              </button>
            )}
            {m.user_id !== user?.id && (
              <button type="button" className="text-destructive hover:underline" onClick={() => removeMember(m)}>
                {confirmRemove === m.id ? 'Confirm remove' : 'Remove from partnership'}
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-md bg-muted/40 p-2">
              <p className="text-[11px] text-muted-foreground">This month</p>
              <p className="tabular-nums font-medium">{hrs(m.month_hours)} hrs</p>
              {m.month_excluded > 0 && <p className="text-[11px] text-muted-foreground">+ {hrs(m.month_excluded)} excluded</p>}
            </div>
            <div className="rounded-md bg-muted/40 p-2">
              <p className="text-[11px] text-muted-foreground">Year to date</p>
              <p className="tabular-nums font-medium">{hrs(m.ytd_hours)} hrs</p>
              {m.ytd_excluded > 0 && <p className="text-[11px] text-muted-foreground">+ {hrs(m.ytd_excluded)} excluded</p>}
            </div>
          </div>

          {m.role === 'owner' ? (
            <p className="text-xs text-muted-foreground">The owner has no hour allotment.</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {m.not_started ? (
                  <>Lease starts {m.lease_start_date}; no hours counted yet.</>
                ) : (
                  <>
                    {m.hour_allotment_period === 'monthly' ? 'Current month' : 'Lease year'} ({m.window_start} → {m.window_end}):{' '}
                    <span className="tabular-nums">{hrs(m.window_hours)}</span>
                    {m.annual_hour_allotment != null && <> of {m.annual_hour_allotment}</>} hrs
                    {m.window_overage > 0 && (
                      <span className="font-medium text-destructive">
                        {' '}— {hrs(m.window_overage)} over{m.window_overage_cost != null && <> (${m.window_overage_cost.toFixed(2)} excess)</>}
                      </span>
                    )}
                  </>
                )}
              </p>
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1.5">
                  <Label>Hours</Label>
                  <Input
                    type="number"
                    min="0"
                    value={allotments[m.id] ?? ''}
                    onChange={e => setAllotments(a => ({ ...a, [m.id]: e.target.value }))}
                    placeholder="50"
                  />
                </div>
                <div className="w-28 space-y-1.5">
                  <Label>Period</Label>
                  <Select
                    value={periods[m.id] ?? 'annual'}
                    onChange={e => setPeriods(p => ({ ...p, [m.id]: e.target.value as 'annual' | 'monthly' }))}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="annual">Annual</option>
                    <option value="monthly">Monthly</option>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <Label>Rent / mo ($)</Label>
                  <Input type="number" min="0" step="0.01" value={terms[m.id]?.rent ?? ''}
                    onChange={e => setTerms(t => ({ ...t, [m.id]: { ...t[m.id], rent: e.target.value } }))} placeholder="2500" />
                </div>
                <div className="space-y-1.5">
                  <Label>Excess ($/hr)</Label>
                  <Input type="number" min="0" step="0.01" value={terms[m.id]?.excess ?? ''}
                    onChange={e => setTerms(t => ({ ...t, [m.id]: { ...t[m.id], excess: e.target.value } }))} placeholder="150" />
                </div>
                <div className="space-y-1.5">
                  <Label>Lease start</Label>
                  <Input type="date" value={terms[m.id]?.start ?? ''}
                    onChange={e => setTerms(t => ({ ...t, [m.id]: { ...t[m.id], start: e.target.value } }))} />
                </div>
              </div>
              <Button size="sm" variant="outline" disabled={saving[m.id]} onClick={() => save(m)}>
                {saved[m.id] ? 'Saved!' : saving[m.id] ? '…' : 'Save'}
              </Button>
            </>
          )}
        </div>
      ))}

      <AddMember onAdded={load} />
    </div>
  )
}
