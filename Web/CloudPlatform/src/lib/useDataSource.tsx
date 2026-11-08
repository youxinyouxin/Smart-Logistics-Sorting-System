import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type {
  ConnectionState,
  EnvHistoryRecord,
  HistoryMetric,
  MetricKey,
  MetricReading,
  MinutePoint,
  Snapshot,
  SourceKey,
  SourceSnapshot,
  SourceState,
} from '../types'
import { errorMessage, getHistoryMetric, getSnapshot } from './api'
import { HISTORY_METRICS, buildServerHistory, mergeHistory } from './history'
import { METRIC_UNITS, minuteKey, parseBackendTime, parseNumeric } from './format'
import { useRules } from './rules'
import { useSettings } from './settings'

const SOURCES: SourceKey[] = ['iot', 'multi_in_one']
const HISTORY_WINDOW_MINUTES = 60
const HISTORY_REFRESH_MS = 60_000
const SOURCE_FIELDS: Record<SourceKey, Partial<Record<MetricKey, string>>> = {
  iot: { temperature: 'temperature', illumination: 'illumination' },
  multi_in_one: { temperature: 'temperature', humidity: 'humidity', pm25: 'pm2_5' },
}

const METRIC_PRIORITY: Record<MetricKey, SourceKey[]> = {
  temperature: ['multi_in_one', 'iot'],
  humidity: ['multi_in_one'],
  illumination: ['iot'],
  pm25: ['multi_in_one'],
}

function normalizeSnapshot(raw: Record<string, unknown>): Snapshot {
  const result: Snapshot = {}
  for (const key of SOURCES) {
    const source = raw[key]
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue
    const record = source as Record<string, unknown>
    const values = record.values
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue
    const quality = record.source
    result[key] = {
      updated_at: String(record.updated_at ?? ''),
      source: quality === 'live' || quality === 'history' || quality === 'stale' ? quality : undefined,
      values: values as Record<string, unknown>,
    }
  }
  return result
}

function sourceAgeMs(source: SourceSnapshot | undefined, now: number): number | null {
  if (!source) return null
  const date = parseBackendTime(source.updated_at)
  if (!date) return null
  return Math.max(0, now - date.getTime())
}

function readingFor(
  snapshot: Snapshot,
  metric: MetricKey,
  intervalMs: number,
  now: number,
): MetricReading | null {
  const sourceKey = METRIC_PRIORITY[metric].find((candidate) => {
    const source = snapshot[candidate]
    const field = SOURCE_FIELDS[candidate][metric]
    return Boolean(source && field && parseNumeric(source.values[field]) !== null)
  })
  if (!sourceKey) return null
  const source = snapshot[sourceKey]
  const field = SOURCE_FIELDS[sourceKey][metric]
  if (!source || !field) return null
  const value = parseNumeric(source.values[field])
  if (value === null) return null
  const age = sourceAgeMs(source, now)
  const expire = Math.max(60000, intervalMs * 3)
  return {
    value,
    unit: METRIC_UNITS[metric],
    source: sourceKey,
    updatedAt: source.updated_at,
    stale: source.source === 'stale' || age === null || age > expire,
  }
}

interface DataSourceContextValue {
  snapshot: Snapshot
  readings: Partial<Record<MetricKey, MetricReading>>
  history: MinutePoint[]
  historyLoading: boolean
  historyError: string | null
  connectionState: ConnectionState
  sourceState: (source: SourceKey) => SourceState
  sourceAge: (source: SourceKey) => number | null
  latestUpdatedAt: number | null
  latestUpdatedText: string | null
  receivedAt: number | null
  lastAttemptAt: number | null
  error: string | null
  refreshing: boolean
  now: number
  refresh: () => void
}

const DataSourceContext = createContext<DataSourceContextValue | null>(null)

