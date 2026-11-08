import { useEffect, useRef, useState, type FormEvent } from 'react'
import { EngineTrends } from '@/components/EngineTrends'
import { Select } from '@/components/ui/select'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, Camera, Paperclip, Plus, X, RefreshCw, Download, FileText } from 'lucide-react'
import { api, logbookApi, type Squawk, type MaintenanceEntry, type MaintenanceRecurring, type MaintenanceInterval, type InspectionItem, type CostAnalysis, type MaintenanceAttachment, type LogbookEntry, type LogbookDocument, type LogbookCategory, type LogbookCitation } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input, openPicker } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type Tab = 'squawks' | 'log' | 'logbook' | 'engine'
type SquawkStatus = 'open' | 'in_progress' | 'resolved'
type Severity = 'major' | 'minor' | 'note'

const CATEGORIES = ['maintenance', 'insurance', 'avionics', 'hangar', 'fuel', 'misc'] as const
type Category = typeof CATEGORIES[number]

const SEVERITY_STYLES: Record<Severity, string> = {
  major: 'border-destructive bg-destructive/10 text-destructive',
  minor: 'border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400',
  note:  'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400',
}

const SEVERITY_ICON_COLOR: Record<Severity, string> = {
  major: 'text-destructive',
  minor: 'text-amber-500',
  note:  'text-emerald-500',
}

const SEVERITY_LABEL: Record<Severity, string> = {
  major: 'Major',
  minor: 'Minor',
  note:  'Note',
}

const STATUS_LABEL: Record<SquawkStatus, string> = {
  open:        'New',
  in_progress: 'Planned',
  resolved:    'Resolved',
}

const TODAY = new Date().toISOString().slice(0, 10)
const CURRENT_YEAR = new Date().getFullYear()

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

