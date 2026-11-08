import type { EnvHistoryRecord, EnvHistoryResponse, HistoryMetric, RfidResponse } from '../types'

export class ApiError extends Error {
  kind: 'network' | 'http' | 'parse' | 'timeout' | 'aborted'
  status?: number
  detail?: string

  constructor(kind: ApiError['kind'], message: string, status?: number, detail?: string) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.detail = detail
  }
}

const DATA_TIMEOUT_MS = 8000
export const CONTROL_TIMEOUT_MS = 3000

export function normalizeApiBase(input: string): string {
  const raw = (input || '').trim().replace(/\/+$/, '')
  if (!raw) return '/api'
  let value = raw
  if (!/^https?:\/\//i.test(value) && !value.startsWith('/')) value = `/${value}`
  if (!/\/api$/i.test(value)) value = `${value}/api`
  return value
}

export function apiUrl(base: string, path: string): string {
  return `${normalizeApiBase(base)}${path.startsWith('/') ? path : `/${path}`}`
}

async function requestJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = DATA_TIMEOUT_MS,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort('timeout'), timeoutMs)
  const onAbort = () => controller.abort('external')
  externalSignal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let data: unknown = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        throw new ApiError('parse', '接口返回的不是有效 JSON', response.status)
      }
    }

    if (!response.ok) {
      const detail =
        data && typeof data === 'object' && 'detail' in data
          ? String((data as { detail?: unknown }).detail ?? '')
          : text.slice(0, 200)
      throw new ApiError('http', `接口返回 ${response.status}`, response.status, detail)
    }

    return data as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      const reason = String(controller.signal.reason ?? '')
      if (reason === 'timeout') throw new ApiError('timeout', '请求超时')
      throw new ApiError('aborted', '请求已取消')
    }
    throw new ApiError('network', '无法连接采集服务')
  } finally {
    window.clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', onAbort)
  }
}

export async function getSnapshot(
  base: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const data = await requestJson<unknown>(apiUrl(base, '/data'), { method: 'GET' }, DATA_TIMEOUT_MS, signal)
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ApiError('parse', '采集数据格式不正确')
  }
  return data as Record<string, unknown>
}

export async function getHistoryMetric(
  base: string,
  metric: HistoryMetric,
  start: string,
  end: string,
  signal?: AbortSignal,
): Promise<EnvHistoryResponse> {
  const params = new URLSearchParams({ start, end, limit: '60' })
  const data = await requestJson<unknown>(
    apiUrl(base, `/history/${metric}?${params.toString()}`),
    { method: 'GET' },
    DATA_TIMEOUT_MS,
    signal,
  )
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ApiError('parse', '历史数据格式不正确')
  }
  const record = data as Record<string, unknown>
  const recordsRaw = Array.isArray(record.records) ? record.records : []
  const records: EnvHistoryRecord[] = []
  for (const item of recordsRaw) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (typeof entry.minute !== 'string' || typeof entry.value !== 'number' || !Number.isFinite(entry.value)) {
      continue
    }
    if (entry.source !== 'iot' && entry.source !== 'multi_in_one') continue
    records.push({ minute: entry.minute, source: entry.source, value: entry.value })
  }
  return {
    metric,
    unit: typeof record.unit === 'string' ? record.unit : '',
    records,
  }
}

export async function getDoStatus(base: string, signal?: AbortSignal): Promise<Record<string, boolean>> {
  const data = await requestJson<unknown>(apiUrl(base, '/do'), { method: 'GET' }, DATA_TIMEOUT_MS, signal)
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ApiError('parse', 'DO 状态格式不正确')
  }
  const result: Record<string, boolean> = {}
  for (let channel = 1; channel <= 8; channel += 1) {
    const key = `DO${channel}`
    const value = (data as Record<string, unknown>)[key]
    if (typeof value === 'boolean') result[key] = value
  }
  return result
}

export async function getDoChannel(
  base: string,
  channel: number,
  signal?: AbortSignal,
): Promise<{ channel: number; value: boolean }> {
  const data = await requestJson<unknown>(
    apiUrl(base, `/do/${channel}`),
    { method: 'GET' },
    CONTROL_TIMEOUT_MS,
    signal,
  )
  if (!data || typeof data !== 'object') throw new ApiError('parse', 'DO 单路状态格式不正确')
  const record = data as Record<string, unknown>
  if (typeof record.value !== 'boolean') throw new ApiError('parse', 'DO 单路状态缺少布尔值')
  return { channel, value: record.value }
}

export async function setDoChannel(
  base: string,
  channel: number,
  value: boolean,
  signal?: AbortSignal,
): Promise<{ channel: number; value: boolean }> {
  const data = await requestJson<unknown>(
    apiUrl(base, `/do/${channel}`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    },
    CONTROL_TIMEOUT_MS,
    signal,
  )
  if (!data || typeof data !== 'object') throw new ApiError('parse', '控制接口返回格式不正确')
  const record = data as Record<string, unknown>
  if (typeof record.value !== 'boolean') throw new ApiError('parse', '控制接口未返回确认状态')
  return { channel, value: record.value }
}

export async function testConnection(
  base: string,
  signal?: AbortSignal,
): Promise<{ elapsedMs: number; sourceCount: number }> {
  const started = performance.now()
  const data = await getSnapshot(base, signal)
  const elapsedMs = Math.round(performance.now() - started)
  const sourceCount = Object.keys(data).filter((key) => ['iot', 'multi_in_one'].includes(key)).length
  return { elapsedMs, sourceCount }
}

export async function getRfidRecords(
  base: string,
  start = 1,
  count = 20,
  signal?: AbortSignal,
): Promise<RfidResponse> {
  const safeStart = Math.max(1, Math.floor(start))
  const safeCount = Math.min(100, Math.max(1, Math.floor(count)))
  const data = await requestJson<unknown>(
    apiUrl(base, `/rfid?start=${safeStart}&count=${safeCount}`),
    { method: 'GET' },
    DATA_TIMEOUT_MS,
    signal,
  )
  if (!data || typeof data !== 'object') throw new ApiError('parse', '打卡记录格式不正确')
  const record = data as Record<string, unknown>
  const total = Number(record.total)
  const recordsRaw = Array.isArray(record.records) ? record.records : []
  const records = recordsRaw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const entry = item as Record<string, unknown>
      if (typeof entry.time !== 'string' || typeof entry.name !== 'string') return null
      return { time: entry.time, name: entry.name }
    })
    .filter((item): item is { time: string; name: string } => item !== null)
  return {
    total: Number.isFinite(total) ? total : records.length,
    start: safeStart,
    count: safeCount,
    records,
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'timeout') return error.message || '请求超时'
    if (error.kind === 'network') return error.message || '无法连接采集服务'
    if (error.kind === 'parse') return error.message
    if (error.kind === 'aborted') return '请求已取消'
    return error.detail ? `接口返回 ${error.status}：${error.detail}` : error.message
  }
  return error instanceof Error ? error.message : '未知错误'
}
