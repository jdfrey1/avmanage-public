import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useAuth } from '@/context/AuthContext'
import { api, publicApi } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function Login() {
  const { user, login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [aircraftTail, setAircraftTail] = useState<string | null>(null)
  const [needsSetup, setNeedsSetup] = useState(false)

  useEffect(() => {
    publicApi.partnershipTail().then(({ aircraft_tail }) => setAircraftTail(aircraft_tail)).catch(() => {})
    api.get<{ needs_setup: boolean }>('/setup/status').then(r => setNeedsSetup(r.needs_setup)).catch(() => {})
  }, [])

  if (user) return <Navigate to="/" replace />
  if (needsSetup) return <Navigate to="/setup" replace />

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      await login(email, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-sm space-y-4">
        <img
          src="/branding/mark"
          alt="avManage"
          className="aspect-[900/630] w-full rounded-xl object-cover shadow-md"
        />

        <div className="text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            avManage{aircraftTail ? ` - ${aircraftTail}` : ''}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
          <p className="text-center text-sm">
            <Link to="/forgot-password" className="text-muted-foreground hover:text-foreground hover:underline">Forgot password?</Link>
          </p>
        </form>
      </div>
    </div>
  )
}
