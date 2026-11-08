import { AlertTriangle } from 'lucide-react'
import type { SensorMetricCardData } from '../../lib/sensorMetrics'
import { formatDecimal, formatInteger } from '../../lib/format'
import { StatusBadge } from '../ui/StatusBadge'

interface SensorMetricCardProps {
  metric: SensorMetricCardData
}

function valueText(metric: SensorMetricCardData): string {
  if (metric.value === null) return '—'
  if (metric.kind === 'boolean') {
    if (metric.key === 'smoke') return metric.value ? '报警' : '未报警'
    return metric.value ? '有人' : '无人'
  }
  return metric.decimals > 0 ? formatDecimal(metric.value as number, metric.decimals) : formatInteger(metric.value as number)
}

export function SensorMetricCard({ metric }: SensorMetricCardProps) {
  const muted = metric.status === 'expired' || metric.status === 'unavailable' || metric.status === 'missing'
  return (
    <article className={`device-card sensor-metric-card${muted ? ' sensor-metric-card--muted' : ''}`}>
      <div className="device-card__head">
        <div className="sensor-metric-card__label">{metric.label}</div>
        <StatusBadge state={metric.status} />
      </div>
      <div className="sensor-metric-card__value num">
        {valueText(metric)}
        {metric.value !== null && metric.unit ? <small>{metric.unit}</small> : null}
      </div>
      {metric.note ? <div className="sensor-metric-card__note">{metric.note}</div> : null}
      {metric.alert ? (
        <div className={`device-alert device-alert--${metric.alert.level}`}>
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{metric.alert.message}</span>
        </div>
      ) : null}
    </article>
  )
}