async function uploadAttachment(file: File, parentType: 'log' | 'squawk', parentId: string) {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('parent_type', parentType)
  fd.append('parent_id', parentId)
  return api.upload<MaintenanceAttachment>('/maintenance/attachments/upload', fd)
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function FF({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function Opt() {
  return <span className="font-normal text-muted-foreground">(optional)</span>
}

function CatSelect({ value, onChange }: { value: Category; onChange: (v: Category) => void }) {
  return (
    <Select value={value} onChange={e => onChange(e.target.value as Category)}
      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring">
      {CATEGORIES.map(c => (
        <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
      ))}
    </Select>
  )
}

// ── AttachButton ─────────────────────────────────────────────────────────────

function AttachButton({ onFiles }: { onFiles: (files: File[]) => void }) {
  const cameraRef = useRef<HTMLInputElement>(null)
  const fileRef   = useRef<HTMLInputElement>(null)
  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => cameraRef.current?.click()}
        className="flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <Camera className="h-3.5 w-3.5" /> Snap Photo
      </button>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className="flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <Paperclip className="h-3.5 w-3.5" /> Attach
      </button>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" multiple className="hidden"
        onChange={e => { if (e.target.files?.length) onFiles(Array.from(e.target.files)); e.target.value = '' }} />
      <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple className="hidden"
        onChange={e => { if (e.target.files?.length) onFiles(Array.from(e.target.files)); e.target.value = '' }} />
    </div>
  )
}

// ── StagedFileList ───────────────────────────────────────────────────────────

function StagedFileList({ files, onRemove }: { files: File[]; onRemove: (i: number) => void }) {
  if (!files.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {files.map((f, i) => (
        <span key={i} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
          {f.type === 'application/pdf' ? <FileText className="h-3 w-3" /> : <Camera className="h-3 w-3" />}
          {f.name.length > 20 ? f.name.slice(0, 18) + '…' : f.name}
          <button type="button" onClick={() => onRemove(i)} className="ml-0.5 text-muted-foreground hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  )
}

// ── AttachmentStrip ──────────────────────────────────────────────────────────

function AttachmentStrip({ parentType, parentId, reloadKey }: { parentType: 'log' | 'squawk'; parentId: string; reloadKey?: number }) {
  const [attachments, setAttachments] = useState<MaintenanceAttachment[]>([])

  useEffect(() => {
    api.get<MaintenanceAttachment[]>(`/maintenance/attachments?parent_type=${parentType}&parent_id=${parentId}`)
      .then(setAttachments)
      .catch(() => {})
  }, [parentType, parentId, reloadKey])

  async function handleDelete(id: string) {
    try {
      await api.delete(`/maintenance/attachments/${id}`)
      setAttachments(prev => prev.filter(a => a.id !== id))
    } catch {}
  }

  if (!attachments.length) return null

  return (
    <div className="space-y-2 border-t pt-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Attachments</p>
      <div className="flex flex-wrap gap-2">
        {attachments.map(a => {
          const url = `/api/maintenance/attachments/${a.id}/file`
          const isImage = a.mime_type.startsWith('image/')
          return (
            <div key={a.id} className="group relative">
              {isImage ? (
                <a href={url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border">
                  <img src={url} alt={a.original_name ?? 'attachment'} className="h-16 w-auto max-w-[120px] object-cover" />
                </a>
              ) : (
                <a href={url} target="_blank" rel="noreferrer"
                  className="flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs hover:bg-muted transition-colors">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="max-w-[100px] truncate">{a.original_name ?? 'document.pdf'}</span>
                </a>
              )}
              <button
                type="button"
                onClick={() => handleDelete(a.id)}
                className="absolute -right-1.5 -top-1.5 hidden group-hover:flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Squawks ─────────────────────────────────────────────────────────────────

interface SquawksTabProps {
  showAdd: boolean
  setShowAdd: (v: boolean) => void
  pendingAddFiles: File[]
  setPendingAddFiles: React.Dispatch<React.SetStateAction<File[]>>
}

function SquawksTab({ showAdd, setShowAdd, pendingAddFiles, setPendingAddFiles }: SquawksTabProps) {
  const [squawks, setSquawks]           = useState<Squawk[]>([])
  const [selected, setSelected]         = useState<SquawkStatus[]>(['open', 'in_progress'])
  const [loading, setLoading]           = useState(true)
  const [expandedId, setExpandedId]     = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [saving, setSaving]             = useState(false)
  const [error, setError]               = useState('')
  const [attachReloadKey, setAttachReloadKey] = useState(0)

  const [addDesc, setAddDesc]           = useState('')
  const [addSeverity, setAddSeverity]   = useState<Severity>('note')
  const [addError, setAddError]         = useState('')
  const [addSaving, setAddSaving]       = useState(false)

  const [editDesc, setEditDesc]         = useState('')
  const [editSeverity, setEditSeverity] = useState<Severity>('note')
  const [editStatus, setEditStatus]     = useState<SquawkStatus>('open')
  const [editNotes, setEditNotes]       = useState('')
  const [editPendingFiles, setEditPendingFiles] = useState<File[]>([])

  async function load() {
    setLoading(true)
    try { setSquawks(await api.get<Squawk[]>('/squawks')) }
    catch { setError('Failed to load squawks') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  function toggleStatus(s: SquawkStatus) {
    setSelected(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])
  }

  const filtered = selected.length === 0 ? squawks : squawks.filter(s => selected.includes(s.status))

  function startEdit(s: Squawk) {
    setExpandedId(s.id); setConfirmDeleteId(null)
    setEditDesc(s.description); setEditSeverity(s.severity)
    setEditStatus(s.status); setEditNotes(s.resolution_notes ?? '')
    setEditPendingFiles([])
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (!expandedId) return
    setSaving(true)
    try {
      await api.patch(`/squawks/${expandedId}`, { description: editDesc, severity: editSeverity, status: editStatus, resolution_notes: editNotes || null })
      if (editPendingFiles.length) {
        await Promise.all(editPendingFiles.map(f => uploadAttachment(f, 'squawk', expandedId)))
        setEditPendingFiles([])
        setAttachReloadKey(k => k + 1)
      }
      setExpandedId(null); await load()
    } catch { setError('Failed to save') }
    finally { setSaving(false) }
  }

  async function handleDelete(id: string) {
    try { await api.delete(`/squawks/${id}`); setExpandedId(null); setConfirmDeleteId(null); await load() }
    catch { setError('Failed to delete') }
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault()
    if (!addDesc.trim()) { setAddError('Description required'); return }
    setAddSaving(true)
    try {
      const squawk = await api.post<Squawk>('/squawks', { description: addDesc.trim(), severity: addSeverity })
      if (pendingAddFiles.length) {
        await Promise.all(pendingAddFiles.map(f => uploadAttachment(f, 'squawk', squawk.id)))
      }
      setAddDesc(''); setAddSeverity('note'); setShowAdd(false); setAddError('')
      setPendingAddFiles([])
      await load()
    } catch { setAddError('Failed to save') }
    finally { setAddSaving(false) }
  }

  return (
    <div className="space-y-3 p-4">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        {(['open', 'in_progress', 'resolved'] as SquawkStatus[]).map(s => (
          <button key={s} onClick={() => toggleStatus(s)}
            className={cn('rounded-full border px-3 py-1 text-xs transition-colors',
              selected.includes(s) ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border text-muted-foreground'
            )}>
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {showAdd ? (
        <form onSubmit={handleAdd} className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">New squawk</p>
            <button type="button" onClick={() => { setShowAdd(false); setAddError(''); setPendingAddFiles([]) }}><X className="h-4 w-4 text-muted-foreground" /></button>
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea value={addDesc} onChange={e => setAddDesc(e.target.value)} placeholder="Describe the issue…" rows={2} required />
          </div>
          <div className="space-y-1.5">
            <Label>Severity</Label>
            <div className="flex gap-2">
              {(['major', 'minor', 'note'] as Severity[]).map(s => (
                <button key={s} type="button" onClick={() => setAddSeverity(s)}
                  className={cn('rounded-full border px-3 py-1.5 text-xs transition-colors',
                    addSeverity === s ? SEVERITY_STYLES[s] + ' font-medium' : 'border-border text-muted-foreground'
                  )}>{SEVERITY_LABEL[s]}</button>
              ))}
            </div>
          </div>
          <AttachButton onFiles={fs => setPendingAddFiles(prev => [...prev, ...fs])} />
          <StagedFileList files={pendingAddFiles} onRemove={i => setPendingAddFiles(prev => prev.filter((_, j) => j !== i))} />
          {addError && <p className="text-xs text-destructive">{addError}</p>}
          <Button type="submit" size="sm" className="w-full" disabled={addSaving}>{addSaving ? 'Saving…' : 'Add squawk'}</Button>
        </form>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No squawks match the selected filters</p>
      ) : (
        <ul className="space-y-2">
          {filtered.map(s => (
            <li key={s.id} className="rounded-lg border bg-card">
              <button type="button" className="flex w-full items-start gap-3 p-3 text-left"
                onClick={() => expandedId === s.id ? setExpandedId(null) : startEdit(s)}>
                <AlertTriangle className={cn('mt-0.5 h-4 w-4 shrink-0', SEVERITY_ICON_COLOR[s.severity])} />
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm">{s.description}</p>
                  <div className="mt-1 flex gap-1.5">
                    <Badge variant={s.severity === 'major' ? 'destructive' : s.severity === 'minor' ? 'warning' as any : 'secondary'} className="text-[10px] px-1.5 py-0">{SEVERITY_LABEL[s.severity]}</Badge>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">{STATUS_LABEL[s.status]}</Badge>
                  </div>
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {new Date(s.reported_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </button>

              {expandedId === s.id && (
                <form onSubmit={handleSave} className="border-t px-3 pb-3 pt-2 space-y-3">
                  <div className="space-y-1.5">
                    <Label>Description</Label>
                    <Textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} rows={2} required />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Severity</Label>
                    <div className="flex gap-2">
                      {(['major', 'minor', 'note'] as Severity[]).map(sv => (
                        <button key={sv} type="button" onClick={() => setEditSeverity(sv)}
                          className={cn('rounded-full border px-3 py-1.5 text-xs transition-colors',
                            editSeverity === sv ? SEVERITY_STYLES[sv] + ' font-medium' : 'border-border text-muted-foreground'
                          )}>{SEVERITY_LABEL[sv]}</button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Status</Label>
                    <div className="flex gap-2">
                      {(['open', 'in_progress', 'resolved'] as SquawkStatus[]).map(st => (
                        <button key={st} type="button" onClick={() => setEditStatus(st)}
                          className={cn('rounded-full border px-3 py-1.5 text-xs transition-colors',
                            editStatus === st ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border text-muted-foreground'
                          )}>{STATUS_LABEL[st]}</button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Resolution notes <Opt /></Label>
                    <Textarea value={editNotes} onChange={e => setEditNotes(e.target.value)} rows={2} />
                  </div>
                  <AttachButton onFiles={fs => setEditPendingFiles(prev => [...prev, ...fs])} />
                  <StagedFileList files={editPendingFiles} onRemove={i => setEditPendingFiles(prev => prev.filter((_, j) => j !== i))} />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" className="flex-1" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setExpandedId(null)}>Cancel</Button>
                  </div>
                  <AttachmentStrip parentType="squawk" parentId={s.id} reloadKey={attachReloadKey} />
                  <div className="border-t pt-2 text-center">
                    {confirmDeleteId === s.id ? (
                      <button type="button" className="text-xs font-medium text-destructive" onClick={() => handleDelete(s.id)}>Confirm delete</button>
                    ) : (
                      <button type="button" className="text-xs text-muted-foreground hover:text-destructive" onClick={() => setConfirmDeleteId(s.id)}>Delete squawk</button>
                    )}
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── Cost Analysis Section ────────────────────────────────────────────────────

function CostAnalysisSection() {
  const [rangeMode, setRangeMode] = useState<'ytd' | 'custom'>('ytd')
  const [startDate, setStartDate] = useState(`${CURRENT_YEAR}-01-01`)
  const [endDate, setEndDate]     = useState(TODAY)
  const [data, setData]           = useState<CostAnalysis | null>(null)
  const [expanded, setExpanded]   = useState(false)
  const [loading, setLoading]     = useState(false)

  useEffect(() => {
    setLoading(true)
    api.get<CostAnalysis>(`/maintenance/cost-analysis?start=${startDate}&end=${endDate}`)
      .then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [startDate, endDate])

  function applyYtd() {
    setRangeMode('ytd')
    setStartDate(`${CURRENT_YEAR}-01-01`)
    setEndDate(TODAY)
  }

  if (loading) return <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">Loading analysis…</div>
  if (!data) return null

  const hasCosts = data.total_cost > 0
  const hasHours = data.total_hours > 0

  const rangeLabel = rangeMode === 'ytd'
    ? `YTD ${CURRENT_YEAR}`
    : `${data.start_date} – ${data.end_date}`

  return (
    <div className="rounded-lg border bg-muted/30">
      <button type="button" className="flex w-full items-center justify-between p-3" onClick={() => setExpanded(v => !v)}>
        <span className="text-sm font-medium">Cost Analysis · {rangeLabel}</span>
        <span className="text-sm tabular-nums font-medium">{hasCosts ? `$${fmt(data.total_cost)}` : 'No costs'}</span>
      </button>

      {expanded && (
        <div className="border-t px-3 pb-3 pt-2 space-y-3">
          {/* Range selector */}
          <div className="space-y-2">
            <div className="flex gap-2">
              <button type="button" onClick={applyYtd}
                className={cn('rounded-full border px-3 py-1 text-xs transition-colors',
                  rangeMode === 'ytd' ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border text-muted-foreground'
                )}>YTD</button>
              <button type="button" onClick={() => setRangeMode('custom')}
                className={cn('rounded-full border px-3 py-1 text-xs transition-colors',
                  rangeMode === 'custom' ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border text-muted-foreground'
                )}>Custom</button>
            </div>
            {rangeMode === 'custom' && (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">From</Label>
                  <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="h-8 text-xs" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">To</Label>
                  <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="h-8 text-xs" />
                </div>
              </div>
            )}
          </div>

          {(hasHours || hasCosts) && (
            <div className="flex gap-4 text-sm">
              <div>
                <p className="text-xl font-bold tabular-nums">{data.total_hours.toFixed(1)}</p>
                <p className="text-xs text-muted-foreground">hobbs hrs</p>
              </div>
              {hasCosts && hasHours && (
                <div>
                  <p className="text-xl font-bold tabular-nums">${fmt(data.cost_per_hour)}</p>
                  <p className="text-xs text-muted-foreground">/ hr</p>
                </div>
              )}
            </div>
          )}

          {hasCosts && (
            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Fixed costs</span>
                <span className="tabular-nums font-medium">${fmt(data.fixed_cost)}</span>
              </div>
              {data.by_category.filter(r => r.category !== 'fuel').map(r => (
                <div key={r.category} className="flex justify-between pl-3 text-xs text-muted-foreground">
                  <span className="capitalize">{r.category}</span>
                  <span className="tabular-nums">${fmt(r.total)}</span>
                </div>
              ))}
              {data.variable_cost > 0 && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Variable (fuel)</span>
                  <span className="tabular-nums font-medium">${fmt(data.variable_cost)}</span>
                </div>
              )}
            </div>
          )}

          {data.pilots.length > 0 && hasCosts && (
            <div className="space-y-2 border-t pt-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Per Pilot</p>
              {data.pilots.map(p => {
                const fixedShare = data.fixed_cost * (p.pct / 100)
                const varShare   = data.variable_cost * (p.pct / 100)
                return (
                  <div key={p.pilot_id} className="rounded-md bg-background p-2 space-y-1">
                    <div className="flex justify-between text-sm font-medium">
                      <span>{p.pilot_name}</span>
                      <span className="tabular-nums">${fmt(fixedShare + varShare)}</span>
                    </div>
                    <div className="text-xs text-muted-foreground">{p.hours.toFixed(1)} hrs ({p.pct.toFixed(0)}%)</div>
                    <div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
                      <span>Fixed: <span className="tabular-nums text-foreground">${fmt(fixedShare)}</span></span>
                      {data.variable_cost > 0 && <span>Fuel: <span className="tabular-nums text-foreground">${fmt(varShare)}</span></span>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {!hasCosts && !hasHours && <p className="text-sm text-muted-foreground">No data for this period</p>}
        </div>
      )}
    </div>
  )
}

// ── Cost Log tab ─────────────────────────────────────────────────────────────

interface MaintenanceTabProps {
  showAddEntry: boolean
  setShowAddEntry: (v: boolean) => void
  showRecurring: boolean
  pendingAddFiles: File[]
  setPendingAddFiles: React.Dispatch<React.SetStateAction<File[]>>
}

function MaintenanceTab({ showAddEntry, setShowAddEntry, showRecurring, pendingAddFiles, setPendingAddFiles }: MaintenanceTabProps) {
  const [entries, setEntries]           = useState<MaintenanceEntry[]>([])
  const [loading, setLoading]           = useState(true)
  const [expandedId, setExpandedId]     = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [saving, setSaving]             = useState(false)
  const [error, setError]               = useState('')
  const [attachReloadKey, setAttachReloadKey] = useState(0)

  const [addDate, setAddDate]           = useState(TODAY)
  const [addCategory, setAddCategory]   = useState<Category>('maintenance')
  const [addTitle, setAddTitle]         = useState('')
  const [addDesc, setAddDesc]           = useState('')
  const [addCost, setAddCost]           = useState('0.00')
  const [addTach, setAddTach]           = useState('')
  const [addPerformedBy, setAddPerformedBy] = useState('')
  const [addError, setAddError]         = useState('')
  const [addSaving, setAddSaving]       = useState(false)

  const [editDate, setEditDate]         = useState('')
  const [editCategory, setEditCategory] = useState<Category>('maintenance')
  const [editTitle, setEditTitle]       = useState('')
  const [editDesc, setEditDesc]         = useState('')
  const [editCost, setEditCost]         = useState('')
  const [editTach, setEditTach]         = useState('')
  const [editPerformedBy, setEditPerformedBy] = useState('')
  const [editPendingFiles, setEditPendingFiles] = useState<File[]>([])

  async function load() {
    setLoading(true)
    try { setEntries(await api.get<MaintenanceEntry[]>('/maintenance')) }
    catch { setError('Failed to load') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  function startEdit(e: MaintenanceEntry) {
    setExpandedId(e.id); setConfirmDeleteId(null)
    setEditDate(e.entry_date); setEditCategory(e.category as Category)
    setEditTitle(e.title); setEditDesc(e.description ?? '')
    setEditCost(e.cost_amount ?? '0.00'); setEditTach(e.tach_at_service ?? '')
    setEditPerformedBy(e.performed_by ?? '')
    setEditPendingFiles([])
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (!expandedId) return
    setSaving(true)
    try {
      await api.patch<MaintenanceEntry>(`/maintenance/${expandedId}`, {
        entry_date: editDate, category: editCategory, title: editTitle,
        description: editDesc || null,
        cost_amount: parseFloat(editCost) || 0,
        tach_at_service: editTach ? parseFloat(editTach) : null,
        performed_by: editPerformedBy || null,
      })
      if (editPendingFiles.length) {
        await Promise.all(editPendingFiles.map(f => uploadAttachment(f, 'log', expandedId)))
        setEditPendingFiles([])
        setAttachReloadKey(k => k + 1)
      }
      setExpandedId(null); await load()
    } catch { setError('Failed to save') }
    finally { setSaving(false) }
  }

  async function handleDelete(id: string) {
    try { await api.delete(`/maintenance/${id}`); setExpandedId(null); setConfirmDeleteId(null); await load() }
    catch { setError('Failed to delete') }
  }

  function resetAdd() {
    setAddDate(TODAY); setAddCategory('maintenance'); setAddTitle('')
    setAddDesc(''); setAddCost('0.00'); setAddTach(''); setAddPerformedBy('')
    setAddError(''); setPendingAddFiles([]); setShowAddEntry(false)
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault()
    if (!addTitle.trim()) { setAddError('Title required'); return }
    setAddSaving(true)
    try {
      const entry = await api.post<MaintenanceEntry>('/maintenance', {
        entry_date: addDate, category: addCategory, title: addTitle.trim(),
        description: addDesc || null,
        cost_amount: parseFloat(addCost) || 0,
        tach_at_service: addTach ? parseFloat(addTach) : null,
        performed_by: addPerformedBy || null,
      })
      if (pendingAddFiles.length) {
        await Promise.all(pendingAddFiles.map(f => uploadAttachment(f, 'log', entry.id)))
      }
      resetAdd(); await load()
    } catch { setAddError('Failed to save') }
    finally { setAddSaving(false) }
  }

  return (
    <div className="space-y-3 p-4">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <InspectionsSection />

      <HourIntervalsSection />

      {showRecurring && <RecurringSection onPosted={load} />}

      {showAddEntry && (
        <form onSubmit={handleAdd} className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">New entry</p>
            <button type="button" onClick={resetAdd}><X className="h-4 w-4 text-muted-foreground" /></button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FF label="Date"><Input type="date" value={addDate} onChange={e => setAddDate(e.target.value)} required /></FF>
            <FF label="Category"><CatSelect value={addCategory} onChange={v => setAddCategory(v)} /></FF>
          </div>
          <FF label="Title"><Input value={addTitle} onChange={e => setAddTitle(e.target.value)} placeholder="Annual inspection, Insurance premium…" required /></FF>
          <FF label={<>Description <Opt /></>}><Textarea value={addDesc} onChange={e => setAddDesc(e.target.value)} rows={2} /></FF>
          <div className="grid grid-cols-2 gap-3">
            <FF label="Cost ($)"><Input type="number" step="0.01" min="0" value={addCost} onChange={e => setAddCost(e.target.value)} placeholder="0.00" /></FF>
            <FF label={<>Hobbs <Opt /></>}><Input type="number" step="0.1" min="0" value={addTach} onChange={e => setAddTach(e.target.value)} placeholder="1849.2" /></FF>
          </div>
          <FF label={<>Performed by <Opt /></>}><Input value={addPerformedBy} onChange={e => setAddPerformedBy(e.target.value)} placeholder="KPAO Avionics, self…" /></FF>
          <AttachButton onFiles={fs => setPendingAddFiles(prev => [...prev, ...fs])} />
          <StagedFileList files={pendingAddFiles} onRemove={i => setPendingAddFiles(prev => prev.filter((_, j) => j !== i))} />
          {addError && <p className="text-xs text-destructive">{addError}</p>}
          <Button type="submit" size="sm" className="w-full" disabled={addSaving}>{addSaving ? 'Saving…' : 'Add entry'}</Button>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : entries.length === 0 && !showAddEntry ? (
        <p className="text-sm text-muted-foreground">No entries yet. Use + Add to create one.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map(entry => {
            const d = new Date(entry.entry_date + 'T12:00:00')
            return (
              <li key={entry.id} className="rounded-lg border bg-card">
                <button type="button" className="flex w-full items-start gap-3 p-3 text-left"
                  onClick={() => expandedId === entry.id ? setExpandedId(null) : startEdit(entry)}>
                  <div className="flex w-9 shrink-0 flex-col items-center rounded-md bg-muted py-1 text-center">
                    <span className="text-[9px] uppercase text-muted-foreground">{d.toLocaleDateString('en-US', { month: 'short' })}</span>
                    <span className="text-base font-bold leading-none">{d.getDate()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium">{entry.title}</p>
                    <Badge variant="outline" className="mt-1 text-[10px] px-1.5 py-0 capitalize">{entry.category}</Badge>
                  </div>
                  {entry.cost_amount && (
                    <span className="shrink-0 text-sm font-medium tabular-nums">${fmt(parseFloat(entry.cost_amount))}</span>
                  )}
                </button>

                {expandedId === entry.id && (
                  <form onSubmit={handleSave} className="border-t px-3 pb-3 pt-2 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <FF label="Date"><Input type="date" value={editDate} onChange={e => setEditDate(e.target.value)} required /></FF>
                      <FF label="Category"><CatSelect value={editCategory} onChange={v => setEditCategory(v)} /></FF>
                    </div>
                    <FF label="Title"><Input value={editTitle} onChange={e => setEditTitle(e.target.value)} required /></FF>
                    <FF label={<>Description <Opt /></>}><Textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} rows={2} /></FF>
                    <div className="grid grid-cols-2 gap-3">
                      <FF label="Cost ($)"><Input type="number" step="0.01" min="0" value={editCost} onChange={e => setEditCost(e.target.value)} /></FF>
                      <FF label={<>Hobbs <Opt /></>}><Input type="number" step="0.1" min="0" value={editTach} onChange={e => setEditTach(e.target.value)} /></FF>
                    </div>
                    <FF label={<>Performed by <Opt /></>}><Input value={editPerformedBy} onChange={e => setEditPerformedBy(e.target.value)} /></FF>
                    <AttachButton onFiles={fs => setEditPendingFiles(prev => [...prev, ...fs])} />
                    <StagedFileList files={editPendingFiles} onRemove={i => setEditPendingFiles(prev => prev.filter((_, j) => j !== i))} />
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" className="flex-1" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => setExpandedId(null)}>Cancel</Button>
                    </div>
                    <AttachmentStrip parentType="log" parentId={entry.id} reloadKey={attachReloadKey} />
                    <div className="border-t pt-2 text-center">
                      {confirmDeleteId === entry.id ? (
                        <button type="button" className="text-xs font-medium text-destructive" onClick={() => handleDelete(entry.id)}>Confirm delete</button>
                      ) : (
                        <button type="button" className="text-xs text-muted-foreground hover:text-destructive" onClick={() => setConfirmDeleteId(entry.id)}>Delete entry</button>
                      )}
                    </div>
                  </form>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <CostAnalysisSection />
    </div>
  )
}

// ── Recurring section (inline, no tab) ───────────────────────────────────────

function InspectionsSection() {
  const [items, setItems]   = useState<InspectionItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [title, setTitle]   = useState('')
  const [months, setMonths] = useState('')
  const [due, setDue]       = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    try { setItems(await api.get<InspectionItem[]>('/maintenance/inspections')) }
    catch { setError('Failed to load') } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function handleAdd(e: FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await api.post('/maintenance/inspections', { title: title.trim(), interval_months: months ? parseInt(months) : null, due_date: due || null })
      setTitle(''); setMonths(''); setDue(''); setShowAdd(false)
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to save') }
    finally { setSaving(false) }
  }

  async function setDueDate(id: string, value: string) {
    try { await api.patch(`/maintenance/inspections/${id}`, { due_date: value || null }); await load() }
    catch { setError('Failed to save date') }
  }

  async function markDone(i: InspectionItem) {
    const date = prompt(`Date "${i.title}" was completed (YYYY-MM-DD):`, new Date().toLocaleDateString('en-CA'))
    if (!date) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { setError('Use the format YYYY-MM-DD'); return }
    try { await api.post(`/maintenance/inspections/${i.id}/done`, { date }); await load() }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed') }
  }

  async function remove(id: string) {
    if (!confirm('Remove this item?')) return
    try { await api.delete(`/maintenance/inspections/${id}`); await load() }
    catch { setError('Failed to remove') }
  }

  const tone = (s: InspectionItem['status']) =>
    s === 'overdue' ? 'text-destructive font-medium'
    : s === 'due_soon' ? 'text-amber-600 dark:text-amber-400 font-medium'
    : s === 'no_date' ? 'text-amber-600 dark:text-amber-400'
    : 'text-muted-foreground'
  const label = (i: InspectionItem) =>
    i.status === 'no_date' ? 'date needed'
    : i.status === 'overdue' ? `${Math.abs(i.days_until!)} days overdue`
    : `${i.days_until} days`

  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">Inspections &amp; expirations</p>
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setShowAdd(v => !v)}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}

      {showAdd && (
        <form onSubmit={handleAdd} className="rounded-md border bg-background p-3 space-y-3">
          <FF label="Item"><Input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Fire extinguisher check" required /></FF>
          <div className="grid grid-cols-2 gap-3">
            <FF label="Due date"><Input type="date" value={due} onChange={e => setDue(e.target.value)} /></FF>
            <FF label="Repeats every (months)"><Input type="number" min="1" value={months} onChange={e => setMonths(e.target.value)} placeholder="12" /></FF>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="flex-1" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {loading ? <p className="text-xs text-muted-foreground">Loading…</p> : (
        <ul className="space-y-2">
          {items.map(i => (
            <li key={i.id} className="rounded-md border bg-background p-2.5">
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-sm font-medium">{i.title}</p>
                <span className={`shrink-0 text-xs tabular-nums ${tone(i.status)}`}>{label(i)}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <input
                  type="date"
                  defaultValue={i.due_date ?? ''}
                  key={i.due_date ?? 'none'}
                  onClick={openPicker}
                  onBlur={e => { if (e.target.value !== (i.due_date ?? '')) setDueDate(i.id, e.target.value) }}
                  className="rounded-md border border-input bg-background px-2 py-1 text-xs"
                />
                <span className="text-[11px] text-muted-foreground">
                  {i.interval_months ? `every ${i.interval_months} mo` : 'no repeat'}{i.last_done_date ? ` · last ${i.last_done_date}` : ''}
                </span>
                <span className="flex-1" />
                {i.interval_months ? (
                  <Button size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" onClick={() => markDone(i)}>Done</Button>
                ) : null}
                <button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-destructive" onClick={() => remove(i.id)}>✕</button>
              </div>
              {i.notes && <p className="mt-1 text-[11px] text-muted-foreground">{i.notes}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function HourIntervalsSection() {
  const [items, setItems]       = useState<MaintenanceInterval[]>([])
  const [current, setCurrent]   = useState<number | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState('')
  const [showAdd, setShowAdd]   = useState(false)
  const [title, setTitle]       = useState('')
  const [interval, setIntervalHrs] = useState('')
  const [lastDone, setLastDone] = useState('')
  const [warn, setWarn]         = useState('10')
  const [saving, setSaving]     = useState(false)
  const [busyId, setBusyId]     = useState<string | null>(null)

  async function load() {
    try {
      const r = await api.get<{ current_hours: number | null; items: MaintenanceInterval[] }>('/maintenance/intervals')
      setItems(r.items); setCurrent(r.current_hours)
    } catch { setError('Failed to load') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function handleAdd(e: FormEvent) {
    e.preventDefault()
    setSaving(true); setError('')
    try {
      await api.post('/maintenance/intervals', {
        title: title.trim(), interval_hours: parseFloat(interval),
        last_done_hours: lastDone === '' ? undefined : parseFloat(lastDone),
        warn_hours: parseFloat(warn) || 10,
      })
      setTitle(''); setIntervalHrs(''); setLastDone(''); setWarn('10'); setShowAdd(false)
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to save') }
    finally { setSaving(false) }
  }

  async function markDone(id: string) {
    if (!confirm(`Mark done at the current Flight timer${current != null ? ` (${current.toFixed(1)})` : ''}?`)) return
    setBusyId(id)
    try { await api.post(`/maintenance/intervals/${id}/done`, {}); await load() }
    catch (err) { setError(err instanceof Error ? err.message : 'Failed') }
    finally { setBusyId(null) }
  }

  async function remove(id: string) {
    if (!confirm('Remove this interval?')) return
    try { await api.delete(`/maintenance/intervals/${id}`); await load() }
    catch { setError('Failed to remove') }
  }

  const tone = (s: MaintenanceInterval['status']) =>
    s === 'overdue' ? 'text-destructive font-medium'
    : s === 'due_soon' ? 'text-amber-600 dark:text-amber-400 font-medium'
    : 'text-muted-foreground'

  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">
          Hour-based maintenance{current != null && <span className="font-normal"> · Flight timer {current.toFixed(1)}</span>}
        </p>
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setShowAdd(v => !v)}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {showAdd && (
        <form onSubmit={handleAdd} className="rounded-md border bg-background p-3 space-y-3">
          <FF label="Item"><Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Oil change" required /></FF>
          <div className="grid grid-cols-3 gap-3">
            <FF label="Every (hrs)"><Input type="number" step="0.1" min="0.1" value={interval} onChange={e => setIntervalHrs(e.target.value)} placeholder="50" required /></FF>
            <FF label="Last done at"><Input type="number" step="0.1" min="0" value={lastDone} onChange={e => setLastDone(e.target.value)} placeholder={current != null ? current.toFixed(1) : 'Flight timer'} /></FF>
            <FF label="Warn within"><Input type="number" step="0.1" min="0" value={warn} onChange={e => setWarn(e.target.value)} /></FF>
          </div>
          <p className="text-xs text-muted-foreground">Hours are Flight-timer hours. Leave "Last done at" blank to start from the current reading.</p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="flex-1" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : items.length === 0 && !showAdd ? (
        <p className="text-xs text-muted-foreground">No hour-based items — add one, e.g. oil change every 50 hrs</p>
      ) : (
        <ul className="space-y-2">
          {items.map(i => (
            <li key={i.id} className="flex items-center gap-2 rounded-md border bg-background p-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{i.title}</p>
                <p className="text-xs text-muted-foreground">
                  every {i.interval_hours} hrs · last at {i.last_done_hours.toFixed(1)} · due at {i.next_due_hours.toFixed(1)}
                </p>
              </div>
              <span className={`shrink-0 text-sm tabular-nums ${tone(i.status)}`}>
                {i.hours_remaining == null ? '—'
                  : i.hours_remaining < 0 ? `${Math.abs(i.hours_remaining).toFixed(1)} over`
                  : `${i.hours_remaining.toFixed(1)} left`}
              </span>
              <Button size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" disabled={busyId === i.id} onClick={() => markDone(i.id)}>
                {busyId === i.id ? '…' : 'Done'}
              </Button>
              <button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-destructive" onClick={() => remove(i.id)}>✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RecurringSection({ onPosted }: { onPosted: () => void }) {
  const [items, setItems]               = useState<MaintenanceRecurring[]>([])
  const [loading, setLoading]           = useState(true)
  const [expandedId, setExpandedId]     = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [saving, setSaving]             = useState(false)
  const [posting, setPosting]           = useState<string | null>(null)
  const [error, setError]               = useState('')

  const [showAdd, setShowAdd]           = useState(false)
  const [addCategory, setAddCategory]   = useState<Category>('hangar')
  const [addTitle, setAddTitle]         = useState('')
  const [addDesc, setAddDesc]           = useState('')
  const [addCost, setAddCost]           = useState('')
  const [addDay, setAddDay]             = useState('1')
  const [addDue, setAddDue]             = useState(TODAY)
  const [addError, setAddError]         = useState('')
  const [addSaving, setAddSaving]       = useState(false)

  const [editCategory, setEditCategory] = useState<Category>('hangar')
  const [editTitle, setEditTitle]       = useState('')
  const [editDesc, setEditDesc]         = useState('')
  const [editCost, setEditCost]         = useState('')
  const [editDay, setEditDay]           = useState('1')
  const [editDue, setEditDue]           = useState('')

  async function load() {
    setLoading(true)
    try { setItems(await api.get<MaintenanceRecurring[]>('/maintenance/recurring')) }
    catch { setError('Failed to load') }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  function startEdit(r: MaintenanceRecurring) {
    setExpandedId(r.id); setConfirmDeleteId(null)
    setEditCategory(r.category as Category); setEditTitle(r.title)
    setEditDesc(r.description ?? ''); setEditCost(r.cost_amount)
    setEditDay(String(r.day_of_month)); setEditDue(r.next_due_date)
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (!expandedId) return
    setSaving(true)
    try {
      await api.patch<MaintenanceRecurring>(`/maintenance/recurring/${expandedId}`, {
        category: editCategory, title: editTitle, description: editDesc || null,
        cost_amount: parseFloat(editCost), day_of_month: parseInt(editDay), next_due_date: editDue,
      })
      setExpandedId(null); await load()
    } catch { setError('Failed to save') }
    finally { setSaving(false) }
  }

  async function handlePost(id: string) {
    setPosting(id)
    try { await api.post(`/maintenance/recurring/${id}/post`, {}); await load(); onPosted() }
    catch { setError('Failed to post') }
    finally { setPosting(null) }
  }

  async function handleDelete(id: string) {
    try { await api.delete(`/maintenance/recurring/${id}`); setExpandedId(null); setConfirmDeleteId(null); await load() }
    catch { setError('Failed to delete') }
  }

  function resetAdd() {
    setAddCategory('hangar'); setAddTitle(''); setAddDesc('')
    setAddCost(''); setAddDay('1'); setAddDue(TODAY)
    setAddError(''); setShowAdd(false)
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault()
    if (!addTitle.trim()) { setAddError('Title required'); return }
    if (!addCost || parseFloat(addCost) <= 0) { setAddError('Cost must be positive'); return }
    setAddSaving(true)
    try {
      await api.post<MaintenanceRecurring>('/maintenance/recurring', {
        category: addCategory, title: addTitle.trim(), description: addDesc || null,
        cost_amount: parseFloat(addCost), day_of_month: parseInt(addDay) || 1, next_due_date: addDue,
      })
      resetAdd(); await load()
    } catch { setAddError('Failed to save') }
    finally { setAddSaving(false) }
  }

  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">Recurring costs</p>
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setShowAdd(v => !v)}>
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {showAdd && (
        <form onSubmit={handleAdd} className="rounded-md border bg-background p-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <FF label="Category"><CatSelect value={addCategory} onChange={v => setAddCategory(v)} /></FF>
            <FF label="Cost ($)"><Input type="number" step="0.01" min="0.01" value={addCost} onChange={e => setAddCost(e.target.value)} placeholder="0.00" required /></FF>
          </div>
          <FF label="Title"><Input value={addTitle} onChange={e => setAddTitle(e.target.value)} placeholder="Hangar rent…" required /></FF>
          <FF label={<>Description <Opt /></>}><Textarea value={addDesc} onChange={e => setAddDesc(e.target.value)} rows={2} /></FF>
          <div className="grid grid-cols-2 gap-3">
            <FF label="Day of month"><Input type="number" min="1" max="28" value={addDay} onChange={e => setAddDay(e.target.value)} required /></FF>
            <FF label="Next due date"><Input type="date" value={addDue} onChange={e => setAddDue(e.target.value)} required /></FF>
          </div>
          {addError && <p className="text-xs text-destructive">{addError}</p>}
          <div className="flex gap-2">
            <Button type="submit" size="sm" className="flex-1" disabled={addSaving}>{addSaving ? 'Saving…' : 'Save'}</Button>
            <Button type="button" variant="outline" size="sm" onClick={resetAdd}>Cancel</Button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : items.length === 0 && !showAdd ? (
        <p className="text-xs text-muted-foreground">No recurring costs</p>
      ) : (
        <ul className="space-y-2">
          {items.map(r => (
            <li key={r.id} className="rounded-md border bg-background">
              <div className="flex w-full items-center gap-2 p-2.5">
                <button type="button" className="flex flex-1 items-center gap-2 text-left min-w-0"
                  onClick={() => expandedId === r.id ? setExpandedId(null) : startEdit(r)}>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium">{r.title}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 capitalize">{r.category}</Badge>
                      <span className="text-xs text-muted-foreground">due {r.next_due_date}</span>
                    </div>
                  </div>
                  <span className="shrink-0 text-sm tabular-nums">${fmt(parseFloat(r.cost_amount))}</span>
                </button>
                <Button size="sm" variant="outline" className="shrink-0 h-7 text-xs px-2"
                  disabled={posting === r.id} onClick={() => handlePost(r.id)}>
                  {posting === r.id ? '…' : 'Post'}
                </Button>
              </div>

              {expandedId === r.id && (
                <form onSubmit={handleSave} className="border-t px-3 pb-3 pt-2 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <FF label="Category"><CatSelect value={editCategory} onChange={v => setEditCategory(v)} /></FF>
                    <FF label="Cost ($)"><Input type="number" step="0.01" min="0.01" value={editCost} onChange={e => setEditCost(e.target.value)} required /></FF>
                  </div>
                  <FF label="Title"><Input value={editTitle} onChange={e => setEditTitle(e.target.value)} required /></FF>
                  <FF label={<>Description <Opt /></>}><Textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} rows={2} /></FF>
                  <div className="grid grid-cols-2 gap-3">
                    <FF label="Day of month"><Input type="number" min="1" max="28" value={editDay} onChange={e => setEditDay(e.target.value)} required /></FF>
                    <FF label="Next due date"><Input type="date" value={editDue} onChange={e => setEditDue(e.target.value)} required /></FF>
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" className="flex-1" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setExpandedId(null)}>Cancel</Button>
                  </div>
                  <div className="border-t pt-2 text-center">
                    {confirmDeleteId === r.id ? (
                      <button type="button" className="text-xs font-medium text-destructive" onClick={() => handleDelete(r.id)}>Confirm delete</button>
                    ) : (
                      <button type="button" className="text-xs text-muted-foreground hover:text-destructive" onClick={() => setConfirmDeleteId(r.id)}>Remove</button>
                    )}
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── Logbook tab ──────────────────────────────────────────────────────────────

const LOGBOOK_CATEGORY_LABELS: Record<LogbookCategory, string> = {
  airframe: 'Airframe',
  engine: 'Engine',
  prop: 'Prop',
  ad_sb_compliance: 'AD/SB Compliance',
  other: 'Other',
}

const LOGBOOK_CATEGORY_ORDER: LogbookCategory[] = ['airframe', 'engine', 'prop', 'ad_sb_compliance', 'other']

type ChatTurn = { question: string; answer: string; citations: LogbookCitation[] }

function LogbookChat() {
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState('')
  const [turns, setTurns] = useState<ChatTurn[]>([])

  async function handleAsk(e: FormEvent) {
    e.preventDefault()
    const q = question.trim()
    if (!q) return
    setAsking(true)
    setError('')
    try {
      const history = turns.map(t => ({ question: t.question, answer: t.answer }))
      const res = await logbookApi.ask(q, history)
      setTurns(prev => [...prev, { question: q, answer: res.answer, citations: res.citations }])
      setQuestion('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to get an answer')
    } finally {
      setAsking(false)
    }
  }

  function handleClear() {
    setTurns([])
    setError('')
  }

  return (
    <div className="rounded-lg border bg-card p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">Ask about the logbooks</p>
        {turns.length > 0 && (
          <button type="button" onClick={handleClear} className="text-xs text-muted-foreground hover:text-foreground">
            Clear
          </button>
        )}
      </div>

      {turns.length > 0 && (
        <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
          {turns.map((t, i) => (
            <div key={i} className="space-y-1.5">
              <p className="text-sm font-medium">{t.question}</p>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{t.answer}</p>
              {t.citations.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {t.citations.map(c => (
                    <a
                      key={c.id}
                      href={logbookApi.sourceUrl(c.document_id)}
                      target="_blank"
                      rel="noreferrer"
                      title={c.summary}
                      className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
                    >
                      {LOGBOOK_CATEGORY_LABELS[c.category]} · {c.source_filename} p.{c.page_number ?? '?'}
                      {c.entry_date ? ` · ${c.entry_date}` : ''}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      <form onSubmit={handleAsk} className="flex gap-2">
        <Input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="e.g. What's the history of cylinder compressions?"
          className="text-sm"
        />
        <Button type="submit" size="sm" disabled={asking || !question.trim()}>
          {asking ? '…' : 'Ask'}
        </Button>
      </form>
    </div>
  )
}

function LogbookDateChip({ date }: { date: string | null }) {
  if (!date) {
    return (
      <div className="flex w-12 shrink-0 flex-col items-center justify-center rounded-md bg-muted py-1 text-center text-xs text-muted-foreground">
        —
      </div>
    )
  }
  const d = new Date(date + 'T12:00')
  return (
    <div className="flex w-12 shrink-0 flex-col items-center rounded-md bg-muted py-1 text-center">
      <span className="text-[9px] uppercase leading-tight text-muted-foreground">
        {d.toLocaleDateString('en-US', { month: 'short' })}
      </span>
      <span className="text-lg font-bold leading-none">{d.getDate()}</span>
      <span className="text-[9px] leading-tight text-muted-foreground">{d.getFullYear()}</span>
    </div>
  )
}

function LogbookEntryRow({ entry, onOpen }: { entry: LogbookEntry; onOpen: () => void }) {
  return (
    <li className="rounded-lg border bg-card">
      <button type="button" className="flex w-full items-start gap-3 p-3 text-left hover:bg-accent/40 transition-colors" onClick={onOpen}>
        <LogbookDateChip date={entry.entry_date} />
        <div className="flex-1 min-w-0">
          <p className="truncate text-sm font-medium">{entry.summary}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">{LOGBOOK_CATEGORY_LABELS[entry.category]}</Badge>
            <span className="text-[10px] text-muted-foreground">{entry.source_filename} p.{entry.page_number ?? '?'}</span>
            {entry.needs_review && <Badge variant="warning" className="text-[10px] px-1.5 py-0">Needs review</Badge>}
          </div>
        </div>
      </button>
    </li>
  )
}

function LogbookEntryModal({
  entries, index, onClose, onNavigate, onSaved,
}: {
  entries: LogbookEntry[]
  index: number
  onClose: () => void
  onNavigate: (index: number) => void
  onSaved: (e: LogbookEntry) => void
}) {
  const entry = entries[index]
  const [editDate, setEditDate] = useState(entry.entry_date ?? '')
  const [editSummary, setEditSummary] = useState(entry.summary)
  const [editRawText, setEditRawText] = useState(entry.raw_text)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setEditDate(entry.entry_date ?? '')
    setEditSummary(entry.summary)
    setEditRawText(entry.raw_text)
    setError('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id])

  const dirty = editDate !== (entry.entry_date ?? '') || editSummary !== entry.summary || editRawText !== entry.raw_text

  async function doSave() {
    setSaving(true)
    setError('')
    try {
      const updated = await logbookApi.updateEntry(entry.id, {
        entry_date: editDate || null,
        summary: editSummary,
        raw_text: editRawText,
      })
      onSaved(updated)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
      return false
    } finally {
      setSaving(false)
    }
  }

  // If there are unsaved edits, confirm whether to save them before navigating away/closing.
  async function guarded(action: () => void) {
    if (dirty) {
      const shouldSave = window.confirm('You have unsaved changes to this entry. Save them before continuing?')
      if (shouldSave) {
        const ok = await doSave()
        if (!ok) return
      }
    }
    action()
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    await doSave()
  }

  async function toggleReviewed() {
    try {
      const updated = await logbookApi.updateEntry(entry.id, { needs_review: !entry.needs_review })
      onSaved(updated)
    } catch { /* surfaced via badge staying unchanged */ }
  }

  const fieldEntries = Object.entries(entry.fields || {})

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 pb-20"
      onClick={e => { if (e.target === e.currentTarget) guarded(onClose) }}
    >
      <div className="flex h-[calc(100vh-6rem)] w-full max-w-3xl flex-col rounded-xl border border-border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-2.5">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">{LOGBOOK_CATEGORY_LABELS[entry.category]}</Badge>
            {entry.needs_review && <Badge variant="warning" className="text-[10px] px-1.5 py-0">Needs review</Badge>}
          </div>
          <button type="button" onClick={() => guarded(onClose)} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-1 min-h-0 flex-col gap-3 px-5 py-3">
          <div className="grid flex-none grid-cols-[8rem_1fr] gap-3">
            <FF label="Date"><Input type="date" value={editDate} onChange={e => setEditDate(e.target.value)} /></FF>
            <FF label="Summary"><Input value={editSummary} onChange={e => setEditSummary(e.target.value)} required /></FF>
          </div>

          <div className="grid flex-1 min-h-0 gap-3 sm:grid-cols-2">
            <div className="flex min-h-0 flex-col space-y-1.5">
              <Label>Transcription</Label>
              <Textarea
                value={editRawText}
                onChange={e => setEditRawText(e.target.value)}
                className="min-h-0 flex-1 resize-none"
              />
            </div>

            <div className="flex min-h-0 flex-col space-y-3 overflow-y-auto pr-1">
              {fieldEntries.length > 0 && (
                <div className="space-y-1">
                  <Label>Extracted fields</Label>
                  <div className="max-h-32 space-y-1 overflow-y-auto rounded-md bg-muted/30 p-2 text-xs">
                    {fieldEntries.map(([k, v]) => (
                      <div key={k} className="truncate"><span className="text-muted-foreground">{k}:</span> {Array.isArray(v) ? v.join(', ') : String(v)}</div>
                    ))}
                  </div>
                </div>
              )}

              {entry.tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {entry.tags.map(t => <Badge key={t} variant="secondary" className="text-[10px] px-1.5 py-0">{t}</Badge>)}
                </div>
              )}

              <div className="text-xs text-muted-foreground">
                <p>{entry.source_filename} p.{entry.page_number ?? '?'}</p>
                <a href={logbookApi.sourceUrl(entry.document_id)} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  View original scan →
                </a>
              </div>
            </div>
          </div>

          {error && <p className="flex-none text-xs text-destructive">{error}</p>}

          <div className="flex flex-none gap-2">
            <Button type="submit" size="sm" className="flex-1" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            <Button type="button" size="sm" variant="outline" onClick={toggleReviewed}>
              {entry.needs_review ? 'Mark reviewed' : 'Needs review'}
            </Button>
          </div>
        </form>

        <div className="flex items-center justify-between border-t px-5 py-3">
          <Button type="button" size="sm" variant="outline" onClick={() => guarded(() => onNavigate(index - 1))} disabled={index <= 0}>
            ← Previous
          </Button>
          <span className="text-xs text-muted-foreground">{index + 1} of {entries.length}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => guarded(() => onNavigate(index + 1))} disabled={index >= entries.length - 1}>
            Next →
          </Button>
        </div>
      </div>
    </div>
  )
}

function LogbookImportForm({ onImported, onClose }: { onImported: () => void; onClose: () => void }) {
  const [category, setCategory] = useState<LogbookCategory>('engine')
  const [file, setFile] = useState<File | null>(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ entries: LogbookEntry[] } | null>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleImport() {
    if (!file) return
    setImporting(true)
    setError('')
    setResult(null)
    try {
      const res = await logbookApi.import(category, file)
      setResult(res)
      setFile(null)
      onImported()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Import a new logbook entry</p>
        <button type="button" onClick={onClose}><X className="h-4 w-4 text-muted-foreground" /></button>
      </div>
      <p className="text-xs text-muted-foreground">
        Photograph or scan just the new page — no need to re-upload the whole logbook.
      </p>

      <div className="space-y-1.5">
        <Label>Category</Label>
        <Select
          value={category}
          onChange={e => setCategory(e.target.value as LogbookCategory)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          {Object.entries(LOGBOOK_CATEGORY_LABELS).map(([k, label]) => (
            <option key={k} value={k}>{label}</option>
          ))}
        </Select>
      </div>

      {file ? (
        <div className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
          <span className="flex-1 truncate">{file.name}</span>
          <button type="button" onClick={() => setFile(null)} className="text-muted-foreground hover:text-foreground">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => cameraRef.current?.click()}
            className="flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Camera className="h-3.5 w-3.5" /> Snap Photo
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <Paperclip className="h-3.5 w-3.5" /> Choose File
          </button>
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden"
            onChange={e => setFile(e.target.files?.[0] ?? null)} />
          <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden"
            onChange={e => setFile(e.target.files?.[0] ?? null)} />
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {result && (
        <div className="rounded-md bg-emerald-50 px-2.5 py-2 text-xs text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400">
          Imported {result.entries.length} {result.entries.length === 1 ? 'entry' : 'entries'}.
          {result.entries.some(e => e.needs_review) && ' Check the "Needs review" entries below.'}
        </div>
      )}

      <Button type="button" size="sm" className="w-full" disabled={!file || importing} onClick={handleImport}>
        {importing ? 'Reading document…' : 'Import'}
      </Button>
    </div>
  )
}

function LogbookTab({ showImport, setShowImport }: { showImport: boolean; setShowImport: (v: boolean) => void }) {
  const [documents, setDocuments] = useState<LogbookDocument[]>([])
  const [entries, setEntries] = useState<LogbookEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [category, setCategory] = useState<LogbookCategory | 'all'>('all')
  const [reviewFilter, setReviewFilter] = useState<'all' | 'needs_review'>('all')
  const [search, setSearch] = useState('')
  const [sortOrder, setSortOrder] = useState<'desc' | 'asc'>('desc')
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  function loadDocuments() {
    logbookApi.documents().then(setDocuments).catch(() => {})
  }

  function loadEntries() {
    setLoading(true)
    setError('')
    logbookApi.entries({
      category: category === 'all' ? undefined : category,
      q: search.trim() || undefined,
      needs_review: reviewFilter === 'needs_review' ? true : undefined,
      order: sortOrder,
    })
      .then(setEntries)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }

  useEffect(loadDocuments, [])
  useEffect(loadEntries, [category, reviewFilter, search, sortOrder])

  function handleImported() {
    loadDocuments()
    loadEntries()
  }

  function handleEntrySaved(updated: LogbookEntry) {
    setEntries(prev => prev.map(e => e.id === updated.id ? { ...e, ...updated, source_filename: e.source_filename } : e))
  }

  // Aggregate per-document counts up to the category level — a category can span several
  // physical documents (e.g. Airframe was imported in multiple chunks).
  const categoryTotals = new Map<LogbookCategory, { entry_count: number; needs_review_count: number }>()
  for (const d of documents) {
    const cur = categoryTotals.get(d.category) ?? { entry_count: 0, needs_review_count: 0 }
    cur.entry_count += d.entry_count
    cur.needs_review_count += d.needs_review_count
    categoryTotals.set(d.category, cur)
  }
  const availableCategories = LOGBOOK_CATEGORY_ORDER.filter(c => categoryTotals.has(c))
  const needsReviewCountForSelection = category === 'all'
    ? [...categoryTotals.values()].reduce((s, c) => s + c.needs_review_count, 0)
    : categoryTotals.get(category)?.needs_review_count ?? 0

  function selectCategory(c: LogbookCategory | 'all') {
    setCategory(c)
    setReviewFilter('all')
  }

  return (
    <div className="space-y-3 p-4">
      {showImport && (
        <LogbookImportForm onImported={handleImported} onClose={() => setShowImport(false)} />
      )}

      <LogbookChat />

      {documents.length === 0 && !loading ? (
        <p className="text-sm text-muted-foreground">No logbooks imported yet.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {availableCategories.map(c => {
            const t = categoryTotals.get(c)!
            return (
              <span key={c} className="rounded-full border px-2 py-0.5">
                {LOGBOOK_CATEGORY_LABELS[c]}: {t.entry_count}
                {t.needs_review_count > 0 && <span className="text-amber-600 dark:text-amber-400"> ({t.needs_review_count} to review)</span>}
              </span>
            )
          })}
        </div>
      )}

      <div className="space-y-2">
        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search transcriptions (e.g. compression, oil filter, AD 2020-23)…"
          className="h-8 text-sm"
        />
        <div className="flex flex-wrap gap-2">
          <button onClick={() => selectCategory('all')}
            className={cn('rounded-full border px-3 py-1 text-xs transition-colors',
              category === 'all' ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border text-muted-foreground')}>
            All
          </button>
          {availableCategories.map(c => (
            <button key={c} onClick={() => selectCategory(c)}
              className={cn('rounded-full border px-3 py-1 text-xs transition-colors',
                category === c ? 'border-primary bg-primary/10 text-primary font-medium' : 'border-border text-muted-foreground')}>
              {LOGBOOK_CATEGORY_LABELS[c]}
            </button>
          ))}
          {needsReviewCountForSelection > 0 && (
            <button onClick={() => setReviewFilter(f => f === 'needs_review' ? 'all' : 'needs_review')}
              className={cn('rounded-full border px-3 py-1 text-xs transition-colors',
                reviewFilter === 'needs_review' ? 'border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400 font-medium' : 'border-border text-muted-foreground')}>
              Needs review ({needsReviewCountForSelection})
            </button>
          )}
          <button
            onClick={() => setSortOrder(o => o === 'desc' ? 'asc' : 'desc')}
            className="ml-auto rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {sortOrder === 'desc' ? '↓ Newest' : '↑ Oldest'}
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No entries match.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e, i) => <LogbookEntryRow key={e.id} entry={e} onOpen={() => setOpenIndex(i)} />)}
        </ul>
      )}

      {openIndex !== null && entries[openIndex] && (
        <LogbookEntryModal
          entries={entries}
          index={openIndex}
          onClose={() => setOpenIndex(null)}
          onNavigate={setOpenIndex}
          onSaved={handleEntrySaved}
        />
      )}
    </div>
  )
}

// ── Main page ────────────────────────────────────────────────────────────────

export function MaintenancePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [tab, setTab]                         = useState<Tab>('squawks')
  const [showRecurring, setShowRecurring]      = useState(false)
  const [showAddEntry, setShowAddEntry]        = useState(false)
  const [showAddSquawk, setShowAddSquawk]      = useState(false)
  const [showImportLogbook, setShowImportLogbook] = useState(false)
  const [logPendingFiles, setLogPendingFiles]  = useState<File[]>([])
  const [sqPendingFiles, setSqPendingFiles]    = useState<File[]>([])

  useEffect(() => {
    if (searchParams.get('add') === 'squawk') {
      setTab('squawks')
      setShowAddSquawk(true)
    }
    if (searchParams.get('tab') === 'engine') setTab('engine')
    if (searchParams.get('add') === 'entry') {
      setTab('log')
      setShowAddEntry(true)
    }
  }, [])

  function handleTabChange(t: Tab) {
    setTab(t)
    setShowRecurring(false)
    setShowAddEntry(false)
    setShowAddSquawk(false)
    setShowImportLogbook(false)
    setLogPendingFiles([])
    setSqPendingFiles([])
  }

  function handleLogDrop(e: React.DragEvent) {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files).filter(
      f => f.type.startsWith('image/') || f.type === 'application/pdf'
    )
    if (files.length) {
      setShowAddEntry(true)
      setLogPendingFiles(prev => [...prev, ...files])
    }
  }

  function handleSqDrop(e: React.DragEvent) {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files).filter(
      f => f.type.startsWith('image/') || f.type === 'application/pdf'
    )
    if (files.length) {
      setShowAddSquawk(true)
      setSqPendingFiles(prev => [...prev, ...files])
    }
  }

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 border-b bg-background">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">Maintenance</h1>
            <button
              type="button"
              onClick={() => navigate('/invoices')}
              className="flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
              title="Maintenance invoices"
            >
              <FileText className="h-3.5 w-3.5" /> Invoices
            </button>
          </div>
          {tab === 'squawks' && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => { window.location.href = '/api/export/squawks.csv' }}
                className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
                title="Download CSV"
              >
                <Download className="h-4 w-4" />
              </button>
              <Button
                size="sm"
                onDragOver={e => e.preventDefault()}
                onDrop={handleSqDrop}
                onClick={() => setShowAddSquawk(v => !v)}
              >
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>
          )}
          {tab === 'log' && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => { window.location.href = '/api/export/maintenance.csv' }}
                className="rounded-md p-1.5 text-muted-foreground hover:text-foreground"
                title="Download CSV"
              >
                <Download className="h-4 w-4" />
              </button>
              <button
                onClick={() => setShowRecurring(v => !v)}
                className={cn('rounded-md p-1.5 transition-colors',
                  showRecurring ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
                title="Recurring costs"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
              <Button
                size="sm"
                onDragOver={e => e.preventDefault()}
                onDrop={handleLogDrop}
                onClick={() => setShowAddEntry(v => !v)}
              >
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>
          )}
          {tab === 'logbook' && (
            <Button size="sm" onClick={() => setShowImportLogbook(v => !v)}>
              <Plus className="h-4 w-4" /> Add
            </Button>
          )}
        </div>
        <div className="flex border-b px-4">
          {(['squawks', 'log', 'logbook', 'engine'] as Tab[]).map(t => (
            <button key={t} onClick={() => handleTabChange(t)}
              className={cn('pb-2 pr-4 text-sm font-medium transition-colors border-b-2 -mb-px',
                tab === t ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              )}>
              {t === 'squawks' ? 'Squawks' : t === 'log' ? 'Cost Log' : t === 'logbook' ? 'Logbooks' : 'Data Logs'}
            </button>
          ))}
        </div>
      </div>

      {tab === 'squawks' && (
        <SquawksTab
          showAdd={showAddSquawk}
          setShowAdd={setShowAddSquawk}
          pendingAddFiles={sqPendingFiles}
          setPendingAddFiles={setSqPendingFiles}
        />
      )}
      {tab === 'logbook' && <LogbookTab showImport={showImportLogbook} setShowImport={setShowImportLogbook} />}
      {tab === 'engine' && <EngineTrends />}
      {tab === 'log' && (
        <MaintenanceTab
          showAddEntry={showAddEntry}
          setShowAddEntry={setShowAddEntry}
          showRecurring={showRecurring}
          pendingAddFiles={logPendingFiles}
          setPendingAddFiles={setLogPendingFiles}
        />
      )}
    </div>
  )
}
