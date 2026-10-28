import { useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { ThemeProvider } from './context/ThemeContext'
import { publicApi } from './lib/api'
import { ProtectedRoute } from './components/ProtectedRoute'
import { Layout } from './components/Layout'
import { Login } from './pages/Login'
import { ForgotPassword } from './pages/ForgotPassword'
import { ResetPassword } from './pages/ResetPassword'
import { Dashboard } from './pages/Dashboard'
import { Flights } from './pages/Flights'
import { LogFlight } from './pages/LogFlight'
import { EditFlight } from './pages/EditFlight'
import { Schedule } from './pages/Schedule'
import { NewReservation } from './pages/NewReservation'
import { EditReservation } from './pages/EditReservation'
import { Ledger } from './pages/Ledger'
import { NewLedgerEntry } from './pages/NewLedgerEntry'
import { EditLedgerEntry } from './pages/EditLedgerEntry'
import { RecurringCharges } from './pages/RecurringCharges'
import { Invoices } from './pages/Invoices'
import { Setup } from './pages/Setup'
import { InvoiceDetailPage } from './pages/InvoiceDetail'
import { MaintenancePage } from './pages/MaintenancePage'
import { Settings } from './pages/Settings'
import { Documents } from './pages/Documents'

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
      </BrowserRouter>
    </AuthProvider>
    </ThemeProvider>
  )
}
