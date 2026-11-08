import type { EnvHistoryRecord, HistoryMetric, MinutePoint, SourceKey } from '../types'
import { minuteKey, pad, parseBackendTime } from './format'

export const HISTORY_METRICS: HistoryMetric[] = ['temperature', 'humidity', 'illumination']

const MINUTE_MS = 60_000
const MAX_FILL_GAP_MINUTES = 120

type HistoryField = 'temperature' | 'humidity' | 'illumination'

const METRIC_FIELD: Record<HistoryMetric, HistoryField> = {
  temperature: 'temperature',
  humidity: 'humidity',
  illumination: 'illumination',
}

interface HistorySample {
  timestamp: number
  value: number
  source: SourceKey | undefined
}

function normalizeTimestamp(date: Date): number {
  return Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS
}

function createPoint(timestamp: number): MinutePoint {
  const date = new Date(timestamp)
  return {
    key: minuteKey(date),
    label: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    timestamp,
    temperature: null,
    humidity: null,
    illumination: null,
    sources: {},
  }
}

function getPoint(points: Map<number, MinutePoint>, timestamp: number): MinutePoint {
  let point = points.get(timestamp)
  if (!point) {
    point = createPoint(timestamp)
    points.set(timestamp, point)
  }
  return point
}

function clonePoint(point: MinutePoint): MinutePoint {
  return { ...point, sources: { ...point.sources } }
}

function sortedPoints(points: Map<number, MinutePoint>): MinutePoint[] {
  return [...points.values()].sort((a, b) => a.timestamp - b.timestamp)
}

function collectSamples(records: EnvHistoryRecord[], metric: HistoryMetric): Map<number, HistorySample> {
  const samples = new Map<number, HistorySample>()
  for (const record of records) {
    const date = parseBackendTime(record.minute)
    if (!date || !Number.isFinite(record.value)) continue
    const timestamp = normalizeTimestamp(date)
    const existing = samples.get(timestamp)
    if (metric === 'temperature' && existing?.source === 'multi_in_one') continue
    samples.set(timestamp, {
      timestamp,
      value: record.value,
      source: record.source,
    })
  }
  return samples
}

function fillInternalGaps(points: Map<number, MinutePoint>): void {
  for (const metric of HISTORY_METRICS) {
    const field = METRIC_FIELD[metric]
    const samples: HistorySample[] = []
    for (const point of points.values()) {
      const value = point[field]
      if (value === null) continue
      samples.push({ timestamp: point.timestamp, value, source: point.sources[field] })
    }
    samples.sort((a, b) => a.timestamp - b.timestamp)

    for (let index = 0; index < samples.length - 1; index += 1) {
      const previous = samples[index]
      const next = samples[index + 1]
      const gapMinutes = Math.round((next.timestamp - previous.timestamp) / MINUTE_MS)
      if (gapMinutes <= 1 || gapMinutes > MAX_FILL_GAP_MINUTES) continue

      for (let step = 1; step < gapMinutes; step += 1) {
        const timestamp = previous.timestamp + step * MINUTE_MS
        const point = getPoint(points, timestamp)
        if (point[field] !== null) continue
        const ratio = step / gapMinutes
        point[field] = previous.value + (next.value - previous.value) * ratio
        const source = previous.source ?? next.source
        if (source) point.sources[field] = source
      }
    }
  }
}

export function buildServerHistory(
  recordsByMetric: Partial<Record<HistoryMetric, EnvHistoryRecord[]>>,
): MinutePoint[] {
  const points = new Map<number, MinutePoint>()
  for (const metric of HISTORY_METRICS) {
    const records = recordsByMetric[metric]
    if (!records?.length) continue
    const field = METRIC_FIELD[metric]
    for (const sample of collectSamples(records, metric).values()) {
      const point = getPoint(points, sample.timestamp)
      point[field] = sample.value
      point.sources[field] = sample.source
    }
  }
  fillInternalGaps(points)
  return sortedPoints(points)
}

export function mergeHistory(serverHistory: MinutePoint[], sessionHistory: MinutePoint[]): MinutePoint[] {
  if (!serverHistory.length && !sessionHistory.length) return []

  const points = new Map<number, MinutePoint>()
  for (const point of serverHistory) points.set(point.timestamp, clonePoint(point))

  for (const sessionPoint of sessionHistory) {
    const point = getPoint(points, sessionPoint.timestamp)
    for (const metric of HISTORY_METRICS) {
      const field = METRIC_FIELD[metric]
      const value = sessionPoint[field]
      if (value === null) continue
      point[field] = value
      const source = sessionPoint.sources[field]
      if (source) point.sources[field] = source
    }
    const pm25Source = sessionPoint.sources.pm25
    if (pm25Source) point.sources.pm25 = pm25Source
  }

  fillInternalGaps(points)
  return sortedPoints(points)
}
