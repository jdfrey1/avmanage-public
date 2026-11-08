async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    credentials: 'include',
    ...init,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw Object.assign(new Error(body.error ?? res.statusText), { status: res.status, ...body })
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  get: <T>(path: string) => apiFetch<T>(path),
  post: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    apiFetch<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: (path: string) => apiFetch<void>(path, { method: 'DELETE' }),
  upload: <T>(path: string, formData: FormData) =>
    apiFetch<T>(path, { method: 'POST', body: formData, headers: {} }),
}

// Shared types
export interface Flight {
  id: string
  flight_date: string
  tach_start: string
  tach_end: string
  tach_time: string
  hobbs_start: string | null
  hobbs_end: string | null
  flight_time: string | null
  exclude_from_allotment: boolean
  fuel_gallons: string | null
  tks_gallons: string | null
  fuel_standard_met: boolean | null
  notes: string | null
  route: string | null
  pilot_id: string
  // Who flew it; differs from member_name when someone outside the partnership flew it.
  pilot_name: string
  member_name: string
  other_pilot: string | null
  created_at: string
  ocr_source_image_key: string | null
  oil_added_quarts?: string | null
  fuel_added_gallons?: string | null
  fa_tracks?: FlightAwareTrack[]
  garmin_logs?: GarminLog[]
}

// A Garmin avionics data log (one engine run). Times are ISO strings.
export interface GarminCruise {
  minutes: number; cht: (number | null)[]; egt: (number | null)[]; oilt: number | null; oilp: number | null
  ff: number | null; map: number | null; rpm: number | null; pwr: number | null; tas: number | null; alt: number | null; oat: number | null
}
export interface GarminStats {
  cht_max: (number | null)[]; egt_max: (number | null)[]; oilt_max: number | null; oilp_min: number | null; oilp_max: number | null
  alt_max: number | null; gs_max: number | null; tas_max: number | null; volt_min: number | null; cruise: GarminCruise | null
  events?: GarminEvent[]
}
export interface GarminEvent { type: string; severity: 'warning' | 'caution' | 'info'; msg: string; at: string; cyl?: number; value?: number }
export interface EngineFinding {
  key: string
  ack?: { note: string | null; acked_at: string; acked_by_name: string | null }
  kind: 'limit' | 'event' | 'outlier' | 'trend'; severity: 'warning' | 'caution' | 'info'
  title: string; detail: string | null; log_id: string; at: string; metric: string
}
export type DashboardFinding = EngineFinding & { run: { started_at: string; origin: string | null; destination: string | null; pilot_name: string | null } | null }
export interface EngineTrendsResponse {
  runs: GarminTrendPoint[]; findings: EngineFinding[]; addressed: EngineFinding[]; marks: Record<string, string[]>
  history: { cruise_runs: number; outliers_from: number; trends_from: number }
}
export interface GarminLog {
  id: string
  flight_id?: string | null
  filename?: string | null
  started_at: string
  ended_at?: string
  engine_on_at: string | null
  engine_off_at: string | null
  takeoff_at: string | null
  landing_at: string | null
  engine_hrs: number | null
  air_hrs: number | null
  fuel_used_gal: number | null
  origin: string | null
  destination: string | null
  max_cht: number | null
  max_cht_cyl: number | null
  stats: GarminStats
}
export interface GarminTrendPoint extends GarminLog { flight_date: string | null; pilot_name: string | null }
// Chart data sampled every `step` seconds; t = seconds from t0 (epoch ms). Missing columns are absent.
export type GarminSeries = { t0: number; step: number; t: number[] } & Partial<Record<string, (number | null)[]>>
export interface GarminUploadResult { filename: string; status: 'attached' | 'unmatched' | 'duplicate' | 'error'; error?: string; log?: GarminLog }

// A FlightAware flight (one leg) attached to a logged flight.
export interface FlightAwareTrack {
  id: string
  off_time: string | null
  on_time: string | null
  en_route_min: number | null
  origin: string | null
  destination: string | null
  url: string | null
  has_track: boolean
}

export interface FlightAwareUnmatched {
  id: string
  tail: string
  origin: string | null
  destination: string | null
  off_time: string | null
  on_time: string | null
  en_route_min: number | null
  url: string | null
  has_track: boolean
}

export interface TrackPoint { t: number; lat: number; lon: number; alt: number | null; gs: number | null }

export interface TachOcrResult {
  hobbs: number | null
  flight: number | null
  image_key: string
}

