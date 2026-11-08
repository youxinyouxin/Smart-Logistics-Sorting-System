import type { EnvAlert, Snapshot, SourceKey, SourceState, Thresholds } from '../types'
import { getSourceAlerts } from './alerts'
import { parseNumeric } from './format'

export type SensorMetricKey =
  | 'temperature'
  | 'humidity'
  | 'pm25'
  | 'co2'
  | 'tvoc'
  | 'body'
  | 'illumination'
  | 'smoke'
  | 'pressure'

interface MetricSource {
  source: SourceKey
  field: string
  special?: 'smoke'
}

export interface SensorMetricDef {
  key: SensorMetricKey
  label: string
  unit: string
  kind: 'number' | 'boolean'
  decimals: number
  sources: MetricSource[]
  liveOnly?: boolean
}

export interface SensorMetricCardData {
  key: SensorMetricKey
  label: string
  unit: string
  kind: 'number' | 'boolean'
  decimals: number
  value: number | boolean | null
  status: SourceState
  alert?: EnvAlert
  note?: string
}

export const SENSOR_METRICS: SensorMetricDef[] = [
  {
    key: 'temperature',
    label: '温度',
    unit: '°C',
    kind: 'number',
    decimals: 1,
    sources: [
      { source: 'multi_in_one', field: 'temperature' },
      { source: 'iot', field: 'temperature' },
    ],
  },
  { key: 'humidity', label: '湿度', unit: '%RH', kind: 'number', decimals: 1, sources: [{ source: 'multi_in_one', field: 'humidity' }] },
  { key: 'pm25', label: 'PM2.5', unit: 'μg/m³', kind: 'number', decimals: 0, sources: [{ source: 'multi_in_one', field: 'pm2_5' }] },
  { key: 'co2', label: 'CO₂', unit: 'ppm', kind: 'number', decimals: 0, sources: [{ source: 'multi_in_one', field: 'co2' }] },
  { key: 'tvoc', label: 'TVOC', unit: 'ppb', kind: 'number', decimals: 0, sources: [{ source: 'multi_in_one', field: 'tvoc' }] },
  { key: 'body', label: '人体', unit: '', kind: 'boolean', decimals: 0, sources: [{ source: 'multi_in_one', field: 'body' }] },
  { key: 'illumination', label: '光照', unit: 'lx', kind: 'number', decimals: 0, sources: [{ source: 'iot', field: 'illumination' }] },
  {
    key: 'smoke',
    label: '烟雾',
    unit: '',
    kind: 'boolean',
    decimals: 0,
    sources: [{ source: 'iot', field: '0', special: 'smoke' }],
    liveOnly: true,
  },
  { key: 'pressure', label: '气压', unit: 'hPa', kind: 'number', decimals: 1, sources: [{ source: 'multi_in_one', field: 'pressure_hpa' }] },
]

function readValue(snapshot: Snapshot, entry: MetricSource): number | boolean | null {
  const source = snapshot[entry.source]
  if (!source) return null
  if (entry.special === 'smoke') {
    const di = source.values.di
    if (!di || typeof di !== 'object' || Array.isArray(di)) return null
    const value = (di as Record<string, unknown>)['0']
    return typeof value === 'boolean' ? value : null
  }
  const raw = source.values[entry.field]
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string' && (raw === 'true' || raw === 'false')) return raw === 'true'
  return parseNumeric(raw)
}

function alertFor(def: SensorMetricDef, alerts: EnvAlert[]): EnvAlert | undefined {
  const aliases: Partial<Record<SensorMetricKey, string[]>> = {
    temperature: ['温度'],
    humidity: ['湿度'],
    pm25: ['PM2.5'],
    co2: ['CO₂'],
    tvoc: ['TVOC'],
    illumination: ['光照'],
  }
  const names = aliases[def.key] ?? [def.label]
  return alerts.find((alert) => names.includes(alert.metric))
}

export function getSensorMetricCards(
  snapshot: Snapshot,
  sourceState: (source: SourceKey) => SourceState,
  thresholds: Thresholds,
): SensorMetricCardData[] {
  return SENSOR_METRICS.map((def) => {
    let chosen: MetricSource | null = null
    let value: number | boolean | null = null
    for (const entry of def.sources) {
      if (!snapshot[entry.source]) continue
      const candidate = readValue(snapshot, entry)
      if (candidate !== null) {
        chosen = entry
        value = candidate
        break
      }
    }

    const sourceStatus = chosen ? sourceState(chosen.source) : 'missing'
    let status: SourceState = value === null ? 'missing' : sourceStatus
    let note: string | undefined
    let finalValue = value

    if (def.liveOnly && value !== null && sourceStatus !== 'online') {
      status = 'unavailable'
      finalValue = null
      note = '仅实时数据可用于该状态'
    }

    const alerts = chosen ? getSourceAlerts(chosen.source, snapshot[chosen.source], thresholds, sourceStatus !== 'online') : []
    return {
      key: def.key,
      label: def.label,
      unit: def.unit,
      kind: def.kind,
      decimals: def.decimals,
      value: finalValue,
      status,
      alert: alertFor(def, alerts),
      note,
    }
  })
}
