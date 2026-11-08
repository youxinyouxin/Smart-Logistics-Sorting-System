import { AlertTriangle, CircleCheck, CircleHelp, Clock3, History, WifiOff } from 'lucide-react'
import type { SourceState } from '../../types'

const CONFIG: Record<SourceState, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral'; icon: typeof CircleCheck }> = {
  online: { label: '实时', tone: 'ok', icon: CircleCheck },
  history: { label: '历史平均', tone: 'warn', icon: History },
  delayed: { label: '数据延迟', tone: 'warn', icon: Clock3 },
  expired: { label: '数据已过期', tone: 'warn', icon: Clock3 },
  missing: { label: '未接入', tone: 'neutral', icon: WifiOff },
  invalid: { label: '数据无效', tone: 'danger', icon: AlertTriangle },
  unavailable: { label: '暂不可用', tone: 'neutral', icon: CircleHelp },
}

export function StatusBadge({ state }: { state: SourceState }) {
  const config = CONFIG[state]
  const Icon = config.icon
  return (
    <span className={`badge badge--${config.tone}`}>
      <Icon size={15} aria-hidden="true" />
      {config.label}
    </span>
  )
}

export function UnknownBadge({ label = '状态未知' }: { label?: string }) {
  return (
    <span className="badge badge--neutral">
      <CircleHelp size={15} aria-hidden="true" />
      {label}
    </span>
  )
}