export interface ScheduleBlock {
  id: string
  block_type: 'reservation' | 'maintenance' | 'unavailable'
  start_dt: string
  end_dt: string
  title: string
  notes: string | null
  is_all_day: boolean
  pilot_id: string | null
  pilot_name: string | null
  delivery_ack_at: string | null
  return_ack_at: string | null
  delivery_tach: string | null
  return_tach: string | null
  created_at: string
  created_by: string
  created_by_name: string
  day_over?: boolean
  flights_logged?: { pilot: string; count: number }[] | null
}

export interface PartnershipMember {
  id: string
  user_id: string
  name: string
  role?: 'owner' | 'lessee'
  annual_hour_allotment?: number | null
  hour_allotment_period?: 'annual' | 'monthly'
}

export interface MemberUsage {
  id: string
  user_id: string
  name: string
  email: string
  role: 'owner' | 'lessee'
  is_admin: boolean
  annual_hour_allotment: number | null
  hour_allotment_period: 'annual' | 'monthly'
  ytd_hours: number
  ytd_excluded: number
  month_hours: number
  month_excluded: number
  window_hours: number
  window_overage: number
  window_overage_cost: number | null
  window_start: string | null
  window_end: string | null
  not_started: boolean
  lease_monthly_rate: number | null
  overage_rate_per_hr: number | null
  lease_start_date: string | null
}

export interface Partnership {
  id: string
  name: string
  insurance_expires_date?: string | null
  baseline_hobbs?: number | null
  baseline_flight?: number | null
  baseline_date?: string | null
  baseline_image_key?: string | null
  aircraft_tail: string | null
  aircraft_make_model: string | null
  aircraft_serial: string | null
  members: PartnershipMember[]
}

// No auth required — just the tail number, for branding the login screen and browser tab
// before a session exists. (Not sensitive: it's already painted on the aircraft.)
export const publicApi = {
  partnershipTail: () => api.get<{ aircraft_tail: string | null }>('/partnership/public'),
}

export interface User {
  id: string
  name: string
  email: string
  role: 'owner' | 'lessee' | null
  is_admin: boolean
}

export interface LedgerEntry {
  id: string
  entry_type: string
  direction: 'debit' | 'credit'
  amount: string
  running_balance: string
  effective_date: string
  description: string
  created_at: string
  related_flight_id: string | null
  invoices?: { id: string; invoice_number: string }[]
  documents?: { id: string; title: string }[]
  created_by_name: string
  lessee_id: string
  lessee_name: string
}

export interface Squawk {
  id: string
  description: string
  severity: 'major' | 'minor' | 'note'
  status: 'open' | 'in_progress' | 'resolved'
  tach_at_report: string | null
  reported_by_name: string
  resolution_notes: string | null
  reported_at: string
  resolved_at: string | null
}

export interface MaintenanceEntry {
  id: string
  entry_date: string
  category: string
  title: string
  description: string | null
  cost_amount: string | null
  tach_at_service: string | null
  performed_by: string | null
  created_by_name: string
  created_at: string
}

export interface MaintenanceInterval {
  id: string
  title: string
  description: string | null
  interval_hours: number
  last_done_hours: number
  last_done_date: string | null
  warn_hours: number
  next_due_hours: number
  hours_remaining: number | null
  status: 'ok' | 'due_soon' | 'overdue' | 'unknown'
}

export interface MaintenanceRecurring {
  id: string
  category: string
  title: string
  description: string | null
  cost_amount: string
  day_of_month: number
  next_due_date: string
  active: boolean
  created_at: string
}

export interface MaintenanceAttachment {
  id: string
  parent_type: 'log' | 'squawk'
  parent_id: string
  file_key: string
  mime_type: string
  original_name: string | null
  uploaded_at: string
}

export interface CostAnalysis {
  start_date: string
  end_date: string
  total_hours: number
  pilots: { pilot_id: string; pilot_name: string; hours: number; pct: number }[]
  total_cost: number
  fixed_cost: number
  variable_cost: number
  cost_per_hour: number
  by_category: { category: string; total: number }[]
}

export interface AnnualHoursSummary {
  hours_flown: number
  annual_allotment: number | null
  no_allotment?: boolean
  overage: number
  overage_rate: number | null
  overage_cost: number | null
  period: 'annual' | 'monthly'
  window_start: string | null
  window_end: string | null
  not_started: boolean
  lease_start: string | null
}

export interface CurrencyStatus {
  ifr:          { current: boolean; expiresInDays: number; approachesInWindow: number }
  dayLanding:   { current: boolean; expiresInDays: number }
  nightLanding: { current: boolean; expiresInDays: number }
  medical:      { current: boolean; expiresDate: string | null; daysUntilExpiry: number | null }
  bfr:          { current: boolean; accomplishedDate: string | null; expiresDate: string | null; daysUntilExpiry: number | null }
  lastImportAt:   string | null
  lastImportFile: string | null
  pilot: string
}

