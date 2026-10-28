import { NavLink } from 'react-router-dom'
import { LayoutDashboard, BookOpen, CalendarDays, Wallet, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/flights', label: 'Flights', icon: BookOpen },
  { to: '/schedule', label: 'Schedule', icon: CalendarDays },
  { to: '/maintenance', label: 'Maintenance', icon: Wrench },
  { to: '/ledger', label: 'Ledger', icon: Wallet },
]

export function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background safe-area-bottom">
      <div className="flex">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center gap-1 py-3 text-xs transition-colors',
                isActive ? 'text-primary' : 'text-muted-foreground'
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon className={cn('h-5 w-5', isActive && 'stroke-[2.5]')} />
                <span>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
