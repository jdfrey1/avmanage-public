import { useEffect, useState, type FormEvent } from 'react'
import { Select } from '@/components/ui/select'
import { Navigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

// First-run setup: shown only while the app has no accounts yet.
export function Setup() {
  const { user, refreshUser } = useAuth()
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null)
  const [form, setForm] = useState({
    aircraft_tail: '', aircraft_make_model: '', aircraft_serial: '',
    name: '', email: '', password: '', role: 'owner' as 'owner' | 'lessee',
  })
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    api.get<{ needs_setup: boolean }>('/setup/status').then(r => setNeedsSetup(r.needs_setup)).catch(() => setNeedsSetup(false))
  }, [])

  if (user) return <Navigate to="/" replace />
  if (needsSetup === false) return <Navigate to="/login" replace />
  if (needsSetup === null) return null

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await api.post('/setup', form)
      await refreshUser()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center overflow-y-auto p-6">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-5">
        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to avManage</h1>
          <p className="mt-1 text-sm text-muted-foreground">Set up your aircraft and your administrator account.</p>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">Aircraft</legend>
          <div className="space-y-1.5">
            <Label htmlFor="tail">Tail number</Label>
            <Input id="tail" value={form.aircraft_tail} onChange={set('aircraft_tail')} placeholder="N12345" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="model">Make and model</Label>
            <Input id="model" value={form.aircraft_make_model} onChange={set('aircraft_make_model')} placeholder="Cirrus SR22" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="serial">Serial number</Label>
            <Input id="serial" value={form.aircraft_serial} onChange={set('aircraft_serial')} />
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">Your account</legend>
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={form.name} onChange={set('name')} autoComplete="name" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" value={form.email} onChange={set('email')} autoComplete="email" required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input id="password" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" minLength={8} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role">Your role</Label>
            <Select id="role" value={form.role} onChange={set('role')}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
              <option value="owner">Owner — I own the aircraft</option>
              <option value="lessee">Lessee / partner — I lease or share it</option>
            </Select>
            <p className="text-xs text-muted-foreground">
              The owner pays the aircraft's costs and has no hour allotment; lessees have lease terms and hour allotments.
              You can add the other members, and change who the owner is, in Settings → Members.
            </p>
          </div>
        </fieldset>

        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? 'Setting up…' : 'Create and sign in'}
        </Button>
      </form>
    </div>
  )
}
