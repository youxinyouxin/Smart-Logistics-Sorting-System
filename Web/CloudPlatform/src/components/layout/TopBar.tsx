import { Menu } from 'lucide-react'
import type { ConnectionState } from '../../types'
import { formatClock, formatShortDate } from '../../lib/format'
import { DEMO_DATE } from '../../lib/demo'

const CONNECTION_CLASS: Record<ConnectionState, string> = {
  connecting: '',
  ok: 'status-dot--ok',
  stale: 'status-dot--warn',
  error: 'status-dot--danger',
  empty: 'status-dot--warn',
}

interface TopBarProps {
  pageTitle: string
  connectionState: ConnectionState
  connectionError: string | null
  now: number
  onMenu: () => void
}

export function TopBar({
  pageTitle,
  connectionState,
  connectionError,
  now,
  onMenu,
}: TopBarProps) {
  const connectionLabel =
    connectionState === 'connecting'
      ? '连接中'
      : connectionState === 'error'
        ? '连接中断'
        : connectionState === 'stale'
          ? connectionError
            ? '连接中断'
            : '数据已过期'
          : connectionState === 'empty'
            ? '已连接 · 无采集源'
            : '已连接'
  return (
    <header className="topbar">
      <div className="topbar__left">
        <span className="topbar__product">物流分拣云平台</span>
        <span className="topbar__divider" aria-hidden="true" />
        <h1 className="topbar__title">{pageTitle}</h1>
      </div>
      <div className="topbar__right">
        <span className="topbar__date">
          {formatShortDate(new Date(`${DEMO_DATE}T00:00:00`))} · 演示
        </span>
        <span className="topbar__status">
          <span className={`status-dot ${CONNECTION_CLASS[connectionState]}`} aria-hidden="true" />
          {connectionLabel}
        </span>
        <span className="topbar__time">当前 {formatClock(now)}</span>
        <button className="icon-btn mobile-menu-btn" type="button" onClick={onMenu} aria-label="打开导航">
          <Menu size={24} />
        </button>
      </div>
    </header>
  )
}
