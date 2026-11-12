import { lazy, Suspense, useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { ThemeProvider } from './context/ThemeContext'
import { publicApi } from './lib/api'
import { ProtectedRoute } from './components/ProtectedRoute'
import { Layout } from './components/Layout'
import { Login } from './pages/Login'
import { Dashboard } from './pages/Dashboard'

// Pages other than the Dashboard and Login load on first visit, keeping the initial download small.
const LogFlight = lazy(() => import('./pages/LogFlight').then(m => ({ default: m.LogFlight })))
const EditFlight = lazy(() => import('./pages/EditFlight').then(m => ({ default: m.EditFlight })))
const Flights = lazy(() => import('./pages/Flights').then(m => ({ default: m.Flights })))
const Schedule = lazy(() => import('./pages/Schedule').then(m => ({ default: m.Schedule })))
const NewReservation = lazy(() => import('./pages/NewReservation').then(m => ({ default: m.NewReservation })))
const EditReservation = lazy(() => import('./pages/EditReservation').then(m => ({ default: m.EditReservation })))
const Ledger = lazy(() => import('./pages/Ledger').then(m => ({ default: m.Ledger })))
const NewLedgerEntry = lazy(() => import('./pages/NewLedgerEntry').then(m => ({ default: m.NewLedgerEntry })))
const EditLedgerEntry = lazy(() => import('./pages/EditLedgerEntry').then(m => ({ default: m.EditLedgerEntry })))
const RecurringCharges = lazy(() => import('./pages/RecurringCharges').then(m => ({ default: m.RecurringCharges })))
const Invoices = lazy(() => import('./pages/Invoices').then(m => ({ default: m.Invoices })))
const Setup = lazy(() => import('./pages/Setup').then(m => ({ default: m.Setup })))
const MaintenancePage = lazy(() => import('./pages/MaintenancePage').then(m => ({ default: m.MaintenancePage })))
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })))
const Documents = lazy(() => import('./pages/Documents').then(m => ({ default: m.Documents })))
const ForgotPassword = lazy(() => import('./pages/ForgotPassword').then(m => ({ default: m.ForgotPassword })))
const ResetPassword = lazy(() => import('./pages/ResetPassword').then(m => ({ default: m.ResetPassword })))
const InvoiceDetailPage = lazy(() => import('./pages/InvoiceDetail').then(m => ({ default: m.InvoiceDetailPage })))

export default function App() {
  useEffect(() => {
    publicApi.partnershipTail()
      .then(({ aircraft_tail }) => { document.title = aircraft_tail ? `avManage - ${aircraft_tail}` : 'avManage' })
      .catch(() => { document.title = 'avManage' })
  }, [])

  return (
    <ThemeProvider>
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={<p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/setup" element={<Setup />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route index element={<Dashboard />} />
              <Route path="flights" element={<Flights />} />
              <Route path="flights/new" element={<LogFlight />} />
              <Route path="flights/:id/edit" element={<EditFlight />} />
              <Route path="schedule" element={<Schedule />} />
              <Route path="schedule/new" element={<NewReservation />} />
              <Route path="schedule/:id/edit" element={<EditReservation />} />
              <Route path="ledger" element={<Ledger />} />
              <Route path="ledger/new" element={<NewLedgerEntry />} />
              <Route path="ledger/recurring" element={<RecurringCharges />} />
              <Route path="ledger/:id/edit" element={<EditLedgerEntry />} />
              <Route path="maintenance" element={<MaintenancePage />} />
              <Route path="documents" element={<Documents />} />
<Route path="invoices" element={<Invoices />} />
<Route path="invoices/:id" element={<InvoiceDetailPage />} />
<Route path="settings" element={<Settings />} />
            </Route>
          </Route>
        </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
    </ThemeProvider>
  )
}
