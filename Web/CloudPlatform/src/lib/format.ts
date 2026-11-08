import type { MetricKey } from '../types'

export const METRIC_LABELS: Record<MetricKey, string> = {
  temperature: '温度',
  humidity: '湿度',
  illumination: '光照',
  pm25: 'PM2.5',
}

export const METRIC_UNITS: Record<MetricKey, string> = {
  temperature: '°C',
  humidity: '%RH',
  illumination: 'lx',
  pm25: 'μg/m³',
}

export function parseBackendTime(value: string | null | undefined): Date | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value)
  if (!match) return null
  const [, y, m, d, h, min, s] = match
  const date = new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s ?? 0))
  return Number.isNaN(date.getTime()) ? null : date
}

export function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function formatClock(input: Date | number, seconds?: boolean): string {
  const date = typeof input === 'number' ? new Date(input) : input
  const showSeconds =
    seconds ??
    (typeof document !== 'undefined'
      ? document.documentElement.dataset.showSeconds !== 'false'
      : true)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}${showSeconds ? `:${pad(date.getSeconds())}` : ''}`
}

export function formatDateTime(input: Date | number): string {
  const date = typeof input === 'number' ? new Date(input) : input
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${formatClock(date, true)}`
}

export function formatShortDate(input: Date | number): string {
  const date = typeof input === 'number' ? new Date(input) : input
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function parseNumeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  return null
}

export function formatDecimal(value: number | null, decimals: number): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return value.toFixed(decimals)
}

export function formatInteger(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return Math.round(value).toLocaleString('zh-CN')
}

export function formatPercent(value: number, total: number): string {
  if (!total) return '0.0%'
  return `${((value / total) * 100).toFixed(1)}%`
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function minuteKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function pointKeyToTimestamp(key: string): number {
  const [day, time] = key.split('T')
  const [y, m, d] = day.split('-').map(Number)
  const [h, min] = time.split(':').map(Number)
  return new Date(y, m - 1, d, h, min, 0).getTime()
}
