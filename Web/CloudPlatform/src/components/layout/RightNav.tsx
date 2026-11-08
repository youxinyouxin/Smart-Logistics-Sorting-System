import { NavLink } from 'react-router-dom'
import { ClipboardList, Cpu, LayoutDashboard, ListChecks, SlidersHorizontal } from 'lucide-react'

const ITEMS = [
  { to: '/dashboard', label: '数据看板', short: '看板', Icon: LayoutDashboard },
  { to: '/devices', label: '设备传感器', short: '设备', Icon: Cpu },
  { to: '/operations', label: '运行数据', short: '记录', Icon: ClipboardList },
  { to: '/rules', label: '规则设置', short: '规则', Icon: ListChecks },
  { to: '/settings', label: '设置中心', short: '设置', Icon: SlidersHorizontal },
]

interface RightNavProps {
  variant?: 'desktop' | 'drawer'
  onNavigate?: () => void
}

export function RightNav({ variant = 'desktop', onNavigate }: RightNavProps) {
  return (
    <nav
      className={variant === 'drawer' ? 'right-nav right-nav--drawer' : 'right-nav'}
      aria-label="主导航"
    >
      {ITEMS.map(({ to, label, short, Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => `right-nav__item${isActive ? ' right-nav__item--active' : ''}`}
          onClick={onNavigate}
          aria-label={label}
        >
          <Icon className="right-nav__icon" size={24} aria-hidden="true" />
          {variant === 'drawer' ? (
            <span className="right-nav__full">{label}</span>
          ) : (
            <>
              <span className="right-nav__full">{label}</span>
              <span className="right-nav__short">{short}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}
