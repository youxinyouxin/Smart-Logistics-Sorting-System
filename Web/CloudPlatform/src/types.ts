export type SourceKey = 'iot' | 'multi_in_one'

export type SourceQuality = 'live' | 'history' | 'stale'

export interface SourceSnapshot {
  updated_at: string
  source?: SourceQuality
  values: Record<string, unknown>
}

export type Snapshot = Partial<Record<SourceKey, SourceSnapshot>>

export type MetricKey = 'temperature' | 'humidity' | 'illumination' | 'pm25'

export interface MetricReading {
  value: number
  unit: string
  source: SourceKey
  updatedAt: string
  stale: boolean
}

export type DoMap = Record<string, boolean>

export interface DoChannelResult {
  channel: number
  value: boolean
}

export interface MinutePoint {
  key: string
  label: string
  timestamp: number
  temperature: number | null
  humidity: number | null
  illumination: number | null
  sources: Partial<Record<MetricKey, SourceKey>>
}

export type HistoryMetric = 'temperature' | 'humidity' | 'illumination'

export interface EnvHistoryRecord {
  minute: string
  source: SourceKey
  value: number
}

export interface EnvHistoryResponse {
  metric: HistoryMetric
  unit: string
  records: EnvHistoryRecord[]
}

export type ConnectionState = 'connecting' | 'ok' | 'stale' | 'error' | 'empty'

export type SourceState = 'online' | 'history' | 'delayed' | 'expired' | 'missing' | 'invalid' | 'unavailable'

export type ThemeMode = 'light' | 'dark'
export type FontScale = 'standard' | 'large'
export type Density = 'comfortable' | 'compact'

export interface Thresholds {
  tempMin: number | null
  tempMax: number | null
  humidityMin: number | null
  humidityMax: number | null
  pm25GoodMax: number
  pm25MidMax: number
  pm25DisplayMax: number
  co2Max: number | null
  tvocMax: number | null
  lightMax: number | null
}

export interface AppearanceSettings {
  theme: ThemeMode
  fontScale: FontScale
  density: Density
}

export interface RefreshSettings {
  pollIntervalMs: number
  rulePollIntervalMs: number
  chartWindowMinutes: number
  showSeconds: boolean
  decimals: 0 | 1 | 2
}

export interface AppSettings {
  thresholds: Thresholds
  appearance: AppearanceSettings
  refresh: RefreshSettings
  apiBaseUrl: string
  sorterApiBaseUrl: string
}

export interface RegionDatum {
  name: string
  value: number
}

export interface EnvAlert {
  metric: string
  message: string
  level: 'warn' | 'danger'
}

export interface RfidRecord {
  time: string
  name: string
}

export interface RfidResponse {
  total: number
  start: number
  count: number
  records: RfidRecord[]
}

export type RuleSensorKey = 'temperature' | 'humidity' | 'pm25' | 'co2' | 'tvoc' | 'illumination' | 'pressure'
export type RuleOperator = '>' | '<' | '='
export type RuleLogic = 'and' | 'or'
export type RuleActionType = 'actuator' | 'alert'

export interface RuleCondition {
  id: string
  sensor: RuleSensorKey
  operator: RuleOperator
  value: string
}

export interface DeviceRule {
  id: string
  name: string
  enabled: boolean
  logic: RuleLogic
  conditions: RuleCondition[]
  actionType: RuleActionType
  channel: number
  actuatorAction: 'on' | 'off'
  message: string
}

export interface RuleAlert {
  id: string
  ruleName: string
  message: string
  at: number
}
