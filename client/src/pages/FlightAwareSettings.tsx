import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function FlightAwareSettings() {
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => { api.get<{ hasApiKey: boolean }>('/flightaware/status').then(r => setHasKey(r.hasApiKey)).catch(() => {}) }, [])

  async function save(value: string) {
    setBusy(true); setMsg('')
    try {
      const r = await api.post<{ hasApiKey: boolean }>('/flightaware/api-key', { api_key: value })
      setHasKey(r.hasApiKey); setKey(''); setMsg(r.hasApiKey ? 'Saved' : 'Removed')
    } catch { setMsg('Failed to save') } finally { setBusy(false) }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        FlightAware alert emails for this aircraft are read from the connected Gmail inbox automatically. Add a FlightAware AeroAPI key to also
        save each flight's track (about $0.02 per flight, inside the free monthly credit on the Personal tier).
      </p>
      <p className="text-xs">API key: <span className="font-medium">{hasKey ? 'saved' : 'not set'}</span></p>
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <Label>AeroAPI key</Label>
          <Input type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder="Paste key" />
        </div>
        <Button size="sm" variant="outline" disabled={busy || !key.trim()} onClick={() => save(key)}>Save</Button>
        {hasKey && <Button size="sm" variant="ghost" disabled={busy} onClick={() => save('')}>Remove</Button>}
      </div>
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
    </div>
  )
}