export function DataSourceProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings()
  const { rules } = useRules()
  const hasEnabledRules = rules.some((rule) => rule.enabled)
  const effectivePollIntervalMs = hasEnabledRules
    ? Math.min(settings.refresh.pollIntervalMs, settings.refresh.rulePollIntervalMs)
    : settings.refresh.pollIntervalMs
  const [snapshot, setSnapshot] = useState<Snapshot>({})
  const [serverHistory, setServerHistory] = useState<MinutePoint[]>([])
  const [sessionHistory, setSessionHistory] = useState<MinutePoint[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null)
  const [lastAttemptAt, setLastAttemptAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(() => {
    setRefreshNonce((value) => value + 1)
  }, [])

  const lastBaseRef = useRef(settings.apiBaseUrl)
  useEffect(() => {
    if (lastBaseRef.current === settings.apiBaseUrl) return
    lastBaseRef.current = settings.apiBaseUrl
    setSnapshot({})
    setServerHistory([])
    setSessionHistory([])
    setHistoryLoading(true)
    setHistoryError(null)
    setError(null)
    setLastSuccessAt(null)
    setLastAttemptAt(null)
  }, [settings.apiBaseUrl])

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    let controller: AbortController | null = null
    let inFlight = false

    const fetchHistory = async () => {
      if (cancelled || inFlight || document.hidden) return
      inFlight = true
      controller?.abort()
      controller = new AbortController()

      const end = new Date()
      end.setSeconds(0, 0)
      const start = new Date(end.getTime() - (HISTORY_WINDOW_MINUTES - 1) * 60_000)
      const startKey = minuteKey(start)
      const endKey = minuteKey(end)

      try {
        const results = await Promise.allSettled(
          HISTORY_METRICS.map((metric) =>
            getHistoryMetric(settings.apiBaseUrl, metric, startKey, endKey, controller?.signal),
          ),
        )
        if (cancelled) return

        const recordsByMetric: Partial<Record<HistoryMetric, EnvHistoryRecord[]>> = {}
        let fulfilled = 0
        let firstError: unknown = null
        results.forEach((result, index) => {
          const metric = HISTORY_METRICS[index]
          if (result.status === 'fulfilled') {
            fulfilled += 1
            recordsByMetric[metric] = result.value.records
            return
          }
          const message = errorMessage(result.reason)
          if (message !== '请求已取消') firstError = firstError ?? result.reason
        })

        if (fulfilled > 0) {
          const next = buildServerHistory(recordsByMetric)
          setServerHistory((previous) => {
            if (fulfilled === HISTORY_METRICS.length || previous.length === 0) return next
            return mergeHistory(previous, next)
          })
          setHistoryError(firstError ? errorMessage(firstError) : null)
        } else if (firstError) {
          setHistoryError(errorMessage(firstError))
        }
      } catch (caught) {
        if (!cancelled) setHistoryError(errorMessage(caught))
      } finally {
        inFlight = false
        if (!cancelled) {
          setHistoryLoading(false)
          if (!document.hidden) timer = window.setTimeout(fetchHistory, HISTORY_REFRESH_MS)
        }
      }
    }

    const onVisibility = () => {
      if (document.hidden) {
        if (timer !== null) {
          window.clearTimeout(timer)
          timer = null
        }
      } else {
        if (timer !== null) {
          window.clearTimeout(timer)
          timer = null
        }
        void fetchHistory()
      }
    }

    void fetchHistory()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [settings.apiBaseUrl, refreshNonce])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    let controller: AbortController | null = null
    let failures = 0
    const interval = effectivePollIntervalMs
    const backoffDelays = [10000, 20000, 30000, 60000]
    const backoff = () => Math.max(interval, backoffDelays[Math.min(Math.max(failures, 1), backoffDelays.length) - 1])

    const schedule = (delay: number) => {
      if (cancelled) return
      timer = window.setTimeout(tick, delay)
    }

    const tick = async () => {
      if (cancelled || document.hidden) return
      controller?.abort()
      controller = new AbortController()
      setLastAttemptAt(Date.now())
      setRefreshing(true)
      try {
        const raw = await getSnapshot(settings.apiBaseUrl, controller.signal)
        if (cancelled) return
        const next = normalizeSnapshot(raw)
        setSnapshot(next)
        setLastSuccessAt(Date.now())
        setError(null)
        failures = 0
        setRefreshing(false)
        schedule(interval)
      } catch (caught) {
        if (cancelled) return
        const message = errorMessage(caught)
        if (message !== '请求已取消') {
          failures += 1
          setError(message)
          setRefreshing(false)
          schedule(backoff())
        }
      }
    }

    const onVisibility = () => {
      if (document.hidden) {
        if (timer !== null) window.clearTimeout(timer)
        controller?.abort()
      } else {
        if (timer !== null) window.clearTimeout(timer)
        void tick()
      }
    }

    void tick()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisibility)
      setRefreshing(false)
    }
  }, [settings.apiBaseUrl, effectivePollIntervalMs, refreshNonce])

  const readings = useMemo(() => {
    return {
      temperature: readingFor(snapshot, 'temperature', effectivePollIntervalMs, now) ?? undefined,
      humidity: readingFor(snapshot, 'humidity', effectivePollIntervalMs, now) ?? undefined,
      illumination:
        readingFor(snapshot, 'illumination', effectivePollIntervalMs, now) ?? undefined,
      pm25: readingFor(snapshot, 'pm25', effectivePollIntervalMs, now) ?? undefined,
    }
  }, [snapshot, effectivePollIntervalMs, now])

  const readingsRef = useRef<Partial<Record<MetricKey, MetricReading>>>({})
  readingsRef.current = readings

  useEffect(() => {
    const dates = Object.values(snapshot)
      .map((source) => parseBackendTime(source?.updated_at))
      .filter((date): date is Date => Boolean(date))
    if (!dates.length) return
    const latest = dates.reduce((max, date) => (date.getTime() > max.getTime() ? date : max), dates[0])
    const key = minuteKey(latest)
    const current = readingsRef.current
    const valueAtMinute = (reading: MetricReading | undefined): number | null => {
      if (!reading || reading.stale) return null
      const sourceTime = parseBackendTime(reading.updatedAt)
      if (!sourceTime || minuteKey(sourceTime) !== key) return null
      return reading.value
    }
    const point: MinutePoint = {
      key,
      label: `${String(latest.getHours()).padStart(2, '0')}:${String(latest.getMinutes()).padStart(2, '0')}`,
      timestamp: latest.getTime(),
      temperature: valueAtMinute(current.temperature),
      humidity: valueAtMinute(current.humidity),
      illumination: valueAtMinute(current.illumination),
      sources: {
        temperature: current.temperature?.source,
        humidity: current.humidity?.source,
        illumination: current.illumination?.source,
        pm25: current.pm25?.source,
      },
    }
    setSessionHistory((previous) => {
      const last = previous[previous.length - 1]
      const next = last?.key === key ? [...previous.slice(0, -1), point] : [...previous, point]
      return next.slice(-60)
    })
  }, [snapshot])

  const history = useMemo(
    () => mergeHistory(serverHistory, sessionHistory),
    [serverHistory, sessionHistory],
  )

  const sourceAge = useCallback(
    (source: SourceKey) => sourceAgeMs(snapshot[source], now),
    [snapshot, now],
  )

  const sourceState = useCallback(
    (source: SourceKey): SourceState => {
      const item = snapshot[source]
      if (!item) return 'missing'
      if (item.source === 'stale') return 'expired'
      if (item.source === 'history') return 'history'
      if (!parseBackendTime(item.updated_at)) return 'invalid'
      const age = sourceAgeMs(item, now)
      if (age === null) return 'invalid'
      const delay = Math.max(10000, effectivePollIntervalMs * 2)
      const expire = Math.max(60000, effectivePollIntervalMs * 3)
      if (age > expire) return 'expired'
      if (age > delay) return 'delayed'
      return 'online'
    },
    [snapshot, now, effectivePollIntervalMs],
  )

  const latestUpdatedAt = useMemo(() => {
    const dates = Object.values(snapshot)
      .map((source) => parseBackendTime(source?.updated_at))
      .filter((date): date is Date => Boolean(date))
    return dates.length ? Math.max(...dates.map((date) => date.getTime())) : null
  }, [snapshot])

  const latestUpdatedText = latestUpdatedAt
    ? new Date(latestUpdatedAt).toLocaleString('zh-CN', { hour12: false })
    : null

  const connectionState: ConnectionState = (() => {
    if (lastSuccessAt === null) {
      if (error) return 'error'
      return 'connecting'
    }
    const sourceCount = Object.keys(snapshot).length
    if (!sourceCount) return 'empty'
    if (error) return 'stale'
    if (latestUpdatedAt && latestUpdatedAt < Date.now() - Math.max(60000, effectivePollIntervalMs * 3)) {
      return 'stale'
    }
    return 'ok'
  })()

  const value: DataSourceContextValue = {
    snapshot,
    readings,
    history,
    historyLoading,
    historyError,
    connectionState,
    sourceState,
    sourceAge,
    latestUpdatedAt,
    latestUpdatedText,
    receivedAt: lastSuccessAt,
    lastAttemptAt,
    error,
    refreshing,
    now,
    refresh,
  }

  return <DataSourceContext.Provider value={value}>{children}</DataSourceContext.Provider>
}

export function useDataSource(): DataSourceContextValue {
  const context = useContext(DataSourceContext)
  if (!context) throw new Error('useDataSource must be used inside DataSourceProvider')
  return context
}
