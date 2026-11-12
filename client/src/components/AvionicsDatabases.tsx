import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Camera, Check, History, Image as ImageIcon, Pencil, Plus, RefreshCw, X } from 'lucide-react'
import { api, type AvionicsDatabase, type AvionicsDatabasePhoto, type AvionicsDatabaseUpdate } from '@/lib/api'
import { useUrlState } from '@/lib/navigation'
import { photoTakenDate } from '@/lib/exif'
import { Button } from '@/components/ui/button'
import { Input, openPicker } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

// Maintenance → Databases: the avionics database cycles loaded in the aircraft and when each expires
// (the "Active" column on the Garmin Aux → Databases page), a photo of that page after each update,
// and a history of updates — kept here rather than in the aircraft logbooks.

const fmtDate = (d: string) =>
  new Date(d + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const today = () => new Date().toLocaleDateString('en-CA')
const photoUrl = (id: string) => `/api/maintenance/databases/photos/${id}/file`

const tone = (s: AvionicsDatabase['status']) =>
  s === 'expired' ? 'text-destructive font-medium'
  : s === 'due_soon' ? 'text-amber-600 dark:text-amber-400 font-medium'
  : 'text-muted-foreground'

function statusLabel(d: AvionicsDatabase) {
  if (d.status === 'no_expiry' || d.days_until == null) return 'no expiration'
  if (d.status === 'expired') return d.days_until === 0 ? 'expires today' : `expired ${Math.abs(d.days_until)} days ago`
  if (d.days_until === 0) return 'expires today'
  return `${d.days_until} days`
}

interface FormState { name: string; cycle: string; expires: string; notes: string }
const EMPTY: FormState = { name: '', cycle: '', expires: '', notes: '' }

function DatabaseForm({ initial, submitLabel, onSubmit, onCancel, onDelete }: {
  initial: FormState
  submitLabel: string
  onSubmit: (f: FormState) => Promise<void>
  onCancel: () => void
  onDelete?: () => void
}) {
  const [f, setF] = useState(initial)
  const [saving, setSaving] = useState(false)
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => setF(p => ({ ...p, [k]: e.target.value }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    try { await onSubmit(f) } finally { setSaving(false) }
  }

  return (
    <form onSubmit={submit} className="rounded-md border bg-background p-3 space-y-3">
      <div className="space-y-1.5">
        <Label className="text-xs">Database</Label>
        <Input value={f.name} onChange={set('name')} placeholder="e.g. Navigation" required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Cycle</Label>
          <Input value={f.cycle} onChange={set('cycle')} placeholder="e.g. 2612" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Expires</Label>
          <Input type="date" value={f.expires} onChange={set('expires')} onClick={openPicker} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Notes</Label>
        <Input value={f.notes} onChange={set('notes')} placeholder="Optional" />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" className="flex-1" disabled={saving}>{saving ? 'Saving…' : submitLabel}</Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        {onDelete && (
          <Button type="button" variant="outline" size="sm" className="text-destructive" onClick={onDelete}>Delete</Button>
        )}
      </div>
    </form>
  )
}

