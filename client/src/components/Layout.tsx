import { Suspense } from 'react'
import { Outlet, useNavigate } from 'react-router-dom'
import { Sun, Moon, Monitor, LogOut, Settings } from 'lucide-react'
import { BottomNav } from './BottomNav'
import { useTheme, type Theme } from '@/context/ThemeContext'
import { useAuth } from '@/context/AuthContext'

const NEXT_THEME: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' }
const THEME_ICON: Record<Theme, React.ElementType> = { system: Monitor, light: Sun, dark: Moon }
const THEME_LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' }

export function Layout() {
  const { theme, setTheme } = useTheme()
  const { logout } = useAuth()
  const navigate = useNavigate()
  const ThemeIcon = THEME_ICON[theme]

  async function handleLogout() {
    await logout()
    navigate('/login')
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="flex items-center justify-end gap-0.5 border-b bg-background px-3 py-1.5">
        <button
          onClick={() => setTheme(NEXT_THEME[theme])}
          title={`Theme: ${THEME_LABEL[theme]}`}
          className="flex items-center gap-1 rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <ThemeIcon className="h-4 w-4" />
          <span className="text-[11px]">{THEME_LABEL[theme]}</span>
        </button>
        <button
          onClick={() => navigate('/settings')}
          title="Settings"
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <Settings className="h-4 w-4" />
        </button>
        <button
          onClick={handleLogout}
          title="Log out"
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:text-foreground"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </header>
      <main className="flex-1 overflow-y-auto pb-20">
        {/* Pages load on first visit; keep the header and bottom nav up while one does. */}
        <Suspense fallback={<p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>}>
          <Outlet />
        </Suspense>
      </main>
      <BottomNav />
    </div>
  )
}