export interface BackupFile {
  filename: string
  size_bytes: number
  size_label: string
  created_at: string
  protected: boolean
  type: 'manual' | 'scheduled' | 'auto'
}

export interface BackupSettings {
  enabled: boolean
  cron: string
  maxBackups: number
}

export interface ReportSettings {
  monthlyEnabled: boolean
  monthlyCron: string
  currencyCheckEnabled: boolean
  currencyCheckCron: string
}

export const reportsApi = {
  getSettings: () => api.get<ReportSettings>('/reports/settings'),
  saveSettings: (s: ReportSettings) => api.post<ReportSettings>('/reports/settings', s),
  sendTest: (to?: string) => api.post<{ success: boolean }>('/reports/test', to ? { to } : {}),
  getCurrencyAlertPref: () => api.get<{ enabled: boolean }>('/reports/currency-alert-pref'),
  saveCurrencyAlertPref: (enabled: boolean) => api.post<{ enabled: boolean }>('/reports/currency-alert-pref', { enabled }),
  sendCurrencyTest: (to?: string) => api.post<{ success: boolean }>('/reports/currency-test', to ? { to } : {}),
}

export const profileApi = {
  update: (body: { name?: string; email?: string; currentPassword?: string; newPassword?: string }) =>
    api.patch<User>('/auth/profile', body),
}

export interface BackupVerifyResult {
  ok: boolean
  error?: string
  steps: string[]
  tables?: number
  rows?: Record<string, number>
}

export const backupApi = {
  list: () => api.get<BackupFile[]>('/backup'),
  create: () => api.post<BackupFile>('/backup', {}),
  download: (filename: string) => { window.location.href = `/api/backup/${filename}` },
  delete: (filename: string) => api.delete(`/backup/${filename}`),
  verify: (filename: string) => api.post<BackupVerifyResult>(`/backup/${filename}/verify`, {}),
  toggleProtect: (filename: string) => api.patch<{ filename: string; protected: boolean }>(`/backup/${filename}/protect`, {}),
  getSettings: () => api.get<BackupSettings>('/backup/settings'),
  saveSettings: (s: BackupSettings) => api.post<BackupSettings>('/backup/settings', s),
  restore: (file: File) => {
    const fd = new FormData()
    fd.append('backup', file)
    return api.upload<{ success: boolean; preRestoreBackup: string }>('/backup/restore', fd)
  },
}

export interface RecurringCharge {
  id: string
  lessee_id: string
  lessee_name: string
  entry_type: string
  direction: 'debit' | 'credit'
  amount: string
  description_template: string
  day_of_month: number
  next_due_date: string
  active: boolean
  created_at: string
}

export type LogbookCategory = 'engine' | 'airframe' | 'prop' | 'ad_sb_compliance' | 'other'

export interface LogbookDocument {
  id: string
  category: LogbookCategory
  source_filename: string
  page_count: number | null
  status: 'pending' | 'processed' | 'error'
  error_message: string | null
  uploaded_at: string
  processed_at: string | null
  entry_count: number
  needs_review_count: number
}

export interface LogbookEntry {
  id: string
  document_id: string
  category: LogbookCategory
  page_number: number | null
  entry_date: string | null
  summary: string
  raw_text: string
  fields: Record<string, unknown>
  tags: string[]
  needs_review: boolean
  reviewed_at: string | null
  created_at: string
  source_filename: string
  invoice_id?: string | null
  invoice_number?: string | null
}

export interface LogbookCitation {
  id: string
  document_id: string
  category: LogbookCategory
  source_filename: string
  page_number: number | null
  entry_date: string | null
  summary: string
}

export interface LogbookAskResponse {
  answer: string
  citations: LogbookCitation[]
}