// After a database update: the date, the photo of the Garmin page, and the new cycle and expiration
// of each database that was loaded. Rows whose values change are marked updated automatically.
function RecordUpdateForm({ items, onDone, onCancel }: {
  items: AvionicsDatabase[]
  onDone: () => Promise<void>
  onCancel: () => void
}) {
  const [date, setDate] = useState(today())
  const [photo, setPhoto] = useState<File | null>(null)
  const [dateNote, setDateNote] = useState('')
  const [rows, setRows] = useState(() => items.map(d => ({
    id: d.id, name: d.name, oldCycle: d.cycle ?? '', cycle: d.cycle ?? '', expires: d.expires_date ?? '', updated: false,
  })))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const setRow = (id: string, patch: Partial<(typeof rows)[number]>) =>
    setRows(rs => rs.map(r => r.id === id ? { ...r, ...patch, updated: patch.updated ?? true } : r))
  const changed = rows.filter(r => r.updated)

  // The photo is taken right after the update, so its date is the update date.
  async function pickPhoto(f: File | null) {
    setPhoto(f)
    if (!f) { setDateNote(''); return }
    const taken = await photoTakenDate(f)
    if (taken) { setDate(taken); setDateNote('Date from the photo') }
    else setDateNote('No date in the photo — check the date')
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!photo && !changed.length) { setError('Add a photo or mark at least one database as updated'); return }
    setSaving(true); setError('')
    try {
      let photoId: string | null = null
      if (photo) {
        const fd = new FormData()
        fd.append('file', photo)
        fd.append('taken_date', date)
        photoId = (await api.upload<{ id: string }>('/maintenance/databases/photos', fd)).id
      }
      if (changed.length) {
        await api.post('/maintenance/databases/record', {
          updated_on: date, photo_id: photoId,
          changes: changed.map(r => ({ id: r.id, cycle: r.cycle, expires_date: r.expires || null })),
        })
      }
      await onDone()
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to save') }
    finally { setSaving(false) }
  }

  return (
    <form onSubmit={submit} className="rounded-md border bg-background p-3 space-y-3">
      <p className="text-sm font-medium">Record a database update</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Updated on</Label>
          <Input type="date" value={date} onChange={e => { setDate(e.target.value); setDateNote('') }} onClick={openPicker} required />
          {dateNote && <p className="text-[11px] text-muted-foreground">{dateNote}</p>}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Photo of the Databases page</Label>
          <input ref={fileRef} type="file" accept="image/*" className="hidden"
            onChange={e => pickPhoto(e.target.files?.[0] ?? null)} />
          {photo ? (
            <div className="flex h-9 items-center gap-1 rounded-md border px-2 text-xs">
              <ImageIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{photo.name}</span>
              <button type="button" onClick={() => { pickPhoto(null); if (fileRef.current) fileRef.current.value = '' }}
                className="text-muted-foreground hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
            </div>
          ) : (
            <Button type="button" variant="outline" size="sm" className="h-9 w-full gap-1" onClick={() => fileRef.current?.click()}>
              <Camera className="h-3.5 w-3.5" /> Add photo
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">Enter the new Active cycle and expiration for each database you loaded.</p>
        <ul className="divide-y rounded-md border">
          {rows.map(r => (
            <li key={r.id} className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5', r.updated && 'bg-primary/5')}>
              <label className="flex min-w-[9rem] flex-1 items-center gap-2">
                <input type="checkbox" checked={r.updated} onChange={e => setRow(r.id, { updated: e.target.checked })}
                  className="h-4 w-4 shrink-0" />
                <span className="text-xs font-medium">{r.name}</span>
              </label>
              <div className="ml-6 flex items-center gap-2 sm:ml-0">
                <input value={r.cycle} onChange={e => setRow(r.id, { cycle: e.target.value })}
                  className="w-16 rounded-md border border-input bg-background px-1.5 py-1 font-mono text-xs" placeholder="cycle" />
                <input type="date" value={r.expires} onChange={e => setRow(r.id, { expires: e.target.value })} onClick={openPicker}
                  className="w-[8.5rem] rounded-md border border-input bg-background px-1.5 py-1 text-xs" />
              </div>
            </li>
          ))}
        </ul>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" className="flex-1" disabled={saving}>
          {saving ? 'Saving…' : changed.length ? `Save (${changed.length} updated)` : 'Save'}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

// Update history, newest first: one group per date with that day's photo(s) and the databases loaded.
function UpdateHistory({ photos, updates, onChanged }: {
  photos: AvionicsDatabasePhoto[]
  updates: AvionicsDatabaseUpdate[]
  onChanged: () => Promise<void>
}) {
  const days = new Map<string, { photos: AvionicsDatabasePhoto[]; updates: AvionicsDatabaseUpdate[] }>()
  const day = (d: string) => { if (!days.has(d)) days.set(d, { photos: [], updates: [] }); return days.get(d)! }
  for (const u of updates) day(u.updated_on).updates.push(u)
  for (const p of photos) {
    const linked = updates.find(u => u.photo_id === p.id)
    day(linked ? linked.updated_on : p.taken_date).photos.push(p)
  }
  const dates = [...days.keys()].sort((a, b) => b.localeCompare(a))

  const [editing, setEditing] = useState<string | null>(null)
  const [newDate, setNewDate] = useState('')

  async function redate(d: string) {
    const g = days.get(d)!
    if (newDate && newDate !== d) {
      await api.patch('/maintenance/databases/history/date', {
        date: newDate, update_ids: g.updates.map(u => u.id), photo_ids: g.photos.map(p => p.id),
      })
      await onChanged()
    }
    setEditing(null)
  }

  async function removeUpdate(u: AvionicsDatabaseUpdate) {
    if (!confirm(`Remove "${u.database_name} ${u.cycle ?? ''}" from the history? (The current cycle isn't changed.)`)) return
    await api.delete(`/maintenance/databases/updates/${u.id}`)
    await onChanged()
  }
  async function removePhoto(p: AvionicsDatabasePhoto) {
    if (!confirm(`Delete the photo from ${fmtDate(p.taken_date)}?`)) return
    await api.delete(`/maintenance/databases/photos/${p.id}`)
    await onChanged()
  }

  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
      <p className="text-sm font-medium text-muted-foreground">Update history</p>
      {!dates.length ? <p className="text-xs text-muted-foreground">No updates recorded yet. Use “Record update” after loading new databases.</p> : (
        <ul className="space-y-2">
          {dates.map(d => {
            const g = days.get(d)!
            return (
              <li key={d} className="rounded-md border bg-background p-2.5">
                <div className="flex items-center gap-2">
                  {editing === d ? (
                    <span className="flex flex-1 items-center gap-1">
                      <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} onClick={openPicker}
                        className="rounded-md border border-input bg-background px-1.5 py-1 text-xs" />
                      <button type="button" onClick={() => redate(d)} title="Save date"
                        className="rounded p-1 text-primary hover:bg-muted"><Check className="h-3.5 w-3.5" /></button>
                      <button type="button" onClick={() => setEditing(null)} title="Cancel"
                        className="rounded p-1 text-muted-foreground hover:bg-muted"><X className="h-3.5 w-3.5" /></button>
                    </span>
                  ) : (
                    <span className="flex flex-1 items-center gap-1">
                      <p className="text-sm font-medium">{fmtDate(d)}</p>
                      <button type="button" onClick={() => { setEditing(d); setNewDate(d) }} title="Change date"
                        className="rounded p-1 text-muted-foreground hover:text-foreground"><Pencil className="h-3 w-3" /></button>
                    </span>
                  )}
                  {g.photos.map(p => (
                    <span key={p.id} className="flex items-center gap-1">
                      <a href={photoUrl(p.id)} target="_blank" rel="noreferrer"
                        className="flex items-center gap-1 text-[11px] text-primary hover:underline">
                        <ImageIcon className="h-3 w-3" /> Photo
                      </a>
                      <button type="button" onClick={() => removePhoto(p)} title="Delete photo"
                        className="text-muted-foreground hover:text-destructive"><X className="h-3 w-3" /></button>
                    </span>
                  ))}
                </div>
                {g.updates.length ? (
                  <ul className="mt-1 space-y-0.5">
                    {g.updates.map(u => (
                      <li key={u.id} className="group flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="min-w-0 flex-1">
                          <span className="text-foreground">{u.database_name}</span>{' '}
                          {u.previous_cycle && <span className="font-mono">{u.previous_cycle} → </span>}
                          <span className="font-mono text-foreground">{u.cycle ?? '—'}</span>
                          {u.expires_date && <> · expires {fmtDate(u.expires_date)}</>}
                          {u.recorded_by_name && <> · {u.recorded_by_name}</>}
                        </span>
                        <button type="button" onClick={() => removeUpdate(u)} title="Remove from history"
                          className="text-muted-foreground opacity-60 hover:text-destructive hover:opacity-100"><X className="h-3 w-3" /></button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="mt-1 text-[11px] text-muted-foreground">Photo only</p>}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function AvionicsDatabases() {
  const [items, setItems] = useState<AvionicsDatabase[]>([])
  const [photos, setPhotos] = useState<AvionicsDatabasePhoto[]>([])
  const [updates, setUpdates] = useState<AvionicsDatabaseUpdate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [recording, setRecording] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [view, setView] = useUrlState<'' | 'history'>('view', '', ['', 'history'])

  async function load() {
    try {
      const [dbs, hist] = await Promise.all([
        api.get<AvionicsDatabase[]>('/maintenance/databases'),
        api.get<{ photos: AvionicsDatabasePhoto[]; updates: AvionicsDatabaseUpdate[] }>('/maintenance/databases/history'),
      ])
      setItems(dbs); setPhotos(hist.photos); setUpdates(hist.updates)
    }
    catch { setError('Failed to load') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const body = (f: FormState) => ({ name: f.name.trim(), cycle: f.cycle, expires_date: f.expires || null, notes: f.notes })

  async function add(f: FormState) {
    setError('')
    try { await api.post('/maintenance/databases', body(f)); setShowAdd(false); await load() }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to save') }
  }

  async function save(id: string, f: FormState) {
    setError('')
    try { await api.patch(`/maintenance/databases/${id}`, body(f)); setEditId(null); await load() }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed to save') }
  }

  async function remove(d: AvionicsDatabase) {
    if (!confirm(`Remove the ${d.name} database?`)) return
    try { await api.delete(`/maintenance/databases/${d.id}`); setEditId(null); await load() }
    catch { setError('Failed to remove') }
  }

  // The soonest expiration among databases that expire: that's when the next update is needed.
  const next = items
    .filter(d => d.expires_date && d.status !== 'expired')
    .sort((a, b) => a.expires_date!.localeCompare(b.expires_date!))[0]
  const expired = items.filter(d => d.status === 'expired')
  const latestPhoto = photos[0]
  const lastUpdate = updates[0]

  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {latestPhoto ? (
          <a href={photoUrl(latestPhoto.id)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary hover:underline">
            <ImageIcon className="h-3.5 w-3.5" /> Latest photo · {fmtDate(latestPhoto.taken_date)}
          </a>
        ) : !loading && <span className="text-muted-foreground">No photo yet</span>}
        <button type="button" onClick={() => setView(v => v === 'history' ? '' : 'history')}
          className="flex items-center gap-1 text-primary hover:underline">
          <History className="h-3.5 w-3.5" /> {view === 'history' ? 'Hide update history' : 'Update history'}
          {lastUpdate && view !== 'history' && <span className="text-muted-foreground">(last {fmtDate(lastUpdate.updated_on)})</span>}
        </button>
      </div>

      {view === 'history' && <UpdateHistory photos={photos} updates={updates} onChanged={load} />}

      <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-muted-foreground">Installed databases</p>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs"
              onClick={() => { setRecording(v => !v); setShowAdd(false); setEditId(null) }}>
              <RefreshCw className="h-3.5 w-3.5" /> Record update
            </Button>
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs"
              onClick={() => { setShowAdd(v => !v); setRecording(false); setEditId(null) }}>
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {!loading && (expired.length > 0 || next) && (
          <p className={cn('text-xs', expired.length ? 'text-destructive' : 'text-muted-foreground')}>
            {expired.length
              ? `Expired: ${expired.map(d => d.name).join(', ')}`
              : `Next update needed by ${fmtDate(next!.expires_date!)} (${next!.name})`}
          </p>
        )}

        {recording && (
          <RecordUpdateForm items={items} onCancel={() => setRecording(false)}
            onDone={async () => { setRecording(false); await load() }} />
        )}
        {showAdd && <DatabaseForm initial={EMPTY} submitLabel="Save" onSubmit={add} onCancel={() => setShowAdd(false)} />}

        {loading ? <p className="text-xs text-muted-foreground">Loading…</p>
        : !items.length ? <p className="text-xs text-muted-foreground">No databases yet.</p>
        : (
          <ul className="space-y-2">
            {items.map(d => editId === d.id ? (
              <li key={d.id}>
                <DatabaseForm
                  initial={{ name: d.name, cycle: d.cycle ?? '', expires: d.expires_date ?? '', notes: d.notes ?? '' }}
                  submitLabel="Save"
                  onSubmit={f => save(d.id, f)}
                  onCancel={() => setEditId(null)}
                  onDelete={() => remove(d)}
                />
              </li>
            ) : (
              <li key={d.id} className="rounded-md border bg-background p-2.5">
                <div className="flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">{d.name}</p>
                  <span className={`shrink-0 text-xs tabular-nums ${tone(d.status)}`}>{statusLabel(d)}</span>
                  <button type="button" className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
                    title="Edit" onClick={() => { setEditId(d.id); setShowAdd(false); setRecording(false) }}>
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Cycle <span className="font-mono text-foreground">{d.cycle ?? '—'}</span>
                  {' · '}{d.expires_date ? `expires ${fmtDate(d.expires_date)}` : 'does not expire'}
                </p>
                {d.notes && <p className="mt-1 text-[11px] text-muted-foreground">{d.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
