import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { RightNav } from './RightNav'
import { TopBar } from './TopBar'
import { StatusStrip } from './StatusStrip'
import { NavDrawer } from './NavDrawer'
import { useDataSource } from '../../lib/useDataSource'
import { useRuleEngine } from '../../lib/useRuleEngine'

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': '数据看板',
  '/devices': '设备传感器',
  '/operations': '运行数据',
  '/rules': '规则设置',
  '/settings': '设置中心',
}

export function AppShell() {
  const location = useLocation()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const { connectionState, error, now } = useDataSource()
  useRuleEngine()

  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  const pageTitle = PAGE_TITLES[location.pathname] ?? '数据看板'

  return (
    <>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <div className="app-shell">
        <div className="app-main">
          <TopBar
            pageTitle={pageTitle}
            connectionState={connectionState}
            connectionError={error}
            now={now}
            onMenu={() => setDrawerOpen(true)}
          />
          <StatusStrip />
          <main id="main-content" className="page-content" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
        <RightNav />
      </div>
      <NavDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </>
  )
}