export const logbookApi = {
  documents: () => api.get<LogbookDocument[]>('/logbook/documents'),
  entries: (params: { category?: string; q?: string; date_from?: string; date_to?: string; needs_review?: boolean; order?: 'asc' | 'desc' } = {}) => {
    const qs = new URLSearchParams()
    if (params.category) qs.set('category', params.category)
    if (params.q) qs.set('q', params.q)
    if (params.date_from) qs.set('date_from', params.date_from)
    if (params.date_to) qs.set('date_to', params.date_to)
    if (params.needs_review !== undefined) qs.set('needs_review', String(params.needs_review))
    if (params.order) qs.set('order', params.order)
    return api.get<LogbookEntry[]>(`/logbook/entries?${qs}`)
  },
  updateEntry: (id: string, body: Partial<Pick<LogbookEntry, 'entry_date' | 'summary' | 'raw_text' | 'fields' | 'tags' | 'needs_review'>>) =>
    api.patch<LogbookEntry>(`/logbook/entries/${id}`, body),
  ask: (question: string, history: { question: string; answer: string }[] = []) =>
    api.post<LogbookAskResponse>('/logbook/ask', { question, history }),
  import: (category: LogbookCategory, file: File) => {
    const fd = new FormData()
    fd.append('category', category)
    fd.append('file', file)
    return api.upload<{ document_id: string; entries: LogbookEntry[] }>('/logbook/import', fd)
  },
  sourceUrl: (documentId: string) => `/api/logbook/documents/${documentId}/file`,
}

export type AircraftDocType =
  | 'airworthiness_certificate' | 'registration' | 'radio_station_license'
  | 'operating_limitations' | 'weight_and_balance' | 'miscellaneous' | 'invoice'

export type DocTextStatus = 'pending' | 'ready' | 'partial' | 'skipped' | 'error'

export interface AircraftDocument {
  id: string
  doc_type: AircraftDocType
  title: string
  file_key: string
  uploaded_at: string
  uploaded_by_name: string
  text_status: DocTextStatus
  text_error: string | null
}

export interface DocumentCitation {
  id: string
  doc_type: AircraftDocType
  title: string
  page_number: number | null
}

export interface DocumentAskResponse {
  answer: string
  citations: DocumentCitation[]
}

export const documentsApi = {
  list: () => api.get<AircraftDocument[]>('/documents'),
  upload: (doc_type: AircraftDocType, file: File) => {
    const fd = new FormData()
    fd.append('doc_type', doc_type)
    fd.append('file', file)
    fd.append('title', file.name)
    return api.upload<AircraftDocument>('/documents/upload', fd)
  },
  delete: (id: string) => api.delete(`/documents/${id}`),
  fileUrl: (id: string, pageNumber?: number | null) =>
    pageNumber ? `/api/documents/${id}/file#page=${pageNumber}` : `/api/documents/${id}/file`,
  process: (id: string) => api.post<AircraftDocument>(`/documents/${id}/process`, {}),
  ask: (question: string, history: { question: string; answer: string }[] = []) =>
    api.post<DocumentAskResponse>('/documents/ask', { question, history }),
}

export interface InspectionItem {
  id: string
  title: string
  notes: string | null
  interval_months: number | null
  warn_days: number
  last_done_date: string | null
  due_date: string | null
  days_until: number | null
  status: 'overdue' | 'due_soon' | 'ok' | 'no_date'
}

export interface AircraftStatus {
  grounded: boolean
  major_squawks: { id: string; description: string }[]
  overdue: InspectionItem[]
  due_soon: InspectionItem[]
  insurance_expires_date: string | null
}

export interface InvoicePart { part: string; description: string; qty: number; unit: number; ext: number }
export interface InvoiceItem {
  id: string
  item_no: number
  status: 'approved' | 'rejected' | 'pending'
  item_date: string | null
  description: string
  work_performed: string | null
  labor_hours: number
  labor_rate: number
  labor_amount: number
  parts: InvoicePart[]
  parts_amount: number
  total_amount: number
}
export interface InvoiceSummary {
  id: string
  document_id: string
  vendor: string
  invoice_number: string
  invoice_date: string | null
  customer: string | null
  summary: string | null
  responsible: string | null
  labor: number
  parts: number
  shipping: number
  tax: number
  total: number
  total_time: number | null
  hobbs: number | null
  flight_timer: number | null
  notes: string | null
  ledger_count?: number
  logbook_count?: number
  matches: { item_no: number; status: string; snippet: string; total_amount: number }[]
}
export interface InvoiceDetail extends Omit<InvoiceSummary, 'matches'> {
  items: InvoiceItem[]
  ledger_entries: { id: string; lessee_id: string; lessee_name: string | null; entry_type: string; direction: 'debit' | 'credit'; amount: number; effective_date: string; description: string }[]
  logbook_entries: { id: string; entry_date: string | null; category: string; summary: string }[]
}

// Attach an invoice file to one or more ledger entries (creates the invoice record, files it to Drive).
export async function uploadInvoice(file: File, ledgerIds: string[]) {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('ledger_ids', ledgerIds.join(','))
  return api.upload<{ id: string; invoice_number: string; items: number; parsed: boolean }>('/invoices/upload', fd)
}
