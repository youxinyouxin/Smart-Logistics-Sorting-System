import { Link, useLocation } from 'react-router-dom'
import { Eye, TriangleAlert } from 'lucide-react'
import { useDataSource } from '../../lib/useDataSource'
import { formatClock, formatInteger } from '../../lib/format'
import { DEMO_TOTAL } from '../../lib/demo'
import { useMediaQuery } from '../../lib/useMediaQuery'

export function StatusStrip() {
  const location = useLocation()
  const compact = useMediaQuery('(max-width: 767px)')
  const { snapshot, connectionState, sourceState, latestUpdatedAt, receivedAt, error, refreshing } = useDataSource()
  const sourceKeys = Object.keys(snapshot) as Array<keyof typeof snapshot>
  const online = sourceKeys.filter((key) => sourceState(key) === 'online').length
  const history = sourceKeys.filter((key) => sourceState(key) === 'history').length
  const delayed = sourceKeys.filter((key) => sourceState(key) === 'delayed').length
  const expired = sourceKeys.filter((key) => sourceState(key) === 'expired').length
  const missing = Math.max(0, 2 - sourceKeys.length)
  const updated = latestUpdatedAt ?? receivedAt

  let tone = ''
  let text: string
  if (connectionState === 'connecting') {
    text = '正在连接采集服务…'
  } else if (connectionState === 'error') {
    tone = 'danger'
    text = `无法连接采集服务${updated ? ` · 最后成功 ${formatClock(updated)}` : ''} · 执行器状态未知 · 过期 —`
  } else if (connectionState === 'stale' && error) {
    tone = 'danger'
    text = `连接中断 · 最后成功 ${updated ? formatClock(updated) : '—'} · 执行器状态见设备页 · 过期 —`
  } else if (connectionState === 'empty' || sourceKeys.length === 0) {
    tone = 'warn'
    text = compact
      ? '采集服务可达 · 暂无采集器 · 执行器见设备页'
      : '采集服务可达 · 暂无采集器在传数 · 执行器 8 路（状态见设备页）'
  } else {
    tone = expired > 0 || delayed > 0 || history > 0 || missing > 0 ? 'warn' : 'ok'
    const parts = compact
      ? [tone === 'ok' ? '采集正常' : '采集服务可达', `${online} 个源在传数`, '执行器见设备页']
      : [tone === 'ok' ? '采集正常' : '采集服务可达', `${online} 个采集器在传数`, '执行器 8 路（状态见设备页）']
    if (expired > 0) parts.push(`${expired} 项过期`)
    if (history > 0) parts.push(`${history} 项历史平均`)
    if (delayed > 0) parts.push(`${delayed} 项延迟`)
    if (missing > 0) parts.push(`${missing} 个源未接入`)
    text = parts.join(' · ')
  }

  return (
    <div className={`status-strip${tone ? ` status-strip--${tone}` : ''}`}>
      {tone === 'danger' ? <TriangleAlert size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
      <div className="status-strip__text">
        <span>{text}</span>
        {location.pathname === '/dashboard' ? (
          <span className="status-strip__business">今日分拣 {formatInteger(DEMO_TOTAL)} 件 · 演示</span>
        ) : null}
        {error && !text.includes(error) ? <span>· {error}</span> : null}
        {refreshing ? <span>· 更新中</span> : null}
      </div>
      <Link className="status-strip__link" to="/devices">
        查看设备 ›
      </Link>
    </div>
  )
}
