import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useGoBack } from '@/lib/navigation'
import { ChevronLeft, X } from 'lucide-react'
import { documentsApi, type AircraftDocument, type AircraftDocType, type DocumentCitation } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

const REQUIRED_DOC_TYPES: { key: AircraftDocType; label: string; description: string }[] = [
  { key: 'airworthiness_certificate', label: 'Airworthiness Certificate', description: 'Must be displayed in the cabin/cockpit, legible to passengers or crew.' },
  { key: 'registration', label: 'Registration Certificate', description: "Must be current and match the aircraft's N-number." },
  { key: 'radio_station_license', label: 'Radio Station License', description: 'Required only for international flights.' },
  { key: 'operating_limitations', label: 'Operating Limitations (AFM/POH)', description: "FAA-approved Airplane Flight Manual or Pilot's Operating Handbook." },
  { key: 'weight_and_balance', label: 'Weight & Balance Data', description: 'Current weight and balance calculations for this aircraft.' },
]

const MISC_DOC_TYPE = { key: 'miscellaneous' as AircraftDocType, label: 'Miscellaneous', description: 'Lease agreement, insurance policy and binders, airport certificates of insurance, and other aircraft paperwork.' }

const DOC_TYPE_LABELS: Record<AircraftDocType, string> = Object.fromEntries(
  [...REQUIRED_DOC_TYPES, MISC_DOC_TYPE].map(t => [t.key, t.label])
) as Record<AircraftDocType, string>

type ChatTurn = { question: string; answer: string; citations: DocumentCitation[] }

function DocumentsChat() {
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
      const res = await documentsApi.ask(q, history)
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
        <p className="text-sm font-semibold">Ask about the documents</p>
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
                      key={`${c.id}-${c.page_number ?? 'doc'}`}
                      href={documentsApi.fileUrl(c.id, c.page_number)}
                      target="_blank"
                      rel="noreferrer"
                      title={c.title}
                      className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
                    >
                      {DOC_TYPE_LABELS[c.doc_type] ?? c.doc_type} · {c.title}
                      {c.page_number ? ` · p.${c.page_number}` : ''}
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
          placeholder="e.g. What's the maximum useful load?"
          className="text-sm"
        />
        <Button type="submit" size="sm" disabled={asking || !question.trim()}>
          {asking ? '…' : 'Ask'}
        </Button>
      </form>
    </div>
  )
}

function AircraftDocTypeRow({
  type, label, description, docs, onUploaded, onDeleted, onProcessed,
}: {
  type: AircraftDocType
  label: string
  description: string
  docs: AircraftDocument[]
  onUploaded: (d: AircraftDocument) => void
  onDeleted: (id: string) => void
  onProcessed: (d: AircraftDocument) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set())

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    setError('')
    try {
      for (const file of Array.from(files)) {
        onUploaded(await documentsApi.upload(type, file))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function handleDelete(id: string) {
    try {
      await documentsApi.delete(id)
      onDeleted(id)
    } catch { /* leave it in the list if delete failed */ }
  }

  async function handleProcess(id: string) {
    setProcessingIds(prev => new Set(prev).add(id))
    setError('')
    try {
      onProcessed(await documentsApi.process(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Processing failed')
    } finally {
      setProcessingIds(prev => { const next = new Set(prev); next.delete(id); return next })
    }
  }

  return (
    <div className="space-y-2 rounded-md border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? 'Uploading…' : '+ Add'}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf"
          multiple
          className="hidden"
          onChange={e => handleFiles(e.target.files)}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {docs.length === 0 ? (
        <p className="text-xs italic text-muted-foreground">No file uploaded yet.</p>
      ) : (
        <ul className="space-y-1">
          {docs.map(d => (
            <li key={d.id} className="flex items-center gap-2 rounded bg-muted/30 px-2 py-1.5 text-xs">
              <a href={documentsApi.fileUrl(d.id)} target="_blank" rel="noreferrer" className="flex-1 truncate text-primary hover:underline">
                {d.title}
              </a>
              {d.text_status === 'pending' && (
                <>
                  <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0" title="Not yet processed — click Process to make it searchable via chat">
                    not yet processed
                  </Badge>
                  <button
                    type="button"
                    onClick={() => handleProcess(d.id)}
                    disabled={processingIds.has(d.id)}
                    className="shrink-0 text-[10px] text-primary hover:underline disabled:opacity-50"
                  >
                    {processingIds.has(d.id) ? 'Processing…' : 'Process'}
                  </button>
                </>
              )}
              {(d.text_status === 'skipped' || d.text_status === 'error') && (
                <Badge variant="outline" className="shrink-0 text-[10px] px-1.5 py-0" title={d.text_error ?? 'Not searchable via chat'}>
                  not searchable
                </Badge>
              )}
              {d.text_status === 'partial' && (
                <Badge variant="warning" className="shrink-0 text-[10px] px-1.5 py-0" title={d.text_error ?? 'Only part of this document is searchable so far'}>
                  partially searchable
                </Badge>
              )}
              <span className="shrink-0 text-muted-foreground">
                {new Date(d.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
              <button type="button" onClick={() => handleDelete(d.id)} className="shrink-0 text-muted-foreground hover:text-destructive">
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function Documents() {
  const goBack = useGoBack('/')
  const [documents, setDocuments] = useState<AircraftDocument[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    documentsApi.list().then(setDocuments).catch(() => {}).finally(() => setLoading(false))
  }, [])

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background px-4 py-3">
        <button onClick={goBack} className="rounded-md p-1 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div>
          <h1 className="text-lg font-semibold">Aircraft Documents</h1>
          <p className="text-xs text-muted-foreground">Required Aircraft Documents (ARROW) — reference copies, not used for flight.</p>
        </div>
      </div>

      <div className="space-y-3 p-4">
        <DocumentsChat />

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-2">
            {[...REQUIRED_DOC_TYPES, MISC_DOC_TYPE].map(t => (
              <AircraftDocTypeRow
                key={t.key}
                type={t.key}
                label={t.label}
                description={t.description}
                docs={documents.filter(d => d.doc_type === t.key)}
                onUploaded={doc => setDocuments(prev => [doc, ...prev])}
                onDeleted={id => setDocuments(prev => prev.filter(d => d.id !== id))}
                onProcessed={doc => setDocuments(prev => prev.map(d => d.id === doc.id ? doc : d))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
